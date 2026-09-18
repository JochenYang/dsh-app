/**
 * Release-age tests: recognizing pnpm's three policy failures (and rejecting
 * everything else), and the one argument that lifts the policy for a run.
 *
 * Writing the versions into `minimumReleaseAgeExclude` is deliberately NOT the
 * recovery here: measured on pnpm 11.7.0, the lockfile check that runs before
 * every command ignores that list, so the exclusion-pair approach leaves the
 * profile blocked for the whole cooldown. What clears it is the per-run config
 * override, which is what these tests pin down.
 *
 * @module plugin-market/tests/release-age
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { RELEASE_AGE_OVERRIDE, isReleaseAgeFailure } from '../src/release-age.ts'

/** The unhandled guardrail: a policy failure that names a count, not the picks. */
const UNHANDLED = `Progress: resolved 1, reused 0, downloaded 0, added 0
[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 8 resolution-policy violations were produced but no handleResolutionPolicyViolations callback was wired to react to them.

Internal: resolveDependencies needs a handleResolutionPolicyViolations callback whenever a policy that can produce violations (today: minimumReleaseAge) is active. Wire setupPolicyHandlers (in @pnpm/installing.commands) or supply a callback directly.
`

/** The lockfile-verification failure, verbatim from pnpm 11.7.0 (the one the market hit). */
const LOCKFILE_LISTING = `? Verifying lockfile against supply-chain policies (3 entries)...
✗ Lockfile failed supply-chain policy check (3 entries in 1.7s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:
  dsh-context@0.53.2 was published at 2026-09-17T09:06:32.000Z, within the minimumReleaseAge cutoff (2026-09-16T14:15:46.564Z)

The lockfile contains entries that the active policies reject. This can mean the lockfile is stale, or that someone committed a lockfile that bypassed the policy locally — inspect recent changes to pnpm-lock.yaml before trusting it.
`

/** The strict-mode form (non-interactive). */
const STRICT_LISTING = `[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 2 versions do not meet the minimumReleaseAge constraint:
  @scope/tool@1.0.0-RC.1 released 2 hours ago
  - other-plugin@0.4.2 released 30 minutes ago
`

describe('isReleaseAgeFailure', () => {
  it('recognizes all three policy failures', () => {
    assert.equal(isReleaseAgeFailure(UNHANDLED), true)
    assert.equal(isReleaseAgeFailure(LOCKFILE_LISTING), true)
    assert.equal(isReleaseAgeFailure(STRICT_LISTING), true)
  })

  it('rejects everything else, including the other recoverable failure', () => {
    assert.equal(isReleaseAgeFailure(''), false)
    assert.equal(isReleaseAgeFailure('dependencies:\n+ dsh-x 0.1.0\nDone in 4.2s\n'), false)
    // A build-scripts failure has its own recovery path entirely.
    assert.equal(isReleaseAgeFailure('Ignored build scripts: esbuild. Run "pnpm approve-builds"\n'), false)
    assert.equal(isReleaseAgeFailure('npm ERR! 404 Not Found\n'), false)
    assert.equal(isReleaseAgeFailure('dsh-plugin-wallpaper-engine@0.7.3 installed\n'), false)
  })
})

describe('RELEASE_AGE_OVERRIDE', () => {
  it('is the pnpm config override, camelCase key and zero', () => {
    // pnpm reads `--config.<key>=<value>`; the key and value here are the exact
    // ones measured to clear the lockfile check on 11.7.0.
    assert.equal(RELEASE_AGE_OVERRIDE, '--config.minimumReleaseAge=0')
  })
})
