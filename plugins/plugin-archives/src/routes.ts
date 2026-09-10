/**
 * Host API routes for the archive manager.
 *
 * Four endpoints under the plugin's route namespace on the dsh web server
 * (`/plugins/@dsh-app/plugin-archives/api`):
 *   GET  /list   — archived sessions grouped by project (cwd), with sizes
 *                  and projection-cached titles
 *   POST /delete — remove archived sessions: the log artifact directory is
 *                  deleted through the JSONL backend's public
 *                  `resolveCurrentLog` path, then the archive-set records
 *                  drop (record-only on backends without a log path)
 *   POST /prune  — drop archive-set records whose session logs are already
 *                  gone (stale records), through the registry's serialized
 *                  write chain
 *   GET  /search — cross-session full-text search over the live-preferred corpus
 *
 * Deletion safety fences (all enforced server-side):
 *   - only ids present in the workspace registry's archive set are deletable
 *     (this surface can never touch an unarchived session);
 *   - a live/attached session is skipped (`live`);
 *   - removal targets exactly the session's own log directory (resolved via
 *     `resolveCurrentLog`) — never a parent or the root; on backends without
 *     a log path only the archive-set records drop.
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
import type { ArchiveDeleteResult, ArchiveGroup, ArchiveList, ArchivePruneResult, ArchiveSkipReason, ArchivedSession } from './types.ts'

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
  list(): Promise<readonly unknown[]>
}

/**
 * Unwrap one list() entry to its session header. The rc-line kernel lists
 * bare headers; the alpha line wraps them in snapshots (`{ header, … }`).
 * The archive set predates any single kernel line, so both shapes are
 * admitted — reading `.id` off a snapshot wrapper silently yields
 * `undefined` and misfiles every live archive as stale.
 */
/**
 * Sum the file sizes in one session directory (what deleting it frees).
 * Shallow by design: the layout is `<sessionDir>/session.jsonl[.zstd]` plus
 * backend-owned siblings. Any read fault scores 0 — deletion must never fail
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

function listedHeader(entry: unknown): SessionHeaderLike {
  const wrapped = (entry as { header?: SessionHeaderLike }).header
  return wrapped !== undefined && typeof wrapped.id === 'string' ? wrapped : (entry as SessionHeaderLike)
}

/** Cheap byte size off a listing entry (snapshot metadata; absent → 0). */
function entrySizeBytes(entry: unknown): number {
  const size = (entry as { sizeBytes?: unknown }).sizeBytes
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0
}

/** Structural slice of the workspaceRegistry service. */
export interface WorkspaceRegistryLike {
  readonly archivedSessionIds: readonly string[]
}

/**
 * The registry's domain global state as the prune path sees it: the archive
 * set plus opaque sibling fields that must survive a rewrite verbatim.
 */
type RegistryState = { archivedSessionIds: readonly string[] } & Record<string, unknown>

/**
 * Private write-side slice of the upstream workspace registry. Upstream
 * exposes no archive-set removal API (only `archiveSession`), so /prune
 * reaches the registry's serialized read-modify-write chain — these methods
 * are private in the source but live on the runtime prototype. Every method
 * is capability-checked before use; a kernel that reshaped the class gets a
 * structured 501, never a corrupted state.
 */
interface RegistryWriter extends WorkspaceRegistryLike {
  /** Current domain global state. */
  requireState(): RegistryState
  /** Serialized mutation chain: check-then-write pairs cannot interleave. */
  enqueueOperation<T>(operation: () => Promise<T>): Promise<T>
  /** Durably replace the whole domain state. */
  setState(state: unknown): Promise<unknown>
}

/** Structural slice of the sessions store (liveness guard). */
export interface SessionsLike {
  get(id: string): unknown
}

/** Structural slice of ctx.sessionQuery: enough to run a cross-session search. */
export interface SessionQueryLike {
  searchSessions(request: { query: string; limit?: number }): Promise<{
    items: ReadonlyArray<{
      header: { id: string; createdAt?: number; cwd?: string; title?: string }
      bestMatch?: { snippet?: string }
    }>
    nextCursor?: unknown
  }>
}

/** Structural slice of ctx.tools: enough to report agent-tool availability. */
export interface ToolsLike {
  schemas(): ReadonlyArray<{ name: string }>
}

/** GET /search response value: hits + whether the agent-side session_search tool is mounted. */
export interface ArchiveSearchResult {
  /** Hits ranked by strongest matching event. */
  items: ReadonlyArray<{
    id: string
    title: string
    createdAt: number
    cwd: string
    snippet: string
  }>
  /** Whether the model-facing session_search tool is registered for preset agents. */
  agentToolAvailable: boolean
}

/**
 * Whether a store-resident session is mid-turn (a `turn/start` with no
 * matching `turn/end` yet — the same open-turn test the upstream fork
 * boundary uses). The api-proxy keeps every opened session resident for the
 * whole process lifetime, so mere store presence would flag every
 * previously-opened archived session as live and make it undeletable; only a
 * session still WRITING its log must be fenced. An unreadable event log is
 * treated as mid-turn (conservative: keep the old skip behavior).
 */
function isMidTurn(session: unknown): boolean {
  // alpha.4 replaced the `Session.events` getter with `snapshotEvents()`;
  // an unreadable/absent log stays fenced (treated as mid-turn).
  const source = session as { snapshotEvents?: () => unknown } | undefined
  const events = typeof source?.snapshotEvents === 'function' ? source.snapshotEvents() : undefined
  if (!Array.isArray(events)) return true
  let open = false
  for (const event of events) {
    const type = (event as { type?: unknown }).type
    if (type === 'turn/start') open = true
    else if (type === 'turn/end') open = false
  }
  return open
}

/**
 * Structural slice of the sessionProjectionCache (zero-I/O title lookup).
 *
 * Upstream signature: `cachedSnapshot(meta, inheritedEventCount, keys?)` —
 * the inherited-event count is a required branded `SessionLogOffset`; passing
 * `undefined` makes the brand constructor throw. Archive listings feed the
 * cold-path with `0` (the upstream list route uses the same default: a value
 * of 0 skips nothing and reads the folded/title snapshot at the record base).
 */
export interface ProjectionCacheLike {
  cachedSnapshot(
    meta: SessionHeaderLike,
    inheritedEventCount: number,
    keys?: readonly string[],
  ): { values: { title?: string | null } } | undefined
}

/** Route-layer dependencies, injected by the host half. */
export interface ArchiveRoutesOptions {
  persistence: PersistenceLike
  registry: WorkspaceRegistryLike
  sessions: SessionsLike | undefined
  projectionCache: ProjectionCacheLike | undefined
  /** Cross-session full-text search service (structural slice of ctx.sessionQuery). */
  sessionQuery: SessionQueryLike | undefined
  /** Tools registry (structural slice of ctx.tools): enough to report agent-tool availability. */
  tools: ToolsLike | undefined
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

/**
 * Loopback-host fence (behavioral parity with plugin-sidebar's trust fence):
 * admit only requests whose Host names this machine's loopback interface,
 * so a rebinding/cross-site request carrying an attacker's Host is refused
 * even when it forges an Origin. Reads ONLY the Host header.
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
  // 127.0.0.0/8 in full, validated per octet (a bare \d{1,3} pattern would
  // admit 127.999.999.999, which names no local interface).
  const octets = hostname.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
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
  const entries = new Map((await options.persistence.list()).map((entry) => {
    const header = listedHeader(entry)
    return [String(header.id), entry] as const
  }))
  const groups = new Map<string, ArchiveGroup>()
  let staleCount = 0
  let totalBytes = 0
  for (const id of archivedIds) {
    const entry = entries.get(id)
    if (entry === undefined) {
      // Archived but no persisted log: nothing to show or delete here.
      // /prune is the surface that can drop such records; listing only
      // counts them.
      staleCount += 1
      continue
    }
    const header = listedHeader(entry)
    const cwd = header.cwd ?? ''
    let group = groups.get(cwd)
    if (group === undefined) {
      group = { cwd, title: groupTitle(cwd), sessions: [], totalBytes: 0 }
      groups.set(cwd, group)
    }
    // Byte size comes from the listing snapshot itself (cheap metadata the
    // backend provides); the rc-line kernel no longer exposes per-session
    // artifact paths, so directory walks are gone.
    const sizeBytes = entrySizeBytes(entry)
    const cachedTitle = options.projectionCache?.cachedSnapshot(header, 0)?.values.title
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

/** Structural slice of the JSONL persistence backend's public log resolver:
 * the rc-line replacement for the old private `locate()` (same artifact
 * path, public API). Optional — a non-JSONL backend (e.g. SQLite) answers
 * `undefined` and deletion degrades to record-only. */
interface LogResolverLike {
  resolveCurrentLog(id: string, signal?: AbortSignal): Promise<string | undefined>
}

/** Physically delete the requested archived sessions: remove each session's
 * log artifact directory through the backend's public `resolveCurrentLog`,
 * then drop the archive-set records through the registry's serialized write
 * chain. A backend without `resolveCurrentLog` degrades to record-only
 * removal (same fenced reasons as before). */
async function deleteArchives(writer: RegistryWriter, options: ArchiveRoutesOptions, ids: readonly string[]): Promise<ArchiveDeleteResult> {
  const result: ArchiveDeleteResult = { deleted: [], freedBytes: 0, skipped: [] }
  const entries = new Map((await options.persistence.list()).map((entry) => {
    const header = listedHeader(entry)
    return [String(header.id), entry] as const
  }))
  const archivedIds = new Set(options.registry.archivedSessionIds.map(String))
  const resolver = options.persistence as unknown as LogResolverLike | undefined
  const resolvable = resolver !== undefined && typeof resolver.resolveCurrentLog === 'function'
  const deletable = ids.filter((id) => {
    // Fence 1: only sessions the user archived are manageable here.
    if (!archivedIds.has(id)) {
      result.skipped.push({ id, reason: 'not-archived' })
      return false
    }
    if (entries.get(id) === undefined) {
      result.skipped.push({ id, reason: 'missing' })
      return false
    }
    const resident = options.sessions?.get(id)
    if (resident !== undefined && isMidTurn(resident)) {
      result.skipped.push({ id, reason: 'live' })
      return false
    }
    return true
  })
  for (const id of deletable) {
    const snapshotBytes = entrySizeBytes(entries.get(id))
    try {
      if (resolvable) {
        // The log artifact is `<sessionDir>/…`; removing the directory takes
        // every generation and sidecar with it. `force` tolerates a racing
        // removal; other faults surface as `io` skips, never a failed batch.
        const logPath = await (resolver as LogResolverLike).resolveCurrentLog(id)
        if (logPath === undefined) {
          result.skipped.push({ id, reason: 'missing' })
          continue
        }
        const dir = dirname(logPath)
        const sizeBytes = await dirSize(dir)
        await rm(dir, { recursive: true, force: true })
        result.deleted.push(id)
        result.freedBytes += sizeBytes
      } else {
        // Non-JSONL backend: no artifact path to remove — record-only.
        result.deleted.push(id)
        result.freedBytes += snapshotBytes
      }
    } catch {
      result.skipped.push({ id, reason: 'io' })
    }
  }
  if (result.deleted.length === 0) return result
  const removed = new Set(result.deleted)
  await writer.enqueueOperation(async () => {
    const state = writer.requireState()
    const remaining = state.archivedSessionIds.map(String).filter((id) => !removed.has(id))
    await writer.setState({ ...state, archivedSessionIds: remaining })
  })
  return result
}

/**
 * Drop archive-set records whose session logs are already gone. A record is
 * stale only when all three hold: still archived, absent from a fresh
 * persistence listing, and not a live session — everything else stays
 * untouched. The header snapshot is taken once per call; the archive set is
 * re-read inside the registry's serialized write chain so a concurrent
 * archive/unarchive write can never be lost.
 */
async function pruneStaleArchives(writer: RegistryWriter, options: ArchiveRoutesOptions): Promise<ArchivePruneResult> {
  const headerIds = new Set((await options.persistence.list()).map((entry) => String(listedHeader(entry).id)))
  return writer.enqueueOperation(async () => {
    // Liveness is probed per candidate inside the chain (the store exposes
    // no enumeration): fresher than a snapshot, and cheap in-memory lookups.
    const state = writer.requireState()
    const current = state.archivedSessionIds.map(String)
    const filtered = current.filter((id) => headerIds.has(id) || options.sessions?.get(id) !== undefined)
    if (filtered.length !== current.length) {
      // Spread first: sibling state fields must survive the rewrite.
      await writer.setState({ ...state, archivedSessionIds: filtered })
    }
    return { pruned: current.length - filtered.length, remaining: filtered.length }
  })
}

/**
 * Register the four API routes.
 * @param webServer - the dsh web server service.
 * @param options - route-layer dependencies.
 * @returns a disposer removing all of them.
 */
export function registerArchiveRoutes(webServer: WebServerLike, options: ArchiveRoutesOptions): () => void {
  const listHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req) || !passesFence(req)) return
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
    if (!sameOrigin(req) || !passesFence(req)) return
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
        // Same private-write capability check as /prune: after the artifact
        // removal, archive-set records are rewritten through the registry
        // chain.
        const writer = options.registry as RegistryWriter
        if (typeof writer.enqueueOperation !== 'function'
          || typeof writer.requireState !== 'function'
          || typeof writer.setState !== 'function') {
          fail(res, 501, 'delete-unsupported', '当前内核版本不支持删除归档记录')
          return
        }
        return deleteArchives(writer, options, ids as string[])
          .then((value) => { ok(res, value) })
      })
      .catch((error: unknown) => {
        fail(res, 500, 'delete-failed', `删除归档会话失败（${(error as Error).message}）`)
      })
  }
  const pruneHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req) || !passesFence(req)) return
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      fail(res, 405, 'method-not-allowed', 'POST only')
      return
    }
    // Capability check: the write path is private upstream API — a kernel
    // that reshaped the registry must fail loudly (501) instead of risking
    // a corrupted domain state.
    const writer = options.registry as RegistryWriter
    if (typeof writer.enqueueOperation !== 'function'
      || typeof writer.requireState !== 'function'
      || typeof writer.setState !== 'function') {
      fail(res, 501, 'prune-unsupported', '当前内核版本不支持清理归档记录')
      return
    }
    // Same body discipline as /delete (size-capped); prune takes no input,
    // so the body is drained and ignored.
    void readJsonBody(req)
      .then(() => pruneStaleArchives(writer, options))
      .then((value) => { ok(res, value) })
      .catch((error: unknown) => {
        fail(res, 500, 'prune-failed', `清理归档记录失败（${error instanceof Error ? error.message : String(error)}）`)
      })
  }
  const searchHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req) || !passesFence(req)) return
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      fail(res, 405, 'method-not-allowed', 'GET only')
      return
    }
    if (options.sessionQuery === undefined) {
      fail(res, 503, 'session-query-unavailable', '当前内核未提供会话检索服务（session-query-sqlite 未启用）')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    // Cap the query: the backend scores the full text, so bound what we send.
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 500)
    if (query === '') {
      fail(res, 400, 'bad-request', '查询词不能为空')
      return
    }
    const limitParam = Number(url.searchParams.get('limit') ?? '20')
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(50, Math.floor(limitParam)) : 20
    void options.sessionQuery.searchSessions({ query, limit })
      .then((page) => {
        const items = page.items.map((hit) => ({
          id: String(hit.header.id ?? ''),
          title: typeof hit.header.title === 'string' ? hit.header.title : '',
          createdAt: typeof hit.header.createdAt === 'number' ? hit.header.createdAt : 0,
          cwd: typeof hit.header.cwd === 'string' ? hit.header.cwd : '',
          snippet: typeof hit.bestMatch?.snippet === 'string' ? hit.bestMatch.snippet : '',
        }))
        const agentToolAvailable = options.tools !== undefined
          && options.tools.schemas().some((schema) => schema.name === 'session_search')
        ok(res, { items, agentToolAvailable } satisfies ArchiveSearchResult)
      })
      .catch((error: unknown) => {
        fail(res, 500, 'search-failed', `会话检索失败（${error instanceof Error ? error.message : String(error)}）`)
      })
  }

  const disposers = [
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/list`, handler: listHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/delete`, handler: deleteHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/prune`, handler: pruneHandler }),
    webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/search`, handler: searchHandler }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
