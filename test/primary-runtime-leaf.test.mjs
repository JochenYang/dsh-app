// The primary-runtime path the shell answers for the web transport.
//
// Since 0.2.2-rc.2 the host child writes that fourth positional into its own
// `DSH_PRIMARY_RUNTIME` and `dsh-tool-workspace-dependencies` reads
// `runtime.json` out of it; the office skills it used to derive from the same
// argument's parent now come from the kernel package's packaged `assets/`. So
// this function copies nothing, and what it must get right is narrower than
// before: answer the shell's fixed leaf, point it at the installed payload's own
// set, and never leave a link behind that outlives the payload it names.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { scratchDir } from './scratch.mjs'

const require = createRequire(import.meta.url)
const { preparePrimaryRuntime } = require('../dist/main/desktop-host.js')

/**
 * A path with every component in its long form.
 *
 * `realpathSync` leaves an 8.3 short root (`ADMINI~1`) alone on a Windows temp
 * path, so two names for one directory compare unequal unless both sides go
 * through `realpathSync.native` — the same rule `host-arg-shape.test.mjs` uses.
 */
function canonical(target) {
  return realpathSync.native(target)
}

/** Where the leaf lives inside the shell's data directory. */
function leafOf(dataDir) {
  return path.join(dataDir, 'dsh-app-office', 'primary-runtime')
}

/** A payload's own primary-runtime directory: `runtime.json` is the identity. */
function payload() {
  const dir = scratchDir('dsh-payload-')
  writeFileSync(path.join(dir, 'runtime.json'), '{"components":{"python":"3.12.14"}}\n')
  return dir
}

test('a payload is linked into the fixed leaf, and nothing is copied', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const set = payload()
  const leaf = await preparePrimaryRuntime(dataDir, set)

  assert.equal(leaf, leafOf(dataDir))
  assert.equal(lstatSync(leaf).isSymbolicLink(), true, 'the leaf is a link, not a copy')
  assert.equal(canonical(leaf), canonical(set), 'the link resolves to the payload set')
  // The set is what `load_workspace_dependencies` installs, and it is reachable
  // through the answered path.
  assert.ok(existsSync(path.join(leaf, 'runtime.json')))
  // The skills are the kernel package's own business now; the shell must not
  // leave a copy of them beside the leaf.
  assert.equal(existsSync(path.join(dataDir, 'dsh-app-office', 'office-skills')), false)
})

test('a second start with the same payload keeps one link in place', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const set = payload()
  const first = await preparePrimaryRuntime(dataDir, set)
  const second = await preparePrimaryRuntime(dataDir, set)

  assert.equal(first, second)
  assert.equal(lstatSync(second).isSymbolicLink(), true)
  assert.equal(canonical(second), canonical(set))
})

test('a new payload moves the leaf onto it', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const older = payload()
  const newer = payload()

  await preparePrimaryRuntime(dataDir, older)
  const leaf = await preparePrimaryRuntime(dataDir, newer)
  assert.equal(canonical(leaf), canonical(newer), 'the leaf follows the installed payload')
})

test('no payload answers the path and leaves no link behind', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const previous = payload()

  // A link an earlier payload wrote must not survive a version that carries no
  // Python set: its target directory is pruned, and a dangling junction is worse
  // than an absent one because the tool would report a path that looks real.
  await preparePrimaryRuntime(dataDir, previous)
  const leaf = await preparePrimaryRuntime(dataDir, undefined)

  assert.equal(leaf, leafOf(dataDir))
  assert.equal(existsSync(leaf), false, 'the stale link is gone')
  assert.equal(existsSync(path.join(dataDir, 'dsh-app-office', 'office-skills')), false)
})

test('a real directory a shell did not write is left alone', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const leaf = leafOf(dataDir)
  mkdirSync(leaf, { recursive: true })
  writeFileSync(path.join(leaf, 'foreign.txt'), 'keep me\n')

  // No payload: nothing to point at, and the shell only removes its own links.
  await preparePrimaryRuntime(dataDir, undefined)
  assert.ok(existsSync(path.join(leaf, 'foreign.txt')), 'a foreign directory survives')
})

test('a foreign directory is replaced by the payload link when one is named', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const leaf = leafOf(dataDir)
  mkdirSync(path.join(leaf, 'dependencies'), { recursive: true })
  writeFileSync(path.join(leaf, 'dependencies', 'stale.txt'), 'from an older layout\n')

  // The rc.1 layout left a real tree here with the interpreter inside it. A
  // payload's set replaces it wholesale rather than being merged into it.
  const set = payload()
  const answered = await preparePrimaryRuntime(dataDir, set)
  assert.equal(lstatSync(answered).isSymbolicLink(), true)
  assert.equal(existsSync(path.join(answered, 'dependencies', 'stale.txt')), false)
})

test('a data directory the shell cannot answer is refused', async () => {
  await assert.rejects(
    () => preparePrimaryRuntime(undefined, payload()),
    /needs the shell data directory/u,
  )
})

test('a link the shell owns is unlinked, never followed into', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const target = scratchDir('dsh-link-target-')
  writeFileSync(path.join(target, 'keep.txt'), 'do not delete through the link\n')
  const leaf = leafOf(dataDir)
  mkdirSync(path.dirname(leaf), { recursive: true })
  symlinkSync(target, leaf, process.platform === 'win32' ? 'junction' : 'dir')

  await preparePrimaryRuntime(dataDir, undefined)
  assert.equal(existsSync(leaf), false, 'the link is gone')
  assert.ok(existsSync(path.join(target, 'keep.txt')), 'its target was never touched')
})

test('the real tree a pre-0.2.2 line built is removed once no payload names one', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const leaf = leafOf(dataDir)
  // The old layout: a REAL directory holding the interpreter the child statSync'd
  // on every boot, with no runtime.json (there was no Python set).
  const interpreter = path.join(
    leaf, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node',
  )
  mkdirSync(path.dirname(interpreter), { recursive: true })
  writeFileSync(interpreter, 'stale')

  const answered = await preparePrimaryRuntime(dataDir, undefined)
  assert.equal(answered, leaf)
  assert.equal(existsSync(leaf), false, 'the dead interpreter tree is gone, not left in the data directory')
})

test('a payload-shaped tree at the leaf is never removed', async () => {
  const dataDir = scratchDir('dsh-web-data-')
  const leaf = leafOf(dataDir)
  // It carries the old interpreter marker AND a runtime.json, so it is either a
  // payload or something a user pointed at. The shell did not create it.
  const interpreter = path.join(
    leaf, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node',
  )
  mkdirSync(path.dirname(interpreter), { recursive: true })
  writeFileSync(interpreter, 'x')
  writeFileSync(path.join(leaf, 'runtime.json'), '{}\n')

  await preparePrimaryRuntime(dataDir, undefined)
  assert.ok(existsSync(path.join(leaf, 'runtime.json')), 'a payload-shaped tree survives')
})
