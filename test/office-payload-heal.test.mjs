// The office payload the web transport hands its child is materialized into the
// shell's data directory, and the child REFUSES to boot without
// `<assetRoot>/scripts/check_office.py`. The staleness rule alone cannot see an
// interrupted materialization — a half-copied tree is newer than its source, so
// it is never refreshed — and that directory survives both a reinstall and a
// kernel rollback, which makes a half copy a permanent brick whose only symptom
// is the child dying with ENOENT several seconds into its boot.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { prepareOfficePayload } = require('../dist/main/desktop-host.js')

/**
 * The interpreter a real start hands the leaf: `DshHostOptions.executable`, an
 * absolute Node. A 0.1.7-rc.1 child `statSync`s it on every boot — payload or no
 * payload — so `prepareOfficePayload` places it beside the materialized skills.
 */
const INTERPRETER = process.execPath

/** Where inside the leaf the child reads that interpreter. */
const LEAF_INTERPRETER = path.join(
  'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node',
)

/** A payload source: the marker the child validates, plus one skill file. */
function fakeSource() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-src-'))
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  writeFileSync(path.join(dir, 'scripts', 'check_office.py'), 'print("ok")\n')
  writeFileSync(path.join(dir, 'skill.md'), 'skill\n')
  return dir
}

/** The directory `prepareOfficePayload` materializes into. */
function materialized(dataDir) {
  return path.join(dataDir, 'dsh-app-office', 'office-skills')
}

test('a complete payload is materialized once and answered with the fixed leaf', async () => {
  const source = fakeSource()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  const leaf = await prepareOfficePayload(source, dataDir, undefined, INTERPRETER)
  // The leaf is not the payload: the child derives its asset root from the
  // leaf's own dirname, so answering with the payload's inner path would move
  // that root somewhere no artifact carries.
  assert.equal(leaf, path.join(dataDir, 'dsh-app-office', 'primary-runtime'))
  assert.ok(existsSync(path.join(materialized(dataDir), 'scripts', 'check_office.py')))
  assert.ok(existsSync(path.join(materialized(dataDir), 'skill.md')))
})

test('a leaf with no Python set still carries the interpreter the child checks', async () => {
  const source = fakeSource()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  const leaf = await prepareOfficePayload(source, dataDir, undefined, INTERPRETER)
  // Nothing linked the payload's own set, so `load_workspace_dependencies` finds
  // no runtime.json here. What must exist is the interpreter: the child stats it
  // while registering its skills and never serves anything without it.
  assert.equal(existsSync(path.join(leaf, 'runtime.json')), false)
  assert.ok(existsSync(path.join(leaf, LEAF_INTERPRETER)), 'the child stats this on every start')
  // A second start must not trip over the file the first one wrote there.
  assert.equal(await prepareOfficePayload(source, dataDir, undefined, INTERPRETER), leaf)
  assert.ok(existsSync(path.join(leaf, LEAF_INTERPRETER)))
})

test('a start that names no placeable interpreter is refused', async () => {
  const source = fakeSource()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  await assert.rejects(
    () => prepareOfficePayload(source, dataDir, undefined, path.join(dataDir, 'no-such-node')),
    /no Node to place/u,
  )
  await assert.rejects(
    () => prepareOfficePayload(source, dataDir),
    /no Node to place/u,
  )
})

test('a half-copied payload is refreshed instead of being trusted for good', async () => {
  const source = fakeSource()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  // What an interrupted copy leaves: a directory that exists, is NEWER than the
  // source, and has no marker in it. mtime alone would call this fresh forever.
  mkdirSync(materialized(dataDir), { recursive: true })
  writeFileSync(path.join(materialized(dataDir), 'skill.md'), 'skill\n')

  await prepareOfficePayload(source, dataDir, undefined, INTERPRETER)
  assert.ok(
    existsSync(path.join(materialized(dataDir), 'scripts', 'check_office.py')),
    'the marker must be there after the refresh',
  )
})

test('a source that is not a payload is refused before anything is written', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-empty-'))
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  await assert.rejects(() => prepareOfficePayload(empty, dataDir, undefined, INTERPRETER), /missing or incomplete/u)
  assert.equal(existsSync(materialized(dataDir)), false)
})
