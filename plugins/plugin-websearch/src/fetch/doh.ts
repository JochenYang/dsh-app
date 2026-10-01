/**
 * The DNS-over-HTTPS answer source for the fetch provider (ADR-0022's layer,
 * narrowed to what web_fetch needs).
 *
 * Why this exists: a TUN client resolves every hostname into 198.18.0.0/15.
 * The host's fetch provider validates resolved addresses and refuses that
 * range (`WEB_BLOCKED_URL`), so on such a network `web_fetch` fails before a
 * packet leaves the machine. Asking a DoH server directly returns the real
 * public address set, which passes the same validation.
 *
 * The nodes are tried in order and the first answering one wins; the JSON
 * (`application/dns-json`) form is used because all pool members serve it.
 * `node:https` is used rather than global `fetch` so the DoH leg never rides
 * the proxy dispatcher: a proxied fetch has no local resolution to repair.
 *
 * @module @dsh-app/plugin-websearch/fetch/doh
 */

import { request as httpsRequest } from 'node:https'

/** One DoH endpoint. */
export interface DohNode {
  readonly label: string
  /** The `application/dns-json` query base, without the query string. */
  readonly url: string
}

/**
 * The default pool, domestic resolvers first (this app ships Mainland-China
 * first) with overseas services behind them. Every entry serves the JSON API
 * over plain HTTPS on the standard port.
 */
export const DOH_POOL: readonly DohNode[] = [
  { label: 'AliDNS', url: 'https://dns.alidns.com/resolve' },
  { label: 'DNSPod', url: 'https://doh.pub/dns-query' },
  { label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { label: 'Google', url: 'https://dns.google/resolve' },
  { label: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
]

/** Per-node attempt budget; the whole pass is bounded by the caller's signal. */
export const DOH_NODE_TIMEOUT_MS = 2_500

/** One answer record as the JSON form returns it. */
interface DohAnswerRecord {
  readonly name?: unknown
  readonly type?: unknown
  readonly TTL?: unknown
  readonly data?: unknown
}

/** One DoH JSON response, narrowed defensively (it is network input). */
interface DohPayload {
  readonly Status?: unknown
  readonly Answer?: unknown
}

/** The record types this module reads back. */
const RECORD_A = 1
const RECORD_AAAA = 28

/** One node's outcome: a usable answer set, an empty set, or the failure. */
export type DohResult =
  | { readonly kind: 'addresses'; readonly addresses: readonly string[]; readonly ttlSeconds: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failure'; readonly reason: string }

/**
 * The transport seam: perform one GET and return the parsed JSON body.
 * Injectable so the unit suite never touches the network.
 */
export type DohSend = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>

/** Ask one node for one record set; a non-zero DNS status is a miss, not a throw. */
async function queryNode(node: DohNode, hostname: string, type: number, send: DohSend, signal?: AbortSignal): Promise<DohResult> {
  const url = `${node.url}?name=${encodeURIComponent(hostname)}&type=${type === RECORD_A ? 'A' : 'AAAA'}`
  let payload: unknown
  try {
    payload = await send(url, DOH_NODE_TIMEOUT_MS, signal)
  } catch (error) {
    return { kind: 'failure', reason: error instanceof Error ? error.message : String(error) }
  }
  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'failure', reason: 'response is not a JSON object' }
  }
  const parsed = payload as DohPayload
  if (parsed.Status !== 0) {
    return { kind: 'failure', reason: `${node.label}: DNS status ${String(parsed.Status)}` }
  }
  const answers = Array.isArray(parsed.Answer) ? (parsed.Answer as readonly DohAnswerRecord[]) : []
  const addresses: string[] = []
  let ttlSeconds: number | null = null
  for (const answer of answers) {
    if (answer.type !== type || typeof answer.data !== 'string') continue
    addresses.push(answer.data)
    if (typeof answer.TTL === 'number' && answer.TTL > 0) {
      ttlSeconds = ttlSeconds === null ? Math.floor(answer.TTL) : Math.min(ttlSeconds, Math.floor(answer.TTL))
    }
  }
  if (addresses.length === 0) return { kind: 'empty' }
  return { kind: 'addresses', addresses: [...new Set(addresses)], ttlSeconds: ttlSeconds ?? 60 }
}

/**
 * Resolve one hostname through the pool: A records first (this app's traffic
 * is overwhelmingly IPv4), then AAAA, and each record type walks the pool
 * until a node answers it. A host with no AAAA records is not a failure —
 * the A set alone is the answer, and one node's NODATA ends that record
 * type's walk rather than spending the rest of the pool on it.
 *
 * @param hostname - the host to resolve.
 * @param options - the pool and the transport seam.
 * @returns the answer set, an empty set (the host has no such record), or the
 *   last failure reason after every node missed.
 */
export async function dohResolve(hostname: string, options: {
  readonly pool?: readonly DohNode[]
  readonly send?: DohSend
  readonly signal?: AbortSignal
}): Promise<DohResult> {
  const pool = options.pool ?? DOH_POOL
  const send = options.send ?? httpsSend
  const addresses: string[] = []
  let sawNodata = false
  let lastReason = 'no DoH node answered'
  let ttlSeconds: number | null = null
  for (const type of [RECORD_A, RECORD_AAAA]) {
    for (const node of pool) {
      if (options.signal?.aborted === true) return { kind: 'failure', reason: 'aborted' }
      const result = await queryNode(node, hostname, type, send, options.signal)
      if (result.kind === 'addresses') {
        addresses.push(...result.addresses)
        ttlSeconds = ttlSeconds === null ? result.ttlSeconds : Math.min(ttlSeconds, result.ttlSeconds)
        break
      }
      if (result.kind === 'empty') {
        // Status 0 with no records of this type: the host has none. One node's
        // NODATA is enough evidence, so do not spend the rest of the pool on it.
        sawNodata = true
        break
      }
      lastReason = `${node.label}: ${result.reason}`
    }
    // An AAAA-less host is the common case: once A answered, the AAAA walk
    // costs four round trips and can only add an address the A set already
    // covers for this app's traffic. Only a host with NO A records is worth
    // the second pass.
    if (type === RECORD_A && addresses.length > 0) break
  }
  if (addresses.length > 0) return { kind: 'addresses', addresses: [...new Set(addresses)], ttlSeconds: ttlSeconds ?? 60 }
  return sawNodata ? { kind: 'empty' } : { kind: 'failure', reason: lastReason }
}

/**
 * The production transport: one plain HTTPS GET with a hard timeout, parsed
 * as JSON. A non-2xx status or unparsable body is a failure the caller's
 * fallthrough handles.
 */
async function httpsSend(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('DoH request timed out')), timeoutMs)
  const onAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = httpsRequest(url, { method: 'GET', signal: controller.signal }, response => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new Error('response is not valid JSON'))
          }
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Cache one hostname's answer set with a TTL, bounded so it cannot grow. */
export class DohCache {
  private readonly entries = new Map<string, { readonly addresses: readonly string[], readonly expiresAt: number }>()
  private readonly maxEntries: number

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries
  }

  get(hostname: string): readonly string[] | undefined {
    const entry = this.entries.get(hostname)
    if (entry === undefined) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(hostname)
      return undefined
    }
    return entry.addresses
  }

  set(hostname: string, addresses: readonly string[], ttlMs: number): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(hostname)) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(hostname, { addresses, expiresAt: Date.now() + ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }
}
