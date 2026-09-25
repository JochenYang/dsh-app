// Staged-kernel discovery: the tree the Windows installer pre-extracts at
// install time (scripts/installer/extract-kernel.nsh) and the app's first
// launch adopts instead of unpacking the tarball. Pure plus one temp-dir
// fixture; no network, no installer.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { findStagedKernel, stagedKernelDirs, stagedRuntimeTree } = require('../dist/kernel/staged.js')

/** A scratch root removed the async way (the form that never follows a link). */
function scratch(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-staged-${label}-`))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A staged tree as the installer's tar lays it down. */
function writeStage(dir, { manifest = true } = {}) {
  const inner = join(dir, 'runtime')
  mkdirSync(inner, { recursive: true })
  if (manifest) writeFileSync(join(inner, 'manifest.json'), '{}\n', 'utf8')
  return inner
}

test('a staged directory with a runtime manifest is adoptable', (t) => {
  const dir = scratch(t, 'present')
  const inner = writeStage(dir)
  const found = findStagedKernel([dir])
  assert.deepEqual(found, { dir, runtime: inner })
  assert.equal(stagedRuntimeTree(dir), inner)
})

test('a staged directory without the inner manifest is not a stage', (t) => {
  // A half-written stage (an installer killed mid-tar) must answer "no
  // stage", not half a runtime the app would try to activate.
  const dir = scratch(t, 'half')
  writeStage(dir, { manifest: false })
  assert.equal(stagedRuntimeTree(dir), null)
  assert.equal(findStagedKernel([dir]), null)
})

test('an absent staged directory is not a stage', (t) => {
  const dir = scratch(t, 'absent')
  assert.equal(findStagedKernel([join(dir, 'nope')]), null)
})

test('the first usable candidate wins, in order', (t) => {
  const root = scratch(t, 'order')
  const first = join(root, 'a')
  const second = join(root, 'b')
  writeStage(first)
  writeStage(second)
  const found = findStagedKernel([join(root, 'missing'), first, second])
  assert.equal(found?.dir, first)
})

test('no candidates at all answers null, not a throw', () => {
  assert.equal(findStagedKernel([]), null)
})

test('the packaged candidate list is the resources path only', () => {
  // The stage is an installer artifact; a dev run has no installer and must
  // not silently adopt some repo-local copy.
  const resources = process.resourcesPath
  const dirs = stagedKernelDirs()
  if (typeof resources === 'string' && resources !== '') {
    assert.deepEqual(dirs, [join(resources, 'kernel-staged')])
  } else {
    assert.deepEqual(dirs, [])
  }
})
