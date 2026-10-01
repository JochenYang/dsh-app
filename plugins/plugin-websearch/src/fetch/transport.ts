/**
 * The fetch transport: one GET hop, sent either through the process's proxy
 * dispatcher (when a proxy route applies) or pinned to a validated address
 * set over `node:http`/`node:https`.
 *
 * Why pinning instead of a plain `fetch`: the host's provider validates one
 * DNS answer set and pins the connection to it, so a second resolution
 * between the check and the connect cannot swap in a private address. This
 * transport keeps that property, and it is also what makes the DoH path
 * work — the validated set is the DoH answer, not the poisoned system one.
 *
 * @module @dsh-app/plugin-websearch/fetch/transport
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import type { LookupOptions } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { lookup } from 'node:dns/promises'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  FETCH_ACCEPT,
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENT,
  isNonPublicIpLiteral,
  isPublicAddress,
} from './network.ts'

/** The marker reason the deadline timer aborts with. */
const TIMEOUT_MARKER = Symbol('fetch-timeout')

/** One response hop, normalized across the two send paths. */
export interface FetchHop {
  readonly statusCode: number
  header(name: string): string | null
  /** The body as bytes; empty when the response carries none. */
  body(): AsyncIterable<Uint8Array>
  close(): Promise<void>
}

/** The send seam: perform one GET against one validated URL. */
export type HopSend = (
  url: URL,
  addresses: readonly string[],
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<FetchHop>

/** Whole-request cancellation plus a timeout, as one signal. */
export interface Deadline {
  readonly signal: AbortSignal
  /** Whether the deadline (not the caller) is what aborted the request. */
  expired(): boolean
  dispose(): void
}

/**
 * Compose the caller's signal with a timeout into one signal.
 *
 * @param signal - the caller's cancellation signal, when it has one.
 * @param timeoutMs - the whole-fetch budget.
 */
export function startDeadline(signal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort(TIMEOUT_MARKER)
  }, timeoutMs)
  const onAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * The environment names each proxy slot owns, lowercase first — undici reads
 * the lowercase name first, so both casings are always considered together
 * (this mirrors the kernel's own policy resolver).
 */
const PROXY_ENV_NAMES = {
  'http:': ['http_proxy', 'HTTP_PROXY'],
  'https:': ['https_proxy', 'HTTPS_PROXY'],
} as const

/** The `ALL_PROXY` fallback slot, resolved but never a scheme's own answer. */
const ALL_PROXY_NAMES = ['all_proxy', 'ALL_PROXY'] as const

/** The no-proxy slot names, lowercase first. */
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY'] as const

/** Proxy URL schemes this transport routes through; anything else means direct. */
const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:'])

/** Read one slot in undici's precedence order, treating blank as unset. */
function readEnv(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = (env[name] ?? '').trim()
    if (value !== '') return value
  }
  return undefined
}

/**
 * Whether a candidate proxy URL is one this transport can use. A malformed
 * URL or an unsupported scheme (a SOCKS proxy, say) is rejected — and a
 * rejected slot means DIRECT for that scheme, never a silent fallthrough to
 * the fallback, so the diagnostic and the route cannot disagree.
 */
function acceptedProxyUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = new URL(value)
    return SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The proxy URL one scheme resolves to, or undefined for a direct connection.
 *
 * A scheme's own variable wins, then `ALL_PROXY`, then — for HTTPS only — the
 * HTTP proxy, matching undici so this decision and the installed dispatcher
 * never disagree about one URL.
 */
function proxyUrlFor(env: Readonly<Record<string, string | undefined>>, protocol: 'http:' | 'https:'): string | undefined {
  const all = acceptedProxyUrl(readEnv(env, ALL_PROXY_NAMES))
  const raw = readEnv(env, PROXY_ENV_NAMES[protocol])
  const own = acceptedProxyUrl(raw)
  // A malformed own slot is a rejection, not an absence: the kernel's resolver
  // keeps that scheme direct instead of adopting ALL_PROXY behind the user's
  // back, and so does this one.
  if (raw !== undefined && own === undefined) return undefined
  if (own !== undefined) return own
  if (protocol === 'https:') return all ?? acceptedProxyUrl(readEnv(env, PROXY_ENV_NAMES['http:']))
  return all
}

/** Every proxy-carrying variable, for the coarse "is a proxy configured" answer. */
const ALL_PROXY_VARS = [...PROXY_ENV_NAMES['http:'], ...PROXY_ENV_NAMES['https:'], ...ALL_PROXY_NAMES]

/**
 * Whether a hostname names this machine BY NAME. The IP spellings (loopback,
 * the IPv4-mapped forms, `0.0.0.0`) are judged by the address policy instead —
 * `isNonPublicIpLiteral` — so this only has to cover the name form. A proxy
 * must never be handed either: it resolves in its own network, so a proxy on
 * this machine would reach a service that only listens on loopback — which is
 * how the harness's own Web UI and test servers become a routing loop.
 */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost')
}

/**
 * NO_PROXY matching: a list split on commas and whitespace; an entry matches
 * by equality or dot-suffix (`api.tavily.com` matches `tavily.com`, not
 * `avily.com`), a leading `.` or `*.` is the same thing, an entry may carry a
 * `:port` that must match, `*` exempts everything, and matching is
 * case-insensitive. CIDR is deliberately not matched — the kernel does not
 * either (an OS bypass list carrying `10.0.0.0/8` must be rewritten as
 * suffixes).
 */
export function matchesNoProxy(host: string, noProxy: string | undefined, port?: string): boolean {
  const raw = (noProxy ?? '').trim()
  if (raw.length === 0) return false
  const target = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return raw.split(/[,\s]+/).some(entryRaw => {
    const entry = entryRaw.trim().toLowerCase()
    if (entry.length === 0) return false
    if (entry === '*') return true
    const colon = entry.indexOf(':')
    let candidate = entry
    if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
      const entryPort = entry.slice(colon + 1)
      if (port !== undefined && entryPort !== port) return false
      candidate = entry.slice(0, colon)
    }
    candidate = candidate.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate.length === 0) return false
    return target === candidate || target.endsWith(`.${candidate}`)
  })
}

/** Whether a usable proxy is configured for either scheme. */
export function proxyEnvActive(env: Readonly<Record<string, string | undefined>>): boolean {
  return proxyUrlFor(env, 'https:') !== undefined || proxyUrlFor(env, 'http:') !== undefined
}

/**
 * Route one URL: through the process's proxy dispatcher, or direct.
 *
 * The dispatcher is the one the kernel installed at boot (this app's shell
 * injects the proxy into the child's environment), so a proxied hop needs no
 * local resolution at all — which is exactly why a proxied fetch never hits
 * the fake-IP problem in the first place.
 *
 * Four conditions send a fetch direct: no usable proxy resolved for the
 * scheme, a loopback destination (by name or by address), or an exempting
 * NO_PROXY entry. The non-public IP literal case also goes direct — a proxy
 * resolves the address in its own network, so handing it `10.0.0.5` would
 * reach a service the address policy exists to keep out of reach; the direct
 * path then refuses it with the policy's own error instead.
 */
export function proxyRouteFor(url: URL, env: Readonly<Record<string, string | undefined>>): 'proxy' | 'direct' {
  const protocol = url.protocol === 'https:' ? 'https:' : 'http:'
  if (proxyUrlFor(env, protocol) === undefined) return 'direct'
  if (isLocalHostname(url.hostname) || isNonPublicIpLiteral(url.hostname)) return 'direct'
  const port = url.port !== '' ? url.port : protocol === 'https:' ? '443' : '80'
  const exempt = NO_PROXY_NAMES.some(name => matchesNoProxy(url.hostname, env[name], port))
  return exempt ? 'direct' : 'proxy'
}

/**
 * Resolve one hostname through the untouched system resolver (the same call
 * the host provider makes). The result is a raw answer set — the caller
 * validates it.
 */
export async function systemResolve(hostname: string): Promise<readonly string[]> {
  const resolved = await lookup(hostname, { all: true, order: 'verbatim' })
  return resolved.map(entry => entry.address)
}

/** The address family of a textual IP address. */
function familyOf(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4
}

/**
 * Build the `lookup` callback that serves one fixed, already-validated answer
 * set — the pin. `node:http`/`node:https` hand this to `net.connect`, which
 * keeps the hostname for Host and TLS SNI while connecting to the pinned
 * address. Both callback shapes are handled: the all-form (happy-eyeballs)
 * and the single-address form, and both family spellings (`4` and `'IPv4'`).
 */
export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  return ((hostname: string, options: LookupOptions, callback: (err: Error | null, address: unknown, family?: unknown) => void) => {
    const wanted = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family ?? 0)
    const eligible = wanted === 0 ? addresses : addresses.filter(address => familyOf(address) === wanted)
    if (eligible.length === 0) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${String(options.family ?? 0)}`), {
        code: 'ENOTFOUND',
        hostname,
      })
      if (options.all === true) callback(error, [])
      else callback(error, '', wanted)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(address => ({ address, family: familyOf(address) })))
      return
    }
    callback(null, eligible[0], familyOf(eligible[0]))
  }) as LookupFunction
}

/** Wrap a global-`fetch` response (the proxied path) as one hop. */
function wrapFetchHop(response: Response): FetchHop {
  return {
    statusCode: response.status,
    header: (name: string) => response.headers.get(name),
    body: async function* () {
      const reader = response.body?.getReader()
      if (reader === undefined) return
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done === true) return
          if (value !== undefined) yield value
        }
      } finally {
        reader.releaseLock()
      }
    },
    close: async () => {
      await response.body?.cancel().catch(() => undefined)
    },
  }
}

/**
 * One GET hop over `node:http`/`node:https`, connected to the pinned address
 * set. Redirects are NOT followed by the stack — the provider's loop handles
 * them so every hop is validated.
 */
function sendPinned(url: URL, addresses: readonly string[], headers: Record<string, string>, signal: AbortSignal): Promise<FetchHop> {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<FetchHop>((resolve, reject) => {
    const request = transport({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
      lookup: createPinnedLookup(addresses),
      signal,
    }, (response: IncomingMessage) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        header: (name: string) => response.headers[name.toLowerCase()] as string | null | undefined ?? null,
        body: () => response,
        close: async () => {
          response.destroy()
        },
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * The production send: the proxied path rides the process dispatcher (no
 * local resolution, nothing to pin), the direct path pins the validated
 * address set. A proxied hop still refuses a non-public IP literal: the
 * literal is the destination itself, and a local proxy would reach exactly
 * the loopback or private service the checks exist to keep out of reach.
 */
export function createSendHop(env: Readonly<Record<string, string | undefined>>): HopSend {
  return async (url, addresses, headers, signal) => {
    if (proxyRouteFor(url, env) === 'proxy') {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal })
      return wrapFetchHop(response)
    }
    return await sendPinned(url, addresses, headers, signal)
  }
}

/** The default request headers — anonymous, no cookies, no credentials. */
export function fetchHeaders(): Record<string, string> {
  return { 'user-agent': FETCH_USER_AGENT, accept: FETCH_ACCEPT }
}

/**
 * Translate a transport failure into the fetch error taxonomy: a deadline
 * expiry is a timeout, a caller abort is an abort, anything else is a
 * provider failure with the original error preserved as the cause.
 */
export function translateTransportError(error: unknown, deadline: Deadline): WebError {
  if (deadline.expired()) return new WebError(`web fetch timed out after ${FETCH_TIMEOUT_MS} ms`, 'WEB_FETCH_TIMEOUT', { cause: error })
  if (error instanceof Error && (error.name === 'AbortError' || deadline.signal.aborted)) {
    return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new WebError(`web fetch failed: ${message}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/** Validate one resolved answer set, refusing the whole set on any non-public hop. */
export function validateAddresses(hostname: string, addresses: readonly string[]): void {
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
  }
}
