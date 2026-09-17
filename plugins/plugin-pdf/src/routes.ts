/**
 * PDF-mode API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-pdf`:
 *   GET  /mode?sessionId= — whether the session's PDF mode is on
 *   POST /mode            — {sessionId, enabled}: turn PDF mode on or off
 *   GET  /office-active   — the suite-wide active-format claim, so the capsule
 *                           can stand down when another format supersedes it
 *   GET  /font-status     — read-only check that the bundled CJK font asset is
 *                           readable (the pdf_render dependency), so a runtime
 *                           packaged without assets/ fails loudly and early
 *                           instead of only inside a failed render
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin fence
 * and browser authentication before a route handler runs, so a route never
 * re-checks them. Enabling claims the shared office slot and disabling releases
 * it when this plugin still holds it, so the four office formats stay mutually
 * exclusive.
 *
 * Two registry rules shape the paths: a segment admits only `[A-Za-z0-9_$.-]`,
 * so the npm scope travels as `dsh-app` and a session id rides the query string
 * rather than a path segment; and only GET/HEAD/POST exist, so the mode write is
 * a POST (a PUT would fall through to the shared channel's own 404).
 *
 * @module @dsh-app/plugin-pdf/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { PdfModeStore } from './mode-store.ts'
import { claimOfficeActive, readOfficeActive, releaseOfficeActive } from './office-active-store.ts'
import { bundledFontStatus } from './pdfd/font.ts'

/**
 * Route namespace on the shared `/api` channel (mirrored by the client half).
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-pdf'

/** Cap on one request body: the mode write carries two short fields. */
const MAX_BODY_BYTES = 8_192

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

function fail(status: number, code: string, message: string): Response {
  return sendJson(status, { ok: false, error: { code, message } })
}

/**
 * Bounded JSON body read. The carrier has already buffered the body (the route
 * declares `requestBody: 'buffered'`) under the channel's own cap; this much
 * smaller route limit is checked before parsing so an oversized body never
 * reaches the mode store.
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
 * Register the mode and shared-active routes on the Connection exact-Fetch
 * registry. Every route owns its exact path and its methods; another method of
 * the same path falls through to the shared channel's own 404.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param store - the session-mode store shared with the prompt section.
 * @param activeFile - absolute path of the suite-wide active-format claim.
 * @returns disposer removing the routes.
 */
export function registerPdfRoutes(
  connectionFetch: HostConnectionFetch,
  store: PdfModeStore,
  activeFile: string,
): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/mode`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const sessionId = new URL(request.url).searchParams.get('sessionId')
          if (sessionId === null || sessionId === '') return fail(400, 'bad-request', 'sessionId 不能为空')
          // An unknown session reads as "off" — the capsule treats that the
          // same as a fresh session, so no error surface is needed.
          return ok({ enabled: store.isEnabled(sessionId), updatedAt: store.updatedAtOf(sessionId) })
        }
        try {
          const body = await readJsonBody(request)
          const sessionId = body.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') {
            return fail(400, 'bad-request', 'sessionId 必须是非空字符串')
          }
          if (typeof body.enabled !== 'boolean') {
            return fail(400, 'bad-request', 'enabled 必须是 true 或 false')
          }
          store.set(sessionId, body.enabled)
          if (body.enabled) await claimOfficeActive(activeFile, sessionId)
          else await releaseOfficeActive(activeFile, sessionId)
          return ok({ enabled: store.isEnabled(sessionId), updatedAt: store.updatedAtOf(sessionId) })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'invalid body'
          if (message === 'payload-too-large') {
            return fail(413, 'payload-too-large', 'request body too large (8 KiB cap)')
          }
          return fail(400, 'bad-request', message)
        }
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/office-active`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => ok({ active: readOfficeActive(activeFile) }),
    }),
    // Appended last: existing callers index the routes array by position, and
    // the mode route must stay first.
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/font-status`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return ok(await bundledFontStatus())
        } catch (cause: unknown) {
          return fail(500, 'font-status-error', cause instanceof Error ? cause.message : String(cause))
        }
      },
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
