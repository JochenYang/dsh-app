// The host child's argv shape: which positional arguments a given
// @deepseek-ai/dsh-desktop-host line takes, and what happens when the shell
// cannot tell. The two shapes are the ends of the range this shell ships
// against — 0.1.5-rc.2 takes the profile directory alone, 0.1.6-alpha.1 takes
// the runtime tree as well — so a wrong guess is a hard boot failure
// ("unsupported internal option"), and the refused-then-retried fallback is
// what keeps an unmapped version from being a dead app.
//
// The fallback is exercised against a fake host that enforces the old line's
// contract and refuses the new shape the way the real one does, because no
// single real runtime can prove both sides of the discovery.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** A runtime tree whose host package reports `version` and enforces `contract`. */
function fakeRuntime(version, contract) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-arg-shape-'))
  const dir = desktopHostDir(root)
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version })}\n`)
  writeFileSync(path.join(dir, 'lib', 'index.js'), FAKE_HOST)
  return { root, contract, projectDir: mkdtempSync(path.join(os.tmpdir(), 'dsh-arg-shape-profile-')) }
}

/** Start a fake host through the real transport, collecting its log lines. */
async function start(runtime, logs = []) {
  const host = new DshHost({
    executable: process.execPath,
    entry: desktopHostEntry(runtime.root),
    runtimeDir: runtime.root,
    projectDir: runtime.projectDir,
    env: { ...process.env, FAKE_HOST_CONTRACT: runtime.contract },
    onLog: (line) => { logs.push(line) },
  })
  await host.start()
  return { host, logs, shapes: () => shapes(logs) }
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
