// Provider naming, hint and price facts.
//
// The host reports whatever the kernel's registry holds, so this module is the
// only place that decides what a card is CALLED, what choosing it does, and
// what it costs. Three failures it pins: a provider the host reports under an
// unknown id must still render (as its raw id, not an empty label); the two
// DeepSeek routes must not share one description (that is what made them read
// as duplicate cards); and the date-based price belongs to the Search API
// alone — the model-retrieval route spends tokens and has no per-call price.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { en, zh } from '../src/client/locales.ts'
import { PROVIDER_HINT_KEYS, PROVIDER_KEYS, PROVIDER_PRICE_KEYS, providerLabel } from '../src/client/providers.ts'
import { BRAND_PROVIDER_ID, UPSTREAM_PROVIDER_IDS } from '../src/wire.ts'

const OFFICIAL = 'deepseek-official'
const SEARCH_API = 'deepseek-search-api'

const makeT = (dict: Record<string, string>) => (key: string) => dict[key] ?? key

describe('provider labels', () => {
  it('names the brand chain and every DeepSeek route the line mounts', () => {
    for (const id of [BRAND_PROVIDER_ID, ...UPSTREAM_PROVIDER_IDS]) {
      assert.ok(PROVIDER_KEYS[id] !== undefined, `${id} has no dictionary key`)
    }
  })

  it('has copy for every mapped key in both locales', () => {
    const keys = [...Object.values(PROVIDER_KEYS), ...Object.values(PROVIDER_HINT_KEYS), ...Object.values(PROVIDER_PRICE_KEYS)]
    for (const key of keys) {
      assert.equal(typeof zh[key], 'string', `zh is missing ${key}`)
      assert.equal(typeof en[key], 'string', `en is missing ${key}`)
    }
  })

  it('renders an unknown provider under its raw id', () => {
    // A third-party provider the kernel mounts is worth showing; a blank label
    // would look like a rendering bug.
    assert.equal(providerLabel('someone-elses-provider', makeT(zh)), 'someone-elses-provider')
  })

  it('describes the two DeepSeek routes differently', () => {
    assert.ok(PROVIDER_HINT_KEYS[OFFICIAL] !== PROVIDER_HINT_KEYS[SEARCH_API])
    assert.ok(zh[PROVIDER_HINT_KEYS[OFFICIAL]] !== zh[PROVIDER_HINT_KEYS[SEARCH_API]])
  })

  it('charges each payable route its own way, and the brand chain none', () => {
    assert.equal(PROVIDER_PRICE_KEYS[BRAND_PROVIDER_ID], undefined)
    assert.ok(PROVIDER_PRICE_KEYS[OFFICIAL] !== undefined)
    assert.ok(PROVIDER_PRICE_KEYS[SEARCH_API] !== undefined)
    // Only the Search API sentence carries the 2026-11-01 price; the model
    // route must not claim a date it never had.
    assert.match(zh[PROVIDER_PRICE_KEYS[SEARCH_API]], /2026-11-01/u)
    assert.doesNotMatch(zh[PROVIDER_PRICE_KEYS[OFFICIAL]], /2026-11-01/u)
  })
})
