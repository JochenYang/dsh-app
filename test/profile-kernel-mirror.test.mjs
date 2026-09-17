// The profile as an installed tree: what the shell puts inside a profile for a
// host line that anchors the kernel packages on the profile itself (0.1.5 and
// earlier, see `hostProfileAnchor`), and — the property this shape was chosen
// for — what a recursive delete inside the profile may NOT reach.
//
// The failure that shape avoids was measured on this machine: `fs.rmSync(dir,
// { recursive: true })` on a directory holding junctions into a runtime tree
// emptied that runtime's own package directories (Electron 44.4.1 / Node
// 24.21). A profile is a directory users and package managers delete, so the
// mirror is made of hardlinks and links inside it are never followed. The
// junction case below is that regression, kept as a test.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  PROFILE_KERNEL_MARKER,
  dropRuntimeMirror,
  mirrorRuntimeIntoProfile,
} = require('../dist/main/suite-profile.js')

/** A runtime tree with the two shapes that matter: a scoped kernel package and a vendor package. */
function fakeRuntime() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-runtime-'))
  const scoped = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(scoped, 'lib'), { recursive: true })
  writeFileSync(path.join(scoped, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}\n')
  writeFileSync(path.join(scoped, 'lib', 'index.js'), 'module.exports = 1\n')
  const vendor = path.join(root, 'node_modules', 'yaml')
  mkdirSync(vendor, { recursive: true })
  writeFileSync(path.join(vendor, 'package.json'), '{"name":"yaml"}\n')
  return root
}

/** A seeded suite profile: the manifest plus whatever node_modules it already has. */
function fakeProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-profile-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"name":"dsh-profile-dsh-app","private":true}\n')
  return dir
}

test('the mirror gives the profile the runtime tree, and a second start writes nothing', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  const first = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(first.status, 'mirrored')
  assert.equal(first.entries, 2)
  assert.equal(first.files, 3)
  assert.equal(
    readFileSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'index.js'), 'utf8'),
    'module.exports = 1\n',
  )
  assert.ok(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)))

  const second = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(second.status, 'already')
  assert.equal(second.entries, 2)
  assert.equal(second.files, first.files)

  // A package the runtime does not carry — the market's own install, pnpm's
  // state — is not the mirror's to touch.
  const foreign = path.join(profile, 'node_modules', 'dsh-deja', 'package.json')
  mkdirSync(path.dirname(foreign), { recursive: true })
  writeFileSync(foreign, '{"name":"dsh-deja"}\n')
  await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(readFileSync(foreign, 'utf8'), '{"name":"dsh-deja"}\n')
})

test('dropping the mirror removes the profile copy without following links inside it', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)

  // A link of exactly the kind a package manager or an earlier shell leaves
  // behind. `fs.rm(recursive)` would walk through it and take the runtime's
  // files with it; the mirror's own remover must not.
  symlinkSync(
    path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'),
    path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const dropped = await dropRuntimeMirror(profile)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 2)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)), false)
  // The runtime is exactly as it was.
  assert.equal(readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'index.js'), 'utf8'), 'module.exports = 1\n')
  assert.equal(readFileSync(path.join(runtime, 'node_modules', 'yaml', 'package.json'), 'utf8'), '{"name":"yaml"}\n')
})

test('a delete of the profile directory leaves the runtime intact', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)
  // The hardlink claim: the profile's name for each file can go away and the
  // runtime's name still resolves to the same bytes.
  const { rmSync } = await import('node:fs')
  rmSync(path.join(profile, 'node_modules'), { recursive: true, force: true })
  assert.equal(readFileSync(path.join(runtime, 'node_modules', 'yaml', 'package.json'), 'utf8'), '{"name":"yaml"}\n')
  assert.equal(readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}\n')
  // And the next start rebuilds what the delete took.
  const rebuilt = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(rebuilt.status, 'mirrored')
  assert.equal(rebuilt.files, 3)
})

test('dropping a mirror that was never made is a no-op', async () => {
  const profile = fakeProfile()
  assert.equal((await dropRuntimeMirror(profile)).status, 'already')
})
