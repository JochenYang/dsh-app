/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-websearch`:
 *   GET  /config        — the masked config + per-engine status + active provider
 *   POST /config/save   — validate + persist + re-point the live provider
 *   POST /engine/test   — probe ONE engine (or all of them) with a real query
 *   POST /selftest      — run one search through `ctx.web.search` itself,
 *                         plus the fetch transport's network verdict
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
import type { FetchNetworkStatus } from './fetch/provider.ts'
import { WebSearchStore } from './store.ts'
import {
  activeEngines,
  BRAND_PROVIDER_ID,
  engineBlockReason,
  engineSpec,
  maskEngines,
  unmaskEngines,
  UPSTREAM_PROVIDER_IDS,
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
  /**
   * Re-point `ctx.web`'s configured search provider at the saved choice.
   *
   * The seam's config field is a read-only volatile reference, so the write
   * goes through the kernel's own config editor — the path its settings pages
   * take — and is therefore async. A rejection is a save the host could not
   * apply, which the route reports instead of acknowledging silently.
   */
  applyProviderChoice(file: WebSearchFile): Promise<void>
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
   * Every search provider the seam's registry holds right now, mapped to its
   * own `available()`. Undefined when the registry is not inspectable (a kernel
   * whose seam shape differs), which the view renders as "unknown" rather than
   * a false green.
   */
  providerAvailability(): ReadonlyMap<string, boolean> | undefined
  /**
   * The provider id `ctx.web` is configured with right now — the seam's own
   * live value, not this plugin's stored preference. Undefined when the seam
   * cannot be read, in which case the view falls back to the stored id.
   */
  activeProviderId(): string | undefined
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
  /**
   * The fetch transport's current verdict: which route (proxy / direct) and
   * resolver (system / DoH) the NEXT `web_fetch` will use, refreshed so the
   * answer is current rather than up to a TTL window old. Carries no user
   * URLs — the canary only ever probes a neutral host.
   */
  networkStatus(): Promise<FetchNetworkStatus>
  /**
   * Fetch one fixed, small URL through the REAL seam (`ctx.web.fetch`), so
   * the self-check exercises the exact path the model's `web_fetch` tool
   * takes — provider resolution included. The verdict line above says which
   * path a fetch will use; this proves the path works right now. Throws on
   * failure; the route maps it onto a coded result.
   */
  fetchProbe(): Promise<{ readonly statusCode: number, readonly bytes: number, readonly latencyMs: number }>
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
 * @param activeProvider - the id `ctx.web` is configured with right now, as the
 *   seam reports it. It is what the page marks as active AND what the file
 *   reflects back: the loader row is the authority on which provider answers,
 *   so a stale stored preference must never be echoed as the current choice.
 * @param availability - the seam's registry, or undefined when unreadable.
 */
export function buildView(
  store: WebSearchStore,
  seamAvailable: boolean,
  activeProvider: string,
  resolveKey: (entry: EngineEntry) => string | undefined,
  availability: ReadonlyMap<string, boolean> | undefined,
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
    // `provider` follows the seam, not the stored preference: the two drift
    // apart when the loader row was edited outside this page, and echoing the
    // stored value would then hide the drift.
    file: { ...file, provider: activeProvider, engines: maskEngines(file.engines) },
    engines,
    activeProvider,
    providers: buildProviderStatuses(file, seamAvailable, activeProvider, availability),
    filePath: store.filePath,
    seamAvailable,
  }
}

/**
 * Compute every provider choice's real state.
 *
 * The brand side is knowable locally: it is usable exactly when at least one
 * engine can run. The upstream side is NOT — whether a DeepSeek provider is
 * registered depends on the composed loader tree (its row can be disabled by
 * a patch layer), and whether it is usable depends on a DeepSeek credential
 * the seam resolves at call time.
 *
 * So the cards come from TWO sources: the ids this line is expected to mount
 * ({@link UPSTREAM_PROVIDER_IDS}) and everything the live registry actually
 * holds. The expected ids get an explicit state — `unknown` when the registry
 * is unreadable, `unavailable` with a "not registered" reason when the row is
 * missing, and the provider's own `available()` verdict otherwise — because a
 * provider that is simply absent would otherwise vanish from a page whose
 * whole job is offering the choice. Registry entries nobody expected are
 * appended, not hidden: a third-party provider the model can resolve to is
 * worth seeing.
 *
 * @param file - the persisted config (brand-chain usability).
 * @param seamAvailable - false when the brand provider itself never registered.
 * @param activeProvider - the id `ctx.web` resolves to right now.
 * @param availability - the registry, or undefined when it cannot be read.
 * @returns one status per card, brand first, expected upstream ids next.
 */
export function buildProviderStatuses(
  file: WebSearchFile,
  seamAvailable: boolean,
  activeProvider: string,
  availability: ReadonlyMap<string, boolean> | undefined,
): ProviderStatus[] {
  const enginesReady = activeEngines(file).length > 0
  const brand: ProviderStatus = !seamAvailable
    ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: { code: 'provider.noSeam', text: 'this kernel has no ctx.web service, so the brand chain cannot register' } }
    : !file.enabled
      ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: { code: 'provider.disabled', text: 'the brand chain is switched off (enabled: false)' } }
      : !enginesReady
        ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: { code: 'provider.noEngines', text: 'no engine is enabled' } }
        : { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'ready' }

  if (availability === undefined) {
    return [brand, ...UPSTREAM_PROVIDER_IDS.map((id): ProviderStatus => ({
      id,
      selected: activeProvider === id,
      state: 'unknown',
      reason: { code: 'provider.upstreamUnknown', text: 'the provider registry could not be read; run the end-to-end self-check' },
    }))]
  }

  // The two upstream failure modes are distinct and worth telling apart: not
  // registered means the loader row is absent or disabled (a patch-layer
  // decision), registered-but-unusable means the provider is mounted but its
  // own `available()` says no (typically a missing DeepSeek key).
  const expected = UPSTREAM_PROVIDER_IDS.map((id): ProviderStatus => {
    const usable = availability.get(id)
    if (usable === undefined) {
      return {
        id,
        selected: activeProvider === id,
        state: 'unavailable',
        reason: { code: 'provider.upstreamUnregistered', text: `${id} is not registered on ctx.web (a patch layer may disable its loader row)` },
      }
    }
    if (!usable) {
      return {
        id,
        selected: activeProvider === id,
        state: 'unavailable',
        reason: { code: 'provider.upstreamUnusable', text: 'registered but unavailable: usually no DeepSeek API key, or an invalid one' },
      }
    }
    return { id, selected: activeProvider === id, state: 'ready' }
  })

  const known = new Set<string>([BRAND_PROVIDER_ID, ...UPSTREAM_PROVIDER_IDS])
  const additional = [...availability.keys()]
    .filter(id => !known.has(id))
    .sort()
    .map((id): ProviderStatus => (availability.get(id) === true
      ? { id, selected: activeProvider === id, state: 'ready' }
      : {
          id,
          selected: activeProvider === id,
          state: 'unavailable',
          reason: { code: 'provider.upstreamUnusable', text: 'registered, but its own availability check says no' },
        }))

  return [brand, ...expected, ...additional]
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
 * @param deps - host callbacks (engine probe, provider registry + selection).
 * @returns disposer removing the routes.
 */
export function registerWebSearchRoutes(
  connectionFetch: HostConnectionFetch,
  store: WebSearchStore,
  deps: RouteDeps,
): () => Promise<void> {
  const respond = (): Response => {
    const file = store.load()
    return ok(buildView(
      store,
      deps.seamAvailable(),
      deps.activeProviderId() ?? file.provider,
      deps.resolveKey,
      deps.providerAvailability(),
    ))
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
            // The store write is this page's record; the seam's configured
            // provider belongs to the loader. Re-pointing it is a write to the
            // profile patch through the kernel's config editor, so it can fail
            // on its own — and a page that acknowledged the save would then
            // show a source that never took effect.
            try {
              await deps.applyProviderChoice(file)
            } catch (error) {
              return fail(502, 'provider', {
                code: 'provider.switchFailed',
                text: error instanceof Error ? error.message : String(error),
              })
            }
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
        // The verdict is refreshed ONCE, before either half runs: the fetch
        // probe should meet the same decision the line reports, not a second
        // canary pass of its own.
        const network = await deps.networkStatus()
        try {
          const outcome = await deps.searchThroughSeam(query)
          try {
            const probe = await deps.fetchProbe()
            return ok({ query, ...outcome, network, fetch: { ok: true, ...probe } })
          } catch (fetchError) {
            // A fetch that cannot run is a result too — and it is the whole
            // point of the check: the verdict line says which path the next
            // fetch uses, this line says whether that path works right now.
            return ok({
              query,
              ...outcome,
              network,
              fetch: {
                ok: false,
                error: {
                  code: 'selftest.fetchFailed',
                  text: fetchError instanceof Error ? fetchError.message : String(fetchError),
                },
              },
            })
          }
        } catch (error) {
          // A self-test that cannot run is a result, not a server error:
          // the message is what the user needs to read.
          return ok({
            query,
            ok: false,
            network,
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
