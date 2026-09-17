/**
 * The two desktop actions the KERNEL can already perform, so the brand routes
 * serve them from a kernel seam rather than delegating them to the shell
 * (`shell-actions.ts` covers the three the shell alone can do).
 *
 * An action naming a native gesture has to find the seam that owns it:
 *
 *   - reveal a path → `ctx.sessionController.openWorkspacePath({ path, action:
 *     'reveal' })`, which spawns Explorer / Finder / the Linux file manager
 *     through `dsh-native-command`. The same service answers whether this host
 *     has a desktop at all (`canOpenWorkspacePath`), which is what turns "no
 *     desktop here" into a stable `unsupported` instead of a failed spawn.
 *   - pick a directory → `ctx.directoryPicker`, a capability seam whose `native`
 *     backend opens one OS chooser on the host's display. A composition carrying
 *     only the `browse` backend (a remote deployment) answers `unsupported`: the
 *     in-app browser is the client's own surface, not something this route can
 *     improvise.
 *
 * Both seams are resolved BY NAME per call through {@link NativeSeams}, so this
 * module imports no framework types and stays testable with fakes. Resolution is
 * a lookup, never `inject`: the routes hang off the Connection transport alone,
 * so a composition without a picker degrades one action instead of keeping the
 * whole plugin from activating.
 *
 * @module @dsh-app/plugin-brand/native-actions
 */

import type { HostText } from './host-text.js'

/**
 * The kernel's session controller, as far as this module reads it
 * (`ctx.sessionController` in `@deepseek-ai/dsh-api-session-controller`).
 */
export interface SessionOpener {
  /** Whether this host can hand a path to a native opener at all. */
  canOpenWorkspacePath(): boolean
  /**
   * Open or reveal one path on the host's display.
   * @param request - the path, and `reveal` to select it in its file manager.
   * @param signal - caller lifetime; abort terminates the native command.
   */
  openWorkspacePath(
    request: { readonly path: string; readonly action?: 'reveal' },
    signal: AbortSignal,
  ): Promise<{ readonly opened: boolean }>
}

/** One directory-picker backend's interaction shape, read structurally. */
export interface DirectoryPickerCapability {
  /** `native` opens an OS chooser; other kinds are served by their own client. */
  readonly kind: string
  /** Present on the `native` capability only. */
  pick?(signal: AbortSignal): Promise<string | null>
}

/** The kernel's directory picker (`ctx.directoryPicker`). */
export interface DirectoryPicker {
  capability(): DirectoryPickerCapability
}

/**
 * Where the kernel seams come from. A function per seam, resolved per request:
 * the services can appear (or disappear) with a plugin reload, and the shell
 * re-injects its own environment on every start, so nothing here is cached.
 */
export interface NativeSeams {
  opener(): SessionOpener | undefined
  picker(): DirectoryPicker | undefined
}

/**
 * Deadline for the action that answers immediately. A host that accepted the
 * call and stopped answering must not pin a route forever.
 */
export const NATIVE_TIMEOUT_MS = 30_000

/**
 * Deadline for the action that blocks on a HUMAN: the OS chooser stays open
 * while the user reads the file system.
 */
export const NATIVE_DIALOG_TIMEOUT_MS = 4 * 60_000

/** Longest downstream message a caller is shown. */
const MAX_MESSAGE_CHARS = 300

/**
 * Outcome of one kernel-seam action, shaped like the delegated routes' own so
 * the route layer maps both through one switch.
 */
export type NativeOutcome =
  | { readonly kind: 'ok'; readonly payload: Record<string, unknown> }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly host: HostText }

/**
 * Reveal one path in the host's file manager.
 * @param seams - where the kernel seams are resolved from.
 * @param path - an already-validated absolute or host-resolvable path.
 * @returns the outcome; never throws.
 */
export async function revealInFileManager(seams: NativeSeams, path: string): Promise<NativeOutcome> {
  const opener = seams.opener()
  if (opener === undefined || typeof opener.canOpenWorkspacePath !== 'function') return { kind: 'unsupported' }
  if (!opener.canOpenWorkspacePath()) return { kind: 'unsupported' }
  try {
    // `reveal`, not a plain open: the action selects the path in its folder,
    // which is what the caller's gesture means. A plain open would hand a
    // directory to its default application instead.
    await opener.openWorkspacePath({ path, action: 'reveal' }, AbortSignal.timeout(NATIVE_TIMEOUT_MS))
    return { kind: 'ok', payload: {} }
  } catch (error) {
    return { kind: 'failed', host: failureHost(error, NATIVE_TIMEOUT_MS) }
  }
}

/**
 * Ask the operator for one directory through the host's OS chooser.
 * @param seams - where the kernel seams are resolved from.
 * @returns `path: null` when the operator cancelled — a success, not a failure.
 */
export async function pickDirectory(seams: NativeSeams): Promise<NativeOutcome> {
  const capability = seams.picker()?.capability()
  if (capability === undefined || capability.kind !== 'native') return { kind: 'unsupported' }
  const pick = capability.pick
  if (typeof pick !== 'function') return { kind: 'unsupported' }
  try {
    const path = await pick.call(capability, AbortSignal.timeout(NATIVE_DIALOG_TIMEOUT_MS))
    return { kind: 'ok', payload: { path } }
  } catch (error) {
    return { kind: 'failed', host: failureHost(error, NATIVE_DIALOG_TIMEOUT_MS) }
  }
}

/**
 * The coded message for an action that did not complete. Only the timeout is
 * distinguished: the fail-soft contract the client renders is "the action
 * failed", and the native layer's own sentence is the actionable detail.
 */
function failureHost(error: unknown, budgetMs: number): HostText {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      code: 'native.timeout',
      params: { seconds: Math.round(budgetMs / 1000) },
      text: `the native action did not finish within ${String(Math.round(budgetMs / 1000))} s`,
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  const capped = detail.length > MAX_MESSAGE_CHARS ? `${detail.slice(0, MAX_MESSAGE_CHARS)}…` : detail
  return {
    code: 'native.failed',
    params: { detail: capped },
    text: `the native action failed: ${capped}`,
  }
}
