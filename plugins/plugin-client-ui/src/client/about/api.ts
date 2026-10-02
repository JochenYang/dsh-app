/**
 * The 「关于 DSH-APP」 page's view of plugin-brand's host routes.
 *
 * Same seam as the diagnostics page (`./api.ts`), and the same two hops: the
 * host route confirms this environment HAS a shell action route (answering
 * `unsupported` when it does not), then the page calls that route directly —
 * which is the only place the action can be performed from, because the route
 * lives on the app's own origin and the kernel child cannot resolve a custom
 * scheme.
 *
 * Why this is its own module rather than an addition to the diagnostics one:
 * that page's job is "help me report a problem" and this page's is "tell me what
 * I am running". They share the transport helpers by importing them, not by
 * growing one file that answers two questions.
 *
 * @module @dsh-app/plugin-client-ui/client/about/api
 */

import { callShellAction, delegateAction } from '../diagnostics/api.ts'
import type { RouteOutcome, ShellActionAnswer } from '../diagnostics/api.ts'

/**
 * What the shell reports about this installation.
 *
 * An explicit allowlist on the host side too (see `src/main/shell-actions.ts`
 * `AboutInfo`): versions and paths only, nothing enumerated from the
 * environment.
 */
export interface AboutInfo extends ShellActionAnswer {
  readonly info?: {
    readonly shellVersion?: string
    readonly kernelVersion?: string
    readonly kernelChannel?: string
    readonly dshHome?: string
    readonly logDir?: string
    readonly electronVersion?: string
    readonly nodeVersion?: string
    readonly platform?: string
    readonly updateSupported?: boolean
  }
}

/** The three shell-performed gestures this page offers, named as the tray names them. */
export type AboutAction = 'check-app-update' | 'check-kernel-update' | 'restart-server'

/**
 * Read the versions and paths the page renders.
 *
 * Two hops, like every shell-performed read: the host hands back the shell's
 * coordinates, then the page calls them.
 *
 * @returns the facts, or why they are unavailable.
 */
export async function fetchAboutInfo(): Promise<RouteOutcome<AboutInfo>> {
  const delegate = await delegateAction('/desktop/about-info', {})
  if (delegate.kind !== 'ok') return delegate
  return callShellAction<AboutInfo>(delegate.url, {})
}

/**
 * Start one of the tray's gestures from inside the window.
 *
 * The shell answers as soon as the action is STARTED, never when it finishes: an
 * app-update check downloads a large installer and raises its own dialogs, so
 * the request would otherwise stay open for minutes and this page would look
 * hung.
 *
 * @param action - which gesture to start.
 * @returns the shell's acknowledgement, or why it could not start.
 */
export async function startAboutAction(action: AboutAction): Promise<RouteOutcome<ShellActionAnswer>> {
  const delegate = await delegateAction(`/desktop/${action}`, {})
  if (delegate.kind !== 'ok') return delegate
  return callShellAction<ShellActionAnswer>(delegate.url, {})
}
