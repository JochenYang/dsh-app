/**
 * Settings-page API under `/plugins/@dsh-app/plugin-memory/api`:
 *   GET  /status — toggle states + global/project stats
 *   POST /config — set toggles (body {enabled?, distill?} booleans)
 *   POST /clear  — drop entries: {scope:'global'} empties the global file;
 *                  {scope:'project', slug} removes that project directory.
 *
 * Same-origin enforced on every route; the slug is pattern-validated before
 * it ever reaches the filesystem (traversal fence). Writes act on the root
 * the tools, injection, and distiller share, so a toggle flip here is
 * honored by the next prompt assembly / distill window with no restart.
 *
 * @module @dsh-app/plugin-memory/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isValidSlug, listProjects, removeProject, type MemoryRoot } from './memory-store.ts'
import type { MemoryStatus } from './types.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-memory/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

function sameOrigin(req: IncomingMessage): boolean {
  return (req.headers.origin === undefined || req.headers.origin === req.headers.host)
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
 * Register the three settings-page routes.
 * @param webServer - the dsh web server service.
 * @param root - the two-level memory root.
 * @returns disposer removing all routes.
 */
export function registerMemoryRoutes(webServer: WebServerLike, root: MemoryRoot): () => void {
  const disposers: Array<() => void> = []

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/status`,
    handler: (req, res) => {
      if (!sameOrigin(req)) return
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        fail(res, 405, 'method-not-allowed', 'GET only')
        return
      }
      const { entries, sizeBytes } = root.global.stats()
      const status: MemoryStatus = {
        enabled: root.global.isEnabled(),
        distill: root.global.isDistillEnabled(),
        entries,
        sizeBytes,
        filePath: root.global.filePath,
        projects: listProjects(root.dir),
        activity: root.distillActivity(),
      }
      ok(res, status)
    },
  }))

  disposers.push(webServer.register({
    path: `${ROUTE_PREFIX}/config`,
    handler: (req, res) => {
      if (!sameOrigin(req)) return
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
      if (!sameOrigin(req)) return
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

  return () => { for (const dispose of disposers) dispose() }
}
