// The activation tail's two untrusted-input guards: the artifact must declare
// the version its caller asked for, and no tar entry may write outside the
// extraction root. Both are exercised offline against a fake runtime bundle,
// mirroring the harness in kernel-manager.test.mjs.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { KernelManager } = require('../dist/kernel/manager.js')
const { KERNEL_ROOT_DIR } = require('../dist/shared/constants.js')
const { tarExtractionFilter, isSafeArchivePath } = require('../dist/kernel/tar-entry.js')
const locale = require('../dist/shared/locale.js')
const tar = require('tar')

const PLATFORM = process.platform
const ARCH = process.arch
const NODE_BINARY = PLATFORM === 'win32' ? 'node.exe' : 'node'

function sha512Hex(file) {
  return createHash('sha512').update(readFileSync(file)).digest('hex')
}

/** The minimal tree activateTarball accepts: manifest + node binary + dsh entry. */
function writeRuntimeTree(runtime, { dshVersion, suiteVersion, platform = PLATFORM, arch = ARCH }) {
  mkdirSync(path.join(runtime, 'node'), { recursive: true })
  mkdirSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  mkdirSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'), { recursive: true })
  writeFileSync(path.join(runtime, 'node', NODE_BINARY), 'fake-node')
  writeFileSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// dsh')
  writeFileSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'), '// host')
  const manifest = { dshVersion, suiteVersion, channel: 'stable', platform, arch, integrity: '', source: 'artifact' }
  writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}

/**
 * A bundled-runtime layout: tarball + sidecar, and a shipped manifest.json that
 * may disagree with the tarball's inner manifest — the build fault the version
 * binding refuses to activate.
 */
async function makeBundle(dir, { inner, shipped }) {
  const runtime = path.join(dir, 'src', 'runtime')
  writeRuntimeTree(runtime, inner)
  const tarball = path.join(dir, 'kernel.tgz')
  await tar.c({ gzip: true, cwd: path.join(dir, 'src'), file: tarball }, ['runtime'])
  const digest = sha512Hex(tarball)
  writeFileSync(`${tarball}.sha512`, `${digest}\n`)
  if (shipped) writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(shipped))
  return { tarball, sidecar: `${tarball}.sha512`, digest }
}

function harness(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bundleDir = path.join(dir, 'resources')
  mkdirSync(bundleDir)
  const userData = path.join(dir, 'userData')
  const manager = new KernelManager({
    runtimeRoot: userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: 'owner', artifactRepo: 'repo',
  })
  return {
    dir, bundleDir, manager,
    bundle: async (inner, shipped) => {
      const target = path.join(bundleDir, `bundle-${Math.random().toString(36).slice(2)}`)
      mkdirSync(target)
      return makeBundle(target, { inner, shipped })
    },
  }
}

test('a bundled tarball whose inner manifest disagrees with the shipped one is refused', async (t) => {
  const h = harness(t, 'dsh-version-bind-')
  const version = { dshVersion: '0.1.6-alpha.2', suiteVersion: '0.12.9' }
  // The shipped manifest says 0.1.7; the tarball inside says 0.1.6. Activating
  // it would install a kernel the boot drift check believes is newer.
  const bundle = await h.bundle(version, { ...version, dshVersion: '0.1.7' })
  await assert.rejects(
    () => h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar),
    (err) => {
      assert.match(err.message, /artifactVersionMismatch|0\.1\.6-alpha\.2.*0\.1\.7|another version/)
      return true
    },
  )
  // Nothing was activated: the refusal happens before current.json exists.
  assert.equal(existsSync(path.join(h.dir, 'userData', KERNEL_ROOT_DIR, 'current.json')), false)
})

test('a bundled tarball in agreement with its shipped manifest installs', async (t) => {
  const h = harness(t, 'dsh-version-ok-')
  const version = { dshVersion: '0.1.6-alpha.2', suiteVersion: '0.12.9' }
  const bundle = await h.bundle(version, version)
  const current = await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)
  assert.equal(current.manifest.dshVersion, '0.1.6-alpha.2')
  assert.equal(current.bundledStamp, '0.1.6-alpha.2+0.12.9')
})

test('isSafeArchivePath refuses absolute paths, parent climbs and drive forms', () => {
  assert.equal(isSafeArchivePath('runtime/app/index.js'), true)
  assert.equal(isSafeArchivePath('runtime/../evil'), false)
  assert.equal(isSafeArchivePath('../../evil'), false)
  // A drive-relative member or link target (`C:evil`) is neither absolute nor a
  // `..` climb, but node-tar resolves a link through path.resolve — on Windows
  // that lands at the root of another volume.
  assert.equal(isSafeArchivePath('C:evil'), false)
  assert.equal(isSafeArchivePath('c:/windows/evil'), false)
  if (PLATFORM === 'win32') assert.equal(isSafeArchivePath('C:/windows/evil'), false)
  else assert.equal(isSafeArchivePath('/etc/passwd'), false)
})

test('tarExtractionFilter refuses a drive-relative link target', () => {
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'Link', linkpath: 'C:evil' }), false)
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'SymbolicLink', linkpath: 'D:/outside' }), false)
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'HardLink', linkpath: 'runtime/b' }), true)
})

test('tarExtractionFilter refuses a link whose target leaves the root', () => {
  assert.equal(tarExtractionFilter('runtime/app', { type: 'Directory' }), true)
  assert.equal(tarExtractionFilter('runtime/app/node_modules/x', { type: 'File' }), true)
  // The escape the member-path check alone cannot see.
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'SymbolicLink', linkpath: '../../../outside' }), false)
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'Link', linkpath: '/etc/passwd' }), false)
  // A link without a target is either malformed or dodging the check.
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'SymbolicLink' }), false)
  assert.equal(tarExtractionFilter('runtime/evil', { type: 'SymbolicLink', linkpath: '' }), false)
  // An in-archive link (the hardlinked-node_modules case) is allowed.
  assert.equal(tarExtractionFilter('runtime/a', { type: 'HardLink', linkpath: 'runtime/b' }), true)
})

test('extraction refuses to write through a link that points outside', async (t) => {
  let linked = true
  const probeDir = mkdtempSync(path.join(tmpdir(), 'dsh-symlink-probe-'))
  try {
    // A dangling link needs no target to exist, so this probes the privilege
    // without creating a file to clean up afterwards.
    symlinkSync('nowhere', path.join(probeDir, 'probe'), 'file')
  } catch {
    linked = false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
  if (!linked) {
    t.skip('this host does not permit creating symlinks; the filter is covered by the unit test above')
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-link-escape-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outside = path.join(dir, 'outside')
  mkdirSync(outside)
  const stage = path.join(dir, 'stage')
  mkdirSync(stage)
  const escape = path.join(stage, 'escape')
  symlinkSync(outside, escape, 'dir')
  const tarball = path.join(dir, 'evil.tgz')
  await tar.c({ gzip: true, cwd: stage, file: tarball, portable: true }, ['escape'])

  const extractDir = path.join(dir, 'extract')
  mkdirSync(extractDir)
  await tar.x({ file: tarball, cwd: extractDir, filter: tarExtractionFilter })
  // The link entry was dropped, and nothing landed outside the root.
  assert.equal(existsSync(path.join(extractDir, 'escape')), false)
  assert.equal(readdirSyncSafe(extractDir).length, 0)
  assert.equal(readdirSyncSafe(outside).length, 0)
})

function readdirSyncSafe(dir) {
  try {
    return require('node:fs').readdirSync(dir)
  } catch {
    return []
  }
}
