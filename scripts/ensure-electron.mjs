#!/usr/bin/env node
/**
 * Make sure Electron's binary is unpacked BEFORE anything loads the package.
 *
 * Why this is a step of its own rather than a line in `npm test`: the `electron`
 * package ships no install script, so `npm ci` only places the package and its
 * downloaded zip — the binary is unpacked lazily, on the first `require('electron')`
 * (`node_modules/electron/index.js`, which calls `install.js` when `path.txt` names
 * an executable that is not there yet).
 *
 * That laziness is fine for one process and broken for many: `node --test` runs
 * each test FILE in its own process, several of them load `electron`, and on a
 * fresh checkout they all reach `install.js` at the same time. Unpacking into the
 * same directory concurrently fails halfway —
 *
 *   Error: failed to create '.../electron/dist/resources.pak': File exists (os error 17)
 *   Error: Electron failed to install correctly.
 *
 * — and because that happens while a module is LOADING, the failure surfaces as
 * whichever test file happened to load the package first, with no test-level
 * assertion anywhere near the cause. Measured on CI run 36670178423: the job
 * failed at `test/host-arg-shape.test.mjs` while the same tree passed locally,
 * and a local reproduction (rm -rf node_modules/electron/dist, then four
 * concurrent `node -e "require('electron')"`) left dist/ with 19 of its 55
 * entries. Exactly one process may unpack; every other process must wait.
 *
 * So: run the installer once, from one process, and verify the result. Idempotent
 * — a complete `dist/` costs one `stat`.
 *
 * Usage: node scripts/ensure-electron.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const electronDir = path.join(root, 'node_modules', 'electron')

/**
 * The executable `path.txt` names, or null when the package is not installed.
 *
 * `path.txt` is the package's own record of which binary to expect; reading it
 * rather than hardcoding `electron.exe`/`electron` keeps this correct on every
 * platform the app ships. An absent `path.txt` means the install never ran at all
 * (a source checkout with no dependencies), which is not this script's problem.
 * @returns the expected executable's path, or null.
 */
function expectedBinary() {
  const pathFile = path.join(electronDir, 'path.txt')
  if (!existsSync(pathFile)) return null
  const name = readFileSync(pathFile, 'utf8').trim()
  if (name === '') return null
  return path.join(electronDir, 'dist', name)
}

/** True when the binary and the data files beside it are present. */
function isUnpacked() {
  const binary = expectedBinary()
  if (binary === null || !existsSync(binary)) return false
  // `resources.pak` is what the concurrent run failed to create; a binary without
  // it is a half-unpacked tree that would fail at launch instead of here.
  return existsSync(path.join(electronDir, 'dist', 'resources.pak'))
}

/**
 * Unpack the binary once, in THIS process, and verify it landed.
 *
 * Not run through `require('electron')`: that throws on failure with a message
 * telling the user to reinstall by hand, while `install.js` reports what actually
 * went wrong (a proxy, a mirror, a bad zip) and exits non-zero.
 * @throws when the install fails or leaves an incomplete tree.
 */
function unpack() {
  const installer = path.join(electronDir, 'install.js')
  if (!existsSync(installer)) {
    throw new Error(`no ${installer} — is the electron package installed? Run: npm ci`)
  }
  console.log('[ensure-electron] unpacking the Electron binary (once, in this process)')
  execFileSync(process.execPath, [installer], { cwd: electronDir, stdio: 'inherit' })
  if (!isUnpacked()) {
    throw new Error(
      'the Electron binary is still incomplete after install.js — '
      + `expected ${expectedBinary() ?? '<path.txt>'} and dist/resources.pak. `
      + 'Delete node_modules/electron and run: npm ci',
    )
  }
}

if (!isUnpacked()) unpack()
console.log('[ensure-electron] the Electron binary is unpacked')
