/**
 * Chain behavior: engine order, fall-through, budget accounting, rotation.
 * The engines are fakes, so these assertions are about the chain's own
 * contract — not about any real search backend.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ChainExhaustedError, runChain, runChainCached, SearchCache, type ChainStep } from '../src/chain.ts'
import type { Engine } from '../src/engines/types.ts'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'

function source(url: string): WebSearchSource {
  return { url }
}

/** An engine that returns `count` sources, or throws `error` when given one. */
function fake(id: string, behavior: number | string, calls: string[]): ChainStep {
  const engine: Engine = {
    id,
    async run(): Promise<WebSearchSource[]> {
      calls.push(id)
      if (typeof behavior === 'string') throw new Error(behavior)
      return Array.from({ length: behavior }, (_, index) => source(`https://${id}.example/${String(index)}`))
    },
  }
  return { id, engine }
}

const OPTIONS = { mode: 'fallback' as const, timeoutMs: 5_000, maxResults: 10, rotation: 0 }

describe('runChain', () => {
  it('stops at the first engine that returns results', async () => {
    const calls: string[] = []
    const outcome = await runChain(
      [fake('a', 2, calls), fake('b', 2, calls)],
      { query: 'q' },
      OPTIONS,
    )
    assert.equal(outcome.usedEngine, 'a')
    assert.deepEqual(calls, ['a'])
    assert.equal(outcome.result.sources.length, 2)
  })

  it('falls through to the next engine when one throws', async () => {
    const calls: string[] = []
    const outcome = await runChain(
      [fake('a', 'boom', calls), fake('b', 1, calls)],
      { query: 'q' },
      OPTIONS,
    )
    assert.equal(outcome.usedEngine, 'b')
    assert.deepEqual(calls, ['a', 'b'])
    assert.equal(outcome.attempts[0].ok, false)
    assert.equal(outcome.attempts[0].error, 'boom')
    // The note names the engine that failed AND the one that answered, so a
    // reader can tell the result came from a fallback.
    assert.match(outcome.result.content ?? '', /a failed/)
    assert.match(outcome.result.content ?? '', /switched to b/)
  })

  it('falls through when an engine returns zero results', async () => {
    const calls: string[] = []
    const outcome = await runChain(
      [fake('a', 0, calls), fake('b', 3, calls)],
      { query: 'q' },
      OPTIONS,
    )
    assert.equal(outcome.usedEngine, 'b')
    assert.deepEqual(calls, ['a', 'b'])
    // An empty result is a successful attempt, not an error: the note must
    // not claim the engine failed.
    assert.equal(outcome.attempts[0].ok, true)
    assert.equal(outcome.attempts[0].resultCount, 0)
  })

  it('throws ChainExhaustedError naming every attempt when all fail', async () => {
    const calls: string[] = []
    await assert.rejects(
      runChain([fake('a', 'one', calls), fake('b', 'two', calls)], { query: 'q' }, OPTIONS),
      (error: unknown) => {
        assert.ok(error instanceof ChainExhaustedError)
        assert.match(error.message, /a \(one\)/)
        assert.match(error.message, /b \(two\)/)
        return true
      },
    )
    assert.deepEqual(calls, ['a', 'b'])
  })

  it('honors maxResults from the request over the configured cap', async () => {
    const calls: string[] = []
    const outcome = await runChain(
      [fake('a', 5, calls)],
      { query: 'q', maxResults: 2 },
      OPTIONS,
    )
    assert.equal(outcome.result.sources.length, 2)
  })

  it('deduplicates URLs across engines that both answered', async () => {
    const calls: string[] = []
    const shared: ChainStep = {
      id: 'a',
      engine: { id: 'a', async run(): Promise<WebSearchSource[]> { calls.push('a'); return [source('https://same.example/x')] } },
    }
    const outcome = await runChain([shared], { query: 'q' }, OPTIONS)
    assert.equal(outcome.result.sources.length, 1)
    assert.equal(calls.length, 1)
  })

  it('rotates the starting engine in rotate mode', async () => {
    const steps = (calls: string[]): ChainStep[] => [fake('a', 1, calls), fake('b', 1, calls)]
    const first: string[] = []
    const second: string[] = []
    await runChain(steps(first), { query: 'q' }, { ...OPTIONS, mode: 'rotate', rotation: 0 })
    await runChain(steps(second), { query: 'q' }, { ...OPTIONS, mode: 'rotate', rotation: 1 })
    assert.equal(first[0], 'a')
    assert.equal(second[0], 'b')
  })

  it('reports engines skipped after the budget is spent', async () => {
    const calls: string[] = []
    // A hanging engine: it only settles when the chain's own budget aborts it.
    // That is the real shape of a budget exhaustion — the deadline fires
    // mid-attempt, so the failing engine is recorded and the ones after it are
    // skipped rather than attempted.
    const hanging: ChainStep = {
      id: 'slow',
      engine: {
        id: 'slow',
        async run({ signal }): Promise<WebSearchSource[]> {
          calls.push('slow')
          return await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(new Error('search timed out')) })
          })
        },
      },
    }
    await assert.rejects(
      runChain([hanging, fake('b', 1, calls)], { query: 'q' }, { ...OPTIONS, timeoutMs: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof ChainExhaustedError)
        assert.deepEqual(error.attempts.map(attempt => attempt.id), ['slow'])
        assert.deepEqual([...error.skipped], ['b'])
        return true
      },
    )
    // The second engine must NOT have run: the budget was already spent.
    assert.deepEqual(calls, ['slow'])
  })

  it('skips every engine when the caller signal is already aborted', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runChain([fake('a', 1, calls), fake('b', 1, calls)], { query: 'q' }, { ...OPTIONS, signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof ChainExhaustedError)
        assert.deepEqual([...error.skipped], ['a', 'b'])
        assert.deepEqual(error.attempts, [])
        return true
      },
    )
    assert.deepEqual(calls, [])
  })

  it('propagates caller cancellation instead of walking the chain', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const slow: ChainStep = {
      id: 'slow',
      engine: {
        id: 'slow',
        async run({ signal }): Promise<WebSearchSource[]> {
          calls.push('slow')
          return await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(new Error('aborted')) })
            controller.abort()
          })
        },
      },
    }
    await assert.rejects(
      runChain([slow, fake('b', 1, calls)], { query: 'q' }, { ...OPTIONS, signal: controller.signal }),
    )
    // The second engine must NOT run: a cancelled call is over, not a
    // fall-through opportunity.
    assert.deepEqual(calls, ['slow'])
  })
})

describe('SearchCache', () => {
  it('returns a stored entry within its TTL', () => {
    const cache = new SearchCache()
    cache.set('k', [source('https://a.example')], 'bing', undefined)
    assert.equal(cache.get('k', 60_000)?.sources.length, 1)
  })

  it('drops an entry past its TTL', () => {
    const cache = new SearchCache()
    cache.set('k', [source('https://a.example')], 'bing', undefined)
    assert.equal(cache.get('k', 0), undefined)
  })

  it('evicts the oldest entry past the cap', () => {
    const cache = new SearchCache(2)
    cache.set('a', [source('https://a.example')], 'bing', undefined)
    cache.set('b', [source('https://b.example')], 'bing', undefined)
    cache.set('c', [source('https://c.example')], 'bing', undefined)
    assert.equal(cache.get('a', 60_000), undefined)
    assert.ok(cache.get('c', 60_000) !== undefined)
  })

  it('clears everything', () => {
    const cache = new SearchCache()
    cache.set('k', [source('https://a.example')], 'bing', undefined)
    cache.clear()
    assert.equal(cache.get('k', 60_000), undefined)
  })
})

describe('runChainCached', () => {
  const CACHE_OPTIONS = { ...OPTIONS, cacheTtlMs: 60_000 }

  it('serves a repeat query from cache without re-running an engine', async () => {
    const calls: string[] = []
    const cache = new SearchCache()
    const steps = (): ChainStep[] => [fake('a', 2, calls)]
    const first = await runChainCached(steps(), { query: 'same' }, { ...CACHE_OPTIONS, cache })
    const second = await runChainCached(steps(), { query: 'same' }, { ...CACHE_OPTIONS, cache })
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    // The engine ran exactly once: the second call was a replay.
    assert.deepEqual(calls, ['a'])
  })

  it('keys on the result cap, so a larger request is not served a smaller answer', async () => {
    const calls: string[] = []
    const cache = new SearchCache()
    await runChainCached([fake('a', 2, calls)], { query: 'q', maxResults: 2 }, { ...CACHE_OPTIONS, cache })
    const bigger = await runChainCached([fake('a', 5, calls)], { query: 'q', maxResults: 5 }, { ...CACHE_OPTIONS, cache })
    assert.equal(bigger.cached, false)
    assert.equal(bigger.result.sources.length, 5)
  })

  it('invalidates when the engine walk changes (reorder / disable)', async () => {
    const calls: string[] = []
    const cache = new SearchCache()
    await runChainCached([fake('a', 1, calls), fake('b', 1, calls)], { query: 'q' }, { ...CACHE_OPTIONS, cache })
    // Same query, different chain identity: must NOT replay the old answer.
    const after = await runChainCached([fake('b', 1, calls)], { query: 'q' }, { ...CACHE_OPTIONS, cache })
    assert.equal(after.cached, false)
    assert.equal(after.usedEngine, 'b')
  })

  it('does not cache when the TTL is zero', async () => {
    const calls: string[] = []
    const cache = new SearchCache()
    const steps = (): ChainStep[] => [fake('a', 1, calls)]
    await runChainCached(steps(), { query: 'q' }, { ...CACHE_OPTIONS, cache, cacheTtlMs: 0 })
    const second = await runChainCached(steps(), { query: 'q' }, { ...CACHE_OPTIONS, cache, cacheTtlMs: 0 })
    assert.equal(second.cached, false)
    assert.deepEqual(calls, ['a', 'a'])
  })

  it('does not cache a failed search', async () => {
    const calls: string[] = []
    const cache = new SearchCache()
    await assert.rejects(
      runChainCached([fake('a', 'boom', calls)], { query: 'q' }, { ...CACHE_OPTIONS, cache }),
    )
    const second = await runChainCached([fake('a', 1, calls)], { query: 'q' }, { ...CACHE_OPTIONS, cache })
    assert.equal(second.cached, false)
  })
})
