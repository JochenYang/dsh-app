// The proxy the shell injects into the kernel child must actually BE a proxy:
// a listener that only accepts TCP connections (a dev server, a stray daemon)
// is refused, so a squatting process cannot receive the kernel's outbound
// traffic. The explicit-proxy-wins and env-shaping rules are pinned here too.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { detectLocalProxy, withDetectedProxy, hasProxyEnv } = require('../dist/main/proxy-detect.js')

/** A listener on 127.0.0.1 that answers like an HTTP proxy would. */
async function startFakeProxy() {
  const server = http.createServer()
  // A CONNECT is the probe's question; without this handler node's server
  // destroys the socket instead of answering, which would look like a
  // non-proxy. A real proxy answers 200 (tunnel established) or 4xx/5xx.
  server.on('connect', (req, clientSocket) => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    clientSocket.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** A listener that accepts connections and then says nothing HTTP at all. */
async function startRawListener() {
  const sockets = []
  const server = net.createServer((socket) => sockets.push(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

test('a listener that answers as a proxy is detected', async () => {
  const fake = await startFakeProxy()
  const previous = process.env.DSH_APP_PROXY_PORTS
  process.env.DSH_APP_PROXY_PORTS = String(fake.port)
  try {
    const found = await detectLocalProxy()
    assert.equal(found, `http://127.0.0.1:${String(fake.port)}`)
  } finally {
    if (previous === undefined) delete process.env.DSH_APP_PROXY_PORTS
    else process.env.DSH_APP_PROXY_PORTS = previous
    await fake.close()
  }
})

test('a listener that only accepts TCP is not adopted as a proxy', async () => {
  const raw = await startRawListener()
  const previous = process.env.DSH_APP_PROXY_PORTS
  process.env.DSH_APP_PROXY_PORTS = String(raw.port)
  try {
    // The bare connect succeeds, so without the HTTP probe this is exactly the
    // value that would have been injected into the kernel's environment.
    assert.equal(await detectLocalProxy(), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_APP_PROXY_PORTS
    else process.env.DSH_APP_PROXY_PORTS = previous
    await raw.close()
  }
})

test('a plain HTTP service answering CONNECT is accepted — the documented boundary', async () => {
  // Deliberate: the probe proves "speaks HTTP", not "is a proxy" (telling the
  // two apart needs a full tunnel round-trip). This pins the boundary so a
  // future tightening of the probe is a conscious change, and documents that
  // the previous behaviour (a bare connect) was strictly weaker.
  const server = http.createServer()
  server.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n')
    socket.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const previous = process.env.DSH_APP_PROXY_PORTS
  process.env.DSH_APP_PROXY_PORTS = String(port)
  try {
    assert.equal(await detectLocalProxy(), `http://127.0.0.1:${String(port)}`)
  } finally {
    if (previous === undefined) delete process.env.DSH_APP_PROXY_PORTS
    else process.env.DSH_APP_PROXY_PORTS = previous
    await new Promise((resolve) => server.close(resolve))
  }
})

test('withDetectedProxy: an explicit proxy in the environment wins, and loopback stays direct', () => {
  const base = { HTTPS_PROXY: 'http://10.0.0.9:3128', HOME: '/home/u' }
  const out = withDetectedProxy(base, 'http://127.0.0.1:7897')
  assert.equal(out.injected, false)
  assert.equal(out.env.HTTPS_PROXY, 'http://10.0.0.9:3128')
  // No proxy at all and nothing detected: the environment is untouched.
  const none = withDetectedProxy(base, undefined)
  assert.equal(none.injected, false)
  assert.equal(none.env, base)
  // An injected proxy never covers loopback, and keeps the user's own entries.
  const injected = withDetectedProxy({ HOME: '/home/u', NO_PROXY: '10.1.2.3' }, 'http://127.0.0.1:7897')
  assert.equal(injected.injected, true)
  assert.equal(injected.env.HTTPS_PROXY, 'http://127.0.0.1:7897')
  assert.equal(injected.env.ALL_PROXY, 'http://127.0.0.1:7897')
  const noProxy = injected.env.NO_PROXY.split(',')
  assert.ok(noProxy.includes('127.0.0.1'))
  assert.ok(noProxy.includes('localhost'))
  assert.ok(noProxy.includes('10.1.2.3'))
  assert.equal(hasProxyEnv(injected.env), true)
  assert.equal(hasProxyEnv({ HOME: '/home/u' }), false)
  // A whitespace-only value is "not set" in both predicates: otherwise the
  // shell would skip injecting a detected proxy AND skip the proxy bootstrap.
  assert.equal(hasProxyEnv({ HTTPS_PROXY: '   ' }), false)
  assert.equal(withDetectedProxy({ HTTPS_PROXY: '   ' }, 'http://127.0.0.1:7897').injected, true)
})