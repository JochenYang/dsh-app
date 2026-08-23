/**
 * DSH APP sidebar dock — host half.
 *
 * Registers the plugin's trust-fenced HTTP routes on the dsh web server
 * (`/plugins/@dsh-app/plugin-sidebar/*`). The M1 surface is read-only
 * filesystem access (directory listing + bounded file preview); terminal
 * (pty), git, and writes arrive in later milestones, each fenced the same
 * way and disposed with the plugin's fiber.
 *
 * Stability discipline: the host half keeps ZERO global side effects — no
 * context prototype mutation, no process-wide state — because a host plugin
 * polluting the composition is how unrelated plugins break on session
 * resume (a regression class this plugin explicitly guards against).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the host session service (ctx.sessions) into scope.
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { handleFsRequest } from './fs-routes.ts'
import { handleGitRequest } from './git-routes.ts'
import { passesFence } from './trust-fence.ts'

/**
 * The plugin's route prefix on the dsh web server. It lives under an /api
 * segment INSIDE the plugin's plugin-route namespace: the plain
 * `/plugins/<pkg>/client.js` path (and anything else the client-modules
 * system serves at the package root) belongs to the loader — a prefix route
 * at the package root would shadow it and break the client half's boot.
 */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-sidebar/api'

/** The cordis services this host half consumes. */
export const inject = ['webServer', 'sessions']

/**
 * Register the fenced host routes.
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
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      if (!passesFence(req)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'request failed the loopback trust fence' } }))
        return
      }
      const url = new URL(req.url ?? '/', `http://${typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1'}`)
      const gitPrefix = `${ROUTE_PREFIX}/git`
      if (url.pathname === gitPrefix || url.pathname.startsWith(`${gitPrefix}/`)) {
        void handleGitRequest(req, res, url, gitScope)
        return
      }
      void handleFsRequest(req, res, url)
    },
  })
  ctx.effect(() => dispose, 'plugin-sidebar: dispose fs routes')
}
