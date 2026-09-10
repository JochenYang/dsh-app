/**
 * Browser-trust fence for the sidebar dock's host routes.
 *
 * The fence is behavioral parity with the /api gateway's fence in
 * @deepseek-ai/dsh-client-connection: a request passes when its Host header
 * names a loopback authority — the dsh web server binds 127.0.0.1, so any
 * legitimately-served browser request carries a loopback Host, while a
 * cross-site or DNS-rebinding attacker's request carries the attacker's own
 * Host. It is a rebinding/cross-site defense, NOT authentication.
 *
 * The fence deliberately reads ONLY the Host header. Origin is never
 * consulted: browsers may omit the port from Origin on loopback origins,
 * and mis-keying on Origin is a known way to 403 every legitimate
 * 127.0.0.1 request (the local-address regression this plugin must avoid).
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
