/**
 * DSH APP sidebar dock — host half.
 *
 * Registers the plugin's Git routes on the Connection exact-Fetch registry
 * (`ctx.connection.fetch`, paths below `/api/plugins/dsh-app/plugin-sidebar`),
 * which is the only host seam the desktop form carries: the host disables the
 * `webserver` row, so a plugin that injects it never activates at all. The
 * file tree tab was retired with its fs routes: the upstream sidebar ships
 * file management natively.
 *
 * Stability discipline: the host half keeps ZERO global side effects — no
 * context prototype mutation, no process-wide state — because a host plugin
 * polluting the composition is how unrelated plugins break on session
 * resume (a regression class this plugin explicitly guards against).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the host session service (ctx.sessions) into scope.
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerGitRoutes } from './git-routes.ts'

/** The cordis services this host half consumes. */
export const inject = ['connection', 'sessions']

/**
 * Apply: register the git face on the Connection transport.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  // The monorepo type surface also declares the client-side `ctx.sessions`
  // face. Narrow the host service explicitly here; runtime injection still
  // resolves the host SessionStore declared above.
  const sessionStore = ctx.get('sessions') as unknown as {
    get(id: SessionId): { header: { cwd?: string } } | undefined
  }
  const gitScope = {
    cwdForSession: (sessionId: string): string | undefined => sessionStore.get(sessionId as SessionId)?.header.cwd,
  }
  ctx.effect(() => registerGitRoutes(ctx.connection.fetch, gitScope), 'plugin-sidebar: dispose git routes')
}
