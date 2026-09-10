/**
 * Direct LLM calls for background maintenance — the low-cost alternative to
 * a read-only subagent child.
 *
 * A subagent run carries a whole session lifecycle (agent creation, prompt
 * assembly with the full system prompt, structured-output capture tooling);
 * a distill/curate prompt needs none of that — one system + one user message
 * through `ctx.llm.stream()` returns the same JSON for roughly an order of
 * magnitude fewer tokens. The child path stays available behind the
 * `distillBackend` switch, but direct is the default.
 *
 * Two shared disciplines live here:
 *   - a process-wide serial queue with exponential backoff on 429: quiet
 *     windows can fire across sessions at once, and a burst of parallel
 *     distill calls is exactly what trips provider rate limits;
 *   - tolerant JSON extraction: models wrap the answer in ```json fences or
 *     prepend chatter — the host extracts the first balanced object/array
 *     instead of rejecting the whole run.
 *
 * @module @dsh-app/plugin-memory/llm-direct
 */

import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Model route for one direct call (resolved from the triggering session). */
export interface DirectRoute {
  provider: string
  model: string
}

/** One direct JSON call. */
export interface DirectCallSpec {
  route: DirectRoute
  /** System instruction (the task + rules + output contract). */
  system: string
  /** The payload (transcript excerpt or memory file). */
  user: string
  /** Output cap; JSON answers are short by construction. */
  maxTokens?: number
  signal?: AbortSignal
}

/** Outcome of one direct call (never throws for model-side failures). */
export interface DirectCallResult {
  status: 'ok' | 'error' | 'aborted'
  /** Parsed JSON payload (status 'ok' only). */
  parsed?: unknown
  inputTokens: number
  outputTokens: number
  durationMs: number
  /** Human-readable cause (non-ok statuses). */
  error?: string
}

/** Cap on a direct answer — JSON decisions, never prose. */
const DIRECT_MAX_TOKENS = 2_000

/** Retries on rate-limit failures (the initial attempt + these). */
const DIRECT_RETRIES = 2

/** Base backoff between retries (doubled per attempt). */
const DIRECT_BACKOFF_MS = 1_000

function isRateLimited(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
    ?? (error as { statusCode?: unknown })?.statusCode
  if (status === 429) return true
  return /429|rate.?limit|too many requests|请求过于频繁/iu.test(String((error as Error)?.message ?? error ?? ''))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Process-wide serial chain: every direct maintenance call runs after the
// previous one settled, so N quiet sessions finishing together cannot burst
// N parallel model requests. A single call pays zero queue delay.
let directQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = directQueue.then(task)
  directQueue = run.catch(() => undefined)
  return run
}

/** Strip ```json fences and chatter; parse the first balanced value. */
export function extractJson(text: string): { ok: true, value: unknown } | { ok: false } {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.search(/[{[]/u)
  if (start < 0) return { ok: false }
  const body = candidate.slice(start)
  // Balanced scan so trailing chatter after the closing bracket is ignored.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(body.slice(0, i + 1)) as unknown }
        } catch {
          return { ok: false }
        }
      }
    }
  }
  return { ok: false }
}

/** Structural face of the LLM runtime (nominal brands stay behind this wall). */
export interface LlmRuntimeLike {
  stream(options: unknown): AsyncIterable<unknown>
}

/**
 * Resolve the LLM runtime off a plugin context. The dsh-llm Context merge
 * is not relied on (see {@link streamJson}); a missing service throws so a
 * mis-mounted distiller fails loud at the quiet window, not silently.
 */
export function resolveLlm(ctx: unknown): LlmRuntimeLike {
  const llm = (ctx as { llm?: unknown } | undefined)?.llm as { stream?: unknown } | undefined
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('memory distill: ctx.llm unavailable (missing inject)')
  }
  return llm as LlmRuntimeLike
}

/**
 * One direct JSON model call. Never throws for model-side failures (bad
 * JSON, error/abort finish, rate-limit exhaustion after retries) — those
 * surface as a non-ok status so the caller stays fail-soft. Transport-level
 * throws (no route, disposed context) propagate.
 */
export async function streamJson(llm: LlmRuntimeLike, spec: DirectCallSpec): Promise<DirectCallResult> {
  const startedAt = Date.now()
  const messages = [
    createSystemMessage(spec.system, 'plugin-memory'),
    createUserMessage({ content: [{ type: 'text', text: spec.user }], source: { kind: 'user' } }),
  ]
  // The structural face erases the nominal brands (see LlmRuntimeLike), so
  // the loosened signature below covers exactly the chunks this module
  // reads; runtime imports stay external regardless. Bound to the runtime:
  // the method reads instance state (this.streamWithRegistration).
  const stream = (llm.stream as unknown as (this: unknown, options: {
    provider: string
    model: string
    messages: typeof messages
    maxTokens?: number
    signal?: AbortSignal
  }) => AsyncIterable<{
    type: string
    text?: unknown
    usage?: { inputTokens?: unknown, outputTokens?: unknown }
    reason?: { kind?: unknown, failure?: unknown }
  }>).bind(llm)
  return enqueue(async () => {
    let lastError: string | undefined
    for (let attempt = 0; ; attempt++) {
      let text = ''
      let inputTokens = 0
      let outputTokens = 0
      try {
        for await (const chunk of stream({
          provider: spec.route.provider,
          model: spec.route.model,
          messages,
          maxTokens: spec.maxTokens ?? DIRECT_MAX_TOKENS,
          signal: spec.signal,
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk.type === 'usage') {
            const usage = chunk.usage
            if (typeof usage?.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) inputTokens = usage.inputTokens
            if (typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) outputTokens = usage.outputTokens
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'aborted') {
              return { status: 'aborted', inputTokens, outputTokens, durationMs: Date.now() - startedAt, error: 'aborted' }
            }
            if (kind === 'error') {
              const failure = chunk.reason?.failure as { message?: unknown, code?: unknown } | undefined
              if (isRateLimited(failure)) throw Object.assign(new Error('rate limited'), { status: 429 })
              return {
                status: 'error', inputTokens, outputTokens, durationMs: Date.now() - startedAt,
                error: `llm error: ${String(failure?.message ?? failure?.code ?? kind)}`,
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' || spec.signal?.aborted === true) {
          return { status: 'aborted', inputTokens, outputTokens, durationMs: Date.now() - startedAt, error: 'aborted' }
        }
        if (isRateLimited(error) && attempt < DIRECT_RETRIES) {
          await sleep(DIRECT_BACKOFF_MS * 2 ** attempt)
          continue
        }
        lastError = error instanceof Error ? error.message : String(error)
        break
      }
      if (text.trim() === '') {
        lastError = 'empty response'
        break
      }
      const extracted = extractJson(text)
      if (!extracted.ok) {
        lastError = 'unparseable JSON response'
        break
      }
      return { status: 'ok', parsed: extracted.value, inputTokens, outputTokens, durationMs: Date.now() - startedAt }
    }
    return { status: 'error', inputTokens: 0, outputTokens: 0, durationMs: Date.now() - startedAt, error: lastError ?? 'unknown error' }
  })
}
