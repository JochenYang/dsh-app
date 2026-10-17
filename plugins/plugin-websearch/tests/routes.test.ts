/**
 * Provider status computation: the settings page's 搜索来源 cards read
 * entirely from this, so its three states and their reasons are the contract
 * that keeps a user from selecting a source that cannot answer.
 *
 * The card LIST is the other half of that contract. It used to be two
 * hardcoded ids, which meant a provider the kernel mounted (0.2.1's
 * `deepseek-search-api`) could be the one actually answering while the page
 * never showed it — a page that hides the active choice cannot be trusted
 * about the others either.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildProviderStatuses } from '../src/routes.ts'
import { BRAND_PROVIDER_ID, defaultFile, UPSTREAM_PROVIDER_IDS, validateFile } from '../src/wire.ts'

const OFFICIAL = 'deepseek-official'
const SEARCH_API = 'deepseek-search-api'

/** A registry holding the suite's provider plus both DeepSeek routes. */
function registry(overrides: Record<string, boolean> = {}): Map<string, boolean> {
  return new Map<string, boolean>([
    [BRAND_PROVIDER_ID, true],
    [OFFICIAL, true],
    [SEARCH_API, true],
    ...Object.entries(overrides),
  ])
}

describe('buildProviderStatuses', () => {
  it('reports the brand chain ready when an engine is enabled', () => {
    const [brand] = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, registry())
    assert.equal(brand.id, BRAND_PROVIDER_ID)
    assert.equal(brand.state, 'ready')
    assert.equal(brand.selected, true)
    assert.equal(brand.reason, undefined)
  })

  it('reports the brand chain unavailable with no engines enabled', () => {
    const base = defaultFile()
    const file = validateFile({
      ...base,
      engines: base.engines.map(entry => ({ ...entry, enabled: false })),
    })
    const [brand] = buildProviderStatuses(file, true, BRAND_PROVIDER_ID, registry())
    assert.equal(brand.state, 'unavailable')
    assert.equal(brand.reason?.code, 'provider.noEngines')
  })

  it('reports the brand chain unavailable when the seam is missing', () => {
    const [brand] = buildProviderStatuses(defaultFile(), false, BRAND_PROVIDER_ID, registry())
    assert.equal(brand.state, 'unavailable')
    assert.equal(brand.reason?.code, 'provider.noSeam')
  })

  it('reports the brand chain unavailable when the plugin is disabled', () => {
    const [brand] = buildProviderStatuses(validateFile({ enabled: false }), true, BRAND_PROVIDER_ID, registry())
    assert.equal(brand.state, 'unavailable')
    assert.equal(brand.reason?.code, 'provider.disabled')
  })

  it('renders one card per expected DeepSeek provider, not just one', () => {
    const statuses = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, registry())
    assert.deepEqual(statuses.map(item => item.id), [BRAND_PROVIDER_ID, ...UPSTREAM_PROVIDER_IDS])
    assert.deepEqual(statuses.slice(1).map(item => item.state), ['ready', 'ready'])
  })

  it('marks the Search API provider selected when the seam resolves to it', () => {
    // 0.2.1's provider is the one a user may pick instead of the auxiliary
    // model-turn route; a card for it that never shows its selected state is
    // the exact bug this list exists to prevent.
    const statuses = buildProviderStatuses(defaultFile(), true, SEARCH_API, registry())
    const selected = statuses.filter(item => item.selected)
    assert.equal(selected.length, 1)
    assert.equal(selected[0]?.id, SEARCH_API)
    assert.equal(selected[0]?.state, 'ready')
  })

  it('keeps a card for an expected provider the registry does not hold', () => {
    // A disabled loader row must still be OFFERED, with the reason: dropping
    // the card silently would look like the provider no longer exists.
    const statuses = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, new Map([
      [BRAND_PROVIDER_ID, true],
      [OFFICIAL, true],
    ]))
    const api = statuses.find(item => item.id === SEARCH_API)
    assert.ok(api !== undefined)
    assert.equal(api.state, 'unavailable')
    assert.equal(api.reason?.code, 'provider.upstreamUnregistered')
  })

  it('distinguishes "not registered" from "registered but unusable"', () => {
    // The two failure modes need different user actions: an unregistered
    // provider means the loader row is disabled (fix the patch layer), while an
    // unusable one usually means a missing key (fix the credential). Collapsing
    // them into one message would send the user to the wrong place.
    const statuses = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, new Map([
      [BRAND_PROVIDER_ID, true],
      [SEARCH_API, false],
    ]))
    assert.equal(statuses.find(item => item.id === OFFICIAL)?.reason?.code, 'provider.upstreamUnregistered')
    assert.equal(statuses.find(item => item.id === SEARCH_API)?.reason?.code, 'provider.upstreamUnusable')
  })

  it('reports unknown (never a false green) when the registry is unreadable', () => {
    const statuses = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, undefined)
    assert.equal(statuses.length, 1 + UPSTREAM_PROVIDER_IDS.length)
    for (const status of statuses.slice(1)) {
      assert.equal(status.state, 'unknown')
      assert.equal(status.reason?.code, 'provider.upstreamUnknown')
    }
  })

  it('appends a provider nobody expected instead of hiding it', () => {
    // A third-party provider the model can resolve to is worth seeing, and it
    // must not duplicate the ids already rendered above it.
    const statuses = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, new Map([
      [BRAND_PROVIDER_ID, true],
      [OFFICIAL, true],
      [SEARCH_API, true],
      ['zeta-search', true],
      ['alpha-search', false],
    ]))
    assert.deepEqual(statuses.map(item => item.id), [BRAND_PROVIDER_ID, ...UPSTREAM_PROVIDER_IDS, 'alpha-search', 'zeta-search'])
    assert.equal(statuses.at(-1)?.state, 'ready')
    assert.equal(statuses.at(-2)?.state, 'unavailable')
  })

  it('marks exactly one provider selected', () => {
    for (const active of [BRAND_PROVIDER_ID, ...UPSTREAM_PROVIDER_IDS]) {
      const statuses = buildProviderStatuses(defaultFile(), true, active, registry())
      assert.equal(statuses.filter(item => item.selected).length, 1)
      assert.equal(statuses.find(item => item.selected)?.id, active)
    }
  })
})
