// The layer survives a package-manager run, or the suite disappears with it.
//
// Measured on a real machine: a `dsh plugin … remove` in the profile (and the
// plugin manager's own page) runs pnpm, which prunes
// `node_modules/@dsh-app/suite-layer` as an extraneous directory. The suite's rows
// travel only through that bundle, so the settings rail lost every suite row and
// the plugin page reported the bundle as "not installed" — and nothing repaired it
// until the next app start, because the install runs in the start path only.
//
// This suite drives the keeper directly: install into a temp profile, delete the
// directory the way pnpm does, and require it back.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { removeTree } from '../scripts/lib/remove-tree.mjs'

const require = createRequire(import.meta.url)
const suiteLayer = require('../dist/main/suite-layer.js')

const OVERLAY = readFileSync(path.join(import.meta.dirname, '..', 'dist', 'main', 'dsh-app.patch.yml'), 'utf8')

/** Poll until `file` exists, or the deadline passes. */
async function waitForFile(file, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(file)) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return existsSync(file)
}

test('a pruned layer is put back while the app runs', async () => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-keeper-'))
  const layerDir = path.join(profileDir, 'node_modules', '@dsh-app', 'suite-layer')
  try {
    // A real profile has a manifest; the bundle entry lives in it.
    const manifest = path.join(profileDir, 'package.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(manifest, JSON.stringify({ name: 'probe-profile', dsh: { profile: { bundles: [] } } }))

    const installed = await suiteLayer.installSuiteLayer({ profileDir, overlay: OVERLAY })
    assert.equal(installed.status, 'installed')
    const layerManifest = path.join(layerDir, 'package.json')
    assert.ok(existsSync(layerManifest), 'the install writes the layer package')
    assert.match(
      JSON.parse(readFileSync(layerManifest, 'utf8')).dsh.bundle.patch,
      /cordis\.patch\.yml/u,
    )

    const keeper = suiteLayer.keepSuiteLayer({ profileDir, overlay: OVERLAY, intervalMs: 20 })
    try {
      // What pnpm does: the directory goes away, the manifest entry stays.
      await rm(layerDir, { recursive: true, force: true })
      assert.ok(!existsSync(layerManifest), 'the keeper is tested against a real removal')
      assert.ok(await waitForFile(layerManifest), 'the keeper must restore the layer')
      assert.equal(readFileSync(path.join(layerDir, 'cordis.patch.yml'), 'utf8'), `${OVERLAY.replace(/\n+$/u, '')}\n`)
      // The manifest entry comes back too — a bundle the profile does not name is
      // just as invisible as a directory that is not there.
      const bundles = JSON.parse(readFileSync(manifest, 'utf8')).dsh.profile.bundles
      assert.deepEqual(bundles, [suiteLayer.SUITE_LAYER_PACKAGE])
    } finally {
      keeper.close()
    }

    // After close, a removal stays removed: the keeper must not outlive its owner.
    await rm(layerDir, { recursive: true, force: true })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.ok(!existsSync(layerManifest), 'a closed keeper does nothing')
  } finally {
    await removeTree(profileDir)
  }
})
