// The session-side handshake rewrite: from 0.1.6-alpha.2 the client streams over
// a plain WebSocket straight to the host's loopback origin, so the shell has to
// attach the host cookie and an origin the host accepts — and refuse everyone
// else's handshake. See src/main/host-stream-auth.ts.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { installHostStreamAuth } = require('../dist/main/host-stream-auth.js')
const { APP_ORIGIN } = require('../dist/main/desktop-host.js')

/** A session stand-in that keeps the handler it was given. */
function fakeSession() {
  const installed = []
  return {
    installed,
    webRequest: {
      onBeforeSendHeaders: (filter, handler) => { installed.push({ filter, handler }) },
    },
  }
}

/** Call one installed handler the way Electron would. */
function call(handler, details) {
  let answer
  handler(details, (result) => { answer = result })
  return answer
}

const HOST = 'http://127.0.0.1:19387'
const TARGET = { origin: HOST, cookie: 'dsh=abc123' }

test('the window’s own handshake to the host carries the cookie and the host origin', () => {
  const session = fakeSession()
  installHostStreamAuth(session, () => TARGET, () => 7)
  const { filter, handler } = session.installed[0]
  // The pattern is what keeps this off every other socket on the machine.
  assert.deepEqual(filter, { urls: ['ws://127.0.0.1/*'] })

  const answer = call(handler, {
    url: 'ws://127.0.0.1:19387/api/gateway/stream',
    webContentsId: 7,
    requestHeaders: { Origin: APP_ORIGIN, 'User-Agent': 'probe' },
  })
  assert.deepEqual(answer, {
    requestHeaders: {
      'user-agent': 'probe',
      origin: HOST,
      cookie: 'dsh=abc123',
      'sec-fetch-site': 'same-origin',
    },
  })
})

test('a handshake from any other origin is cancelled, not rewritten', () => {
  const session = fakeSession()
  installHostStreamAuth(session, () => TARGET, () => 7)
  const { handler } = session.installed[0]
  const answer = call(handler, {
    url: 'ws://127.0.0.1:19387/api/gateway/stream',
    webContentsId: 7,
    requestHeaders: { origin: 'http://localhost:3000' },
  })
  assert.deepEqual(answer, { cancel: true })
})

test('another window, another port or a host that is not ready is left alone', () => {
  const cases = [
    { why: 'the target is not known yet', target: () => undefined, windowId: () => 7, webContentsId: 7, url: 'ws://127.0.0.1:19387/x' },
    { why: 'there is no window yet', target: () => TARGET, windowId: () => undefined, webContentsId: 7, url: 'ws://127.0.0.1:19387/x' },
    { why: 'the handshake is from a different webContents', target: () => TARGET, windowId: () => 7, webContentsId: 8, url: 'ws://127.0.0.1:19387/x' },
    { why: 'the port is another local service’s', target: () => TARGET, windowId: () => 7, webContentsId: 7, url: 'ws://127.0.0.1:8080/x' },
  ]
  for (const item of cases) {
    const session = fakeSession()
    installHostStreamAuth(session, item.target, item.windowId)
    const answer = call(session.installed[0].handler, {
      url: item.url,
      webContentsId: item.webContentsId,
      requestHeaders: { origin: APP_ORIGIN },
    })
    assert.deepEqual(answer, {}, item.why)
  }
})

test('the target and the window are read per handshake, so a kernel switch needs no reinstall', () => {
  const session = fakeSession()
  let target
  let windowId = 7
  installHostStreamAuth(session, () => target, () => windowId)
  const { handler } = session.installed[0]
  const details = { url: 'ws://127.0.0.1:19387/x', webContentsId: 7, requestHeaders: { origin: APP_ORIGIN } }
  assert.deepEqual(call(handler, details), {}, 'nothing installed yet')

  target = { origin: 'http://127.0.0.1:19387', cookie: 'dsh=first' }
  assert.equal(call(handler, details).requestHeaders.cookie, 'dsh=first')
  // A kernel update moves the port and the cookie; the same handler follows.
  target = { origin: 'http://127.0.0.1:25000', cookie: 'dsh=second' }
  assert.deepEqual(
    call(handler, { ...details, url: 'ws://127.0.0.1:25000/x' }).requestHeaders.cookie,
    'dsh=second',
  )
  assert.deepEqual(call(handler, details), {}, 'the old port is no longer ours')
})
