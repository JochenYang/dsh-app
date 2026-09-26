// The on-demand office payload: what the settings row reports, and the one
// download that installs the LibreOffice engine under <userData>/dsh-app-office.
//
// What these tests are for: the engine is no longer part of the runtime
// artifact, so this module is the ONLY way a user gets one. Every failure mode
// here has the same consequence on a user's machine — office conversion stays
// unavailable — and three of them are invisible without an explicit test:
//   * a mismatched or corrupt artifact must NOT replace a working install;
//   * a payload installed for another kernel must not be reported as installed;
//   * the version directory is a CONTENT identity, so a kernel update reuses
//     what is already on disk instead of downloading 115 MiB again.
// All of it runs against a fake release (a stubbed `fetch`) and a payload
// tarball built here, so there is no network and no real kit.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { OfficePayloadManager, manifestProblems, requiredFiles } = require('../dist/kernel/office-payload.js')
const { officePayloadAssetName, officePayloadManifestName, modelscopeRuntimeAssetUrl } = require('../dist/kernel/sources/artifact.js')
const { OFFICE_PAYLOAD_DIR, OFFICE_PAYLOAD_MODULES_DIR, OFFICE_ROOT_DIR } = require('../dist/shared/constants.js')
const build = await import('../scripts/lib/office-payload.mjs')
const tar = require('tar')

const OWNER = 'JochenYang'
const REPO = 'dsh-app'
const PLATFORM = 'win32'
const ARCH = 'x64'
const ENGINE = 'win32-x64'
const KIT_VERSION = '0.0.1'
/** A declared Python set, as the payload manifest names it. */
const PYTHON_VERSION = '3.12.14'
const PAYLOAD_VERSION = build.officePayloadVersion(KIT_VERSION)
const DSH_VERSION = '0.1.6-alpha.2'
const ASSET = officePayloadAssetName(PLATFORM, ARCH, DSH_VERSION)
const MANIFEST_ASSET = officePayloadManifestName(PLATFORM, ARCH)
const OFFICIAL_BASE = `https://github.com/${OWNER}/${REPO}/releases/download/runtime-${DSH_VERSION}`
const PAYLOAD_ROOT = 'payload'

/** Every userData tree this file creates, removed when the process exits. */
const roots = []
process.on('exit', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function newUserData() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-office-payload-'))
  roots.push(dir)
  return dir
}

/** The payload manifest a release of `version` carries. */
function payloadManifest(version = PAYLOAD_VERSION, overrides = {}) {
  return {
    payloadVersion: version,
    dshVersion: DSH_VERSION,
    platform: PLATFORM,
    arch: ARCH,
    components: { kit: KIT_VERSION, engine: ENGINE, python: null },
    source: 'artifact',
    ...overrides,
  }
}

/**
 * Build a payload tarball with the shape the build produces: a single
 * `payload/` directory holding the manifest, the kit's entry and the target
 * engine's content marker.
 */
async function makePayloadTarball(dir, { manifest = payloadManifest(), engine = ENGINE, pythonTree = true } = {}) {
  const tree = path.join(dir, PAYLOAD_ROOT)
  const kit = path.join(tree, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  const engineDir = path.join(tree, 'node_modules', '@deepseek-ai', `libreoffice-kit-${engine}`)
  mkdirSync(kit, { recursive: true })
  mkdirSync(path.join(engineDir, 'program'), { recursive: true })
  // A manifest that declares a Python set carries the tree unless the case is
  // deliberately incomplete (the archive that installs but cannot answer).
  const python = manifest.components?.python
  if (pythonTree && typeof python === 'string' && python !== '') {
    mkdirSync(path.join(tree, 'primary-runtime'), { recursive: true })
    writeFileSync(path.join(tree, 'primary-runtime', 'runtime.json'), `${JSON.stringify({ components: { python } }, null, 2)}\n`)
  }
  writeFileSync(path.join(tree, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(kit, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: KIT_VERSION, type: 'module', main: 'index.js' }, null, 2)}\n`)
  writeFileSync(path.join(kit, 'index.js'), 'export function createConverter() { return Promise.resolve({ render: async () => ({ missingFonts: [] }) }) }\n')
  writeFileSync(path.join(engineDir, 'package.json'), `${JSON.stringify({ name: `@deepseek-ai/libreoffice-kit-${engine}`, version: KIT_VERSION }, null, 2)}\n`)
  writeFileSync(path.join(engineDir, 'prebuilds.json'), '{"files":[]}\n')
  writeFileSync(path.join(engineDir, 'program', 'soffice.bin'), 'engine placeholder\n')
  const tarball = path.join(dir, `${path.basename(dir)}.tgz`)
  await tar.c({ gzip: true, file: tarball, cwd: dir, portable: true, mtime: new Date(0) }, [PAYLOAD_ROOT])
  return tarball
}

function sha512Hex(file) {
  return createHash('sha512').update(readFileSync(file)).digest('hex')
}

/**
 * Install a fetch stub over the fake release. `tarball` answers the asset
 * itself; `sha512` defaults to the real digest of that tarball, and passing a
 * different one is how the digest-mismatch case is built.
 */
function stubRelease(tarball, { sha512 = tarball === null ? null : sha512Hex(tarball), manifest = payloadManifest(), metadata = true, serveEverywhere = false } = {}) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    if (metadata && target === `${OFFICIAL_BASE}/${ASSET}.sha512`) {
      return sha512 === null ? new Response('', { status: 404 }) : new Response(`${sha512}\n`, { status: 200 })
    }
    if (metadata && target === `${OFFICIAL_BASE}/${MANIFEST_ASSET}`) {
      return new Response(`${JSON.stringify({ ...manifest, integrity: sha512 ?? '' })}\n`, { status: 200 })
    }
    // `serveEverywhere` answers the asset from EVERY candidate (mirrors and
    // ModelScope included), which is how "each source served wrong bytes" is
    // built — the failure classification looks at the LAST error of the chain.
    if (tarball !== null && (target === `${OFFICIAL_BASE}/${ASSET}` || (serveEverywhere && target.includes(`/${ASSET}`)))) {
      const bytes = readFileSync(tarball)
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    }
    // Anything else (mirrors, ModelScope) is an unreachable source, which is
    // what a real first-run failure looks like too.
    throw new Error(`no route in this test: ${target}`)
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

function manager(userData, target) {
  const lines = []
  const value = new OfficePayloadManager({
    userDataDir: userData,
    platform: PLATFORM,
    arch: ARCH,
    owner: OWNER,
    repo: REPO,
    target: () => target(),
    log: (line) => { lines.push(line) },
  })
  return { value, lines }
}

/** A target for one payload version, as an active kernel manifest would give. */
function targetFor(version = PAYLOAD_VERSION, extra = {}) {
  return {
    dshVersion: DSH_VERSION,
    payloadVersion: version,
    platform: PLATFORM,
    arch: ARCH,
    engine: ENGINE,
    ...extra,
  }
}

/** Poll until the task settles, so a background transfer can be asserted on. */
async function settled(instance, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await instance.status()
    if (status.phase !== 'downloading' && status.phase !== 'installing') return status
    if (Date.now() > deadline) throw new Error(`payload task did not settle: ${JSON.stringify(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a kernel that declares no payload reports unsupported, never a download', async () => {
  const { value } = manager(newUserData(), () => null)
  assert.deepEqual(await value.status(), {
    supported: false, required: null, installed: null, installedOnDisk: null, phase: 'idle', progress: null, error: null,
  })
  // A download for an unsupported kernel is a no-op, not an error: nothing can
  // resolve, so the row must not offer it and no file may appear.
  assert.equal((await value.download()).supported, false)
  assert.equal(value.expectedDir(), null)
  assert.equal(await value.installedDir(), null)
})

test('the required version is reported, and the directory the shim is told about exists before it does', async () => {
  const userData = newUserData()
  const { value } = manager(userData, () => targetFor())
  const status = await value.status()
  assert.equal(status.supported, true)
  assert.equal(status.required, PAYLOAD_VERSION)
  assert.equal(status.installed, null)
  assert.equal(status.phase, 'idle')
  // The child is told the path whether or not it is installed: that is what
  // makes a payload downloaded while the kernel runs usable without a restart.
  assert.equal(value.expectedDir(), path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, PAYLOAD_VERSION))
  assert.equal(existsSync(value.expectedDir()), false)
})

test('a download installs the payload, verifies it, and reports it installed', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  const { value } = manager(userData, () => targetFor())
  try {
    const started = await value.download()
    assert.equal(started.supported, true)
    assert.equal(started.installed, null)
    const status = await settled(value)
    assert.equal(status.phase, 'idle', JSON.stringify(status))
    assert.equal(status.installed, PAYLOAD_VERSION)
    assert.equal(status.error, null)

    const installed = path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, PAYLOAD_VERSION)
    assert.equal(await value.installedDir(), installed)
    for (const relative of requiredFiles(ENGINE)) {
      assert.ok(existsSync(path.join(installed, relative)), relative)
    }
    // The transport leads with the ModelScope copy; this fake release has no
    // route to it, so the walk continues to the official asset — fetched once.
    const assetCalls = release.calls.filter((url) => url.endsWith(`/${ASSET}`))
    assert.deepEqual(assetCalls, [
      modelscopeRuntimeAssetUrl(DSH_VERSION, ASSET),
      `${OFFICIAL_BASE}/${ASSET}`,
    ])
    // Parsed back: the installed manifest is the one the release carried.
    assert.deepEqual(JSON.parse(readFileSync(path.join(installed, 'manifest.json'), 'utf8')), payloadManifest())
  } finally {
    release.restore()
  }
})

test('an installed payload is never fetched again — a kernel update reuses it', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  const { value } = manager(userData, () => targetFor())
  try {
    await value.download()
    await settled(value)
    const callsAfterInstall = release.calls.length
    // Same content version, a DIFFERENT kernel release tag: the kernel moved,
    // the payload did not, so nothing may be downloaded — this is the whole
    // point of versioning the payload by content rather than by dsh version.
    const moved = manager(userData, () => targetFor(PAYLOAD_VERSION, { dshVersion: '0.1.6-alpha.3' }))
    const status = await moved.value.download()
    assert.equal(status.installed, PAYLOAD_VERSION)
    assert.equal(status.phase, 'idle')
    assert.equal(release.calls.length, callsAfterInstall)
    // And the ROW must not fall back to "not installed": a satisfied payload is
    // `installed`, so there is no upgrade to report either. Asserted here because
    // a shell (or client) that read the wrong field would show a download button
    // over a working install — the regression this pair of fields exists against.
    assert.equal(status.installedOnDisk, PAYLOAD_VERSION)
    assert.equal(status.required, PAYLOAD_VERSION)
  } finally {
    release.restore()
  }
})

test('a kit bump reads as an UPDATE, never as a fresh install', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  try {
    // Install kit 0.0.1 for this target, then read it from a kernel whose kit
    // pin moved to 0.0.2 — exactly what `DESKTOP_OFFICE_KIT_VERSION` does. The
    // two versions differ only in the kit component, mirroring a real bump.
    const first = manager(userData, () => targetFor())
    await first.value.download()
    await settled(first.value)

    const bumped = build.officePayloadVersion('0.0.2')
    const status = await manager(userData, () => targetFor(bumped)).value.status()
    assert.equal(status.required, bumped, 'the kernel requires the bumped version')
    assert.equal(status.installed, null, 'the bumped version is not installed — an upgrade IS available')
    // The whole point: the version already on disk is still REPORTED, so the row
    // can say "installed vX, update available" instead of "not installed".
    assert.equal(status.installedOnDisk, PAYLOAD_VERSION)
    assert.notEqual(status.installedOnDisk, status.required)
  } finally {
    release.restore()
  }
})

test('a digest mismatch fails the download and installs nothing', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  // Every source serves the same wrong bytes: the trusted digest comes from the
  // release metadata, and the classification must name the integrity fault
  // rather than the transport that carried it.
  const release = stubRelease(tarball, { sha512: 'a'.repeat(128), serveEverywhere: true })
  const { value } = manager(userData, () => targetFor())
  try {
    await value.download()
    const status = await settled(value)
    assert.equal(status.phase, 'failed')
    assert.equal(status.installed, null)
    assert.match(status.error?.message ?? '', /完整性|integrity|摘要/u)
    assert.equal(existsSync(path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, PAYLOAD_VERSION)), false)
    // The staging directory is cleaned up too: a failed attempt leaves nothing.
    const payloadRoot = path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR)
    const leftovers = existsSync(payloadRoot) ? require('node:fs').readdirSync(payloadRoot) : []
    assert.deepEqual(leftovers, [])
  } finally {
    release.restore()
  }
})

test('an artifact for another payload version is refused before it is trusted', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  // The tarball itself is fine; the release's metadata claims a different
  // payload version than this kernel requires (a re-labelled or stale release).
  const tarball = await makePayloadTarball(work, { manifest: payloadManifest('0.9.9') })
  const release = stubRelease(tarball, { manifest: payloadManifest('0.9.9') })
  const { value } = manager(userData, () => targetFor())
  try {
    await value.download()
    const status = await settled(value)
    assert.equal(status.phase, 'failed')
    assert.equal(status.error?.code, 'officePayload.manifestMismatch')
    assert.equal(existsSync(path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, PAYLOAD_VERSION)), false)
    assert.equal(release.calls.some((url) => url.endsWith(`/${ASSET}`)), false, 'nothing was downloaded')
  } finally {
    release.restore()
  }
})

test('a payload with no engine is refused at install time', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  // The engine directory is absent from the archive while the manifest claims
  // one: the required-file check is what catches it, not the manifest.
  const tarball = await makePayloadTarball(work, { engine: 'win32-arm64' })
  const release = stubRelease(tarball)
  const { value } = manager(userData, () => targetFor())
  try {
    await value.download()
    const status = await settled(value)
    assert.equal(status.phase, 'failed')
    assert.equal(status.error?.code, 'officePayload.manifestMismatch')
    assert.equal(existsSync(path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, PAYLOAD_VERSION)), false)
  } finally {
    release.restore()
  }
})

test('a payload that declares a Python set but lost its tree is refused', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  // The manifest names the Python version the host's `load_workspace_dependencies`
  // will read; an archive without `primary-runtime/runtime.json` would install
  // and only fail at that call, so it must never reach the active directory.
  const manifest = payloadManifest(build.officePayloadVersion(KIT_VERSION, PYTHON_VERSION), {
    components: { kit: KIT_VERSION, engine: ENGINE, python: PYTHON_VERSION },
  })
  const tarball = await makePayloadTarball(work, { manifest, pythonTree: false })
  const release = stubRelease(tarball, { manifest })
  const { value } = manager(userData, () => targetFor(manifest.payloadVersion))
  try {
    await value.download()
    const status = await settled(value)
    assert.equal(status.phase, 'failed')
    assert.equal(status.error?.code, 'officePayload.manifestMismatch')
    assert.match(String(status.error?.message), /primary-runtime/u)
    assert.equal(existsSync(path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, manifest.payloadVersion)), false)
  } finally {
    release.restore()
  }
})

test('a payload of another kernel is never reported as installed', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  try {
    const first = manager(userData, () => targetFor())
    await first.value.download()
    await settled(first.value)
    assert.equal((await first.value.installedDir()) !== null, true)

    // The same directory, read by a kernel that requires a different content
    // version: it must read as "not installed" even though a payload is there.
    const other = manager(userData, () => targetFor('0.0.1-py3.12.7'))
    const status = await other.value.status()
    assert.equal(status.required, '0.0.1-py3.12.7')
    assert.equal(status.installed, null)
    assert.equal(await other.value.installedDir(), null)
    // ...while the version that IS on disk is reported separately. This is the
    // "an upgrade is available" state: a `^0.1.1` kit range resolving to a new
    // kit at build time moves `required` past a payload the user already has,
    // and reporting only `installed: null` showed them an untouched machine's
    // download flow instead of an update.
    assert.equal(status.installedOnDisk, PAYLOAD_VERSION)
  } finally {
    release.restore()
  }
})

test('a version on disk that is NOT complete is never reported as installed-on-disk', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  const payloadRoot = path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR)
  // A DIFFERENT content version than the one installed, so the tree below is
  // read by the "required moved past it" path this field exists for.
  const otherVersion = '0.0.1-py3.12.7'
  try {
    const first = manager(userData, () => targetFor())
    await first.value.download()
    await settled(first.value)

    // Intact first: the engine is there, so the version IS reported. Without
    // this half, the mutilated assertion below would pass for the wrong reason.
    const intact = manager(userData, () => targetFor(otherVersion))
    assert.equal((await intact.value.status()).installedOnDisk, PAYLOAD_VERSION)

    // Now remove the engine marker: a payload that lost it is not usable at all,
    // so it must not be offered as "installed, update available" either — the
    // honest answer is the download flow.
    rmSync(path.join(payloadRoot, PAYLOAD_VERSION, OFFICE_PAYLOAD_MODULES_DIR, '@deepseek-ai', `libreoffice-kit-${ENGINE}`), { recursive: true, force: true })
    const mutilated = manager(userData, () => targetFor(otherVersion))
    assert.equal((await mutilated.value.status()).installedOnDisk, null)
  } finally {
    release.restore()
  }
})

test('installing a new payload version prunes the previous one', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  const payloadRoot = path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR)
  try {
    const first = manager(userData, () => targetFor())
    await first.value.download()
    await settled(first.value)
    assert.ok(existsSync(path.join(payloadRoot, PAYLOAD_VERSION)))

    // A new kit version: the required payload moves, so the new one installs
    // and the old directory is reclaimed (it is re-downloadable by definition).
    const nextVersion = build.officePayloadVersion('0.0.2')
    const nextWork = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
    roots.push(nextWork)
    const nextTarball = await makePayloadTarball(nextWork, {
      manifest: payloadManifest(nextVersion, { components: { kit: '0.0.2', engine: ENGINE, python: null } }),
    })
    const nextRelease = stubRelease(nextTarball, {
      manifest: payloadManifest(nextVersion, { components: { kit: '0.0.2', engine: ENGINE, python: null } }),
    })
    try {
      const next = manager(userData, () => targetFor(nextVersion))
      await next.value.download()
      const status = await settled(next.value)
      assert.equal(status.installed, nextVersion)
      assert.ok(existsSync(path.join(payloadRoot, nextVersion)))
      assert.equal(existsSync(path.join(payloadRoot, PAYLOAD_VERSION)), false, 'the previous version was pruned')
    } finally {
      nextRelease.restore()
    }
  } finally {
    release.restore()
  }
})

test('a failed install leaves the previous payload untouched', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const release = stubRelease(tarball)
  const payloadRoot = path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR)
  try {
    const first = manager(userData, () => targetFor())
    await first.value.download()
    await settled(first.value)

    // Another version arrives with a corrupt artifact: the transfer fails, and
    // the working install must still be there and still be the one reported.
    const nextVersion = build.officePayloadVersion('0.0.2')
    const nextWork = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
    roots.push(nextWork)
    const nextTarball = await makePayloadTarball(nextWork, {
      manifest: payloadManifest(nextVersion, { components: { kit: '0.0.2', engine: ENGINE, python: null } }),
    })
    const badRelease = stubRelease(nextTarball, {
      sha512: 'b'.repeat(128),
      manifest: payloadManifest(nextVersion, { components: { kit: '0.0.2', engine: ENGINE, python: null } }),
    })
    try {
      const next = manager(userData, () => targetFor(nextVersion))
      await next.value.download()
      const status = await settled(next.value)
      assert.equal(status.phase, 'failed')
      assert.ok(existsSync(path.join(payloadRoot, PAYLOAD_VERSION)), 'the working install survived')
      // And the OLD payload still answers for a kernel that asks for it.
      const old = manager(userData, () => targetFor())
      assert.equal((await old.value.status()).installed, PAYLOAD_VERSION)
    } finally {
      badRelease.restore()
    }
  } finally {
    release.restore()
  }
})

test('a release without the payload reports the artifact as missing', async () => {
  const userData = newUserData()
  const { value } = manager(userData, () => targetFor())
  const release = stubRelease(null, { metadata: true, sha512: null, manifest: payloadManifest() })
  try {
    await value.download()
    const status = await settled(value)
    assert.equal(status.phase, 'failed')
    assert.equal(status.error?.code, 'officePayload.artifactMissing')
    assert.match(status.error?.message ?? '', /office-payload/u)
  } finally {
    release.restore()
  }
})

test('a cancelled download stops the transfer and installs nothing', async () => {
  const userData = newUserData()
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-office-fixture-'))
  roots.push(work)
  const tarball = await makePayloadTarball(work)
  const bytes = readFileSync(tarball)
  const real = globalThis.fetch
  // A body that never ends: the transfer stays in 'downloading' until
  // cancelled. The abort is wired to the stream by hand because a hand-made
  // Response is not undici's own body — a real response errors its stream when
  // the request signal aborts, and the module relies on exactly that.
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    // A real fetch rejects immediately for an already-aborted signal, and the
    // cancel gesture can land while the metadata calls are still in flight.
    if (init?.signal?.aborted === true) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    if (target === `${OFFICIAL_BASE}/${ASSET}.sha512`) return new Response(`${sha512Hex(tarball)}\n`, { status: 200 })
    if (target === `${OFFICIAL_BASE}/${MANIFEST_ASSET}`) return new Response(JSON.stringify(payloadManifest()), { status: 200 })
    if (target === `${OFFICIAL_BASE}/${ASSET}`) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            controller.error(error)
          })
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': String(bytes.length * 100) } })
    }
    throw new Error(`no route in this test: ${target}`)
  }
  const { value } = manager(userData, () => targetFor())
  try {
    await value.download()
    const cancelled = await value.cancel()
    assert.equal(cancelled.installed, null)
    const status = await settled(value)
    assert.equal(status.phase, 'idle')
    assert.equal(status.error, null)
    assert.equal(status.installed, null)
    assert.equal(existsSync(path.join(userData, OFFICE_ROOT_DIR, OFFICE_PAYLOAD_DIR, PAYLOAD_VERSION)), false)
  } finally {
    globalThis.fetch = real
  }
})

test('the build and the shell agree on every name and on the manifest rules', () => {
  // The build writes what the shell resolves, in two module systems, so the
  // names are repeated rather than imported. This is the assertion that keeps
  // them one contract.
  for (const [platform, arch, version] of [
    ['win32', 'x64', '0.1.6-alpha.2'],
    ['win32', 'arm64', '0.1.6-alpha.2'],
    ['darwin', 'arm64', '0.1.5-rc.2'],
    ['linux', 'x64', '0.1.6-alpha.2+build.7'],
  ]) {
    assert.equal(
      officePayloadAssetName(platform, arch, version),
      build.officePayloadAssetName(platform, arch, version),
      `asset name for ${platform}-${arch}`,
    )
    assert.equal(
      officePayloadManifestName(platform, arch),
      build.officePayloadManifestName(platform, arch),
      `manifest name for ${platform}-${arch}`,
    )
  }
  // The archive layout: the build's constants are what the shell's required
  // files name, one level deep.
  assert.deepEqual(requiredFiles(ENGINE), build.officePayloadRequiredFiles(ENGINE))
  // A declared Python set makes its own manifest a required file — the check
  // that catches an archive which would install but could not answer the host's
  // `load_workspace_dependencies`.
  assert.deepEqual(requiredFiles(ENGINE, PYTHON_VERSION), build.officePayloadRequiredFiles(ENGINE, PYTHON_VERSION))
  assert.equal(requiredFiles(ENGINE, PYTHON_VERSION).some((relative) => relative.endsWith(path.join('primary-runtime', 'runtime.json'))), true)
  assert.equal(requiredFiles(ENGINE, null).some((relative) => relative.endsWith('runtime.json')), false)
  assert.equal(requiredFiles(ENGINE, '').some((relative) => relative.endsWith('runtime.json')), false)
  // The wasm engine (the kit's fallback for a target with no native engine —
  // the linux cells) does not ship the native engines' `prebuilds.json`; the
  // marker both sides require for it is the engine package's own manifest.
  const wasm = requiredFiles('wasm')
  assert.deepEqual(wasm, build.officePayloadRequiredFiles('wasm'))
  assert.equal(wasm.some((relative) => relative.endsWith('prebuilds.json')), false)
  assert.equal(wasm.some((relative) => relative.endsWith(path.join('libreoffice-kit-wasm', 'package.json'))), true)
  assert.equal(requiredFiles(ENGINE).some((relative) => relative.endsWith('prebuilds.json')), true)

  // And the manifest rules: one fixture set, both implementations, same verdict.
  const target = targetFor()
  const good = payloadManifest()
  const cases = [
    ['a matching manifest', good, []],
    ['another payload version', payloadManifest('0.9.9'), ['version']],
    ['another target', payloadManifest(PAYLOAD_VERSION, { platform: 'linux', arch: 'x64' }), ['platform']],
    ['no engine', payloadManifest(PAYLOAD_VERSION, { components: { kit: KIT_VERSION, engine: null, python: null } }), ['engine']],
    ['another engine', payloadManifest(PAYLOAD_VERSION, { components: { kit: KIT_VERSION, engine: 'darwin-arm64', python: null } }), ['engine']],
    ['no kit version', payloadManifest(PAYLOAD_VERSION, { components: { kit: '', engine: ENGINE, python: null } }), ['kit']],
  ]
  for (const [label, manifest, expected] of cases) {
    const shellProblems = manifestProblems(manifest, target)
    const buildProblems = build.officePayloadManifestProblems(manifest, { platform: PLATFORM, arch: ARCH, engine: ENGINE }, PAYLOAD_VERSION)
    assert.equal(shellProblems.length > 0, expected.length > 0, `shell verdict for ${label}: ${JSON.stringify(shellProblems)}`)
    assert.equal(buildProblems.length > 0, expected.length > 0, `build verdict for ${label}: ${JSON.stringify(buildProblems)}`)
  }
})
