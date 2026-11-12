/**
 * Config validation: defaults, degradation, and the secret round-trip.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activeEngines,
  assertKeysWellFormed,
  BRAND_PROVIDER_ID,
  defaultFile,
  ENGINE_IDS,
  engineBlockReason,
  engineSpec,
  isStoredKeyToken,
  MAX_KEYS_PER_ENGINE,
  splitKeys,
  UPSTREAM_PROVIDER_IDS,
  validateFile,
  WebSearchValidationError,
} from '../src/wire.ts'

describe('validateFile', () => {
  it('fills every engine when the file has none', () => {
    const file = validateFile({})
    assert.equal(file.engines.length, ENGINE_IDS.length)
    assert.deepEqual(file.engines.map(entry => entry.id).sort(), [...ENGINE_IDS].sort())
  })

  it('appends engines missing from a hand-trimmed file instead of dropping them', () => {
    const file = validateFile({ engines: [{ id: 'bing', enabled: true, priority: 0 }] })
    assert.equal(file.engines.length, ENGINE_IDS.length)
    assert.equal(file.engines[0].id, 'bing')
  })

  it('rejects an unknown engine id', () => {
    assert.throws(
      () => validateFile({ engines: [{ id: 'google', enabled: true, priority: 0 }] }),
      { code: 'engine.unknownId', params: { id: 'google' } },
    )
  })

  it('rejects a duplicated engine id', () => {
    assert.throws(
      () => validateFile({ engines: [{ id: 'bing', priority: 0 }, { id: 'bing', priority: 1 }] }),
      { code: 'engine.duplicate', params: { id: 'bing' } },
    )
  })

  it('clamps numeric settings into their valid ranges', () => {
    const file = validateFile({ timeoutMs: 1, maxResults: 9999, cacheTtlMinutes: -5 })
    assert.equal(file.timeoutMs, 3_000)
    assert.equal(file.maxResults, 50)
    assert.equal(file.cacheTtlMinutes, 0)
  })

  it('accepts every DeepSeek provider the kernel line can mount', () => {
    for (const id of UPSTREAM_PROVIDER_IDS) assert.equal(validateFile({ provider: id }).provider, id)
    assert.equal(validateFile({ provider: 'nonsense' }).provider, BRAND_PROVIDER_ID)
  })

  it('accepts only the two known chain modes', () => {
    assert.equal(validateFile({ mode: 'rotate' }).mode, 'rotate')
    assert.equal(validateFile({ mode: 'nonsense' }).mode, 'fallback')
  })

  it('rejects a SearXNG instance without a scheme', () => {
    assert.throws(
      () => validateFile({ searxngInstances: ['searx.example.com'] }),
      { code: 'searxng.notHttp', params: { url: 'searx.example.com' } },
    )
  })

  it('trims and drops blank SearXNG instance lines', () => {
    const file = validateFile({ searxngInstances: ['  https://a.example  ', '', '   '] })
    assert.deepEqual([...file.searxngInstances], ['https://a.example'])
  })
})

describe('activeEngines', () => {
  it('orders by priority and drops disabled engines', () => {
    const file = validateFile({
      engines: [
        { id: 'bing', enabled: false, priority: 0 },
        { id: 'parallel', enabled: true, priority: 2 },
        { id: 'exa', enabled: true, priority: 1 },
      ],
    })
    const ids = activeEngines(file).map(entry => entry.id)
    // The two enabled engines keep their relative priority order. Engines
    // absent from the file are appended by validateFile (a missing row must
    // never silently remove a search path), so this asserts the leading
    // order rather than the whole list.
    assert.deepEqual(ids.slice(0, 2), ['exa', 'parallel'])
    assert.ok(!ids.includes('bing'))
  })

  it('drops SearXNG when no instance is configured', () => {
    // SearXNG has no working default (public instances disabled the JSON API),
    // so attempting it would spend a round-trip on every search and add a
    // permanent failure to the fallback note.
    const withoutInstances = validateFile({ searxngInstances: [] })
    assert.ok(!activeEngines(withoutInstances).some(entry => entry.id === 'searxng'))

    const withInstance = validateFile({ searxngInstances: ['https://searx.example.com'] })
    assert.ok(activeEngines(withInstance).some(entry => entry.id === 'searxng'))
  })

  it('orders SearXNG last by default', () => {
    // The shipped order must not put a not-yet-configured engine ahead of the
    // ones that work out of the box.
    const ids = ENGINE_IDS
    assert.equal(ids[ids.length - 1], 'searxng')
  })

  it('ships the evidence-based default order', () => {
    // Locked deliberately: every position was decided by a head-to-head of all
    // four working engines across five query shapes (see the ENGINE_IDS
    // comment). A change here should be a new measurement, not a drive-by.
    assert.deepEqual(
      [...ENGINE_IDS],
      ['anysearch', 'bing', 'parallel', 'exa', 'searxng'],
    )
  })

  it('keeps the metered engines behind the keyless ones', () => {
    // Free engines absorb the volume; the hosted endpoints are backstops so a
    // busy day does not spend quota. AnySearch and Bing are keyless and
    // unmetered; Parallel and Exa are hosted and metered.
    const ids = [...ENGINE_IDS]
    assert.ok(ids.indexOf('anysearch') < ids.indexOf('parallel'))
    assert.ok(ids.indexOf('bing') < ids.indexOf('parallel'))
    assert.ok(ids.indexOf('anysearch') < ids.indexOf('exa'))
    assert.ok(ids.indexOf('bing') < ids.indexOf('exa'))
  })

  it('keeps a metered engine that has no key', () => {
    // Exa, Parallel and AnySearch all answer anonymously, so a row with no key
    // must stay in the chain. Asserted on a file where it is the ONLY engine
    // enabled, so the result cannot be true by accident.
    const base = defaultFile()
    const file = validateFile({
      ...base,
      engines: base.engines.map(entry => ({
        ...entry,
        enabled: entry.id === 'exa',
        ...entry.id === 'exa' ? { apiKeys: undefined } : {},
      })),
    })
    const active = activeEngines(file)
    assert.deepEqual(active.map(entry => entry.id), ['exa'])
  })
})

describe('engineBlockReason', () => {
  it('reports a disabled engine', () => {
    assert.deepEqual(engineBlockReason({ id: 'bing', enabled: false, priority: 0 }), { code: 'engine.disabled', params: { id: 'bing' } })
  })

  it('reports a keyless engine as runnable', () => {
    assert.equal(engineBlockReason({ id: 'bing', enabled: true, priority: 0 }), undefined)
  })

  it('never blocks a keyed engine for its key, whatever the list holds', () => {
    // A missing, unmatched or unset key is not a reason to block: the anonymous
    // path is a real search path. Blocking here would have the badge contradict
    // the chain, which keeps the engine either way.
    for (const apiKeys of [undefined, [], ['$ENV:NOT_SET_ANYWHERE']]) {
      assert.equal(engineBlockReason({ id: 'exa', enabled: true, priority: 0, ...apiKeys === undefined ? {} : { apiKeys } }), undefined)
    }
  })

  it('blocks SearXNG with no instance, and only then', () => {
    assert.deepEqual(engineBlockReason({ id: 'searxng', enabled: true, priority: 0 }, 0), {
      code: 'engine.missingInstance',
      params: { label: 'SearXNG' },
    })
    assert.equal(engineBlockReason({ id: 'searxng', enabled: true, priority: 0 }, 1), undefined)
  })
})

describe('key parsing', () => {
  it('splits on commas and newlines, trimming and dropping empties', () => {
    assert.deepEqual(splitKeys(' a , b\n c ,, \n'), ['a', 'b', 'c'])
  })

  it('collapses duplicates in first-seen order', () => {
    assert.deepEqual(splitKeys('b,a,b'), ['b', 'a'])
  })

  it('does not reject or cap: policy belongs to the write path', () => {
    // This runs on the LOAD path too (`validateEngine`). A parser that throws
    // there makes an unreadable config out of one bad character: the store falls
    // back to defaults and the next save writes them over the real file.
    assert.deepEqual(splitKeys('sk-a b'), ['sk-a b'])
    assert.equal(splitKeys(Array.from({ length: 40 }, (_, index) => `k${index}`).join(',')).length, 40)
  })

  it('clamps an oversized stored list instead of failing the load', () => {
    const keys = Array.from({ length: 40 }, (_, index) => `k${index}`)
    const file = validateFile({ engines: [{ id: 'exa', enabled: true, priority: 0, apiKeys: keys }] })
    assert.equal(file.engines[0].apiKeys?.length, MAX_KEYS_PER_ENGINE)
  })

  it('reads the pre-0.3 single apiKey field into the list form', () => {
    const file = validateFile({ engines: [{ id: 'exa', enabled: true, priority: 0, apiKey: 'k1, k2' }] })
    assert.deepEqual(file.engines[0].apiKeys, ['k1', 'k2'])
  })

  it('merges apiKeys arrays with the same split rules', () => {
    const file = validateFile({ engines: [{ id: 'exa', enabled: true, priority: 0, apiKeys: ['k1\nk2', 'k1'] }] })
    assert.deepEqual(file.engines[0].apiKeys, ['k1', 'k2'])
  })

  it('rejects a non-array apiKeys field', () => {
    assert.throws(
      () => validateFile({ engines: [{ id: 'exa', apiKeys: 'k1' }] }),
      WebSearchValidationError,
    )
  })

  it('declares key support per engine, and a console only where a key exists', () => {
    assert.equal(engineSpec('bing')?.keySupport, 'none')
    assert.equal(engineSpec('searxng')?.keySupport, 'none')
    assert.equal(engineSpec('exa')?.keySupport, 'optional')
    assert.equal(engineSpec('parallel')?.keySupport, 'optional')
    assert.equal(engineSpec('anysearch')?.keySupport, 'optional')
    // Bing's public Search API was retired in 2025-08, so a signup link there
    // would be an entrance with no door.
    assert.equal(engineSpec('bing')?.keyConsole, undefined)
    assert.match(engineSpec('exa')?.keyConsole ?? '', /^https:\/\//)
  })
})

describe('assertKeysWellFormed (the write path\'s strict half)', () => {
  it('accepts a well-formed list', () => {
    assertKeysWellFormed([{ id: 'exa', apiKeys: ['sk-a', 'sk-b'] }])
    assertKeysWellFormed([{ id: 'exa', apiKey: 'sk-legacy' }])
    assertKeysWellFormed(undefined)
  })

  it('names the engine when a key has whitespace inside it', () => {
    assert.throws(
      () => assertKeysWellFormed([{ id: 'parallel', apiKeys: ['sk-a b'] }]),
      (error: unknown) => error instanceof WebSearchValidationError
        && error.code === 'engine.keyMalformed'
        && error.params?.id === 'parallel',
    )
  })

  it('rejects anything outside printable ASCII, including the mask itself', () => {
    // Every provider's keys are printable ASCII. A full-width character or a
    // copy of the placeholder is a paste accident, and storing it would create a
    // "key" that can only ever 401 while the read path masks it back out of
    // sight.
    for (const key of ['••••••', '•••••', 'sk－fullwidth', 'sk\u00a0nbsp']) {
      assert.throws(
        () => assertKeysWellFormed([{ id: 'exa', apiKeys: [key] }]),
        WebSearchValidationError,
        `expected "${key}" to be refused`,
      )
    }
  })

  it('refuses more keys than the cap instead of silently dropping the tail', () => {
    const keys = Array.from({ length: MAX_KEYS_PER_ENGINE + 1 }, (_, index) => `k${index}`)
    assert.throws(
      () => assertKeysWellFormed([{ id: 'exa', apiKeys: keys }]),
      (error: unknown) => error instanceof WebSearchValidationError && error.code === 'engine.keyTooMany',
    )
  })

  it('does not count duplicates toward the cap', () => {
    const keys = Array.from({ length: MAX_KEYS_PER_ENGINE }, () => 'k-same')
    assertKeysWellFormed([{ id: 'exa', apiKeys: keys }])
  })
})

describe('isStoredKeyToken', () => {
  it('recognises the placeholder the host sends and nothing a user would type', () => {
    assert.equal(isStoredKeyToken('••••••#a1b2c3d4'), true)
    assert.equal(isStoredKeyToken('••••••'), false, 'the pre-reference shape is no longer a placeholder')
    assert.equal(isStoredKeyToken('$ENV:EXA_KEY'), false)
    assert.equal(isStoredKeyToken('sk-live-key'), false)
    assert.equal(isStoredKeyToken('••••••#NOTHEX!!'), false)
  })
})
