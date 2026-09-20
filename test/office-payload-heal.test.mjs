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
  const leaf = await prepareOfficePayload(source, dataDir)
  // The leaf is not the payload: the child derives its asset root from the
  // leaf's own dirname, so answering with the payload's inner path would move
  // that root somewhere no artifact carries.
  assert.equal(leaf, path.join(dataDir, 'dsh-app-office', 'primary-runtime'))
  assert.ok(existsSync(path.join(materialized(dataDir), 'scripts', 'check_office.py')))
  assert.ok(existsSync(path.join(materialized(dataDir), 'skill.md')))
})

test('a half-copied payload is refreshed instead of being trusted for good', async () => {
  const source = fakeSource()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  // What an interrupted copy leaves: a directory that exists, is NEWER than the
  // source, and has no marker in it. mtime alone would call this fresh forever.
  mkdirSync(materialized(dataDir), { recursive: true })
  writeFileSync(path.join(materialized(dataDir), 'skill.md'), 'skill\n')

  await prepareOfficePayload(source, dataDir)
  assert.ok(
    existsSync(path.join(materialized(dataDir), 'scripts', 'check_office.py')),
    'the marker must be there after the refresh',
  )
})

test('a source that is not a payload is refused before anything is written', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-empty-'))
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-data-'))
  await assert.rejects(() => prepareOfficePayload(empty, dataDir), /missing or incomplete/u)
  assert.equal(existsSync(materialized(dataDir)), false)
})
