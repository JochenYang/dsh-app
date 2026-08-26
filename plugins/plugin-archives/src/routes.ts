/**
 * Host API routes for the archive manager.
 *
 * Two endpoints under the plugin's route namespace on the dsh web server
 * (`/plugins/@dsh-app/plugin-archives/api`):
 *   GET  /list   — archived sessions grouped by project (cwd), with sizes
 *                  and projection-cached titles
 *   POST /delete — remove the on-disk artifacts of archived sessions
 *
 * Deletion safety fences (all enforced server-side):
 *   - only ids present in the workspace registry's archive set are deletable
 *     (this surface can never touch an unarchived session);
 *   - a live/attached session is skipped (`live`);
 *   - removal targets exactly the session's own directory, resolved through
 *     the persistence backend's `locate()` — never a parent or the root.
 *
 * The namespace deliberately lives inside the loader-owned `/plugins/<pkg>`
 * prefix with an `/api` segment (same discipline as plugin-usage): the
 * package root belongs to the client-modules system, and an independent
 * namespace means no third-party plugin can collide with these routes.
 *
 * @module @dsh-app/plugin-archives/routes
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ArchiveDeleteResult, ArchiveGroup, ArchiveList, ArchiveSkipReason, ArchivedSession } from './types.ts'

/** Route namespace on the dsh web server (inside the plugin's package prefix). */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-archives/api'

/** Upper bound on a /delete request body (the ids array is tiny; refuse spam). */
const MAX_BODY_BYTES = 1_000_000

/** Upper bound on ids accepted per /delete call. */
const MAX_IDS_PER_CALL = 1000

/** Structural slice of the webServer service the routes consume. */
export interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** The persisted-session header fields the routes consume. */
export interface SessionHeaderLike {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
}

/** Structural slice of the sessionPersistence service. */
export interface PersistenceLike {
  list(signal?: AbortSignal): Promise<SessionHeaderLike[]>
  locate(meta: SessionHeaderLike): { kind: string; path: string } | undefined
}

/** Structural slice of the workspaceRegistry service. */
export interface WorkspaceRegistryLike {
  readonly archivedSessionIds: readonly string[]
}

/** Structural slice of the sessions store (liveness guard). */
export interface SessionsLike {
  get(id: string): unknown
}

/** Structural slice of the sessionProjectionCache (zero-I/O title lookup). */
export interface ProjectionCacheLike {
  cachedSnapshot(meta: SessionHeaderLike): { values: { title?: string | null } } | undefined
}

/** Route-layer dependencies, injected by the host half. */
export interface ArchiveRoutesOptions {
  persistence: PersistenceLike
  registry: WorkspaceRegistryLike
  sessions: SessionsLike | undefined
  projectionCache: ProjectionCacheLike | undefined
}

/**
 * Sum the file sizes in one session directory (what deleting it frees).
 * Shallow by design: the layout is `<sessionDir>/session.jsonl[.zstd]` plus
 * backend-owned siblings. Any read fault scores 0 — listing must never fail
 * because one directory is unreadable.
 */
async function dirSize(dir: string): Promise<number> {
  let entries: Array<{ isFile(): boolean; name: string }>
  try {
    entries = await readdir(dir, { withFileTypes: true }) as Array<{ isFile(): boolean; name: string }>
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      total += (await stat(`${dir}/${entry.name}`)).size
    } catch {
      // racing deletion or unreadable file: contribute nothing
    }
  }
  return total
}

/** Group display name: cwd basename, or a placeholder for cwd-less sessions. */
function groupTitle(cwd: string): string {
  if (cwd === '') return '未记录项目目录'
  const name = basename(cwd)
  return name === '' || name === '/' || name === '\\' ? cwd : name
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

/** Read and JSON-parse a request body, enforcing the size cap. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('unparsable body'))
      }
    })
    req.on('error', reject)
  })
}

/** Build the grouped listing of archived sessions. */
async function listArchives(options: ArchiveRoutesOptions): Promise<ArchiveList> {
  const archivedIds = new Set(options.registry.archivedSessionIds.map(String))
  const headers = new Map((await options.persistence.list()).map((header) => [String(header.id), header]))
  const groups = new Map<string, ArchiveGroup>()
  let staleCount = 0
  let totalBytes = 0
  for (const id of archivedIds) {
    const header = headers.get(id)
    if (header === undefined) {
      // Archived but no persisted log: nothing to show or delete. The id
      // stays in the registry (no public removal API) but hides nothing.
      staleCount += 1
      continue
    }
    const cwd = header.cwd ?? ''
    const located = options.persistence.locate(header)
    if (located === undefined) {
      // Backend owns no per-session artifact (e.g. SQLite): nothing to list
      // or delete here. Same bucket as a missing header.
      staleCount += 1
      continue
    }
    let group = groups.get(cwd)
    if (group === undefined) {
      group = { cwd, title: groupTitle(cwd), sessions: [], totalBytes: 0 }
      groups.set(cwd, group)
    }
    const dir = dirname(located.path)
    const sizeBytes = await dirSize(dir)
    const cachedTitle = options.projectionCache?.cachedSnapshot(header)?.values.title
    const session: ArchivedSession = {
      id,
      createdAt: header.createdAt,
      sizeBytes,
      title: typeof cachedTitle === 'string' ? cachedTitle : '',
    }
    group.sessions.push(session)
    group.totalBytes += sizeBytes
    totalBytes += sizeBytes
  }
  const listed = [...groups.values()]
  for (const group of listed) group.sessions.sort((a, b) => b.createdAt - a.createdAt)
  listed.sort((a, b) => (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0))
  return {
    groups: listed,
    archivedCount: listed.reduce((count, group) => count + group.sessions.length, 0),
    staleCount,
    totalBytes,
  }
}

/** Delete the on-disk artifacts of the requested archived sessions. */
async function deleteArchives(options: ArchiveRoutesOptions, ids: readonly string[]): Promise<ArchiveDeleteResult> {
  const result: ArchiveDeleteResult = { deleted: [], freedBytes: 0, skipped: [] }
  const archivedIds = new Set(options.registry.archivedSessionIds.map(String))
  const headers = new Map((await options.persistence.list()).map((header) => [String(header.id), header]))
  for (const id of ids) {
    // Fence 1: only sessions the user archived are manageable here.
    if (!archivedIds.has(id)) {
      result.skipped.push({ id, reason: 'not-archived' })
      continue
    }
    // Fence 2: a live session's log is still being written; never remove it.
    if (options.sessions?.get(id) !== undefined) {
      result.skipped.push({ id, reason: 'live' })
      continue
    }
    const header = headers.get(id)
    if (header === undefined) {
      result.skipped.push({ id, reason: 'missing' })
      continue
    }
    try {
      const located = options.persistence.locate(header)
      if (located === undefined) {
        // Backend owns no per-session artifact: nothing exists to remove.
        result.skipped.push({ id, reason: 'missing' })
        continue
      }
      const dir = dirname(located.path)
      const sizeBytes = await dirSize(dir)
      // force tolerates a racing removal (ENOENT); other faults (e.g. a file
      // locked open on Windows) surface as `io` skips, never a failed batch.
      await rm(dir, { recursive: true, force: true })
      result.deleted.push(id)
      result.freedBytes += sizeBytes
    } catch {
      result.skipped.push({ id, reason: 'io' })
    }
  }
  return result
}

/**
 * Register the two API routes.
 * @param webServer - the dsh web server service.
 * @param options - route-layer dependencies.
 * @returns a disposer removing both of them.
 */
export function registerArchiveRoutes(webServer: WebServerLike, options: ArchiveRoutesOptions): () => void {
  const listHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req)) return
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      fail(res, 405, 'method-not-allowed', 'GET only')
      return
    }
    void listArchives(options)
      .then((value) => { ok(res, value) })
      .catch((error: unknown) => {
        fail(res, 500, 'list-failed', `读取归档会话失败（${(error as Error).message}）`)
      })
  }
  const deleteHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req)) return
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      fail(res, 405, 'method-not-allowed', 'POST only')
      return
    }
    void readJsonBody(req)
      .then((body) => {
        const ids = (body as { ids?: unknown }).ids
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_CALL || ids.some((id) => typeof id !== 'string')) {
          fail(res, 400, 'bad-request', '请求体需要非空的 ids 字符串数组')
          return
        }
        return deleteArchives(options, ids as string[])
          .then((value) => { ok(res, value) })
      })
      .catch((error: unknown) => {
        fail(res, 500, 'delete-failed', `删除归档会话失败（${(error as Error).message}）`)
      })
  }
  const disposers = [
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/list`, handler: listHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/delete`, handler: deleteHandler }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
