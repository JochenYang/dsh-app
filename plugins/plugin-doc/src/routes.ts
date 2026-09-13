/**
 * Word-mode API under `/plugins/@dsh-app/plugin-doc/api`:
 *   GET /mode?sessionId= — whether the session's Word mode is on
 *   PUT /mode            — {sessionId, enabled}: turn Word mode on or off
 *   GET /office-active   — the suite-wide active-format claim, so the capsule
 *                          can stand down when another format supersedes it
 *
 * Same-origin and loopback-Host fences mirror the other suite plugins' routes
 * (each suite plugin bundles standalone, so the fence is duplicated by design
 * rather than shared). Enabling claims the shared office slot and disabling
 * releases it when this plugin still holds it, so the four office formats stay
 * mutually exclusive.
 *
 * @module @dsh-app/plugin-doc/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DocModeStore } from './mode-store.ts'
import { claimOfficeActive, readOfficeActive, releaseOfficeActive } from './office-active-store.ts'

/** Route namespace on the dsh web server (mirrored by the client half). */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-doc/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
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

/** Reject cross-origin and non-local callers with an answer, never a hung connection. */
function requireSameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (sameOrigin(req) && passesFence(req)) return true
  fail(res, 403, 'forbidden', 'cross-origin or non-local request')
  return false
}

/** Bounded JSON body read (the PUT body is two short fields). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 8_192) {
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

/** The client-facing mode state of one session. */
function modeStateOf(store: DocModeStore, sessionId: string): {
  enabled: boolean
  updatedAt: number | null
} {
  return { enabled: store.isEnabled(sessionId), updatedAt: store.updatedAtOf(sessionId) }
}

/**
 * Register the mode and shared-active routes.
 * @param webServer - the dsh web server service.
 * @param store - the session-mode store shared with the prompt section.
 * @param activeFile - absolute path of the suite-wide active-format claim.
 * @returns disposer removing the routes.
 */
export function registerDocRoutes(webServer: WebServerLike, store: DocModeStore, activeFile: string): () => void {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/mode`,
      handler: (req, res) => {
        if (!requireSameOrigin(req, res)) return
        if (req.method === 'GET') {
          const sessionId = new URL(req.url ?? '/', 'http://local').searchParams.get('sessionId')
          if (sessionId === null || sessionId === '') {
            fail(res, 400, 'bad-request', 'sessionId 不能为空')
            return
          }
          // An unknown session reads as "off" — the capsule treats that the same
          // as a fresh session, so no error surface is needed.
          ok(res, modeStateOf(store, sessionId))
          return
        }
        if (req.method !== 'PUT') {
          res.setHeader('Allow', 'GET, PUT')
          fail(res, 405, 'method-not-allowed', 'GET or PUT only')
          return
        }
        void readJsonBody(req)
          .then(async (body) => {
            const sessionId = body.sessionId
            if (typeof sessionId !== 'string' || sessionId === '') {
              fail(res, 400, 'bad-request', 'sessionId 必须是非空字符串')
              return
            }
            if (typeof body.enabled !== 'boolean') {
              fail(res, 400, 'bad-request', 'enabled 必须是 true 或 false')
              return
            }
            store.set(sessionId, body.enabled)
            if (body.enabled) await claimOfficeActive(activeFile, sessionId)
            else await releaseOfficeActive(activeFile, sessionId)
            ok(res, modeStateOf(store, sessionId))
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (8 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/office-active`,
      handler: (req, res) => {
        if (!requireSameOrigin(req, res)) return
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          fail(res, 405, 'method-not-allowed', 'GET only')
          return
        }
        ok(res, { active: readOfficeActive(activeFile) })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
