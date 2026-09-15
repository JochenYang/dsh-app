/**
 * Browser-trust fence for the brand plugin's host routes.
 *
 * These routes make the SHELL do something native (reveal a folder, notify,
 * open a save/pick dialog), so every one of them runs both halves of the fence
 * the suite already uses rather than a new variant:
 *
 *   - {@link passesFence} is copied from plugin-sidebar's trust-fence.ts: the
 *     dsh web server binds 127.0.0.1, so a legitimately-served browser request
 *     carries a loopback Host while a cross-site or DNS-rebinding attacker's
 *     request carries the attacker's own Host.
 *   - {@link sameOrigin} is copied from plugin-hooks' routes.ts: a request that
 *     carries an Origin header must name the authority it was sent to. The
 *     app's own page (the dsh UI in the Electron window, fetched over loopback)
 *     sends exactly that on a same-origin POST; a hostile page sends its own
 *     origin, which never matches this machine's Host. Rejecting Origin
 *     outright would 403 the app's own settings page.
 *
 * The pair is a rebinding/cross-site defense, NOT authentication: any local
 * process can forge both headers. Authentication lives on the other hop — the
 * kernel-to-shell bearer token in bridge-client.ts — and never reaches here.
 */

import type { IncomingHttpHeaders } from 'node:http'

/** Structural header subset the fence reads. */
export interface FenceRequestHeaders {
  headers: IncomingHttpHeaders
}

/**
 * Whether one request's Host header names a loopback authority.
 * @param request - the structural request (headers only).
 * @returns true when the Host is loopback (127.0.0.1, localhost, ::1, with
 * or without a port); false for anything else or no Host at all.
 */
export function passesFence(request: FenceRequestHeaders): boolean {
  const raw = request.headers.host
  if (typeof raw !== 'string' || raw === '') return false
  let hostname: string
  try {
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  // 127.0.0.0/8 in full: rebinding into 127.0.0.2 still names the machine.
  // Each octet is validated (a bare \d{1,3} pattern would admit
  // 127.999.999.999, which names no local interface).
  const octets = hostname.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

/**
 * Whether an optional Origin header names the authority the request was sent
 * to (the `Host` header). An absent Origin passes: non-browser callers such as
 * the app's own host-side code send none.
 * @param request - the structural request (headers only).
 * @returns true when Origin is absent or its host equals the request Host.
 */
export function sameOrigin(request: FenceRequestHeaders): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * Both halves at once — the check every route runs first.
 * @param request - the structural request (headers only).
 */
export function passesTrustFence(request: FenceRequestHeaders): boolean {
  return passesFence(request) && sameOrigin(request)
}
