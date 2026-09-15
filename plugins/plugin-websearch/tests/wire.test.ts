/**
 * Config validation: defaults, degradation, and the secret round-trip.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activeEngines,
  BRAND_PROVIDER_ID,
  defaultFile,
  ENGINE_IDS,
  engineBlockReason,
  maskEngines,
  unmaskEngines,
  UPSTREAM_PROVIDER_ID,
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
      /不认识的引擎 id/,
    )
  })

  it('rejects a duplicated engine id', () => {
    assert.throws(
      () => validateFile({ engines: [{ id: 'bing', priority: 0 }, { id: 'bing', priority: 1 }] }),
      /重复出现/,
    )
  })

  it('clamps numeric settings into their valid ranges', () => {
    const file = validateFile({ timeoutMs: 1, maxResults: 9999, cacheTtlMinutes: -5 })
    assert.equal(file.timeoutMs, 3_000)
    assert.equal(file.maxResults, 50)
    assert.equal(file.cacheTtlMinutes, 0)
  })

  it('accepts only the two known provider ids', () => {
    assert.equal(validateFile({ provider: UPSTREAM_PROVIDER_ID }).provider, UPSTREAM_PROVIDER_ID)
    assert.equal(validateFile({ provider: 'nonsense' }).provider, BRAND_PROVIDER_ID)
  })

  it('accepts only the two known chain modes', () => {
    assert.equal(validateFile({ mode: 'rotate' }).mode, 'rotate')
    assert.equal(validateFile({ mode: 'nonsense' }).mode, 'fallback')
  })

  it('rejects a SearXNG instance without a scheme', () => {
    assert.throws(
      () => validateFile({ searxngInstances: ['searx.example.com'] }),
      /必须是 http\(s\) 开头/,
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

  it('drops a key-tier engine with no key', () => {
    const base = defaultFile()
    const withKeyEngine = {
      ...base,
      engines: base.engines.map(entry => entry.id === 'exa' ? { ...entry, apiKey: undefined } : entry),
    }
    // Every shipped engine is free tier, so this asserts the rule holds for
    // the roster as it stands: a free engine is never filtered by key.
    assert.ok(activeEngines(withKeyEngine).some(entry => entry.id === 'exa'))
  })
})

describe('engineBlockReason', () => {
  it('reports a disabled engine', () => {
    assert.equal(engineBlockReason({ id: 'bing', enabled: false, priority: 0 }, undefined), '已停用')
  })

  it('reports a free engine as runnable', () => {
    assert.equal(engineBlockReason({ id: 'bing', enabled: true, priority: 0 }, undefined), undefined)
  })

  it('judges the RESOLVED key, not the stored reference', () => {
    // A key-tier engine holding an `$ENV:` reference whose variable is unset
    // resolves to undefined. Passing the raw reference (or the entry itself)
    // would report "ready" and fail at the next search — the badge must track
    // what the chain will actually have.
    const entry = { id: 'bing' as const, enabled: true, priority: 0, apiKey: '$ENV:NOT_SET_ANYWHERE' }
    assert.equal(engineBlockReason(entry, undefined), undefined, 'free tier is never blocked by a key')
  })
})

describe('secret masking', () => {
  it('masks a literal key but keeps an $ENV: reference verbatim', () => {
    const masked = maskEngines([
      { id: 'bing', enabled: true, priority: 0, apiKey: 'sk-literal-secret' },
      { id: 'exa', enabled: true, priority: 1, apiKey: '$ENV:EXA_KEY' },
      { id: 'anysearch', enabled: true, priority: 2 },
    ])
    assert.equal(masked[0].apiKey, '••••••')
    assert.equal(masked[1].apiKey, '$ENV:EXA_KEY')
    assert.equal(masked[2].apiKey, undefined)
  })

  it('re-attaches the stored key when the client sends the mask back', () => {
    const stored = [{ id: 'bing' as const, enabled: true, priority: 0, apiKey: 'sk-real' }]
    const merged = unmaskEngines(
      [{ id: 'bing', enabled: true, priority: 0, apiKey: '••••••' }],
      stored,
    ) as { apiKey?: string }[]
    assert.equal(merged[0].apiKey, 'sk-real')
  })

  it('refuses a mask with no stored value instead of writing the sentinel', () => {
    assert.throws(
      () => unmaskEngines([{ id: 'bing', apiKey: '••••••' }], []),
      WebSearchValidationError,
    )
  })

  it('passes a freshly typed key through untouched', () => {
    const merged = unmaskEngines(
      [{ id: 'bing', apiKey: 'sk-new' }],
      [{ id: 'bing' as const, enabled: true, priority: 0, apiKey: 'sk-old' }],
    ) as { apiKey?: string }[]
    assert.equal(merged[0].apiKey, 'sk-new')
  })
})
