/**
 * PPT-mode API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-ppt`:
 *   GET  /templates     — the bundled template catalog with cover-preview data
 *                         URLs for the picker panel (single image, capped size)
 *   GET  /mode?sessionId= — whether the mode is on and its template (null =
 *                         off, or on with 常规主题)
 *   POST /mode          — {sessionId, enabled, template}: turn the mode on
 *                         (template id or null for 常规主题) or off
 *   GET  /office-active — the suite-wide active-format claim, so the capsule
 *                         can stand down when another format supersedes it
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them. The template
 * value is validated against the bundled catalog before it reaches the store,
 * so only known ids persist. Enabling claims the shared office slot and
 * disabling releases it when this plugin still holds it, so the four office
 * formats stay mutually exclusive.
 *
 * @module @dsh-app/plugin-ppt/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { PptModeStore } from './mode-store.ts'
import { claimOfficeActive, readOfficeActive, releaseOfficeActive } from './office-active-store.ts'
import { allTemplates, templateById, templateCoverBytes } from './templates.ts'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-ppt` travels as `dsh-app/plugin-ppt`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-ppt'

/** Cover previews above this size are refused rather than degraded silently. */
const MAX_PREVIEW_BYTES = 200 * 1024

/** Cap on one request body: the mode body is three short fields. */
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
 * smaller route limit is checked before parsing so an oversized body can never
 * reach the store.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** One catalog row the picker panel renders. */
export interface TemplateView {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
  /** Cover preview as a data URL (pages/01.jpg), omitted when unreadable. */
  readonly cover?: string
  readonly pageCount: number
}

/** Catalog with cover previews; failures degrade per template, not globally. */
export async function templateViews(covers: boolean): Promise<readonly TemplateView[]> {
  const entries = await allTemplates()
  const views: TemplateView[] = []
  for (const entry of entries) {
    let cover: string | undefined
    const bytes = covers ? await templateCoverBytes(entry) : undefined
    if (bytes !== undefined && bytes.byteLength <= MAX_PREVIEW_BYTES) {
      cover = `data:image/jpeg;base64,${bytes.toString('base64')}`
    }
    views.push({
      id: entry.meta.id,
      name: entry.meta.name,
      category: entry.meta.category,
      description: entry.meta.description,
      ...(cover === undefined ? {} : { cover }),
      pageCount: entry.meta.pages.length,
    })
  }
  return views
}

/** The client-facing mode state of one session. */
function modeStateOf(store: PptModeStore, sessionId: string): {
  enabled: boolean
  template: string | null
  updatedAt: number | null
} {
  return {
    enabled: store.isEnabled(sessionId),
    template: store.templateOf(sessionId),
    updatedAt: store.updatedAtOf(sessionId),
  }
}

/**
 * Register the template-catalog, mode and shared-active routes on the
 * Connection exact-Fetch registry.
 *
 * Every route owns its exact path (a parameter rides the query string, never a
 * path segment) and its methods; another method of the same path falls through
 * to the shared channel's own 404 rather than a route body.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param store - the session-mode store shared with the prompt section.
 * @param activeFile - absolute path of the suite-wide active-format claim.
 * @returns disposer removing the routes.
 */
export function registerPptRoutes(
  connectionFetch: HostConnectionFetch,
  store: PptModeStore,
  activeFile: string,
): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/templates`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        // covers=0 keeps the payload tiny for name-only consumers (the
        // capsule label); the picker panel fetches with covers.
        const covers = new URL(request.url).searchParams.get('covers') !== '0'
        try {
          return ok({ templates: await templateViews(covers) })
        } catch (cause: unknown) {
          return fail(500, 'catalog-error', `模板目录读取失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/mode`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const sessionId = new URL(request.url).searchParams.get('sessionId')
          if (sessionId === null || sessionId === '') {
            return fail(400, 'bad-request', 'sessionId 不能为空')
          }
          // An unknown session reads as "off" — the capsule treats that the
          // same as a fresh session, so no error surface is needed.
          return ok(modeStateOf(store, sessionId))
        }
        try {
          const body = await readJsonBody(request)
          const sessionId = body.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') {
            return fail(400, 'bad-request', 'sessionId 必须是非空字符串')
          }
          const enabled = body.enabled
          if (typeof enabled !== 'boolean') {
            return fail(400, 'bad-request', 'enabled 必须是 true 或 false')
          }
          const template = body.template
          if (template !== null && typeof template !== 'string') {
            return fail(400, 'bad-request', 'template 必须是内置模板 id 或 null')
          }
          if (enabled && template !== null && await templateById(template) === undefined) {
            return fail(400, 'bad-request', `未知模板 id：${template}`)
          }
          if (enabled) {
            store.set(sessionId, template === null ? null : template)
            await claimOfficeActive(activeFile, sessionId)
          } else {
            store.clear(sessionId)
            await releaseOfficeActive(activeFile, sessionId)
          }
          return ok(modeStateOf(store, sessionId))
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
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
