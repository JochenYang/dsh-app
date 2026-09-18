// The web transport of the dsh desktop host (host package 0.1.6-alpha.2 and
// later): the authenticated exchange, the forward from the app origin, and the
// boot rows rendered into the index document. Everything here runs against a
// real local HTTP server — the module is Fetch-shaped and never touches the
// child process, so the transport is testable without one.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  authenticateHostWeb,
  forwardHostWebRequest,
  parseHostInjections,
  renderHostIndex,
} = require('../dist/main/host-web.js')

const APP_ORIGIN = 'dsh-app://app'

/** A local HTTP server on an ephemeral loopback port. */
async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => { server.close(resolve) }),
  }
}

/** A session pointing at `origin`, with no boot rows of its own. */
function sessionFor(origin, injections = []) {
  return { origin, cookie: 'dsh=abc123', injections, appOrigin: APP_ORIGIN }
}

const DOCUMENT = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

test('the authentication exchange keeps the cookie pair alone', async () => {
  const seen = []
  const server = await listen((request, response) => {
    seen.push({ method: request.method, url: request.url })
    response.writeHead(303, {
      'set-cookie': 'dsh=abc123; Path=/; HttpOnly; SameSite=Lax',
      location: '/',
    })
    response.end()
  })
  try {
    const auth = await authenticateHostWeb(`${server.origin}/?token=one-shot`)
    assert.deepEqual(auth, { origin: server.origin, cookie: 'dsh=abc123' })
    // The token rides the launch URL only: the request must not follow the
    // redirect, because the token is spent by the exchange itself.
    assert.deepEqual(seen, [{ method: 'GET', url: '/?token=one-shot' }])
  } finally {
    await server.close()
  }
})

test('an exchange that is not a 303 with a cookie is refused', async () => {
  const ok = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('landing page')
  })
  const cookieless = await listen((_request, response) => {
    response.writeHead(303, { location: '/' })
    response.end()
  })
  try {
    await assert.rejects(authenticateHostWeb(`${ok.origin}/?token=x`), /authentication failed \(status 200, cookie missing\)/u)
    await assert.rejects(authenticateHostWeb(`${cookieless.origin}/?token=x`), /authentication failed \(status 303, cookie missing\)/u)
  } finally {
    await ok.close()
    await cookieless.close()
  }
})

test('a forward rewrites the hop-local request headers and the session cookie', async () => {
  const seen = []
  const server = await listen((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '11',
      'content-encoding': 'identity',
      'set-cookie': 'junk=1',
    })
    response.end('{"ok":true}')
  })
  try {
    const request = new Request('http://dsh-app.local/api/plugins/dsh-app/x?q=1', {
      headers: {
        origin: APP_ORIGIN,
        cookie: 'stale=1',
        'sec-fetch-site': 'cross-site',
        accept: 'application/json',
      },
    })
    const response = await forwardHostWebRequest(request, sessionFor(server.origin))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '{"ok":true}')
    // Headers of the hop, not of the payload: undici already decoded the body,
    // so an encoding/length pair would describe bytes that no longer exist.
    for (const name of ['content-encoding', 'content-length', 'set-cookie']) {
      assert.equal(response.headers.get(name), null, `${name} must be dropped`)
    }
    assert.equal(response.headers.get('content-type'), 'application/json')

    assert.equal(seen.length, 1)
    assert.deepEqual({ method: seen[0].method, url: seen[0].url }, { method: 'GET', url: '/api/plugins/dsh-app/x?q=1' })
    // The token in the host URL is never forwarded, and the window's own origin
    // and cookie have no business reaching the child.
    assert.equal(seen[0].headers.cookie, 'dsh=abc123')
    assert.equal(seen[0].headers.origin, undefined)
    assert.equal(seen[0].headers['sec-fetch-site'], undefined)
    assert.equal(seen[0].headers.accept, 'application/json')
  } finally {
    await server.close()
  }
})

test('a streaming request body and a non-2xx answer pass through', async () => {
  const seen = []
  const server = await listen((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, body })
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    })
  })
  try {
    const request = new Request('http://dsh-app.local/api/echo?x=1', {
      method: 'POST',
      headers: { origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: '{"hello":true}',
    })
    const response = await forwardHostWebRequest(request, sessionFor(server.origin))
    assert.equal(response.status, 404)
    assert.equal(await response.text(), 'not found')
    assert.deepEqual(seen, [{ method: 'POST', url: '/api/echo?x=1', body: '{"hello":true}' }])
  } finally {
    await server.close()
  }
})

test('a request named by another origin is refused', async () => {
  let served = false
  const server = await listen((_request, response) => {
    served = true
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('nope')
  })
  try {
    const request = new Request('http://dsh-app.local/index.html', { headers: { origin: 'https://evil.example' } })
    const response = await forwardHostWebRequest(request, sessionFor(server.origin))
    assert.equal(response.status, 403)
    assert.equal(served, false)
  } finally {
    await server.close()
  }
})

test('every row kind renders in its own region', () => {
  const rows = [
    { kind: 'global', name: '__DSH_BOOT__', value: { entries: [], html: '<b>' } },
    { kind: 'script-preload', src: '/plugins/one.js' },
    { kind: 'script', placement: 'head', text: 'window.__HEAD__ = 1' },
    { kind: 'style', text: 'html { color: red }' },
    { kind: 'script-src', placement: 'head', src: '/plugins/a.js?x="1"&y=<2>' },
    { kind: 'script', placement: 'body', text: 'window.__BODY__ = 1' },
    { kind: 'html', placement: 'body', html: '<div id="injected"></div>' },
  ]
  const out = renderHostIndex(DOCUMENT, rows)

  // The boot-ready deferred comes first in the head, then the rows in table
  // order; the client entry awaits it before reading any injected state.
  const boot = out.indexOf('globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()')
  const headEnd = out.indexOf('<title>')
  assert.ok(boot > out.indexOf('<head>') && boot < headEnd, 'the boot deferred leads the head rows')
  const headOrder = [
    'globalThis["__DSH_BOOT__"] = ',
    '<link rel="preload" as="script" href="/plugins/one.js">',
    '<script>window.__HEAD__ = 1</script>',
    '<style>html { color: red }</style>',
    '<script src="/plugins/a.js?x=&quot;1&quot;&amp;y=&lt;2&gt;"></script>',
  ].map((markup) => out.indexOf(markup))
  assert.ok(headOrder.every((at) => at > -1), 'every head row is rendered')
  assert.deepEqual([...headOrder].sort((a, b) => a - b), headOrder, 'head rows keep table order')
  assert.ok(headOrder.at(-1) < headEnd, 'head rows land before the document head content')

  const bodyOrder = [
    '<script>window.__BODY__ = 1</script>',
    '<div id="injected"></div>',
    '(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()',
  ].map((markup) => out.indexOf(markup))
  assert.ok(bodyOrder.every((at) => at > -1), 'every body row and the tail are rendered')
  assert.deepEqual([...bodyOrder].sort((a, b) => a - b), bodyOrder, 'body rows precede the readiness tail')
  assert.ok(bodyOrder[0] > out.indexOf('<body>') && bodyOrder[0] < out.indexOf('<div id="root">'), 'body rows land right after the body tag')

  // `<` is escaped inside the JSON so a row value cannot close the script
  // element early, and the raw value never appears in the document.
  assert.match(out, /globalThis\["__DSH_BOOT__"\] = \{"entries":\[\],"html":"\\u003cb>"\}/u)
  assert.ok(!out.includes('<b>'), 'a row value never reaches the document as markup')
})

test('a document with no head or body still receives the rows', () => {
  const out = renderHostIndex('<main>x</main>', [
    { kind: 'global', name: 'A', value: 1 },
    { kind: 'script', placement: 'body', text: 'window.__B__ = 1' },
  ])
  assert.ok(out.startsWith('<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'))
  assert.ok(out.indexOf('<main>x</main>') < out.indexOf('<script>window.__B__ = 1</script>'))
  assert.ok(out.endsWith('<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'))
})

test('a global row with an undefined value renders as undefined', () => {
  const out = renderHostIndex('<head></head>', [{ kind: 'global', name: 'X', value: undefined }])
  assert.ok(out.includes('<script>globalThis["X"] = undefined</script>'))
})

test('a row this shell cannot render fails loudly', () => {
  assert.throws(() => renderHostIndex('<head></head>', [{ kind: 'iframe', src: '/x' }]), /unknown index injection row kind "iframe"/u)
  assert.throws(() => renderHostIndex('<head></head>', [{ kind: 'script', placement: 'head' }]), /has no text/u)
  assert.throws(() => renderHostIndex('<head></head>', [{ kind: 'html', placement: 'footer', html: 'x' }]), /no head\/body placement/u)
  assert.throws(() => renderHostIndex('<head></head>', [null]), /unknown index injection row kind null/u)
})

test('the ready message needs a table, and its rows need a kind', () => {
  const rows = parseHostInjections([{ kind: 'global', name: 'A', value: 1 }])
  assert.equal(rows.length, 1)
  assert.throws(() => parseHostInjections(undefined), /without an index injection table/u)
  assert.throws(() => parseHostInjections({ kind: 'global' }), /without an index injection table/u)
  assert.throws(() => parseHostInjections([{ name: 'A' }]), /row 0 is not a row/u)
})

test('the index document is rewritten, and only where it should be', async () => {
  const rendered = { kind: 'global', name: '__DSH_BOOT__', value: { entries: [{ id: 'core' }] } }
  const PRE_INJECTED = '<html><head><script>globalThis["__DSH_BOOT__"] = {}</script></head><body>done</body></html>'
  const server = await listen((request, response) => {
    const path = new URL(request.url, 'http://x').pathname
    // The two paths an index may answer on, one per branch: `/` arrives without
    // the rendered table (this shell renders it), `/index.html` arrives with it
    // (the child's own frontend route renders it), which is the line's real
    // shape — the child renders the table, upstream sets the transport global
    // from its preload, and this shell has no preload.
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(DOCUMENT)
      return
    }
    if (path === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PRE_INJECTED)
      return
    }
    if (path === '/pre-injected') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(PRE_INJECTED)
      return
    }
    if (path === '/missing.html') {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<h1>not found</h1>')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  const session = sessionFor(server.origin, [rendered])
  try {
    const index = await forwardHostWebRequest(new Request('http://dsh-app.local/'), session)
    assert.equal(index.status, 200)
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
    const html = await index.text()
    assert.ok(html.includes('globalThis["__DSH_BOOT__"] = {"entries":[{"id":"core"}]}'), 'the row reaches the document')
    assert.ok(html.includes('__DSH_BOOT_READY__ = Promise.withResolvers()'), 'the client gate is created before the rows')
    assert.ok(
      html.includes(`globalThis.__DSH_TRANSPORT__ = {"ownsHost":true,"streamBaseUrl":"${server.origin}"}`),
      'the stream row names the host origin',
    )

    // The child renders this very table into its own index answers. Rendering
    // it again would run every script row twice, so a document that already
    // carries the boot row is passed through — with THIS shell's own row added,
    // which the child never contributes.
    const pre = await forwardHostWebRequest(new Request('http://dsh-app.local/index.html'), session)
    const preHtml = await pre.text()
    assert.ok(preHtml.startsWith('<html><head><script>globalThis.__DSH_TRANSPORT__'), 'the stream row goes in at the head')
    assert.ok(preHtml.includes('<script>globalThis["__DSH_BOOT__"] = {}</script>'), 'the boot row is the child’s only')
    assert.equal(preHtml.match(/__DSH_BOOT__/gu)?.length, 1, 'the table is not rendered twice')

    // A document that is not an index this shell serves, or is not a success,
    // is not this shell's to rewrite.
    const other = await forwardHostWebRequest(new Request('http://dsh-app.local/pre-injected'), session)
    assert.equal(await other.text(), PRE_INJECTED)
    const missing = await forwardHostWebRequest(new Request('http://dsh-app.local/missing.html'), session)
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), '<h1>not found</h1>')
    const json = await forwardHostWebRequest(new Request('http://dsh-app.local/api/state'), session)
    assert.equal(await json.text(), '{"ok":true}')

    // A HEAD answer carries no body, so there is nothing to render into.
    const head = await forwardHostWebRequest(new Request('http://dsh-app.local/index.html', { method: 'HEAD' }), session)
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  } finally {
    await server.close()
  }
})
