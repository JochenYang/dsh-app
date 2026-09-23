/**
 * Installed-tab projection tests: the two counts the tab must keep apart —
 * the label's installed total and the badge's actionable update backlog.
 *
 * @module plugin-market/tests/installed-projection
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { installedOwnerBadge, sameNameStateOf, updatablePackages, mergeUpdateFacts } from '../src/client/installed-projection.ts'

describe('updatablePackages', () => {
  it('counts only non-suite packages with a pending update', () => {
    const packages = [
      { name: 'updatable', updateAvailable: true, suite: false },
      { name: 'current', updateAvailable: false, suite: false },
      { name: 'unknown', suite: false },
      { name: 'suite-member', updateAvailable: true, suite: true },
    ]
    assert.deepEqual(updatablePackages(packages), [{ name: 'updatable', updateAvailable: true, suite: false }])
  })

  it('returns the original objects so the batch loop can pass them to /update', () => {
    const pkg = { name: 'a', updateAvailable: true, suite: false }
    assert.equal(updatablePackages([pkg])[0], pkg)
  })

  it('keeps the input order for a deterministic batch sequence', () => {
    const packages = [
      { name: 'b', updateAvailable: true, suite: false },
      { name: 'a', updateAvailable: true, suite: false },
    ]
    assert.deepEqual(updatablePackages(packages).map(pkg => pkg.name), ['b', 'a'])
  })
})

describe('mergeUpdateFacts (two-phase installed load)', () => {
  const rows = [
    { name: 'pkg-a', version: '^1.0.0', source: 'registry' as const, installedVersion: '1.0.0' },
    { name: 'pkg-b', version: '^2.0.0', source: 'registry' as const, installedVersion: '2.0.0' },
    { name: 'pkg-local', version: 'file:../x.tgz', source: 'local' as const, installedVersion: '0.1.0' },
  ]

  it('keeps the same array reference when the probe changes nothing', () => {
    const merged = mergeUpdateFacts(rows, [
      { name: 'pkg-a', latest: undefined },
      { name: 'pkg-b', latest: undefined },
    ])
    assert.equal(merged, rows)
  })

  it('attaches latest and updateAvailable only to rows the probe marks outdated', () => {
    const merged = mergeUpdateFacts(rows, [
      { name: 'pkg-a', latest: '1.4.0', updateAvailable: true },
      { name: 'pkg-b', latest: '2.0.0' },
    ])
    assert.equal(merged[0]?.latest, '1.4.0')
    assert.equal(merged[0]?.updateAvailable, true)
    // A probed current version is recorded but never reads as an update.
    assert.equal(merged[1]?.latest, '2.0.0')
    assert.equal(merged[1]?.updateAvailable, undefined)
    // Unprobed/local rows pass through untouched.
    assert.equal(merged[2], rows[2])
  })

  it('takes only update fields from the probe, keeping the local row as truth', () => {
    // The probe's row carries a different dependency spec / source; the local
    // facts must win for everything except latest/updateAvailable.
    const probed = [{ name: 'pkg-a', version: '^9.9.9', source: 'registry' as const, latest: '1.4.0', updateAvailable: true }]
    const merged = mergeUpdateFacts(rows, probed)
    assert.equal(merged[0]?.version, '^1.0.0')
    assert.equal((merged[0] as { source?: string } | undefined)?.source, 'registry')
    assert.equal(merged[0]?.latest, '1.4.0')
  })

  it('matches by normalized npm name and ignores probes for unknown rows', () => {
    const merged = mergeUpdateFacts(rows, [
      { name: 'PKG-A', latest: '1.4.0', updateAvailable: true },
      { name: 'not-installed', latest: '1.0.0', updateAvailable: true },
    ])
    assert.equal(merged[0]?.updateAvailable, true)
    assert.equal(merged.length, rows.length)
    assert.equal(merged.some(pkg => pkg.name === 'not-installed'), false)
  })
})

describe('sameNameStateOf (catalog card same-name verdict)', () => {
  const entry = { repoKey: 'github.com/o/r' }

  it('answers none without a same-named install', () => {
    assert.deepEqual(sameNameStateOf(entry, undefined), { kind: 'none' })
  })

  it('answers same-origin only when both repo keys are known and equal', () => {
    assert.deepEqual(sameNameStateOf(entry, { source: 'registry', repoKey: 'github.com/o/r' }), { kind: 'same-origin' })
  })

  it('answers cross-origin when the keys differ or one side is unknown', () => {
    assert.deepEqual(sameNameStateOf(entry, { source: 'registry', repoKey: 'gitlab.com/o/r' }), { kind: 'cross-origin' })
    assert.deepEqual(sameNameStateOf(entry, { source: 'registry' }), { kind: 'cross-origin' })
    assert.deepEqual(sameNameStateOf({}, { source: 'registry', repoKey: 'github.com/o/r' }), { kind: 'cross-origin' })
  })

  it('answers local-git and reports whether the repos agree', () => {
    assert.deepEqual(sameNameStateOf(entry, { source: 'git', repoKey: 'github.com/o/r' }), { kind: 'local-git', sameRepo: true })
    assert.deepEqual(sameNameStateOf(entry, { source: 'local' }), { kind: 'local-git', sameRepo: false })
    // A monorepo subpath key is a different install target than the repo root.
    assert.deepEqual(
      sameNameStateOf({ repoKey: 'github.com/o/r#path' }, { source: 'git', repoKey: 'github.com/o/r' }),
      { kind: 'local-git', sameRepo: false },
    )
  })
})

describe('installedOwnerBadge', () => {
  it('marks a suite plugin as the shell\'s own', () => {
    assert.equal(installedOwnerBadge({ suite: true }), 'suite')
  })

  it('marks every other row as the author\'s, whatever it came in as', () => {
    // npm, a git repo, a local tarball: all of them belong to whoever wrote the
    // package, and the badge is what stops their breakage reading as ours.
    assert.equal(installedOwnerBadge({ suite: false, source: 'registry' }), 'third-party')
    assert.equal(installedOwnerBadge({ suite: false, source: 'git' }), 'third-party')
    assert.equal(installedOwnerBadge({ suite: false, source: 'local' }), 'third-party')
    // A row that does not carry the flag at all is not a suite plugin either:
    // the shell sets it explicitly on the plugins it ships.
    assert.equal(installedOwnerBadge({}), 'third-party')
  })
})
