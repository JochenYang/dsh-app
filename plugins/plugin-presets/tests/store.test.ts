/**
 * Store tests over real temp directories (created under the OS temp dir,
 * always removed afterwards): listing only exportable presets, export of
 * unknown entries, import writing files, the 409-conflict/overwrite
 * contract, and the guarantee that a hostile archive leaves the root
 * untouched with no staging residue.
 *
 * @module plugin-presets/tests/store
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { packPresetDir } from '../src/pack.ts'
import { PresetStore } from '../src/store.ts'
import { PresetPackageError } from '../src/wire.ts'

// One scratch root per test file; each test gets its own subdirectory.
const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-presets-store-'))
after(() => { rmSync(scratchRoot, { recursive: true, force: true }) })

function scratch(name: string): string {
  const dir = join(scratchRoot, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a minimal preset directory that discovery-grade checks accept. */
function writePreset(dir: string, entry: string, body: string): void {
  mkdirSync(join(dir, entry), { recursive: true })
  writeFileSync(join(dir, entry, 'agent.cordis.yml'), body, 'utf8')
}

function errorCode(error: unknown): string {
  assert.ok(error instanceof PresetPackageError, `expected PresetPackageError, got ${String(error)}`)
  return error.code
}

describe('list', () => {
  it('lists only whitelisted directories that carry the composition file', async () => {
    const root = scratch('list')
    writePreset(root, 'good', 'rows: []\n')
    mkdirSync(join(root, 'no-composition'), { recursive: true })
    mkdirSync(join(root, 'Bad Name'), { recursive: true })
    writeFileSync(join(root, 'Bad Name', 'agent.cordis.yml'), 'rows: []\n', 'utf8')
    writeFileSync(join(root, 'loose-file.txt'), 'not a preset', 'utf8')

    const store = new PresetStore(root)
    const presets = await store.list()
    assert.deepEqual(presets.map(p => p.entry), ['good'])
    assert.equal(presets[0].files, 1)
    assert.equal(presets[0].bytes, 'rows: []\n'.length)
  })

  it('answers an empty list for a missing root (first run)', async () => {
    const store = new PresetStore(join(scratchRoot, 'list-missing', 'nested'))
    assert.deepEqual(await store.list(), [])
  })
})

describe('export', () => {
  it('rejects an unknown entry and an invalid entry name', async () => {
    const root = scratch('export-missing')
    const store = new PresetStore(root)
    assert.equal(errorCode(await store.exportZip('ghost').catch(e => e)), 'unknown-entry')
    // A separator-bearing name fails the whitelist before any existence check.
    assert.equal(errorCode(await store.exportZip('../escape').catch(e => e)), 'entry-invalid')
    assert.ok(!existsSync(join(root, '.escape')))
  })

  it('never reaches outside the managed root even for a crafted name', async () => {
    const root = scratch('export-containment')
    writePreset(scratchRoot, 'outside', 'rows: []\n') // sibling of the root, not inside it
    const store = new PresetStore(root)
    // '..outside' fails the whitelist (leading dot) → entry-invalid.
    assert.equal(errorCode(await store.exportZip('..outside').catch(e => e)), 'entry-invalid')
    // A whitelisted name that only exists OUTSIDE the root stays unreachable.
    assert.equal(errorCode(await store.exportZip('outside').catch(e => e)), 'unknown-entry')
  })
})

describe('import', () => {
  it('writes a fresh preset and the store lists it afterwards', async () => {
    const sourceRoot = scratch('import-src')
    writePreset(sourceRoot, 'alpha', 'rows:\n  - name: persona\n')
    const bytes = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')

    const root = scratch('import-dst')
    const store = new PresetStore(root)
    const result = await store.importZip(bytes, false)
    assert.deepEqual(result, { entry: 'alpha', files: 1 })
    assert.equal(readFileSync(join(root, 'alpha', 'agent.cordis.yml'), 'utf8'), 'rows:\n  - name: persona\n')

    const listed = await store.list()
    assert.deepEqual(listed.map(p => p.entry), ['alpha'])
  })

  it('answers conflict on an existing entry, then replaces only with overwrite', async () => {
    const sourceRoot = scratch('conflict-src')
    writePreset(sourceRoot, 'alpha', 'rows: v1\n')
    const bytesV1 = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')
    writeFileSync(join(sourceRoot, 'alpha', 'agent.cordis.yml'), 'rows: v2\n', 'utf8')
    const bytesV2 = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')

    const root = scratch('conflict-dst')
    const store = new PresetStore(root)
    await store.importZip(bytesV1, false)

    const conflict = await store.importZip(bytesV2, false).catch(e => e)
    assert.equal(errorCode(conflict), 'conflict')
    assert.equal((conflict as PresetPackageError).details.entry, 'alpha')
    // The old content survives a refused import.
    assert.equal(readFileSync(join(root, 'alpha', 'agent.cordis.yml'), 'utf8'), 'rows: v1\n')

    await store.importZip(bytesV2, true)
    assert.equal(readFileSync(join(root, 'alpha', 'agent.cordis.yml'), 'utf8'), 'rows: v2\n')
  })

  it('leaves no staging or backup residue after a successful import', async () => {
    const sourceRoot = scratch('residue-src')
    writePreset(sourceRoot, 'alpha', 'rows: v1\n')
    const bytes = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')
    const root = scratch('residue-dst')
    const store = new PresetStore(root)
    await store.importZip(bytes, false)
    await store.importZip(bytes, true)
    const residue = readdirSync(root).filter(name => name.startsWith('.dshpreset-'))
    assert.deepEqual(residue, [])
  })

  it('refuses a hostile archive and leaves the managed root untouched', async () => {
    const sourceRoot = scratch('hostile-src')
    writePreset(sourceRoot, 'alpha', 'rows: v1\n')
    const bytes = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')

    const root = scratch('hostile-dst')
    const store = new PresetStore(root)
    await store.importZip(bytes, false)

    // Crafted archive: valid manifest, but a payload path that escapes the
    // staging area. The import must refuse before any write happens.
    const { strToU8, zipSync } = await import('fflate')
    const manifest = strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', entry: 'evil' }))
    const crafted = zipSync({
      'manifest.json': manifest,
      'preset/../alpha/agent.cordis.yml': strToU8('rows: pwned\n'),
    })
    const error = await store.importZip(crafted, false).catch(e => e)
    assert.equal(errorCode(error), 'illegal-path')
    // The existing preset is byte-identical, and nothing new appeared.
    assert.equal(readFileSync(join(root, 'alpha', 'agent.cordis.yml'), 'utf8'), 'rows: v1\n')
    assert.deepEqual(readdirSync(root).filter(name => name !== 'alpha'), [])
  })

  it('round-trips through two stores: export from one root, import into another', async () => {
    const sourceRoot = scratch('hop-a')
    const targetRoot = scratch('hop-b')
    writePreset(sourceRoot, 'traveler', 'rows:\n  - name: persona\n')
    mkdirSync(join(sourceRoot, 'traveler', 'skills'), { recursive: true })
    writeFileSync(join(sourceRoot, 'traveler', 'skills', 'note.md'), 'hello', 'utf8')

    const source = new PresetStore(sourceRoot)
    const target = new PresetStore(targetRoot)
    const bytes = await source.exportZip('traveler')
    const result = await target.importZip(bytes, false)
    assert.deepEqual(result, { entry: 'traveler', files: 2 })
    assert.equal(
      readFileSync(join(targetRoot, 'traveler', 'skills', 'note.md'), 'utf8'),
      readFileSync(join(sourceRoot, 'traveler', 'skills', 'note.md'), 'utf8'),
    )
    assert.deepEqual((await target.list()).map(p => p.entry), ['traveler'])
  })
})
