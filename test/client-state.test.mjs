// The window's own client state belongs to the kernel LINE that wrote it.
//
// Measured on the v0.12.0 release: `dsh.workspace.view.v5` lost its
// `sessionUpdatedAtByAccount` field in the 0.1.6 line while the rc line's
// `retainAccountKeys` still reads it with `Object.entries`, so one run of the
// newer client crashed the older one's session list for good
// (`slot entry crashed in 'sidebar.workspaces'`), sessions and all still on
// disk. This module is what keeps the two lines from reading each other's state.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { CLIENT_STATE_MARKER, alignWindowStateWithLine, kernelLine } = require('../dist/main/client-state.js')

/** A session that records what a clear asked for. */
function fakeSession() {
  const calls = []
  return { calls, clearStorageData: async (options) => { calls.push(options) } }
}

function markerDir(line) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-window-line-'))
  if (line !== undefined) {
    writeFileSync(path.join(dir, CLIENT_STATE_MARKER), `${JSON.stringify({ line, at: 'x' })}\n`)
  }
  return dir
}

test('the line is the version without its prerelease part', () => {
  assert.equal(kernelLine('0.1.5-rc.2'), '0.1.5')
  assert.equal(kernelLine('0.1.5-rc.1'), '0.1.5')
  assert.equal(kernelLine('0.1.5'), '0.1.5')
  assert.equal(kernelLine('0.1.6-alpha.1'), '0.1.6')
  assert.equal(kernelLine('0.1.6'), '0.1.6')
  assert.equal(kernelLine('0.1.5+build7'), '0.1.5')
  assert.equal(kernelLine(undefined), undefined)
  assert.equal(kernelLine(''), undefined)
  assert.equal(kernelLine('nightly'), undefined)
})

test('a line change resets the storage, the same line keeps it', async () => {
  const dir = markerDir('0.1.5')
  const session = fakeSession()
  const moved = await alignWindowStateWithLine({ session, userDataDir: dir, version: '0.1.6-alpha.1' })
  assert.deepEqual(moved, { status: 'cleared', line: '0.1.6', previous: '0.1.5' })
  assert.deepEqual(session.calls, [{ storages: ['localstorage'] }])
  assert.equal(JSON.parse(readFileSync(path.join(dir, CLIENT_STATE_MARKER), 'utf8')).line, '0.1.6')

  const same = await alignWindowStateWithLine({ session, userDataDir: dir, version: '0.1.6-alpha.2' })
  assert.equal(same.status, 'kept')
  assert.equal(session.calls.length, 1)

  // A patch-level kernel update inside a line is not a line change.
  const back = await alignWindowStateWithLine({ session, userDataDir: dir, version: '0.1.5-rc.2' })
  assert.deepEqual(back, { status: 'cleared', line: '0.1.5', previous: '0.1.6' })
  assert.equal(session.calls.length, 2)
})

test('the first start under this rule adopts what is there instead of clearing it', async () => {
  const dir = markerDir(undefined)
  const session = fakeSession()
  const first = await alignWindowStateWithLine({ session, userDataDir: dir, version: '0.1.5-rc.2' })
  assert.deepEqual(first, { status: 'adopted', line: '0.1.5' })
  assert.deepEqual(session.calls, [])
  assert.equal(JSON.parse(readFileSync(path.join(dir, CLIENT_STATE_MARKER), 'utf8')).line, '0.1.5')

  // An unusable marker is the same case: nothing says which line wrote the
  // state, so it is kept and the marker is rewritten.
  const broken = markerDir(undefined)
  writeFileSync(path.join(broken, CLIENT_STATE_MARKER), 'not json\n')
  const adopted = await alignWindowStateWithLine({ session, userDataDir: broken, version: '0.1.5-rc.2' })
  assert.equal(adopted.status, 'adopted')
  assert.deepEqual(session.calls, [])
})

test('a version that names no line is skipped rather than guessed at', async () => {
  const dir = markerDir('0.1.5')
  const session = fakeSession()
  const outcome = await alignWindowStateWithLine({ session, userDataDir: dir, version: undefined })
  assert.equal(outcome.status, 'skipped')
  assert.deepEqual(session.calls, [])
  assert.equal(JSON.parse(readFileSync(path.join(dir, CLIENT_STATE_MARKER), 'utf8')).line, '0.1.5')
})
