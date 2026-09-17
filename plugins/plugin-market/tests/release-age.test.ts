/**
 * Release-age tests: recognizing pnpm's three policy failures (and rejecting
 * everything else), reading the rejected versions out of each listing form,
 * deriving the candidate set from a profile manifest, and merging entries into
 * the `minimumReleaseAgeExclude` list without disturbing the rest of the file.
 *
 * @module plugin-market/tests/release-age
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MarketValidationError } from '../src/errors.ts'
import {
  allowReleaseAges,
  exactDependenciesOf,
  pinnedDependenciesOf,
  releaseAgeViolationsOf,
  withReleaseAgeExcludes,
} from '../src/release-age.ts'

/** The unhandled guardrail: a policy failure that names a count, not the picks. */
const UNHANDLED = `Progress: resolved 1, reused 0, downloaded 0, added 0
[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 8 resolution-policy violations were produced but no handleResolutionPolicyViolations callback was wired to react to them.

Internal: resolveDependencies needs a handleResolutionPolicyViolations callback whenever a policy that can produce violations (today: minimumReleaseAge) is active. Wire setupPolicyHandlers (in @pnpm/installing.commands) or supply a callback directly.
`

/** The lockfile-verification listing, verbatim from pnpm 11.7.0. */
const LOCKFILE_LISTING = `? Verifying lockfile against supply-chain policies (3 entries)...
✗ Lockfile failed supply-chain policy check (3 entries in 1.7s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:
  @typescript/typescript-win32-x64@7.1.0-dev.20260916.1 was published at 2026-09-16T08:40:23.492Z, within the minimumReleaseAge cutoff (2026-09-16T01:52:35.378Z)
  typescript@7.1.0-dev.20260916.1 was published at 2026-09-16T08:43:03.940Z, within the minimumReleaseAge cutoff (2026-09-16T01:52:35.378Z)
  dsh-plugin-wallpaper-engine@0.7.3 was published at 2026-09-17T02:00:00.000Z, within the minimumReleaseAge cutoff (2026-09-16T01:52:35.378Z)

The lockfile contains entries that the active policies reject. This can mean the lockfile is stale, or that someone committed a lockfile that bypassed the policy locally — inspect recent changes to pnpm-lock.yaml before trusting it.
`

/** The strict-mode form (non-interactive): a dash-prefixed list of picks. */
const STRICT_LISTING = `[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 2 versions do not meet the minimumReleaseAge constraint:
  @scope/tool@1.0.0-RC.1 released 2 hours ago
  - other-plugin@0.4.2 released 30 minutes ago
`

describe('releaseAgeViolationsOf', () => {
  it('answers null when the failure is unrelated to the release-age policy', () => {
    assert.equal(releaseAgeViolationsOf(''), null)
    assert.equal(releaseAgeViolationsOf('dependencies:\n+ dsh-x 0.1.0\nDone in 4.2s\n'), null)
    // A build-scripts failure is a different recovery path entirely.
    assert.equal(releaseAgeViolationsOf('Ignored build scripts: esbuild\n'), null)
  })

  it('answers an empty list for the unhandled guardrail, which names no version', () => {
    assert.deepEqual(releaseAgeViolationsOf(UNHANDLED), [])
  })

  it('reads every rejectable version out of the lockfile listing', () => {
    assert.deepEqual(releaseAgeViolationsOf(LOCKFILE_LISTING), [
      '@typescript/typescript-win32-x64@7.1.0-dev.20260916.1',
      'typescript@7.1.0-dev.20260916.1',
      'dsh-plugin-wallpaper-engine@0.7.3',
    ])
  })

  it('reads the strict listing, dash rows included', () => {
    assert.deepEqual(releaseAgeViolationsOf(STRICT_LISTING), ['@scope/tool@1.0.0-RC.1', 'other-plugin@0.4.2'])
  })

  it('drops free-form text and dedupes repeated rows', () => {
    const output = [
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:',
      '  8 entries could not be checked',
      '  not@a-version',
      '  a@1.0.0',
      '  a@1.0.0',
      '  a@^1.0.0',
      '',
    ].join('\n')
    assert.deepEqual(releaseAgeViolationsOf(output), ['a@1.0.0'])
  })
})

describe('exactDependenciesOf', () => {
  it('keeps exact pins and skips every spec without a version to exclude', () => {
    const manifest = JSON.stringify({
      name: 'dsh-profile-dsh-app',
      private: true,
      dependencies: {
        'dsh-plugin-x': '0.7.3',
        '@scope/plugin': '1.0.0-rc.1',
        range: '^1.0.0',
        tarball: 'file:../plugin.tgz',
        git: 'github:owner/repo',
        number: 5,
      },
    })
    assert.deepEqual(exactDependenciesOf(manifest), ['dsh-plugin-x@0.7.3', '@scope/plugin@1.0.0-rc.1'])
  })

  it('degrades to nothing for an absent, malformed or dependency-less manifest', () => {
    assert.deepEqual(exactDependenciesOf(null), [])
    assert.deepEqual(exactDependenciesOf('not json'), [])
    assert.deepEqual(exactDependenciesOf('{}'), [])
    assert.deepEqual(exactDependenciesOf('{"dependencies": []}'), [])
  })
})

describe('pinnedDependenciesOf (file level)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-market-release-age-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads the profile manifest, and nothing at all when it is missing', () => {
    const path = join(dir, 'package.json')
    assert.deepEqual(pinnedDependenciesOf(path), [])
    writeFileSync(path, JSON.stringify({ dependencies: { 'dsh-plugin-x': '0.7.3' } }), 'utf8')
    assert.deepEqual(pinnedDependenciesOf(path), ['dsh-plugin-x@0.7.3'])
  })
})

describe('withReleaseAgeExcludes (pure)', () => {
  it('creates the minimal document when the file is absent', () => {
    assert.equal(
      withReleaseAgeExcludes(null, ['dsh-plugin-x@0.7.3']),
      "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nminimumReleaseAgeExclude:\n  - 'dsh-plugin-x@0.7.3'\n",
    )
  })

  it('appends to an existing list, deduped and byte-preserving', () => {
    const existing = [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'onlyBuiltDependencies:',
      '  - esbuild',
      'minimumReleaseAgeExclude:',
      "  - '@scope/tool@1.0.0'",
      '',
    ].join('\n')
    const next = withReleaseAgeExcludes(existing, ['@scope/tool@1.0.0', 'dsh-plugin-x@0.7.3'])
    assert.equal(next, `${existing}  - 'dsh-plugin-x@0.7.3'\n`)
    assert.equal(withReleaseAgeExcludes(next, ['dsh-plugin-x@0.7.3']), next)
  })

  it('appends the key when the file has none and keeps its other keys', () => {
    const existing = 'packages:\n  - .\nonlyBuiltDependencies:\n  - esbuild\n'
    const next = withReleaseAgeExcludes(existing, ['dsh-plugin-x@0.7.3'])
    assert.ok(next.startsWith(existing))
    assert.equal(next, `${existing}minimumReleaseAgeExclude:\n  - 'dsh-plugin-x@0.7.3'\n`)
  })

  it('adopts CRLF line endings for inserted rows', () => {
    const crlf = 'packages:\r\n  - .\r\nnodeLinker: hoisted\r\n'
    const next = withReleaseAgeExcludes(crlf, ['dsh-plugin-x@0.7.3'])
    assert.ok(next.startsWith(crlf))
    assert.ok(next.endsWith("  - 'dsh-plugin-x@0.7.3'\r\n"))
  })

  it('refuses an entry that could break out of the list row', () => {
    for (const entry of ['a b@1.0.0', "a'b@1.0.0", 'a@1.0.0\nother: x', '*@1.0.0']) {
      assert.throws(() => withReleaseAgeExcludes(null, [entry]), MarketValidationError, entry)
    }
  })
})

describe('allowReleaseAges (file level)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-release-age-write-'))
    path = join(dir, 'profiles', 'dsh-app', 'pnpm-workspace.yaml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates the profile directory and file when absent, once', () => {
    assert.equal(existsSync(path), false)
    assert.equal(allowReleaseAges(path, ['dsh-plugin-x@0.7.3']), true)
    assert.equal(readFileSync(path, 'utf8'), withReleaseAgeExcludes(null, ['dsh-plugin-x@0.7.3']))
    assert.equal(allowReleaseAges(path, ['dsh-plugin-x@0.7.3']), false)
  })

  it('merges on disk without touching the settings around the list, and leaves no temp file', () => {
    mkdirSync(join(dir, 'profiles', 'dsh-app'), { recursive: true })
    writeFileSync(path, 'packages:\n  - .\n\nnodeLinker: hoisted\nonlyBuiltDependencies:\n  - esbuild\n', 'utf8')
    assert.equal(allowReleaseAges(path, ['dsh-plugin-x@0.7.3']), true)
    const text = readFileSync(path, 'utf8')
    assert.ok(text.startsWith('packages:\n  - .\n\nnodeLinker: hoisted\nonlyBuiltDependencies:\n  - esbuild\n'))
    assert.ok(text.includes("minimumReleaseAgeExclude:\n  - 'dsh-plugin-x@0.7.3'\n"))
    assert.deepEqual(readdirSync(join(path, '..')).filter(name => name.includes('.tmp')), [])
  })
})
