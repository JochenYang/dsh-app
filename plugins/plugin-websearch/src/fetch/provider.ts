/**
 * The fetch provider: `web_fetch` with the host's contract and a resolution
 * layer that survives a poisoned resolver.
 *
 * What the host's own provider cannot do on a TUN/fake-IP network: it
 * resolves through `node:dns/promises`, sees 198.18.x.x, and refuses the
 * fetch (`WEB_BLOCKED_URL`) before a packet moves. This provider keeps the
 * identical policy (URL rules, same-origin redirects, byte/char caps,
 * charset decoding, error codes) and changes one thing — where the address
 * set comes from:
 *
 * - a proxy route applies (this app's shell injects one on demand) → the
 *   process dispatcher sends the hop; the proxy resolves, nothing local to
 *   repair;
 * - otherwise a canary decides per TTL window: a clean system resolver keeps
 *   answering (zero behavior change), a poisoned one is bypassed with
 *   DNS-over-HTTPS, whose public answer set passes the same validation.
 *
 * No process-wide DNS patch is installed: the interception this replaces in
 * the source project (a `dns.lookup` monkey-patch) does not reach
 * `dns/promises`, which is what the host provider reads — and a patch that
 * wide would reach every lookup in the kernel child, including operator
 * loopback endpoints. Resolution here is per-request and per-provider.
 *
 * @module @dsh-app/plugin-websearch/fetch/provider
 */

import { WebError, type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '@deepseek-ai/dsh-web'
import { DohCache, dohResolve, type DohSend } from './doh.ts'
import { DECISION_TTL_MS, runCanary, type CanaryOutcome } from './detect.ts'
import {
  FETCH_TIMEOUT_MS,
  MAX_BODY_CHARS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  classifyContentType,
  decoderForCharset,
  isRedirectStatus,
  isSameOrigin,
  literalHostAddresses,
  parseCharset,
  validateFetchUrl,
} from './network.ts'
import {
  createSendHop,
  fetchHeaders,
  proxyEnvActive,
  proxyRouteFor,
  startDeadline,
  systemResolve,
  translateTransportError,
  validateAddresses,
  type Deadline,
  type FetchHop,
  type HopSend,
} from './transport.ts'
import { BRAND_FETCH_PROVIDER_ID } from '../wire.ts'

export { BRAND_FETCH_PROVIDER_ID }
/** How long a DoH answer set is trusted (bounded by the record TTL too). */
const DOH_CACHE_TTL_MS = 5 * 60_000

/** The status surface the settings page reads — no user URLs, ever. */
export interface FetchNetworkStatus {
  /** Which transport the NEXT fetch will use, given the environment. */
  readonly route: 'proxy' | 'direct'
  /** Which resolver a direct fetch will use. */
  readonly resolver: 'system' | 'doh' | 'unknown'
  readonly verdict: CanaryOutcome['verdict'] | 'unknown'
  /** When the verdict was last established (epoch ms), or null. */
  readonly checkedAt: number | null
}

/** Construction seams; every one is injectable so the unit suite stays hermetic. */
export interface FetchProviderDeps {
  readonly send?: HopSend
  /** The system resolver (the canary reads the same one). */
  readonly systemLookup?: (hostname: string) => Promise<readonly string[]>
  /** The proxy environment (process.env in production). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The DoH transport seam. */
  readonly dohSend?: Parameters<typeof dohResolve>[1]['send']
  /** Clock, for the TTL window. */
  readonly clock?: () => number
}

export class WebFetchNetworkProvider implements WebFetchProvider {
  readonly id: string

  private readonly send: HopSend
  private readonly lookupHost: (hostname: string) => Promise<readonly string[]>
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly clock: () => number
  private readonly dohSend: DohSend | undefined
  private readonly dohCache = new DohCache()
  private decision: CanaryOutcome | null = null
  private decisionAt = 0

  constructor(id: string, deps: FetchProviderDeps = {}) {
    this.id = id
    this.env = deps.env ?? process.env
    this.send = deps.send ?? createSendHop(this.env)
    this.lookupHost = deps.systemLookup ?? (async (hostname) => await systemResolve(hostname))
    this.clock = deps.clock ?? Date.now
    this.dohSend = deps.dohSend
  }

  /**
   * Always available: unlike a search engine, there is no key or endpoint to
   * be missing. The provider either fetches or fails with a coded error —
   * reporting "unavailable" would only push the seam into
   * `WEB_PROVIDER_UNAVAILABLE` instead of the real cause.
   */
  available(): boolean {
    return true
  }

  /**
   * The current network verdict, for the settings self-check. The route is
   * the environment's general answer (a proxy configured or not): the
   * per-URL NO_PROXY nuance belongs to the fetch itself, which is why the
   * self-check's fetch line is evidence, not a promise about every URL.
   */
  /**
   * The current network verdict, for the settings self-check.
   *
   * `refresh` re-runs the canary before answering. The canary is one lookup of
   * a neutral host, so the cost is one request; the benefit is that the
   * self-check reports what is true NOW rather than what was true up to a TTL
   * window ago — the question a user is actually asking when they press it.
   * A failed refresh keeps the previous verdict instead of blanking the line.
   */
  async status(options?: { readonly refresh?: boolean }): Promise<FetchNetworkStatus> {
    if (options?.refresh === true) {
      try {
        await this.recheck()
      } catch {
        // A canary that cannot run is not a reason to forget the last answer.
      }
    }
    const proxied = proxyEnvActive(this.env)
    if (this.decision === null) {
      return { route: proxied ? 'proxy' : 'direct', resolver: 'unknown', verdict: 'unknown', checkedAt: null }
    }
    return {
      route: proxied ? 'proxy' : 'direct',
      resolver: this.decision.action === 'arm' ? 'doh' : 'system',
      verdict: this.decision.verdict,
      checkedAt: this.decisionAt,
    }
  }

  /** Force a fresh canary pass (the self-check's re-check affordance). */
  async recheck(): Promise<CanaryOutcome> {
    this.decision = await runCanary({ lookup: this.lookupHost })
    this.decisionAt = this.clock()
    return this.decision
  }

  /**
   * Whether this fetch will consult the system resolver, or the DoH plane.
   * Read once per request and carried through it, so a verdict that expires
   * mid-fetch cannot make one request resolve two ways.
   */
  private async resolveVerdict(): Promise<CanaryOutcome> {
    if (this.decision !== null && this.clock() - this.decisionAt < DECISION_TTL_MS) return this.decision
    return await this.recheck()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted === true) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const deadline: Deadline = startDeadline(signal, FETCH_TIMEOUT_MS)
    try {
      return await this.followAndRead(validateFetchUrl(request.url), deadline)
    } catch (error) {
      if (error instanceof WebError) throw error
      throw translateTransportError(error, deadline)
    } finally {
      deadline.dispose()
    }
  }

  /** Follow same-origin redirects up to the cap, then read the final hop. */
  private async followAndRead(initialUrl: URL, deadline: Deadline): Promise<WebFetchResult> {
    let currentUrl = initialUrl
    let redirectsFollowed = 0
    for (;;) {
      if (deadline.signal.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
      const hop = await this.requestOnce(currentUrl, deadline)
      try {
        if (isRedirectStatus(hop.statusCode)) {
          if (redirectsFollowed >= MAX_REDIRECTS) {
            throw new WebError(`exceeded the maximum of ${MAX_REDIRECTS} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = hop.header('location')
          if (location === null) {
            throw new WebError(`redirect response (HTTP ${hop.statusCode}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          const target = new URL(location, currentUrl)
          validateFetchUrl(target.toString())
          if (!isSameOrigin(target, currentUrl)) {
            throw new WebError(`cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`, 'WEB_REDIRECT_BLOCKED')
          }
          redirectsFollowed += 1
          currentUrl = target
          continue
        }
        return await this.readBody(hop, currentUrl)
      } finally {
        await hop.close()
      }
    }
  }

  /** One hop: pick the route, resolve (when direct), validate, send. */
  private async requestOnce(url: URL, deadline: Deadline): Promise<FetchHop> {
    const headers = fetchHeaders()
    if (proxyRouteFor(url, this.env) === 'proxy') {
      return await this.send(url, [], headers, deadline.signal)
    }
    const literalAddresses = literalHostAddresses(url)
    // The verdict is read ONCE per hop and handed down: a decision that
    // expires between the canary and the lookup must not split one request
    // across two resolvers.
    const verdict = literalAddresses !== null ? null : await this.resolveVerdict()
    const addresses = literalAddresses ?? await this.resolveAddresses(url, deadline, verdict as CanaryOutcome)
    validateAddresses(url.hostname, addresses)
    return await this.send(url, addresses, headers, deadline.signal)
  }

  /**
   * The address set for a direct hop: the DoH answer when the network is
   * poisoned, the system answer otherwise. The verdict was resolved once for
   * this request (see {@link requestOnce}) and is carried in, so a verdict
   * that expires mid-request cannot make one fetch resolve two ways.
   */
  private async resolveAddresses(url: URL, deadline: Deadline, verdict: CanaryOutcome): Promise<readonly string[]> {
    const hostname = url.hostname
    if (verdict.action === 'system') {
      return await this.lookupHost(hostname)
    }
    const cached = this.dohCache.get(hostname)
    if (cached !== undefined) return cached
    const answer = await dohResolve(hostname, {
      ...this.dohSend !== undefined ? { send: this.dohSend } : {},
      signal: deadline.signal,
    })
    if (answer.kind === 'failure') {
      // DoH plane dead: fail the fetch rather than silently falling back to
      // the poisoned resolver, which would reproduce the original error.
      throw new WebError(`encrypted resolution failed (${answer.reason}); web_fetch cannot reach this host safely`, 'WEB_PROVIDER_ERROR')
    }
    if (answer.kind === 'addresses') {
      this.dohCache.set(hostname, answer.addresses, Math.min(DOH_CACHE_TTL_MS, answer.ttlSeconds * 1000))
      return answer.addresses
    }
    // NODATA through every node: ask the system resolver once so a genuinely
    // non-existent host reports its real error instead of "no addresses".
    return await this.lookupHost(hostname)
  }

  /** Read, byte-cap, classify and decode the final response. */
  private async readBody(hop: FetchHop, finalUrl: URL): Promise<WebFetchResult> {
    const contentType = hop.header('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const decoder = decoderForCharset(parseCharset(contentType))
    const declared = hop.header('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
        throw new WebError(`response exceeds the maximum of ${MAX_RESPONSE_BYTES} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }
    const { bytes, truncatedByBytes } = await readCapped(hop)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > MAX_BODY_CHARS
    const content = truncatedByChars ? decoded.slice(0, MAX_BODY_CHARS) : decoded
    return {
      url: finalUrl.toString(),
      statusCode: hop.statusCode,
      body: { kind, content },
      truncated: truncatedByBytes || truncatedByChars,
    }
  }
}

/**
 * Read a hop's body up to the byte cap. A stream that grows past the cap is
 * cut short (truncated) rather than rejected, so a server that under-reports
 * still yields a bounded usable body.
 */
async function readCapped(hop: FetchHop): Promise<{ readonly bytes: Uint8Array; readonly truncatedByBytes: boolean }> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of hop.body()) {
    if (total + chunk.byteLength > MAX_RESPONSE_BYTES) {
      chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - total))
      return { bytes: concatBytes(chunks), truncatedByBytes: true }
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  return { bytes: concatBytes(chunks), truncatedByBytes: false }
}

/** Concatenate byte chunks without the `Buffer` global (browser-safe type). */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Build the production provider. */
export function createWebFetchProvider(deps: FetchProviderDeps = {}): WebFetchNetworkProvider {
  return new WebFetchNetworkProvider(BRAND_FETCH_PROVIDER_ID, deps)
}
