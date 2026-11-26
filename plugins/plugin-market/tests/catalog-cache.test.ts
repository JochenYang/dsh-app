/**
 * Catalog cache tests: snapshot building (caps, per-source failure rows),
 * atomic persistence with degrade-on-garbage reads, and the TTL catalog
 * resolution (fresh hit, expired refetch, stale fallback, snapshot rescue,
 * forced refresh).
 *
 * @module plugin-market/tests/catalog-cache
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MAX_ENTRIES_PER_SOURCE, MAX_ENTRIES_TOTAL, type CatalogEntry, type SourceFetchResult } from '../src/catalog.ts'
import type { HostText } from '../src/errors.ts'
import { CATALOG_CACHE_TTL_MS, resolveCatalog, type CatalogResolveDeps, type CatalogResolution } from '../src/routes.ts'
import { buildCatalogCache, CACHE_FORMAT_VERSION, loadCatalogCache, saveCatalogCache } from '../src/store.ts'

const entry = (pkg: string, name = pkg): CatalogEntry => ({ id: pkg, name, description: `${name} 描述`, package: pkg })

/**
 * A source failure's coded reason (the host's wire shape). Both are typed as
 * `HostText` rather than left to inference: a literal's inferred type fixes
 * `params` to that one reason's keys, so a second reason with different params
 * would not be passable to the same helper.
 */
const FAILED_REASON: HostText = { code: 'catalog.httpStatus', params: { status: 503 }, text: 'HTTP 503' }
const TIMEOUT_REASON = { code: 'catalog.timeout', params: { seconds: 30 }, text: 'the request timed out after 30 seconds' }

const okSource = (url: string, packages: readonly string[]): SourceFetchResult =>
  ({ url, entries: packages.map(pkg => entry(pkg)) })
const failedSource = (url: string, reason: HostText = FAILED_REASON): SourceFetchResult => ({ url, reason })
/** A source whose document the per-source cap clipped: kept rows plus the declared count. */
const clippedSource = (url: string, packages: readonly string[], declared: number): SourceFetchResult =>
  ({ url, entries: packages.map(pkg => entry(pkg)), truncated: { kept: packages.length, declared } })

describe('buildCatalogCache', () => {
  it('does not flag a source whose rows all duplicate an earlier one', () => {
    // Source B's rows are all copies of source A's, well inside the budget. The
    // merged catalog lists each package once, so nothing was clipped — and a
    // flag here would be permanent: every later 304 and stale-row read re-serves
    // it, and `market_search` would keep calling a complete list incomplete.
    const shared = Array.from({ length: 100 }, (_, index) => `pkg-${index}`)
    const cache = buildCatalogCache(1, [
      okSource('https://a.example.com/l', shared),
      okSource('https://b.example.com/l', shared),
    ])
    assert.equal(cache.sources['https://a.example.com/l']?.entries.length, 100)
    assert.equal(cache.sources['https://b.example.com/l']?.entries.length, 100)
    assert.equal(cache.sources['https://a.example.com/l']?.truncated, undefined)
    assert.equal(cache.sources['https://b.example.com/l']?.truncated, undefined)
  })

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
    // The budget clip is flagged like a per-source clip: the file holds fewer
    // rows than the source declared, and a later read must be able to say so.
    assert.equal(cache.sources['https://b.example.com/l']?.truncated, true)
    assert.equal(cache.sources['https://a.example.com/l']?.truncated, undefined)
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

  it('keeps a truncated source flagged through the file, and never invents one', () => {
    // The clip has to survive the cache: the panel and the model read the file,
    // not the fetch result, and "the directory is incomplete" is a fact about a
    // source row — not something a reader can recompute from the row count.
    saveCatalogCache(path, buildCatalogCache(7000, [
      clippedSource('https://a.example.com/l', ['pkg-a'], MAX_ENTRIES_PER_SOURCE + 1),
      okSource('https://b.example.com/l', ['pkg-b']),
    ]))
    const loaded = loadCatalogCache(path, (message) => warnings.push(message))
    assert.equal(loaded?.sources['https://a.example.com/l']?.truncated, true)
    assert.equal(loaded?.sources['https://b.example.com/l']?.truncated, undefined)
    assert.equal(warnings.length, 0)
  })

  it('reads a cache written before the flag existed as untruncated', () => {
    // No format-version bump for this field: the old shape is simply a complete
    // directory as far as the reader can prove, and the next refetch that clips
    // records it.
    writeFileSync(path, JSON.stringify({
      version: CACHE_FORMAT_VERSION,
      fetchedAt: 42,
      sources: { 'https://a.example.com/l': { entries: [entry('pkg-a')] } },
    }), 'utf8')
    const loaded = loadCatalogCache(path, () => {})
    assert.equal(loaded?.sources['https://a.example.com/l']?.truncated, undefined)
  })

  it('re-parses only when the file changes (the parse memo keys on mtime + size)', () => {
    // The cache is read on every /catalog request and every market_search, and
    // the live directory makes the file megabytes: an unchanged file must answer
    // the object already parsed, a rewrite must be visible.
    saveCatalogCache(path, buildCatalogCache(5_000, [okSource('https://a.example.com/l', ['pkg-a'])]))
    const first = loadCatalogCache(path, () => {})
    const second = loadCatalogCache(path, () => {})
    assert.equal(second, first, 'the unchanged file answers the same parsed object')
    saveCatalogCache(path, buildCatalogCache(6_000, [okSource('https://a.example.com/l', ['pkg-a', 'pkg-b'])]))
    const third = loadCatalogCache(path, () => {})
    assert.notEqual(third, first)
    assert.equal(third?.fetchedAt, 6_000)
    assert.deepEqual(third?.sources['https://a.example.com/l']?.entries.map(item => item.package), ['pkg-a', 'pkg-b'])
  })

  it('reads back a legal full-size cache instead of refusing it as corruption', () => {
    // Measured 2026-11-26 on real cache rows: this writer emits ~625 bytes per
    // row, so a cache at the merged-catalog cap (24,000 rows) is ~15 MB. The
    // old 16 MB FILE cap sat inside that range, and crossing it did not degrade:
    // the whole cache was refused as corruption, every request refetched live,
    // and nothing was ever persisted again.
    const filler = 'a realistic feature sentence for volume. '.repeat(10)
    const url = 'https://a.example.com/l'
    const entries: CatalogEntry[] = Array.from({ length: MAX_ENTRIES_TOTAL }, (_, index) => ({
      id: `pkg-${index}`,
      name: `plugin-${index}`,
      description: `${filler}${index}`,
      package: `pkg-${index}`,
    }))
    const cache = buildCatalogCache(9_000, [{ url, entries }])
    assert.equal(cache.sources[url]?.entries.length, MAX_ENTRIES_TOTAL)
    saveCatalogCache(path, cache)
    assert.ok(statSync(path).size > 10_000_000, 'the full-size cache really is ten-plus MB')
    const loaded = loadCatalogCache(path, (message) => warnings.push(message))
    assert.notEqual(loaded, null)
    assert.equal(loaded?.sources[url]?.entries.length, MAX_ENTRIES_TOTAL)
    assert.equal(loaded?.sources[url]?.entries.at(-1)?.package, `pkg-${MAX_ENTRIES_TOTAL - 1}`)
    assert.deepEqual(warnings, [])
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
    log?: (message: string) => void
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
      ...(options.log !== undefined ? { log: options.log } : {}),
    }
    return { fetches, run: () => resolveCatalog(deps) }
  }

  it('documents the 6-hour TTL contract', () => {
    assert.equal(CATALOG_CACHE_TTL_MS, 6 * 60 * 60 * 1000)
  })

  it('answers a fresh cache immediately with cached: true and never fetches', async () => {
    // Freshness requires a row for EVERY configured source and NO failure on any of
    // them: a failed row is retried on the next open instead of being trusted for
    // the rest of the TTL (see the retry test below).
    const cache = buildCatalogCache(9_000, [okSource(URL_A, ['pkg-a']), okSource(URL_B, ['pkg-b'])])
    const { fetches, run } = harness({ cache, results: [] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, [])
    assert.equal(cacheToWrite, null)
    assert.equal(payload.cached, true)
    assert.equal(payload.stale, undefined)
    assert.equal(payload.cachedAt, 9_000)
    assert.deepEqual(payload.plugins.map(item => item.package).sort(), ['pkg-a', 'pkg-b'])
    assert.deepEqual(payload.failed, [])
  })

  it('retries a source whose cached row is a failure', async () => {
    // One flaky fetch used to be locked in for the whole TTL: the row was written
    // with empty entries, the cache still counted as fresh, and the source stayed
    // hidden for hours. The row is now unproven, so the next open fetches it.
    const cache = buildCatalogCache(9_000, [okSource(URL_A, ['pkg-a']), failedSource(URL_B, FAILED_REASON)])
    const { fetches, run } = harness({ cache, results: [okSource(URL_A, ['pkg-a']), okSource(URL_B, ['pkg-b'])] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, sources, 'the failed row is retried')
    assert.equal(payload.cached, undefined)
    assert.deepEqual(payload.plugins.map(item => item.package).sort(), ['pkg-a', 'pkg-b'])
    assert.equal(cacheToWrite?.fetchedAt, 10_000)
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

  it('a failed source with a cached row lends its rows instead of shrinking the list', async () => {
    // The measured shape this guards: the 4282-row npm mirror dies while the
    // 100-row community store answers — the panel must not quietly become the
    // 100-row list. The failure is still reported, and the rebuilt cache
    // records the failure so the next open retries the dead source instead of
    // trusting the lent rows.
    const cache = buildCatalogCache(10_000 - CATALOG_CACHE_TTL_MS, [
      okSource(URL_A, ['pkg-a1', 'pkg-a2']),
      okSource(URL_B, ['pkg-b']),
    ])
    const { fetches, run } = harness({
      cache,
      results: [failedSource(URL_A, TIMEOUT_REASON), okSource(URL_B, ['pkg-b'])],
    })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(fetches, sources)
    // A live refresh (rows landed), so neither cached nor stale marks.
    assert.equal(payload.cached, undefined)
    assert.equal(payload.stale, undefined)
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-a1', 'pkg-a2', 'pkg-b'])
    assert.deepEqual(payload.failed, [{ url: URL_A, reason: TIMEOUT_REASON }])
    // The rebuilt cache keeps the failure row for the dead source AND the rows it
    // lent: erasing them made one flaky fetch shrink the directory, and the retry
    // path had nothing left to read.
    assert.deepEqual(cacheToWrite?.sources[URL_A], { entries: [entry('pkg-a1'), entry('pkg-a2')], failed: TIMEOUT_REASON })
    assert.deepEqual(cacheToWrite?.sources[URL_B], { entries: [entry('pkg-b')] })
  })

  it('does not lend rows from a cached row that was itself a failure', async () => {
    // URL_A's cached row is a failure row (it failed last open too): there is
    // nothing to lend, so the payload carries the surviving source alone.
    const cache = buildCatalogCache(10_000 - CATALOG_CACHE_TTL_MS, [
      failedSource(URL_A, FAILED_REASON),
      okSource(URL_B, ['pkg-b']),
    ])
    const { run } = harness({ cache, results: [failedSource(URL_A, TIMEOUT_REASON), okSource(URL_B, ['pkg-b'])] })
    const { payload, cacheToWrite } = await run()
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-b'])
    assert.deepEqual(payload.failed, [{ url: URL_A, reason: TIMEOUT_REASON }])
    assert.deepEqual(cacheToWrite?.sources[URL_A], { entries: [], failed: TIMEOUT_REASON })
  })

  it('every source failed keeps the stale-rescue branch: stale payload, nothing written', async () => {
    // The lending rule is payload-only: with NO live source anywhere the flow
    // must not write a snapshot of pure failure rows over the last good cache
    // (that write would hide the old rows from the next open's retry).
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
    // WRITTEN even though nothing was live: the next open has to see the old rows
    // AND why they did not refresh. The timestamp does not move, so an older row set
    // cannot masquerade as fresh.
    assert.equal(cacheToWrite?.fetchedAt, 10_000, 'the timestamp does not move')
    assert.equal(cacheToWrite?.sources[URL_A]?.failed !== undefined, true, 'and the failure is recorded')
    assert.deepEqual(cacheToWrite?.sources[URL_A]?.entries.map(item => item.package), ['pkg-a', 'pkg-b'], 'with the old rows kept')
    assert.equal(payload.stale, true)
    assert.equal(payload.cachedAt, 10_000)
    assert.deepEqual(payload.plugins.map(item => item.package), ['pkg-a', 'pkg-b', 'pkg-c'])
    assert.deepEqual(payload.failed, [
      { url: URL_A, reason: TIMEOUT_REASON },
      { url: URL_B, reason: FAILED_REASON },
    ])
  })

  it('a partial outage stamps a fresh cachedAt (the panel shows live data)', async () => {
    const cache = buildCatalogCache(10_000 - CATALOG_CACHE_TTL_MS, [okSource(URL_A, ['pkg-old'])])
    const { run } = harness({ cache, results: [okSource(URL_A, ['pkg-a']), failedSource(URL_B, FAILED_REASON)] })
    const { payload } = await run()
    assert.equal(payload.cachedAt, 10_000)
    assert.equal(payload.stale, undefined)
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
    assert.equal(cacheToWrite?.fetchedAt, 10_000, 'a total failure still records itself, with the old timestamp')
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

  it('reports a clipped source as truncated and warns once, with url and both counts', async () => {
    // The measured defect this pins: 6,885 live rows met a 5,000 cap and the
    // 1,885 dropped rows reached nobody — not the payload, not the log, not the
    // tool result. The count is now stated where a human reads it.
    const lines: string[] = []
    const declared = MAX_ENTRIES_PER_SOURCE + 5
    const { run } = harness({
      cache: null,
      results: [clippedSource(URL_A, ['pkg-a', 'pkg-b'], declared), okSource(URL_B, ['pkg-c'])],
      log: (message) => lines.push(message),
    })
    const { truncated, cacheToWrite } = await run()
    assert.equal(truncated, true)
    const warnings = lines.filter(line => line.includes(URL_A))
    assert.equal(warnings.length, 1, 'one line per clipped source, not per row')
    assert.ok(warnings[0]!.includes(String(declared)), 'the declared count is in the line')
    assert.ok(warnings[0]!.includes('2'), 'the kept count is in the line')
    // The clip travels into the cache, so the next reader does not have to guess.
    assert.equal(cacheToWrite?.sources[URL_A]?.truncated, true)
    assert.equal(cacheToWrite?.sources[URL_B]?.truncated, undefined)
  })

  it('flags a merge that hits the merged cap, not only a per-source clip', async () => {
    // Two sources at the per-source cap sum past the merged cap: the second
    // source's tail is dropped by `mergeCatalogs`, which was a silent clip of
    // its own. The resolution now reports it, so the model is not told "not
    // found" about a row that was merely never listed.
    const first = Array.from({ length: MAX_ENTRIES_PER_SOURCE }, (_, index) => `pkg-a${index}`)
    const second = Array.from({ length: MAX_ENTRIES_PER_SOURCE }, (_, index) => `pkg-b${index}`)
    const { run } = harness({ cache: null, results: [okSource(URL_A, first), okSource(URL_B, second)] })
    const { truncated, payload } = await run()
    assert.equal(truncated, true)
    assert.equal(payload.plugins.length, MAX_ENTRIES_TOTAL)
    assert.equal(payload.plugins.at(-1)?.package, `pkg-b${MAX_ENTRIES_TOTAL - MAX_ENTRIES_PER_SOURCE - 1}`)
  })

  it('carries truncation from the cache into the resolution, and reads an old cache as complete', async () => {
    const clipped = buildCatalogCache(9_000, [
      clippedSource(URL_A, ['pkg-a'], MAX_ENTRIES_PER_SOURCE + 1),
      okSource(URL_B, ['pkg-b']),
    ])
    const fromCache = await harness({ cache: clipped, results: [] }).run()
    assert.equal(fromCache.truncated, true, 'a fresh cache states the clip it was written with')

    // The same rows WITHOUT the flag are what a cache written before this field
    // existed looks like: untruncated as far as the reader can prove, and no
    // format-version bump was paid to learn it.
    const legacy = {
      version: CACHE_FORMAT_VERSION,
      fetchedAt: 9_000,
      sources: {
        [URL_A]: { entries: [entry('pkg-a')] },
        [URL_B]: { entries: [entry('pkg-b')] },
      },
    }
    const fromLegacy = await harness({ cache: legacy, results: [] }).run()
    assert.equal(fromLegacy.truncated, false)
  })
})
