// Which kernel a shell installs when it could install either of two: the
// version the configured channel resolves, or the runtime bundled inside the
// build. The decision is pure, so this runs without a registry or an install.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  bundledKernelChannel,
  bundledTarball,
  findBundledKernel,
  isNewerKernel,
  preferredKernel,
} = require('../dist/kernel/bundled.js')

test('a bundle ahead of the channel wins: no download for an older kernel', () => {
  // The measured incident: the channel resolved 0.1.5-rc.2 while the shell
  // shipped 0.1.6-alpha.2 in its own resources.
  const pick = preferredKernel({ bundled: '0.1.6-alpha.2', resolved: '0.1.5-rc.2' })
  assert.deepEqual(pick, { version: '0.1.6-alpha.2', source: 'bundled' })
})

test('a channel ahead of the bundle wins: a shipped snapshot cannot pin the user', () => {
  assert.deepEqual(
    preferredKernel({ bundled: '0.1.5-rc.2', resolved: '0.1.6-alpha.2' }),
    { version: '0.1.6-alpha.2', source: 'resolved' },
  )
})

test('equal versions go to the bundle: the bytes are already on disk', () => {
  assert.deepEqual(
    preferredKernel({ bundled: '0.1.6-alpha.2', resolved: '0.1.6-alpha.2' }),
    { version: '0.1.6-alpha.2', source: 'bundled' },
  )
})

test('prerelease ordering still follows semver across lines', () => {
  assert.equal(preferredKernel({ bundled: '0.1.6-alpha.2', resolved: '0.1.6-beta.1' }).source, 'resolved')
  assert.equal(preferredKernel({ bundled: '0.1.6-beta.1', resolved: '0.1.6-alpha.2' }).source, 'bundled')
  // A prerelease never outranks the release of the same version.
  assert.equal(preferredKernel({ bundled: '0.2.0', resolved: '0.2.0-rc.1' }).source, 'bundled')
  assert.equal(preferredKernel({ bundled: '0.2.0-rc.1', resolved: '0.2.0' }).source, 'resolved')
})

test('one side missing answers with the other', () => {
  assert.deepEqual(preferredKernel({ bundled: '0.1.6-alpha.2', resolved: null }), { version: '0.1.6-alpha.2', source: 'bundled' })
  assert.deepEqual(preferredKernel({ bundled: null, resolved: '0.1.5-rc.2' }), { version: '0.1.5-rc.2', source: 'resolved' })
  assert.deepEqual(preferredKernel({ bundled: '', resolved: '  ' }), null, 'blank values are "no version", not a version')
  assert.equal(preferredKernel({ bundled: null, resolved: null }), null)
})

test('unparseable versions fall back to inequality, with the channel winning', () => {
  // The registry is the authority on what a line carries; a malformed bundled
  // version must not win a comparison it cannot take part in — and comparing
  // two of them must not throw.
  assert.deepEqual(preferredKernel({ bundled: 'dev', resolved: '0.1.6-alpha.2' }), { version: '0.1.6-alpha.2', source: 'resolved' })
  assert.deepEqual(preferredKernel({ bundled: 'nonsense', resolved: 'nonsense' }), { version: 'nonsense', source: 'bundled' })
  assert.equal(isNewerKernel('nonsense', 'nonsense'), false)
  assert.equal(isNewerKernel('nonsense', '0.1.5-rc.2'), true)
  assert.equal(isNewerKernel('0.1.5-rc.2', 'nonsense'), true)
  assert.equal(isNewerKernel('0.1.6-alpha.2', '0.1.5-rc.2'), true)
  assert.equal(isNewerKernel('0.1.5-rc.2', '0.1.6-alpha.2'), false)
})

test('the channel default comes from the bundled manifest', () => {
  assert.equal(bundledKernelChannel({ channel: 'alpha' }), 'alpha')
  assert.equal(bundledKernelChannel({ channel: 'beta' }), 'beta')
  assert.equal(bundledKernelChannel({ channel: 'stable' }), 'stable')
  // No manifest, or a value the manifest has no business carrying: today's
  // default. The value is JSON from disk, so it is validated, not trusted.
  assert.equal(bundledKernelChannel(null), 'stable')
  assert.equal(bundledKernelChannel({}), 'stable')
  assert.equal(bundledKernelChannel({ channel: '' }), 'stable')
  assert.equal(bundledKernelChannel({ channel: 'Alpha' }), 'stable')
})

test('the bundled kernel is read from the first directory that has one', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-bundled-'))
  try {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(path.join(first, 'manifest.json'), JSON.stringify({ dshVersion: '0.1.6-alpha.2', channel: 'alpha' }))
    writeFileSync(path.join(first, 'kernel.tgz'), 'not really a tarball')
    writeFileSync(path.join(first, 'kernel.tgz.sha512'), 'deadbeef\n')
    writeFileSync(path.join(second, 'manifest.json'), JSON.stringify({ dshVersion: '0.1.5-rc.2', channel: 'stable' }))

    const bundle = findBundledKernel([first, second])
    assert.equal(bundle.dir, first)
    assert.equal(bundle.tarball, path.join(first, 'kernel.tgz'))
    assert.equal(bundle.sha512, path.join(first, 'kernel.tgz.sha512'))
    assert.equal(bundle.manifest.dshVersion, '0.1.6-alpha.2')
    assert.deepEqual(bundledTarball(bundle), {
      tarball: path.join(first, 'kernel.tgz'),
      sha512: path.join(first, 'kernel.tgz.sha512'),
    })

    // A directory with a manifest but no tarball is still a bundle: the
    // manifest alone answers the channel and version questions, while
    // bundledTarball() reports that there is nothing to install from.
    const manifestOnly = findBundledKernel([second])
    assert.equal(manifestOnly.manifest.dshVersion, '0.1.5-rc.2')
    assert.equal(manifestOnly.tarball, null)
    assert.equal(bundledTarball(manifestOnly), null)

    // Neither file: no bundle, which is what sends a first run online.
    assert.equal(findBundledKernel([path.join(root, 'empty')]), null)
    assert.equal(bundledTarball(null), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a partial bundle is not a bundle: the search continues', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-bundled-'))
  try {
    const half = path.join(root, 'half')
    const other = path.join(root, 'other')
    mkdirSync(half, { recursive: true })
    mkdirSync(other, { recursive: true })
    // A tarball without its sidecar and without a manifest: nothing installable
    // and nothing identifying, so this directory has no bundle to report.
    writeFileSync(path.join(half, 'kernel.tgz'), 'tarball')
    writeFileSync(path.join(other, 'manifest.json'), JSON.stringify({ dshVersion: '0.1.6-alpha.2', channel: 'alpha' }))
    const bundle = findBundledKernel([half, other])
    assert.equal(bundle.dir, other)
    assert.equal(bundle.manifest.dshVersion, '0.1.6-alpha.2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unreadable manifest is null, not a crash', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-bundled-'))
  try {
    const dir = path.join(root, 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'manifest.json'), '{ "dshVersion": ')
    // No tarball either, so the directory holds nothing usable at all.
    assert.equal(findBundledKernel([dir]), null)
    // With a tarball it IS a bundle — installable, with no identity to compare
    // against, which is what leaves bundledKernelChannel at the default.
    writeFileSync(path.join(dir, 'kernel.tgz'), 'tarball')
    writeFileSync(path.join(dir, 'kernel.tgz.sha512'), 'deadbeef\n')
    const bundle = findBundledKernel([dir])
    assert.equal(bundle.manifest, null)
    assert.equal(bundledTarball(bundle).tarball, path.join(dir, 'kernel.tgz'))
    assert.equal(bundledKernelChannel(bundle.manifest), 'stable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
