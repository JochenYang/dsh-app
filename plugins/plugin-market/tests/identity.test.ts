/**
 * Identity-rule tests: the repo-key normalization every same-name comparison
 * rides on, its conservative null stance, and the npm-name normalization.
 *
 * @module plugin-market/tests/identity
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { normalizeNpmName, repoKeyOf, sameOrigin } from '../src/identity.ts'

describe('repoKeyOf', () => {
  it('normalizes https repo and page URLs to a lowercase host/owner/repo key', () => {
    assert.equal(repoKeyOf('https://github.com/Owner/Repo'), 'github.com/owner/repo')
    assert.equal(repoKeyOf('https://github.com/o/r/'), 'github.com/o/r')
    assert.equal(repoKeyOf('https://www.github.com/o/r'), 'github.com/o/r')
    assert.equal(repoKeyOf('https://gitlab.com/o/r'), 'gitlab.com/o/r')
    assert.equal(repoKeyOf('https://gitee.com/o/r.git'), 'gitee.com/o/r')
  })

  it('normalizes a GitHub /tree/ page URL to the repo it belongs to', () => {
    assert.equal(repoKeyOf('https://github.com/o/r/tree/main/packages/x'), 'github.com/o/r')
  })

  it('reads git+ / ssh / scp / git-protocol specs', () => {
    assert.equal(repoKeyOf('git+https://github.com/o/r.git'), 'github.com/o/r')
    assert.equal(repoKeyOf('git+ssh://git@github.com/o/r.git'), 'github.com/o/r')
    assert.equal(repoKeyOf('git@github.com:o/r.git'), 'github.com/o/r')
    assert.equal(repoKeyOf('git://github.com/o/r.git'), 'github.com/o/r')
    assert.equal(repoKeyOf('git@gitee.com:o/r'), 'gitee.com/o/r')
  })

  it('keeps the full monorepo subpath in the key (different subdirs = different plugins)', () => {
    assert.equal(repoKeyOf('git+https://github.com/o/r.git#path:packages/x'), 'github.com/o/r#path:packages/x')
    assert.equal(repoKeyOf('https://github.com/o/r#path:x'), 'github.com/o/r#path:x')
    assert.notEqual(repoKeyOf('https://github.com/o/r#path:x'), repoKeyOf('https://github.com/o/r#path:y'))
    // Round-trip: a stored key re-normalizes to itself, so the install gate
    // and the card read one key identically.
    assert.equal(repoKeyOf('github.com/o/r'), 'github.com/o/r')
    // A bare `#path` fragment (no subdirectory) carries no identity beyond
    // the repo itself.
    assert.equal(repoKeyOf('github.com/o/r#path'), 'github.com/o/r')
  })

  it('reads the host shorthand some specs and repository fields carry', () => {
    assert.equal(repoKeyOf('github:o/r'), 'github.com/o/r')
    assert.equal(repoKeyOf('gitee:o/r.git'), 'gitee.com/o/r')
  })

  it('answers null for npm names and anything without a provable repo', () => {
    for (const value of ['lodash', '@scope/pkg', '', '   ', null, undefined, 'not a url', 'https://example.com/o/r', 'https://github.com/o']) {
      assert.equal(repoKeyOf(value as string | null | undefined), null, String(value))
    }
  })
})

describe('sameOrigin', () => {
  it('matches only two known identical keys', () => {
    assert.equal(sameOrigin('github.com/o/r', 'github.com/o/r'), true)
    assert.equal(sameOrigin('github.com/o/r', 'github.com/o/r#path'), false)
    assert.equal(sameOrigin('github.com/o/r', 'gitlab.com/o/r'), false)
  })

  it('never matches an unknown side, including two unknowns', () => {
    assert.equal(sameOrigin(null, null), false)
    assert.equal(sameOrigin(null, 'github.com/o/r'), false)
    assert.equal(sameOrigin('github.com/o/r', null), false)
  })
})

describe('normalizeNpmName', () => {
  it('lowercases and trims a name so map keys are casing-stable', () => {
    assert.equal(normalizeNpmName('  @Scope/Pkg '), '@scope/pkg')
    assert.equal(normalizeNpmName('Pkg'), 'pkg')
  })
})
