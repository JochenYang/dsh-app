/**
 * The fetch provider's contract: the host's policy (URL rules, redirects,
 * caps, classification, error codes) plus the resolution layer's two
 * behaviors that matter — a poisoned resolver routes through DoH, a clean
 * one stays on the system path.
 *
 * The transport is a local `node:http` server reached through an injected
 * `send` seam, so every assertion is about the provider's own loop; the DNS
 * seams are fakes, so no probe leaves the machine either.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import { createWebFetchProvider, type FetchProviderDeps } from '../src/fetch/provider.ts'
import { MAX_BODY_CHARS, MAX_RESPONSE_BYTES } from '../src/fetch/network.ts'
import { proxyEnvActive, proxyRouteFor, type FetchHop, type HopSend } from '../src/fetch/transport.ts'

let server: Server
let port = 0

/** The hostname the provider sees; the send seam maps it to the local server. */
const TEST_HOST = 'fetch.invalid'
const CLEAN_IP = '93.184.216.34'
const POISONED_IP = '198.18.0.174'

before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('hello')
      return
    }
    if (path === '/html') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>t</title>')
      return
    }
    if (path === '/redirect-same') {
      response.writeHead(302, { location: '/text' })
      response.end()
      return
    }
    if (path === '/redirect-cross') {
      response.writeHead(302, { location: 'http://other.invalid/text' })
      response.end()
      return
    }
    if (path === '/redirect-no-location') {
      response.writeHead(302)
      response.end()
      return
    }
    if (path === '/redirect-loop') {
      response.writeHead(302, { location: '/redirect-loop' })
      response.end()
      return
    }
    if (path === '/binary') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('\x00\x01')
      return
    }
    if (path === '/charset') {
      // 0xC4E3 0xBA C3 = 你好 in GBK.
      response.writeHead(200, { 'content-type': 'text/plain; charset=gbk' })
      response.end(Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]))
      return
    }
    if (path === '/declared-too-large') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(MAX_RESPONSE_BYTES + 1) })
      response.end('x')
      return
    }
    if (path === '/stream-too-large') {
      // Chunked with no content-length: the body grows past the cap and must
      // be cut short rather than rejected.
      response.writeHead(200, { 'content-type': 'text/plain' })
      const chunk = 'a'.repeat(1024)
      for (let written = 0; written < MAX_RESPONSE_BYTES; written += chunk.length) response.write(chunk)
      response.end('b'.repeat(2048))
      return
    }
    if (path === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('late')
      }, 5_000)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

/** Wrap a global-`fetch` response as one hop (the production proxy shape). */
async function hopFromFetch(url: URL, signal?: AbortSignal): Promise<FetchHop> {
  const response = await fetch(url, { redirect: 'manual', ...signal !== undefined ? { signal } : {} })
  return {
    statusCode: response.status,
    header: (name: string) => response.headers.get(name),
    body: async function* () {
      const reader = response.body?.getReader()
      if (reader === undefined) return
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) return
        if (value !== undefined) yield value
      }
    },
    close: async () => {
      await response.body?.cancel().catch(() => undefined)
    },
  }
}

/** The injected send: maps TEST_HOST onto the local server, records addresses. */
function localSend(seen: { readonly addresses: readonly string[] }[]): HopSend {
  return async (url, addresses, _headers, signal) => {
    seen.push({ addresses })
    const target = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${String(port)}`)
    return await hopFromFetch(target, signal)
  }
}

/** A clean system resolver: every canary probe answers public. */
function cleanLookup(calls: string[]) {
  return async (hostname: string): Promise<readonly string[]> => {
    calls.push(hostname)
    return [CLEAN_IP]
  }
}

/** A poisoned system resolver: the canary probe answers fake-IP. */
function poisonedLookup(calls: string[]) {
  return async (hostname: string): Promise<readonly string[]> => {
    calls.push(hostname)
    return [POISONED_IP]
  }
}

/** A DoH seam that answers every query with one public address. */
function dohOk(calls: string[]) {
  return async (url: string): Promise<unknown> => {
    calls.push(url)
    return { Status: 0, Answer: [{ name: TEST_HOST, type: 1, TTL: 120, data: CLEAN_IP }] }
  }
}

/** Extract the WebError code from a rejection. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof WebError ? error.code : `not-a-weberror:${String(error)}`
  }
}

function make(deps: FetchProviderDeps = {}) {
  return createWebFetchProvider({ env: {}, ...deps })
}

describe('provider — clean network path', () => {
  it('fetches text and classifies the body', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const result = await provider.fetch({ url: `http://${TEST_HOST}/text` })
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.kind, 'text')
    assert.equal(result.body.content, 'hello')
    assert.equal(result.truncated, false)
  })

  it('classifies html', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const result = await provider.fetch({ url: `http://${TEST_HOST}/html` })
    assert.equal(result.body.kind, 'html')
  })

  it('resolves through the system resolver when the canary is clean', async () => {
    const calls: string[] = []
    const seen: { readonly addresses: readonly string[] }[] = []
    const provider = make({ send: localSend(seen), systemLookup: cleanLookup(calls) })
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    // One canary probe ('example.com') plus one resolution of the fetch host.
    assert.deepEqual(calls, ['example.com', TEST_HOST])
    assert.deepEqual(seen[0].addresses, [CLEAN_IP])
    const status = await provider.status()
    assert.equal(status.route, 'direct')
    assert.equal(status.resolver, 'system')
    assert.equal(status.verdict, 'clean')
  })

  it('keeps the canary verdict for the TTL window', async () => {
    let now = 0
    const calls: string[] = []
    const provider = make({ send: localSend([]), systemLookup: cleanLookup(calls), clock: () => now })
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    // The canary ran once; the second fetch used the cached verdict.
    assert.equal(calls.filter(host => host === 'example.com').length, 1)
    now += 11 * 60_000
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    assert.equal(calls.filter(host => host === 'example.com').length, 2)
  })
})

describe('provider — poisoned network path', () => {
  it('bypasses the poisoned resolver with DoH', async () => {
    const lookups: string[] = []
    const dohCalls: string[] = []
    const seen: { readonly addresses: readonly string[] }[] = []
    const provider = make({
      send: localSend(seen),
      systemLookup: poisonedLookup(lookups),
      dohSend: dohOk(dohCalls),
    })
    const result = await provider.fetch({ url: `http://${TEST_HOST}/text` })
    assert.equal(result.statusCode, 200)
    // The canary saw the poison; the fetch host went through DoH...
    assert.deepEqual(lookups, ['example.com'])
    assert.equal(dohCalls.length > 0, true)
    assert.match(dohCalls[0], /name=fetch\.invalid/)
    // ...and the pinned connection used the DoH answer, not the fake IP.
    assert.deepEqual(seen[0].addresses, [CLEAN_IP])
    const status = await provider.status()
    assert.equal(status.resolver, 'doh')
    assert.equal(status.verdict, 'poisoned')
  })

  it('fails with a coded error when the DoH plane is dead', async () => {
    // Never silently falls back to the poisoned resolver: that would
    // reproduce the original WEB_BLOCKED_URL the whole layer exists to fix.
    const provider = make({
      send: localSend([]),
      systemLookup: poisonedLookup([]),
      dohSend: async () => { throw new Error('connect ETIMEDOUT') },
    })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/text` }))
    assert.equal(code, 'WEB_PROVIDER_ERROR')
  })

  it('asks the system resolver once when DoH answers NODATA', async () => {
    const lookups: string[] = []
    const provider = make({
      send: localSend([]),
      systemLookup: poisonedLookup(lookups),
      dohSend: async () => ({ Status: 0, Answer: [] }),
    })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/text` }))
    // Canary + one honest lookup of the nonexistent host; the host then
    // fails on the same guard the host provider would have failed on.
    assert.deepEqual(lookups, ['example.com', TEST_HOST])
    assert.equal(code, 'WEB_BLOCKED_URL')
  })
})

describe('provider — proxy route', () => {
  it('does no local resolution when a proxy route applies', async () => {
    const lookups: string[] = []
    const dohCalls: string[] = []
    const provider = make({
      send: localSend([]),
      systemLookup: cleanLookup(lookups),
      dohSend: dohOk(dohCalls),
      env: { ALL_PROXY: 'http://127.0.0.1:7897' },
    })
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    // The proxy resolves the origin; neither the canary nor DoH nor the
    // system resolver was consulted.
    assert.deepEqual(lookups, [])
    assert.deepEqual(dohCalls, [])
    assert.equal((await provider.status()).route, 'proxy')
  })

  it('honors NO_PROXY exemptions', async () => {
    const lookups: string[] = []
    const provider = make({
      send: localSend([]),
      systemLookup: cleanLookup(lookups),
      env: { ALL_PROXY: 'http://127.0.0.1:7897', NO_PROXY: TEST_HOST },
    })
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    // The exempted host was resolved and connected directly: both the
    // canary probe and the host lookup happened, which the proxied path
    // would have skipped.
    assert.deepEqual(lookups, ['example.com', TEST_HOST])
  })
})

describe('provider — redirects', () => {
  it('follows a same-origin redirect', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const result = await provider.fetch({ url: `http://${TEST_HOST}/redirect-same` })
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.content, 'hello')
    assert.equal(result.url, `http://${TEST_HOST}/text`)
  })

  it('refuses a cross-origin redirect', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/redirect-cross` }))
    assert.equal(code, 'WEB_REDIRECT_BLOCKED')
  })

  it('stops at the redirect cap', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/redirect-loop` }))
    assert.equal(code, 'WEB_REDIRECT_BLOCKED')
  })

  it('refuses a redirect without a Location header', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/redirect-no-location` }))
    assert.equal(code, 'WEB_PROVIDER_ERROR')
  })
})

describe('provider — body policy', () => {
  it('refuses an undeclared binary type', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/binary` }))
    assert.equal(code, 'WEB_UNSUPPORTED_CONTENT_TYPE')
  })

  it('refuses a response whose declared length is over the cap', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/declared-too-large` }))
    assert.equal(code, 'WEB_FETCH_TOO_LARGE')
  })

  it('cuts short a stream that grows past the cap', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const result = await provider.fetch({ url: `http://${TEST_HOST}/stream-too-large` })
    assert.equal(result.truncated, true)
    assert.equal(result.body.content.length, MAX_BODY_CHARS)
  })

  it('decodes with the declared charset', async () => {
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    const result = await provider.fetch({ url: `http://${TEST_HOST}/charset` })
    assert.equal(result.body.content, '你好')
  })
})

describe('provider — URL policy', () => {
  it('refuses a non-HTTP scheme', async () => {
    const provider = make()
    assert.equal(await codeOf(provider.fetch({ url: 'file:///etc/passwd' })), 'WEB_INVALID_URL')
  })

  it('refuses embedded credentials', async () => {
    const provider = make()
    assert.equal(await codeOf(provider.fetch({ url: `http://user:pass@${TEST_HOST}/text` })), 'WEB_BLOCKED_URL')
  })

  it('refuses a non-public IP literal, proxied or not', async () => {
    const proxied = make({ env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } })
    assert.equal(await codeOf(proxied.fetch({ url: 'http://127.0.0.1/text' })), 'WEB_BLOCKED_URL')
    assert.equal(await codeOf(proxied.fetch({ url: 'http://10.0.0.5/text' })), 'WEB_BLOCKED_URL')
  })

  it('refuses every loopback spelling, including the mapped and transition forms', async () => {
    // Regression: the WHATWG URL parser rewrites a bracketed `::ffff:127.0.0.1`
    // to `[::ffff:7f00:1]`, so a checker that only recognised the dotted
    // spelling let these connect to a service bound to loopback. Each case
    // here names this machine (or wraps it in a transition prefix) and must be
    // refused on the literal path, BEFORE any socket exists.
    const provider = make({ systemLookup: cleanLookup([]) })
    for (const host of [
      '127.0.0.1',
      '127.0.0.2',                                   // the rest of 127.0.0.0/8
      '[::1]',
      '[::ffff:127.0.0.1]',                          // mapped, dotted
      '[::ffff:7f00:1]',                             // mapped, hex — same address
      '[0:0:0:0:0:ffff:7f00:1]',                     // mapped, fully expanded
      '[::ffff:a00:1]',                              // mapped 10.0.0.1
      '[2002:7f00:1::1]',                            // 6to4 wrapping loopback
      '[64:ff9b::7f00:1]',                           // NAT64 wrapping loopback
    ]) {
      const code = await codeOf(provider.fetch({ url: `http://${host}/text` }))
      assert.equal(code, 'WEB_BLOCKED_URL', host)
    }
  })

  it('refuses a loopback destination sent through a proxy too', async () => {
    // A proxy resolves the address in its own network, so handing it loopback
    // would reach a service the policy exists to keep out of reach.
    const proxied = make({ env: { ALL_PROXY: 'http://127.0.0.1:7897' } })
    for (const host of ['127.0.0.1', '[::1]', '[::ffff:7f00:1]']) {
      const code = await codeOf(proxied.fetch({ url: `http://${host}/text` }))
      assert.equal(code, 'WEB_BLOCKED_URL', host)
    }
  })

  it('treats a rejected proxy slot as direct for THAT scheme', async () => {
    // The kernel's resolver keeps a scheme direct when its own slot is
    // rejected (a SOCKS or malformed URL), rather than adopting a different
    // scheme's value behind the user's back. An http:// fetch therefore goes
    // direct even though ALL_PROXY is set and usable.
    const calls: string[] = []
    const provider = make({
      send: localSend([]),
      systemLookup: cleanLookup(calls),
      env: { HTTP_PROXY: 'socks5://127.0.0.1:1080', ALL_PROXY: 'http://127.0.0.1:7897' },
    })
    await provider.fetch({ url: `http://${TEST_HOST}/text` })
    assert.deepEqual(calls, ['example.com', TEST_HOST])
  })

  it('falls back to the http proxy for an https fetch, as undici does', async () => {
    // No HTTPS_PROXY and no ALL_PROXY: https inherits the http slot. The
    // fetch is an http:// one to the local harness, so assert the RESOLVED
    // policy directly rather than through a route.
    const provider = make({ env: { HTTP_PROXY: 'http://127.0.0.1:7897' } })
    assert.equal(proxyEnvActive(provider.env), true)
    assert.equal(proxyRouteFor(new URL('https://example.com/'), provider.env), 'proxy')
    assert.equal(proxyRouteFor(new URL('http://example.com/'), provider.env), 'proxy')
  })

  it('never hands a loopback destination to a proxy', async () => {
    // By name and by address: a proxy resolves in its own network, so a
    // proxy on this machine would reach a service that only listens on
    // loopback — how the harness's own UI becomes a routing loop.
    const proxied = make({ env: { ALL_PROXY: 'http://127.0.0.1:7897' } })
    for (const url of ['http://localhost:8080/x', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://[::ffff:7f00:1]/x']) {
      assert.equal(proxyRouteFor(new URL(url), proxied.env), 'direct', url)
    }
    // A normal public host under the same policy IS proxied.
    assert.equal(proxyRouteFor(new URL('https://example.com/'), proxied.env), 'proxy')
  })

  it('reports an aborted caller signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = make({ send: localSend([]), systemLookup: cleanLookup([]) })
    assert.equal(await codeOf(provider.fetch({ url: `http://${TEST_HOST}/text` }, controller.signal)), 'WEB_ABORTED')
  })

  it('propagates a caller abort mid-flight', async () => {
    const provider = make({
      send: localSend([]),
      systemLookup: cleanLookup([]),
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const code = await codeOf(provider.fetch({ url: `http://${TEST_HOST}/slow` }, controller.signal))
    assert.equal(code, 'WEB_ABORTED')
  })
})

describe('provider — status before any fetch', () => {
  it('answers unknown until the first fetch decides', async () => {
    const provider = make()
    const status = await provider.status()
    assert.equal(status.route, 'direct')
    assert.equal(status.resolver, 'unknown')
    assert.equal(status.verdict, 'unknown')
    assert.equal(status.checkedAt, null)
  })

  it('recheck forces a fresh verdict', async () => {
    const calls: string[] = []
    const provider = make({ systemLookup: poisonedLookup(calls) })
    const outcome = await provider.recheck()
    assert.equal(outcome.action, 'arm')
    assert.equal(calls.length, 1)
    await provider.recheck()
    assert.equal(calls.length, 2)
  })

  it('reports the verdict even while a proxy is configured', async () => {
    // The proxy path does not consult the canary, but a user about to drop
    // the proxy needs the last known answer rather than a blank line.
    const calls: string[] = []
    const provider = make({
      systemLookup: poisonedLookup(calls),
      env: { ALL_PROXY: 'http://127.0.0.1:7897' },
    })
    const status = await provider.status({ refresh: true })
    assert.equal(status.route, 'proxy')
    assert.equal(status.verdict, 'poisoned')
    assert.equal(status.resolver, 'doh')
    assert.equal(calls.length, 1)
  })

  it('refreshes on demand so the self-check reports the current network', async () => {
    const calls: string[] = []
    let clock = 0
    const provider = make({ systemLookup: poisonedLookup(calls), clock: () => clock })
    await provider.status({ refresh: true })
    await provider.status({ refresh: true })
    // Each refresh is one canary pass, regardless of the TTL window.
    assert.equal(calls.length, 2)
    // A plain read inside the window does not re-probe.
    clock += 1_000
    await provider.status()
    assert.equal(calls.length, 2)
  })

  it('keeps the last verdict when a refresh cannot run', async () => {
    const calls: string[] = []
    let fail = false
    const provider = make({
      systemLookup: async (host: string) => {
        calls.push(host)
        if (fail) throw new Error('EAI_AGAIN')
        return [POISONED_IP]
      },
    })
    await provider.status({ refresh: true })
    // The canary itself turning inconclusive is a real, reportable verdict...
    fail = true
    const after = await provider.status({ refresh: true })
    assert.equal(after.verdict, 'inconclusive')
    assert.equal(after.resolver, 'doh')
    assert.equal(calls.length, 2)
  })
})
