/**
 * Host API routes for the usage plugin.
 *
 * Four GET endpoints under the plugin's route namespace on the dsh web
 * server (`/plugins/@dsh-app/plugin-usage/api`):
 *   /status   — liveness signal ({active, reason?})
 *   /summary  — totals + per-day series + per-model table (?days=N)
 *   /heatmap  — calendar cells (?weeks=N)
 *   /balance  — proxied DeepSeek official balance (GET /user/balance)
 *
 * The namespace deliberately lives inside the loader-owned `/plugins/<pkg>`
 * prefix with an `/api` segment (same discipline as plugin-sidebar): the
 * package root belongs to the client-modules system, and an independent
 * namespace means a third-party usage plugin can never collide with these
 * routes — the web server rejects duplicate paths by throwing.
 *
 * @module @dsh-app/plugin-usage/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DAY_MS, heatmap, startOfLocalDay, summarize } from './aggregate.ts'
import type { UsageBalance, UsagePrice } from './types.ts'
import type { UsageStore } from './store.ts'

/** Route namespace on the dsh web server (inside the plugin's package prefix). */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-usage/api'

/** Structural slice of the webServer service the routes consume. */
export interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** Balance failures the client distinguishes (each with its own zh-CN message). */
export type BalanceErrorCode = 'missing-credential' | 'invalid-credential' | 'upstream'

/** Error thrown by the balance fetcher; code decides the route's response. */
export class BalanceError extends Error {
  readonly code: BalanceErrorCode
  constructor(code: BalanceErrorCode, message: string) {
    super(message)
    this.code = code
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

function ok(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Same-origin fence: an absent Origin is fine (same-origin fetch sends none). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  const host = req.headers.host
  if (host === undefined) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

function requireGet(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    fail(res, 405, 'method-not-allowed', 'GET only')
    return false
  }
  return true
}

function readInt(url: URL, key: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) return fallback
  return parsed
}

/**
 * Register the four API routes.
 * @param webServer - the dsh web server service.
 * @param store - the usage store; null in user-disabled mode (data routes 503).
 * @param options - route-layer options.
 * @returns a disposer removing all of them.
 */
export function registerUsageRoutes(webServer: WebServerLike, store: UsageStore | null, options: UsageRoutesOptions): () => void {
  const statusHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req) || !requireGet(req, res)) return
    ok(res, options.active ? { active: true } : { active: false, reason: 'disabled-by-user-config' })
  }
  const summaryHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req) || !requireGet(req, res)) return
    if (!options.active || store === null) {
      fail(res, 503, 'disabled', 'built-in usage collection is disabled by the user config file')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const days = readInt(url, 'days', 30, 366)
    ok(res, summarize(store.all(), days, options.pricing ?? []))
  }
  const heatmapHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req) || !requireGet(req, res)) return
    if (!options.active || store === null) {
      fail(res, 503, 'disabled', 'built-in usage collection is disabled by the user config file')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const weeks = readInt(url, 'weeks', 26, 104)
    const today = startOfLocalDay(Date.now())
    const since = today - (weeks * 7 - 1) * DAY_MS
    ok(res, {
      weeks,
      since,
      until: today + DAY_MS - 1,
      cells: heatmap(store.all(), weeks, since, today + DAY_MS - 1),
    })
  }
  const balanceHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!sameOrigin(req) || !requireGet(req, res)) return
    if (!options.active || options.fetchBalance === undefined) {
      fail(res, 503, 'disabled', 'built-in usage collection is disabled by the user config file')
      return
    }
    try {
      ok(res, await options.fetchBalance())
    } catch (error) {
      if (error instanceof BalanceError) {
        // 502 for upstream trouble, 503 when the account side isn't usable here.
        const status = error.code === 'upstream' ? 502 : 503
        fail(res, status, error.code, error.message)
        return
      }
      fail(res, 502, 'upstream', '查询余额失败，请稍后重试')
    }
  }
  const disposers = [
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: statusHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/summary`, handler: summaryHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/heatmap`, handler: heatmapHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/balance`, handler: (req, res) => { void balanceHandler(req, res) } }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
