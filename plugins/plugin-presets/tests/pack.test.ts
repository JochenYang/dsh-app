/**
 * Pack/unpack tests: export packing over a real preset tree, the
 * pack→unpack round trip (byte identity), the archive size and file-count
 * caps, and rejection of hostile archives (path traversal, missing/bad
 * manifest, files outside the preset payload) BEFORE anything is inflated.
 *
 * @module plugin-presets/tests/pack
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { packPresetDir, unpackPresetZip, walkPresetFiles } from '../src/pack.ts'
import { PresetPackageError } from '../src/wire.ts'
import { patchCentralOriginalSize, setDataDescriptorFlag, zipWithDuplicatedCentralEntry } from './zip-craft.ts'

// One scratch root per test file; each test gets its own subdirectory.
const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-presets-pack-'))
after(() => { rmSync(scratchRoot, { recursive: true, force: true }) })

function scratch(name: string): string {
  const dir = join(scratchRoot, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A small but complete preset tree: composition, metadata, nested skill, binary file. */
function writePresetTree(dir: string): void {
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), 'rows:\n  - name: persona\n', 'utf8')
  writeFileSync(join(dir, 'preset.yml'), 'description: 测试预设\n', 'utf8')
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 127, 128, 42]))
}

describe('walkPresetFiles', () => {
  it('collects every regular file with relative paths, sorted', async () => {
    const dir = scratch('walk')
    writePresetTree(dir)
    const walked = await walkPresetFiles(dir)
    assert.deepEqual(walked.map(f => f.rel), [
      'agent.cordis.yml',
      'blob.bin',
      'preset.yml',
      'skills/demo/SKILL.md',
    ])
    const blob = walked.find(f => f.rel === 'blob.bin')
    assert.ok(blob !== undefined && blob.size === 8)
  })

  it('answers an empty tree with an empty list', async () => {
    const dir = scratch('walk-empty')
    assert.deepEqual(await walkPresetFiles(dir), [])
  })
})

describe('pack → unpack round trip', () => {
  it('restores the same entry name and byte-identical files', async () => {
    const dir = scratch('roundtrip-src')
    writePresetTree(dir)
    const bytes = await packPresetDir(dir, 'demo')
    assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 10 * 1024 * 1024)

    const unpacked = unpackPresetZip(bytes)
    assert.equal(unpacked.entry, 'demo')
    assert.deepEqual(unpacked.files.map(f => f.rel).sort(), [
      'agent.cordis.yml',
      'blob.bin',
      'preset.yml',
      'skills/demo/SKILL.md',
    ])
    for (const file of unpacked.files) {
      const original = await import('node:fs/promises').then(fs => fs.readFile(join(dir, file.rel)))
      assert.ok(Buffer.compare(Buffer.from(file.data), original) === 0, file.rel)
    }
  })

  it('survives a second hop: unpack → re-zip → unpack yields the same payload', async () => {
    // Simulates a share: our archive is unpacked by a recipient who re-zips
    // the payload with the same manifest — the second unpack must agree.
    const dir = scratch('roundtrip-2-src')
    writePresetTree(dir)
    const firstBytes = await packPresetDir(dir, 'hop')
    const manifestRaw = unzipSync(firstBytes)['manifest.json']
    const first = unpackPresetZip(firstBytes)
    const second = unpackPresetZip(zipSync({
      'manifest.json': manifestRaw,
      ...Object.fromEntries(first.files.map(f => [`preset/${f.rel}`, f.data])),
    }))
    assert.equal(second.entry, 'hop')
    assert.deepEqual(second.files.map(f => f.rel).sort(), first.files.map(f => f.rel).sort())
    for (const file of second.files) {
      const twin = first.files.find(f => f.rel === file.rel)
      assert.ok(twin !== undefined && Buffer.compare(Buffer.from(file.data), Buffer.from(twin.data)) === 0, file.rel)
    }
  })
})

describe('pack caps', () => {
  it('rejects a preset tree over the file-count cap', async () => {
    const dir = scratch('too-many')
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(dir, `f${String(index)}.txt`), 'x')
    }
    await assert.rejects(
      () => packPresetDir(dir, 'toomany'),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'too-many-files',
    )
  })
})

describe('unpack caps and hostile archives', () => {
  it('rejects a payload over the decompressed-size cap before inflating anything', () => {
    // ~21MB of zeros compresses to a few KB: the archive is under the upload
    // cap, the declared uncompressed size is not — the census pass must
    // refuse it from metadata alone.
    const bytes = zipSync({ 'preset/big.bin': new Uint8Array(21 * 1024 * 1024) })
    assert.ok(bytes.byteLength < 1024 * 1024)
    assert.throws(
      () => unpackPresetZip(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'too-large',
    )
  })

  it('rejects an archive over the file-count cap', () => {
    const members: Record<string, Uint8Array> = {}
    for (let index = 0; index < 201; index += 1) {
      members[`preset/f${String(index)}.txt`] = strToU8('x')
    }
    members['manifest.json'] = strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'x' }))
    assert.throws(
      () => unpackPresetZip(zipSync(members)),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'too-many-files',
    )
  })

  it('accepts exactly 200 payload files', () => {
    const members: Record<string, Uint8Array> = {}
    for (let index = 0; index < 200; index += 1) {
      members[`preset/f${String(index)}.txt`] = strToU8('x')
    }
    members['manifest.json'] = strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'x' }))
    const unpacked = unpackPresetZip(zipSync(members))
    assert.equal(unpacked.files.length, 200)
  })

  it('rejects path traversal shapes with illegal-path', () => {
    const manifest = strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'evil' }))
    for (const hostile of ['preset/../evil.txt', 'C:/evil.txt', '\\evil', '/abs/evil', 'preset/.hidden/x', 'other/row.txt']) {
      assert.throws(
        () => unpackPresetZip(zipSync({ 'manifest.json': manifest, [hostile]: strToU8('x') })),
        (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path',
        hostile,
      )
    }
  })

  it('rejects a missing manifest and a non-JSON manifest', () => {
    assert.throws(
      () => unpackPresetZip(zipSync({ 'preset/a.txt': strToU8('x') })),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
    assert.throws(
      () => unpackPresetZip(zipSync({ 'manifest.json': strToU8('{oops'), 'preset/a.txt': strToU8('x') })),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('rejects a manifest whose entry violates the whitelist', () => {
    const manifest = strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: '../evil' }))
    assert.throws(
      () => unpackPresetZip(zipSync({ 'manifest.json': manifest, 'preset/a.txt': strToU8('x') })),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('rejects data that is not a ZIP at all', () => {
    assert.throws(
      () => unpackPresetZip(strToU8('definitely not a zip')),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('rejects a payload member whose real content exceeds its declared size', () => {
    // A lying-small declared size slips past the census cap; the bounded
    // inflate counts the real bytes and aborts (a plain unzipSync pass would
    // silently truncate and restore corrupt bytes).
    const bytes = patchCentralOriginalSize(zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'demo' })),
      'preset/big.bin': new Uint8Array(2 * 1024 * 1024),
    }), 'preset/big.bin', 100)
    assert.throws(
      () => unpackPresetZip(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'zip.sizeMismatch'
        && error.host.params?.subject === 'subject.preset'
        && error.host.params?.name === 'preset/big.bin',
    )
  })

  it('rejects a payload member whose real content falls short of its declared size', () => {
    const bytes = patchCentralOriginalSize(zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'demo' })),
      'preset/a.txt': strToU8('x'),
    }), 'preset/a.txt', 5 * 1024 * 1024)
    assert.throws(
      () => unpackPresetZip(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'zip.sizeMismatch'
        && error.host.params?.subject === 'subject.preset'
        && error.host.params?.name === 'preset/a.txt',
    )
  })

  it('rejects duplicate member names at the census', () => {
    const bytes = zipWithDuplicatedCentralEntry(zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'demo' })),
      'preset/a.txt': strToU8('x'),
    }), 'preset/a.txt')
    assert.throws(
      () => unpackPresetZip(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'preset.duplicateMember'
        && error.host.params?.name === 'preset/a.txt',
    )
  })

  it('rejects data-descriptor members whose compressed size is not declared up front', () => {
    const bytes = setDataDescriptorFlag(zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'demo' })),
      'preset/a.txt': strToU8('x'),
    }), 'preset/a.txt')
    assert.throws(
      () => unpackPresetZip(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'zip.dataDescriptor'
        && error.host.params?.subject === 'subject.preset'
        && error.host.params?.name === 'preset/a.txt',
    )
  })
})
