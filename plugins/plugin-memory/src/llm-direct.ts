/**
 * Direct LLM calls for background maintenance (distill + curate).
 *
 * A subagent run carries a whole session lifecycle (agent creation, prompt
 * assembly with the full system prompt, structured-output capture tooling);
 * a distill/curate prompt needs none of that — one system + one user message
 * through `ctx.llm.stream()` returns the same JSON for roughly an order of
 * magnitude fewer tokens, so both background passes call the model this way.
 *
 * Three shared disciplines live here:
 *   - a process-wide serial queue with exponential backoff on 429: quiet
 *     windows can fire across sessions at once, and a burst of parallel
 *     distill calls is exactly what trips provider rate limits;
 *   - a per-attempt deadline inside that slot: a provider stream that never
 *     closes would otherwise pin every later maintenance call behind a
 *     promise that never settles;
 *   - tolerant JSON extraction: models wrap the answer in ```json fences,
 *     prepend chatter or quote the input file before answering — the host
 *     tries every fenced body and every bracket start, rather than dropping
 *     the whole run on the first candidate that is not valid JSON.
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
  /** Deadline for one streaming attempt; defaults to {@link DIRECT_TIMEOUT_MS}. */
  timeoutMs?: number
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

/**
 * Deadline for one streaming attempt. A distill answer is capped at
 * DIRECT_MAX_TOKENS and lands in seconds to tens of seconds; even the 8000
 * token curate answer finishes in ~160 s on a provider streaming as slowly
 * as 50 tokens/s. Three minutes therefore sits above a slow-but-working
 * answer and marks the "hung, not slow" line. A hung stream is what this
 * queue cannot survive: its promise never settles, so every later
 * distill/curate waits behind it forever while the distiller's in-flight
 * guard keeps that session from ever being retried. A timed-out attempt is
 * NOT retried — the retry budget belongs to 429s — it settles the slot with
 * a failure, which is all the queue needs to move on.
 */
const DIRECT_TIMEOUT_MS = 180_000

/** Sentinel the attempt deadline resolves with (see {@link streamJson}); it
 *  is also what keeps our own timeout out of the caller-abort wording. */
const TIMED_OUT = Symbol('direct-call-timeout')

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

/**
 * Parse the value that OPENS at `start` — the first balanced `{...}`/`[...]`
 * the scan completes — or fail for this start so the caller can try the next
 * one. Malformed JSON stays malformed: no repair pass, no eval, no tolerance
 * for a trailing comma.
 */
function valueAt(region: string, start: number): { ok: true, value: unknown } | { ok: false } {
  const body = region.slice(start)
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

/**
 * Strip ```json fences and chatter; return the first candidate that really is
 * JSON. Candidates are tried in order — every fenced body first (the slot the
 * model was asked to answer in), then every `{`/`[` start of the whole answer
 * — and the first success wins. Stopping at the FIRST candidate loses answers
 * that quote their input: the curator asks for verbatim `- [category] date`
 * lines, whose own brackets are what the scan hits first, so the leading
 * candidate is a balanced-looking non-JSON fragment and the real object comes
 * later. Such an answer used to be a total loss, and because the curator then
 * never records the file as reviewed, every cooldown paid for the same doomed
 * call again — forever.
 */
export function extractJson(text: string): { ok: true, value: unknown } | { ok: false } {
  const regions: string[] = []
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/giu)) {
    if (fence[1] !== undefined) regions.push(fence[1])
  }
  regions.push(text)
  for (const region of regions) {
    for (let start = 0; start < region.length; start++) {
      const char = region[start]
      if (char !== '{' && char !== '[') continue
      const parsed = valueAt(region, start)
      if (parsed.ok) return parsed
    }
  }
  return { ok: false }
}

/** Structural face of the LLM runtime (nominal brands stay behind this wall). */
export interface LlmRuntimeLike {
  stream(options: unknown): AsyncIterable<unknown>
}

/** One streamed chunk as this module reads it (see {@link LlmRuntimeLike}). */
interface StreamChunk {
  type: string
  text?: unknown
  usage?: { inputTokens?: unknown, outputTokens?: unknown }
  reason?: { kind?: unknown, failure?: unknown }
}

/**
 * Best-effort teardown of a consumed stream (a for-await loop would do this
 * implicitly on an early exit). Never awaited — a hung stream answers
 * return() only after its pending next() settles, which is exactly what never
 * happens — and never allowed to throw into an otherwise settled call.
 */
function release(iterator: AsyncIterator<StreamChunk>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  } catch {
    // Teardown failure of a call we already gave up on; nothing to salvage.
  }
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
 * JSON, error/abort finish, rate-limit exhaustion after retries, a stream
 * that outlived its deadline) — those surface as a non-ok status so the
 * caller stays fail-soft. Transport-level throws (no route, disposed
 * context) propagate.
 */
export async function streamJson(llm: LlmRuntimeLike, spec: DirectCallSpec): Promise<DirectCallResult> {
  const startedAt = Date.now()
  const timeoutMs = spec.timeoutMs ?? DIRECT_TIMEOUT_MS
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
  }) => AsyncIterable<StreamChunk>).bind(llm)
  return enqueue(async () => {
    let lastError: string | undefined
    for (let attempt = 0; ; attempt++) {
      let text = ''
      let inputTokens = 0
      let outputTokens = 0
      const abortedResult = (): DirectCallResult => ({
        status: 'aborted', inputTokens, outputTokens, durationMs: Date.now() - startedAt, error: 'aborted',
      })
      const timeoutResult = (): DirectCallResult => ({
        status: 'error', inputTokens, outputTokens, durationMs: Date.now() - startedAt,
        // Deliberately not the 'aborted' wording: an abort is the host asking
        // us to stop, a timeout is a stream WE gave up on. The log needs to
        // tell those apart.
        error: `timeout: stream did not finish within ${String(timeoutMs)}ms`,
      })
      // The deadline covers this attempt alone, and it RESOLVES with a
      // sentinel (it never rejects) so racing it needs no rejection handling.
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => { resolve(TIMED_OUT) }, timeoutMs) })
      // Own abort channel: it relays the caller's signal (host-side disposal
      // must still stop the request) and carries our deadline.
      const controller = new AbortController()
      const relayCallerAbort = (): void => { controller.abort() }
      if (spec.signal?.aborted === true) controller.abort()
      else spec.signal?.addEventListener('abort', relayCallerAbort, { once: true })
      let timedOut = false
      let iterator: AsyncIterator<StreamChunk> | undefined
      try {
        // Manual iteration rather than for-await: the deadline below has to
        // race each step, since a stream that ignores its abort signal would
        // otherwise hold the serial queue open forever.
        iterator = stream({
          provider: spec.route.provider,
          model: spec.route.model,
          messages,
          maxTokens: spec.maxTokens ?? DIRECT_MAX_TOKENS,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
        for (;;) {
          const next = iterator.next()
          // The race abandons `next` when the deadline wins; a stream that
          // then rejects it (its own abort handling) must not surface as an
          // unhandled rejection.
          next.catch(() => undefined)
          const step = await Promise.race([next, deadline])
          if (step === TIMED_OUT) {
            timedOut = true
            controller.abort()
            return timeoutResult()
          }
          if (step.done === true) break
          const chunk = step.value
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk.type === 'usage') {
            const usage = chunk.usage
            if (typeof usage?.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) inputTokens = usage.inputTokens
            if (typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) outputTokens = usage.outputTokens
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'aborted') return abortedResult()
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
        // Our deadline first: aborting the controller above can surface here
        // as an AbortError, which must read as our timeout, not as the host
        // having asked us to stop.
        if (timedOut) return timeoutResult()
        if ((error as Error)?.name === 'AbortError' || spec.signal?.aborted === true) return abortedResult()
        if (isRateLimited(error) && attempt < DIRECT_RETRIES) {
          await sleep(DIRECT_BACKOFF_MS * 2 ** attempt)
          continue
        }
        lastError = error instanceof Error ? error.message : String(error)
        break
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        spec.signal?.removeEventListener('abort', relayCallerAbort)
        if (iterator !== undefined) release(iterator)
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
