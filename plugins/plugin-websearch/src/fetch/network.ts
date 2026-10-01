/**
 * The URL and address policy for the fetch provider — the pure, network-free
 * half. These functions are the contract the upstream `http` provider
 * documents (same code strings, same caps) so a fetch answered by this plugin
 * is indistinguishable from one answered by the host: the model-facing tool
 * sees the same error taxonomy either way.
 *
 * Kept free of network side effects so the tests can exercise the policy
 * directly; `node:net` is the only builtin it touches.
 *
 * @module @dsh-app/plugin-websearch/fetch/network
 */

import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** Maximum accepted request URL length. */
export const MAX_URL_LENGTH = 2048

/** Same-origin redirect hops followed before the fetch is refused. */
export const MAX_REDIRECTS = 5

/** Response byte budget: a declared Content-Length above this is refused. */
export const MAX_RESPONSE_BYTES = 5_000_000

/** Decoded character budget above which the body is flagged truncated. */
export const MAX_BODY_CHARS = 100_000

/** Whole-fetch deadline (redirects included), matching the host's budget. */
export const FETCH_TIMEOUT_MS = 30_000

/** Request headers, mirroring the host provider's anonymous-fetch shape. */
export const FETCH_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'
export const FETCH_ACCEPT = 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8'

/**
 * Whether an address is globally reachable unicast — the SSRF bar.
 *
 * This is the host provider's own predicate, reproduced with the library it
 * uses (`ipaddr.js`, same version): IPv4 and IPv4-mapped IPv6 are judged by
 * the embedded address's range, everything else by its own range. A hand
 * written prefix table cannot do this — `::ffff:7f00:1` is loopback, `2002:`
 * is 6to4, `64:ff9b::` is NAT64 and `192.0.2.0/24` is reserved, and a
 * checker that only knows well-known prefixes lets all of them through.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns true only for a global unicast destination.
 */
export function isPublicAddress(input: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(input)
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/** WHATWG URL keeps IPv6 hostnames bracketed; the address checks do not. */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Whether a URL hostname is an IP literal the policy would refuse anyway. */
export function isNonPublicIpLiteral(hostname: string): boolean {
  const unbracketed = stripIpv6Brackets(hostname)
  return isIP(unbracketed) !== 0 && !isPublicAddress(unbracketed)
}

/**
 * The literal-host fast path: an IP in the URL is its own answer set (the
 * host provider skips resolution for these and validates the literal
 * itself).
 */
export function literalHostAddresses(url: URL): readonly string[] | null {
  const hostname = stripIpv6Brackets(url.hostname)
  return isIP(hostname) !== 0 ? [hostname] : null
}

/** Parse a request URL and enforce the scheme/credential restrictions. */
export function parseFetchUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/** The full pre-network URL policy: length bound plus {@link parseFetchUrl}. */
export function validateFetchUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  return parseFetchUrl(input)
}

/** Same-origin means scheme, hostname and port all match. */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/** Whether a status code asks the client to follow a redirect. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Classify a Content-Type into a decodable body kind, or undefined to refuse. */
export function classifyContentType(contentType: string | null): 'html' | 'text' | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/** Extract the lower-cased charset label from a Content-Type, when declared. */
export function parseCharset(contentType: string | null): string | undefined {
  return /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim().toLowerCase()
}

/** Build a decoder for the declared charset (UTF-8 when none is declared). */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}
