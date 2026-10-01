/**
 * The fake-IP canary: decide, once per TTL window, whether this process must
 * resolve fetch destinations through DoH or may keep using the system
 * resolver.
 *
 * The decision is a five-branch table, the same shape the source project
 * proved out (ADR-0022):
 *
 * ① any canary address is non-public → arm DoH (poisoned; the hits are the
 *   evidence);
 * ② every canary lookup failed → arm DoH (inconclusive — a blind resolver
 *   beats a poisoned one, and DNS blackholes are the common failure here);
 * ③ mixed success with zero hits → system (a clean sample proves no
 *   poisoning; failures stay diagnostics);
 * ④ all clean → system;
 * ⑤ the environment forces a verdict (proxy active) → caller skips this
 *   module entirely.
 *
 * The probe host is a neutral, always-public name: under a clean resolver it
 * answers with public addresses, under fake-IP it answers with 198.18.x.x.
 * Nothing user-specific is ever resolved here, so the verdict names no user
 * destination and is safe to surface in the settings UI.
 *
 * @module @dsh-app/plugin-websearch/fetch/detect
 */

import { lookup } from 'node:dns/promises'
import { isPublicAddress } from './network.ts'

/** The neutral probe host (IANA-reserved, always public on a clean network). */
export const CANARY_HOST = 'example.com'

/** How long a verdict is trusted before the next fetch re-checks. */
export const DECISION_TTL_MS = 10 * 60_000

/** The system lookup the canary probes through (all-form, verbatim order). */
export type SystemLookup = (host: string) => Promise<readonly string[]>

/** One non-public address observed for one host — the enabling evidence. */
export interface CanaryHit {
  readonly host: string
  readonly addresses: readonly string[]
}

/** The verdict. `arm` routes resolution through DoH; `system` keeps it local. */
export interface CanaryOutcome {
  readonly action: 'arm' | 'system'
  readonly verdict: 'poisoned' | 'clean' | 'inconclusive'
  readonly hits: readonly CanaryHit[]
  readonly failures: readonly string[]
  readonly checkedAt: number
}

/** The production system resolver: the untouched `dns.promises.lookup`. */
export const systemLookup: SystemLookup = async (host) => {
  const resolved = await lookup(host, { all: true, order: 'verbatim' })
  return resolved.map(entry => entry.address)
}

/**
 * Run the decision table over the canary host.
 *
 * @param options - the lookup seam and the probe host (both injectable for
 *   the unit suite).
 * @returns the verdict with its evidence.
 */
export async function runCanary(options?: {
  readonly lookup?: SystemLookup
  readonly host?: string
  readonly clock?: () => number
}): Promise<CanaryOutcome> {
  const probe = options?.lookup ?? systemLookup
  const host = options?.host ?? CANARY_HOST
  const hits: CanaryHit[] = []
  const failures: string[] = []
  try {
    const addresses = await probe(host)
    const poisoned = addresses.filter(address => !isPublicAddress(address))
    if (poisoned.length > 0) {
      hits.push({ host, addresses: poisoned })
      return { action: 'arm', verdict: 'poisoned', hits, failures, checkedAt: (options?.clock ?? Date.now)() }
    }
    return { action: 'system', verdict: 'clean', hits, failures, checkedAt: (options?.clock ?? Date.now)() }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    return { action: 'arm', verdict: 'inconclusive', hits, failures, checkedAt: (options?.clock ?? Date.now)() }
  }
}
