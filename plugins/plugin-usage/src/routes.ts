/**
 * Host API routes for the usage plugin.
 *
 * Four GET endpoints on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-usage`:
 *   /status   — liveness signal ({active, reason?})
 *   /summary  — totals + per-day series + per-model table (?days=N)
 *   /heatmap  — calendar cells (?weeks=N)
 *   /balance  — proxied DeepSeek official balance (GET /user/balance),
 *               TTL-cached; ?fresh=1 bypasses the cache (manual re-query)
 *
 * The transport is the desktop host's Connection registry
 * (`ctx.connection.fetch`), not the dsh web server: the host disables its
 * `webserver` row, so a plugin that injects `webServer` never activates at
 * all. An exact path per endpoint keeps the namespace independent, so a
 * third-party usage plugin can never collide with these routes — the registry
 * rejects a duplicate path by throwing.
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them.
 *
 * Every failure crosses as a coded `HostText` (see types.ts) carrying an
 * ENGLISH diagnostic: the settings page owns the wording, in either language.
 *
 * @module @dsh-app/plugin-usage/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { DAY_MS, heatmap, startOfLocalDay, summarize } from './aggregate.ts'
import type { HostText, UsageBalance, UsageBalanceSnapshot, UsagePrice } from './types.ts'
import type { UsageStore } from './store.ts'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-usage` travels as `dsh-app/plugin-usage`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-usage'

/**
 * How long a successful balance fetch stays reusable. The balance only moves
 * on spend/top-up, so short-burst re-entries into the settings page share one
 * upstream call instead of re-sending the API key on every visit.
 */
const BALANCE_TTL_MS = 5 * 60_000

/**
 * The answer of every data route while the user config has the collector off.
 * Coded, not worded: the settings page renders it in the active UI language.
 */
const DISABLED: HostText = {
  code: 'disabled',
  text: 'built-in usage collection is disabled by the user config file',
}

/**
 * Balance failures the client distinguishes. Kebab-case because these codes
 * already travel on the wire; each names a failure, not a sentence — the copy
 * lives in the client dictionary (`usage.host.balance*`).
 */
export type BalanceErrorCode =
  | 'missing-credential'
  | 'invalid-credential'
  /** Any other upstream refusal with no more specific code. */
  | 'upstream'
  | 'upstream-http'
  | 'upstream-timeout'
  | 'upstream-network'

/**
 * Error thrown by the balance fetcher; code decides the route's response.
 *
 * Carries a code plus its params rather than a zh-CN sentence: the client
 * renders the copy, and `text` keeps an English developer-facing diagnostic
 * for logs and for a client that does not know the code (see {@link HostText}).
 */
export class BalanceError extends Error {
  /**
   * @param code - stable failure code.
   * @param text - English developer-facing diagnostic.
   * @param params - values the client's copy interpolates.
   */
  constructor(
    readonly code: BalanceErrorCode,
    readonly text: string,
    readonly params?: Readonly<Record<string, string | number>>,
  ) {
    super(text)
    this.name = 'BalanceError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.params === undefined
      ? { code: this.code, text: this.text }
      : { code: this.code, params: this.params, text: this.text }
  }
}

/** Fetcher injected by the host half: resolve the key, call the official API. */
export type BalanceFetcher = () => Promise<UsageBalance>

/** Route-layer options. */
export interface UsageRoutesOptions {
  /** Merged price table (built-in defaults overridden by config). Unused when disabled. */
  pricing?: UsagePrice[]
  /** Whether collection is live; false → only /status answers, data routes 503. */
  active: boolean
  /** Balance fetcher; absent → /balance answers 503 (disabled mode). */
  fetchBalance?: BalanceFetcher
}

function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Read-only report data: never cached, never sniffed.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * Failure answer. `kind` is the transport-ish category the client already
 * checked; `host` is the coded message the UI renders in its own language. The
 * plain `message` stays an English diagnostic for logs and for a client that
 * does not know the code yet.
 */
function fail(status: number, kind: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code: kind, message: host.text ?? host.code, host } })
}

function readInt(url: URL, key: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) return fallback
  return parsed
}

/**
 * Register the four API routes on the Connection exact-Fetch registry.
 *
 * Every route owns its exact path and its method (`GET`); a request with any
 * other method continues through the shared channel's own dispatch instead of
 * reaching this handler.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param store - the usage store; null in user-disabled mode (data routes 503).
 * @param options - route-layer options.
 * @returns an asynchronous disposer removing all of them.
 */
export function registerUsageRoutes(
  connectionFetch: HostConnectionFetch,
  store: UsageStore | null,
  options: UsageRoutesOptions,
): () => Promise<void> {
  const statusHandler = async (): Promise<Response> =>
    ok(options.active ? { active: true } : { active: false, reason: 'disabled-by-user-config' })
  const summaryHandler = async (request: Request): Promise<Response> => {
    if (!options.active || store === null) {
      return fail(503, 'disabled', DISABLED)
    }
    const days = readInt(new URL(request.url, 'http://localhost'), 'days', 30, 366)
    return ok(summarize(store.all(), days, options.pricing ?? []))
  }
  const heatmapHandler = async (request: Request): Promise<Response> => {
    if (!options.active || store === null) {
      return fail(503, 'disabled', DISABLED)
    }
    const weeks = readInt(new URL(request.url, 'http://localhost'), 'weeks', 26, 104)
    const today = startOfLocalDay(Date.now())
    const since = today - (weeks * 7 - 1) * DAY_MS
    return ok({
      weeks,
      since,
      until: today + DAY_MS - 1,
      cells: heatmap(store.all(), weeks, since, today + DAY_MS - 1),
    })
  }
  // Balance cache: only SUCCESSFUL fetches populate it (a failing silent
  // refresh must not poison the next attempt) and the timestamp survives
  // cache hits so the card can show the true upstream query time.
  let balanceCached: UsageBalanceSnapshot | null = null
  let balanceInflight: Promise<UsageBalanceSnapshot> | null = null
  const runBalanceFetch = (): Promise<UsageBalanceSnapshot> => {
    // Single-flight: concurrent callers (mount refresh racing a click) join
    // the same upstream call instead of firing duplicates.
    if (balanceInflight !== null) return balanceInflight
    const fetcher = options.fetchBalance
    if (fetcher === undefined) {
      return Promise.reject(new BalanceError('missing-credential', 'no DeepSeek API key is configured for this kernel'))
    }
    balanceInflight = fetcher().then((balance): UsageBalanceSnapshot => {
      const snapshot = { balance, fetchedAt: Date.now() }
      balanceCached = snapshot
      return snapshot
    }).finally(() => { balanceInflight = null })
    return balanceInflight
  }
  const balanceHandler = async (request: Request): Promise<Response> => {
    if (!options.active || options.fetchBalance === undefined) {
      return fail(503, 'disabled', DISABLED)
    }
    const fresh = new URL(request.url, 'http://localhost').searchParams.get('fresh') === '1'
    try {
      const cacheHit = !fresh && balanceCached !== null && Date.now() - balanceCached.fetchedAt < BALANCE_TTL_MS
      return ok(cacheHit ? balanceCached : await runBalanceFetch())
    } catch (error) {
      if (error instanceof BalanceError) {
        // 502 for upstream trouble, 503 when the account side isn't usable here.
        const credential = error.code === 'missing-credential' || error.code === 'invalid-credential'
        return fail(credential ? 503 : 502, error.code, error.hostText())
      }
      // An unexpected throw from an injected fetcher: still a coded answer, with
      // the thrown message as the English diagnostic.
      return fail(502, 'upstream', {
        code: 'upstream',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const disposers = [
    connectionFetch.register({ path: `${ROUTE_PREFIX}/status`, methods: ['GET'], requestBody: 'buffered', fetch: statusHandler }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/summary`, methods: ['GET'], requestBody: 'buffered', fetch: summaryHandler }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/heatmap`, methods: ['GET'], requestBody: 'buffered', fetch: heatmapHandler }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/balance`, methods: ['GET'], requestBody: 'buffered', fetch: balanceHandler }),
  ]
  return async () => {
    for (const dispose of disposers) await dispose()
  }
}
