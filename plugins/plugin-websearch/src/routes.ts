/**
 * Settings-page API under `/plugins/@dsh-app/plugin-websearch/api`:
 *   GET  /config        — the masked config + per-engine status + active provider
 *   POST /config        — validate + persist + re-point the live provider
 *   POST /engine/test   — probe ONE engine (or all of them) with a real query
 *
 * Every route enforces same-origin plus a loopback-host fence (403 with a
 * body, never a hung connection). Reads MASK literal apiKey values (never
 * returned to the client); an update carrying the mask sentinel keeps the
 * stored value.
 *
 * Isolation note: the small HTTP helpers below intentionally mirror
 * plugin-mcp's routes.ts instead of being shared — each suite plugin bundles
 * standalone (esbuild, no cross-plugin runtime imports), so a shared util
 * would be a new package for ~40 lines.
 *
 * @module @dsh-app/plugin-websearch/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
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
  type ProviderStatus,
  type WebSearchFile,
} from './wire.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-websearch/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

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

/** Same-origin fence (compare host parts; Origin carries the scheme). */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Loopback-host fence: admit only requests whose Host names this machine's
 * loopback interface, so a rebinding/cross-site request carrying an
 * attacker's Host is refused even when it forges a matching Origin.
 */
function passesFence(req: IncomingMessage): boolean {
  const raw = req.headers.host
  if (typeof raw !== 'string' || raw === '') return false
  let hostname: string
  try {
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.setHeader('Content-Type', 'application/json')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Bounded JSON body read. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) {
        // Drain instead of destroy: the socket stays alive so the 413 answer
        // actually reaches the client.
        reject(new Error('payload-too-large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The client-facing view. Status is derived from the persisted config alone
 * (enabled? key present?) — no network — so opening the settings page never
 * fires a probe at six engines. Live latency arrives from `/engine/test`.
 *
 * @param seamAvailable - whether `ctx.web` exists AND this plugin's provider
 * is registered. Passed in rather than assumed: the banner it drives is the
 * only signal that the chain cannot run at all.
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
    ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: '当前内核没有 ctx.web 服务，品牌引擎链无法注册' }
    : !file.enabled
      ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: '品牌引擎链已被整体停用（配置 enabled: false）' }
      : !enginesReady
        ? { id: BRAND_PROVIDER_ID, selected: activeProvider === BRAND_PROVIDER_ID, state: 'unavailable', reason: '没有启用的引擎，请至少开启一个' }
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
      reason: '无法读取内核的 provider 注册表，可用性未知；点「端到端自检」可确认',
    }
  } else if (!upstream.registered) {
    upstreamStatus = {
      id: UPSTREAM_PROVIDER_ID,
      selected: activeProvider === UPSTREAM_PROVIDER_ID,
      state: 'unavailable',
      reason: '未注册：内核未挂载 web-search-deepseek（可能被 patch 层禁用），选它会导致搜索失败',
    }
  } else if (!upstream.usable) {
    upstreamStatus = {
      id: UPSTREAM_PROVIDER_ID,
      selected: activeProvider === UPSTREAM_PROVIDER_ID,
      state: 'unavailable',
      reason: '已注册但不可用：通常是没有配置 DeepSeek API Key，或 key 无效',
    }
  } else {
    upstreamStatus = { id: UPSTREAM_PROVIDER_ID, selected: activeProvider === UPSTREAM_PROVIDER_ID, state: 'ready' }
  }

  return [brand, upstreamStatus]
}

/**
 * Register the web search routes.
 * @param webServer - the dsh web server service.
 * @param store - the config store.
 * @param deps - host callbacks (provider switch + engine probe).
 * @returns disposer removing the routes.
 */
export function registerWebSearchRoutes(webServer: WebServerLike, store: WebSearchStore, deps: RouteDeps): () => void {
  const guard = (req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST'): boolean => {
    if (!sameOrigin(req) || !passesFence(req)) {
      fail(res, 403, 'forbidden', 'cross-origin request')
      return false
    }
    if (req.method !== method) {
      res.setHeader('Allow', method)
      fail(res, 405, 'method-not-allowed', `${method} only`)
      return false
    }
    return true
  }

  const respond = (res: ServerResponse): void => {
    const file = store.load()
    ok(res, buildView(store, deps.seamAvailable(), file.provider, deps.resolveKey, deps.upstreamStatus()))
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        respond(res)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config/save`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then((body) => {
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
                fail(res, 400, 'bad-request', error.message)
              } else {
                fail(res, 500, 'io', `写入配置失败：${error instanceof Error ? error.message : String(error)}`)
              }
              return
            }
            respond(res)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (64 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/engine/test`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then(async (body) => {
            const query = typeof body.query === 'string' && body.query.trim() !== ''
              ? body.query.trim()
              : 'DeepSeek Harness'
            const file = store.load()
            // `id` absent = test every enabled engine (the "一键自检" button).
            const targets = typeof body.id === 'string' && body.id !== ''
              ? file.engines.filter(entry => entry.id === body.id)
              : file.engines.filter(entry => entry.enabled)
            if (targets.length === 0) {
              fail(res, 400, 'bad-request', '没有可测试的引擎')
              return
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
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
            ok(res, { query, results, provider: file.provider, brandProviderId: BRAND_PROVIDER_ID })
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (64 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/selftest`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then(async (body) => {
            const query = typeof body.query === 'string' && body.query.trim() !== ''
              ? body.query.trim()
              : 'DeepSeek Harness'
            try {
              const outcome = await deps.searchThroughSeam(query)
              ok(res, { query, ...outcome })
            } catch (error) {
              // A self-test that cannot run is a result, not a server error:
              // the message is what the user needs to read.
              ok(res, {
                query,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                chainExhausted: deps.isChainExhausted(error),
              })
            }
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (64 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
