// The legacy module projection a previous kernel line leaves in a profile.
//
// Upstream materializes `<profile>/.dsh-module-fallback/node_modules/<name>` and
// points the profile's own `node_modules/<name>` at it, so a profile plugin can
// resolve the kernel's packages without their being installed there. Its cleanup
// lives in `loadProfile` — which the DESKTOP host does not call (it calls
// `loadProfileDirectory`), so on this line nothing removes it. Measured on the
// machine this was written on: a 0.1.6 boot left 144 entries and 434 profile
// links behind, and the next 0.1.7 boot resolved 0.1.6 client packages out of it
// — `web boot: 7 entries did not activate`, `configForms` never provided, the
// window on "Failed to load plugins".
//
// The property under test is twofold: a projection of ANOTHER tree is dropped
// (links unlinked, directory removed), and a projection of the tree about to boot
// is left alone. The second half of that matters as much as the first: the
// directory holds links INTO a kernel tree, and a removal that walked them would
// empty the tree it points at.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { removeTree } from '../scripts/lib/remove-tree.mjs'

const require = createRequire(import.meta.url)
const { dropForeignProjection } = require('../dist/main/suite-profile.js')

/**
 * A scratch machine: one profile, and two kernel trees it could be wired to.
 * Every directory here is one this file created, so the plain recursive delete
 * in the teardown cannot follow a link out of the tree it removes.
 */
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-projection-'))
  const profile = path.join(root, 'profiles', 'dsh-app')
  const ownTree = path.join(root, 'kernel', 'dsh-0.1.7-alpha.2+suite-aaaa1111')
  const otherTree = path.join(root, 'kernel', 'dsh-0.1.6-alpha.2+suite-bbbb2222')
  for (const tree of [ownTree, otherTree]) {
    mkdirSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh-client-locale'), { recursive: true })
    writeFileSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh-client-locale', 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-client-locale', version: '0.0.1' })}\n`)
  }
  mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  return { root, profile, ownTree, otherTree }
}

/** Plant a projection of `tree` in `profile`, the way a boot of that line leaves it. */
function plant(profile, tree) {
  const projection = path.join(profile, '.dsh-module-fallback', 'node_modules', '@deepseek-ai')
  mkdirSync(projection, { recursive: true })
  symlinkSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh-client-locale'), path.join(projection, 'dsh-client-locale'), 'junction')
  const links = path.join(profile, 'node_modules', '@deepseek-ai')
  mkdirSync(links, { recursive: true })
  symlinkSync(path.join(profile, '.dsh-module-fallback', 'node_modules', '@deepseek-ai', 'dsh-client-locale'), path.join(links, 'dsh-client-locale'), 'junction')
  // A package of the profile's own, next to the projected one.
  mkdirSync(path.join(profile, 'node_modules', 'dsh-context'), { recursive: true })
}

test('a projection of another tree is dropped, and the tree it pointed at is untouched', async () => {
  const { profile, ownTree, otherTree } = scratch()
  plant(profile, otherTree)
  const outcome = await dropForeignProjection(profile, ownTree)
  assert.equal(outcome.status, 'dropped')
  assert.equal(outcome.entries, 1)
  assert.equal(outcome.links, 1)
  assert.equal(existsSync(path.join(profile, '.dsh-module-fallback')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-locale')), false)
  // The profile's own packages stay, and so does the OTHER kernel's tree — the
  // projection is links, and a removal that walked them would empty it.
  assert.equal(existsSync(path.join(profile, 'node_modules', 'dsh-context')), true)
  assert.equal(existsSync(path.join(otherTree, 'node_modules', '@deepseek-ai', 'dsh-client-locale', 'package.json')), true)
})

test('a projection of the tree about to boot is left alone', async () => {
  const { profile, ownTree } = scratch()
  plant(profile, ownTree)
  const outcome = await dropForeignProjection(profile, ownTree)
  assert.equal(outcome.status, 'kept')
  assert.equal(existsSync(path.join(profile, '.dsh-module-fallback')), true)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-locale')), true)
})

test('a profile without a projection is not touched, and nothing is created', async () => {
  const { profile, ownTree } = scratch()
  mkdirSync(path.join(profile, 'node_modules', 'dsh-context'), { recursive: true })
  const outcome = await dropForeignProjection(profile, ownTree)
  assert.equal(outcome.status, 'absent')
  assert.equal(existsSync(path.join(profile, '.dsh-module-fallback')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'dsh-context')), true)
})

test('a profile link that points elsewhere survives the drop', async () => {
  const { profile, ownTree, otherTree } = scratch()
  plant(profile, otherTree)
  // The suite's own links (`@dsh-app/*` into a checkout) are not the projection's
  // to take back, and neither is a market install that resolves on its own.
  mkdirSync(path.join(profile, 'node_modules', '@dsh-app'), { recursive: true })
  symlinkSync(path.join(otherTree, 'node_modules', '@deepseek-ai', 'dsh-client-locale'), path.join(profile, 'node_modules', '@dsh-app', 'plugin-brand'), 'junction')
  const outcome = await dropForeignProjection(profile, ownTree)
  assert.equal(outcome.status, 'dropped')
  assert.equal(outcome.links, 1)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@dsh-app', 'plugin-brand')), true)
})

test('the projected package is what the profile resolved before the drop, and no longer after', async () => {
  const { root, profile, ownTree, otherTree } = scratch()
  plant(profile, otherTree)
  const resolved = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-locale', 'package.json')
  assert.equal(JSON.parse(readFileSync(resolved, 'utf8')).version, '0.0.1')
  await dropForeignProjection(profile, ownTree)
  assert.equal(existsSync(resolved), false)
  // Through the link-safe walker: this scratch tree HOLDS the junctions the
  // tests planted, and a sync recursive delete descends through them.
  await removeTree(root)
})
