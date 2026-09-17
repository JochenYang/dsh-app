/**
 * Link-safety tests for the preset store's deletes: the directories it
 * removes may be LINKS the user planted in the preset root (a shared preset
 * area, a junction into another drive), and a delete must drop the link
 * instead of descending through it — the sync recursive form emptied what a
 * link pointed at (test/recursive-delete-guard.test.mjs holds the shipped
 * contrast). Each case has its control: an ordinary directory is still
 * deleted completely, leaving no staging or backup residue.
 *
 * @module plugin-presets/tests/remove-tree
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { packPresetDir } from '../src/pack.ts'
import { removeTree } from '../src/remove-tree.ts'
import { PresetStore } from '../src/store.ts'

const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-presets-links-'))
after(() => removeTree(scratchRoot))

function scratch(name: string): string {
  const dir = join(scratchRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a minimal preset directory that discovery-grade checks accept. */
function writePreset(dir: string, entry: string, body: string): void {
  mkdirSync(join(dir, entry), { recursive: true })
  writeFileSync(join(dir, entry, 'agent.cordis.yml'), body, 'utf8')
}

/** `junction` on Windows (no privilege needed), a directory symlink elsewhere. */
const LINK_KIND = process.platform === 'win32' ? 'junction' : 'dir'

/** Residue the import contract promises never to leave behind. */
function stagingResidue(root: string): string[] {
  return readdirSync(root).filter(name => name.startsWith('.dshpreset-'))
}

/**
 * A deleter built on `stat` instead of `lstat` — the shape that reads a link
 * as a directory and descends THROUGH it. It proves the fixtures here are not
 * vacuous: the sync recursive form the store used to call does exactly this
 * under the app's own Node (see the guard test's header), which plain Node on
 * this machine does not reproduce.
 */
async function deleteFollowingLinks(target: string): Promise<void> {
  const stats = await stat(target)
  if (!stats.isDirectory()) {
    await rm(target, { force: true })
    return
  }
  for (const entry of await readdir(target)) await deleteFollowingLinks(join(target, entry))
  await rmdir(target)
}

describe('removeTree', () => {
  it('unlinks a link and leaves what it points at intact', async () => {
    const root = scratch('walker')
    const shared = join(root, 'shared')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'agent.cordis.yml'), 'rows: shared\n', 'utf8')
    const link = join(root, 'linked')
    symlinkSync(shared, link, LINK_KIND)

    await removeTree(link)

    assert.equal(existsSync(link), false, 'the link itself is gone, never left dangling')
    assert.deepEqual(readdirSync(shared), ['agent.cordis.yml'], 'the linked directory still holds its file')
    assert.equal(readFileSync(join(shared, 'agent.cordis.yml'), 'utf8'), 'rows: shared\n')
  })

  it('still deletes an ordinary tree completely (control)', async () => {
    const root = scratch('walker-control')
    const tree = join(root, 'plain')
    mkdirSync(join(tree, 'nested'), { recursive: true })
    writeFileSync(join(tree, 'nested', 'agent.cordis.yml'), 'rows: own\n', 'utf8')

    await removeTree(tree)

    assert.equal(existsSync(tree), false, 'the plain tree is gone, nested files included')
    await removeTree(tree) // idempotent, like the force: true it replaced
  })

  it('the same fixture CAN lose the linked tree — the tests above discriminate', async () => {
    const root = scratch('walker-follow')
    const shared = join(root, 'shared')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'agent.cordis.yml'), 'rows: shared\n', 'utf8')
    const link = join(root, 'linked')
    symlinkSync(shared, link, LINK_KIND)

    await deleteFollowingLinks(link).catch(() => undefined)

    assert.deepEqual(readdirSync(shared), [], 'a link-following delete must empty the linked tree, or nothing above proves anything')
  })
})

describe('import overwrite', () => {
  it('unlinks an entry that is a link instead of emptying what it points at', async () => {
    const sourceRoot = scratch('link-src')
    writePreset(sourceRoot, 'alpha', 'rows: v1\n')
    const bytes = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')

    // The shared area stands for a preset root the user linked into this one.
    const shared = join(scratchRoot, 'shared-preset')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'agent.cordis.yml'), 'rows: shared\n', 'utf8')
    const root = scratch('link-dst')
    symlinkSync(shared, join(root, 'alpha'), LINK_KIND)

    const store = new PresetStore(root)
    await store.importZip(bytes, true)

    assert.equal(readFileSync(join(root, 'alpha', 'agent.cordis.yml'), 'utf8'), 'rows: v1\n', 'the import landed')
    assert.deepEqual(readdirSync(shared), ['agent.cordis.yml'], 'the linked preset directory still holds its file')
    assert.equal(readFileSync(join(shared, 'agent.cordis.yml'), 'utf8'), 'rows: shared\n', 'and its content is untouched')
    assert.deepEqual(stagingResidue(root), [], 'the replaced link was unlinked, not kept as backup')
  })

  it('deletes a replaced ordinary directory completely (control)', async () => {
    const sourceRoot = scratch('plain-src')
    writePreset(sourceRoot, 'alpha', 'rows: v1\n')
    const bytes = await packPresetDir(join(sourceRoot, 'alpha'), 'alpha')

    const root = scratch('plain-dst')
    writePreset(root, 'alpha', 'rows: old\n')
    const store = new PresetStore(root)
    await store.importZip(bytes, true)

    assert.equal(readFileSync(join(root, 'alpha', 'agent.cordis.yml'), 'utf8'), 'rows: v1\n', 'the import landed')
    assert.deepEqual(readdirSync(root), ['alpha'], 'the replaced directory left nothing behind')
    assert.deepEqual(stagingResidue(root), [], 'no staging or backup residue')
  })
})
