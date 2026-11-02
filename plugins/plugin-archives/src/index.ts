/**
 * DSH APP session archive manager — host half.
 *
 * Serves the archive manager's routes (list/trash/delete/restore/restore-deleted/
 * purge/prune/search) on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-archives`. The archive set comes from the
 * workspace registry (`archivedSessionIds` — upstream archiving hides a
 * session from every grouping surface but never touches its stored log),
 * session metadata from `sessionPersistence.list()`, titles from the
 * projection cache (zero-I/O), and liveness from the sessions store.
 *
 * Upstream has no session-deletion API (persistence is append-only by
 * contract), so deletion is ours — and it is a MOVE, not an unlink: /delete
 * renames each archived session's log directory into the plugin's own trash
 * under `$DSH_HOME/storages/dsh-app-plugin-archives/trash/`, /restore-deleted
 * moves it back and re-creates the archive record through the registry's public
 * `archiveSession`, and /purge is the one route that frees bytes. Safety fences:
 * only archived ids are deletable, live sessions are skipped unless the request
 * asks to stop them first, and every result reports what moved and what was
 * skipped with a reason.
 *
 * A session is deleted as its whole subagent tree: the descendants are collected
 * from `ctx.subagents.listDescendants` plus the persisted headers' parent marker
 * (`./tree.ts`) and travel into the SAME trash entry, so a restore brings the tree
 * back together. A running member refuses the whole tree; a request that carries
 * `stopFirst` instead stops the work through the public
 * `workspace/session-stop` event and waits — with a bound — for
 * `workspace/session-activity` to answer empty (`./stop.ts`). Neither path takes a
 * live session out of the kernel's in-memory store: those handles are private, and
 * a moved session stays resident until the next kernel restart.
 *
 * A purge also removes the kernel's projection-cache shard for the sessions it
 * buries (`./projcache.ts`): the cache has no eviction surface of its own, so a
 * deleted session's document would otherwise outlive every listing that could
 * name it. Moving a session into the trash keeps its shard on purpose.
 *
 * /delete KEEPS the archive-set record: the set is the client's visibility fence
 * over the list snapshot the browser already holds, so a dropped record un-hides a
 * session whose log is in the trash and the row pops back until the next reload.
 * The kept record is stale (its log is gone), which `/list` counts and `/prune`
 * reclaims. The removal is ALSO announced with the upstream `api-session/removed`
 * event — purely informational here: nothing installed on this kernel line
 * subscribes to it, so it is never a reason to drop the record, and a listener that
 * throws costs a warning.
 *
 * Two housekeeping surfaces ride the same routes: the retention policy
 * (`./settings.ts` — `retentionDays` one of 0/7/15/30/90, and whether to sweep at
 * startup) and the audit log (`./audit.ts` — one JSON line per action, rolled at
 * 1 MiB). The startup sweep calls the SAME `runRetentionSweep` the settings page's
 * button posts to, so the two can never age entries differently. A settings file
 * that exists but cannot be trusted reads as "nothing expires, nothing sweeps"
 * (`SAFE_SETTINGS`): the trash is the user's only undo buffer for a deletion, so an
 * unreadable policy must not be able to empty it.
 *
 * Stability discipline: zero global side effects — no context prototype
 * mutation, no process-wide state. A kernel without the consumed services
 * never mounts anything.
 *
 * @module @dsh-app/plugin-archives
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the sessionPersistence Context merge into scope.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: pulls the workspaceRegistry Context merge into scope.
import type {} from '@deepseek-ai/dsh-workspace'
import {
  registerArchiveRoutes,
  runRetentionSweep,
  type ArchiveRoutesOptions,
  type ProjectionCacheLike,
  type SessionQueryLike,
  type SessionsLike,
  type ToolsLike,
} from './routes.ts'
import { projCacheSessionsDir } from './projcache.ts'
import { readSettings, settingsPathIn } from './settings.ts'
import type { SubagentCatalogLike } from './tree.ts'

// The removal broadcast. `api-session/removed` is declared by
// `@deepseek-ai/dsh-api-remotes` as one of the Host events this application
// forwards (`API_REMOTE_FORWARDED_EVENTS`, `mode: 'emit'`, its payload bound to
// the `session` resource), but that package declares the ALLOWLIST, not a cordis
// `Events` signature — so the event is declared here, which is exactly what
// cordis's merge-extensible `Events` map is for (`plugin-rewind` declares its tool
// gates the same way). Omitting the declaration would need a cast the type gate
// cannot see, and a kernel that renamed the event would then fail in silence.
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A session ceased to exist; the payload is the id a forwarded frame names. */
    'api-session/removed'(sessionId: SessionId): void
  }
}

export const name = 'plugin-archives'

/**
 * The archive manager rides the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/** Config: none yet — the manager is a fixed-surface maintenance tool. */
export interface Config {}
export const Config: z<Config> = z.object({})

/**
 * Host apply: mount the archive manager's API routes on the Connection
 * transport. A route registration failure is the plugin's own and never fails
 * the boot.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)
  // The trash lives beside the other plugins' stores, in the harness home and
  // therefore on the same filesystem as the sessions root — which is what keeps
  // a move a rename. `$DSH_HOME` is resolved once, at mount: a kernel process
  // never changes it, and the route layer takes the path as data so a test can
  // point it at a temporary directory.
  const home = resolveDshHome()
  const trashRoot = join(home, 'storages', 'dsh-app-plugin-archives', 'trash')
  // The kernel's own projection-cache table: `<DSH_HOME>/storages/session_projcache/
  // sessions/<session id>.json`. `/purge` removes the shards of the sessions it
  // buries (nothing else ever reclaims them); moving a session into the trash
  // leaves them alone, so a restore comes back with its title.
  const projCacheDir = projCacheSessionsDir(home)
  const settingsPath = settingsPathIn(home)
  const options: ArchiveRoutesOptions = {
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    trashRoot,
    projCacheDir,
    // Optional services degrade to feature loss, never boot failure: without
    // the sessions store every id looks cold (still safe to delete), and
    // without the projection cache rows just lose their titles.
    sessions: ctx.get('sessions') as SessionsLike | undefined,
    // The kernel's own "is this session busy" answer: the same
    // `workspace/session-activity` waterfall that `archiveSession` refuses on,
    // answered by the turn family, running background jobs, subagent
    // descendants and scheduled follow-ups. Handed over as a plain function
    // over a string id so the route layer stays kernel-agnostic; the id is
    // built with the kernel's own constructor rather than asserted.
    activity: id => ctx.waterfall(
      'workspace/session-activity',
      { sessionId: SessionId(id) },
      () => Promise.resolve([]),
    ),
    // The kernel's own stop request, for a delete that carries `stopFirst`: the
    // `workspace/session-stop` event, dispatched CONCURRENTLY (its declared mode —
    // `@deepseek-ai/dsh-workspace/lib/types/index.d.ts:110`), whose providers
    // cancel the turn family, subagent descendants, owned jobs and schedules
    // through the same paths the user's stop buttons use. Fire-and-return by
    // design, which is why the route polls `activity` afterwards (`./stop.ts`).
    stopSession: id => ctx.parallel('workspace/session-stop', { sessionId: SessionId(id) }),
    // `ctx.subagents`' descendant walk, for the session's whole subagent tree: a
    // PUBLIC method (`SubagentRuntime.listDescendants`,
    // `@deepseek-ai/dsh-subagent/lib/types/index.d.ts:245`), handed over as a plain
    // object so the route layer stays kernel-agnostic. Optional — without it the
    // tree comes from the persisted headers' `parentSession` + `origin` pair.
    subagents: ctx.get('subagents') as SubagentCatalogLike | undefined,
    projectionCache: ctx.get('sessionProjectionCache') as ProjectionCacheLike | undefined,
    // Session full-text search + agent-tool availability (opt-in overlay):
    // without them /search answers 503 and agentToolAvailable stays false.
    sessionQuery: ctx.get('sessionQuery') as SessionQueryLike | undefined,
    tools: ctx.get('tools') as ToolsLike | undefined,
    // One line per action, beside the kernel's own logs. The path is handed over
    // as data (the route layer writes nothing to `$DSH_HOME` it was not given).
    auditLog: join(home, 'logs', 'dsh-app-plugin-archives.log'),
    settingsPath,
    // The removal broadcast (see the `Events` declaration above): informational
    // only. No package installed on this kernel line subscribes to
    // `api-session/removed`, so it changes nothing about the archive record — it is
    // dispatched (and contained) for a future client that does listen.
    emitRemoved: id => ctx.emit('api-session/removed', SessionId(id)),
    warn: message => log.warn(message),
  }
  ctx.effect(() => registerArchiveRoutes(ctx.connection.fetch, options), 'plugin-archives: api routes')

  // The retention sweep, when the settings say so. One shared implementation with
  // the settings page's "sweep now" button (`runRetentionSweep`), so a policy
  // cannot age an entry one way at startup and another way on demand.
  //
  // Started, not awaited: mounting must not wait on the trash, and a sweep that
  // fails is a logged warning — the entries it could not remove are still there
  // and will be picked up by the next sweep, because they are still expired.
  void (async () => {
    try {
      const read = await readSettings(settingsPath)
      if (read.malformed && read.detail !== undefined) log.warn(read.detail)
      if (!read.settings.sweepOnStartup) return
      const result = await runRetentionSweep(options)
      if (result.purged.length > 0) {
        log.info(`retention sweep removed ${result.purged.length} trash entr${
          result.purged.length === 1 ? 'y' : 'ies'
        } older than ${result.retentionDays} days`)
      }
    } catch (error) {
      log.warn(`retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
}
