/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-websearch`:
 *   GET  /config        — the masked config + per-engine status + active provider
 *   POST /config/save   — validate + persist + re-point the live provider
 *   POST /engine/test   — probe ONE engine (or all of them) with a real query
 *   POST /selftest      — run one search through `ctx.web.search` itself
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them. Reads MASK
 * literal apiKey values (never returned to the client); an update carrying the
 * mask sentinel keeps the stored value.
 *
 * Isolation note: the transport helpers below intentionally mirror
 * plugin-mcp's routes.ts instead of being shared — each suite plugin bundles
 * standalone (esbuild, no cross-plugin runtime imports), so a shared util
 * would be a new package for ~40 lines.
 *
 * @module @dsh-app/plugin-websearch/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { WebSearchStore } from './store.ts'
import {
  activeEngines,
  BRAND_PROVIDER_ID,
  engineBlockReason,
  engineSpec,
  maskEngines,
  unmaskEngines,
  UPSTREAM_PROVIDER_ID,
  WebSearchValidationError,
  type EngineEntry,
  type EngineStatus,
  type HostText,
  type ProviderStatus,
  type WebSearchFile,
} from './wire.ts'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-websearch` travels as
 * `dsh-app/plugin-websearch`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-websearch'

/** Cap on one request body: config saves and probe requests are small. */
const MAX_BODY_BYTES = 65_536

/** A single engine probe's outcome. */
export interface ProbeResult {
  readonly latencyMs: number
  readonly resultCount: number
}

/** The host services the routes need. */
export interface RouteDeps {
  /** Re-point `ctx.web.searchProvider` at the persisted choice. */
  applyProviderChoice(file: WebSearchFile): void
  /** Run one engine against a real query. Throws on failure. */
  probe(id: string, query: string): Promise<ProbeResult>
  /** Whether an error is the chain's "everything failed" signal. */
  isChainExhausted(error: unknown): boolean
  /** Whether this plugin's provider is actually registered on `ctx.web`. */
  seamAvailable(): boolean
  /** Drop cached results (config changed: an entry may name a disabled engine). */
  clearCache(): void
  /**
   * Resolve one engine's key (`$ENV:NAME` → the environment variable's value).
   * Lives on the host because only the host can read the environment; the
   * status badge must judge the RESOLVED key, or an unset variable would
   * report "ready" and fail at the next search.
   */
  resolveKey(entry: EngineEntry): string | undefined
  /**
   * The upstream provider's registration + usability, read off the seam's own
   * registry. Returns undefined when the registry is not inspectable (a kernel
   * whose seam shape differs), which the view renders as "unknown" rather than
   * a false green.
   */
  upstreamStatus(): { registered: boolean, usable: boolean } | undefined
  /**
   * Run one search through the REAL seam (`ctx.web.search`), so the self-check
   * exercises the exact path the model's `web_search` tool takes — including
   * provider resolution. Returns the answering provider id, source count, and
   * the fallback note (the text the model would see).
   */
  searchThroughSeam(query: string): Promise<{
    provider: string
    resultCount: number
    latencyMs: number
    cached?: boolean
    engine?: string
    failedEngines?: readonly string[]
    note?: string
  }>
}

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * Failure answer. `kind` is the transport-ish category (kept for the existing
 * client checks); `host` is the coded message the UI renders in its own
 * language. The plain `message` stays an English diagnostic for logs and for a
 * client that does not know the code yet.
 */
function fail(status: number, kind: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code: kind, message: host.text ?? host.code, host } })
}

/**
 * Bounded JSON body read. The carrier has already buffered the body (every
 * route declares `requestBody: 'buffered'`) under the channel's own cap; this
 * smaller route limit is checked before parsing, so an oversized body can
 * never reach the store.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/**
 * The client-facing view. Status is derived from the persisted config alone
 * (enabled? key present?) — no network — so opening the settings page never
 * fires a probe at six engines. Live latency arrives from `/engine/test`.
 *
 * @param seamAvailable - whether `ctx.web` exists AND this plugin's provider
 *   is registered. Passed in rather than assumed: the banner it drives is the
 *   only signal that the chain cannot run at all.
 */
export function buildView(
  store: WebSearchStore,
  seamAvailable: boolean,
  activeProvider: string,
  resolveKey: (entry: EngineEntry) => string | undefined,
  upstream: { registered: boolean, usable: boolean } | undefined,
): Record<string, unknown> {
  const file = store.load()
  const usable = new Set(activeEngines(file).map(entry => entry.id))
  const engines = file.engines.map((entry) => {
    const spec = engineSpec(entry.id)
    // `engineBlockReason` is the single owner of "why can this not run": the
    // chain filters with the same rule, so the badge and the behavior cannot
    // disagree. The key passed in is the RESOLVED one, so an unset
    // `$ENV:VAR` reports missing-key instead of a false "ready".
    const block = engineBlockReason(entry, resolveKey(entry), file.searxngInstances.length)
    let status: EngineStatus
    if (block !== undefined) {
      // `blocked` covers both "needs a key" and "needs an instance" — the
      // message carries which, so the badge does not have to guess from a
      // state name that only fits one of them.
      status = entry.enabled
        ? { state: 'blocked', message: block }
        : { state: 'disabled' }
    } else if (usable.has(entry.id)) status = { state: 'ready' }
    else status = { state: 'unknown' }
    return {
      ...spec,
      entry: { ...entry, ...entry.apiKey !== undefined ? { apiKey: maskEngines([entry])[0].apiKey } : {} },
      status,
    }
  })
  return {
    file: { ...file, engines: maskEngines(file.engines) },
    engines,
    activeProvider,
    providers: buildProviderStatuses(file, seamAvailable, activeProvider, upstream),
    filePath: store.filePath,
    seamAvailable,
  }
}

/**
 * Compute both provider choices' real state.
 *
 * The brand side is knowable locally: it is usable exactly when at least one
 * engine can run. The upstream side is NOT — whether `deepseek-official` is
 * registered depends on the composed loader tree (its row can be disabled by
 * a patch layer), and whether it is usable depends on a DeepSeek credential
 * the seam resolves at call time. Neither fact is exposed as a queryable API,
 * so this reports `unknown` with an explicit explanation rather than guessing
 * green: the settings page can then tell the user to verify with 端到端自检,
 * which is the check that actually answers it.
 */
export function buildProviderStatuses(
  file: WebSearchFile,
  seamAvailable: boolean,
  activeProvider: string,
  upstream: { registered: boolean, usable: boolean } | undefined,
): ProviderStatus[] {
  const enginesReady = activeEngines(file).length > 0
  const brand: ProviderStatus = !seamAvailable
    ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: { code: 'provider.noSeam', text: 'this kernel has no ctx.web service, so the brand chain cannot register' } }
    : !file.enabled
      ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: { code: 'provider.disabled', text: 'the brand chain is switched off (enabled: false)' } }
      : !enginesReady
        ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: { code: 'provider.noEngines', text: 'no engine is enabled' } }
        : { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'ready' }

  // The upstream side is answered from the seam's registry when it is
  // inspectable. The two failure modes are distinct and worth telling apart:
  // not registered means the loader row is absent or disabled (a patch-layer
  // decision), registered-but-unusable means the provider is mounted but its
  // own `available()` says no (typically a missing DeepSeek key).
  let upstreamStatus: ProviderStatus
  if (upstream === undefined) {
    upstreamStatus = {
      id: UPSTREAM_PROVIDER_ID,
      selected: activeProvider === UPSTREAM_PROVIDER_ID,
      state: 'unknown',
      reason: { code: 'provider.upstreamUnknown', text: 'the provider registry could not be read; run the end-to-end self-check' },
    }
  } else if (!upstream.registered) {
    upstreamStatus = {
      id: UPSTREAM_PROVIDER_ID,
      selected: activeProvider === UPSTREAM_PROVIDER_ID,
      state: 'unavailable',
      reason: { code: 'provider.upstreamUnregistered', text: 'web-search-deepseek is not mounted (a patch layer may disable it)' },
    }
  } else if (!upstream.usable) {
    upstreamStatus = {
      id: UPSTREAM_PROVIDER_ID,
      selected: activeProvider === UPSTREAM_PROVIDER_ID,
      state: 'unavailable',
      reason: { code: 'provider.upstreamUnusable', text: 'registered but unavailable: usually no DeepSeek API key, or an invalid one' },
    }
  } else {
    upstreamStatus = { id: UPSTREAM_PROVIDER_ID, selected: activeProvider === UPSTREAM_PROVIDER_ID, state: 'ready' }
  }

  return [brand, upstreamStatus]
}

/**
 * Register the web search routes on the Connection exact-Fetch registry.
 *
 * Every route owns its exact path (nothing here takes a path parameter) and
 * its methods; another method of the same path falls through to the shared
 * channel's own 404 rather than a route body.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param store - the config store.
 * @param deps - host callbacks (provider switch + engine probe).
 * @returns disposer removing the routes.
 */
export function registerWebSearchRoutes(
  connectionFetch: HostConnectionFetch,
  store: WebSearchStore,
  deps: RouteDeps,
): () => Promise<void> {
  const respond = (): Response => {
    const file = store.load()
    return ok(buildView(store, deps.seamAvailable(), file.provider, deps.resolveKey, deps.upstreamStatus()))
  }

  /** Map one body-read/validation failure onto its status + coded message. */
  const bodyFailure = (error: unknown): Response => {
    const message = error instanceof Error ? error.message : 'invalid body'
    if (message === 'payload-too-large') {
      return fail(413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (64 KiB cap)' })
    }
    return fail(400, 'bad-request', { code: 'route.invalidBody', text: message })
  }

  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/config`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => respond(),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/config/save`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJsonBody(request)
          const existing = store.load()
          try {
            // The client sends the whole config back; engine keys that came
            // down masked are re-attached from the stored copy here, so a
            // save that did not touch a key never destroys it.
            const merged = { ...body, engines: unmaskEngines(body.engines, existing.engines) }
            const file = store.save(merged)
            deps.applyProviderChoice(file)
            deps.clearCache()
          } catch (error) {
            if (error instanceof WebSearchValidationError) {
              return fail(400, 'bad-request', error.hostText())
            }
            return fail(500, 'io', { code: 'route.writeFailed', text: error instanceof Error ? error.message : String(error) })
          }
          return respond()
        } catch (error) {
          return bodyFailure(error)
        }
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/engine/test`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        const query = typeof body.query === 'string' && body.query.trim() !== ''
          ? body.query.trim()
          : 'DeepSeek Harness'
        const file = store.load()
        // `id` absent = test every enabled engine (the "一键自检" button).
        const targets = typeof body.id === 'string' && body.id !== ''
          ? file.engines.filter(entry => entry.id === body.id)
          : file.engines.filter(entry => entry.enabled)
        if (targets.length === 0) {
          return fail(400, 'bad-request', { code: 'route.noTestableEngine', text: 'no enabled engine to test' })
        }
        // Sequential on purpose: parallel probes against rate-limited free
        // engines would have them trip each other's quota and report
        // failures that a real (sequential) search would never see.
        const results: Record<string, unknown>[] = []
        for (const entry of targets) {
          const spec = engineSpec(entry.id)
          try {
            const probe = await deps.probe(entry.id, query)
            results.push({
              id: entry.id,
              label: spec?.label ?? entry.id,
              ok: true,
              latencyMs: probe.latencyMs,
              resultCount: probe.resultCount,
            })
          } catch (error) {
            results.push({
              id: entry.id,
              label: spec?.label ?? entry.id,
              ok: false,
              // A probe failure is a diagnostic (HTTP status, parse fault):
              // the client wraps it in its own copy and shows the detail.
              error: { code: 'engine.probeFailed', text: error instanceof Error ? error.message : String(error) },
            })
          }
        }
        return ok({ query, results, provider: file.provider, brandProviderId: BRAND_PROVIDER_ID })
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/selftest`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        const query = typeof body.query === 'string' && body.query.trim() !== ''
          ? body.query.trim()
          : 'DeepSeek Harness'
        try {
          const outcome = await deps.searchThroughSeam(query)
          return ok({ query, ...outcome })
        } catch (error) {
          // A self-test that cannot run is a result, not a server error:
          // the message is what the user needs to read.
          return ok({
            query,
            ok: false,
            error: {
              code: deps.isChainExhausted(error) ? 'selftest.chainExhausted' : 'selftest.failed',
              text: error instanceof Error ? error.message : String(error),
            },
            chainExhausted: deps.isChainExhausted(error),
          })
        }
      },
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
