/**
 * Provider status computation: the settings page's 搜索来源 cards read
 * entirely from this, so its three states and their reasons are the contract
 * that keeps a user from selecting a source that cannot answer.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildProviderStatuses } from '../src/routes.ts'
import { BRAND_PROVIDER_ID, defaultFile, UPSTREAM_PROVIDER_ID, validateFile } from '../src/wire.ts'

const READY = { registered: true, usable: true }

describe('buildProviderStatuses', () => {
  it('reports the brand chain ready when an engine is enabled', () => {
    const [brand] = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, READY)
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
    const [brand] = buildProviderStatuses(file, true, BRAND_PROVIDER_ID, READY)
    assert.equal(brand.state, 'unavailable')
    assert.match(brand.reason ?? '', /没有启用的引擎/)
  })

  it('reports the brand chain unavailable when the seam is missing', () => {
    const [brand] = buildProviderStatuses(defaultFile(), false, BRAND_PROVIDER_ID, READY)
    assert.equal(brand.state, 'unavailable')
    assert.match(brand.reason ?? '', /ctx\.web/)
  })

  it('reports the brand chain unavailable when the plugin is disabled', () => {
    const [brand] = buildProviderStatuses(validateFile({ enabled: false }), true, BRAND_PROVIDER_ID, READY)
    assert.equal(brand.state, 'unavailable')
    assert.match(brand.reason ?? '', /整体停用/)
  })

  it('reports the upstream provider ready when registered and usable', () => {
    const [, upstream] = buildProviderStatuses(defaultFile(), true, UPSTREAM_PROVIDER_ID, READY)
    assert.equal(upstream.id, UPSTREAM_PROVIDER_ID)
    assert.equal(upstream.state, 'ready')
    assert.equal(upstream.selected, true)
  })

  it('distinguishes "not registered" from "registered but unusable"', () => {
    // The two upstream failure modes need different user actions: an
    // unregistered provider means the loader row is disabled (fix the patch
    // layer), while an unusable one usually means a missing key (fix the
    // credential). Collapsing them into one message would send the user to
    // the wrong place.
    const [, missing] = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, { registered: false, usable: false })
    assert.equal(missing.state, 'unavailable')
    assert.match(missing.reason ?? '', /未注册/)

    const [, unusable] = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, { registered: true, usable: false })
    assert.equal(unusable.state, 'unavailable')
    assert.match(unusable.reason ?? '', /已注册但不可用/)
  })

  it('reports unknown (never a false green) when the registry is unreadable', () => {
    const [, upstream] = buildProviderStatuses(defaultFile(), true, BRAND_PROVIDER_ID, undefined)
    assert.equal(upstream.state, 'unknown')
    assert.match(upstream.reason ?? '', /无法读取/)
  })

  it('marks exactly one provider selected', () => {
    for (const active of [BRAND_PROVIDER_ID, UPSTREAM_PROVIDER_ID]) {
      const statuses = buildProviderStatuses(defaultFile(), true, active, READY)
      assert.equal(statuses.filter(item => item.selected).length, 1)
      assert.equal(statuses.find(item => item.selected)?.id, active)
    }
  })
})
