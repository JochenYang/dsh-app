/**
 * PPT-mode API under `/plugins/@dsh-app/plugin-ppt/api`:
 *   GET  /templates     — the bundled template catalog with cover-preview data
 *                         URLs for the picker panel (single image, capped size)
 *   GET  /mode?sessionId= — whether the mode is on and its template (null =
 *                         off, or on with 常规主题)
 *   PUT  /mode          — {sessionId, enabled, template}: turn the mode on
 *                         (template id or null for 常规主题) or off
 *   GET  /office-active — the suite-wide active-format claim, so the capsule
 *                         can stand down when another format supersedes it
 *
 * Same-origin and loopback-Host fences mirror the other suite plugins'
 * routes (each suite plugin bundles standalone, so the fence is duplicated
 * by design rather than shared). The template value is validated against
 * the bundled catalog before it reaches the store, so only known ids
 * persist. Enabling claims the shared office slot and disabling releases it
 * when this plugin still holds it, so the four office formats stay mutually
 * exclusive.
 *
 * @module @dsh-app/plugin-ppt/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PptModeStore } from './mode-store.ts'
import { claimOfficeActive, readOfficeActive, releaseOfficeActive } from './office-active-store.ts'
import { allTemplates, templateById, templateCoverBytes } from './templates.ts'

/** Route namespace on the dsh web server (mirrored by the client half). */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-ppt/api'

/** Cover previews above this size are refused rather than degraded silently. */
const MAX_PREVIEW_BYTES = 200 * 1024

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

/** Reject cross-origin and non-local callers with an answer, never a hung connection. */
function requireSameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (sameOrigin(req) && passesFence(req)) return true
  fail(res, 403, 'forbidden', 'cross-origin or non-local request')
  return false
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
 * Register the template-catalog, mode and shared-active routes.
 * @param webServer - the dsh web server service.
 * @param store - the session-mode store shared with the prompt section.
 * @param activeFile - absolute path of the suite-wide active-format claim.
 * @returns disposer removing the routes.
 */
export function registerPptRoutes(webServer: WebServerLike, store: PptModeStore, activeFile: string): () => void {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/templates`,
      handler: (req, res) => {
        if (!requireSameOrigin(req, res)) return
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          fail(res, 405, 'method-not-allowed', 'GET only')
          return
        }
        // covers=0 keeps the payload tiny for name-only consumers (the
        // capsule label); the picker panel fetches with covers.
        const covers = new URL(req.url ?? '/', 'http://local').searchParams.get('covers') !== '0'
        void templateViews(covers).then(
          (templates) => ok(res, { templates }),
          (cause: unknown) => fail(res, 500, 'catalog-error', `模板目录读取失败：${cause instanceof Error ? cause.message : String(cause)}`),
        )
      },
    }),
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
          // An unknown session reads as "off" — the capsule treats that the
          // same as a fresh session, so no error surface is needed.
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
            const enabled = body.enabled
            if (typeof enabled !== 'boolean') {
              fail(res, 400, 'bad-request', 'enabled 必须是 true 或 false')
              return
            }
            const template = body.template
            if (template !== null && typeof template !== 'string') {
              fail(res, 400, 'bad-request', 'template 必须是内置模板 id 或 null')
              return
            }
            if (enabled && template !== null && await templateById(template) === undefined) {
              fail(res, 400, 'bad-request', `未知模板 id：${template}`)
              return
            }
            if (enabled) {
              store.set(sessionId, template === null ? null : template)
              await claimOfficeActive(activeFile, sessionId)
            } else {
              store.clear(sessionId)
              await releaseOfficeActive(activeFile, sessionId)
            }
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
