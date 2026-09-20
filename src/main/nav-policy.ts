/**
 * The main window's navigation predicate.
 *
 * Lives in its own module so the fence can be tested without a BrowserWindow:
 * `window.ts` wires the same function into `will-navigate` and
 * `setWindowOpenHandler`, and the tests assert the fence, not the wiring.
 *
 * The origin comparison is not sufficient on its own: the splash document the
 * shell loads at creation is a `file:` URL, and a scheme-only check would let a
 * compromised page context navigate the top-level window to ANY local file
 * (a spoofed settings page harvesting credentials). The one `file:` target
 * allowed is the splash page the shell itself resolved.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_ORIGIN } from './desktop-host'

/** The splash document, the same path `window.ts` and `startup-window.ts` load. */
export const SPLASH_PAGE = path.join(__dirname, '..', 'static', 'startup.html')

/** The splash page as the window would name it in a navigation target. */
const SPLASH_URL = pathToFileURL(SPLASH_PAGE).href

/**
 * The app origin's protocol + host, compared the way shell-actions.ts does.
 *
 * NOT `new URL(target).origin === APP_ORIGIN`: `dsh-app` is a custom scheme,
 * and a non-special scheme's WHATWG origin is the literal string "null" in
 * every JavaScript realm — including Electron's main process, scheme
 * registration notwithstanding. The origin comparison this module was first
 * written with (and which the window had before) is therefore always false,
 * which refuses every app-internal navigation instead of allowing exactly the
 * app origin. Protocol + hostname is the comparison that works for a
 * registered custom scheme.
 */
const APP_PROTOCOL = `${APP_ORIGIN.split('://')[0]}:`
const APP_HOST = APP_ORIGIN.split('://')[1] ?? ''

function isAppOrigin(target: string): boolean {
  try {
    const url = new URL(target)
    // The port is part of the comparison: `dsh-app://app:80/…` is a DIFFERENT
    // origin to the renderer (a standard scheme keeps its port), so letting it
    // through would admit a URL the fence's own comment calls impossible.
    return url.protocol === APP_PROTOCOL && url.hostname === APP_HOST && url.port === ''
  } catch {
    return false
  }
}

/**
 * Whether a navigation target is one the shell performs on its own window.
 *
 * @param target - the URL a navigation (or `window.open`) asks for.
 * @returns true for the app origin and the shell's own splash document;
 *   everything else — including any other `file:` URL — is refused.
 */
export function isShellNavigationTarget(target: string): boolean {
  if (isAppOrigin(target)) return true
  try {
    return new URL(target).href === SPLASH_URL
  } catch {
    return false
  }
}
