// Desktop bridge fences and actions. This is a local listening socket guarding
// native capabilities, so the tests are weighted towards the fences: every one of
// them is the only thing between a random local process (or a page that finds
// the port) and "open a folder" / "write a file".
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { isLoopbackHost, startDesktopBridge } = require('../dist/main/desktop-bridge.js')

/** Start a bridge for one test and close it afterwards. */
async function withBridge(t, handlers) {
  const bridge = await startDesktopBridge(handlers)
  assert.ok(bridge, 'the bridge must bind a loopback port')
  t.after(() => bridge.close())
  return bridge
}

/** One authenticated-looking request, with every knob the fences check. */
async function call(bridge, action, body, options = {}) {
  const token = options.token === undefined ? bridge.token : options.token
  const headers = { 'content-type': 'application/json', ...options.headers }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${bridge.url}/bridge/${action}`, {
    method: options.method ?? 'POST',
    headers,
    body: (options.method ?? 'POST') === 'POST' ? (options.raw ?? JSON.stringify(body ?? {})) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json }
}

test('isLoopbackHost accepts every loopback form and nothing else', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:51234', 'localhost', 'localhost:8080', '[::1]', '[::1]:9000']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of [undefined, '', 'evil.example', '127.0.0.1.evil.example', '0.0.0.0:80', '[::1', 'localhost.evil.example']) {
    assert.equal(isLoopbackHost(host), false, String(host))
  }
})

test('every action reaches its handler and answers ok', async (t) => {
  const seen = []
  const bridge = await withBridge(t, {
    openInFolder: async (target) => { seen.push(['folder', target]) },
    notify: async (title, body) => { seen.push(['notify', title, body]) },
    saveTextAs: async (name, content) => { seen.push(['save', name, content]); return '/tmp/out.txt' },
    pickDirectory: async () => '/tmp/picked',
    openLogs: async () => { seen.push(['logs']) },
  })

  assert.deepEqual(await call(bridge, 'open-in-folder', { path: 'C:/logs' }), { status: 200, json: { ok: true } })
  assert.deepEqual(await call(bridge, 'notify', { title: '标题', body: '内容' }), { status: 200, json: { ok: true } })
  assert.deepEqual(await call(bridge, 'save-text-as', { name: 'a.txt', content: 'hi' }), { status: 200, json: { ok: true, path: '/tmp/out.txt' } })
  assert.deepEqual(await call(bridge, 'pick-directory'), { status: 200, json: { ok: true, path: '/tmp/picked' } })
  assert.deepEqual(await call(bridge, 'open-logs'), { status: 200, json: { ok: true } })

  assert.deepEqual(seen, [
    ['folder', 'C:/logs'],
    ['notify', '标题', '内容'],
    ['save', 'a.txt', 'hi'],
    ['logs'],
  ])
})

test('a cancelled dialog is a successful call with no path', async (t) => {
  const bridge = await withBridge(t, { saveTextAs: async () => null, pickDirectory: async () => null })
  assert.deepEqual(await call(bridge, 'save-text-as', { name: 'a.txt', content: 'x' }), { status: 200, json: { ok: true, path: null } })
  assert.deepEqual(await call(bridge, 'pick-directory'), { status: 200, json: { ok: true, path: null } })
})

test('a handler the shell does not provide reports unavailable, not a crash', async (t) => {
  const bridge = await withBridge(t, {})
  const result = await call(bridge, 'open-in-folder', { path: '/tmp' })
  assert.equal(result.status, 501)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /不支持/u)
})

test('a failing action surfaces its own message and a 500', async (t) => {
  const bridge = await withBridge(t, { openInFolder: async () => { throw new Error('无法打开该目录') } })
  const result = await call(bridge, 'open-in-folder', { path: '/tmp' })
  assert.equal(result.status, 500)
  assert.equal(result.json.error, '无法打开该目录')
})

test('invalid input is a 400, not an action failure', async (t) => {
  const bridge = await withBridge(t, { openInFolder: async () => {} })
  assert.equal((await call(bridge, 'open-in-folder', {})).status, 400)
  assert.equal((await call(bridge, 'open-in-folder', { path: 42 })).status, 400)
  assert.equal((await call(bridge, 'open-in-folder', { path: 'x'.repeat(5_000) })).status, 400)
})

test('an unknown action is refused', async (t) => {
  const bridge = await withBridge(t, { openLogs: async () => {} })
  assert.equal((await call(bridge, 'elevate-me')).status, 500)
})

// --- fences ---------------------------------------------------------------

test('a request without the bearer token is refused', async (t) => {
  const bridge = await withBridge(t, { openLogs: async () => {} })
  assert.equal((await call(bridge, 'open-logs', {}, { token: null })).status, 401)
  assert.equal((await call(bridge, 'open-logs', {}, { token: 'wrong' })).status, 401)
  // A token of a different length must not crash the constant-time compare.
  assert.equal((await call(bridge, 'open-logs', {}, { token: '' })).status, 401)
})

test('a browser-shaped request is refused even with a valid token', async (t) => {
  const bridge = await withBridge(t, { openLogs: async () => {} })
  // Origin is the tell: the kernel child never sends one, a page always does.
  const result = await call(bridge, 'open-logs', {}, { headers: { origin: 'http://127.0.0.1:8672' } })
  assert.equal(result.status, 403)
})

/**
 * Send a hand-built request over a raw socket. `fetch` refuses to set `Host`
 * (it is a forbidden header name), so the Host fence can only be exercised by
 * writing the request bytes ourselves.
 */
function rawStatus(bridge, requestLines) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(bridge.url)
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`${requestLines.join('\r\n')}\r\n\r\n`)
    })
    let response = ''
    socket.on('data', (chunk) => { response += chunk.toString('utf8') })
    socket.on('end', () => resolve(Number(response.split(' ')[1])))
    socket.on('error', reject)
  })
}

test('a non-loopback Host is refused even with a valid token', async (t) => {
  const bridge = await withBridge(t, { openLogs: async () => {} })
  // The Host fence is the DNS-rebinding guard: a page resolving evil.example to
  // 127.0.0.1 still reaches us, but it cannot forge the Host the kernel sends.
  const status = await rawStatus(bridge, [
    'POST /bridge/open-logs HTTP/1.1',
    'Host: evil.example',
    `Authorization: Bearer ${bridge.token}`,
    'Content-Type: application/json',
    'Content-Length: 0',
    'Connection: close',
  ])
  assert.equal(status, 403)
})

test('the bridge answers POST only', async (t) => {
  const bridge = await withBridge(t, { openLogs: async () => {} })
  assert.equal((await call(bridge, 'open-logs', {}, { method: 'GET' })).status, 405)
})

test('an oversized body is refused instead of buffered', async (t) => {
  const bridge = await withBridge(t, { saveTextAs: async () => null })
  const result = await call(bridge, 'save-text-as', {}, { raw: JSON.stringify({ name: 'a', content: 'x'.repeat(9 * 1024 * 1024) }) })
  assert.equal(result.status, 413)
})

test('close is idempotent and releases the port', async (t) => {
  const bridge = await startDesktopBridge({ openLogs: async () => {} })
  assert.ok(bridge)
  await bridge.close()
  await bridge.close()
  await assert.rejects(fetch(`${bridge.url}/bridge/open-logs`, { method: 'POST' }))
})
