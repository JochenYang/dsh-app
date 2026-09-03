/**
 * Settings-page API under `/plugins/@dsh-app/plugin-memory/api`:
 *   GET  /status        — toggle states + global/project stats + global rows
 *   GET  /entries?slug= — one PROJECT store's rows with pin state
 *   POST /config        — set toggles (body {enabled?, distill?} booleans)
 *   POST /pin           — pin/unpin one row (body {content, pinned, scope?, slug?})
 *   POST /forget        — delete one row by exact content (body {match, scope?, slug?})
 *   POST /clear         — drop entries: {scope:'global'} empties the global file;
 *                         {scope:'project', slug} removes that project directory.
 *
 * Same-origin enforced on every route (403 with a body, never a hung
 * connection); the slug is pattern-validated before it ever reaches the
 * filesystem (traversal fence). Writes act on the root the tools, injection,
 * and distiller share, so a toggle flip here is honored by the next prompt
 * assembly / distill window with no restart.
 *
 * @module @dsh-app/plugin-memory/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isValidSlug, listProjects, normalizeForMatch, parseEntries, removeProject, type MemoryRoot, type MemoryStore } from './memory-store.ts'
import type { MemoryEntriesResponse, MemoryStatus } from './types.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-memory/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** Browser Origin carries the scheme (`http://host:port`), so a raw string
 *  compare against the Host header can never pass for browser requests —
 *  compare the host parts. A missing Origin is a non-browser caller (curl,
 *  in-process): allowed. Exported for tests. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Reject cross-origin callers with an answer, never a hung connection. */
function requireSameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (sameOrigin(req)) return true
  fail(res, 403, 'forbidden', 'cross-origin request')
  return false
}

/** Resolve the target store of a scoped write body (pin/forget); answers the
 *  400 itself and returns undefined on a bad scope or unknown slug. */
function resolveStore(root: MemoryRoot, body: Record<string, unknown>, res: ServerResponse): MemoryStore | undefined {
  if (body.scope === undefined || body.scope === 'global') return root.global
  if (body.scope !== 'project') {
    fail(res, 400, 'bad-request', 'scope must be global or project')
    return undefined
  }
  const slug = body.slug
  if (typeof slug !== 'string' || !isValidSlug(slug)) {
    fail(res, 400, 'bad-request', 'project scope requires a valid slug')
    return undefined
  }
  const store = root.projectBySlug(slug)
  if (store === undefined) {
    fail(res, 400, 'bad-request', 'unknown project slug')
    return undefined
  }
  return store
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

/** Bounded JSON body read (same discipline as the sidebar git routes). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 8_192) {
        reject(new Error('request body too large'))
        req.destroy()
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
 * Register the six settings-page routes.
 * @param webServer - the dsh web server service.
 * @param root - the two-level memory root.
 * @returns disposer removing all routes.
 */
export function registerMemoryRoutes(webServer: WebServerLike, root: MemoryRoot): () => void {
  const disposers: Array<() => void> = []

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/status`,
    handler: (req, res) => {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        fail(res, 405, 'method-not-allowed', 'GET only')
        return
      }
      const { entries, sizeBytes } = root.global.stats()
      const pinned = root.global.pinnedSet()
      const status: MemoryStatus = {
        enabled: root.global.isEnabled(),
        distill: root.global.isDistillEnabled(),
        entries,
        sizeBytes,
        filePath: root.global.filePath,
        globalList: parseEntries(root.global.read()).map(entry => ({
          text: entry.content,
          pinned: pinned.has(normalizeForMatch(entry.content)),
        })),
        projects: listProjects(root.dir),
        activity: root.distillActivity(),
      }
      ok(res, status)
    },
  }))

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/config`,
    handler: (req, res) => {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        fail(res, 405, 'method-not-allowed', 'POST only')
        return
      }
      void readJsonBody(req)
        .then(body => {
          // Accept either toggle, both, or neither (a no-op body is still
          // answered with the current state — the UI reloads from it).
          const enabled = body.enabled
          const distill = body.distill
          if (enabled !== undefined && typeof enabled !== 'boolean') {
            fail(res, 400, 'bad-request', 'enabled must be a boolean')
            return
          }
          if (distill !== undefined && typeof distill !== 'boolean') {
            fail(res, 400, 'bad-request', 'distill must be a boolean')
            return
          }
          if (typeof enabled === 'boolean') root.global.setEnabled(enabled)
          if (typeof distill === 'boolean') root.global.setDistillEnabled(distill)
          ok(res, {
            enabled: root.global.isEnabled(),
            distill: root.global.isDistillEnabled(),
          })
        })
        .catch(error => {
          fail(res, 400, 'bad-request', error instanceof Error ? error.message : 'invalid body')
        })
    },
  }))

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/clear`,
    handler: (req, res) => {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        fail(res, 405, 'method-not-allowed', 'POST only')
        return
      }
      void readJsonBody(req)
        .then(body => {
          if (body.scope === 'project') {
            const slug = body.slug
            if (typeof slug !== 'string' || !isValidSlug(slug)) {
              fail(res, 400, 'bad-request', 'slug 格式不正确')
              return
            }
            try {
              removeProject(root.dir, slug)
              ok(res, { scope: 'project', slug })
            } catch (error) {
              fail(res, 500, 'io', `清空项目记忆失败：${error instanceof Error ? error.message : String(error)}`)
            }
            return
          }
          if (body.scope !== 'global' && body.scope !== undefined) {
            fail(res, 400, 'bad-request', 'scope 必须是 global 或 project')
            return
          }
          try {
            root.global.clear()
            ok(res, { scope: 'global' })
          } catch (error) {
            fail(res, 500, 'io', `清空全局记忆失败：${error instanceof Error ? error.message : String(error)}`)
          }
        })
        .catch(error => {
          fail(res, 400, 'bad-request', error instanceof Error ? error.message : 'invalid body')
        })
    },
  }))

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/entries`,
    handler: (req, res) => {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        fail(res, 405, 'method-not-allowed', 'GET only')
        return
      }
      const slug = req.url === undefined ? null : new URL(req.url, 'http://localhost').searchParams.get('slug')
      if (slug === null || slug === '') {
        fail(res, 400, 'bad-request', 'entries requires a project slug (global rows come with /status)')
        return
      }
      const store = root.projectBySlug(slug)
      if (store === undefined) {
        fail(res, 400, 'bad-request', 'unknown project slug')
        return
      }
      const pinned = store.pinnedSet()
      const body: MemoryEntriesResponse = {
        entries: parseEntries(store.read()).map(entry => ({
          text: entry.content,
          pinned: pinned.has(normalizeForMatch(entry.content)),
        })),
      }
      ok(res, body)
    },
  }))

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/pin`,
    handler: (req, res) => {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        fail(res, 405, 'method-not-allowed', 'POST only')
        return
      }
      void readJsonBody(req)
        .then(body => {
          const content = body.content
          const pinned = body.pinned
          if (typeof content !== 'string' || content.trim() === '') {
            fail(res, 400, 'bad-request', 'content must be a non-empty string')
            return
          }
          if (typeof pinned !== 'boolean') {
            fail(res, 400, 'bad-request', 'pinned must be a boolean')
            return
          }
          const store = resolveStore(root, body, res)
          if (store === undefined) return
          const changed = pinned ? store.addPin(content) : store.removePin(content)
          ok(res, { pinned, changed })
        })
        .catch(error => {
          fail(res, 400, 'bad-request', error instanceof Error ? error.message : 'invalid body')
        })
    },
  }))

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/forget`,
    handler: (req, res) => {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        fail(res, 405, 'method-not-allowed', 'POST only')
        return
      }
      void readJsonBody(req)
        .then(body => {
          const match = body.match
          if (typeof match !== 'string' || match.trim() === '') {
            fail(res, 400, 'bad-request', 'match must be a non-empty string')
            return
          }
          const store = resolveStore(root, body, res)
          if (store === undefined) return
          // The settings-page row delete is EXACT-content (removeContent), not
          // the LLM tool's substring sweep: removing one row never touches
          // another row that merely shares a phrase with it.
          const result = store.removeContent(match)
          ok(res, { forgotten: result.removed.length, remaining: result.remaining })
        })
        .catch(error => {
          fail(res, 400, 'bad-request', error instanceof Error ? error.message : 'invalid body')
        })
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
