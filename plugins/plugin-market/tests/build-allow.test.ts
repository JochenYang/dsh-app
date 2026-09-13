/**
 * Build-script whitelist tests: the minimal workspace document created when
 * no pnpm-workspace.yaml exists, the merge into an existing
 * onlyBuiltDependencies list (deduped, everything else byte-preserved), the
 * key appended to files without one, YAML-safety quoting for scoped names,
 * and idempotency at both the pure and the file level.
 *
 * @module plugin-market/tests/build-allow
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MarketValidationError } from '../src/errors.ts'
import { allowBuilds, withAllowedBuilds } from '../src/build-allow.ts'

/** A realistic user-maintained workspace file the merge must not disturb. */
const EXISTING = `packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
onlyBuiltDependencies:
  - esbuild
  - '@scope/native'
`

describe('withAllowedBuilds (pure)', () => {
  it('creates the minimal document when the file is absent', () => {
    assert.equal(
      withAllowedBuilds(null, ['dsh-remote']),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nonlyBuiltDependencies:\n  - dsh-remote\n',
    )
    assert.equal(
      withAllowedBuilds(null, ['a', 'b']),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nonlyBuiltDependencies:\n  - a\n  - b\n',
    )
  })

  it('merges into an existing list, deduped and byte-preserving', () => {
    const next = withAllowedBuilds(EXISTING, ['dsh-remote', 'esbuild', '@scope/native'])
    assert.equal(next, `${EXISTING}  - dsh-remote\n`)
  })

  it('appends the key to a file without one', () => {
    const existing = 'packages:\n  - .\nnodeLinker: hoisted\n'
    const next = withAllowedBuilds(existing, ['dsh-remote'])
    assert.ok(next.startsWith(existing), 'existing content must be untouched')
    assert.equal(next, `${existing}onlyBuiltDependencies:\n  - dsh-remote\n`)
  })

  it('merges into a flow-style list', () => {
    const next = withAllowedBuilds('onlyBuiltDependencies: [esbuild]\n', ['dsh-remote'])
    assert.equal(next, 'onlyBuiltDependencies: [esbuild, dsh-remote]\n')
  })

  it('is idempotent: already-listed names change nothing', () => {
    assert.equal(withAllowedBuilds(EXISTING, ['esbuild', '@scope/native']), EXISTING)
    assert.equal(withAllowedBuilds(null, ['dsh-remote']), withAllowedBuilds(withAllowedBuilds(null, ['dsh-remote']), ['dsh-remote']))
  })

  it('adopts CRLF line endings for inserted rows and keeps existing bytes', () => {
    const crlf = EXISTING.replace(/\n/g, '\r\n')
    const next = withAllowedBuilds(crlf, ['dsh-remote'])
    assert.ok(next.startsWith(crlf))
    assert.ok(next.endsWith('  - dsh-remote\r\n'))
  })

  it('quotes scoped names as YAML requires and dedupes them against quoted rows', () => {
    const created = withAllowedBuilds(null, ['@scope/native'])
    assert.ok(created.includes("  - '@scope/native'\n"))
    const merged = withAllowedBuilds(created, ['@scope/native', 'other'])
    assert.equal(merged.includes('  - other\n'), true)
    assert.equal(merged.match(/@scope\/native/g)?.length, 1)
  })

  it('rejects names that could break out of the list row', () => {
    for (const name of ['a b', 'a:b', "a'b", 'a#b', '*alias', '~', 'x\ny']) {
      assert.throws(() => withAllowedBuilds(null, [name]), MarketValidationError, name)
    }
  })
})

describe('allowBuilds (file level)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-build-allow-'))
    path = join(dir, 'profiles', 'web', 'pnpm-workspace.yaml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates the profile directory and file when absent', () => {
    assert.equal(existsSync(path), false)
    assert.equal(allowBuilds(path, ['dsh-remote']), true)
    assert.equal(readFileSync(path, 'utf8'), withAllowedBuilds(null, ['dsh-remote']))
  })

  it('is idempotent on disk: a second identical write changes nothing', () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, EXISTING, 'utf8')
    assert.equal(allowBuilds(path, ['dsh-remote']), true)
    const afterFirst = readFileSync(path, 'utf8')
    assert.equal(allowBuilds(path, ['dsh-remote']), false)
    assert.equal(readFileSync(path, 'utf8'), afterFirst)
  })

  it('merges into an existing file without touching its other content', () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, EXISTING, 'utf8')
    allowBuilds(path, ['dsh-remote'])
    const text = readFileSync(path, 'utf8')
    assert.ok(text.startsWith('packages:\n  - .\nnodeLinker: hoisted\n'))
    assert.ok(text.includes("  - '@scope/native'\n"))
    assert.ok(text.includes('  - dsh-remote\n'))
  })

  it('leaves no temporary files behind', () => {
    allowBuilds(path, ['dsh-remote'])
    assert.equal(existsSync(path), true)
    assert.deepEqual(
      readdirSync(join(path, '..')).filter(name => name.includes('.tmp')),
      [],
    )
  })
})
