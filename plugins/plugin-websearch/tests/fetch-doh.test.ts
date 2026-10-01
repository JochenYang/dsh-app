/**
 * The DoH client: answer parsing, pool fallthrough, and the NODATA case.
 * The transport seam is a fake queue, so these assertions are about the
 * client's own logic — no packet leaves the machine.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DOH_POOL, DohCache, dohResolve } from '../src/fetch/doh.ts'

/** A fake send that answers from a URL-keyed queue of payloads/throws. */
function sendOf(answers: ReadonlyMap<string, unknown>) {
  return async (url: string): Promise<unknown> => {
    const key = [...answers.keys()].find(prefix => url.startsWith(prefix))
    if (key === undefined) throw new Error(`no fake answer for ${url}`)
    const answer = answers.get(key)
    if (answer instanceof Error) throw answer
    return answer
  }
}

const A_OK = { Status: 0, Answer: [{ name: 'example.com', type: 1, TTL: 120, data: '93.184.216.34' }] }

describe('dohResolve', () => {
  it('returns the address set from the first answering node', async () => {
    const send = sendOf(new Map([[DOH_POOL[0].url, A_OK]]))
    const result = await dohResolve('example.com', { send })
    assert.equal(result.kind, 'addresses')
    if (result.kind !== 'addresses') return
    assert.deepEqual(result.addresses, ['93.184.216.34'])
    assert.equal(result.ttlSeconds, 120)
  })

  it('falls through to the next node when one fails', async () => {
    const send = sendOf(new Map<string, unknown>([
      [DOH_POOL[0].url, new Error('connect ECONNREFUSED')],
      [DOH_POOL[1].url, { Status: 0, Answer: [{ type: 1, TTL: 60, data: '1.2.3.4' }] }],
    ]))
    const result = await dohResolve('example.com', { send })
    assert.equal(result.kind, 'addresses')
    if (result.kind !== 'addresses') return
    assert.deepEqual(result.addresses, ['1.2.3.4'])
  })

  it('treats a non-zero DNS status as a miss, not an answer', async () => {
    const send = sendOf(new Map<string, unknown>([[DOH_POOL[0].url, { Status: 2, Answer: [] }]]))
    const result = await dohResolve('example.com', { send })
    // Every node missed with SERVFAIL-style statuses: the honest outcome is
    // a failure the caller turns into a coded error, never a silent empty.
    assert.equal(result.kind, 'failure')
  })

  it('reports NODATA as an empty answer, not a failure', async () => {
    const send = sendOf(new Map<string, unknown>([
      [`${DOH_POOL[0].url}?name=example.com&type=A`, { Status: 0, Answer: [] }],
      [`${DOH_POOL[0].url}?name=example.com&type=AAAA`, { Status: 0, Answer: [] }],
    ]))
    const result = await dohResolve('example.com', { send })
    assert.equal(result.kind, 'empty')
  })

  it('merges the A set when AAAA has no records', async () => {
    const send = sendOf(new Map<string, unknown>([
      [`${DOH_POOL[0].url}?name=example.com&type=A`, { Status: 0, Answer: [{ type: 1, TTL: 300, data: '5.6.7.8' }] }],
      [`${DOH_POOL[0].url}?name=example.com&type=AAAA`, { Status: 0, Answer: [] }],
    ]))
    const result = await dohResolve('example.com', { send })
    assert.equal(result.kind, 'addresses')
    if (result.kind !== 'addresses') return
    assert.deepEqual(result.addresses, ['5.6.7.8'])
  })

  it('de-duplicates addresses across nodes', async () => {
    const send = sendOf(new Map<string, unknown>([
      [`${DOH_POOL[0].url}?name=example.com&type=A`, { Status: 0, Answer: [
        { type: 1, TTL: 60, data: '5.6.7.8' },
        { type: 1, TTL: 60, data: '5.6.7.8' },
      ] }],
      [`${DOH_POOL[0].url}?name=example.com&type=AAAA`, { Status: 0, Answer: [] }],
    ]))
    const result = await dohResolve('example.com', { send })
    assert.equal(result.kind, 'addresses')
    if (result.kind !== 'addresses') return
    assert.deepEqual(result.addresses, ['5.6.7.8'])
  })
})

describe('DohCache', () => {
  it('serves an entry until its TTL, then drops it', async () => {
    const cache = new DohCache(8)
    cache.set('a', ['1.1.1.1'], 5)
    assert.deepEqual(cache.get('a'), ['1.1.1.1'])
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(cache.get('a'), undefined)
  })

  it('evicts the oldest entry when full', () => {
    const cache = new DohCache(2)
    cache.set('a', ['1.1.1.1'], 3600_000)
    cache.set('b', ['2.2.2.2'], 3600_000)
    cache.set('c', ['3.3.3.3'], 3600_000)
    assert.equal(cache.get('a'), undefined)
    assert.deepEqual(cache.get('c'), ['3.3.3.3'])
    cache.clear()
    assert.equal(cache.get('c'), undefined)
  })
})
