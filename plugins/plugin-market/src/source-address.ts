/**
 * The catalog source ADDRESS policy: which literals a source URL may name, and
 * which answers a hostname may resolve to.
 *
 * A source URL is user input that this host then requests, so it is held to the
 * SSRF bar the suite already applies to model-facing fetches: the destination
 * must be globally routable unicast. Everything else is refused — loopback, the
 * private blocks, link-local (which is where the cloud metadata endpoints
 * live), CGNAT, multicast, reserved space, and the IPv6 forms that carry an
 * IPv4 address (6to4, Teredo, NAT64) — because an internal answer from an
 * internet-facing client is either a mistake or an attempt to reach something
 * the user did not mean to expose.
 *
 * ONE DELIBERATE EXCEPTION: `198.18.0.0/15`, the RFC 2544 benchmarking block.
 * A machine whose VPN client runs in TUN/fake-IP mode answers EVERY hostname
 * with an address in that block (measured on this project's machine:
 * `dns.lookup('definitely-not-a-host.invalid')` answers `198.18.0.35`, where a
 * clean resolver answers NXDOMAIN). Refusing the block would therefore refuse
 * every catalog source — the two presets included — on the network shape this
 * app is built and shipped on. The cost is stated plainly rather than hidden:
 * ON SUCH A NETWORK THE RESOLUTION HALF OF THIS POLICY IS INERT, because every
 * answer is a benchmarking address, and only the URL half still refuses
 * anything (a literal private host). The half is advisory in a second way too:
 * it judges the LOCAL resolver's answer before the request, while the
 * connection resolves again inside undici — through the proxy this app injects
 * on a desktop start (`sourceAddressReason` in `catalog.ts` owns that note).
 * The suite's fetch provider can afford the
 * strict rule because it detects the poisoned resolver and re-resolves over
 * DoH (`plugin-websearch/src/fetch/doh.ts`); the catalog path has no second
 * resolver, so it takes the exception instead of a bypass.
 *
 * `ipaddr.js` files this block under `reserved`, which is why the exception is
 * an explicit subnet test and never a range name: `reserved` also carries
 * `240.0.0.0/4`, `192.0.2.0/24` and friends. For the same reason the block is
 * matched on IPv4 only — IPv6 has its own `benchmarking` range (`2001:2::/48`)
 * that this policy has no reason to allow, and it stays refused.
 *
 * Why `ipaddr.js` rather than `node:net`'s `BlockList`: the range NAME is part
 * of the answer (the diagnostic carries it, and the exception above is written
 * against a subnet rather than a name), the suite's own fetch predicate is this
 * library at this version (`plugin-websearch/src/fetch/network.ts`), and it
 * classifies the transition forms a prefix table would have to enumerate by
 * hand (6to4, NAT64, Teredo, IPv6 benchmarking). It is NOT a workaround for
 * IPv4-mapped addresses — measured on this platform, `BlockList` applies IPv4
 * rules to a mapped address natively (`check('::ffff:7f00:1', 'ipv6')` answers
 * true), so that is not a reason to prefer it.
 *
 * ONE KNOWN GAP, SHARED WITH THE SUITE'S FETCH PROVIDER: an IPv4-COMPATIBLE
 * literal never reaches this module in the form it was typed. WHATWG URL
 * parsing rewrites the host of `https://[::127.0.0.1]/` to `[::7f00:1]`, which
 * is neither `isIPv4MappedAddress()` nor a refused range, so it passes. It
 * reaches nothing on this platform (measured: the connect times out), and
 * closing it is a two-caller decision — the suite's fetch provider has the
 * same blind spot — so it is recorded here rather than changed on one side.
 *
 * Everything in this module is pure and network-free: the resolver is the
 * caller's, so the policy is exercised without a socket.
 *
 * @module @dsh-app/plugin-market/source-address
 */

import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import type { HostText } from './errors.ts'

/** The one allowed non-unicast block: RFC 2544 benchmarking (fake-IP). */
const FAKE_IP_BLOCK = ipaddr.parseCIDR('198.18.0.0/15')

/** One address's verdict under the source policy. */
export interface AddressVerdict {
  /** Whether the policy refuses this address. */
  readonly blocked: boolean
  /**
   * Classification, for the diagnostic: the `ipaddr.js` range name, or
   * `benchmarking` for the allowed exception, or `unparsable`.
   */
  readonly range: string
}

/**
 * Judge one textual address.
 *
 * IPv4-mapped IPv6 is judged by the address it EMBEDS (`::ffff:127.0.0.1` is
 * loopback), the same normalization the suite's fetch provider applies. An
 * address nothing can parse is REFUSED rather than waved through: this policy
 * fails closed, and a real resolver answer always parses.
 *
 * @param address - textual IPv4 or IPv6 address.
 * @returns the verdict.
 */
export function verdictOfAddress(address: string): AddressVerdict {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(address)
  } catch {
    return { blocked: true, range: 'unparsable' }
  }
  const subject = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed
  // `match` refuses an IPv6 subject, so the family is tested first (the
  // exception is IPv4-only by design — see the module header).
  if (subject instanceof ipaddr.IPv4 && subject.match(FAKE_IP_BLOCK)) return { blocked: false, range: 'benchmarking' }
  const range = subject.range()
  return { blocked: range !== 'unicast', range }
}

/**
 * The first address of a set the policy refuses, or undefined when every one
 * passes. A hostname with ANY refused answer is refused: the connection may
 * take any address the resolver returned.
 *
 * @param addresses - the answer set, in the resolver's own order.
 * @returns the offending address and its range, or undefined.
 */
export function blockedAddressOf(addresses: readonly string[]): { readonly address: string, readonly range: string } | undefined {
  for (const address of addresses) {
    const verdict = verdictOfAddress(address)
    if (verdict.blocked) return { address, range: verdict.range }
  }
  return undefined
}

/**
 * The IP literal a URL hostname names, when it names one. WHATWG URL parsing
 * keeps IPv6 hosts bracketed (`https://[::1]/`), so the brackets come off here.
 *
 * @param hostname - a `URL.hostname`.
 * @returns the bare literal, or undefined for a name.
 */
export function literalAddressOf(hostname: string): string | undefined {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) === 0 ? undefined : bare
}

/**
 * The coded reason for a hostname that is a REFUSED literal, or undefined when
 * the hostname is a name or a public address. The synchronous half of the
 * policy: it needs no resolver, so URL validation can carry it.
 *
 * @param hostname - a `URL.hostname`.
 * @returns the coded reason, or undefined.
 */
export function literalAddressReason(hostname: string): HostText | undefined {
  const literal = literalAddressOf(hostname)
  if (literal === undefined) return undefined
  return verdictOfAddress(literal).blocked ? privateAddressReason(hostname) : undefined
}

/**
 * The coded reason for a source that names a private or local literal.
 * @param host - the host as the user typed it.
 */
export function privateAddressReason(host: string): HostText {
  return {
    code: 'source.privateAddress',
    params: { host },
    text: `a catalog source must not point at a private, loopback or link-local address: "${host}"`,
  }
}

/**
 * The coded reason for a source host that resolves to a private or local
 * address. The offending address and its range ride the English diagnostic
 * (a log needs them); the panel's sentence interpolates the host alone.
 *
 * @param host - the hostname as the user typed it.
 * @param address - the refused answer.
 * @param range - that address's classification.
 */
export function privateResolutionReason(host: string, address: string, range: string): HostText {
  return {
    code: 'source.privateResolution',
    params: { host },
    text: `the catalog source host "${host}" resolves to a non-public address (${address}, ${range})`,
  }
}

/**
 * The coded reason for a source host the resolver could not answer for.
 *
 * Deliberately NOT {@link privateResolutionReason}: a failed or expired lookup
 * is not a private answer, and reporting it as one would be a claim the user
 * cannot check. The npm catalog path refuses on this reason (see
 * `hopAddressReason` in `catalog.ts`); the user-typed https source keeps the
 * opposite default, because there the failure is the user's own network.
 *
 * @param host - the hostname as the source named it.
 */
export function unresolvedReason(host: string): HostText {
  return {
    code: 'source.unresolved',
    params: { host },
    text: `the catalog source host "${host}" could not be resolved`,
  }
}

/**
 * The resolver half of the policy, injectable so the request path can be
 * exercised without a socket.
 */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>
