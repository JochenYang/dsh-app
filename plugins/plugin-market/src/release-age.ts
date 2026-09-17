/**
 * pnpm's release-age policy: recognizing its failures, and the exclusion list
 * that clears them.
 *
 * pnpm ≥11 enables a release-age cooldown by default (`minimumReleaseAge`,
 * 24 h): a version published inside the window is not picked, and a version
 * the resolution is forced to pick is a *violation*. pnpm's own install paths
 * handle a violation by appending `name@version` to `minimumReleaseAgeExclude`
 * in `pnpm-workspace.yaml` and proceeding; other paths do not, and fail
 * instead:
 *
 *   - `remove` wires no policy callback at all, so any violation its
 *     resolution produces aborts with
 *     `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` (an internal
 *     guardrail that names a count, not the packages);
 *   - the lockfile check that runs before a command aborts with
 *     `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` and lists every entry it
 *     rejected, with its publish time;
 *   - strict mode aborts with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`.
 *
 * A profile whose manifest pins a version newer than the cutoff without an
 * exclusion entry — an install interrupted before pnpm recorded one, a
 * lockfile or exclusion list written by a toolchain without the policy, a
 * hand-edited manifest — therefore cannot be uninstalled. The recovery is the
 * one pnpm itself applies on the install path: record the offending versions
 * as exclusions and retry. The cooldown stays in force for everything else,
 * which is why this module never touches `minimumReleaseAge`.
 *
 * @module @dsh-app/plugin-market/release-age
 */

import { readFileSync } from 'node:fs'
import { MarketValidationError } from './errors.ts'
import { EXACT_VERSION_PATTERN, PACKAGE_NAME_PATTERN } from './npm.ts'
import { writeWorkspaceList, withWorkspaceList, type ValueRefusal } from './workspace-list.ts'

/** The single workspace key this module owns. */
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'

/**
 * The failures this module reacts to. All three mean the same thing — the
 * active release-age policy rejected a version the command needs — and all
 * three are cleared the same way.
 */
const RELEASE_AGE_CODES = [
  'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED',
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'ERR_PNPM_NO_MATURE_MATCHING_VERSION',
] as const

/**
 * Read one `name@version` token back as an exclusion entry, or null when it is
 * not one. Both halves are checked against the npm grammar and the exact
 * version shape: these values are spliced into pnpm-workspace.yaml, so
 * free-form log text must never survive this boundary. The version is split at
 * the LAST `@` so scoped names (`@scope/pkg@1.2.3`) come back whole.
 */
function entryOf(token: string): string | null {
  const at = token.lastIndexOf('@')
  if (at <= 0) return null
  const name = token.slice(0, at)
  const version = token.slice(at + 1)
  if (!PACKAGE_NAME_PATTERN.test(name) || !EXACT_VERSION_PATTERN.test(version)) return null
  return `${name}@${version}`
}

/**
 * The package versions a failed CLI run reported, or null when the output
 * carries no release-age failure.
 *
 * pnpm prints the rejected versions in its lockfile-verification and strict
 * listings, one per line, each starting with the `name@version` token. The
 * unhandled-guardrail form prints only a count, so an empty list means
 * "a release-age failure with nothing named" — the caller falls back to the
 * profile manifest for candidates.
 *
 * @param output - the full combined CLI output (never the truncated tail).
 * @returns the deduped `name@version` entries, or null for an unrelated failure.
 */
export function releaseAgeViolationsOf(output: string): readonly string[] | null {
  if (!RELEASE_AGE_CODES.some(code => output.includes(code))) return null
  const entries: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const first = line.trim().replace(/^-\s*/, '').split(/\s+/)[0]
    if (first === undefined) continue
    const entry = entryOf(first)
    if (entry !== null && !entries.includes(entry)) entries.push(entry)
  }
  return entries
}

/**
 * The `name@version` entries of a profile manifest's dependencies that are
 * pinned to an exact version.
 *
 * This is the candidate set for a release-age failure that names nothing: the
 * versions such a profile can be forced to pick are its own declared ones.
 * Ranges and non-registry specs carry no version to exclude and are skipped —
 * pnpm resolves those to a mature version on its own.
 *
 * @param manifestText - the profile's package.json content, or null.
 * @returns the deduped entries.
 */
export function exactDependenciesOf(manifestText: string | null): readonly string[] {
  if (manifestText === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    return []
  }
  const dependencies = (parsed as { dependencies?: unknown } | null)?.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  const entries: string[] = []
  for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof spec !== 'string') continue
    const version = spec.trim()
    if (!PACKAGE_NAME_PATTERN.test(name) || !EXACT_VERSION_PATTERN.test(version)) continue
    const entry = `${name}@${version}`
    if (!entries.includes(entry)) entries.push(entry)
  }
  return entries
}

/**
 * {@link exactDependenciesOf} for a manifest on disk. An unreadable or
 * unusable manifest answers an empty list — the caller then has nothing to
 * exclude and reports the original failure.
 * @param manifestPath - absolute path of the profile's package.json.
 */
export function pinnedDependenciesOf(manifestPath: string): readonly string[] {
  try {
    return exactDependenciesOf(readFileSync(manifestPath, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Message for an entry that could not be written as a plain YAML scalar. Both
 * callers validate their values first, so this is a boundary guard only.
 */
const refuseEntry: ValueRefusal = entry => new MarketValidationError({
  code: 'releaseAge.unsafeEntry',
  params: { entry },
  text: `the version cannot be written into the release-age exclusion list safely: "${entry}"`,
})

/**
 * Merge `entries` into the `minimumReleaseAgeExclude` list of a
 * pnpm-workspace.yaml document, touching nothing else (see
 * {@link withWorkspaceList} for the merge rules).
 * @param existing - the current file content, or null when the file is absent.
 * @param entries - `name@version` entries to exclude.
 * @returns the new content; the input itself when nothing would change.
 */
export function withReleaseAgeExcludes(existing: string | null, entries: readonly string[]): string {
  return withWorkspaceList(existing, EXCLUDE_KEY, entries, refuseEntry)
}

/**
 * Merge `entries` into the exclusion list on disk.
 * @param path - absolute path of the profile's pnpm-workspace.yaml.
 * @param entries - `name@version` entries to exclude.
 * @returns whether the file content changed.
 */
export function allowReleaseAges(path: string, entries: readonly string[]): boolean {
  return writeWorkspaceList(path, EXCLUDE_KEY, entries, refuseEntry)
}
