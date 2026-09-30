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
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

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
  const step = path.join(ROOT, 'scripts', 'ensure-electron.mjs')
  assert.ok(existsSync(step), `missing ${step}`)
  const source = readFileSync(step, 'utf8')
  // It must check for the two things a half-unpacked tree lacks, rather than
  // trusting that a directory exists.
  assert.match(source, /resources\.pak/u, 'a binary without resources.pak is half-unpacked and would fail at launch')
  assert.match(source, /install\.js/u, 'the package\'s own installer is what unpacks it')
  assert.match(source, /path\.txt/u, 'path.txt is the package\'s record of which binary to expect')
})

test('the unpack step is idempotent, so a healthy tree costs no work', () => {
  const source = readFileSync(path.join(ROOT, 'scripts', 'ensure-electron.mjs'), 'utf8')
  // An `if (!isUnpacked()) unpack()` guard: a complete dist/ must not be rewritten,
  // which also keeps parallel invocations (a probe beside a test) harmless.
  assert.match(source, /if \(!isUnpacked\(\)\) unpack\(\)/u,
    'the step must be a no-op when the binary is already unpacked')
})
