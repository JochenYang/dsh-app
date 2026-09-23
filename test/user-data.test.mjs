// The shell's data directory has to have ONE spelling.
//
// Windows and default macOS volumes match names case-insensitively, so `DSH App`
// and `DSH APP` are one directory — and the migration that was meant to rename it
// could never fire, because it asked whether the target name already existed and
// the answer was always yes. The shell then passed a string the disk did not have,
// and Node's ESM cache keys modules by URL string: measured in an installed build,
// the kernel child instantiated @deepseek-ai/dsh-app-boot twice and every settings
// write was refused with "profile reload requires the root Include entry".
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { USER_DATA_DIR_NAME, alignUserDataDir } = require('../dist/main/user-data.js')

/** A throwaway application-data root, with the data directory under one spelling. */
function fixture(existingName) {
  const appDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-app-userdata-'))
  const dir = path.join(appDataDir, existingName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'settings.json'), '{"keep":true}\n')
  return { appDataDir, dir }
}

test('a data root that does not exist yet gets the brand spelling', () => {
  const missing = path.join(mkdtempSync(path.join(os.tmpdir(), 'dsh-app-userdata-')), 'never-created')
  assert.equal(alignUserDataDir(missing), path.join(missing, USER_DATA_DIR_NAME))
})

test('the brand spelling is left as it is', () => {
  const { appDataDir, dir } = fixture(USER_DATA_DIR_NAME)
  assert.equal(alignUserDataDir(appDataDir), dir)
  assert.equal(readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"keep":true}\n')
})

test('the legacy spelling is renamed onto the brand spelling, contents and all', () => {
  const { appDataDir } = fixture('DSH App')
  const target = path.join(appDataDir, USER_DATA_DIR_NAME)
  assert.equal(alignUserDataDir(appDataDir), target)
  // One entry, in the brand spelling: two directories spelling the same name is
  // the state that broke the kernel child's module cache.
  assert.deepEqual(readdirSync(appDataDir), [USER_DATA_DIR_NAME])
  assert.equal(readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"keep":true}\n')
  // Idempotent: the next start has nothing left to do.
  assert.equal(alignUserDataDir(appDataDir), target)
})

test('a rename that cannot be made adopts the spelling the disk has', () => {
  const { appDataDir, dir } = fixture('DSH App')
  // The staging name the two-step rename needs is taken by a directory that is not
  // empty — nothing can rename over that (EPERM on Windows, ENOTEMPTY elsewhere),
  // so the move cannot start.
  const staged = path.join(appDataDir, `${USER_DATA_DIR_NAME}.renaming`)
  mkdirSync(staged)
  writeFileSync(path.join(staged, 'in-the-way.txt'), 'in the way\n')
  assert.equal(alignUserDataDir(appDataDir), dir)
  // The data is where it was, and the caller now passes the path that exists —
  // a used directory is better than a half-moved one.
  assert.equal(readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"keep":true}\n')
  assert.equal(readFileSync(path.join(staged, 'in-the-way.txt'), 'utf8'), 'in the way\n')
})
