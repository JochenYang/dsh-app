/**
 * The model bridge's plugin branch against the catalog cache: what it answers
 * when the cache is fresh, expired or absent, what it writes back, and what it
 * tells the model about the snapshot it searched.
 *
 * The measured defect this pins (2026-11-26, cache 84.5 hours old): the branch
 * called `resolveCatalog` with `refresh: false`, which answers from the cache
 * only while it is FRESH — past the TTL it fetched every source in place
 * (3,258 ms and 1,866 ms on two consecutive calls) and persisted nothing, so a
 * user who never opened the panel paid a full download on every search. The
 * panel, meanwhile, answered from the old snapshot and refreshed behind it.
 * One shape now serves both: a single-flight refresh the branch waits on for at
 * most {@link BRIDGE_REFRESH_WAIT_MS} and whose result — or the old snapshot —
 * is persisted.
 *
 * Everything here runs offline: `fetchSource` is injected through the deps and
 * the "slow" source is a timer, never a socket. `$DSH_HOME` points at a temp
 * directory so `readInstalled` reads no real profile.
 *
 * @module plugin-market/tests/market-bridge-refresh
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { searchPluginsBranch, runMarketSearch, type MarketToolDeps } from '../src/bridge.ts'
import { CATALOG_CACHE_TTL_MS } from '../src/routes.ts'
import type { CatalogEntry, SourceFetchResult } from '../src/catalog.ts'
import { CatalogHold } from '../src/install-intent.ts'
import { buildCatalogCache, loadCatalogCache, saveCatalogCache } from '../src/store.ts'

const URL_A = 'https://a.example.com/l'
const URL_B = 'https://b.example.com/l'

const entry = (pkg: string, name: string): CatalogEntry => ({ id: pkg, name, description: `${name} description`, package: pkg })
const okSource = (url: string, entries: readonly CatalogEntry[]): SourceFetchResult => ({ url, entries })
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Poll until the predicate holds; a suite that hangs is worse than one that fails. */
async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the expected cache write never happened')
    await delay(5)
  }
}

const STALE_ROW = entry('dsh-plugin-old', 'Old Plugin')
const FRESH_ROW = entry('dsh-plugin-new', 'New Plugin')

describe('searchPluginsBranch (cache, refresh and persistence)', () => {
  let dir: string
  let sourcesPath: string
  let cachePath: string
  let previousHome: string | undefined
  let lines: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-bridge-'))
    sourcesPath = join(dir, 'sources.json')
    cachePath = join(dir, 'catalog-cache.json')
    writeFileSync(sourcesPath, JSON.stringify({ sources: [URL_A] }), 'utf8')
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(dir, 'home')
    lines = []
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  })

  /** The deps one branch call needs; every case supplies its own fetch seam. */
  function depsOf(overrides: Partial<MarketToolDeps> = {}): MarketToolDeps {
    return {
      sourcesPath,
      catalogCachePath: cachePath,
      profile: 'no-such-profile',
      log: (message) => lines.push(message),
      ...overrides,
    }
  }

  /** An expired snapshot holding the old row, on disk. */
  function saveStaleCache(): number {
    const at = Date.now() - CATALOG_CACHE_TTL_MS - 3_600_000
    saveCatalogCache(cachePath, buildCatalogCache(at, [okSource(URL_A, [STALE_ROW])]))
    return at
  }

  it('answers from the old snapshot when the refresh outlasts the wait, then persists it', async () => {
    const staleAt = saveStaleCache()
    const calls: string[] = []
    const hold = new CatalogHold()
    const deps = depsOf({
      catalogHold: hold,
      refreshWaitMs: 20,
      fetchSource: async (url) => {
        calls.push(url)
        await delay(80)
        return okSource(url, [FRESH_ROW])
      },
    })

    const answer = await searchPluginsBranch(deps, 'plugin', 5)
    assert.deepEqual(answer.hits.map(hit => hit.id), [STALE_ROW.package])
    assert.equal(answer.notes?.length, 1)
    assert.match(answer.notes![0]!, /hours old/)
    assert.match(answer.notes![0]!, /do not claim the plugin does not exist/)
    assert.deepEqual(calls, [URL_A], 'the fetch is started, not skipped')
    // The hold names the build the model just saw: the old snapshot, not a
    // refresh that has not landed yet.
    assert.deepEqual(hold.current()?.entries.map(row => row.package), [STALE_ROW.package])

    // Behind the answer the refresh finishes and writes the new snapshot.
    await until(() => loadCatalogCache(cachePath, () => {})?.fetchedAt !== staleAt)
    const written = loadCatalogCache(cachePath, () => {})
    assert.deepEqual(written?.sources[URL_A]?.entries.map(row => row.package), [FRESH_ROW.package])
    assert.deepEqual(hold.current()?.entries.map(row => row.package), [FRESH_ROW.package])
  })

  it('shares one refresh between two concurrent searches', async () => {
    saveStaleCache()
    let fetches = 0
    const deps = depsOf({
      refreshWaitMs: 2_000,
      fetchSource: async (url) => {
        fetches += 1
        await delay(40)
        return okSource(url, [FRESH_ROW])
      },
    })

    const [first, second] = await Promise.all([
      searchPluginsBranch(deps, 'plugin', 5),
      searchPluginsBranch(deps, 'plugin', 5),
    ])
    assert.equal(fetches, 1, 'the second search joins the pass already running')
    assert.deepEqual(first.hits.map(hit => hit.id), [FRESH_ROW.package])
    assert.deepEqual(second.hits.map(hit => hit.id), [FRESH_ROW.package])
    assert.equal(first.notes?.length ?? 0, 0)
    assert.equal(second.notes?.length ?? 0, 0)
  })

  it('waits for the fetch when there is no cache at all, and persists it', async () => {
    // No cache file: there is nothing else to answer from, so the wait window
    // does not apply (refreshWaitMs: 1 must not turn a cold start into an empty
    // answer).
    const deps = depsOf({
      refreshWaitMs: 1,
      fetchSource: async (url) => {
        await delay(30)
        return okSource(url, [FRESH_ROW])
      },
    })
    const answer = await searchPluginsBranch(deps, 'plugin', 5)
    assert.deepEqual(answer.hits.map(hit => hit.id), [FRESH_ROW.package])
    assert.equal(answer.notes?.length ?? 0, 0)
    const written = loadCatalogCache(cachePath, () => {})
    assert.deepEqual(written?.sources[URL_A]?.entries.map(row => row.package), [FRESH_ROW.package])
  })

  it('does not touch the network once the refresh has landed', async () => {
    let fetches = 0
    const deps = depsOf({
      fetchSource: async (url) => {
        fetches += 1
        return okSource(url, [FRESH_ROW])
      },
    })
    await searchPluginsBranch(deps, 'plugin', 5) // cold: the one call that pays
    assert.equal(fetches, 1)
    const second = await searchPluginsBranch(deps, 'plugin', 5)
    assert.equal(fetches, 1, 'the persisted snapshot answers inside the TTL')
    assert.deepEqual(second.hits.map(hit => hit.id), [FRESH_ROW.package])
    assert.equal(lines.length, 0)
  })

  it('says so when the directory it searched is clipped', async () => {
    saveCatalogCache(cachePath, buildCatalogCache(Date.now(), [
      { url: URL_A, entries: [FRESH_ROW], truncated: { kept: 1, declared: 50_000 } },
    ]))
    const answer = await searchPluginsBranch(depsOf({
      fetchSource: async () => { throw new Error('a fresh cache must not fetch') },
    }), 'plugin', 5)
    assert.deepEqual(answer.hits.map(hit => hit.id), [FRESH_ROW.package])
    assert.equal(answer.notes?.length, 1)
    assert.match(answer.notes![0]!, /per-source entry cap/)
    assert.match(answer.notes![0]!, /does not exist/)
  })

  it('reports an unreadable source as a failure, so a miss does not read as absence', async () => {
    writeFileSync(sourcesPath, JSON.stringify({ sources: [URL_A, URL_B] }), 'utf8')
    const deps = depsOf({
      fetchSource: async (url): Promise<SourceFetchResult> => url === URL_A
        ? { url, reason: { code: 'catalog.httpStatus', params: { status: 503 }, text: 'HTTP 503' } }
        : okSource(url, [FRESH_ROW]),
    })
    const result = await runMarketSearch({
      query: 'a query nothing in the catalog matches',
      scope: 'plugins',
      limit: 5,
      searchSkills: async () => ({ hits: [] }),
      searchPlugins: (query, limit) => searchPluginsBranch(deps, query, limit),
    })
    assert.deepEqual(result.plugins, [])
    const row = result.failures.find(item => item.source === 'plugins')
    assert.notEqual(row, undefined, 'a source that could not be read is a failure row')
    assert.ok(row!.reason.includes(URL_A), 'the row names the source')
    assert.ok(row!.reason.includes('HTTP 503'), 'and carries its diagnostic')
    // The contract: "could not look" must not also read as "nothing matched".
    assert.equal(result.notes.some(note => note.includes('No plugin matched')), false)
  })

  it('reports a failed refresh honestly instead of claiming one is running', async () => {
    saveStaleCache()
    const deps = depsOf({
      refreshWaitMs: 2_000,
      fetchSource: async () => { throw new Error('getaddrinfo ENOTFOUND a.example.com') },
    })
    const result = await runMarketSearch({
      query: 'a query nothing in the catalog matches',
      scope: 'plugins',
      limit: 5,
      searchSkills: async () => ({ hits: [] }),
      searchPlugins: (query, limit) => searchPluginsBranch(deps, query, limit),
    })
    assert.deepEqual(result.plugins, [])
    // The note states the pass FAILED — "being refreshed" would be a promise
    // nothing is going to keep.
    assert.ok(result.notes.some(note => note.includes('refresh just failed')))
    assert.equal(result.notes.some(note => note.includes('being refreshed')), false)
    // And it is a failure row: the model must not read this as "nothing matched".
    const row = result.failures.find(item => item.source === 'plugins')
    assert.notEqual(row, undefined, 'a failed refresh is a failure, not an empty match')
    assert.ok(row!.reason.includes('refresh failed'))
    assert.equal(result.notes.some(note => note.includes('No plugin matched')), false)
    // The cause still reaches whoever reads the host log.
    assert.ok(lines.some(line => line.includes('background catalog refresh failed')))
  })

  it('adds no failure row when every source answered', async () => {
    const result = await runMarketSearch({
      query: 'plugin',
      scope: 'plugins',
      limit: 5,
      searchSkills: async () => ({ hits: [] }),
      searchPlugins: (query, limit) => searchPluginsBranch(
        depsOf({ fetchSource: async (url) => okSource(url, [FRESH_ROW]) }),
        query,
        limit,
      ),
    })
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.plugins.map(hit => hit.id), [FRESH_ROW.package])
  })
})
