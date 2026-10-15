/**
 * Entering a directory as a workspace — the container's half of the session-mode
 * contract.
 *
 * A session-bound domain workbench needs the same three moves every time: turn a
 * directory into a registered workspace, open it so the frame returns to the
 * Conversation, and say something useful when either step fails. Those moves are
 * NOT the same as "call two services": they carry the discipline this repository
 * already paid for once in `plugin-client-ui/client/workspace-launch.ts`, and a
 * second copy of it would drift:
 *
 * - the services are resolved PER CALL, never captured when the plugin applies.
 *   Measured on this kernel line: `ctx.get(name)` answers `undefined` during
 *   apply and only comes up when a page renders;
 * - the faces are read STRUCTURALLY, because a namespace service is a cordis
 *   seam rather than a module — this plugin depends on neither workspace package;
 * - a missing or reshaped service answers `pending` rather than throwing, and
 *   every rejection is turned into a stable CODE, so a card never has to catch.
 *   That last point is what keeps a rejected promise out of a `onClick` handler,
 *   where it would surface as an unhandled rejection and no copy at all.
 *
 * The TOKEN, not a sentence, is the result: the container owns the dictionary and
 * the card decides where the words go, so the two never both hold the text.
 *
 * @module @dsh-app/plugin-workbench/client/entry
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/**
 * How one entry attempt ended. A value, never a rejection — a card that renders
 * `entryMessage(status)` has nothing left to catch.
 */
export type WorkbenchEntryStatus = 'ok' | 'pending' | `error:${string}`

/**
 * The statuses that carry copy.
 *
 * `ok` is deliberately not one of them: a successful entry opens the workspace,
 * the frame returns to the Conversation, and this page unmounts — a card that
 * rendered a success message would be racing its own teardown.
 */
export type WorkbenchEntryProblem = Exclude<WorkbenchEntryStatus, 'ok'>

/** Structural face of the workspace controller service used here. */
interface WorkspaceCreation {
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

/** Structural face of the workspace navigation service used here. */
interface WorkspaceNavigation {
  openWorkspace(workspaceId: string): Promise<void>
}

/** The two calls one entry makes, resolved once per invocation. */
interface EntrySeam {
  readonly create: (dir: string) => Promise<{ workspaceId: string }>
  readonly open: (workspaceId: string) => Promise<void>
}

/** Enter a directory as a workspace, answering a status token. */
export type WorkspaceEntry = (path: string) => Promise<WorkbenchEntryStatus>

/**
 * Resolve the workspace services at call time.
 *
 * `ctx.get` answers undefined for a service this kernel does not provide, so a
 * kernel without them degrades to `pending` instead of throwing. Each face is
 * read structurally and checked by function before use, so a changed seam
 * answers `pending` rather than calling into something that is not there.
 *
 * @param ctx - the client root context.
 * @returns the seam, or null while (or if) the services are unavailable.
 */
function seamOf(ctx: ClientContext): EntrySeam | null {
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
 * The host's stable failure code, in either shape a Remote call can reject with:
 * a `RemoteError` carries `code` directly, while the client service wraps one in
 * a `WorkspaceCreateError` (its `rpcError` field).
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
 * Build the entry action the container hands every card.
 *
 * @param ctx - the client root context.
 * @returns an action that never rejects.
 */
export function createWorkspaceEntry(ctx: ClientContext): WorkspaceEntry {
  return async (path) => {
    // A card that has no directory yet is a contract violation, not a
    // user-facing case — the same reading the shell's launch seam takes.
    if (typeof path !== 'string' || path === '') return 'error:invalid-argument'
    const seam = seamOf(ctx)
    if (seam === null) return 'pending'
    try {
      const workspace = await seam.create(path)
      await seam.open(workspace.workspaceId)
      return 'ok'
    } catch (error) {
      return `error:${failureCodeOf(error)}`
    }
  }
}
