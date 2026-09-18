/**
 * pnpm's release-age policy: recognizing its failures, and the one flag that
 * clears them.
 *
 * pnpm ≥11 enables a release-age cooldown by default (`minimumReleaseAge`, 24 h):
 * a version published inside the window is not picked, and a version the
 * resolution is forced to pick is a *violation*. pnpm's own install path handles
 * one by appending `name@version` to `minimumReleaseAgeExclude` in
 * `pnpm-workspace.yaml`; the paths this market drives do not, and fail instead:
 *
 *   - `remove` wires no policy callback at all, so a violation its resolution
 *     produces aborts with `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` (an
 *     internal guardrail that names a count, not the packages);
 *   - the lockfile check that runs before EVERY command aborts with
 *     `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, listing every entry it rejected;
 *   - strict mode aborts with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`.
 *
 * Writing that exclusion list is NOT a way out of it. Measured on pnpm 11.7.0:
 * the lockfile check ignores `minimumReleaseAgeExclude` entirely, so a profile
 * whose manifest pins a version newer than the cutoff is blocked — no install,
 * no uninstall — for the whole cooldown, and a retry after writing the exclusion
 * fails identically. The per-run config override is: {@link RELEASE_AGE_OVERRIDE}
 * clears the check and the resolution for ONE run, leaves `minimumReleaseAge` and
 * every other run exactly as the profile and the user had them, and writes
 * nothing.
 *
 * @module @dsh-app/plugin-market/release-age
 */

/**
 * The failures this module reacts to. All three mean the same thing — the active
 * release-age policy rejected a version this run needs — and all three are
 * cleared the same way.
 */
const RELEASE_AGE_CODES = [
  'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED',
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'ERR_PNPM_NO_MATURE_MATCHING_VERSION',
] as const

/**
 * The pnpm argument that lifts the release-age policy for one run, as the
 * config override pnpm reads from `--config.<key>=<value>` (an environment
 * variable does not reach it: measured, `npm_config_minimum_release_age=0`
 * leaves the check in force).
 */
export const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/**
 * Whether a failed run failed on the release-age policy.
 * @param output - the full combined CLI output (never the truncated tail).
 * @returns true when pnpm named one of the policy's failures.
 */
export function isReleaseAgeFailure(output: string): boolean {
  return RELEASE_AGE_CODES.some(code => output.includes(code))
}
