/**
 * The engine chain: the one place that decides which engine runs, in what
 * order, under what budget, and what happens when one fails.
 *
 * Why a chain rather than N registered providers: the seam picks exactly ONE
 * provider per call (`ctx.web` selection semantics), and multi-provider
 * registration surfaces as `WEB_PROVIDER_AMBIGUOUS`. Fallback therefore
 * belongs inside the selected provider — which is also what makes it
 * observable: the chain knows which engine answered, so the settings page can
 * show it and the caller can be told.
 *
 * Two modes:
 * - `fallback` — always start at the highest-priority engine and walk down.
 *   Deterministic: the same query always hits the same first engine, so a
 *   preference is honored.
 * - `rotate` — start one position further along each call, wrapping. This
 *   spreads load across engines that meter anonymously (Exa, Parallel) and
 *   across the shared-IP quotas the keyless engines sit behind. The
 *   starting position is the only thing that changes; the walk still falls
 *   through, so rotation never costs a successful search.
 *
 * Budget: ONE deadline for the whole call, composed with the caller's signal.
 * Per-engine timeouts would make the effective limit depend on how many
 * engines happened to fail, so a caller's 30s tool budget could be spent many
 * times over.
 *
 * @module @dsh-app/plugin-websearch/chain
 */

import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { Engine } from './engines/index.ts'
import type { ChainMode } from './wire.ts'

/** One engine the chain will attempt, already resolved and ready to run. */
export interface ChainStep {
  readonly id: string
  readonly engine: Engine
}

/** One attempt's outcome, kept for diagnostics and the settings-page probe. */
export interface AttemptRecord {
  readonly id: string
  readonly ok: boolean
  /** Present when `ok` is false: why this engine was abandoned. */
  readonly error?: string
  readonly resultCount: number
  readonly latencyMs: number
}

/** A search outcome plus the chain's own accounting. */
export interface ChainOutcome {
  readonly result: WebSearchResult
  readonly usedEngine: string
  readonly attempts: readonly AttemptRecord[]
  /** Engines skipped because the budget was already spent. */
  readonly skipped: readonly string[]
}

/** A chain-level failure: every attempted engine failed. */
export class ChainExhaustedError extends Error {
  constructor(readonly attempts: readonly AttemptRecord[], readonly skipped: readonly string[]) {
    const detail = attempts.length === 0
      ? '没有可用的搜索引擎'
      : attempts.map(attempt => `${attempt.id}（${attempt.error ?? '未知原因'}）`).join('；')
    super(`所有搜索引擎均失败：${detail}`)
    this.name = 'ChainExhaustedError'
  }
}

/**
 * Compose the caller's signal with the chain's own deadline.
 *
 * `AbortSignal.any` is the honest primitive here, but its availability varies
 * by Node build, so the fallback wires the two sources by hand. Both paths
 * must produce a signal that aborts for EITHER reason — a chain that only
 * honored its own timer would ignore a cancelled tool call, and one that only
 * honored the caller would ignore the budget.
 */
function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal, dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('搜索超时')), timeoutMs)
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** Where the walk starts. `fallback` is always 0; `rotate` advances per call. */
function startOffset(mode: ChainMode, stepCount: number, rotation: number): number {
  if (mode !== 'rotate' || stepCount === 0) return 0
  return rotation % stepCount
}

/** Reorder the steps so the walk begins at `offset` and wraps. */
function rotated(steps: readonly ChainStep[], offset: number): ChainStep[] {
  if (offset === 0) return [...steps]
  return [...steps.slice(offset), ...steps.slice(0, offset)]
}

/** Join sources from every attempt that produced any, preserving engine order. */
function mergeSources(results: readonly { readonly sources: readonly WebSearchSource[] }[], limit: number): WebSearchSource[] {
  const seen = new Set<string>()
  const out: WebSearchSource[] = []
  for (const { sources } of results) {
    for (const source of sources) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      out.push(source)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** Build the human-facing note that says which engine actually answered. */
function fallbackNote(attempts: readonly AttemptRecord[], usedEngine: string, skipped: readonly string[]): string | undefined {
  const failed = attempts.filter(attempt => !attempt.ok)
  const parts: string[] = []
  if (failed.length > 0) {
    parts.push(`Note: ${failed.map(attempt => `${attempt.id} 失败（${attempt.error ?? '未知原因'}）`).join('；')}，已改用 ${usedEngine}。`)
  }
  if (skipped.length > 0) {
    parts.push(`（超时预算已用尽，未尝试：${skipped.join('、')}）`)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** How many engines must succeed before the chain stops early. */
const SATISFYING_RESULT_COUNT = 1

/** One cached outcome: the sources plus when it was stored. */
interface CacheEntry {
  readonly sources: readonly WebSearchSource[]
  readonly note: string | undefined
  readonly usedEngine: string
  readonly storedAt: number
}

/**
 * A small LRU result cache.
 *
 * Its job is quota protection, not speed: the keyless engines rate-limit by
 * IP, and an agent that re-asks the same question across a turn would
 * otherwise burn the shared quota on identical queries. A hit therefore skips
 * the chain entirely.
 *
 * Keyed on the query AND the effective result cap, because a cached
 * 5-source answer must not satisfy a request for 20.
 */
export class SearchCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(private readonly maxEntries = 50) {}

  /** Look up a fresh entry; a stale one is dropped on sight. */
  get(key: string, ttlMs: number): CacheEntry | undefined {
    if (ttlMs <= 0) return undefined
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.storedAt > ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    // Re-insert to refresh LRU position (Map preserves insertion order).
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /** Store an outcome, evicting the oldest entry past the cap. */
  set(key: string, sources: readonly WebSearchSource[], usedEngine: string, note: string | undefined): void {
    this.entries.delete(key)
    this.entries.set(key, { sources, usedEngine, note, storedAt: Date.now() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Drop everything (config changed: stale results may name a dead engine). */
  clear(): void {
    this.entries.clear()
  }
}

/** The cache key: query, effective cap, and the chain identity it ran under. */
export function cacheKey(query: string, limit: number, identity: string): string {
  return `${identity}\u0000${String(limit)}\u0000${query}`
}

/**
 * Run one search through the chain, consulting `cache` first.
 *
 * A hit short-circuits the whole walk and is reported with `cached: true`, so
 * the caller can tell a fresh search from a replay (the settings page's
 * self-check shows it, which is how a user verifies the TTL is doing what
 * they asked).
 *
 * @param steps - engines to try, in preference order.
 * @param request - the seam's request (query + optional maxResults cap).
 * @param options - mode, budget, rotation counter, cache TTL, and the caller's signal.
 */
export async function runChainCached(
  steps: readonly ChainStep[],
  request: WebSearchRequest,
  options: {
    readonly mode: ChainMode
    readonly timeoutMs: number
    readonly maxResults: number
    readonly rotation: number
    readonly cacheTtlMs: number
    readonly cache: SearchCache
    readonly signal?: AbortSignal
  },
): Promise<ChainOutcome & { readonly cached: boolean }> {
  const limit = Math.min(request.maxResults ?? options.maxResults, options.maxResults)
  // The identity names the engines in their walk order, so reordering or
  // disabling an engine invalidates cached results instead of replaying an
  // answer that a now-preferred engine would have produced.
  const identity = `${options.mode}:${steps.map(step => step.id).join(',')}`
  const key = cacheKey(request.query, limit, identity)
  const hit = options.cache.get(key, options.cacheTtlMs)
  if (hit !== undefined) {
    return {
      result: {
        sources: hit.sources,
        truncated: false,
        ...hit.note !== undefined ? { content: hit.note } : {},
      },
      usedEngine: hit.usedEngine,
      attempts: [{ id: hit.usedEngine, ok: true, resultCount: hit.sources.length, latencyMs: 0 }],
      skipped: [],
      cached: true,
    }
  }

  const outcome = await runChain(steps, request, options)
  const note = typeof outcome.result.content === 'string' ? outcome.result.content : undefined
  options.cache.set(key, outcome.result.sources, outcome.usedEngine, note)
  return { ...outcome, cached: false }
}

/**
 * Run one search through the chain.
 *
 * Returns as soon as an engine yields at least one source — a second engine
 * is only consulted when the previous one failed or came back empty, so a
 * working first choice never pays for the rest of the list. A `content`
 * (generated answer) from any attempt is preserved; sources merge across
 * attempts, which is what lets a partially-successful chain still return
 * something useful.
 *
 * @param steps - engines to try, in preference order.
 * @param request - the seam's request (query + optional maxResults cap).
 * @param options - mode, budget, rotation counter, and the caller's signal.
 */
export async function runChain(
  steps: readonly ChainStep[],
  request: WebSearchRequest,
  options: {
    readonly mode: ChainMode
    readonly timeoutMs: number
    readonly maxResults: number
    readonly rotation: number
    readonly signal?: AbortSignal
  },
): Promise<ChainOutcome> {
  const limit = Math.min(request.maxResults ?? options.maxResults, options.maxResults)
  const ordered = rotated(steps, startOffset(options.mode, steps.length, options.rotation))
  const { signal, dispose } = composeSignal(options.signal, options.timeoutMs)
  const attempts: AttemptRecord[] = []
  const succeeded: { sources: readonly WebSearchSource[] }[] = []
  const skipped: string[] = []

  try {
    for (const step of ordered) {
      // A spent budget is not a failure of the next engine, so it is recorded
      // as "skipped" and reported separately — the distinction is what tells
      // a user whether to raise the timeout or fix an engine.
      if (signal.aborted) {
        skipped.push(step.id)
        continue
      }
      const startedAt = Date.now()
      try {
        const sources = await step.engine.run({
          query: request.query,
          maxResults: limit,
          signal,
        })
        attempts.push({ id: step.id, ok: true, resultCount: sources.length, latencyMs: Date.now() - startedAt })
        if (sources.length > 0) succeeded.push({ sources })
        if (succeeded.length >= SATISFYING_RESULT_COUNT) break
      } catch (error) {
        // Caller cancellation must propagate: continuing the walk would turn
        // a cancelled search into a full sweep of every engine.
        if (options.signal?.aborted === true) throw error
        attempts.push({
          id: step.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          resultCount: 0,
          latencyMs: Date.now() - startedAt,
        })
      }
    }
  } finally {
    dispose()
  }

  const sources = mergeSources(succeeded, limit)
  if (sources.length === 0 && succeeded.length === 0) {
    throw new ChainExhaustedError(attempts, skipped)
  }

  const usedEngine = attempts.find(attempt => attempt.ok && attempt.resultCount > 0)?.id
    ?? attempts.find(attempt => attempt.ok)?.id
    ?? ordered[0]?.id
    ?? 'unknown'
  const note = fallbackNote(attempts, usedEngine, skipped)
  return {
    result: {
      sources,
      truncated: false,
      ...note !== undefined ? { content: note } : {},
    },
    usedEngine,
    attempts,
    skipped,
  }
}
