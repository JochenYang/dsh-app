/**
 * DSH APP session archive manager — host half.
 *
 * Serves the archive manager's two routes (list/delete) under
 * `/plugins/@dsh-app/plugin-archives/api`. The archive set comes from the
 * workspace registry (`archivedSessionIds` — upstream archiving hides a
 * session from every grouping surface but never touches its stored log),
 * session metadata from `sessionPersistence.list()`, titles from the
 * projection cache (zero-I/O), and liveness from the sessions store.
 *
 * Upstream has no session-deletion API (persistence is append-only by
 * contract), so deletion removes exactly the session's own on-disk
 * directory, resolved through the backend's `locate()`. Safety fences:
 * only archived ids are deletable, live sessions are skipped, and every
 * result reports what was freed and what was skipped with a reason.
 *
 * The archived id itself stays in the registry after its log is deleted
 * (the registry exposes no removal API): a stale entry hides nothing and
 * is reported as `staleCount` by /list.
 *
 * Stability discipline: zero global side effects — no context prototype
 * mutation, no process-wide state. A kernel without the consumed services
 * never mounts anything.
 *
 * @module @dsh-app/plugin-archives
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the sessionPersistence Context merge into scope.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: pulls the workspaceRegistry Context merge into scope.
import type {} from '@deepseek-ai/dsh-workspace'
import {
  registerArchiveRoutes,
  type ProjectionCacheLike,
  type SessionsLike,
} from './routes.ts'

export const name = 'plugin-archives'
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']

/** Config: none yet — the manager is a fixed-surface maintenance tool. */
export interface Config {}
export const Config: z<Config> = z.object({})

/**
 * Host apply: mount the archive manager's API routes.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerArchiveRoutes(ctx.webServer, {
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    // Optional services degrade to feature loss, never boot failure: without
    // the sessions store every id looks cold (still safe to delete), and
    // without the projection cache rows just lose their titles.
    sessions: ctx.get('sessions') as SessionsLike | undefined,
    projectionCache: ctx.get('sessionProjectionCache') as ProjectionCacheLike | undefined,
  }), 'plugin-archives: api routes')
}
