// Pausable, resumable kernel downloads. A real `node:http` server serves a real
// (large, slow) runtime tarball over loopback, in two modes: honoring `Range`
// and ignoring it — the second one is what a naive resume gets wrong, because
// appending a whole 200 body to a partial file produces a spliced file that can
// never match the digest.
//
// Only the metadata URLs are redirected (github.com → the local server): the
// bytes, the HTTP conversation, the digest check, the extraction and the
// activation are all the production path.
//
// Boundaries this suite pins as unsupported: a partial file is resumed only by
// the process that paused it (never across a restart), and only for the same
// URL — an abandoned pause is cleaned up by the next install like any staging.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const require = createRequire(import.meta.url)
const { KernelManager } = require('../dist/kernel/manager.js')
const { KERNEL_ROOT_DIR, STAGING_DIR, TARBALL_FILE } = require('../dist/shared/constants.js')
const tar = require('tar')

const PLATFORM = process.platform
const ARCH = process.arch
const NODE_BINARY = PLATFORM === 'win32' ? 'node.exe' : 'node'
const VERSION = '1.0.0'
const SUITE = 's1'
const OWNER = 'owner'
const REPO = 'repo'
const TGZ_NAME = `dsh-runtime-${PLATFORM}-${ARCH}-${VERSION}.tgz`
const MANIFEST_NAME = `manifest-${PLATFORM}-${ARCH}.json`
const VERSION_DIR = `dsh-${VERSION}+suite-${SUITE}`
/** Incompressible payload: the tarball stays ~this size, so it takes real time. */
const PAD_BYTES = 1024 * 1024
const CHUNK_BYTES = 8 * 1024
const CHUNK_DELAY_MS = 8

// One transport candidate for the bytes (plus ModelScope, which a succeeding
// official candidate never reaches): the metadata chain under test is not this
// suite's subject, and a mirror URL would only add noise.
process.env.DSH_APP_GITHUB_MIRRORS = ''

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha512Hex = (value) => createHash('sha512').update(value).digest('hex')

after(() => {
  if (fixtureDir !== null) rmSync(fixtureDir, { recursive: true, force: true })
})

/**
 * The fake runtime every test serves: the layout activateTarball expects, with
 * one large random file so the download lasts long enough to be paused in the
 * middle of it. Built once — the bytes are read-only and shared.
 */
let fixturePromise = null
let fixtureDir = null
function runtimeFixture() {
  fixturePromise ??= (async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pause-fixture-'))
    fixtureDir = dir
    const runtime = path.join(dir, 'src', 'runtime')
    mkdirSync(path.join(runtime, 'node'), { recursive: true })
    mkdirSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(path.join(runtime, 'node', NODE_BINARY), 'fake-node')
    writeFileSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// dsh')
    // A real tree carries the host package the shell spawns, and `load()`
    // verifies both entries before it reuses an installed kernel.
    mkdirSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'), { recursive: true })
    writeFileSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'), '// host')
    const pad = randomBytes(PAD_BYTES)
    writeFileSync(path.join(runtime, 'node', 'pad.bin'), pad)
    const manifest = {
      dshVersion: VERSION, suiteVersion: SUITE, channel: 'stable',
      platform: PLATFORM, arch: ARCH, integrity: '', source: 'artifact',
    }
    writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify(manifest))

    const tarball = path.join(dir, 'kernel.tgz')
    await tar.c({ gzip: true, cwd: path.join(dir, 'src'), file: tarball }, ['runtime'])
    const bytes = readFileSync(tarball)
    return { bytes, digest: sha512Hex(bytes), manifest, padDigest: sha512Hex(pad), dir }
  })()
  return fixturePromise
}

/**
 * Serve the fake runtime over loopback, slowly, in one of two Range modes.
 * `rangeRequests` records every `Range` header the client sent, `stats` counts
 * the whole-body and partial responses actually delivered.
 */
async function startServer(t, { supportsRange }) {
  const fixture = await runtimeFixture()
  const rangeRequests = []
  const stats = { partial: 0, full: 0 }

  const server = createServer((req, res) => {
    void (async () => {
      const name = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.split('/').pop()
      let closed = false
      const gone = () => closed || res.destroyed || (res.socket?.destroyed ?? true)
      res.on('error', () => undefined)
      res.on('close', () => { closed = true })
      req.on('error', () => undefined)

      if (name === `${TGZ_NAME}.sha512`) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(`${fixture.digest}\n`)
        return
      }
      if (name === MANIFEST_NAME) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(fixture.manifest))
        return
      }
      if (name !== TGZ_NAME) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }

      const header = req.headers.range
      if (header !== undefined) rangeRequests.push(header)
      const match = supportsRange && header !== undefined ? /^bytes=(\d+)-$/u.exec(header) : null
      const start = match === null ? 0 : Number(match[1])
      if (match === null) {
        stats.full += 1
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(fixture.bytes.length) })
      } else {
        stats.partial += 1
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(fixture.bytes.length - start),
          'content-range': `bytes ${start}-${String(fixture.bytes.length - 1)}/${String(fixture.bytes.length)}`,
        })
      }
      for (let pos = start; pos < fixture.bytes.length; pos += CHUNK_BYTES) {
        if (gone()) return
        res.write(fixture.bytes.subarray(pos, pos + CHUNK_BYTES))
        await delay(CHUNK_DELAY_MS)
      }
      if (!gone()) res.end()
    })()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = server.address().port

  // Every metadata URL the artifact resolver builds is redirected here; anything
  // else fails loudly, so a test can never quietly reach the real network.
  const real = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!raw.startsWith(`https://github.com/${OWNER}/${REPO}/`)) {
      throw new Error(`unexpected network access in test: ${raw}`)
    }
    return real(`http://127.0.0.1:${String(port)}${new URL(raw).pathname}`, init)
  }
  t.after(() => { globalThis.fetch = real })

  return { ...fixture, port, rangeRequests, stats }
}

/** A harness with its own temp tree and a status tap; `dir` is removed at the end. */
async function harness(t, prefix = 'dsh-pause-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const userData = path.join(dir, 'userData')
  const root = path.join(userData, KERNEL_ROOT_DIR)
  const statuses = []
  const logs = []
  const manager = new KernelManager({
    runtimeRoot: userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: OWNER, artifactRepo: REPO,
    onStatus: (status) => { statuses.push(status); h.onStatus?.(status) },
    log: (message) => logs.push(message),
  })
  const h = {
    dir, userData, root, manager, statuses, logs,
    /** Set by a test to react to statuses (the pause button, in effect). */
    onStatus: null,
    stagingFile: path.join(root, STAGING_DIR, TARBALL_FILE),
    currentFile: path.join(root, 'current.json'),
    /** Progress reports of the running transfer (the paused one excluded). */
    progressReports: () => statuses.filter((s) => s.phase === 'downloading' && s.paused !== true && s.progress !== null),
    bundle: async () => {
      const fixture = await runtimeFixture()
      const target = path.join(dir, 'bundle')
      mkdirSync(target, { recursive: true })
      const tarball = path.join(target, 'kernel.tgz')
      const sidecar = `${tarball}.sha512`
      writeFileSync(tarball, fixture.bytes)
      writeFileSync(sidecar, `${fixture.digest}\n`)
      writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(fixture.manifest))
      return { tarball, sidecar }
    },
  }
  return h
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** Pause once the transfer is past `fraction`, and wait until that happened. */
async function pauseReliably(h, fraction, install) {
  const paused = deferred()
  h.onStatus = (status) => {
    if (status.phase !== 'downloading' || status.paused === true) return
    if ((status.progress ?? 0) < fraction) return
    if (h.manager.pauseDownload()) {
      // One-shot: the hook is the user's pause button, and it must not re-fire
      // on the statuses a later resume emits.
      h.onStatus = null
      paused.resolve()
    }
  }
  const running = install()
  // An install that fails instead of pausing must not hang the test.
  await Promise.race([
    paused.promise,
    running.then(() => { throw new Error('the install finished before it could be paused') }),
  ])
  return { pausedStatus: h.statuses.at(-1), running }
}

/** The frozen size of the partial file, read twice to prove it stopped growing. */
async function frozenSize(file) {
  await delay(200)
  const first = statSync(file).size
  await delay(300)
  const second = statSync(file).size
  assert.equal(second, first, 'the partial file must stop growing once paused')
  return second
}

test('pause stops the transfer where it is, and the status says so', async (t) => {
  const server = await startServer(t, { supportsRange: true })
  const h = await harness(t)

  const { pausedStatus, running } = await pauseReliably(h, 0.3, () => h.manager.installVersion(VERSION))

  assert.equal(h.manager.isDownloadPaused(), true)
  assert.equal(pausedStatus.paused, true, 'the status carries the paused flag')
  assert.equal(pausedStatus.phase, 'downloading', 'no new phase — every phase branch keeps working')
  assert.ok(pausedStatus.progress > 0 && pausedStatus.progress < 1, `progress is frozen mid-transfer (${pausedStatus.progress})`)

  const size = await frozenSize(h.stagingFile)
  assert.ok(size > 0 && size < server.bytes.length, `the partial file is kept (${size}/${server.bytes.length})`)
  assert.equal(h.manager.pauseDownload(), false, 'pausing again is a safe no-op')
  assert.equal(h.manager.isDownloadPaused(), true)

  // Nothing may be written or reported while paused. The server keeps offering
  // the remaining body, so a pause that did not stop the read would show up as
  // a growing file above and as new progress reports here.
  const reports = h.progressReports().length
  await delay(400)
  assert.equal(statSync(h.stagingFile).size, size, 'no byte is written while paused')
  assert.equal(h.progressReports().length, reports, 'no progress is reported while paused')

  // Give up on the paused install: staging (partial file included) still belongs
  // to the normal staging discipline and is reclaimed by the next install.
  const fresh = new KernelManager({
    runtimeRoot: h.userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: OWNER, artifactRepo: REPO,
  })
  const bundle = await h.bundle()
  const current = await fresh.installFromLocalTarball(bundle.tarball, bundle.sidecar)
  assert.equal(current.active, VERSION_DIR)
  assert.ok(!existsSync(path.join(h.root, STAGING_DIR)), 'the next install reclaims the abandoned staging')
  assert.deepEqual(await fresh.load(), current)
  // The abandoned install is still parked, not failed: releasing it belongs to
  // the shell that paused it, and this manager is about to be discarded.
  assert.equal(h.manager.isDownloadPaused(), true, 'an abandoned pause stays parked instead of failing the install')
})

test('resume continues with a Range request and the install finishes', async (t) => {
  const server = await startServer(t, { supportsRange: true })
  const h = await harness(t)

  const { running } = await pauseReliably(h, 0.3, () => h.manager.installVersion(VERSION))
  const size = await frozenSize(h.stagingFile)

  assert.equal(h.manager.resumeDownload(), true)
  assert.equal(h.manager.isDownloadPaused(), false)
  assert.equal(h.manager.resumeDownload(), false, 'resuming when not paused is a safe no-op')

  // The cycle is not one-shot, and a pause requested while the loop sits
  // between requests blocks the next one instead of being dropped.
  assert.equal(h.manager.pauseDownload(), true, 'pausing again after a resume takes effect')
  assert.equal(h.manager.isDownloadPaused(), true)
  await delay(50)
  assert.deepEqual(server.rangeRequests, [], 'the pending pause blocks the next request')
  assert.equal(h.statuses.filter((status) => status.paused === true).length, 2, 'both pauses are reported')
  assert.equal(h.manager.resumeDownload(), true)

  const current = await running

  assert.deepEqual(server.rangeRequests, [`bytes=${String(size)}-`], 'the resume asks for exactly the bytes we already have')
  assert.equal(server.stats.partial, 1, 'the server answered the range with a partial body')
  assert.equal(server.stats.full, 1, 'the transfer was not restarted from scratch')
  assert.equal(current.active, VERSION_DIR)
  assert.equal(
    sha512Hex(readFileSync(path.join(h.root, VERSION_DIR, 'node', 'pad.bin'))),
    server.padDigest,
    'the resumed file is byte-identical to what the server holds (the digest check passed on the way in)',
  )
  assert.ok(!existsSync(path.join(h.root, STAGING_DIR)), 'staging never survives an activation')
})

test('a server that ignores Range makes the resume restart from zero', async (t) => {
  const server = await startServer(t, { supportsRange: false })
  const h = await harness(t)

  const { running } = await pauseReliably(h, 0.3, () => h.manager.installVersion(VERSION))
  const size = await frozenSize(h.stagingFile)

  // Watch the file while the second attempt runs: an append would push it past
  // the announced size, which is the shape of the spliced file this test exists
  // to prevent (the digest would reject it anyway).
  const observed = []
  const poll = setInterval(() => {
    try {
      observed.push(statSync(h.stagingFile).size)
    } catch {
      // The file is gone once the install activates — nothing to observe.
    }
  }, 5)
  // Registered up front so a failing assertion cannot leave the interval
  // running and hold the test process open.
  t.after(() => clearInterval(poll))

  assert.equal(h.manager.resumeDownload(), true)
  const current = await running
  clearInterval(poll)

  assert.deepEqual(server.rangeRequests, [`bytes=${String(size)}-`], 'the client still asks for a range')
  assert.equal(server.stats.full, 2, 'the ignored range answered 200, so the whole body was fetched again')
  assert.equal(server.stats.partial, 0)
  assert.ok(Math.max(...observed) <= server.bytes.length, `the partial file is never appended to a foreign body (max ${Math.max(...observed)})`)
  assert.ok(h.logs.some((message) => message.includes('resume refused')), 'the refusal is logged, not silent')
  assert.equal(current.active, VERSION_DIR)
  assert.equal(
    sha512Hex(readFileSync(path.join(h.root, VERSION_DIR, 'node', 'pad.bin'))),
    server.padDigest,
    'the re-downloaded file is byte-identical',
  )
})

test('an install that is never paused transfers exactly as before', async (t) => {
  const server = await startServer(t, { supportsRange: true })
  const h = await harness(t, 'dsh-pause-plain-')

  const current = await h.manager.installVersion(VERSION)

  assert.equal(current.active, VERSION_DIR)
  assert.deepEqual(server.rangeRequests, [], 'no pause means no Range request')
  assert.deepEqual(server.stats, { partial: 0, full: 1 }, 'one request, one whole body')
  assert.ok(
    !h.statuses.some((status) => 'paused' in status),
    'an un-paused transfer never reports a paused flag — the payloads stay as they were',
  )
  assert.equal(
    sha512Hex(readFileSync(path.join(h.root, VERSION_DIR, 'node', 'pad.bin'))),
    server.padDigest,
  )
})

test('pause and resume are no-ops when no download is running', async (t) => {
  const h = await harness(t, 'dsh-pause-noop-')

  assert.equal(h.manager.isDownloadPaused(), false)
  assert.equal(h.manager.pauseDownload(), false)
  assert.equal(h.manager.resumeDownload(), false)

  // Also during an install that downloads nothing (the bundled tarball path):
  // the pause button must stay harmless, and never report a paused transfer.
  const seen = []
  h.onStatus = (status) => { if (status.phase === 'extracting') seen.push(h.manager.pauseDownload()) }
  const bundle = await h.bundle()
  const current = await h.manager.installFromLocalTarball(bundle.tarball, bundle.sidecar)

  assert.equal(current.active, VERSION_DIR)
  assert.ok(seen.length > 0, 'the local install reported its extraction phases')
  assert.ok(seen.every((answer) => answer === false), 'a pause during a local install is a no-op')
  assert.equal(h.manager.isDownloadPaused(), false)
})
