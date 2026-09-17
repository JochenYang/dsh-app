/**
 * Link-safety tests for the store's deletes: the data directories the store
 * removes (topics/, a project dir) may be LINKS the user planted there (a
 * shared or symlinked store area), and a delete must drop the link instead of
 * descending through it — the shape that cost a runtime tree once
 * (test/recursive-delete-guard.test.mjs holds the shipped contrast). Every
 * case below has its control: an ordinary directory still comes out empty.
 *
 * Linked pairs are built with the platform's own link kind; cleanup goes
 * through the walker under test.
 *
 * @module @dsh-app/plugin-memory/tests/remove-tree
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, removeProject } from '../src/memory-store.ts'
import { removeTree } from '../src/remove-tree.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'dshm-links-'))

/** `junction` on Windows (no privilege needed), a directory symlink elsewhere. */
const LINK_KIND = process.platform === 'win32' ? 'junction' : 'dir'

/** A directory standing in for "someone else's data the link points at". */
function outsideTree(root: string, name: string): string {
  const target = join(root, name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'card.md'), 'outside content\n', 'utf8')
  writeFileSync(join(target, 'index.md'), 'outside index\n', 'utf8')
  return target
}

/** What the linked directory still holds. */
function filesIn(target: string): string[] {
  return (existsSync(target) ? readdirSync(target) : []).sort()
}

const OUTSIDE_FILES = ['card.md', 'index.md']

/**
 * A deleter built on `stat` instead of `lstat` — the shape that reads a link
 * as a directory and descends THROUGH it. It exists to prove the fixtures
 * above are not vacuous: the sync recursive form the store used to call does
 * exactly this under the app's own Node (see the guard test's header), while
 * plain Node on this machine does not reproduce it.
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

test('the same fixture CAN lose the linked tree — the tests above discriminate', async (t) => {
  const root = scratch()
  t.after(() => removeTree(root))
  const target = outsideTree(root, 'outside')
  const link = join(root, 'linked')
  symlinkSync(target, link, LINK_KIND)

  await deleteFollowingLinks(link).catch(() => undefined)

  assert.deepEqual(filesIn(target), [], 'a link-following delete must empty the linked tree, or nothing above proves anything')
})

test('removeTree: a linked directory is unlinked, what it points at survives', async (t) => {
  const root = scratch()
  t.after(() => removeTree(root))
  const target = outsideTree(root, 'outside')
  const link = join(root, 'linked')
  symlinkSync(target, link, LINK_KIND)
  // The walker's safety rests on this reading: a link must not look like a
  // directory, or the delete descends silently.
  assert.equal(lstatSync(link).isSymbolicLink(), true)

  await removeTree(link)

  assert.equal(existsSync(link), false, 'the link itself is gone, never left dangling')
  assert.deepEqual(filesIn(target), OUTSIDE_FILES, 'the linked directory still holds every file it had')
})

test('removeTree: an ordinary tree is still deleted completely (control)', async (t) => {
  const root = scratch()
  t.after(() => removeTree(root))
  const tree = join(root, 'plain')
  mkdirSync(join(tree, 'nested'), { recursive: true })
  writeFileSync(join(tree, 'nested', 'card.md'), 'own content\n', 'utf8')

  await removeTree(tree)

  assert.equal(existsSync(tree), false, 'the plain tree is gone, nested files included')
  await removeTree(tree) // idempotent, like the force: true it replaced
})

test('MemoryStore.clear(): a linked topics dir is dropped, not emptied', async (t) => {
  const root = scratch()
  t.after(() => removeTree(root))
  const store = new MemoryStore(join(root, 'store'))
  mkdirSync(store.dir, { recursive: true })
  const shared = outsideTree(root, 'shared-topics')
  symlinkSync(shared, join(store.dir, 'topics'), LINK_KIND)
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: ['kept'] })}\n`, 'utf8')

  await store.clear()

  assert.equal(existsSync(join(store.dir, 'topics')), false, 'the linked topics dir is unlinked')
  assert.deepEqual(filesIn(shared), OUTSIDE_FILES, 'the shared directory is untouched')
  assert.equal(store.pinnedSet().size, 0, 'the reset still lands')
})

test('MemoryStore.clear(): a normal store is wiped to nothing (control)', async (t) => {
  const root = scratch()
  t.after(() => removeTree(root))
  const store = new MemoryStore(join(root, 'store'))
  await store.upsert({ name: 'one', category: 'lesson', summary: '一条', body: '第一条内容' })
  assert.equal(existsSync(join(store.dir, 'topics', 'one.md')), true)
  assert.equal(existsSync(join(store.dir, 'index.md')), true)

  await store.clear()

  assert.equal(existsSync(join(store.dir, 'topics')), false, 'the topics dir is gone')
  assert.equal(existsSync(join(store.dir, 'index.md')), false, 'the index is gone')
  assert.equal(store.list().length, 0)
})

test('removeProject: a linked project dir is dropped, not emptied', async (t) => {
  const root = scratch()
  t.after(() => removeTree(root))
  const rootDir = join(root, 'memory')
  mkdirSync(join(rootDir, 'projects'), { recursive: true })
  const shared = outsideTree(root, 'shared-project')
  const slug = 'demo-1234abcd'
  symlinkSync(shared, join(rootDir, 'projects', slug), LINK_KIND)

  await removeProject(rootDir, slug)

  assert.equal(existsSync(join(rootDir, 'projects', slug)), false, 'the project link is unlinked')
  assert.deepEqual(filesIn(shared), OUTSIDE_FILES, 'the linked project directory is untouched')
})
