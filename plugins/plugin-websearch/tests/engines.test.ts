/**
 * Engine parsers, driven by saved fixtures.
 *
 * These are the tests that catch a search provider redesigning its markup:
 * a real page's shape is captured once, and a parser change that no longer
 * matches it fails here instead of silently returning zero results in
 * production. Each fixture is trimmed to the containers the parser reads.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseAnySearch } from '../src/engines/anysearch.ts'
import { parseBing } from '../src/engines/bing.ts'
import { parseExa } from '../src/engines/exa.ts'
import { parseJsonRpc } from '../src/engines/mcp.ts'
import { parseParallel } from '../src/engines/parallel.ts'
import { parseSearxng } from '../src/engines/searxng.ts'

describe('parseBing', () => {
  const html = `
    <ol id="b_results">
      <li class="b_algo"><h2><a href="https://github.com/deepseek-ai/deepseek-harness">GitHub - deepseek-ai/deepseek-harness</a></h2><p>DeepSeek Harness (dsh) is an open-source agent harness.</p></li>
      <li class="b_algo"><h2><a href="https://www.deepseek.com/harness/en/">DeepSeek Harness developer preview</a></h2><p>Everything is a plugin.</p></li>
      <li class="b_algo"><p>a result with no anchor</p></li>
    </ol>`

  it('extracts url, title and snippet per result', () => {
    const sources = parseBing(html, 10)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].url, 'https://github.com/deepseek-ai/deepseek-harness')
    assert.equal(sources[0].title, 'GitHub - deepseek-ai/deepseek-harness')
    assert.match(sources[0].snippet ?? '', /open-source agent harness/)
  })

  it('drops a block with no link rather than emitting a broken source', () => {
    const sources = parseBing(html, 10)
    assert.ok(sources.every(source => source.url.startsWith('http')))
  })

  it('honors the limit', () => {
    assert.equal(parseBing(html, 1).length, 1)
  })

  it('returns an empty list for a page with no results (a markup change)', () => {
    assert.deepEqual(parseBing('<html><body>nothing here</body></html>', 10), [])
  })
})

describe('parseAnySearch', () => {
  it('maps the JSON envelope', () => {
    const sources = parseAnySearch({
      code: 0,
      message: 'success',
      data: {
        results: [
          { url: 'https://a.example', title: 'A', snippet: 'about A', content: 'long body' },
          { url: 'https://b.example', title: 'B', content: 'body used when snippet is absent' },
          { title: 'no url' },
        ],
      },
    }, 10)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].snippet, 'about A')
    // `content` is the fallback only when `snippet` is missing.
    assert.equal(sources[1].snippet, 'body used when snippet is absent')
  })

  it('treats a non-zero business code as a failure even on HTTP 200', () => {
    // The API signals rate limits and bad requests through `code`, so checking
    // only the HTTP status would surface them as a silent "0 results".
    assert.throws(
      () => parseAnySearch({ code: 429, message: 'rate limited' }, 10),
      /AnySearch returned an error: rate limited/,
    )
  })

  it('fails when the envelope has no results array', () => {
    assert.throws(() => parseAnySearch({ code: 0 }, 10), /no data\.results/)
  })

  it('accepts an empty result list as success', () => {
    assert.deepEqual(parseAnySearch({ code: 0, data: { results: [] } }, 10), [])
  })
})

describe('parseSearxng', () => {
  it('maps the JSON API payload', () => {
    const sources = parseSearxng({
      results: [
        { url: 'https://a.example', title: 'A', content: 'about A' },
        { url: 'https://b.example' },
        { title: 'no url' },
      ],
    }, 10)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].snippet, 'about A')
    assert.equal(sources[1].title, undefined)
  })

  it('explains that a non-JSON body means the JSON API is disabled', () => {
    // The public instances answer the HTML page with HTTP 200, so the error
    // must name the real cause instead of "0 results".
    assert.throws(() => parseSearxng({}, 10), /JSON API disabled/)
  })

  it('accepts an empty result list as success', () => {
    assert.deepEqual(parseSearxng({ results: [] }, 10), [])
  })
})

describe('parseExa', () => {
  const text = `Title: deepseek-ai/deepseek-harness
URL: https://github.com/deepseek-ai/deepseek-harness
Published: N/A
Author: N/A
Highlights:
DeepSeek Harness: Everything is a Plugin.
...
# DeepSeek Harness

Title: Second result
URL: https://example.com/second
Published: 2026-08-14T00:00:00.000Z
Highlights:
Some highlight text`

  it('parses each Title/URL group', () => {
    const sources = parseExa(text, 10)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].url, 'https://github.com/deepseek-ai/deepseek-harness')
    assert.equal(sources[1].title, 'Second result')
  })

  it('treats the N/A placeholder as an absent date', () => {
    const sources = parseExa(text, 10)
    assert.equal(sources[0].publishedAt, undefined)
    assert.equal(sources[1].publishedAt, '2026-08-14T00:00:00.000Z')
  })

  it('drops a group with no URL', () => {
    assert.deepEqual(parseExa('Title: orphan\nHighlights:\nnothing', 10), [])
  })
})

describe('parseParallel', () => {
  it('parses the nested JSON payload and takes the first excerpt', () => {
    const payload = JSON.stringify({
      search_id: 'search_x',
      results: [
        { url: 'https://a.example', title: 'A', publish_date: null, excerpts: ['', '  ', 'real excerpt'] },
        { url: 'https://b.example', title: 'B', publish_date: '2026-01-02', excerpts: [] },
        { title: 'no url' },
      ],
    })
    const sources = parseParallel(payload, 10)
    assert.equal(sources.length, 2)
    assert.equal(sources[0].snippet, 'real excerpt')
    assert.equal(sources[1].publishedAt, '2026-01-02')
    assert.equal(sources[0].publishedAt, undefined)
  })

  it('fails loudly when the payload is not JSON (transport contract change)', () => {
    assert.throws(() => parseParallel('Title: text layout instead', 10), /did not return valid JSON/)
  })

  it('fails when the results field is missing', () => {
    assert.throws(() => parseParallel('{"search_id":"x"}', 10), /no results field/)
  })
})

describe('parseJsonRpc', () => {
  it('reads a plain JSON body', () => {
    const envelope = parseJsonRpc('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}')
    assert.ok(envelope.result !== undefined)
  })

  it('reads an SSE data frame (the Exa framing)', () => {
    const envelope = parseJsonRpc('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n')
    assert.ok(envelope.result !== undefined)
  })

  it('rejects an empty body', () => {
    assert.throws(() => parseJsonRpc('   '), /response is empty/)
  })

  it('rejects a body that carries no JSON-RPC frame', () => {
    assert.throws(() => parseJsonRpc('event: ping\n\n'), /no parsable JSON-RPC frame/)
  })
})
