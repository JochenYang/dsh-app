/**
 * Catalog cache tests: snapshot building (caps, per-source failure rows),
 * atomic persistence with degrade-on-garbage reads, and the TTL catalog
 * resolution (fresh hit, expired refetch, stale fallback, snapshot rescue,
 * forced refresh).
 *
 * @module plugin-market/tests/catalog-cache
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MAX_ENTRIES_TOTAL, type CatalogEntry, type SourceFetchResult } from '../src/catalog.ts'
import { CATALOG_CACHE_TTL_MS, resolveCatalog, type CatalogResolveDeps, type CatalogResolution } from '../src/routes.ts'
import { buildCatalogCache, CACHE_FORMAT_VERSION, loadCatalogCache, saveCatalogCache } from '../src/store.ts'

const entry = (pkg: string, name = pkg): CatalogEntry => ({ id: pkg, name, description: `${name} 描述`, package: pkg })

/** A source failure's coded reason (the host's wire shape). */
const FAILED_REASON = { code: 'catalog.httpStatus', params: { status: 503 }, text: 'HTTP 503' }
const TIMEOUT_REASON = { code: 'catalog.timeout', params: { seconds: 30 }, text: 'the request timed out after 30 seconds' }

const okSource = (url: string, packages: readonly string[]): SourceFetchResult =>
  ({ url, entries: packages.map(pkg => entry(pkg)) })
const failedSource = (url: string, reason = FAILED_REASON): SourceFetchResult => ({ url, reason })

describe('buildCatalogCache', () => {
  it('keeps entry lists and per-source failure rows side by side', () => {
    const cache = buildCatalogCache(1000, [
      okSource('https://a.example.com/l', ['pkg-a1', 'pkg-a2']),
      failedSource('https://b.example.com/l', TIMEOUT_REASON),
    ])
    assert.equal(cache.fetchedAt, 1000)
    assert.deepEqual(cache.sources['https://a.example.com/l'], { entries: [entry('pkg-a1'), entry('pkg-a2')] })
    assert.deepEqual(cache.sources['https://b.example.com/l'], { entries: [], failed: TIMEOUT_REASON })
  })

  it('caps the snapshot at the merged-catalog total', () => {
    const first = Array.from({ length: MAX_ENTRIES_TOTAL - 10 }, (_, index) => `pkg-a${index}`)
    const second = Array.from({ length: 100 }, (_, index) => `pkg-b${index}`)
    const cache = buildCatalogCache(1, [
      okSource('https://a.example.com/l', first),
      okSource('https://b.example.com/l', second),
    ])
    assert.equal(cache.sources['https://a.example.com/l']?.entries.length, MAX_ENTRIES_TOTAL - 10)
    assert.equal(cache.sources['https://b.example.com/l']?.entries.length, 10)
  })
})

describe('catalog cache persistence', () => {
  let dir: string
  let path: string
  let warnings: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-cache-'))
    path = join(dir, 'catalog-cache.json')
    warnings = []
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips a snapshot through tmp+rename with no residue', () => {
    const cache = buildCatalogCache(5000, [
      okSource('https://a.example.com/l', ['pkg-a']),
      failedSource('https://b.example.com/l'),
    ])
    saveCatalogCache(path, cache)
    const listing = JSON.parse(readFileSync(path, 'utf8')) as { version: number, fetchedAt: number }
    assert.equal(listing.version, CACHE_FORMAT_VERSION)
    assert.equal(listing.fetchedAt, 5000)
    const loaded = loadCatalogCache(path, (message) => warnings.push(message))
    assert.equal(loaded?.version, CACHE_FORMAT_VERSION)
    assert.equal(loaded?.fetchedAt, 5000)
    assert.deepEqual(loaded?.sources['https://a.example.com/l'], { entries: [entry('pkg-a')] })
    assert.equal(warnings.length, 0)
  })

  it('answers null for a cache written by an older format', () => {
    // The pre-versioning shape (no `version`) carried raw category ids as
    // labels; reading it must fall through to a live rebuild, never render it.
    writeFileSync(path, JSON.stringify({
      fetchedAt: 42,
      sources: { 'https://a.example.com/l': { entries: [entry('pkg-a')] } },
    }), 'utf8')
    assert.equal(loadCatalogCache(path, () => {}), null)
    // A versioned-but-stale format invalidates itself the same way, so a
    // downgrade from a newer build cannot poison the panel either.
    writeFileSync(path, JSON.stringify({
      version: CACHE_FORMAT_VERSION - 1,
      fetchedAt: 42,
      sources: { 'https://a.example.com/l': { entries: [entry('pkg-a')] } },
    }), 'utf8')
    assert.equal(loadCatalogCache(path, (message) => warnings.push(message)), null)
    assert.ok(warnings.length > 0)
  })

  it('answers null for a missing file (first run)', () => {
    assert.equal(loadCatalogCache(path, () => {}), null)
  })

  it('degrades garbage files to null without throwing', () => {
    writeFileSync(path, '{ not json', 'utf8')
    assert.equal(loadCatalogCache(path, (message) => warnings.push(message)), null)
    writeFileSync(path, JSON.stringify([1, 2]), 'utf8')
    assert.equal(loadCatalogCache(path, () => {}), null)
    writeFileSync(path, JSON.stringify({ fetchedAt: 'nope', sources: {} }), 'utf8')
    assert.equal(loadCatalogCache(path, (message) => warnings.push(message)), null)
    writeFileSync(path, JSON.stringify({ fetchedAt: 1, sources: 'nope' }), 'utf8')
    assert.equal(loadCatalogCache(path, () => {}), null)
    assert.ok(warnings.length > 0)
  })

  it('drops unusable rows and entries instead of failing the whole snapshot', () => {
    writeFileSync(path, JSON.stringify({
      version: CACHE_FORMAT_VERSION,
      fetchedAt: 42,
      sources: {
        'https://a.example.com/l': { entries: [entry('pkg-a'), { name: 'broken' }, null] },
        'https://b.example.com/l': { entries: [] },
        'https://c.example.com/l': { entries: [], failed: FAILED_REASON },
        'https://d.example.com/l': 'garbage',
      },
    }), 'utf8')
    const loaded = loadCatalogCache(path, () => {})
    assert.equal(loaded?.fetchedAt, 42)
    assert.deepEqual(Object.keys(loaded?.sources ?? {}), ['https://a.example.com/l', 'https://c.example.com/l'])
    assert.deepEqual(loaded?.sources['https://a.example.com/l'], { entries: [entry('pkg-a')] })
    assert.deepEqual(loaded?.sources['https://c.example.com/l'], { entries: [], failed: FAILED_REASON })
  })
})

describe('resolveCatalog (TTL cache flow)', () => {
  const URL_A = 'https://a.example.com/l'
  const URL_B = 'https://b.example.com/l'
  const sources = [URL_A, URL_B]

  /** Drive resolveCatalog with in-memory fakes; fetches are recorded. */
  function harness(options: {
    cache?: ReturnType<typeof buildCatalogCache> | null
    results?: SourceFetchResult[]
    snapshot?: { entries: readonly CatalogEntry[], snapshotAt?: string } | null
    now?: () => number
    refresh?: boolean
    sources?: readonly string[]
  }): { fetches: string[], run: () => Promise<CatalogResolution> } {
    const fetches: string[] = []
    const deps: CatalogResolveDeps = {
      sources: options.sources ?? sources,
      refresh: options.refresh ?? false,
      fetchSource: async (url) => {
        fetches.push(url)
        const result = options.results?.find(item => item.url === url)
        if (result === undefined) throw new Error(`no scripted result for ${url}`)
        return result
      },
      readCache: () => options.cache ?? null,
      loadSnapshot: () => options.snapshot ?? null,
      now: options.now ?? (() => 10_000),
    }
    return { fetches, run: () => resolveCatalog(deps) }
  }

  it('documents the 6-hour TTL contract', () => {
    assert.equal(CATALOG_CACHE_TTL_MS, 6 * 60 * 60 * 1000)
  })

  it('answers a fresh cache immediately with cached: true and never fetches', async () => {
    // Freshness requires a row for EVERY configured source (URL_B's failure
    // row counts) — a partial snapshot must never pose as complete.
    const cache = buildCatalogCache(9_000, [okSource(URL_A, ['pkg-a']), failedSource(URL_B, FAILED_REASON)])
    const { fetches, run } = harness({ cache, results: [] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, [])
    assert.equal(cacheToWrite, null)
    assert.equal(payload.cached, true)
    assert.equal(payload.stale, undefined)
    assert.equal(payload.cachedAt, 9_000)
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-a'])
    // The cached failure row keeps the source's last error visible.
    assert.deepEqual(payload.failed, [{ url: URL_B, reason: FAILED_REASON }])
  })

  it('treats a cache that misses a configured source as expired', async () => {
    // URL_B was configured after the snapshot: the cache must not masquerade
    // as complete for the rest of its TTL window.
    const cache = buildCatalogCache(9_000, [okSource(URL_A, ['pkg-a'])])
    const { fetches, run } = harness({ cache, results: [okSource(URL_A, ['pkg-a2']), okSource(URL_B, ['pkg-b'])] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, sources)
    assert.equal(payload.cached, undefined)
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-a2', 'pkg-b'])
    assert.equal(cacheToWrite?.fetchedAt, 10_000)
  })

  it('refetches an expired cache, serves fresh, and persists the new snapshot', async () => {
    const cache = buildCatalogCache(10_000 - CATALOG_CACHE_TTL_MS, [okSource(URL_A, ['pkg-old'])])
    const { fetches, run } = harness({ cache, results: [okSource(URL_A, ['pkg-a']), failedSource(URL_B, FAILED_REASON)] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, sources)
    assert.equal(payload.stale, undefined)
    assert.equal(payload.cachedAt, 10_000)
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-a'])
    assert.deepEqual(payload.failed, [{ url: URL_B, reason: FAILED_REASON }])
    // The failed source keeps a row in the written cache so the failure stays
    // visible on the next cache hit.
    assert.deepEqual(cacheToWrite?.sources[URL_B], { entries: [], failed: FAILED_REASON })
    assert.deepEqual(cacheToWrite?.sources[URL_A], { entries: [entry('pkg-a')] })
  })

  it('falls back to the stale cache when every source fails', async () => {
    // The cache is expired (beyond the TTL) — exactly the "stale rescue" case.
    const cache = buildCatalogCache(10_000, [
      okSource(URL_A, ['pkg-a', 'pkg-b']),
      okSource(URL_B, ['pkg-c']),
    ])
    const { fetches, run } = harness({
      cache,
      now: () => 10_000 + CATALOG_CACHE_TTL_MS + 1,
      results: [failedSource(URL_A, TIMEOUT_REASON), failedSource(URL_B, FAILED_REASON)],
    })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, sources)
    assert.equal(cacheToWrite, null)
    assert.equal(payload.stale, true)
    assert.equal(payload.cached, undefined)
    assert.equal(payload.cachedAt, 10_000)
    // The rescue carries the CURRENT failure reasons, not the cached ones.
    assert.deepEqual(payload.failed, [
      { url: URL_A, reason: TIMEOUT_REASON },
      { url: URL_B, reason: FAILED_REASON },
    ])
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-a', 'pkg-b', 'pkg-c'])
  })

  it('renders the bundled snapshot when every source fails and no cache exists', async () => {
    const snapshot = { entries: [entry('snap-a'), entry('snap-b')], snapshotAt: '2026-09-01T00:00:00.000Z' }
    const { run } = harness({ cache: null, results: [failedSource(URL_A), failedSource(URL_B)], snapshot })
    const { payload, cacheToWrite } = await run()
    assert.equal(cacheToWrite, null)
    assert.equal(payload.snapshot, true)
    assert.equal(payload.snapshotAt, '2026-09-01T00:00:00.000Z')
    assert.equal(payload.stale, undefined)
    assert.deepEqual(payload.plugins.map(item => item.package), ['snap-a', 'snap-b'])
    assert.equal(payload.failed.length, 2)
  })

  it('answers an empty failure payload when there is neither cache nor snapshot', async () => {
    const { run } = harness({ cache: null, results: [failedSource(URL_A), failedSource(URL_B)], snapshot: null })
    const { payload, cacheToWrite } = await run()
    assert.equal(cacheToWrite, null)
    assert.deepEqual(payload.plugins, [])
    assert.equal(payload.failed.length, 2)
    assert.equal(payload.snapshot, undefined)
  })

  it('skips the fresh cache on a forced refresh (?refresh=1)', async () => {
    const cache = buildCatalogCache(9_000, [okSource(URL_A, ['pkg-cached'])])
    const { fetches, run } = harness({
      cache,
      refresh: true,
      results: [okSource(URL_A, ['pkg-live']), okSource(URL_B, ['pkg-live-b'])],
    })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, sources)
    assert.equal(payload.cached, undefined)
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-live', 'pkg-live-b'])
    assert.equal(cacheToWrite?.fetchedAt, 10_000)
  })

  it('answers an empty payload without fetching when no sources are configured', async () => {
    const { fetches, run } = harness({ sources: [], cache: null, results: [] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, [])
    assert.deepEqual(payload.plugins, [])
    assert.deepEqual(payload.failed, [])
    assert.equal(cacheToWrite, null)
  })
})
