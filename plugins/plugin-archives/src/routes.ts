/**
 * Host API routes for the archive manager.
 *
 * Eight endpoints on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-archives` (the registry admits only
 * `[A-Za-z0-9_$.-]` in a path segment, so the npm scope's `@` travels as
 * `dsh-app`):
 *   GET  /list            — archived sessions grouped by project (cwd), with
 *                           sizes and projection-cached titles
 *   POST /delete          — MOVE the archived sessions' log artifact
 *                           directories into the session trash (see
 *                           `./trash.ts`); the archive-set records are KEPT
 *                           (see "the record stays" below)
 *   POST /restore-deleted — move trashed sessions back to their original paths
 *                           and re-create their archive records
 *   GET  /trash           — the trash listing: entries, newest first, with the
 *                           span of deletion instants (usage)
 *   POST /purge           — delete trashed entries for good
 *   POST /restore         — drop an id from the archive set (the log was never
 *                           touched, so the session is simply visible again)
 *   POST /prune           — drop archive-set records whose session logs are
 *                           already gone (stale records), through the
 *                           registry's serialized write chain
 *   GET  /search          — cross-session full-text search over the
 *                           live-preferred corpus
 *
 * Plus two lifecycle endpoints:
 *   GET  /settings        — the retention tier and the startup-sweep switch
 *   POST /settings        — write them (normalized; see `./settings.ts`)
 *   POST /sweep           — run the retention sweep now (`./retention.ts`)
 *
 * Every one of them appends an audit line per subject (`./audit.ts`) when the
 * host configured a log path, and a line that cannot be written is a warning on
 * the response — never a failed action.
 *
 * Deletion safety fences (all enforced server-side):
 *   - only ids present in the workspace registry's archive set are deletable
 *     (this surface can never touch an unarchived session);
 *   - a live/attached session is skipped (`live`) unless the request asked to stop
 *     it first (`stopFirst`, see below);
 *   - removal targets exactly the session's own log directory — never a
 *     parent or the root; on a backend without a log path nothing is moved
 *     (`unsupported`).
 *
 * ## A session is deleted as its whole subagent tree
 *
 * Subagent children live in sibling directories under the same sessions root, so
 * moving a parent alone leaves each child's log behind as an orphan with no parent
 * left to name it. `/delete` therefore collects the tree under every requested id
 * (`./tree.ts`, from `ctx.subagents.listDescendants` plus the persisted header
 * markers) and moves the root TOGETHER WITH its descendants into the same trash
 * entry, which is what makes `/restore-deleted` bring the whole tree back.
 *
 * The tree is a stricter fence, never a wider one:
 *   - any member already parked in the trash refuses the whole tree
 *     (`already-in-trash`), because a half-moved tree is exactly what this exists
 *     to prevent — and it makes a second click on the same row idempotent;
 *   - any member running refuses the whole tree (`live`), reported with the ids
 *     that were busy when the tree held more than the requested session;
 *   - a tree over the walk's depth/node bound refuses the whole tree
 *     (`tree-too-large`); the bound is a refusal, never a truncation;
 *   - every member's directory goes through the same resolver + containment fence
 *     as the root; a descendant both the resolver and the directory walk fail to
 *     name has no directory to move and is not a member (it cannot be orphaned).
 *
 * ## `stopFirst`: the one way a running session can still be deleted
 *
 * A running session is skipped by default, unchanged. A request may carry
 * `stopFirst: true`, which asks the PUBLIC `workspace/session-stop` seam to cancel
 * the running work and then polls `workspace/session-activity` until it answers
 * empty (`./stop.ts`, bounded by `STOP_TIMEOUT_MS` / `STOP_POLL_MS`). The wait is
 * bounded on purpose: a session that does not settle inside the budget is reported
 * as `still-running` WITH the ids still active, and nothing is moved. A stop
 * dispatch that raises is `stop-failed` with the listeners' own messages, also
 * with nothing moved.
 *
 * What `stopFirst` deliberately does NOT do is take the session out of the kernel's
 * in-memory store: the only handles for that are private (`detachEntered`,
 * `liveEntryFor` in `@deepseek-ai/dsh-session`), and reaching them would need a cast
 * the type gate cannot see. A session that was live when its log moved is still
 * resident until the next kernel restart — stated, not papered over.
 *
 * `resolveCurrentLog` answers only for logs written in the current session
 * format, so a session still stored as an older generation resolves to
 * `undefined` while still listing everywhere. /delete therefore falls back to
 * locating `<root>/<project>/<id>/` itself before calling an id missing.
 *
 * ## Deletion is a move, and a move is undoable
 *
 * `/delete` no longer removes anything: it renames each session's log directory
 * into `$DSH_HOME/storages/dsh-app-plugin-archives/trash/<trashId>/payload/<n>/`
 * beside a `metadata.json` that records where it came from. `/restore-deleted`
 * puts it back and re-creates the archive record; `/purge` is the only route
 * that frees bytes, and it is the only one that cannot be undone. The storage
 * layer — two-phase metadata, probe-based settlement, real-path containment, the
 * leftover rules — lives in `./trash.ts`.
 *
 * Deleting works without a sessions root (it only moves the directory the kernel's
 * own resolver named); restoring does not, because a restore is a write to a path
 * that came out of a file on disk. A root that is unavailable at restore time
 * answers `needs-root` for every id instead of trusting the metadata's own claim,
 * and nothing in that metadata can widen the fence. GET /trash answers the same
 * question the same way: a row's `restorable` flag is computed per request from
 * the root this backend can see, so a row whose recorded path is outside it — or
 * one that arrived from a backend with no root at all — reports `outside-root` /
 * `needs-root` and offers no restore instead of offering one that cannot work.
 *
 * ## A purge owns its session's cache shards too
 *
 * A session's projection-cache document outlives its log directory: the kernel's
 * cache has no eviction surface. `/purge` therefore removes the shards of every
 * session it buries (`./projcache.ts`), and this is also the path "empty the
 * trash" takes. A failure there is a warning, never a failed purge — the bytes are
 * already gone, so a retry would find nothing left to delete.
 *
 * ## Every row has a handle
 *
 * `/purge` and `/restore-deleted` accept an entry's trash id OR one of its
 * present members' session ids, and both mean the same row: a row that appears in
 * the listing can always be cleared, including the ones whose payload is entirely
 * gone and the ones whose metadata never became readable (their directory name is
 * the id). See `./trash.ts` for what a session id is allowed to authorize.
 *
 * ## The archive record stays, and it is the client's visibility fence
 *
 * `/delete` does NOT drop the session's archive-set record: the set is what hides
 * an archived session from every grouping surface, and the browser still holds a
 * list snapshot containing that session. Dropping the record publishes
 * "no longer archived" for a session the client can still see, so the row pops back
 * into the sidebar until the next reload — the exact bug the record prevents.
 * Keeping it holds the session hidden; with its log gone the record is stale, which
 * `/list` counts as `staleCount` and `/prune` reclaims, and `/restore-deleted`
 * re-creates it (an idempotent `archiveSession` for an id already in the set) after
 * putting the directory back.
 *
 * ## The removal broadcast is extra information, not a licence
 *
 * `emitRemoved` (`./index.ts`, the upstream-declared `api-session/removed` event) is
 * dispatched once per moved session id. It is deliberately NOT what decides the
 * record's fate: no package installed on this kernel line subscribes to that event
 * (the only `api-session/*` listener is `api-session/status`), so acting on it — for
 * instance dropping the record because a client "will hear about it" — would trade a
 * working fence for a notification nobody reads. A future client that does consume
 * it gets the row dropped immediately; a host whose listener throws costs a warning
 * and nothing else (the move already happened, and the record is untouched either
 * way).
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them.
 *
 * @module @dsh-app/plugin-archives/routes
 */

import fsp from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
// The kernel's own session-id constructor: `/prune` hands ids to the registry's
// public removal, which takes the branded type (never a bare string).
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SESSION_ID_SEGMENT,
  TrashError,
  assertContained,
  entryForAddress,
  listEntries,
  lookupPurgeTarget,
  moveToTrash,
  planRestore,
  purgeEntry,
  restoreEntry,
  trashErrorCode,
  type TrashEntry,
  type TrashMemberSource,
} from './trash.ts'
import { purgeSessionShards } from './projcache.ts'
import { appendAudit, type AuditRecord } from './audit.ts'
import { isRetentionDays, readSettings, SETTINGS_VERSION, writeSettings } from './settings.ts'
import { sweepExpired } from './retention.ts'
import { collectSubagentTree, type SessionHeaderRow, type SubagentCatalogLike } from './tree.ts'
import { STOP_POLL_MS, STOP_TIMEOUT_MS, stopAndWait, type StopWaitOptions } from './stop.ts'
import type {
  ArchiveDeleteResult,
  ArchiveGroup,
  ArchiveList,
  ArchivePruneResult,
  ArchivePurgeResult,
  ArchiveRestoreDeletedResult,
  ArchiveRestoreWarningCode,
  ArchiveSettingsView,
  ArchiveSkipReason,
  ArchiveSkipped,
  ArchiveSweepResult,
  ArchiveTrashEntry,
  ArchiveTrashList,
  ArchiveTrashRestoreBlock,
  ArchivedSession,
  HostText,
} from './types.ts'
import type { ListedEntry } from './trash.ts'

/** Route namespace on the shared Connection `/api` channel. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-archives'

/** Upper bound on a /delete request body (the ids array is tiny; refuse spam). */
const MAX_BODY_BYTES = 1_000_000

/** Upper bound on ids accepted per /delete call. */
const MAX_IDS_PER_CALL = 1000

/** The persisted-session header fields the routes consume. */
export interface SessionHeaderLike {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  /** Fork lineage, read by the subagent-tree walk together with `origin` — the
   *  pair is what distinguishes a subagent child from a fork child (`./tree.ts`). */
  readonly parentSession?: unknown
  /** `'subagent'` on a session created as a subagent child. */
  readonly origin?: unknown
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
    entries = await fsp.readdir(dir, { withFileTypes: true }) as Array<{ isFile(): boolean; name: string }>
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      total += (await fsp.stat(`${dir}/${entry.name}`)).size
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
 * PUBLIC write-side slice of the upstream workspace registry.
 *
 * `/prune` used to reach into the registry's private write chain
 * (`requireState` / `enqueueOperation` / `setState`) because the kernel exposed
 * no way to remove one id from the archive set. This kernel line publishes one:
 * `archivedSessionIds` answers what is archived, and `unarchiveSession` removes a
 * single id through the registry's OWN serialized write — which also drops that
 * session's pin in the same durable write, something a whole-state rewrite by
 * this plugin could not know about (it spread the fields it knew and silently
 * dropped any it did not).
 */
interface RegistryPruner extends WorkspaceRegistryLike {
  /** Durably remove one id from the archive set. */
  unarchiveSession(sessionId: SessionId): Promise<void>
}

/**
 * PUBLIC write-side slice the restore-deleted path needs: putting an id BACK
 * into the archive set.
 *
 * `/delete` KEEPS the record, so for a normal restore the id is already in the
 * set and this call is a no-op — `archiveSession` answers an already-archived id
 * "without writing, asking, or stopping"
 * (`@deepseek-ai/dsh-workspace/lib/index.js`, `archiveSession`). It is here for the
 * case that is not normal: the record was pruned while the entry sat in the trash,
 * and the session the user restored has to come back to this page rather than to
 * the sidebar.
 *
 * `archiveSession` is the registry's own durable path: it writes on the registry's
 * serialized chain, drops the session's pin in the same write (archiving and
 * pinning are mutually exclusive), and asks the `workspace/session-activity`
 * waterfall before it writes. A whole-state rewrite by this plugin could not
 * maintain those fields, and reaching for the private `requireState` /
 * `enqueueOperation` / `setState` chain is the drift AGENTS.md rules out.
 *
 * One consequence is worth knowing here: for an id that is NOT archived,
 * `archiveSession` requires the session to exist in persistence, which is why the
 * restore moves the directory back BEFORE it asks. A log this kernel line cannot
 * list (a newer generation) is then refused by the registry, and the route reports
 * that as a warning rather than pretending the record came back.
 */
interface RegistryRestorer extends WorkspaceRegistryLike {
  /** Durably add one id to the archive set. */
  archiveSession(sessionId: SessionId): Promise<void>
}

/**
 * Structural slice of the sessions store, for the one question /prune asks it:
 * whether a session is still resident (a cold record is not one).
 */
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
    keys?: readonly string[],
  ): { values: { title?: string | null } } | undefined
}

/** Route-layer dependencies, injected by the host half. */
export interface ArchiveRoutesOptions {
  persistence: PersistenceLike
  registry: WorkspaceRegistryLike
  sessions: SessionsLike | undefined
  projectionCache: ProjectionCacheLike | undefined
  /**
   * Absolute trash root (`$DSH_HOME/storages/dsh-app-plugin-archives/trash`).
   *
   * Injected rather than resolved here: the host half owns the harness-home
   * lookup, and a test can point the trash at its own temporary directory
   * without touching the environment.
   */
  trashRoot: string
  /**
   * Absolute projection-cache shard directory
   * (`$DSH_HOME/storages/session_projcache/sessions`), or undefined when the
   * host exposes none.
   *
   * Injected for the same reason the trash root is: the host half owns the
   * harness-home lookup. `/purge` deletes the shards of the sessions it buries —
   * the kernel never reclaims them, so they are per-session residue nothing else
   * can reach — while moving a session INTO the trash deliberately leaves its
   * shard, so a restore comes back with the title and values it had.
   */
  projCacheDir: string | undefined
  /**
   * The kernel's own answer to "is this session busy", asked once per id before
   * its log artifact is removed.
   *
   * This is the `workspace/session-activity` waterfall — the seam
   * `WorkspaceRegistry.archiveSession` refuses on — whose providers are the turn
   * family, running background jobs, subagent descendants and scheduled
   * follow-ups. Required, not optional: a delete path that cannot ask has no
   * safe default, and the host half always has the seam to hand over.
   */
  activity: (id: string) => Promise<readonly unknown[]>
  /**
   * The kernel's own stop request — the `workspace/session-stop` event, dispatched
   * with `ctx.parallel` — which is what a `stopFirst: true` delete runs before it
   * asks {@link activity} again (`./stop.ts`).
   *
   * Optional because it is a capability, not a default: a host that cannot offer it
   * must answer `stop-failed` for a request that asks for a stop, never proceed on
   * the assumption that the work stopped by itself.
   */
  stopSession: ((id: string) => Promise<void>) | undefined
  /**
   * `ctx.subagents`' descendant walk, used to collect the whole subagent tree under
   * one session (`./tree.ts`). Optional: without it the tree comes from the
   * persisted headers' `parentSession` + `origin` pair, which is the durable
   * record anyway.
   */
  subagents: SubagentCatalogLike | undefined
  /**
   * The bound on a `stopFirst` wait. Omitted keeps `STOP_TIMEOUT_MS` /
   * `STOP_POLL_MS`; a test narrows it (and may inject the clock) so the refusal can
   * be observed without waiting out the real budget.
   */
  stopWait?: StopWaitOptions | undefined
  /** Cross-session full-text search service (structural slice of ctx.sessionQuery). */
  sessionQuery: SessionQueryLike | undefined
  /** Tools registry (structural slice of ctx.tools): enough to report agent-tool availability. */
  tools: ToolsLike | undefined
  /**
   * Absolute audit log path
   * (`$DSH_HOME/logs/dsh-app-plugin-archives.log`), or undefined when the host
   * keeps no log directory.
   *
   * Injected rather than resolved here for the same reason the trash root is: the
   * host half owns the harness-home lookup, and a test points it at its own
   * temporary file. A `false` from the append is a warning on the response
   * (`./audit.ts`: the bytes are already moved by then).
   */
  auditLog: string | undefined
  /**
   * Absolute settings file path
   * (`$DSH_HOME/storages/dsh-app-plugin-archives/settings.json`).
   *
   * Required: without it the retention tier has no home, and a delete surface
   * whose expiry policy cannot be read is a delete surface nobody can predict.
   */
  settingsPath: string
  /**
   * The removal broadcast — `ctx.emit('api-session/removed', SessionId(id))`
   * wired in `./index.ts`.
   *
   * This is the upstream event (`@deepseek-ai/dsh-api-remotes`'s forwarded-event
   * allowlist, `mode: 'emit'`, `resources: { session }`) that tells a client a
   * session is GONE rather than merely un-archived. Optional because it is a
   * capability: a host that cannot dispatch it simply leaves the record drop
   * unannounced, which is the old pop-back behavior and not a reason to refuse a
   * deletion that already moved the bytes.
   */
  emitRemoved: ((id: string) => void) | undefined
  /** Clock, injected so a test can age its own trash fixtures for the sweep. */
  now?: (() => number) | undefined
  /**
   * Where a non-fatal problem goes: the host's own logger.
   *
   * The one thing that must never be swallowed silently is a failed AUDIT append
   * (`./audit.ts`): the action it records already happened, so it cannot fail the
   * response, and a warning nobody reads is the same as no warning at all.
   */
  warn: (message: string) => void
}

/**
 * Group display name: the cwd basename. A cwd-less group gets an EMPTY title
 * on purpose — a heading is copy, and copy is the client's to write; the client
 * renders its own line for `cwd === ''` (see the section's group heading).
 */
function groupTitle(cwd: string): string {
  if (cwd === '') return ''
  const name = basename(cwd)
  return name === '' || name === '/' || name === '\\' ? cwd : name
}

function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * Failure answer. `code` is the transport-ish category (kept for the existing
 * client checks); `host` is the coded message the UI renders in its own
 * language. The plain `message` stays an English diagnostic for logs and for a
 * client that does not know the code yet.
 */
function fail(status: number, code: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code, message: host.text ?? host.code, host } })
}

/**
 * Bounded JSON body read. The carrier has already buffered the body (the route
 * declares `requestBody: 'buffered'`) under the channel's own cap; this much
 * smaller route limit is checked before parsing so an oversized body can never
 * become a deletion request.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body too large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('body too large')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw error instanceof Error ? error : new Error('unparsable body')
  }
}

/**
 * Append one audit line, and report — never raise — a failure.
 *
 * The action this records has already happened by the time it is called: a
 * deletion whose bytes are in the trash must not be reported as failed because a
 * log line could not be written. The host's logger gets the diagnostic; a host
 * with no audit path simply records nothing.
 * @param options - route-layer dependencies.
 * @param record - the action to record.
 */
async function auditLine(options: ArchiveRoutesOptions, record: AuditRecord): Promise<void> {
  if (options.auditLog === undefined) return
  const outcome = await appendAudit({
    logPath: options.auditLog,
    record,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (!outcome.written && outcome.detail !== undefined) options.warn(`plugin-archives: ${outcome.detail}`)
}

/**
 * Append one line per untouched id, with the reason it was left alone.
 *
 * Called at every exit of a mutating path: a request that moved nothing still has
 * an answer for each id it named, and that answer is what a later "what happened to
 * session X" question needs.
 * @param options - route-layer dependencies.
 * @param operation - the action that skipped them.
 * @param skipped - the ids and reasons.
 */
async function auditSkips(
  options: ArchiveRoutesOptions,
  operation: AuditRecord['operation'],
  skipped: readonly ArchiveSkipped[],
): Promise<void> {
  for (const skip of skipped) {
    await auditLine(options, {
      operation,
      result: 'skipped',
      ...(operation === 'delete' ? { sessionId: skip.id } : { entryId: skip.id }),
      reason: skip.reason,
    })
  }
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

/** Structural slice of the JSONL persistence backend's public log resolver:
 * the rc-line replacement for the old private `locate()` (same artifact
 * path, public API). Optional — a non-JSONL backend (e.g. SQLite) has no
 * artifact to remove, so /delete skips those ids as `unsupported`. */
interface LogResolverLike {
  resolveCurrentLog(id: string, signal?: AbortSignal): Promise<string | undefined>
}

/** Structural slice of the backend's on-disk root. `root` is private in the
 * source but live on the runtime instance; `config.root` is the public copy
 * the constructor resolves into it. Read-only probes — neither is written. */
interface SessionRootLike {
  readonly root?: unknown
  readonly config?: { readonly root?: unknown }
}

/** Session log filenames inside one session directory: `session.jsonl`,
 * `session.v3.jsonl`, each optionally `.zstd`. Pre-v3 generations carry no
 * version infix, which is why this is a pattern and not an exact name. */
const SESSION_LOG_FILE = /^session(\.[0-9a-z]+)*\.jsonl(\.zstd)?$/i

/** The ids whose on-disk directory name is the id itself: upstream
 * `encodeSegment` leaves exactly this character set literal and escapes
 * `~` plus everything outside it. Anything else is skipped, never guessed
 * at — that encoder exists precisely because a SessionId is unvalidated.
 * The pattern itself lives in `./trash.ts`, which enforces the same whitelist
 * when it records or replays an original path. */
const LITERAL_SEGMENT = SESSION_ID_SEGMENT

/** The directory the backend stores sessions under, or undefined when the
 * instance does not expose one. */
function sessionsRoot(persistence: unknown): string | undefined {
  const source = persistence as SessionRootLike
  const raw = typeof source.root === 'string' && source.root !== ''
    ? source.root
    : typeof source.config?.root === 'string' && source.config.root !== ''
      ? source.config.root
      : undefined
  return raw === undefined ? undefined : resolve(raw)
}

/**
 * What one directory lookup found — three answers, never two.
 *
 * `absent` is positive evidence (ENOENT/ENOTDIR): the directory is not there.
 * `unknown` is everything else the filesystem can say — EACCES, EPERM, EIO, a
 * handle an indexer is holding — and it is NOT "not there": reading "I could not
 * look" as "it is gone" is how a subagent child was left behind by a delete that
 * reported success (its directory was still on disk, `skipped` said nothing about
 * it, and the root moved on without it).
 */
type DirLookup =
  | { readonly kind: 'found'; readonly dir: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly detail: string }

/** Whether a directory read failed for a reason that proves absence. */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** English diagnostic for one unreadable directory. */
function lookupDetail(path: string, error: unknown): string {
  return `could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Locate one session's own artifact directory without the backend's resolver.
 *
 * `resolveCurrentLog` answers only for logs already written in the CURRENT
 * session format — a session still stored as a pre-v3 generation gets
 * `undefined` even though its directory is intact (the resolver deliberately
 * refuses to name a non-current log as "the current log"). Those sessions
 * still appear in every listing, so without this fallback they sit in the
 * archive panel and can never be deleted.
 *
 * Layout is `<root>/<encoded project>/<encoded id>/`; a directory is accepted
 * only when the name matches the id verbatim AND it actually holds session log
 * files, so a stray name collision can never aim a deletion at something that
 * is not a stored session.
 *
 * Every read failure is classified: a project directory that is not there is
 * skipped (the id is unique, so keep looking), and a read that fails for any other
 * reason is `unknown` — never `absent`. The readdir calls go through one
 * `fs/promises` namespace object so a test can substitute a single call and
 * reproduce a denied directory (`./trash.ts`, "One filesystem object").
 * @param root - absolute sessions root.
 * @param id - the session whose directory is wanted.
 * @returns the directory, proven absence, or "could not look".
 */
async function locatedSessionDir(root: string, id: string): Promise<DirLookup> {
  if (id === '.' || id === '..' || !LITERAL_SEGMENT.test(id)) return { kind: 'absent' }
  let projectNames: string[]
  try {
    projectNames = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    // An absent root means the session cannot be in it; anything else means the
    // question could not be answered.
    return isAbsence(error) ? { kind: 'absent' } : { kind: 'unknown', detail: lookupDetail(root, error) }
  }
  for (const project of projectNames) {
    const dir = join(root, project, id)
    try {
      const entries = await fsp.readdir(dir)
      if (entries.some((entry) => SESSION_LOG_FILE.test(entry))) return { kind: 'found', dir }
    } catch (error) {
      if (isAbsence(error)) continue
      // Not "not in this project": this project directory holds the id's name and
      // would not be read, so whether the session is here is unknown.
      return { kind: 'unknown', detail: lookupDetail(dir, error) }
    }
  }
  return { kind: 'absent' }
}

/** Projection-cached title of one listed session (empty when none was generated). */
function cachedTitle(options: ArchiveRoutesOptions, listed: unknown): string {
  const title = options.projectionCache?.cachedSnapshot(listedHeader(listed))?.values.title
  return typeof title === 'string' ? title : ''
}

/** Why one session's directory could not be planned for a move. */
type DirectoryRefusal = 'path-outside-root' | 'io'

/** One member's directory, as the resolver and the containment fence found it. */
type LocatedDir =
  | { readonly kind: 'found'; readonly dir: string; readonly sizeBytes: number }
  /** Neither the resolver nor the directory walk named a directory for this id. */
  | { readonly kind: 'not-there' }
  | { readonly kind: 'refused'; readonly reason: DirectoryRefusal; readonly detail?: string }

/**
 * Locate one session's own directory for a move.
 *
 * The resolver is trusted for the FILE, not for what its parent happens to be: a
 * kernel that ever returned a log in a shared directory would move every session
 * at once. The fallback path (`locatedSessionDir`) already checks that the
 * directory's own name is the id; with a known root, `assertContained` adds the
 * real-path fence a junction under the root cannot fool. With no root the
 * resolver's own answer is the fence instead, and the entry records `rootUnknown`.
 *
 * A fallback that could not LOOK is a refusal (`io`), not `not-there`: the caller
 * treats the two very differently, and a member whose directory cannot be inspected
 * must refuse the whole tree rather than be assumed gone.
 * @param input.resolver - the backend's public log resolver.
 * @param input.root - the sessions root this backend exposes, if any.
 * @param input.id - the session whose directory is wanted.
 * @returns the directory and its shallow size, "not there", or the refusal.
 */
async function locateSessionDir(input: {
  resolver: LogResolverLike
  root: string | undefined
  id: string
}): Promise<LocatedDir> {
  try {
    const logPath = await input.resolver.resolveCurrentLog(input.id)
    const resolvedDir = logPath === undefined ? undefined : dirname(logPath)
    const named = resolvedDir !== undefined && basename(resolvedDir) === input.id ? resolvedDir : undefined
    let dir: string | undefined
    if (input.root === undefined) {
      // No root to search, and none to fence against: the resolver's own answer is
      // all there is, and it must at least be this session's own directory.
      dir = named
    } else {
      if (named !== undefined) {
        dir = named
      } else {
        const located = await locatedSessionDir(input.root, input.id)
        if (located.kind === 'unknown') return { kind: 'refused', reason: 'io', detail: located.detail }
        dir = located.kind === 'found' ? located.dir : undefined
      }
      if (dir !== undefined) await assertContained(input.root, dir)
    }
    if (dir === undefined) return { kind: 'not-there' }
    return { kind: 'found', dir, sizeBytes: await dirSize(dir) }
  } catch (error) {
    return {
      kind: 'refused',
      reason: trashErrorCode(error) === 'trash-path-outside-root' ? 'path-outside-root' : 'io',
    }
  }
}

/** One session a delete will move: a requested root, or one descendant of it. */
interface PlannedSession {
  /** Session id. */
  readonly id: string
  /** Absolute directory to move (where a restore puts it back). */
  readonly dir: string
  /** Shallow byte size measured before the move. */
  readonly sizeBytes: number
  /** False for a subagent child: it was never in the archive set, so a restore
   *  must not add it (see `TrashMember.archived`). */
  readonly archived: boolean
}

/** Move the requested archived sessions — and their subagent trees — into the trash.
 *
 * Nothing is deleted here: each session's own log directory is renamed into a
 * new trash entry (see `./trash.ts`), which is what makes `/restore-deleted`
 * possible and `/purge` the only irreversible route. The archive-set records are
 * KEPT (see the module header): they are what hides these sessions from every
 * grouping surface, and with the logs gone they are the stale records `/list`
 * counts and `/prune` reclaims. The removal is also announced
 * ({@link announceRemoval}) — information for a client that listens, never the
 * reason a record may go.
 *
 * Fences, in order, per REQUESTED id — the same as before, with the tree widened
 * from one session to its whole subtree:
 *   0. an id named twice in one request is moved once (the second mention is a
 *      no-op), because two moves of one directory would fail and roll the whole
 *      batch back;
 *   1. only an archived id is manageable here;
 *   2. any member of the tree already parked in the trash is a no-op
 *      (`already-in-trash`), never a second copy and never half a tree;
 *   3. the root's log has to exist to be movable;
 *   4. what the kernel says is running wins (`live`) — for every member, or
 *      `stopFirst` stops them and waits (`./stop.ts`) before going on;
 *   5. every member's directory must resolve to exactly that session's own
 *      directory and really sit inside the sessions root (`missing` /
 *      `path-outside-root`). When the backend exposes no root, the resolver's own
 *      answer is the fence instead, and the entry records `rootUnknown`.
 *
 * A backend without `resolveCurrentLog` has no artifact to move and skips every
 * id as `unsupported` — degrading to a record drop is the exact
 * pop-back-into-the-list behavior this surface must not produce.
 * @param options - route-layer dependencies.
 * @param ids - the requested session ids.
 * @param stopFirst - stop running work through `workspace/session-stop` and wait for
 *   the activity seam to answer empty, instead of skipping the tree as `live`.
 * @returns what moved, the bytes the trash now holds, and what was left untouched.
 */
async function deleteArchives(
  options: ArchiveRoutesOptions,
  ids: readonly string[],
  stopFirst: boolean,
): Promise<ArchiveDeleteResult> {
  const result: ArchiveDeleteResult = { deleted: [], freedBytes: 0, skipped: [] }
  const resolver = options.persistence as unknown as LogResolverLike | undefined
  if (resolver === undefined || typeof resolver.resolveCurrentLog !== 'function') {
    for (const id of ids) result.skipped.push({ id, reason: 'unsupported' })
    await auditSkips(options, 'delete', result.skipped)
    return result
  }
  const root = sessionsRoot(options.persistence)
  const entries = new Map((await options.persistence.list()).map((entry) => {
    const header = listedHeader(entry)
    return [String(header.id), entry] as const
  }))
  // The whole listing as the subagent-tree walk reads it. One pass, because a
  // tree walk per requested id would re-read the same rows.
  const headers: SessionHeaderRow[] = [...entries.values()].map((entry) => {
    const header = listedHeader(entry)
    return { id: String(header.id), parentSession: header.parentSession, origin: header.origin }
  })
  const archivedIds = new Set(options.registry.archivedSessionIds.map(String))
  // What the trash already holds. `held` is "present or unreadable" — a member
  // whose slot the filesystem will not describe still counts as possibly there,
  // so a second delete cannot start a second copy of it. Nothing destructive is
  // ever authorized from this set (see `lookupPurgeTarget`).
  const listing = await listEntries(options.trashRoot)
  const held = new Set([
    ...listing.entries.flatMap((entry) => entry.held),
    ...listing.leftovers.flatMap((leftover) => leftover.members.map((member) => member.sessionId)),
  ])
  const requested = new Set<string>()
  // The members this call will move, keyed by session id: a session can belong to
  // one tree only in practice, but a requested root that is ALSO a descendant of
  // another requested root must be queued once — two renames of one directory
  // would fail and roll the whole batch back.
  const planned = new Map<string, PlannedSession>()
  const wait: StopWaitOptions = options.stopWait ?? { timeoutMs: STOP_TIMEOUT_MS, pollMs: STOP_POLL_MS }
  for (const id of ids) {
    // Fence 0: one id appears once. A duplicate would otherwise be queued for
    // two moves of the same directory, and the second one's failure would roll
    // the whole batch back.
    if (requested.has(id)) {
      result.skipped.push({ id, reason: 'already-in-trash' })
      continue
    }
    requested.add(id)
    // Fence 1: only sessions the user archived are manageable here. One reading of
    // it is not a widening: an id the trash still holds answers `already-in-trash`
    // rather than `not-archived`, which is the more useful of two true statements
    // when a record was pruned out from under a row that is still parked. Nothing
    // moves either way.
    if (!archivedIds.has(id)) {
      result.skipped.push({ id, reason: held.has(id) ? 'already-in-trash' : 'not-archived' })
      continue
    }
    // The tree under this id: itself plus every subagent descendant. A refusal
    // here is about the WHOLE tree, so it is reported against the requested id
    // and nothing moves.
    const tree = await collectSubagentTree({ rootId: SessionId(id), catalog: options.subagents, headers })
    if (tree.kind === 'refused') {
      result.skipped.push({ id, reason: tree.reason, detail: tree.detail })
      continue
    }
    const members = tree.ids
    /** What a reason about more than the requested id reports: the tree it is about. */
    const treeSessions = members.length > 1 ? { sessions: members } : {}
    // Fence 2: a second click on the same row finds it already parked, and a tree
    // with ANY member already parked refuses whole — the first entry is what a
    // restore returns, and a second copy of one member is a tree nothing can put
    // back together.
    const parked = members.filter((memberId) => held.has(memberId))
    if (parked.length > 0) {
      result.skipped.push({
        id,
        reason: 'already-in-trash',
        ...(members.length > 1 ? { sessions: parked } : {}),
      })
      continue
    }
    // Fence 3: the root's log has to be there to be movable (an id whose log is
    // gone is /prune's business, not /delete's).
    if (entries.get(id) === undefined) {
      result.skipped.push({ id, reason: 'missing', ...treeSessions })
      continue
    }
    // Fence 4: what the KERNEL says is running — for every member, because a busy
    // child means the parent is producing output under it right now. This replaces
    // a mid-turn guess read off `session.snapshotEvents()` — a method this kernel
    // line deprecates — which knew nothing about background jobs, subagent
    // descendants or scheduled follow-ups, and which only ever looked at sessions
    // that happened to be resident.
    //
    // A waterfall that THROWS cannot answer the question, and the only safe
    // reading of "cannot tell whether work is running" is that it might be: the
    // tree stays. Moving a log whose session is mid-turn loses the turn, the
    // subagent transcripts under it, and the only record of what ran.
    const active: string[] = []
    let unconfirmed = false
    for (const memberId of members) {
      try {
        if ((await options.activity(memberId)).length > 0) active.push(memberId)
      } catch {
        unconfirmed = true
        break
      }
    }
    if (unconfirmed || active.length > 0) {
      // A stop request can only be aimed at a KNOWN list of running members, so an
      // unanswerable seam refuses here whatever `stopFirst` says: issuing no stop
      // and then waiting would report a timeout for work nobody asked to stop.
      if (!stopFirst || unconfirmed) {
        result.skipped.push({
          id,
          reason: 'live',
          ...(members.length > 1 ? { sessions: unconfirmed ? members : active } : {}),
        })
        continue
      }
      const outcome = await stopAndWait({
        ids: active,
        activity: options.activity,
        stop: options.stopSession,
        wait,
      })
      if (outcome.kind === 'stop-failed') {
        // The session was asked to stop and the dispatch failed: nothing moved, and
        // the listeners' own messages are kept as the diagnostic.
        result.skipped.push({ id, reason: 'stop-failed', sessions: active, detail: outcome.detail })
        continue
      }
      if (outcome.kind === 'still-running') {
        // The bounded wait ran out. Nothing moved, and the response names what was
        // still active so the user can decide (stop it by hand, or try again).
        result.skipped.push({ id, reason: 'still-running', sessions: [...outcome.ids] })
        continue
      }
    }
    // Fence 5: every member's directory, and where it really sits.
    //
    // "Not there" is a POSITIVE answer here: a descendant whose directory is proven
    // absent (ENOENT/ENOTDIR from both the resolver and the walk) has no directory
    // to move, so it is not a member and moving the rest of the tree cannot orphan
    // it. "I could not look" is a different answer, and it refuses the whole tree:
    // that is a member whose bytes exist somewhere this call may not reach, and
    // moving its parent past it is exactly the half-tree this surface must not
    // produce. The containment fence refuses the whole tree for the same reason.
    let refusal: { reason: ArchiveSkipReason; detail?: string } | undefined
    const found: PlannedSession[] = []
    for (const memberId of members) {
      const located = await locateSessionDir({ resolver, root, id: memberId })
      if (located.kind === 'refused') {
        refusal = { reason: located.reason, ...(located.detail === undefined ? {} : { detail: located.detail }) }
        break
      }
      if (located.kind === 'not-there') {
        if (memberId === id) {
          refusal = { reason: 'missing' }
          break
        }
        continue
      }
      found.push({
        id: memberId,
        dir: located.dir,
        sizeBytes: located.sizeBytes,
        // The requested root is archived by fence 1; a descendant was never in the
        // archive set, so a restore must not put it back as an archived session.
        archived: memberId === id,
      })
    }
    if (refusal !== undefined) {
      result.skipped.push({
        id,
        reason: refusal.reason,
        ...treeSessions,
        ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
      })
      continue
    }
    for (const member of found) {
      const existing = planned.get(member.id)
      // A collision keeps the archive fact: `archived` says whether the session was
      // in the archive set, not which root claimed it first.
      if (existing === undefined || (member.archived && !existing.archived)) planned.set(member.id, member)
    }
  }
  if (planned.size === 0) {
    // Nothing to move — every id is already in `skipped`, and each of those
    // answers is still a line in the audit log.
    await auditSkips(options, 'delete', result.skipped)
    return result
  }
  const movable: TrashMemberSource[] = [...planned.values()].map((member) => {
    const listed = entries.get(member.id)
    return {
      sessionId: member.id,
      title: listed === undefined ? '' : cachedTitle(options, listed),
      dirPath: member.dir,
      sizeBytes: member.sizeBytes,
      archived: member.archived,
    }
  })
  let entry: TrashEntry | undefined
  try {
    // One entry for the whole call: the batch travels together, so a restore
    // puts the batch back together. `moveToTrash` writes the entry before the
    // first rename, verifies every rename, and settles its own failures.
    entry = await moveToTrash({ root: options.trashRoot, ...(root === undefined ? {} : { sessionsRoot: root }), members: movable })
  } catch (error) {
    // The move settled itself: either nothing moved (the entry was removed) or
    // the members it could not put back are still parked in the entry named by
    // the error. Report each id as what actually happened to it.
    const code = trashErrorCode(error)
    const stuck = new Set(error instanceof TrashError ? (error.stuckIds ?? []) : [])
    for (const member of movable) {
      const reason: ArchiveSkipReason = stuck.has(member.sessionId)
        ? 'trash-interrupted'
        : code === 'trash-cross-device'
          ? 'cross-device'
          : code === 'trash-concurrent-move' ? 'concurrent' : 'io'
      result.skipped.push({ id: member.sessionId, reason })
    }
  }
  // Everything below runs ONLY for a move that finished, and it is OUTSIDE the try
  // above on purpose: the bytes are already in the trash, so a broadcast listener or
  // an audit append that raises must not be reported as "the move failed" — that
  // reports `deleted: []` over a payload that is sitting right there, and the retry
  // it invites finds the ids gone.
  if (entry !== undefined) {
    result.deleted = movable.map((member) => member.sessionId)
    result.freedBytes = movable.reduce((total, member) => total + member.sizeBytes, 0)
    result.trashId = entry.trashId
    for (const member of movable) {
      // A subagent child was never in the archive set: the tree is announced by its
      // root's id, and there is no record of its own.
      if (member.archived) announceRemoval(options, member.sessionId)
      await auditLine(options, {
        operation: 'delete',
        result: 'ok',
        sessionId: member.sessionId,
        entryId: entry.trashId,
        bytes: member.sizeBytes,
      })
    }
  }
  // One line per untouched id.
  await auditSkips(options, 'delete', result.skipped)
  return result
}

/**
 * Tell the client a session is gone — and never let that be more than a notice.
 *
 * This is the upstream-declared `api-session/removed` event (`./index.ts`). It is
 * PURELY INFORMATIONAL on this kernel line: no installed package subscribes to it,
 * so the archive record is what keeps a deleted session hidden (see the module
 * header). A listener that throws is therefore a warning, not a failure: the log
 * line is the only thing lost, and the delete's result must never depend on it.
 * @param options - route-layer dependencies.
 * @param id - the session whose removal to announce.
 */
function announceRemoval(options: ArchiveRoutesOptions, id: string): void {
  if (options.emitRemoved === undefined) return
  try {
    options.emitRemoved(id)
  } catch (error) {
    options.warn(`plugin-archives: a listener threw while announcing the removal of ${id}: ${
      error instanceof Error ? error.message : String(error)
    }`)
  }
}

/**
 * Drop archive-set records whose session logs are already gone. A record is
 * stale only when all three hold: still archived, absent from a fresh
 * persistence listing, and not a live session — everything else stays
 * untouched. The header snapshot is taken once per call; the archive set is
 * re-read inside the registry's serialized write chain so a concurrent
 * archive/unarchive write can never be lost.
 */
async function pruneStaleArchives(writer: RegistryPruner, options: ArchiveRoutesOptions): Promise<ArchivePruneResult> {
  const headerIds = new Set((await options.persistence.list()).map((entry) => String(listedHeader(entry).id)))
  const current = writer.archivedSessionIds.map(String)
  // A record is stale only when its session is GONE — not merely absent from
  // what this kernel can list. An older kernel skips a log written by a newer
  // one in silence (the listing reports the generations it can read and nothing
  // else), and pruning on that answer would drop the archive records of exactly
  // the sessions a rollback hid — un-hiding them for good, because the record
  // IS the client's visibility fence and nothing re-creates it.
  //
  // So the filesystem has the last word: a log directory still on disk means
  // the session is not gone, whatever the listing says.
  const root = sessionsRoot(options.persistence)
  const stale: string[] = []
  for (const id of current) {
    if (headerIds.has(id) || options.sessions?.get(id) !== undefined) continue
    if (root !== undefined) {
      const located = await locatedSessionDir(root, id)
      // Only PROVEN absence makes a record stale. A directory that is there — and
      // one that could not be inspected — keeps it: dropping a record un-hides the
      // session for good, and nothing re-creates it.
      if (located.kind !== 'absent') continue
    }
    stale.push(id)
  }
  // One id at a time, through the registry's own public removal: it writes on the
  // registry's serialized chain (so a concurrent archive/unarchive cannot be
  // lost) and maintains the fields a whole-state rewrite would have to know about
  // — the pin, and whatever this kernel line adds beside it next.
  for (const id of stale) {
    await writer.unarchiveSession(SessionId(id))
  }
  return { pruned: stale.length, remaining: current.length - stale.length }
}

/**
 * Why a restore of one row would be refused right now, when it would be.
 *
 * The answer comes from {@link planRestore} — the same function the restore
 * request itself runs — so a row can never offer an action its own fence has
 * already made impossible. `target-exists` is filtered out on purpose: it is a
 * situation at the target (the occupant can be deleted), not a missing
 * capability, and hiding the action over it would leave the user no way to see
 * why the restore refused.
 * @param options - route-layer dependencies.
 * @param listed - the entry, as the listing classified it.
 * @param root - the sessions root this backend exposes, if any.
 * @returns the block code, or undefined when a restore would proceed.
 */
async function restoreBlockFor(
  options: ArchiveRoutesOptions,
  listed: ListedEntry,
  root: string | undefined,
): Promise<ArchiveTrashRestoreBlock | undefined> {
  const plan = await planRestore({
    entry: listed.entry,
    entryDir: join(options.trashRoot, listed.entry.trashId),
    sessionsRoot: root,
  })
  const code = plan.blocked?.code
  return code === undefined || code === 'target-exists' ? undefined : code
}

/**
 * The trash listing, as the client's trash panel renders it.
 *
 * An interrupted entry is listed rather than hidden: its bytes are on disk, so the
 * only honest thing to do is show it as what it is — not restorable as the batch
 * it was, and clearable by its own id.
 *
 * `restorable` is answered per request from the payload on disk AND the sessions
 * root this backend can see right now (see `restoreBlockFor`). A row that cannot
 * be restored says why, because the alternative — a stored `true` next to a
 * button that fails every single time — is a claim this surface cannot keep.
 * @param options - route-layer dependencies.
 * @returns entries newest-first with their totals.
 */
async function listTrash(options: ArchiveRoutesOptions): Promise<ArchiveTrashList> {
  const listing = await listEntries(options.trashRoot)
  const root = sessionsRoot(options.persistence)
  const entries: ArchiveTrashEntry[] = []
  for (const listed of listing.entries) {
    // What the entry reports is what is on disk, not what its metadata claims: a
    // member proven gone is not listed, so acting on this row can never reach a
    // session that is back at its original path.
    const members = listed.entry.members.filter((member) => listed.held.includes(member.sessionId))
    const block = listed.restorable ? await restoreBlockFor(options, listed, root) : 'no-payload'
    entries.push({
      trashId: listed.entry.trashId,
      deletedAt: listed.entry.deletedAt,
      // "Interrupted" is a fact about the payload: nothing proven present, or
      // something the filesystem would not describe.
      state: listed.present.length > 0 && listed.unreadable.length === 0 ? 'ready' : 'interrupted',
      restorable: block === undefined,
      ...(block === undefined ? {} : { restorableBlock: block }),
      members: members.map((member) => ({
        sessionId: member.sessionId,
        title: member.title,
        sizeBytes: member.sizeBytes,
        present: listed.present.includes(member.sessionId),
      })),
      totalBytes: members.reduce((total, member) => total + member.sizeBytes, 0),
    })
  }
  // Unfinished deletions and unreadable entries are rows too: their bytes are on
  // disk, so hiding them would be the silent residue this panel exists to avoid —
  // and their trash id is the only handle that can free them.
  const leftovers: ArchiveTrashEntry[] = listing.leftovers.map((leftover) => ({
    trashId: leftover.trashId,
    deletedAt: leftover.deletedAt,
    state: leftover.kind === 'purging' ? 'purging' : 'unverified',
    // Neither is restorable at all, and the state says which: no block reason is
    // reported because no restore is on the table.
    restorable: false,
    members: leftover.members.map((member) => ({
      sessionId: member.sessionId,
      title: member.title,
      sizeBytes: member.sizeBytes,
      present: false,
    })),
    totalBytes: leftover.bytes,
  }))
  const all = [...entries, ...leftovers].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
  // The span of deletion instants is what makes the totals mean something: "12
  // entries, 3.4 MB" says nothing about whether that grew over a week or a year.
  const instants = all.map((entry) => Date.parse(entry.deletedAt)).filter((at) => !Number.isNaN(at))
  return {
    entries: all,
    sessionCount: all.reduce((count, entry) => count + entry.members.length, 0),
    totalBytes: all.reduce((total, entry) => total + entry.totalBytes, 0),
    ...(instants.length === 0
      ? {}
      : {
        oldestDeletedAt: new Date(Math.min(...instants)).toISOString(),
        newestDeletedAt: new Date(Math.max(...instants)).toISOString(),
      }),
  }
}

/**
 * Delete trashed entries for good.
 *
 * The ENTRY is the unit: an entry is what a restore returns as a whole, so
 * purging one session of a batch purges the batch. An id may be either the
 * entry's own trash id or a session id whose payload is still in the trash —
 * both name the same row, and the two spellings exist so that every row the
 * listing shows has a request that can clear it.
 *
 * What a session id is allowed to authorize is decided by
 * {@link lookupPurgeTarget} and nowhere else: a member proven PRESENT authorizes
 * the purge, a member proven ABSENT names nothing, and a slot the filesystem
 * would not describe is refused with a retryable reason instead of being read as
 * "it may be there, delete it".
 *
 * A purge also removes the projection-cache shards of every session it buries.
 * That cleanup runs AFTER the bytes are gone, and a failure is reported as a
 * warning: the entry is deleted either way, so a retry of this request would find
 * nothing left to delete and the shard would stay unreported forever.
 * @param options - route-layer dependencies.
 * @param ids - trash ids, or session ids whose payload is present.
 * @returns the purged entries, the bytes they freed, the ids that named none and
 *   the cache shards that could not be removed.
 */
async function purgeTrash(options: ArchiveRoutesOptions, ids: readonly string[]): Promise<ArchivePurgeResult> {
  const result: ArchivePurgeResult = { purged: [], freedBytes: 0, skipped: [], warnings: [] }
  const listing = await listEntries(options.trashRoot)
  const handled = new Set<string>()
  for (const id of ids) {
    const remaining = {
      entries: listing.entries.filter((candidate) => !handled.has(candidate.entry.trashId)),
      leftovers: listing.leftovers.filter((candidate) => !handled.has(candidate.dirName)),
    }
    const lookup = lookupPurgeTarget(remaining, id)
    if (lookup.kind === 'refused') {
      result.skipped.push({ id, reason: 'trash-unconfirmed' })
      continue
    }
    if (lookup.kind === 'none') {
      result.skipped.push({ id, reason: 'not-in-trash' })
      continue
    }
    const target = lookup.target
    try {
      const { freedBytes } = await purgeEntry({ root: options.trashRoot, target })
      handled.add(target.dirName)
      result.freedBytes += freedBytes
      result.purged.push({ trashId: target.trashId, ids: [...target.ids], deletedAt: target.deletedAt })
      for (const sessionId of target.ids) {
        await auditLine(options, {
          operation: 'purge',
          result: 'ok',
          sessionId,
          entryId: target.trashId,
        })
      }
      // After the entry is gone: the shards belong to the sessions (or to the
      // leftover's recorded members) and are residue nothing else reclaims.
      const warnings = await purgeSessionShards({ dir: options.projCacheDir, ids: target.ids })
      for (const warning of warnings) result.warnings.push({ id: warning.id, code: warning.code })
    } catch {
      result.skipped.push({ id, reason: 'io' })
    }
  }
  await auditSkips(options, 'purge', result.skipped)
  return result
}

/** Map one trash failure onto the skip reason the client words. */
function restoreSkipReason(error: unknown): ArchiveSkipReason {
  switch (trashErrorCode(error)) {
    case 'trash-target-exists':
      return 'target-exists'
    case 'trash-path-outside-root':
      return 'path-outside-root'
    case 'trash-cross-device':
      return 'cross-device'
    case 'trash-restore-needs-root':
      return 'needs-root'
    case 'trash-state-unconfirmed':
      return 'trash-unconfirmed'
    case 'trash-entry-missing':
      return 'not-in-trash'
    default:
      return 'io'
  }
}

/**
 * Move trashed sessions back to their original paths and re-create their
 * archive records.
 *
 * A restore needs the sessions root to fence the recorded paths against, and it
 * needs it NOW: `metadata.json` is a file on disk, so a flag inside it may never
 * be what decides whether a write outside the root is allowed. Without a root
 * every id answers `needs-root`.
 *
 * An id may name the entry by its trash id or by a present member's session id;
 * both name the same row, and the entry is restored member by member:
 *
 *   - a member whose payload is still in the trash comes back here, and its
 *     archive record is re-created;
 *   - a member whose payload is already HOME is reported (`trash-member-already-home`)
 *     and not touched — failing the whole restore over it would leave the rest of
 *     the batch with no way back but a purge;
 *   - a member whose payload is gone from both places is reported as lost
 *     (`trash-member-lost`), which is a fact about data that was already gone, not
 *     something this call did.
 *
 * Order matters for the members that do move: the directory goes back FIRST,
 * because `archiveSession` requires the session to exist, and because a record
 * without its log would be a stale record the very next /list reports. A
 * directory that comes back but whose record does not is a warning
 * (`archive-record-failed`), never a silent success — and never a failure of the
 * move that did happen.
 * @param writer - the registry's public archive path.
 * @param options - route-layer dependencies.
 * @param ids - trash ids, or session ids whose payload is present.
 * @returns what came back, what did not, and the non-fatal problems.
 */
async function restoreDeleted(
  writer: RegistryRestorer,
  options: ArchiveRoutesOptions,
  ids: readonly string[],
): Promise<ArchiveRestoreDeletedResult> {
  const result: ArchiveRestoreDeletedResult = { restored: [], skipped: [], warnings: [] }
  const root = sessionsRoot(options.persistence)
  if (root === undefined) {
    for (const id of ids) {
      result.skipped.push({ id, reason: 'needs-root' })
      await auditLine(options, { operation: 'restore', result: 'skipped', entryId: id, reason: 'needs-root' })
    }
    return result
  }
  const listing = await listEntries(options.trashRoot)
  const consumed = new Set<string>()
  for (const id of ids) {
    const listed = entryForAddress(
      { entries: listing.entries.filter((candidate) => !consumed.has(candidate.entry.trashId)), leftovers: [] },
      id,
    )
    if (listed === undefined) {
      // An `unverified` directory (a minted trash id whose metadata cannot be read)
      // is a row, so its answer must not be "no such session in the trash": what is
      // true is that nothing in it can be located. A `.purging` leftover is out of
      // service by definition, which `not-in-trash` does describe.
      const unverified = listing.leftovers.some((candidate) => candidate.trashId === id && candidate.kind === 'unverified')
      result.skipped.push({ id, reason: unverified ? 'missing' : 'not-in-trash' })
      continue
    }
    let outcome: Awaited<ReturnType<typeof restoreEntry>>
    try {
      outcome = await restoreEntry({ root: options.trashRoot, sessionsRoot: root, trashId: listed.entry.trashId })
    } catch (error) {
      result.skipped.push({ id, reason: restoreSkipReason(error) })
      continue
    }
    consumed.add(listed.entry.trashId)
    for (const warning of outcome.warnings) {
      result.warnings.push({ id, code: warning.code })
    }
    for (const sessionId of outcome.alreadyHome) {
      result.warnings.push({ id: sessionId, code: 'trash-member-already-home' })
    }
    for (const sessionId of outcome.lost) {
      result.warnings.push({ id: sessionId, code: 'trash-member-lost' })
    }
    // What each member was when it went INTO the trash. A subagent child was never
    // in the archive set (`TrashMember.archived === false`), so re-creating its
    // record here would HIDE it — the opposite of putting the tree back as it was.
    // An entry written before that field existed says nothing, and "archived" is
    // the right reading of it: every such entry held archived sessions only.
    const archivedByMember = new Map(outcome.entry.members.map((member) => [member.sessionId, member.archived !== false]))
    for (const sessionId of outcome.restored) {
      const recordExpected = archivedByMember.get(sessionId) !== false
      if (!recordExpected) {
        // The directory is back and no record has to come back with it.
        result.restored.push(sessionId)
        await auditLine(options, { operation: 'restore', result: 'ok', sessionId, entryId: listed.entry.trashId })
        continue
      }
      try {
        await writer.archiveSession(SessionId(sessionId))
      } catch {
        // The directory is back; only the archive record is missing. Say so:
        // the session is now visible in the sidebar, which is not what the user
        // asked for and not something a retry of the same call would fix.
        const code: ArchiveRestoreWarningCode = 'archive-record-failed'
        result.warnings.push({ id: sessionId, code })
        continue
      }
      result.restored.push(sessionId)
      await auditLine(options, { operation: 'restore', result: 'ok', sessionId, entryId: listed.entry.trashId })
    }
  }
  await auditSkips(options, 'restore', result.skipped)
  return result
}

/**
 * Run the retention sweep: read the tier, expire what is older, audit each row.
 *
 * The `/sweep` route and the startup sweep both call THIS function, which is what
 * the retention policy needs to mean one thing: two implementations (one behind
 * the button, one behind the switch) is how an entry survives one path and
 * vanishes through the other. The audit lines live here for the same reason —
 * an expiry the user did not click must be as visible as one they did.
 * @param options - route-layer dependencies.
 * @returns what expired, the bytes freed, and what could not be removed.
 */
export async function runRetentionSweep(options: ArchiveRoutesOptions): Promise<ArchiveSweepResult> {
  const read = await readSettings(options.settingsPath)
  if (read.malformed && read.detail !== undefined) options.warn(`plugin-archives: ${read.detail}`)
  const result: ArchiveSweepResult = await sweepExpired({
    trashRoot: options.trashRoot,
    projCacheDir: options.projCacheDir,
    retentionDays: read.settings.retentionDays,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  for (const purged of result.purged) {
    for (const sessionId of purged.ids) {
      await auditLine(options, { operation: 'purge', result: 'ok', sessionId, entryId: purged.trashId })
    }
  }
  await auditSkips(options, 'purge', result.skipped)
  return result
}

/**
 * Register the plugin's API routes on the Connection exact-Fetch registry.
 *
 * Every route owns its exact path and its methods; another method of the same
 * path falls through to the shared channel's own 404 rather than a route body.
 * `/settings` is the one path with two methods, dispatched by one registration.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param options - route-layer dependencies.
 * @returns a disposer removing all of them.
 */
export function registerArchiveRoutes(connectionFetch: HostConnectionFetch, options: ArchiveRoutesOptions): () => Promise<void> {
  const listFetch = async (): Promise<Response> => {
    try {
      return ok(await listArchives(options))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'list-failed', {
        code: 'route.listFailed',
        params: { detail },
        text: `could not read archived sessions: ${detail}`,
      })
    }
  }
  const deleteFetch = async (request: Request): Promise<Response> => {
    try {
      const body = await readJsonBody(request)
      const ids = (body as { ids?: unknown }).ids
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_CALL || ids.some((id) => typeof id !== 'string')) {
        return fail(400, 'bad-request', { code: 'route.idsRequired', text: 'the body needs a non-empty array of string ids' })
      }
      // Optional `stopFirst`: ask `workspace/session-stop` to cancel a running
      // session's work and wait for the activity seam to answer empty, instead of
      // skipping it as `live`. Anything but a boolean is refused before the
      // filesystem is touched, so a typo cannot be read as "true" or "false".
      const stopFirst = (body as { stopFirst?: unknown }).stopFirst
      if (stopFirst !== undefined && typeof stopFirst !== 'boolean') {
        return fail(400, 'bad-request', {
          code: 'route.badStopFirst',
          text: 'stopFirst must be a boolean when present',
        })
      }
      // /delete moves the log directories into the trash and keeps the archive
      // records: no registry write is needed for the record, and no capability is
      // required for it either. The stale record it leaves is what /list counts and
      // /prune reclaims, and it is what /restore-deleted re-creates in place.
      return ok(await deleteArchives(options, ids as string[], stopFirst === true))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'delete-failed', {
        code: 'route.deleteFailed',
        params: { detail },
        text: `could not delete archived sessions: ${detail}`,
      })
    }
  }
  const pruneFetch = async (request: Request): Promise<Response> => {
    // Capability check on the PUBLIC removal path: a kernel that does not publish
    // `unarchiveSession` must fail loudly (501) rather than have this plugin reach
    // for a private write chain that may have been reshaped.
    const writer = options.registry as RegistryPruner
    if (typeof writer.unarchiveSession !== 'function') {
      return fail(501, 'prune-unsupported', {
        code: 'route.pruneUnsupported',
        text: 'this kernel version cannot prune archive records',
      })
    }
    // Same body discipline as /delete (size-capped); prune takes no input,
    // so the body is drained and ignored.
    try {
      await readJsonBody(request)
      return ok(await pruneStaleArchives(writer, options))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'prune-failed', {
        code: 'route.pruneFailed',
        params: { detail },
        text: `could not prune archive records: ${detail}`,
      })
    }
  }
  const restoreFetch = async (request: Request): Promise<Response> => {
    // Same capability discipline as /prune: the PUBLIC removal path is the only
    // one this plugin may use, and a kernel that does not publish it must fail
    // loudly (501) rather than have the plugin reach for a private write chain.
    const writer = options.registry as RegistryPruner
    if (typeof writer.unarchiveSession !== 'function') {
      return fail(501, 'restore-unsupported', {
        code: 'route.restoreUnsupported',
        text: 'this kernel version cannot restore an archived session',
      })
    }
    try {
      const body = await readJsonBody(request)
      const ids = (body as { ids?: unknown }).ids
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_CALL || ids.some((id) => typeof id !== 'string')) {
        return fail(400, 'bad-request', { code: 'route.idsRequired', text: 'the body needs a non-empty array of string ids' })
      }
      // Restoring is the exact inverse of archiving: dropping the id from the
      // archive set un-hides the session on every grouping surface, and the log
      // was never touched, so nothing else has to happen. The registry's own
      // serialized chain is what makes a concurrent archive/restore safe.
      const restored: string[] = []
      const skipped: ArchiveSkipped[] = []
      const archived = new Set(options.registry.archivedSessionIds.map(String))
      for (const id of ids as string[]) {
        if (!archived.has(id)) {
          // Not archived is not an error worth failing the whole call over: a
          // second click, or a session restored from another window, is normal.
          skipped.push({ id, reason: 'not-archived' })
          await auditLine(options, { operation: 'restore', result: 'skipped', sessionId: id, reason: 'not-archived' })
          continue
        }
        await writer.unarchiveSession(SessionId(id))
        restored.push(id)
        // Un-archiving is what the row's restore button does, so it is an action
        // the log records even though no byte moved: a later "why is this session
        // visible again" has the same kind of answer as any other.
        await auditLine(options, { operation: 'restore', result: 'ok', sessionId: id })
      }
      return ok({ restored, skipped })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'restore-failed', {
        code: 'route.restoreFailed',
        params: { detail },
        text: `could not restore archived sessions: ${detail}`,
      })
    }
  }
  const trashFetch = async (): Promise<Response> => {
    try {
      return ok(await listTrash(options))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'trash-failed', {
        code: 'route.trashFailed',
        params: { detail },
        text: `could not read the session trash: ${detail}`,
      })
    }
  }
  const restoreDeletedFetch = async (request: Request): Promise<Response> => {
    // Same capability discipline as /restore: the PUBLIC archive path is the only
    // one this plugin may use. A kernel that does not publish `archiveSession`
    // gets a coded 501 instead of a restore that silently leaves the session
    // visible, or a reach into a private write chain that may have been reshaped.
    const writer = options.registry as RegistryRestorer
    if (typeof writer.archiveSession !== 'function') {
      return fail(501, 'restore-deleted-unsupported', {
        code: 'route.restoreDeletedUnsupported',
        text: 'this kernel version cannot restore an archive record',
      })
    }
    try {
      const body = await readJsonBody(request)
      const ids = (body as { ids?: unknown }).ids
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_CALL || ids.some((id) => typeof id !== 'string')) {
        return fail(400, 'bad-request', { code: 'route.idsRequired', text: 'the body needs a non-empty array of string ids' })
      }
      return ok(await restoreDeleted(writer, options, ids as string[]))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'restore-deleted-failed', {
        code: 'route.restoreDeletedFailed',
        params: { detail },
        text: `could not restore deleted sessions: ${detail}`,
      })
    }
  }
  const purgeFetch = async (request: Request): Promise<Response> => {
    try {
      const body = await readJsonBody(request)
      const ids = (body as { ids?: unknown }).ids
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_CALL || ids.some((id) => typeof id !== 'string')) {
        return fail(400, 'bad-request', { code: 'route.idsRequired', text: 'the body needs a non-empty array of string ids' })
      }
      // The only irreversible route on this surface: everything else moves a
      // directory and records where it came from.
      return ok(await purgeTrash(options, ids as string[]))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'purge-failed', {
        code: 'route.purgeFailed',
        params: { detail },
        text: `could not purge trashed sessions: ${detail}`,
      })
    }
  }
  const searchFetch = async (request: Request): Promise<Response> => {
    if (options.sessionQuery === undefined) {
      return fail(503, 'session-query-unavailable', {
        code: 'route.sessionQueryUnavailable',
        text: 'this kernel provides no session search service (session-query-sqlite is not enabled)',
      })
    }
    const url = new URL(request.url)
    // Cap the query: the backend scores the full text, so bound what we send.
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 500)
    if (query === '') {
      return fail(400, 'bad-request', { code: 'route.queryRequired', text: 'the query must not be empty' })
    }
    const limitParam = Number(url.searchParams.get('limit') ?? '20')
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(50, Math.floor(limitParam)) : 20
    try {
      const page = await options.sessionQuery.searchSessions({ query, limit })
      const items = page.items.map((hit) => ({
        id: String(hit.header.id ?? ''),
        title: typeof hit.header.title === 'string' ? hit.header.title : '',
        createdAt: typeof hit.header.createdAt === 'number' ? hit.header.createdAt : 0,
        cwd: typeof hit.header.cwd === 'string' ? hit.header.cwd : '',
        snippet: typeof hit.bestMatch?.snippet === 'string' ? hit.bestMatch.snippet : '',
      }))
      const agentToolAvailable = options.tools !== undefined
        && options.tools.schemas().some((schema) => schema.name === 'session_search')
      return ok({ items, agentToolAvailable } satisfies ArchiveSearchResult)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'search-failed', {
        code: 'route.searchFailed',
        params: { detail },
        text: `session search failed: ${detail}`,
      })
    }
  }

  const settingsRead = async (): Promise<Response> => {
    try {
      const read = await readSettings(options.settingsPath)
      // A file this build cannot use is worth a line in the host log: nothing is
      // written back over it, so "the defaults applied" has to be visible somewhere.
      if (read.malformed && read.detail !== undefined) options.warn(`plugin-archives: ${read.detail}`)
      const view: ArchiveSettingsView = {
        settings: read.settings,
        malformed: read.malformed,
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      }
      return ok(view)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'settings-failed', {
        code: 'route.settingsFailed',
        params: { detail },
        text: `could not read the retention settings: ${detail}`,
      })
    }
  }
  const saveSettingsFetch = async (request: Request): Promise<Response> => {
    try {
      const body = await readJsonBody(request)
      const retentionDays = (body as { retentionDays?: unknown }).retentionDays
      // The tier is a closed set and `0` is a real member of it: `isRetentionDays`
      // answers by TYPE and VALUE, so `null`, `''` and `"7"` are refused instead of
      // being coerced into "keep for ever" (see `./settings.ts`).
      if (!isRetentionDays(retentionDays)) {
        return fail(400, 'bad-request', {
          code: 'route.badRetentionDays',
          text: 'retentionDays must be one of 0, 7, 15, 30, 90',
        })
      }
      const sweepOnStartup = (body as { sweepOnStartup?: unknown }).sweepOnStartup
      if (sweepOnStartup !== undefined && typeof sweepOnStartup !== 'boolean') {
        return fail(400, 'bad-request', {
          code: 'route.badSweepOnStartup',
          text: 'sweepOnStartup must be a boolean when present',
        })
      }
      const written = await writeSettings(options.settingsPath, {
        version: SETTINGS_VERSION,
        retentionDays,
        // Absent means "leave the switch where it is": a caller that only changes
        // the tier must not silently flip the startup sweep.
        sweepOnStartup: sweepOnStartup ?? (await readSettings(options.settingsPath)).settings.sweepOnStartup,
      })
      await auditLine(options, { operation: 'settings', result: 'ok' })
      return ok({ settings: written, malformed: false } satisfies ArchiveSettingsView)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'settings-write-failed', {
        code: 'route.settingsWriteFailed',
        params: { detail },
        text: `could not write the retention settings: ${detail}`,
      })
    }
  }
  /**
   * One path, two methods.
   *
   * `/settings` is registered ONCE with both methods and dispatches here: the
   * carrier keys a route by its exact path, so two registrations of the same path
   * would leave whichever came last answering both — and a GET reaching the write
   * handler would answer 400 for a body it never wanted.
   */
  const settingsFetch = async (request: Request): Promise<Response> =>
    (request.method === 'POST' ? saveSettingsFetch(request) : settingsRead())
  const sweepFetch = async (request: Request): Promise<Response> => {
    try {
      // Same body discipline as /prune: the sweep takes no input, so the body is
      // drained (the carrier buffered it) and ignored.
      await readJsonBody(request)
      return ok(await runRetentionSweep(options))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'sweep-failed', {
        code: 'route.sweepFailed',
        params: { detail },
        text: `could not run the retention sweep: ${detail}`,
      })
    }
  }

  const disposers = [
    connectionFetch.register({ path: `${ROUTE_PREFIX}/list`, methods: ['GET'], requestBody: 'buffered', fetch: listFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/trash`, methods: ['GET'], requestBody: 'buffered', fetch: trashFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/delete`, methods: ['POST'], requestBody: 'buffered', fetch: deleteFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/restore`, methods: ['POST'], requestBody: 'buffered', fetch: restoreFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/restore-deleted`, methods: ['POST'], requestBody: 'buffered', fetch: restoreDeletedFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/purge`, methods: ['POST'], requestBody: 'buffered', fetch: purgeFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/prune`, methods: ['POST'], requestBody: 'buffered', fetch: pruneFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/settings`, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: settingsFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/sweep`, methods: ['POST'], requestBody: 'buffered', fetch: sweepFetch }),
    connectionFetch.register({ path: `${ROUTE_PREFIX}/search`, methods: ['GET'], requestBody: 'buffered', fetch: searchFetch }),
  ]
  return async () => {
    for (const dispose of disposers) await dispose()
  }
}
