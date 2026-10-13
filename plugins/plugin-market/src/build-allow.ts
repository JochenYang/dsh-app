/**
 * pnpm build-script allowance for the profile.
 *
 * pnpm ≥10 refuses to run dependency build scripts unless the package is
 * whitelisted under `onlyBuiltDependencies` in `pnpm-workspace.yaml` next to
 * the profile manifest — a blocked build leaves the dependency installed but
 * without its postinstall output (native binaries), which surfaces only as a
 * broken plugin at runtime. When the install output carries pnpm's blocked
 * signal, this module merges the named packages into that whitelist so a
 * retry can run the scripts.
 *
 * Scope discipline mirrors patchfile.ts: the whitelist is the ONLY key this
 * module touches. The document surgery itself (byte preservation, line
 * endings, scalar safety, atomic write) lives in workspace-list.ts, shared
 * with the release-age exclusion list.
 *
 * This module also owns the AUTHORIZATION of that write
 * ({@link BlockedBuildLedger}): the whitelist retry is offered beside a blocked
 * install the host itself ran, so the host is the only party that knows which
 * packages the retry may be about.
 *
 * @module @dsh-app/plugin-market/build-allow
 */

import { MarketValidationError, type HostText } from './errors.ts'
import { writeWorkspaceList, withWorkspaceList, type ValueRefusal } from './workspace-list.ts'

/** The single workspace key this module owns. */
const ALLOW_KEY = 'onlyBuiltDependencies'

/**
 * Message for a name that could not be written as a plain YAML scalar.
 * Package names arrive validated through the npm grammar, but the grammar
 * admits leading `*`/`~`, which YAML would read as alias/null — those must
 * never reach the file.
 */
const refuseName: ValueRefusal = name => new MarketValidationError({
  code: 'buildAllow.unsafeName',
  params: { name },
  text: `the package name cannot be written into the build-script whitelist safely: "${name}"`,
})

/**
 * Merge `packages` into the `onlyBuiltDependencies` whitelist of a
 * pnpm-workspace.yaml document, touching nothing else.
 *
 * - no file (null) → the minimal workspace document with the whitelist;
 * - block-style key → new names appended after the last existing item,
 *   deduped against it (an already-listed name changes nothing);
 * - flow-style key → rewritten with the merged list;
 * - no key → the key appended at the end.
 *
 * @param existing - the current file content, or null when the file is absent.
 * @param packages - package names to allow (pre-validated by the caller).
 * @returns the new content; the input itself when nothing would change.
 */
export function withAllowedBuilds(existing: string | null, packages: readonly string[]): string {
  return withWorkspaceList(existing, ALLOW_KEY, packages, refuseName)
}

/**
 * Merge `packages` into the whitelist file on disk (creates the file and its
 * parent directory when absent). The write is atomic (tmp + rename).
 * @param path - absolute path of the profile's pnpm-workspace.yaml.
 * @param packages - package names to allow (pre-validated by the caller).
 * @returns whether the file content changed.
 */
export function allowBuilds(path: string, packages: readonly string[]): boolean {
  return writeWorkspaceList(path, ALLOW_KEY, packages, refuseName)
}

/**
 * Names one profile's ledger keeps. Bounded because a long-lived host records
 * every blocked attempt it runs; the entries the panel can still retry are the
 * recent ones, and eviction fails CLOSED — a forgotten name is refused, never
 * granted.
 */
const MAX_LEDGER_NAMES = 64

/**
 * Profiles one ledger tracks. A host serves one profile; the bound only keeps a
 * future multi-profile host (or a test) from growing the map without limit.
 */
const MAX_LEDGER_PROFILES = 8

/** One profile's record: the packages the host tried, and the names pnpm reported. */
interface ProfileLedger {
  readonly targets: string[]
  readonly blocked: string[]
}

/** Append a name the list does not carry yet, evicting the oldest past the cap. */
function remember(list: string[], name: string): void {
  if (name === '' || list.includes(name)) return
  list.push(name)
  if (list.length > MAX_LEDGER_NAMES) list.shift()
}

/**
 * The host's own record of installs whose build scripts pnpm skipped — the
 * authorization anchor of `POST /allow-build`.
 *
 * The route used to take the package to reinstall straight from the renderer,
 * so ANY name could be merged into the profile's `onlyBuiltDependencies`
 * whitelist and then installed: a name that was never installed — never even
 * attempted — passed the one check there was (an installed local/git copy), and
 * `pnpm-workspace.yaml` gained a build-script permission for it. Whose install
 * is being remedied is a fact only the host holds, so the host keeps it:
 * `record` is called with the outcome of every install the host itself ran, and
 * `permits` refuses a target it never attempted, a name pnpm never reported,
 * and a profile it has nothing for.
 *
 * The record survives the retry on purpose: a retry whose run is blocked again
 * (a second package that needs approval) stays retryable, which is the panel's
 * documented behaviour. What the ledger authorizes is narrow — re-running one
 * install the host already ran, whitelisting only the names its own output
 * named.
 */
export class BlockedBuildLedger {
  private readonly byProfile = new Map<string, ProfileLedger>()

  /**
   * Record one install the host ran whose build scripts pnpm skipped.
   * @param profile - the profile the install targeted.
   * @param target - the package the host resolved and installed.
   * @param blocked - the names pnpm's output reported (possibly empty).
   */
  record(profile: string, target: string, blocked: readonly string[]): void {
    const held = this.stateFor(profile)
    remember(held.targets, target)
    for (const name of blocked) remember(held.blocked, name)
  }

  /**
   * Whether one allow-build request may proceed.
   *
   * `target` must be an install THIS host attempted — the caller's string is
   * only a key into that record — and every name of `allowed` must be one pnpm
   * reported to this host. The target itself need not appear in `allowed`: the
   * names pnpm reports are usually a native DEPENDENCY's (`Ignored build
   * scripts: sharp` while the plugin being installed is another name), so
   * demanding it would refuse the ordinary retry this endpoint exists for.
   *
   * @param profile - the profile the request targets.
   * @param target - the package the caller wants reinstalled.
   * @param allowed - the names the caller wants whitelisted.
   * @returns null when permitted, else the coded refusal.
   */
  permits(profile: string, target: string, allowed: readonly string[]): HostText | null {
    const held = this.byProfile.get(profile)
    if (held === undefined || !held.targets.includes(target)) {
      return {
        code: 'allowBuild.notBlockedInstall',
        params: { package: target },
        text: `the host has no record of a blocked build-script install for "${target}"; install it from the market panel first, then use the retry beside the blocked-builds warning`,
      }
    }
    const unreported = allowed.filter(name => !held.blocked.includes(name))
    if (unreported.length > 0) {
      return {
        code: 'allowBuild.notReported',
        params: { packages: unreported.join(', ') },
        text: `the allow list names packages this install attempt did not report as blocked: ${unreported.join(', ')}`,
      }
    }
    return null
  }

  /** One profile's record, creating it and evicting the least recently used past the cap. */
  private stateFor(profile: string): ProfileLedger {
    const existing = this.byProfile.get(profile)
    if (existing !== undefined) {
      // Re-insert so the map's insertion order stays "least recently used first".
      this.byProfile.delete(profile)
      this.byProfile.set(profile, existing)
      return existing
    }
    const created: ProfileLedger = { targets: [], blocked: [] }
    this.byProfile.set(profile, created)
    while (this.byProfile.size > MAX_LEDGER_PROFILES) {
      const oldest = this.byProfile.keys().next()
      if (oldest.done === true) return created
      this.byProfile.delete(oldest.value)
    }
    return created
  }
}
