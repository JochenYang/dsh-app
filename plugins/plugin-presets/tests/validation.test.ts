/**
 * Validation-layer tests: the entry whitelist (the containment boundary for
 * every name this plugin reads from or writes to disk), archive path safety
 * (absolute paths, `..` segments, backslashes, dot-leading segments) and the
 * manifest shape rules.
 *
 * @module plugin-presets/tests/validation
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { strToU8 } from 'fflate'
import {
  entryNameProblem,
  parseManifest,
  sanitizeArchivePath,
  zipPathSafetyProblem,
} from '../src/wire.ts'
import { PresetPackageError } from '../src/wire.ts'

describe('entry whitelist', () => {
  it('accepts lowercase names with digits and hyphens (kernel roster rule)', () => {
    for (const entry of ['a', 'standard', 'my-preset', 'v2', 'a0']) {
      assert.equal(entryNameProblem(entry), undefined, entry)
    }
  })

  it('rejects dots and underscores: the kernel roster would silently skip them', () => {
    for (const entry of ['my_preset', 'v1.2', 'a0._-']) {
      assert.notEqual(entryNameProblem(entry), undefined, entry)
    }
  })

  it('accepts a 64-character name and rejects a 65-character one', () => {
    const name64 = `a${'b'.repeat(63)}`
    const name65 = `a${'b'.repeat(64)}`
    assert.equal(name64.length, 64)
    assert.equal(entryNameProblem(name64), undefined)
    assert.equal(name65.length, 65)
    assert.notEqual(entryNameProblem(name65), undefined)
  })

  it('rejects an empty name, uppercase, leading digit violations and separators', () => {
    for (const entry of ['', 'Standard', '_hidden', '.hidden', '-lead', 'a/b', 'a\\b', 'a b', '中文']) {
      assert.notEqual(entryNameProblem(entry), undefined, entry)
    }
  })
})

describe('archive path safety', () => {
  it('accepts normal relative paths and nested preset payloads', () => {
    for (const name of ['manifest.json', 'preset/agent.cordis.yml', 'preset/skills/x.md', 'preset/a/b/c.txt']) {
      assert.equal(zipPathSafetyProblem(name), undefined, name)
    }
  })

  it('rejects absolute paths (POSIX and drive-letter)', () => {
    for (const name of ['/etc/passwd', '/preset/x', 'C:/evil', 'C:\\evil', 'D:/preset/x']) {
      assert.notEqual(zipPathSafetyProblem(name), undefined, name)
    }
  })

  it('rejects .. segments anywhere in the path', () => {
    for (const name of ['..', 'preset/../../escape', 'preset/../evil.txt', 'a/../b']) {
      assert.notEqual(zipPathSafetyProblem(name), undefined, name)
    }
  })

  it('rejects backslashes (Windows separator smuggling)', () => {
    for (const name of ['preset\\x', 'a\\b\\c', '\\\\server\\share']) {
      assert.notEqual(zipPathSafetyProblem(name), undefined, name)
    }
  })

  it('rejects dot-leading segments and empty segments', () => {
    for (const name of ['preset/.hidden', 'preset/./x', 'preset/.ssh/id', 'a//b', 'preset/']) {
      assert.notEqual(zipPathSafetyProblem(name), undefined, name)
    }
  })

  it('rejects an empty path', () => {
    assert.notEqual(zipPathSafetyProblem(''), undefined)
  })
})

describe('manifest validation', () => {
  const valid = {
    formatVersion: 1,
    kind: 'dsh-preset',
    exportedAt: '2026-01-01T00:00:00.000Z',
    entry: 'demo',
  }

  it('accepts a well-formed manifest', () => {
    const manifest = parseManifest(strToU8(JSON.stringify(valid)))
    assert.equal(manifest.entry, 'demo')
    assert.equal(manifest.kind, 'dsh-preset')
    assert.equal(manifest.formatVersion, 1)
  })

  it('rejects non-JSON and non-object manifests', () => {
    assert.throws(() => parseManifest(strToU8('{nope')), (error: unknown) => error instanceof PresetPackageError)
    assert.throws(() => parseManifest(strToU8('[1,2]')), (error: unknown) => error instanceof PresetPackageError)
  })

  it('rejects a wrong format version and a wrong kind', () => {
    assert.throws(
      () => parseManifest(strToU8(JSON.stringify({ ...valid, formatVersion: 2 }))),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
    assert.throws(
      () => parseManifest(strToU8(JSON.stringify({ ...valid, kind: 'something-else' }))),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('rejects a missing or non-whitelisted entry', () => {
    const { entry, ...noEntry } = valid
    assert.throws(
      () => parseManifest(strToU8(JSON.stringify(noEntry))),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
    assert.throws(
      () => parseManifest(strToU8(JSON.stringify({ ...valid, entry: '../evil' }))),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('tolerates a missing exportedAt (informational field)', () => {
    const { exportedAt, ...rest } = valid
    const manifest = parseManifest(strToU8(JSON.stringify(rest)))
    assert.equal(manifest.entry, 'demo')
    assert.equal(manifest.exportedAt, '')
  })
})

describe('sanitizeArchivePath', () => {
  it('strips control characters and caps the echoed length', () => {
    assert.equal(sanitizeArchivePath('preset/a\x00b'), 'preset/a?b')
    const long = 'x'.repeat(200)
    assert.ok(sanitizeArchivePath(long).length <= 80)
  })
})
