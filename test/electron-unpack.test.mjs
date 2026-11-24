// The Electron-unpack step that `npm test` runs first.
//
// Why this exists as a test: the failure it prevents is invisible in a log that
// only reports the failing FILE. `node --test` gives every test file its own
// process, several of them `require('electron')`, and the package ships no install
// script — so on a fresh checkout (CI: `npm ci`, then `npm test`) they all reach
// `install.js` at once, unpacking into the same directory:
//
//   Error: failed to create '.../electron/dist/resources.pak': File exists (os error 17)
//   Error: Electron failed to install correctly.
//
// That fires while a module LOADS, so the job reports whichever file happened to
// load the package first — measured on CI run 36670178423, which failed at
// `test/host-arg-shape.test.mjs` while the same tree passed locally.
//
// The step itself runs here, on a throwaway checkout: a copy of the script beside
// an `electron` package whose installer records every run. That is what tells "a
// healthy tree costs one stat" from a step that only says so. Matching the step's
// source text (what this file used to do) could not: measured, a `return false` at
// the top of `isUnpacked()` — the step unpacking on every run — left it green.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scratchDir } from './scratch.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const STEP = path.join(ROOT, 'scripts', 'ensure-electron.mjs')
/** The executable name the throwaway package records in its `path.txt`. */
const BINARY = 'electron-fixture'

test('npm test unpacks Electron once before the parallel test files run', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const script = pkg.scripts.test
  assert.match(script, /ensure-electron\.mjs/u,
    'without this step several test files race to unpack the same Electron binary')
  // Order matters: the unpack must be done BEFORE `node --test` starts its files.
  const unpackAt = script.indexOf('ensure-electron')
  const runnerAt = script.indexOf('node --test')
  assert.ok(unpackAt !== -1 && runnerAt !== -1 && unpackAt < runnerAt,
    'the unpack must run before the test runner, not after it')

  // And the step must be a real, committed script.
  assert.ok(existsSync(STEP), `missing ${STEP}`)
})

/**
 * A throwaway checkout holding only what the step reads: its own copy of the
 * script, and an `electron` package whose installer appends a line to
 * `installs.log` for every run.
 *
 * @param {object} [options]
 * @param {boolean} [options.complete] start with the binary and its data files.
 * @param {boolean} [options.installerCompletes] whether the installer writes them.
 * @returns the fixture: its directories, a way to run the step, and the run count.
 */
function checkout({ complete = false, installerCompletes = true } = {}) {
  const dir = scratchDir('dsh-ensure-electron-')
  // The step finds its package relative to its own location, so the copy sits
  // where the real one does.
  mkdirSync(path.join(dir, 'scripts'))
  copyFileSync(STEP, path.join(dir, 'scripts', 'ensure-electron.mjs'))
  const electron = path.join(dir, 'node_modules', 'electron')
  mkdirSync(electron, { recursive: true })
  // `path.txt` is the package's record of which binary to expect.
  writeFileSync(path.join(electron, 'path.txt'), `${BINARY}\n`)
  // The package's own installer: run by the step with this directory as its cwd.
  writeFileSync(path.join(electron, 'install.js'), [
    '"use strict";',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "fs.appendFileSync('installs.log', 'install\\n')",
    ...(installerCompletes ? [
      "fs.mkdirSync('dist', { recursive: true })",
      `fs.writeFileSync(path.join('dist', ${JSON.stringify(BINARY)}), '')`,
      "fs.writeFileSync(path.join('dist', 'resources.pak'), '')",
    ] : []),
    '',
  ].join('\n'))
  if (complete) {
    mkdirSync(path.join(electron, 'dist'))
    writeFileSync(path.join(electron, 'dist', BINARY), '')
    writeFileSync(path.join(electron, 'dist', 'resources.pak'), '')
  }
  return {
    dir,
    electron,
    run: () => spawnSync(process.execPath, [path.join(dir, 'scripts', 'ensure-electron.mjs')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }),
    installs: () => {
      const log = path.join(electron, 'installs.log')
      return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').length : 0
    },
  }
}

test('a missing binary is unpacked once, and the step verifies the tree it asked for', () => {
  const fixture = checkout()
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fixture.installs(), 1)
  assert.ok(existsSync(path.join(fixture.electron, 'dist', BINARY)), 'the binary the step expects is there')
  assert.ok(existsSync(path.join(fixture.electron, 'dist', 'resources.pak')),
    'resources.pak is what the concurrent run failed to create; a binary without it fails at launch')
})

test('a complete tree costs no work: the installer is not run again', () => {
  const fixture = checkout({ complete: true })
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fixture.installs(), 0, 'a healthy tree must not be unpacked a second time')
})

test('a binary without its data files is half-unpacked, so the step unpacks again', () => {
  const fixture = checkout()
  mkdirSync(path.join(fixture.electron, 'dist'))
  writeFileSync(path.join(fixture.electron, 'dist', BINARY), '')
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fixture.installs(), 1)
  assert.ok(existsSync(path.join(fixture.electron, 'dist', 'resources.pak')))
})

test('an installer that leaves the tree incomplete is reported, not trusted', () => {
  const fixture = checkout({ installerCompletes: false })
  const result = fixture.run()
  assert.notEqual(result.status, 0, 'a step that only ran the installer would pass here')
  assert.match(result.stderr, /resources\.pak/u, 'the diagnostic names what is missing')
})
