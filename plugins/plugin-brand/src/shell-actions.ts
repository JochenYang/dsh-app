/**
 * The kernel side of the shell's desktop action seam.
 *
 * The shell performs native actions the kernel has no seam for — reveal the log
 * directory, raise a system notification, save a text file where the user points
 * a native dialog, and install/observe the on-demand office payload — and it
 * PUBLISHES the base URL of its route as {@link SHELL_ACTIONS_ENV} when it
 * serves one (`src/main/shell-actions.ts` in the app).
 *
 * This process cannot call that route itself: it lives on the `dsh-app` scheme,
 * which only Electron's own network stack resolves — a child Node process has no
 * such scheme, and a fetch for it fails with an unsupported-scheme error. The
 * CALL therefore travels from the page, which is already in that origin; what
 * these routes own is the other half of the contract: whether the seam exists at
 * all, and the exact coordinates the client must use.
 *
 * Two rules shape this module:
 *
 *   1. Read the environment on EVERY call. A restarted shell re-publishes the
 *      URL, so a value cached at module load would pin a dead endpoint — and the
 *      answer to "are desktop actions available" would be stale too.
 *   2. Trust the value only if it names the app's own origin. The base URL
 *      decides where the PAGE sends the user's text, so an environment that
 *      points somewhere else (a hacked shell, a stray variable) must yield
 *      "unavailable" rather than a send.
 *
 * A missing environment is not a failure: a bare `dsh` run or a shell without
 * this seam simply has no desktop actions, which the routes report as
 * `unsupported`.
 *
 * @module @dsh-app/plugin-brand/shell-actions
 */

/** Published by the shell: base URL of its action route (`dsh-app://app/…/action`). */
export const SHELL_ACTIONS_ENV = 'DSH_APP_SHELL_ACTIONS'

/** Scheme and host of the app's own origin — the only place a call may go. */
const APP_SCHEME = 'dsh-app:'
const APP_HOST = 'app'

/**
 * The actions the shell's route performs.
 *
 * A MIRROR of `src/main/shell-actions.ts` (`SHELL_ACTIONS`), which is the
 * authority: this process cannot import the shell's module, so the list is
 * spelled twice and the two have to move together. The shell's own test suite
 * asserts the shape of the route; this type only decides what the plugin is
 * willing to forward.
 */
export type ShellAction =
  | 'notify'
  | 'save-text-as'
  | 'open-logs'
  | 'office-payload-state'
  | 'office-payload-download'
  | 'office-payload-cancel'
  | 'config-check'

/** Read one environment variable, tolerating an unset value. */
function envValue(name: string): string {
  return process.env[name] ?? ''
}

/**
 * Whether a published value names the app's own origin.
 *
 * Scheme and host are compared rather than `URL.origin`: Node resolves a
 * non-special scheme's origin to the opaque string `null`, so an origin
 * comparison would refuse a perfectly good value here.
 *
 * @param value - the published base URL.
 */
function isAppOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === APP_SCHEME && url.hostname === APP_HOST
  } catch {
    return false
  }
}

/**
 * Base URL of the shell's action route, without a trailing slash.
 * @returns the URL, or '' when this environment has no such seam.
 */
export function shellActionsBase(): string {
  const value = envValue(SHELL_ACTIONS_ENV).replace(/\/+$/u, '')
  return value !== '' && isAppOrigin(value) ? value : ''
}

/**
 * Whether this environment can perform a desktop action at all.
 * @returns true when the shell published a usable action base.
 */
export function shellActionsAvailable(): boolean {
  return shellActionsBase() !== ''
}

/**
 * The exact URL the client must call for one action. Only meaningful when
 * {@link shellActionsAvailable} is true; the routes check that first.
 *
 * @param action - the action to address.
 * @returns the absolute URL of that action.
 */
export function shellActionUrl(action: ShellAction): string {
  return `${shellActionsBase()}/${action}`
}
