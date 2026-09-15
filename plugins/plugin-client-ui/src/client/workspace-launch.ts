/**
 * Launch-folder seam (desktop shell → page).
 *
 * The desktop shell can be started with a directory — `dsh-app.exe
 * D:\projects\app`, a folder dropped onto the app icon, an "open with" — and
 * the folder should come up as a dsh workspace. The shell cannot register one
 * itself: workspaces are this client's, and the renderer has no preload and no
 * IPC with the shell. So the shell calls ONE global function through
 * `executeJavaScript` (its only sanctioned seam) and this module owns it.
 *
 * The handler answers with a STATUS TOKEN, never a sentence. The shell is a
 * separate process that may run in another language, so copy for a refused
 * folder is the shell's to build; it maps the token. That is also why the
 * token is not a message: matching on localized text across a boundary is the
 * failure mode the kernel-side failure classifier already hit once.
 *
 * Degradation is deliberate. Nothing here throws, the global is installed as
 * soon as this plugin applies, and the services are resolved per call — a
 * kernel without the brand suite (a rollback target) never exposes the global,
 * so the shell's bounded retry gives up quietly and the app opens its normal
 * window. A second launch of the same folder reuses the blank session the
 * workspace already has, so repeated launches do not stack empty sessions.
 *
 * @module @dsh-app/plugin-client-ui/client/workspace-launch
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/**
 * The global the shell calls. Duplicated in `src/main/workspace-launch.ts`
 * (two builds, no shared module); `test/workspace-launch.test.mjs` fails if the
 * two spellings drift apart, because the drift is silent — the shell would
 * retry a handler that exists under another name and give up.
 */
export const WORKSPACE_LAUNCH_GLOBAL = '__dshAppOpenWorkspace'

/**
 * What the handler answers. `pending` = the services are not up yet, retry;
 * `ok` = the workspace is open; `error:<code>` = the host refused, carrying
 * its stable failure code.
 */
export type LaunchStatus = 'pending' | 'ok' | `error:${string}`

/** Structural face of the workspace controller service used here. */
interface WorkspaceCreation {
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

/** Structural face of the workspace navigation service used here. */
interface WorkspaceNavigation {
  openWorkspace(workspaceId: string): Promise<void>
}

/** The two calls this seam makes, resolved once per invocation. */
interface OpenSeam {
  readonly create: (dir: string) => Promise<{ workspaceId: string }>
  readonly open: (workspaceId: string) => Promise<void>
}

/**
 * Resolve the workspace services at call time.
 *
 * `ctx.get` answers undefined for a service this kernel does not provide, so
 * a vanilla kernel degrades instead of throwing. The faces are read
 * structurally — this plugin does not depend on the workspace controller
 * packages, and a namespace service is a cordis seam rather than a module —
 * and each is checked by function before use, so a changed seam answers
 * 'pending' and the shell's bounded retry gives up rather than calling into
 * something that is not there.
 *
 * @param ctx - the client root context.
 * @returns the seam, or null while (or if) the services are unavailable.
 */
function openSeamOf(ctx: ClientContext): OpenSeam | null {
  const workspaces = ctx.get('workspaces') as Partial<WorkspaceCreation> | undefined
  const navigation = ctx.get('uiWorkspace') as Partial<WorkspaceNavigation> | undefined
  const create = workspaces?.create
  const openWorkspace = navigation?.openWorkspace
  if (typeof create !== 'function' || typeof openWorkspace !== 'function') return null
  return {
    create: (dir) => create.call(workspaces, { path: dir }),
    open: (workspaceId) => openWorkspace.call(navigation, workspaceId),
  }
}

/**
 * The host's stable failure code, in either shape a Remote call can reject
 * with: a `RemoteError` carries `code` directly, while the client service
 * wraps one in `WorkspaceCreateError` (its `rpcError` field).
 *
 * @param error - the rejection value.
 * @returns the code, or 'unexpected' when there is none to report.
 */
function failureCodeOf(error: unknown): string {
  const record = (error ?? {}) as { code?: unknown; rpcError?: { code?: unknown } }
  const code = typeof record.code === 'string' ? record.code : record.rpcError?.code
  return typeof code === 'string' && code !== '' ? code : 'unexpected'
}

/**
 * Install the launch-folder handler on `window`.
 *
 * @param ctx - the client root context.
 * @returns the disposer that removes the global (an effect for the caller).
 */
export function installWorkspaceLaunch(ctx: ClientContext): () => void {
  const globals = window as unknown as Record<string, unknown>
  const previous = globals[WORKSPACE_LAUNCH_GLOBAL]
  const handler = async (dir: unknown): Promise<LaunchStatus> => {
    // The shell only ever sends an absolute path; anything else is a contract
    // violation, not a user-facing case.
    if (typeof dir !== 'string' || dir === '') return 'error:invalid-argument'
    const seam = openSeamOf(ctx)
    if (seam === null) return 'pending'
    try {
      const workspace = await seam.create(dir)
      await seam.open(workspace.workspaceId)
      return 'ok'
    } catch (error) {
      return `error:${failureCodeOf(error)}`
    }
  }
  globals[WORKSPACE_LAUNCH_GLOBAL] = handler
  return () => {
    // Only claim the slot back if it is still ours: a reload or a re-applied
    // plugin may already have installed a newer handler.
    if (globals[WORKSPACE_LAUNCH_GLOBAL] !== handler) return
    if (previous === undefined) delete globals[WORKSPACE_LAUNCH_GLOBAL]
    else globals[WORKSPACE_LAUNCH_GLOBAL] = previous
  }
}
