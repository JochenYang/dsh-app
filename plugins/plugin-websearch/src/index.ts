/**
 * DSH APP web search plugin — host half.
 *
 * Registers ONE `ctx.web` search provider (id `dsh-app`) whose internal engine
 * chain falls back across Bing / AnySearch / SearXNG / Exa / Parallel. The
 * model-facing `web_search` tool is upstream's and never changes: swapping
 * engines is a provider-level concern, so this plugin adds no tool, and the
 * chain's fallback is invisible to the model apart from the note naming the
 * engine that answered.
 *
 * The upstream DeepSeek provider (`deepseek-official`) stays registered and
 * untouched. Which of the two `ctx.web` resolves is a single field — the
 * settings page's 原生/品牌 switch writes it and the runtime re-points
 * immediately, so the user can compare the two without editing overlay files
 * or restarting.
 *
 * Stability discipline: a kernel without the `ctx.web` seam degrades to
 * `seamAvailable: false` (routes still answer, nothing is registered) instead
 * of failing the boot. Engine failures are contained per engine by the chain.
 *
 * @module @dsh-app/plugin-websearch
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the web seam Context merge (ctx.web) + provider types.
import type {} from '@deepseek-ai/dsh-web'
import { ChainExhaustedError, runChainCached, SearchCache, type ChainStep } from './chain.ts'
import { createEngine } from './engines/index.ts'
import { registerWebSearchRoutes } from './routes.ts'
import { WebSearchStore } from './store.ts'
import { activeEngines, BRAND_PROVIDER_ID, UPSTREAM_PROVIDER_ID, type EngineEntry, type WebSearchFile } from './wire.ts'

export const name = 'plugin-websearch'

/**
 * The settings page rides the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['connection']

/** Config: storage location. */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-websearch. */
  storePath: string
}

export const Config: z<Config> = z.object({
  storePath: z.string().default(''),
})

/** `$ENV:NAME` reference syntax accepted in apiKey values (used by key-tier engines). */
const ENV_REF = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * Resolve one engine's key. `$ENV:NAME` reads the environment at call time (so
 * a rotated variable reaches the next search without a restart); a literal is
 * returned as-is; absent means "no key".
 *
 * No SHIPPED engine is key-tier yet (all six are free), so this is the
 * documented extension point for the next engine that needs one — it exists so
 * adding such an engine is a roster entry, not a plumbing change.
 */
export function resolveKey(entry: EngineEntry): string | undefined {
  if (entry.apiKey === undefined) return undefined
  const match = ENV_REF.exec(entry.apiKey)
  if (match === null) return entry.apiKey
  const value = process.env[match[1]]
  return value === undefined || value === '' ? undefined : value
}

/** Structural slice of the web seam: enough to register + resolve. */
interface WebSeamLike {
  registerSearchProvider(provider: {
    id: string
    available(): boolean
    search(request: { query: string, maxResults?: number }, signal?: AbortSignal): Promise<unknown>
  }): () => void
  searchProviderId?: string
  search?(request: { query: string, maxResults?: number }, signal?: AbortSignal): Promise<unknown>
  /**
   * The seam's private provider registry. Read structurally (never typed by
   * the upstream package, which does not export it) purely for the settings
   * page's availability badges — nothing here depends on it at search time.
   */
  searchProviders?: Map<string, { available(): boolean }>
}

/** One search's chain accounting (not part of the seam's portable result shape). */
interface SearchAccounting {
  readonly engine: string
  readonly cached: boolean
  readonly attempts: number
  readonly failed: readonly string[]
}

/**
 * A one-slot holder for the last search's accounting.
 *
 * A plain `let` does not work here: the write happens inside the provider
 * closure and the read happens at the self-test call site, so TypeScript's
 * control-flow analysis cannot see the assignment and narrows the variable to
 * `never`. A getter hides the value from narrowing, which is what makes the
 * read type-check honestly.
 */
class AccountingBox {
  private value: SearchAccounting | undefined

  set(next: SearchAccounting | undefined): void {
    this.value = next
  }

  get(): SearchAccounting | undefined {
    return this.value
  }
}
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-websearch')
  const store = new WebSearchStore(dir, (message) => log.warn(message))

  // The seam is a service on the context, not an injectable here: reading it
  // structurally keeps a kernel without `ctx.web` from throwing at activation.
  const seam = ctx.get('web') as WebSeamLike | undefined

  /** Round-robin counter for `rotate` mode; process-scoped by design. */
  let rotation = 0
  /** Result cache; cleared when the config changes (see the save route). */
  const cache = new SearchCache()
  /**
   * The last search's chain accounting. The seam's `WebSearchResult` has no
   * room for it (it is a portable shape owned upstream), so the self-test
   * reads it from here — that is what lets the UI show which engine actually
   * answered and whether the result was a cache hit.
   */
  const lastOutcome = new AccountingBox()

  /**
   * The provider. `available()` must stay a cheap local check (no network) —
   * the seam calls it on every resolution, and the settings page reflects it,
   * so it reports "usable" whenever at least one engine could run.
   */
  const provider = {
    id: BRAND_PROVIDER_ID,
    available(): boolean {
      const file = store.load()
      if (!file.enabled) return false
      return activeEngines(file).length > 0
    },
    async search(request: { query: string, maxResults?: number }, signal?: AbortSignal): Promise<unknown> {
      const file = store.load()
      const entries = activeEngines(file)
      if (entries.length === 0) {
        throw new Error('web search is disabled: enable at least one engine in Settings -> Web search')
      }
      const steps: ChainStep[] = entries.map(entry => ({
        id: entry.id,
        engine: createEngine(entry.id, file),
      }))
      rotation += 1
      const outcome = await runChainCached(steps, request, {
        mode: file.mode,
        timeoutMs: file.timeoutMs,
        maxResults: file.maxResults,
        rotation,
        cacheTtlMs: file.cacheTtlMinutes * 60_000,
        cache,
        ...signal !== undefined ? { signal } : {},
      })
      const failed = outcome.attempts.filter(attempt => !attempt.ok)
      lastOutcome.set({
        engine: outcome.usedEngine,
        cached: outcome.cached,
        attempts: outcome.attempts.length,
        failed: failed.map(attempt => attempt.id),
      })
      if (failed.length > 0) {
        log.info(`websearch: ${outcome.usedEngine} answered; failed: ${failed.map(a => `${a.id}(${a.error ?? ''})`).join(', ')}`)
      }
      return outcome.result
    },
  }

  if (seam !== undefined && typeof seam.registerSearchProvider === 'function') {
    ctx.effect(() => seam.registerSearchProvider(provider), 'plugin-websearch: search provider')
  } else {
    log.warn('websearch: ctx.web seam unavailable on this kernel; no provider registered')
  }

  /** Whether the provider is actually live (drives the settings-page banner). */
  const seamAvailable = (): boolean => seam !== undefined && typeof seam.registerSearchProvider === 'function'

  /**
   * Point `ctx.web` at the configured provider.
   *
   * The overlay pins `searchProvider: dsh-app`, so this only has to act when
   * the user chose the upstream provider (or switched back) — the assignment
   * is what makes the switch take effect without a restart. Written
   * defensively: a kernel whose seam exposes `searchProviderId` as a
   * read-only accessor simply keeps the overlay's value.
   */
  const applyProviderChoice = (file: WebSearchFile): void => {
    if (seam === undefined) return
    try {
      if (seam.searchProviderId !== file.provider) {
        seam.searchProviderId = file.provider
        log.info(`websearch: active search provider → ${file.provider}`)
      }
    } catch (error) {
      log.warn(`websearch: cannot switch search provider on this kernel: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Apply the persisted choice at activation so a restart honors the user's
  // switch even when the overlay says `dsh-app`.
  applyProviderChoice(store.load())

  ctx.effect(() => registerWebSearchRoutes(ctx.connection.fetch, store, {
    applyProviderChoice,
    probe: async (id, query) => {
      const file = store.load()
      const entry = file.engines.find(item => item.id === id)
      if (entry === undefined) throw new Error(`unknown engine: ${id}`)
      const engine = createEngine(entry.id, file)
      const startedAt = Date.now()
      // A probe gets its own generous budget: it exists to diagnose, so
      // reporting "timed out at the shared 25s budget" would conflate the
      // probe with a real search's constraints.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('probe timed out')), 20_000)
      try {
        const sources = await engine.run({
          query,
          maxResults: Math.min(file.maxResults, 5),
          signal: controller.signal,
        })
        return { latencyMs: Date.now() - startedAt, resultCount: sources.length }
      } finally {
        clearTimeout(timer)
      }
    },
    isChainExhausted: error => error instanceof ChainExhaustedError,
    seamAvailable,
    /** Config changed: cached answers may name an engine that is now off. */
    clearCache: () => { cache.clear() },
    resolveKey,
    /**
     * Read the upstream provider's state off the seam's registry. Guarded at
     * every step: the registry is an unexported implementation detail, so a
     * kernel that renames or hides it must degrade to "unknown" (the caller
     * renders that honestly) rather than throwing inside a GET route.
     */
    upstreamStatus: () => {
      try {
        const registry = seam?.searchProviders
        if (!(registry instanceof Map)) return undefined
        const provider = registry.get(UPSTREAM_PROVIDER_ID)
        if (provider === undefined) return { registered: false, usable: false }
        return { registered: true, usable: provider.available() }
      } catch {
        return undefined
      }
    },
    /**
     * Drive `ctx.web.search` itself. This is the self-check's whole point: it
     * resolves the provider through the seam's own selection rules, so a
     * misconfigured `searchProvider` (or an unavailable upstream provider)
     * surfaces here instead of at the next real search.
     */
    searchThroughSeam: async (query: string) => {
      if (seam === undefined || typeof seam.search !== 'function') {
        throw new Error('this kernel has no ctx.web service, so no search can run')
      }
      const file = store.load()
      lastOutcome.set(undefined)
      const startedAt = Date.now()
      const result = await seam.search({ query, maxResults: file.maxResults }) as {
        sources?: readonly unknown[]
        content?: unknown
      }
      const accounting = lastOutcome.get()
      return {
        provider: seam.searchProviderId ?? 'unknown',
        resultCount: Array.isArray(result?.sources) ? result.sources.length : 0,
        latencyMs: Date.now() - startedAt,
        // Chain accounting from the provider that just ran (absent when the
        // upstream DeepSeek provider answered instead).
        ...accounting === undefined ? {} : {
          cached: accounting.cached,
          engine: accounting.engine,
          failedEngines: accounting.failed,
        },
        ...typeof result?.content === 'string' && result.content !== '' ? { note: result.content } : {},
      }
    },
  }), 'plugin-websearch: api routes')

  log.info(`websearch store: ${store.filePath}`)
}
