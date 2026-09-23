/**
 * What the engines put on the wire, driven by a stubbed `fetch`.
 *
 * The parser tests next door check what a page MEANS; these check the two things
 * a local proxy can take away from a request before any parser sees it, both
 * measured on this machine through the kernel's own dispatcher (undici plus the
 * proxy at 127.0.0.1:7897, whose responses arrive with `headers: []`):
 *
 *   - the body's `content-encoding`, so a gzip body reaches us undecodable —
 *     the Parallel MCP endpoint answered 50,347 bytes of valid JSON-RPC direct
 *     and 10,817 bytes of gzip through that path;
 *   - a redirect's `Location`, so a 302 cannot be followed — Bing answers the zh
 *     market with `302 → cn.bing.com` and the engine reported a bare "HTTP 302"
 *     while the page itself was reachable (direct: 200, ten result blocks).
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { bingEngine } from '../src/engines/bing.ts'
import { request } from '../src/engines/types.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** One result page the Bing parser reads. */
const PAGE = '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.test/a">A</a></h2><p>snippet</p></li></ol>'

/** Replace global fetch, recording every (url, init) it was called with. */
function stubFetch(respond: (url: string, init: RequestInit | undefined) => Response): Array<{ url: string, init: RequestInit | undefined }> {
  const seen: Array<{ url: string, init: RequestInit | undefined }> = []
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return Promise.resolve(respond(String(url), init))
  }) as typeof fetch
  return seen
}

describe('the engines ask for an uncompressed body', () => {
  it('adds accept-encoding: identity without dropping the caller headers', async () => {
    const seen = stubFetch(() => new Response('{}', { status: 200 }))
    await request('https://example.test/x', { headers: { 'user-agent': 'UA' }, signal: new AbortController().signal })
    const headers = seen[0]?.init?.headers as Record<string, string> | undefined
    assert.equal(headers?.['accept-encoding'], 'identity')
    assert.equal(headers?.['user-agent'], 'UA', 'the caller headers are merged, not replaced')
  })
})

describe('bing: a redirect we could not follow', () => {
  const signal = new AbortController().signal

  it('retries the host Bing itself redirects to, and returns its results', async () => {
    // The 302 arrives without `Location` through the proxy above, so there is
    // nothing to follow and the engine must know where Bing was sending it.
    const seen = stubFetch((url) => (url.startsWith('https://www.bing.com/')
      ? new Response('', { status: 302 })
      : new Response(PAGE, { status: 200 })))
    const sources = await bingEngine('zh').run({ query: 'test', maxResults: 5, signal })
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.url, 'https://example.test/a')
    assert.equal(seen.length, 2, 'the first host is tried once, then the measured target')
    assert.match(seen[1]?.url ?? '', /^https:\/\/cn\.bing\.com\/search\?/)
    // The retry keeps the same query and market, or it would answer a different search.
    assert.match(seen[1]?.url ?? '', /q=test/u)
    assert.match(seen[1]?.url ?? '', /mkt=zh-CN/u)
  })

  it('reports the second host status when the retry fails too', async () => {
    stubFetch((url) => new Response('', { status: url.startsWith('https://www.bing.com/') ? 302 : 503 }))
    await assert.rejects(
      () => bingEngine('zh').run({ query: 'test', maxResults: 5, signal }),
      /HTTP 503/u,
    )
  })

  it('a non-zh market reports the status without inventing a target', async () => {
    const seen = stubFetch(() => new Response('', { status: 302 }))
    await assert.rejects(
      () => bingEngine('en').run({ query: 'test', maxResults: 5, signal }),
      /HTTP 302/u,
    )
    assert.equal(seen.length, 1, 'only the known zh redirect target is worth a retry')
  })
})
