// Server-side guards that only a real exchange can exercise:
//   - redact(): a credential fragment must never reach a log file, an event or
//     the diagnostics the shell shows the user.
//   - probeServerHealth(): the 303 + Set-Cookie dance. A healthy server whose
//     token exchange is mishandled looks unhealthy, and the shell then rolls a
//     perfectly good kernel back — so this is the misjudgment that matters.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { probeServerHealth, redact } = require('../dist/main/server.js')

const MAX_LOG_LINE = 2000

test('redact keeps the key name and drops the value in every shape we see', () => {
  // JSON pairs (the shape dsh prints in its own diagnostics).
  assert.equal(redact('{"apiKey": "sk-1234567890"}'), '{"apiKey": "[redacted]"}')
  assert.equal(redact("{'authorization': 'Bearer abc.def'}"), "{'authorization': '[redacted]'}")
  // Query strings: the bare rule below would otherwise swallow the whole URL.
  assert.equal(redact('GET /?token=abc123&next=/x'), 'GET /?token=[redacted]&next=/x')
  // Bare key=value and key: value.
  assert.equal(redact('api_key=secret-value rest'), 'api_key=[redacted] rest')
  assert.equal(redact('password: hunter2'), 'password: [redacted]')
  // Case-insensitive, and the credential name itself survives for debugging.
  assert.match(redact('TOKEN=abc'), /^TOKEN=\[redacted\]$/u)
})

test('redact leaves ordinary output alone', () => {
  const line = 'dsh web: http://127.0.0.1:8672/?token=…' // already elided by the caller
  assert.equal(redact('kernel activated dsh-0.1.5-rc.2+suite-98b0d32e'), 'kernel activated dsh-0.1.5-rc.2+suite-98b0d32e')
  assert.equal(redact(''), '')
  assert.ok(redact('a normal log line about tokens being loaded').includes('tokens being loaded'))
  assert.notEqual(redact(line), undefined)
})

test('redact caps a single line', () => {
  const capped = redact('x'.repeat(MAX_LOG_LINE * 2))
  assert.equal(capped.length, MAX_LOG_LINE)
})

/** Start a loopback server for one test, with the given request handler. */
async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('probeServerHealth exchanges the token for a cookie and follows it', async () => {
  const seen = []
  const ok = await withServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh_auth=abc123; Path=/; HttpOnly' })
      res.end()
      return
    }
    // The session root only answers 200 WITH the cookie — exactly what the
    // naive `redirect: 'follow'` probe would miss.
    if (req.headers.cookie === 'dsh_auth=abc123') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    res.writeHead(401)
    res.end('unauthorized')
  }, (url) => probeServerHealth(`${url}/?token=xyz`))

  assert.equal(ok, true)
  assert.equal(seen.length, 2)
  assert.equal(seen[1].url, '/')
  assert.equal(seen[1].cookie, 'dsh_auth=abc123', 'the cookie is sent without its attributes')
})

test('probeServerHealth stays false when the session root rejects the request', async () => {
  const ok = await withServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh_auth=abc123; Path=/' })
      res.end()
      return
    }
    res.writeHead(401)
    res.end()
  }, (url) => probeServerHealth(`${url}/?token=xyz`))
  assert.equal(ok, false)
})

test('probeServerHealth refuses a redirect without a cookie or off-origin', async () => {
  const noCookie = await withServer((req, res) => {
    res.writeHead(303, { location: '/' })
    res.end()
  }, (url) => probeServerHealth(`${url}/?token=xyz`))
  assert.equal(noCookie, false)

  const offOrigin = await withServer((req, res) => {
    res.writeHead(303, { location: 'http://example.com/', 'set-cookie': 'dsh_auth=abc' })
    res.end()
  }, (url) => probeServerHealth(`${url}/?token=xyz`))
  assert.equal(offOrigin, false, 'a health probe must never follow a redirect off loopback')
})

test('probeServerHealth accepts an already-authenticated root', async () => {
  const ok = await withServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  }, (url) => probeServerHealth(`${url}/`))
  assert.equal(ok, true)
})

test('probeServerHealth reports false instead of throwing when nothing listens', async () => {
  // A port that was just closed: the fetch must fail inside the probe, not
  // propagate into the boot path as an exception.
  const port = await withServer((req, res) => {
    res.writeHead(200)
    res.end()
  }, (url) => new URL(url).port)
  assert.equal(await probeServerHealth(`http://127.0.0.1:${port}/?token=xyz`), false)
})
