// Kernel manager state machine: install -> activate -> rollback -> cleanup.
// The offline (bundled tarball) path is exercised end to end against a fake
// runtime bundle, so no network and no real kernel are involved; every test
// owns its own userData directory.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { KernelManager } = require('../dist/kernel/manager.js')
const { KERNEL_ROOT_DIR } = require('../dist/shared/constants.js')
// Not destructured: every test callback names its TestContext `t`.
const locale = require('../dist/shared/locale.js')
const tar = require('tar')

const PLATFORM = process.platform
const ARCH = process.arch
const NODE_BINARY = PLATFORM === 'win32' ? 'node.exe' : 'node'

function sha512Hex(file) {
  return createHash('sha512').update(readFileSync(file)).digest('hex')
}

/**
 * Build a fake runtime bundle with the layout activateTarball expects:
 * `runtime/manifest.json`, a node binary, and the dsh entry point. The sidecar
 * and the shipped `manifest.json` sit beside the tarball, exactly like
 * `resources/kernel/` inside the installer.
 */
async function makeRuntimeBundle(dir, { dshVersion, suiteVersion, platform = PLATFORM, arch = ARCH, shippedManifest = true }) {
  const runtime = path.join(dir, 'src', 'runtime')
  mkdirSync(path.join(runtime, 'node'), { recursive: true })
  mkdirSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(path.join(runtime, 'node', NODE_BINARY), 'fake-node')
  writeFileSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// dsh')
  const manifest = { dshVersion, suiteVersion, channel: 'stable', platform, arch, integrity: '', source: 'artifact' }
  writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify(manifest))

  const tarball = path.join(dir, 'kernel.tgz')
  await tar.c({ gzip: true, cwd: path.join(dir, 'src'), file: tarball }, ['runtime'])
  const digest = sha512Hex(tarball)
  const sidecar = `${tarball}.sha512`
  writeFileSync(sidecar, `${digest}\n`)
  if (shippedManifest) writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { tarball, sidecar, digest, manifest }
}

/** A harness with its own temp tree; `dir` is removed when the test ends. */
async function harness(t, prefix, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bundleDir = path.join(dir, 'resources')
  mkdirSync(bundleDir)
  const userData = path.join(dir, 'userData')
  const root = path.join(userData, KERNEL_ROOT_DIR)
  const manager = new KernelManager({
    runtimeRoot: userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: 'owner', artifactRepo: 'repo',
    ...options,
  })
  let bundles = 0
  return {
    dir, userData, root, manager, bundleDir,
    currentFile: path.join(root, 'current.json'),
    // Each bundle gets its own directory: they all write `kernel.tgz`, so
    // sharing one path would let the newest overwrite the previous.
    bundle: (options) => {
      const target = path.join(bundleDir, `bundle-${String(++bundles)}`)
      mkdirSync(target)
      return makeRuntimeBundle(target, options)
    },
    readCurrent: () => JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8')),
    versionDirs: () => readdirSync(root).filter((name) => name.startsWith('dsh-')),
  }
}

test('first install activates a versioned dir, records provenance, and reclaims staging', async (t) => {
  const h = await harness(t, 'dsh-kernel-first-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  assert.equal(await h.manager.load(), null, 'nothing installed yet')

  const current = await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  assert.equal(current.active, 'dsh-1.0.0+suite-s1')
  assert.equal(current.previous, null)
  assert.equal(current.sha512, bundle.digest, 'provenance records the verified digest')
  assert.equal(current.bundledStamp, '1.0.0+s1', 'adoption stamp is the bundle identity')
  assert.ok(existsSync(path.join(h.root, current.active, 'node', NODE_BINARY)))
  assert.ok(existsSync(path.join(h.root, current.active, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
  assert.ok(!existsSync(path.join(h.root, 'staging')), 'staging never survives an activation')

  const onDisk = h.readCurrent()
  assert.equal(onDisk.active, current.active)
  assert.equal(onDisk.previous, null)
  assert.equal(onDisk.manifest.dshVersion, '1.0.0')
  assert.ok(typeof onDisk.installedAt === 'string' && onDisk.installedAt.length > 0)
})

test('installing a second version keeps the first as the rollback target', async (t) => {
  const h = await harness(t, 'dsh-kernel-second-')
  const first = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  const second = await h.bundle({ dshVersion: '2.0.0', suiteVersion: 's2' })

  await h.manager.installFromLocalTarball(first.tarball, first.sidecar)
  const after = await h.manager.installFromLocalTarball(second.tarball, second.sidecar)

  assert.equal(after.active, 'dsh-2.0.0+suite-s2')
  assert.equal(after.previous, 'dsh-1.0.0+suite-s1')
  assert.ok(existsSync(path.join(h.root, after.previous)), 'the rollback target stays on disk')
})

test('re-activating the same version does not point previous at itself', async (t) => {
  const h = await harness(t, 'dsh-kernel-same-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })

  await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)
  const again = await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  assert.equal(again.active, 'dsh-1.0.0+suite-s1')
  assert.equal(again.previous, null, 'same-dir re-activation leaves nothing to roll back to')
})

test('rollback restores the previous version and clears the pointer', async (t) => {
  const h = await harness(t, 'dsh-kernel-rollback-')
  const first = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  const second = await h.bundle({ dshVersion: '2.0.0', suiteVersion: 's2' })
  await h.manager.installFromLocalTarball(first.tarball, first.sidecar)
  await h.manager.installFromLocalTarball(second.tarball, second.sidecar)

  const rolled = await h.manager.rollback()

  assert.ok(rolled)
  assert.equal(rolled.active, 'dsh-1.0.0+suite-s1')
  assert.equal(rolled.previous, null, 'rollback is single-step, not a stack')
  assert.equal(rolled.manifest.dshVersion, '1.0.0')
  assert.equal(h.readCurrent().active, 'dsh-1.0.0+suite-s1')
  assert.ok(existsSync(path.join(h.root, 'dsh-2.0.0+suite-s2')), 'the failed version is not deleted by rollback')
})

test('rollback with nothing to roll back to is a no-op', async (t) => {
  const h = await harness(t, 'dsh-kernel-norollback-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  assert.equal(await h.manager.rollback(), null)
  assert.equal(h.readCurrent().active, 'dsh-1.0.0+suite-s1')
})

test('a bundle for another platform/arch is rejected before activation', async (t) => {
  const h = await harness(t, 'dsh-kernel-platform-')
  const wrongArch = ARCH === 'arm64' ? 'x64' : 'arm64'
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1', arch: wrongArch })

  await assert.rejects(
    h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar),
    /平台不匹配/,
  )
  assert.equal(h.manager.getCurrent(), null)
  assert.deepEqual(h.versionDirs(), [], 'a rejected bundle activates nothing')
})

test('a sidecar failing integrity check aborts the install and leaves no state', async (t) => {
  const h = await harness(t, 'dsh-kernel-integrity-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  writeFileSync(bundle.sidecar, `${'0'.repeat(128)}\n`)

  await assert.rejects(
    h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar),
    /完整性校验失败/,
  )
  assert.equal(h.manager.getCurrent(), null)
  assert.deepEqual(h.versionDirs(), [])
  assert.ok(!existsSync(h.currentFile), 'no activation record is written')
})

test('a malformed sidecar fails closed the same way', async (t) => {
  const h = await harness(t, 'dsh-kernel-malformed-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  writeFileSync(bundle.sidecar, 'not-a-digest\n')

  await assert.rejects(h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar), /完整性校验失败/)
  assert.deepEqual(h.versionDirs(), [])
})

test('cleanup keeps active and previous, drops orphans and staging', async (t) => {
  const h = await harness(t, 'dsh-kernel-cleanup-')
  const first = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  const second = await h.bundle({ dshVersion: '2.0.0', suiteVersion: 's2' })
  await h.manager.installFromLocalTarball(first.tarball, first.sidecar)
  await h.manager.installFromLocalTarball(second.tarball, second.sidecar)

  mkdirSync(path.join(h.root, 'dsh-0.9.0+suite-old'))
  mkdirSync(path.join(h.root, 'staging'))
  await h.manager.cleanup()

  assert.deepEqual(h.versionDirs().sort(), ['dsh-1.0.0+suite-s1', 'dsh-2.0.0+suite-s2'])
  assert.ok(!existsSync(path.join(h.root, 'staging')))
})

test('cleanup in dev mode never touches a production kernel tree', async (t) => {
  const h = await harness(t, 'dsh-kernel-devcleanup-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)
  const orphan = path.join(h.root, 'dsh-0.9.0+suite-old')
  mkdirSync(orphan)
  const dev = new KernelManager({
    runtimeRoot: h.userData, platform: PLATFORM, arch: ARCH, source: 'dev', channel: 'stable',
    devCheckoutDir: path.join(h.dir, 'checkout'),
  })

  await dev.cleanup()

  assert.ok(existsSync(path.join(h.root, 'dsh-1.0.0+suite-s1')), 'artifact kernel survives a dev-mode cleanup')
  assert.ok(existsSync(orphan), 'dev cleanup does not sweep the artifact tree at all')
})

test('load() reports a broken install as "no kernel" so the caller reinstalls', async (t) => {
  const h = await harness(t, 'dsh-kernel-broken-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  rmSync(path.join(h.root, 'dsh-1.0.0+suite-s1'), { recursive: true, force: true })
  const fresh = new KernelManager({
    runtimeRoot: h.userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: 'owner', artifactRepo: 'repo',
  })

  assert.equal(await fresh.load(), null)
})

test('the installed kernel carries the runtime tree the shell boots from', async (t) => {
  const h = await harness(t, 'dsh-kernel-spec-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  // A1 onward the shell starts the desktop host out of this tree (Electron's own
  // Node is the child's executable, told to behave as node), so what has to hold
  // after an install is that the tree is where the manager says and carries the
  // kernel entry inside `app/`.
  const dir = path.join(h.root, 'dsh-1.0.0+suite-s1')
  assert.equal(h.manager.getCurrentDir(), dir)
  assert.ok(existsSync(path.join(dir, 'node', NODE_BINARY)))
  assert.ok(existsSync(path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
})

test('a bundle without a shipped manifest installs but records no adoption stamp', async (t) => {
  const h = await harness(t, 'dsh-kernel-nostamp-')
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1', shippedManifest: false })

  const current = await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  assert.equal(current.active, 'dsh-1.0.0+suite-s1')
  assert.equal(current.bundledStamp, undefined, 'no shipped manifest means nothing to compare on the next boot')
})

test('install statuses carry the splash step and the localized wording', async (t) => {
  // The splash prefers `status.step` and only falls back to matching the zh
  // wording, so a boot line that states no step would leave the progress list
  // stuck in every non-zh language. The message must come from the table too:
  // an install that threw its own literals would be untranslatable.
  const statuses = []
  const h = await harness(t, 'dsh-kernel-step-', { onStatus: (status) => statuses.push(status) })
  const bundle = await h.bundle({ dshVersion: '1.0.0', suiteVersion: 's1' })

  await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  const steps = statuses.map((status) => status.step)
  assert.ok(statuses.length >= 3, `expected a status per install step, got ${String(statuses.length)}`)
  assert.ok(steps.every((step) => step !== undefined), 'no boot status is left to the wording fallback')
  assert.deepEqual([...new Set(steps)], [1, 2, 3], 'verify -> extract -> activate, never backwards')
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b))
  assert.deepEqual([...new Set(statuses.map((status) => status.phase))], ['extracting', 'installing'])
  assert.equal(statuses[0].message, locale.t('kernel.status.verifyBundled'), 'the wording comes from the table')
  assert.equal(statuses.at(-1).message, locale.t('kernel.status.activating'))
})
