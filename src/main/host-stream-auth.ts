/**
 * Authenticate the window's own WebSocket handshake to the host.
 *
 * Why a session rewrite is needed at all: from `0.1.6-alpha.2` on, the client's
 * gateway does not stream through this shell's `dsh-app://` origin. It reads
 * `globalThis.__DSH_TRANSPORT__.streamBaseUrl` (the row this shell injects, see
 * `host-web.ts`) and opens a WebSocket STRAIGHT to the host's loopback origin.
 * That handshake is a browser request the shell never sees, so the two things it
 * needs have to be attached here:
 *
 *   - the host's session cookie, which lives in this process (the launch URL was
 *     exchanged for it in `DshHost.openWebSession`) and never entered the
 *     browser's cookie jar;
 *   - an `origin` the host accepts — the page's own is `dsh-app://app`, which a
 *     WebSocket to a loopback HTTP server would present as a foreign origin.
 *
 * Upstream's desktop app does the same thing on the same URL pattern. The fence
 * is what keeps it from being a hole: only this app's top-level window may use
 * it, and a handshake whose `origin` is not the app origin is CANCELLED rather
 * than rewritten. A host that is not ready, or a different loopback port (a
 * stray proxy, another local service), is left exactly as the browser sent it.
 */
import { APP_ORIGIN } from './desktop-host'
import type { SessionHeaderRule } from './session-hooks'

/** The host origin and cookie a handshake must carry, or undefined before ready. */
export interface HostStreamTarget {
  readonly origin: string
  readonly cookie: string
}

/** Lower-case the request headers, the way the fence compares them. */
function lowercased(headers: Record<string, string>): Record<string, string> {
  const lowered: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value
  return lowered
}

/**
 * Rewrite this window's handshakes to the host, and refuse anyone else's.
 *
 * Installed once per app run: the target and the window are read per request, so
 * a kernel switch (a new host, a new port, a new cookie) needs no reinstall.
 *
 * @param session - the session the main window lives in.
 * @param target - the host's origin and cookie, undefined until a web-transport
 *   host is ready.
 * @param windowId - the main window's `webContents` id, undefined when there is
 *   no window.
 */
export function hostStreamAuthRule(
  target: () => HostStreamTarget | undefined,
  windowId: () => number | undefined,
): SessionHeaderRule {
  return {
    urls: ['ws://127.0.0.1/*'],
    handle: (details, callback) => {
      const host = target()
      const owner = windowId()
      if (host === undefined || owner === undefined || details.webContentsId !== owner) {
        callback({})
        return true
      }
      const requested = new URL(details.url)
      if (requested.host !== new URL(host.origin).host) {
        callback({})
        return true
      }
      const headers = lowercased(details.requestHeaders)
      if (headers.origin !== APP_ORIGIN) {
        callback({ cancel: true })
        return true
      }
      callback({
        requestHeaders: { ...headers, origin: host.origin, cookie: host.cookie, 'sec-fetch-site': 'same-origin' },
      })
      return true
    },
  }
}
