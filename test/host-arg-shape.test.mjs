// The host child's argv shape and transport: which positional arguments a given
// @deepseek-ai/dsh-desktop-host line takes, how the shell reaches its web
// surface, and what happens when the shell cannot tell. The two shapes are the
// ends of the range this shell ships against — 0.1.5-rc.2 takes the profile
// directory alone, 0.1.6-alpha.1 takes the runtime tree as well — so a wrong
// guess is a hard boot failure ("unsupported internal option"), and the
// refused-then-retried fallback is what keeps an unmapped version from being a
// dead app. The transport moved between 0.1.6-alpha.1 and -alpha.2, from the
// framed byte pipes to the child's own authenticated URL.
//
// The fallback is exercised against a fake host that enforces the old line's
// contract and refuses the new shape the way the real one does, because no
// single real runtime can prove both sides of the discovery. The web transport
// is exercised against a fake host that binds a real loopback listener, so the
// exchange, the forward and the index rendering all run for real.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  DshHost,
  desktopHostDir,
  desktopHostEntry,
  hostArgShape,
  hostPackageVersion,
  hostProfileAnchor,
  hostTransport,
} = require('../dist/main/desktop-host.js')

/**
 * Fake host child: enforces the argv contract it is told to have, reports ready
 * over the IPC channel, and answers `GET /index.html` over the byte pipes. A
 * shape it does not accept is refused exactly as the real hosts refuse it —
 * a `fatal` event naming the argument, then a non-zero exit.
 */
const FAKE_HOST = `
const fs = require('node:fs')
const argv = process.argv.slice(2)
const flag = argv[argv.length - 1] === '--allow-linked-profile'
const positional = flag ? argv.slice(0, -1) : argv
const expected = process.env.FAKE_HOST_CONTRACT === 'runtime-and-project' ? 2 : 1
if (process.env.FAKE_HOST_CONTRACT === 'fail-other') {
  process.send({ type: 'fatal', message: 'dsh desktop: composition did not provide connection, typertGateway, and clientModules' })
  setTimeout(() => { process.exit(1) }, 10)
} else if (positional.length !== expected) {
  process.send({ type: 'fatal', message: 'dsh desktop: unsupported internal option ' + JSON.stringify(positional[1] || '') })
  setTimeout(() => { process.exit(1) }, 10)
} else {
  const response = fs.createWriteStream('', { fd: 4, autoClose: false })
  const request = fs.createReadStream('', { fd: 3, autoClose: false })
  let pending = Buffer.alloc(0)
  const frame = (type, streamId, payload) => {
    const value = Buffer.allocUnsafe(13 + payload.byteLength)
    value.writeUInt32BE(0x44534833, 0)
    value.writeUInt8(type, 4)
    value.writeUInt32BE(streamId, 5)
    value.writeUInt32BE(payload.byteLength, 9)
    payload.copy(value, 13)
    response.write(value)
  }
  request.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.byteLength >= 13 && pending.byteLength >= 13 + pending.readUInt32BE(9)) {
      const type = pending.readUInt8(4)
      const streamId = pending.readUInt32BE(5)
      const length = pending.readUInt32BE(9)
      const payload = pending.subarray(13, 13 + length)
      pending = pending.subarray(13 + length)
      if (type !== 1) continue
      const url = new URL(JSON.parse(payload.toString('utf8')).url)
      const body = Buffer.from('<!doctype html><title>fake ' + url.pathname + '</title>')
      frame(1, streamId, Buffer.from(JSON.stringify({ status: url.pathname === '/index.html' ? 200 : 404, headers: [['content-type', 'text/html']], hasBody: true })))
      frame(2, streamId, body)
      frame(3, streamId, Buffer.alloc(0))
    }
  })
  process.on('message', (message) => { if (message && message.type === 'shutdown') process.exit(0) })
  process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'fake' })
}
`

/**
 * Fake host child of the WEB transport line (0.1.6-alpha.2 and later): it takes
 * the fixed positional contract, binds its own loopback listener, trades the
 * launch URL for a cookie, and serves one index document — which is what the
 * shell's forward path is exercised against. A contract it does not get is
 * refused exactly as the real host refuses it.
 */
const FAKE_WEB_HOST = `
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const argv = process.argv.slice(2)
const problems = []
if (!process.execArgv.includes('--expose-internals')) problems.push('missing --expose-internals')
// The 0.1.7 contract: runtime tree, profile, primary-runtime — then, and only
// then, the package-manager pair (the pnpm script and the Node directory that
// runs it). The slot this line dropped used to be the profile-resolution mode,
// and the slot after that is the package-manager script, so a shell still
// sending a mode is handing the child a package manager it never chose.
if (argv.length !== 3 && argv.length !== 5) problems.push('positional count ' + String(argv.length))
if (argv.length === 5) {
  if (!String(argv[3] || '').endsWith('pnpm.mjs')) problems.push('package manager script ' + JSON.stringify(argv[3] || ''))
  if (!fs.existsSync(path.join(String(argv[4] || ''), 'node.exe')) && !fs.existsSync(path.join(String(argv[4] || ''), 'node'))) {
    problems.push('package manager node dir ' + JSON.stringify(argv[4] || ''))
  }
}
if (process.env.FAKE_WEB_CONTRACT === 'refuse') problems.push('unsupported internal option ' + JSON.stringify(argv[1] || ''))
// The real host composes the office skill plugin with
// assetRoot = join(dirname(argv[2]), 'office-skills') and the plugin throws at
// boot unless that holds scripts/check_office.py. Enforced here so a shell that
// answers with the payload's own primary-runtime (which moves the derived root
// into <payload>/office-skills) fails this suite instead of the user's boot.
if (argv[2] !== undefined) {
  const assetRoot = path.join(path.dirname(argv[2]), 'office-skills')
  if (!fs.existsSync(path.join(assetRoot, 'scripts', 'check_office.py'))) {
    problems.push('office skills missing at ' + assetRoot)
  }
}
if (problems.length > 0) {
  process.send({ type: 'fatal', message: 'dsh desktop: ' + problems.join('; ') })
  setTimeout(() => { process.exit(1) }, 10)
} else {
  // The child's own PATH, written where the test can read it: the shell puts the
  // bundled package manager's shim in front of it, and the kernel's CLI path
  // resolves pnpm by NAME through exactly this variable.
  fs.writeFileSync(path.join(process.cwd(), '.fake-web-path.txt'), process.env.PATH || '')
  const server = http.createServer((request, response) => {
    if ((request.url || '').startsWith('/?token=')) {
      response.writeHead(303, { 'set-cookie': 'dsh=fake-session; Path=/; HttpOnly', location: '/' })
      response.end()
      return
    }
    if (new URL(request.url, 'http://x').pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head></head><body>fake web index</body></html>')
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1', () => {
    process.send({
      type: 'ready',
      url: 'http://127.0.0.1:' + String(server.address().port) + '/?token=fake-token',
      injections: process.env.FAKE_WEB_INJECTIONS === 'missing'
        ? undefined
        : [{ kind: 'global', name: '__DSH_BOOT__', value: { entries: [] } }],
    })
  })
  process.on('message', (message) => {
    if (message && message.type === 'shutdown') { server.close(); process.exit(0) }
  })
}
`

/** A runtime tree whose host package reports `version` and enforces `contract`. */
function fakeRuntime(version, contract) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-arg-shape-'))
  const dir = desktopHostDir(root)
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version })}\n`)
  writeFileSync(path.join(dir, 'lib', 'index.js'), FAKE_HOST)
  return { root, contract, projectDir: mkdtempSync(path.join(os.tmpdir(), 'dsh-arg-shape-profile-')) }
}

/**
 * A runtime tree whose host speaks the web transport, plus the office payload
 * its fourth positional has to point beside and the shell data directory that
 * payload is materialized under.
 */
function fakeWebRuntime(version, contract = 'accept', env = {}) {
  const runtime = fakeRuntime(version, undefined)
  const officeSource = mkdtempSync(path.join(os.tmpdir(), 'dsh-office-assets-'))
  mkdirSync(path.join(officeSource, 'scripts'), { recursive: true })
  writeFileSync(path.join(officeSource, 'scripts', 'check_office.py'), '# fake office check\n')
  writeFileSync(path.join(desktopHostDir(runtime.root), 'lib', 'index.js'), FAKE_WEB_HOST)
  return {
    ...runtime,
    officeSource,
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'dsh-web-data-')),
    env: { FAKE_WEB_CONTRACT: contract, ...env },
  }
}

/** Start a fake host through the real transport, collecting its log lines. */
async function start(runtime, logs = [], options = {}) {
  const host = new DshHost({
    executable: process.execPath,
    entry: desktopHostEntry(runtime.root),
    runtimeDir: runtime.root,
    projectDir: runtime.projectDir,
    env: { ...process.env, FAKE_HOST_CONTRACT: runtime.contract, ...runtime.env },
    onLog: (line) => { logs.push(line) },
    ...options,
  })
  await host.start()
  return { host, logs, shapes: () => shapes(logs) }
}

/** The start's inputs for a web runtime, with the payload it needs. */
function webStartOptions(runtime) {
  return {
    officeSkillsSource: runtime.officeSource,
    userDataDir: runtime.dataDir,
    allowLinkedProfile: true,
    // What index.ts names for an installed runtime tree: the host is handed the
    // tree's `app/` directory as `runtimeDir`, and the bundled pnpm sits at the
    // tree's root.
    pnpmTree: runtime.root,
  }
}

/** Absolute path of a shell's data directory, read off a start's argv. */
function dataDirOf(runtime) {
  return path.join(runtime.dataDir, 'dsh-app-office')
}

/**
 * A web runtime that CARRIES the bundled package manager: `pnpm/bin/pnpm.mjs`
 * and the Node directory beside the tree, the two things the shell hands the
 * child in its last argument slots.
 */
function withBundledPnpm(runtime) {
  const bin = path.join(runtime.root, 'pnpm', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'pnpm.mjs'), '#!/usr/bin/env node\nconsole.log("fake pnpm")\n')
  writeFileSync(path.join(bin, 'pnpm.cmd'), '@echo off\r\necho fake pnpm\r\n')
  mkdirSync(path.join(runtime.root, 'node'), { recursive: true })
  writeFileSync(path.join(runtime.root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), 'fake node\n')
  return runtime
}

/** The PATH the child was spawned with, as the fake host recorded it. */
function childPath(runtime) {
  return readFileSync(path.join(runtime.projectDir, '.fake-web-path.txt'), 'utf8')
}

/**
 * Canonical long-form path for comparisons.
 *
 * `realpathSync` on a Windows junction hands back the 8.3 SHORT form
 * (`ADMINI~1`) of a long target, so a plain realpath comparison between a link
 * and the directory it points at fails on a machine with short names enabled.
 * `.native` resolves the same link to the long form both sides agree on.
 */
function canonical(target) {
  return realpathSync.native(target)
}

/** One shell log line, by the prefix that names it. */
function line(logs, prefix) {
  const found = logs.find((entry) => entry.startsWith(prefix))
  assert.ok(found !== undefined, `the shell must log "${prefix}" (got ${JSON.stringify(logs)})`)
  return found
}

/** The shell's own lines saying which argv shape it used, in order. */
function shapes(logs) {
  return logs.filter((line) => line.startsWith('dsh host: argv shape'))
}

test('the shape follows the host package version', () => {
  assert.equal(hostArgShape('0.1.5-rc.2'), 'project-only')
  assert.equal(hostArgShape('0.1.5'), 'project-only')
  assert.equal(hostArgShape('0.1.4'), 'project-only')
  assert.equal(hostArgShape('0.1.6-alpha.1'), 'runtime-and-project')
  assert.equal(hostArgShape('0.1.7'), 'runtime-and-project')
  assert.equal(hostArgShape('0.2.0'), 'runtime-and-project')
  assert.equal(hostArgShape('1.0.0'), 'runtime-and-project')
  assert.equal(hostArgShape('local'), undefined)
  assert.equal(hostArgShape(undefined), undefined)
})

test('the profile anchor follows the same boundary as the shape', () => {
  // The release that moved the runtime slot into argv also moved where the host
  // resolves the profile's kernel packages from, so one version answers both.
  assert.equal(hostProfileAnchor('0.1.5-rc.2'), 'profile')
  assert.equal(hostProfileAnchor('0.1.5'), 'profile')
  assert.equal(hostProfileAnchor('0.1.4'), 'profile')
  assert.equal(hostProfileAnchor('0.1.6-alpha.1'), 'runtime')
  assert.equal(hostProfileAnchor('1.0.0'), 'runtime')
  assert.equal(hostProfileAnchor('local'), undefined)
  assert.equal(hostProfileAnchor(undefined), undefined)
})

test('the version comes from the runtime tree, or from the app directory itself', () => {
  const installed = fakeRuntime('0.1.5-rc.2', 'project-only')
  assert.equal(hostPackageVersion(installed.root), '0.1.5-rc.2')
  // A dev checkout hands over the app directory as the runtime: its own
  // manifest answers, but only when it really is the host package.
  assert.equal(hostPackageVersion(path.join(installed.root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')), '0.1.5-rc.2')
  assert.equal(hostPackageVersion(path.dirname(installed.root)), undefined)
})

test('the transport follows the host package version at its own boundary', () => {
  // The move happened inside the 0.1.6 alpha line, so a prerelease is what
  // decides — not the patch level the argv shape moved at.
  assert.equal(hostTransport('0.1.5-rc.2'), 'frames')
  assert.equal(hostTransport('0.1.6-alpha.1'), 'frames')
  assert.equal(hostTransport('0.1.6-alpha.2'), 'web')
  assert.equal(hostTransport('0.1.6'), 'web')
  assert.equal(hostTransport('0.1.7'), 'web')
  assert.equal(hostTransport('1.0.0'), 'web')
  // A loose parse still answers a `v` prefix, and an unreadable version is not
  // a guess: the caller then keeps today's frames contract.
  assert.equal(hostTransport('v0.1.6-alpha.2'), 'web')
  assert.equal(hostTransport('local'), undefined)
  assert.equal(hostTransport(undefined), undefined)
})

test('a mapped version boots the shape it takes', async () => {
  const old = fakeRuntime('0.1.5-rc.2', 'project-only')
  const oldRun = await start(old)
  assert.equal(oldRun.shapes().length, 1)
  assert.match(oldRun.shapes()[0], /argv shape project-only \(host package 0\.1\.5-rc\.2\)/)
  assert.equal(oldRun.host.dshVersion, 'fake')
  const oldResponse = await oldRun.host.fetch(new Request('http://dsh-app.local/index.html'))
  assert.equal(oldResponse.status, 200)
  assert.match(await oldResponse.text(), /doctype html/u)
  await oldRun.host.stop()

  const current = fakeRuntime('0.1.6-alpha.1', 'runtime-and-project')
  const currentRun = await start(current)
  assert.equal(currentRun.shapes().length, 1)
  assert.match(currentRun.shapes()[0], /argv shape runtime-and-project \(host package 0\.1\.6-alpha\.1\)/)
  assert.equal((await currentRun.host.fetch(new Request('http://dsh-app.local/index.html'))).status, 200)
  await currentRun.host.stop()
})

test('an unmapped version is discovered by the refusal, once', async () => {
  const runtime = fakeRuntime('local', 'project-only')
  const run = await start(runtime)
  const shapes = run.shapes()
  assert.equal(shapes.length, 2)
  assert.match(shapes[0], /argv shape runtime-and-project \(host package version local unmapped/u)
  assert.match(shapes[1], /argv shape project-only \(fallback: the host refused runtime-and-project — .*unsupported internal option/u)
  // The retry must leave the transport whole: a request still round-trips.
  const response = await run.host.fetch(new Request('http://dsh-app.local/index.html'))
  assert.equal(response.status, 200)
  assert.match(await response.text(), /doctype html/u)
  await run.host.stop()
})

test('an unmapped version that takes the current shape never retries', async () => {
  const runtime = fakeRuntime('local', 'runtime-and-project')
  const run = await start(runtime)
  assert.equal(run.shapes().length, 1)
  assert.match(run.shapes()[0], /argv shape runtime-and-project \(host package version local unmapped/u)
  assert.equal((await run.host.fetch(new Request('http://dsh-app.local/index.html'))).status, 200)
  await run.host.stop()
})

test('an unreadable version starts on the current shape and falls back', async () => {
  // A manifest that parses but carries no usable version...
  const versionless = fakeRuntime('0.1.5-rc.2', 'project-only')
  writeFileSync(path.join(desktopHostDir(versionless.root), 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: 42 })}\n`)
  const run = await start(versionless)
  const shapeLines = run.shapes()
  assert.equal(shapeLines.length, 2)
  assert.match(shapeLines[0], /argv shape runtime-and-project \(host package version unreadable/u)
  assert.match(shapeLines[1], /fallback/u)
  assert.equal((await run.host.fetch(new Request('http://dsh-app.local/index.html'))).status, 200)
  await run.host.stop()

  // ...and one that is not there at all (a checkout root that never installed it).
  const manifestless = fakeRuntime('0.1.5-rc.2', 'project-only')
  rmSync(path.join(desktopHostDir(manifestless.root), 'package.json'))
  const second = await start(manifestless)
  assert.equal(second.shapes().length, 2)
  assert.equal((await second.host.fetch(new Request('http://dsh-app.local/index.html'))).status, 200)
  await second.host.stop()
})

test('a failure that is not about the shape is reported, never retried', async () => {
  // A mapped version never retries, whatever the child says.
  const mappedLogs = []
  const mapped = fakeRuntime('0.1.5-rc.2', 'fail-other')
  await assert.rejects(start(mapped, mappedLogs), /composition did not provide connection/u)
  assert.equal(shapes(mappedLogs).length, 1)

  // An unmapped version retries only on the shape refusal itself: a real boot
  // failure must surface on the first attempt instead of being started twice.
  const unmappedLogs = []
  const unmapped = fakeRuntime('local', 'fail-other')
  await assert.rejects(start(unmapped, unmappedLogs), /composition did not provide connection/u)
  assert.equal(shapes(unmappedLogs).length, 1)
})

test('a web-transport version starts on the child URL contract, office payload and all', async () => {
  const runtime = fakeWebRuntime('0.1.6-alpha.2')
  const logs = []
  const run = await start(runtime, logs, webStartOptions(runtime))
  try {
    assert.match(line(logs, 'dsh host: argv shape'), /argv shape runtime-and-project \(host package 0\.1\.6-alpha\.2\)/u)
    assert.match(line(logs, 'dsh host: web transport'), /web transport \(host package 0\.1\.6-alpha\.2\)/u)

    // The shape is fixed, so the arguments it used are logged: a child that
    // refuses them leaves nothing else to read.
    const argv = JSON.parse(line(logs, 'dsh host: web argv').slice('dsh host: web argv '.length))
    const primaryRuntime = path.join(runtime.dataDir, 'dsh-app-office', 'primary-runtime')
    // The list ENDS at the primary-runtime path ON A TREE WITHOUT pnpm: the
    // kernel line that removed the profile-resolution mode also turned the old
    // next slot into the package-manager script, so a shell still sending
    // `'link'` here handed the child `node --expose-internals link` as its
    // package manager. The pair a tree WITH pnpm gets is the next test's.
    assert.deepEqual(argv, [
      '--expose-internals',
      desktopHostEntry(runtime.root),
      runtime.root,
      runtime.projectDir,
      primaryRuntime,
    ])
    // And nothing was put in front of this child's PATH: a shell that invented a
    // shim directory would be pointing the kernel at a pnpm that is not there.
    assert.equal(childPath(runtime).includes(`${path.sep}pnpm${path.sep}`), false)
    // The invariant the child depends on, not the literal: its asset root is
    // `dirname(argv[4])/office-skills`, so the payload must sit BESIDE the
    // argument — naming the leaf inside the payload puts the name twice in the
    // derived root and the skill fails its boot check on a path that cannot exist.
    const assetRoot = path.join(path.dirname(primaryRuntime), 'office-skills')
    assert.equal(path.basename(assetRoot), 'office-skills')
    assert.equal(
      readFileSync(path.join(assetRoot, 'scripts', 'check_office.py'), 'utf8'),
      '# fake office check\n',
    )
    // No shape fallback is possible on this transport.
    assert.equal(run.shapes().length, 1)

    // The URL contract reports no dsh version, and the token it carries is a
    // credential: it may never reach a log line.
    assert.equal(run.host.dshVersion, undefined)
    assert.match(line(logs, 'dsh host: web transport ready at'), /^dsh host: web transport ready at http:\/\/127\.0\.0\.1:\d+$/u)
    assert.equal(logs.some((entry) => entry.includes('token=fake-token')), false)

    // The whole path runs against the fake child: authenticate, forward, and
    // render the boot rows into the index document it served raw.
    const response = await run.host.fetch(new Request('http://dsh-app.local/index.html'))
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /fake web index/u)
    assert.ok(html.includes('globalThis["__DSH_BOOT__"] = {"entries":[]}'), 'the boot row reaches the document')
    assert.ok(html.includes('globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()'), 'the client gate is created')
  } finally {
    await run.host.stop()
  }
})

test('a runtime carrying pnpm sends the package-manager pair and puts its shim on PATH', async () => {
  // The kernel's package operations are child processes: the service path takes
  // the script from these two slots, and the CLI path (`dsh plugin … add`) runs
  // `execa('pnpm')`, resolving the command NAME through PATH. Without both, a
  // package operation works only where the user happens to have pnpm installed.
  const runtime = withBundledPnpm(fakeWebRuntime('0.1.7-alpha.2'))
  const logs = []
  const run = await start(runtime, logs, webStartOptions(runtime))
  try {
    const argv = JSON.parse(line(logs, 'dsh host: web argv').slice('dsh host: web argv '.length))
    const primaryRuntime = path.join(runtime.dataDir, 'dsh-app-office', 'primary-runtime')
    assert.deepEqual(argv, [
      '--expose-internals',
      desktopHostEntry(runtime.root),
      runtime.root,
      runtime.projectDir,
      primaryRuntime,
      // The script the host runs with its own Node, then the Node directory that
      // governs the package manager's own child processes — upstream's two slots.
      path.join(runtime.root, 'pnpm', 'bin', 'pnpm.mjs'),
      path.join(runtime.root, 'node'),
    ])
    // The shim comes FIRST on the child's PATH: a later entry would lose to a
    // global pnpm of another version, which is the whole reason to bundle one.
    const childPathValue = childPath(runtime)
    assert.equal(childPathValue.split(path.delimiter)[0], path.join(runtime.root, 'pnpm', 'bin'))
    // …and the child accepted it, which is what the fake host's own contract
    // check proves: it refuses a count other than 3 or 5, and a fifth slot pair
    // that is not a pnpm script plus a Node directory.
    assert.equal(run.shapes().length, 1)
    assert.match(line(logs, 'dsh host: web transport ready at'), /^dsh host: web transport ready at http:\/\/127\.0\.0\.1:\d+$/u)
  } finally {
    await run.host.stop()
  }
})

test('a web-transport child that refuses its fixed argv is reported, never retried', async () => {
  const runtime = fakeWebRuntime('0.1.6-alpha.2', 'refuse')
  const logs = []
  await assert.rejects(start(runtime, logs, webStartOptions(runtime)), /unsupported internal option/u)
  assert.equal(shapes(logs).length, 1)
  assert.ok(logs.some((entry) => entry.startsWith('dsh host: web argv')), 'the refused arguments are in the log')
})

test('a web-transport start without its office payload fails before the spawn', async () => {
  const runtime = fakeWebRuntime('0.1.6-alpha.2')
  const logs = []
  await assert.rejects(
    start(runtime, logs, { ...webStartOptions(runtime), officeSkillsSource: path.join(runtime.officeSource, 'gone') }),
    /office payload .* is missing or incomplete/u,
  )
  await assert.rejects(
    start(runtime, [], { ...webStartOptions(runtime), userDataDir: undefined }),
    /no shell data directory was named/u,
  )
  // No child ever reported ready, so nothing was started and nothing to stop.
  assert.equal(logs.some((entry) => entry.includes('web transport ready')), false)
})

test('a web-transport ready without an injection table fails the start', async () => {
  const runtime = fakeWebRuntime('0.1.6-alpha.2', 'accept', { FAKE_WEB_INJECTIONS: 'missing' })
  const logs = []
  await assert.rejects(start(runtime, logs, webStartOptions(runtime)), /without an index injection table/u)
})

/**
 * The regression this suite exists to prevent, learned from a real boot failure:
 * a payload carrying a Python set used to be handed to the child AS the
 * primary-runtime argument, which moved the child's derived asset root into
 * `<payload>/office-skills` — a directory no artifact carries — and the office
 * skill plugin threw at boot ("ENOENT … check_office.py"). The argument must
 * stay the fixed leaf beside the materialized skills, with the Python set linked
 * there.
 */
test('a payload carrying a Python set is linked beside the skills, never handed as the argument', async () => {
  const runtime = fakeWebRuntime('0.1.6-alpha.2')
  // A payload whose primary-runtime is a complete set (its runtime.json is what
  // `primaryRuntimeDir` gates on) — the shape that used to break the boot.
  const payloadRuntime = mkdtempSync(path.join(os.tmpdir(), 'dsh-payload-python-'))
  writeFileSync(path.join(payloadRuntime, 'runtime.json'), '{"components":{"python":"3.12.14"}}\n')
  mkdirSync(path.join(payloadRuntime, 'dependencies'), { recursive: true })
  const logs = []
  const run = await start(runtime, logs, { ...webStartOptions(runtime), officePrimaryRuntime: payloadRuntime })
  try {
    const leaf = path.join(dataDirOf(runtime), 'primary-runtime')
    const skills = path.join(dataDirOf(runtime), 'office-skills')
    // The child's own check ran: the asset root it derives exists.
    assert.ok(existsSync(path.join(skills, 'scripts', 'check_office.py')), 'the materialized skills sit beside the leaf')
    // The leaf is a link to the payload's set, not the payload path itself.
    assert.equal(lstatSync(leaf).isSymbolicLink(), true, 'the leaf is a link')
    assert.equal(canonical(leaf), canonical(payloadRuntime), 'the link resolves to the payload set')
    // And the argument the child was handed is the leaf, whose parent holds the
    // skills — the contract the fake host enforced above.
    const argv = JSON.parse(line(logs, 'dsh host: web argv').slice('dsh host: web argv '.length))
    assert.equal(argv[4], leaf)
    assert.equal(path.dirname(argv[4]), path.dirname(skills))
    // The set is reachable through the argument: this is what the host's
    // `load_workspace_dependencies` installs.
    assert.ok(existsSync(path.join(argv[4], 'runtime.json')), 'the tool finds its runtime.json through the argument')
  } finally {
    await run.host.stop()
  }
})

test('the leaf link is replaced when the payload moves and dropped when none is declared', async () => {
  const runtime = fakeWebRuntime('0.1.6-alpha.2')
  const first = mkdtempSync(path.join(os.tmpdir(), 'dsh-payload-a-'))
  const second = mkdtempSync(path.join(os.tmpdir(), 'dsh-payload-b-'))
  for (const dir of [first, second]) writeFileSync(path.join(dir, 'runtime.json'), '{}\n')
  const leaf = path.join(dataDirOf(runtime), 'primary-runtime')

  const a = await start(runtime, [], { ...webStartOptions(runtime), officePrimaryRuntime: first })
  await a.host.stop()
  assert.equal(canonical(leaf), canonical(first))

  // A kernel update installs a new payload version: the leaf follows it.
  const b = await start(runtime, [], { ...webStartOptions(runtime), officePrimaryRuntime: second })
  await b.host.stop()
  assert.equal(canonical(leaf), canonical(second))

  // A kernel whose payload carries no Python set must not leave a stale link
  // pointing at a pruned payload directory.
  const c = await start(runtime, [], webStartOptions(runtime))
  await c.host.stop()
  assert.equal(existsSync(leaf), false, 'no Python set declared → no leaf')
  assert.ok(existsSync(path.join(dataDirOf(runtime), 'office-skills', 'scripts', 'check_office.py')), 'the skills stay materialized')
})
