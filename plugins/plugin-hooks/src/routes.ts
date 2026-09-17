/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-hooks`:
 *   GET  /hooks          — sanitized bridges + mount status + file path
 *   POST /bridge/create  — validate + persist + dynamically mount
 *   POST /bridge/update  — validate + persist + remount (or unmount when disabled)
 *   POST /bridge/delete  — persist + unmount
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so no route re-checks them — the same-origin
 * and loopback-Host guards this module used to run against the web server are
 * gone with it. Every route owns its exact path (the registry admits no
 * parameter segment, so arguments ride the body) and its methods; another
 * method of the same path falls through to the shared channel's own 404 rather
 * than a route body. Body cap 16 KiB. No secret masking needed (bridges carry
 * file paths only, no credentials).
 *
 * Isolation note: the small transport helpers below (sendJson, ok/fail,
 * readJsonBody) intentionally mirror plugin-market's routes.ts instead of being
 * shared — each suite plugin bundles standalone (esbuild, no cross-plugin
 * runtime imports), so a shared util would be a new package for ~30 lines.
 *
 * @module @dsh-app/plugin-hooks/routes
 */

import { HooksValidationError, HooksStore } from './store.ts'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { HooksMountManager } from './mount.ts'
import type { NativeHookRuntime } from './native.ts'
import type { HooksBridge, HooksMountStatus, HostText } from './wire.ts'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-hooks` travels as `dsh-app/plugin-hooks`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-hooks'

/** Cap on one request body: a bridge definition is small. */
const MAX_BODY = 16_384

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

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
function ok(value: unknown): Response { return sendJson(200, { ok: true, value }) }
/**
 * Failure answer. `kind` is the transport-ish category; `host` is the coded
 * message the UI renders in its own language, and the plain `message` stays an
 * English diagnostic for logs and for a client that does not know the code yet.
 */
function fail(status: number, kind: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code: kind, message: host.text ?? host.code, host } })
}

/**
 * Bounded JSON body read. The carrier has already buffered the body (the route
 * declares `requestBody: 'buffered'`) under the channel's own cap; this much
 * smaller route limit is checked before parsing.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** Body-read failure: `invalid body`, or the JSON parser's own text. */
function bodyFailure(error: unknown): Response {
  const detail = error instanceof Error ? error.message : 'invalid body'
  if (detail === 'payload-too-large') {
    return fail(413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (16 KiB cap)' })
  }
  return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail }, text: detail })
}

/**
 * Register the hooks routes on the Connection exact-Fetch registry.
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param store - the persisted bridge store.
 * @param manager - the compatibility-bridge mount manager.
 * @param native - the native rule runtime.
 * @returns disposer removing the routes.
 */
export function registerHooksRoutes(
  connectionFetch: HostConnectionFetch,
  store: HooksStore,
  manager: HooksMountManager,
  native: NativeHookRuntime,
): () => Promise<void> {
  /** Status dispatch: native entries report from the native runtime, compatibility bridges from the mount manager. */
  const statusFor = (bridge: HooksBridge): HooksMountStatus =>
    bridge.dialect === 'native'
      ? native.statusFor(bridge.id) ?? { state: 'starting' }
      : manager.statusFor(bridge)

  const respond = (): Response => {
    const file = store.load()
    const bridges: BridgeView[] = file.bridges.map(b => ({ ...b, status: statusFor(b) }))
    return ok({ enabled: file.enabled, filePath: store.filePath, mountAvailable: manager.available, bridges } satisfies HooksResponse)
  }

  /** The 409 answer for a write while the whole plugin is disabled, or null when the write may proceed. */
  const guardWrite = (): Response | null =>
    store.load().enabled ? null : fail(409, 'disabled', { code: 'route.disabled' })

  /** Write-store failure: the client's copy owns the sentence, the reason
   * rides as the code's English text. */
  const writeFailed = (error: unknown): HostText => {
    const detail = error instanceof Error ? error.message : String(error)
    return { code: 'route.writeFailed', params: { detail }, text: detail }
  }

  /** One create/update/delete step: read the body, enforce the enable gate, apply, answer with the new state. */
  const mutate = async (request: Request, apply: (body: Record<string, unknown>) => Promise<void>): Promise<Response> => {
    let body: Record<string, unknown>
    try { body = await readJsonBody(request) } catch (error) { return bodyFailure(error) }
    const blocked = guardWrite()
    if (blocked !== null) return blocked
    try {
      await apply(body)
      native.sync(store.load().bridges.filter(b => b.dialect === 'native'))
    } catch (error) {
      if (error instanceof HooksValidationError) return fail(400, 'bad-request', error.hostText())
      return fail(500, 'io', writeFailed(error))
    }
    return respond()
  }

  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/hooks`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => respond(),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/bridge/create`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => mutate(request, async (body) => { await manager.syncOne(store.create(body)) }),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/bridge/update`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => mutate(request, async (body) => {
        const id = typeof body.id === 'string' ? body.id : ''
        await manager.syncOne(store.update(id, body))
      }),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/bridge/delete`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => mutate(request, async (body) => {
        const id = typeof body.id === 'string' ? body.id : ''
        store.remove(id)
        await manager.unmount(id)
      }),
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
