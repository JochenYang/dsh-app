// Entry classification and the walk that records a packaged tree.
//
// The case that motivated both: pnpm lays out `node_modules/.bin` with SYMLINKS
// on POSIX and with real `.cmd`/`.ps1` files on Windows, so the runtime
// inventory met a link only on the four POSIX CI cells, where it failed the
// whole build — "runtime tree holds a non-file entry: app/node_modules/.bin/
// anthropic-ai-sdk" (run 35189579648) — while both Windows cells stayed green on
// the same commit.
//
// A Windows machine can still test every branch: the classifier takes a dirent
// shape (no filesystem needed), and a directory junction is a real link this
// platform creates without elevation, so the walk itself is exercised against a
// tree that really holds one.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  classifyTreeEntry,
  collectTreeEntries,
  linkTargetWithinTree,
  TREE_ENTRY_DIR,
  TREE_ENTRY_FILE,
  TREE_ENTRY_LINK,
  TREE_ENTRY_OTHER,
} from '../scripts/lib/tree-entry.mjs'

/** A readdir/lstat shape: only the three answers the classifier asks for. */
const shape = ({ file = false, dir = false, link = false }) => ({
  isFile: () => file,
  isDirectory: () => dir,
  isSymbolicLink: () => link,
})

/** A real file link, or false where the platform refuses (Windows: Developer Mode). */
function fileLink(target, link) {
  try {
    symlinkSync(target, link)
    return true
  } catch {
    return false
  }
}

/** A real directory link every Windows install can create without elevation. */
function junction(target, link) {
  try {
    symlinkSync(target, link, 'junction')
    return true
  } catch {
    return false
  }
}

test('classifyTreeEntry tells a file, a directory, a link and an other apart', () => {
  assert.equal(classifyTreeEntry(shape({ file: true })), TREE_ENTRY_FILE)
  assert.equal(classifyTreeEntry(shape({ dir: true })), TREE_ENTRY_DIR)
  assert.equal(classifyTreeEntry(shape({ link: true })), TREE_ENTRY_LINK)
  // The link test is first on purpose: a stat() — not lstat() — shape reports a
  // symlink to a directory as isDirectory() too, and the artifact carries the
  // link, not what it points at.
  assert.equal(classifyTreeEntry(shape({ dir: true, link: true })), TREE_ENTRY_LINK)
  // A FIFO, a socket, a device node: neither content nor a name to record.
  assert.equal(classifyTreeEntry(shape({})), TREE_ENTRY_OTHER)
})

test('classifyTreeEntry reads what readdir actually reports', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-tree-entry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'sub'))
  writeFileSync(path.join(root, 'file.txt'), 'x')
  if (!junction(path.join(root, 'sub'), path.join(root, 'link'))) {
    t.skip('this platform creates no directory link without elevation')
    return
  }
  const kinds = Object.fromEntries((await readdir(root, { withFileTypes: true }))
    .map((entry) => [entry.name, classifyTreeEntry(entry)]))
  assert.deepEqual(kinds, { 'file.txt': TREE_ENTRY_FILE, link: TREE_ENTRY_LINK, sub: TREE_ENTRY_DIR })
})

test('linkTargetWithinTree keeps an in-tree link relative to itself', () => {
  const root = path.join(path.resolve(tmpdir()), 'tree-entry-root')
  const bin = path.join(root, 'app', 'node_modules', '.bin', 'anthropic-ai-sdk')
  // The pnpm shape: `../<package>/<bin>` is recorded verbatim.
  assert.equal(linkTargetWithinTree(root, bin, '../@anthropic-ai/sdk/cli.js'), '../@anthropic-ai/sdk/cli.js')
  // An absolute target inside the tree is accepted, but rewritten: the build
  // host's own prefix must not reach the inventory.
  assert.equal(
    linkTargetWithinTree(root, bin, path.join(root, 'app', 'node_modules', '@anthropic-ai', 'sdk', 'cli.js')),
    '../@anthropic-ai/sdk/cli.js',
  )
  assert.equal(linkTargetWithinTree(root, bin, path.join(path.resolve(tmpdir()), 'elsewhere', 'cli.js')), null)
  assert.equal(linkTargetWithinTree(root, bin, '../../../../etc/passwd'), null)
})

test('collectTreeEntries records a link instead of refusing the tree', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-tree-entry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'app', 'node_modules', '.bin')
  const pkg = path.join(root, 'app', 'node_modules', 'pkg')
  mkdirSync(bin, { recursive: true })
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, 'cli.js'), 'console.log(1)\n')
  writeFileSync(path.join(root, 'app', 'runtime-files.json'), '{}\n')

  // The exact shape pnpm leaves behind, link target included; where this
  // platform refuses a file link, a junction onto the package directory stands
  // in — it is the same classification, and the walk must not descend into it.
  const fileShape = fileLink('../pkg/cli.js', path.join(bin, 'pkg-cli'))
  const linkPath = fileShape ? 'app/node_modules/.bin/pkg-cli' : 'app/node_modules/.bin/pkg'
  const target = fileShape ? '../pkg/cli.js' : '../pkg'
  if (!fileShape && !junction(pkg, path.join(bin, 'pkg'))) {
    t.skip('this platform creates no link without elevation')
    return
  }

  const { files, links } = await collectTreeEntries(root, { skip: ['app/runtime-files.json'] })
  assert.deepEqual(files.map((entry) => entry.path), ['app/node_modules/pkg/cli.js'])
  assert.equal(files[0].sha256, createHash('sha256').update('console.log(1)\n').digest('hex'))
  assert.equal(files[0].size, 15)
  assert.deepEqual(links, [{ path: linkPath, target }])
})

test('collectTreeEntries refuses a link that leaves the tree', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-tree-entry-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'dsh-outside-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'app'))
  // A file link is what a POSIX build would have to produce here; a junction on
  // the directory beside it is the Windows stand-in. Both must be rejected: a
  // link out of the tree is dangling on the user's machine, and that — not the
  // link itself — is what the artifact must never carry.
  const fileShape = fileLink(path.relative(path.join(root, 'app'), path.join(outside, 'cli.js')), path.join(root, 'app', 'cli.js'))
  if (!fileShape && !junction(outside, path.join(root, 'app', 'elsewhere'))) {
    t.skip('this platform creates no link without elevation')
    return
  }
  await assert.rejects(
    collectTreeEntries(root),
    /runtime tree holds a link that leaves it: app\/(cli\.js|elsewhere)/u,
  )
})
