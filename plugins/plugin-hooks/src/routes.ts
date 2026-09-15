/**
 * Settings-page API under `/plugins/@dsh-app/plugin-hooks/api`:
 *   GET  /hooks          — sanitized bridges + mount status + file path
 *   POST /bridge/create  — validate + persist + dynamically mount
 *   POST /bridge/update  — validate + persist + remount (or unmount when disabled)
 *   POST /bridge/delete  — persist + unmount
 *
 * Same-origin fence on all routes; body cap 16 KiB. No secret masking needed
 * (bridges carry file paths only, no credentials).
 *
 * Isolation note: the small HTTP helpers below (sameOrigin, sendJson, ok/fail,
 * readJsonBody) intentionally mirror plugin-mcp's routes.ts instead of being
 * shared — each suite plugin bundles standalone (esbuild, no cross-plugin
 * runtime imports), so a shared util would be a new package for ~30 lines.
 *
 * @module @dsh-app/plugin-hooks/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HooksValidationError, HooksStore } from './store.ts'
import type { HooksMountManager } from './mount.ts'
import type { NativeHookRuntime } from './native.ts'
import type { HooksBridge, HooksMountStatus, HostText } from './wire.ts'

export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-hooks/api'
const MAX_BODY = 16_384

interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

interface BridgeView extends Omit<HooksBridge, 'enabled'> {
  enabled: boolean
  status: HooksMountStatus
}

interface HooksResponse {
  enabled: boolean
  filePath: string
  mountAvailable: boolean
  bridges: readonly BridgeView[]
}

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
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
  try { hostname = new URL(`http://${raw}`).hostname } catch { return false }
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
function ok(res: ServerResponse, value: unknown): void { sendJson(res, 200, { ok: true, value }) }
/**
 * Failure answer. `kind` is the transport-ish category; `host` is the coded
 * message the UI renders in its own language, and the plain `message` stays an
 * English diagnostic for logs and for a client that does not know the code yet.
 */
function fail(res: ServerResponse, status: number, kind: string, host: HostText): void {
  sendJson(res, status, { ok: false, error: { code: kind, message: host.text ?? host.code, host } })
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.resume(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch (error) { reject(error instanceof Error ? error : new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

export function registerHooksRoutes(webServer: WebServerLike, store: HooksStore, manager: HooksMountManager, native: NativeHookRuntime): () => void {
  /** Status dispatch: native entries report from the native runtime, compatibility bridges from the mount manager. */
  const statusFor = (bridge: HooksBridge): HooksMountStatus =>
    bridge.dialect === 'native'
      ? native.statusFor(bridge.id) ?? { state: 'starting' }
      : manager.statusFor(bridge)

  const respond = async (res: ServerResponse): Promise<void> => {
    const file = store.load()
    const bridges: BridgeView[] = file.bridges.map(b => ({ ...b, status: statusFor(b) }))
    ok(res, { enabled: file.enabled, filePath: store.filePath, mountAvailable: manager.available, bridges } satisfies HooksResponse)
  }

  const guardWrite = (res: ServerResponse): boolean => {
    if (!store.load().enabled) { fail(res, 409, 'disabled', { code: 'route.disabled' }); return false }
    return true
  }

  /** Write-store failure: the client's copy owns the sentence, the reason
   * rides as the code's English text. */
  const writeFailed = (error: unknown): HostText => {
    const detail = error instanceof Error ? error.message : String(error)
    return { code: 'route.writeFailed', params: { detail }, text: detail }
  }

  /** Body-read failure: `invalid body`, or the JSON parser's own text. */
  const invalidBody = (error: unknown): HostText => {
    const detail = error instanceof Error ? error.message : 'invalid body'
    return { code: 'route.invalidBody', params: { detail }, text: detail }
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/hooks`,
      handler: (req, res) => {
        if (!sameOrigin(req) || !passesFence(req)) { fail(res, 403, 'forbidden', { code: 'route.crossOrigin', text: 'cross-origin request' }); return }
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); fail(res, 405, 'method-not-allowed', { code: 'route.methodOnly', params: { method: 'GET' }, text: 'GET only' }); return }
        void respond(res)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/bridge/create`,
      handler: (req, res) => {
        if (!sameOrigin(req) || !passesFence(req)) { fail(res, 403, 'forbidden', { code: 'route.crossOrigin', text: 'cross-origin request' }); return }
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(res, 405, 'method-not-allowed', { code: 'route.methodOnly', params: { method: 'POST' }, text: 'POST only' }); return }
        void readJsonBody(req).then(async (body) => {
          if (!guardWrite(res)) return
          try {
            const bridge = store.create(body)
            await manager.syncOne(bridge)
            native.sync(store.load().bridges.filter(b => b.dialect === 'native'))
          } catch (error) {
            if (error instanceof HooksValidationError) fail(res, 400, 'bad-request', error.hostText())
            else fail(res, 500, 'io', writeFailed(error))
            return
          }
          await respond(res)
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'invalid body'
          if (message === 'payload-too-large') { fail(res, 413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (16 KiB cap)' }); return }
          fail(res, 400, 'bad-request', invalidBody(error))
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/bridge/update`,
      handler: (req, res) => {
        if (!sameOrigin(req) || !passesFence(req)) { fail(res, 403, 'forbidden', { code: 'route.crossOrigin', text: 'cross-origin request' }); return }
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(res, 405, 'method-not-allowed', { code: 'route.methodOnly', params: { method: 'POST' }, text: 'POST only' }); return }
        void readJsonBody(req).then(async (body) => {
          if (!guardWrite(res)) return
          const id = typeof body.id === 'string' ? body.id : ''
          try {
            const bridge = store.update(id, body)
            await manager.syncOne(bridge)
            native.sync(store.load().bridges.filter(b => b.dialect === 'native'))
          } catch (error) {
            if (error instanceof HooksValidationError) fail(res, 400, 'bad-request', error.hostText())
            else fail(res, 500, 'io', writeFailed(error))
            return
          }
          await respond(res)
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'invalid body'
          if (message === 'payload-too-large') { fail(res, 413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (16 KiB cap)' }); return }
          fail(res, 400, 'bad-request', invalidBody(error))
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/bridge/delete`,
      handler: (req, res) => {
        if (!sameOrigin(req) || !passesFence(req)) { fail(res, 403, 'forbidden', { code: 'route.crossOrigin', text: 'cross-origin request' }); return }
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(res, 405, 'method-not-allowed', { code: 'route.methodOnly', params: { method: 'POST' }, text: 'POST only' }); return }
        void readJsonBody(req).then(async (body) => {
          if (!guardWrite(res)) return
          const id = typeof body.id === 'string' ? body.id : ''
          store.remove(id)
          await manager.unmount(id)
          native.sync(store.load().bridges.filter(b => b.dialect === 'native'))
          await respond(res)
        }).catch((error: unknown) => { fail(res, 400, 'bad-request', invalidBody(error)) })
      },
    }),
  ]
  return () => { for (const d of disposers) d() }
}
