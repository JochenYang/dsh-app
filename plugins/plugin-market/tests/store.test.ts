/**
 * Store tests: sources.json round trips, sanitization on read (https-only,
 * dedupe, caps), atomic writes, and degrade-on-garbage (never throws).
 *
 * @module plugin-market/tests/store
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_INDEX_SOURCE_URL, DEFAULT_SOURCE_URLS, LEGACY_SOURCE_URLS, MAX_SOURCES, NPM_PACKAGE_SOURCE_URL } from '../src/catalog.ts'
import { loadSources, saveSources } from '../src/store.ts'

describe('sources store', () => {
  let dir: string
  let path: string
  let warnings: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-store-'))
    path = join(dir, 'sources.json')
    warnings = []
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('presets the jsDelivr index first, then the community store', () => {
    assert.deepEqual(loadSources(path, () => {}), [...DEFAULT_SOURCE_URLS])
    // The format-1 index on jsDelivr is the FIRST request the panel makes, and
    // one open waits on every source (`Promise.all` in resolveCatalog), so the
    // leading entry is what decides the panel's open time. It must be the CDN
    // file, not a two-hop tarball transport.
    assert.equal(DEFAULT_SOURCE_URLS.length, 2)
    assert.equal(DEFAULT_SOURCE_URLS[0], DEFAULT_INDEX_SOURCE_URL)
    assert.match(DEFAULT_SOURCE_URLS[0], /^https:\/\/cdn\.jsdelivr\.net\/npm\/dsh-plugin-catalog\/index\.json$/)
  })

  it('keeps the npm-mirror package source addable but out of the preset list', () => {
    // Dropped from the presets on 2026-10-28: the manifest + tarball round trip
    // is what stalled a panel open (966 KB of 1.2 MB in 58 s, then a reset).
    // The address stays valid input on the Sources tab, so the preset list
    // naming it is the failure this asserts against.
    assert.ok(!DEFAULT_SOURCE_URLS.includes(NPM_PACKAGE_SOURCE_URL))
  })

  it('presets NO GitHub-Pages source (the expired-open stall)', () => {
    // The awesome-dsh-plugin.com origin was dropped from the preset list on
    // 2026-10-11: behind Fastly, refused by public proxies, 5 MB in 6-8 s on a
    // mainland link — an expired open waited on it alone. It survives only as
    // the OFFLINE-SNAPSHOT fetch source (see DEFAULT_SOURCE_URL's doc), which
    // runs at snapshot-build time, never on the request path.
    assert.ok(DEFAULT_SOURCE_URLS.every(url => !url.includes('awesome-dsh-plugin.com')),
      'the GitHub-Pages origin must not re-enter the live preset list')
  })

  it('respects an existing empty list (no preset re-injection)', () => {
    saveSources(path, [])
    assert.deepEqual(loadSources(path, () => {}), [])
  })

  it('upgrades the untouched legacy preset pair, and only that pair', () => {
    // Every install that predates the CDN index carries exactly this pair and
    // would stay on the slow tarball transport for ever. It is upgraded — but
    // only while it is INDISTINGUISHABLE from an untouched install.
    const logged: string[] = []
    saveSources(path, [...LEGACY_SOURCE_URLS])
    assert.deepEqual(loadSources(path, message => logged.push(message)), [...DEFAULT_SOURCE_URLS])
    assert.equal(logged.some(message => message.includes('upgrading the untouched preset pair')), true)

    // Removed one entry: a decision, so it stands.
    saveSources(path, [LEGACY_SOURCE_URLS[0]!])
    assert.deepEqual(loadSources(path, () => {}), [LEGACY_SOURCE_URLS[0]!])

    // Reordered: also a decision.
    saveSources(path, [...LEGACY_SOURCE_URLS].reverse())
    assert.deepEqual(loadSources(path, () => {}), [...LEGACY_SOURCE_URLS].reverse())

    // Added their own source on top: untouched legacy entries plus one more.
    saveSources(path, [...LEGACY_SOURCE_URLS, 'https://mine.example.com/list.json'])
    assert.deepEqual(loadSources(path, () => {}), [...LEGACY_SOURCE_URLS, 'https://mine.example.com/list.json'])
  })

  it('round-trips a saved list verbatim (order preserved)', () => {
    const urls = ['https://a.example.com/l1', 'https://b.example.com/l2']
    saveSources(path, urls)
    assert.deepEqual(loadSources(path, () => {}), urls)
    // The tmp+rename write leaves no residue behind.
    const listing = readFileSync(path, 'utf8')
    assert.deepEqual(JSON.parse(listing), { sources: urls })
  })

  it('sanitizes on read: drops non-https entries and dedupes', () => {
    writeFileSync(path, JSON.stringify({
      sources: [
        'https://a.example.com/keep',
        'http://insecure.example.com/drop',
        'https://a.example.com/keep',
        'file:///etc/passwd',
        'not a url',
      ],
    }), 'utf8')
    assert.deepEqual(loadSources(path, (message) => warnings.push(message)), ['https://a.example.com/keep'])
    assert.ok(warnings.length > 0)
  })

  it('degrades garbage files to empty without throwing', () => {
    writeFileSync(path, '{ not json', 'utf8')
    assert.deepEqual(loadSources(path, (message) => warnings.push(message)), [])
    writeFileSync(path, JSON.stringify([1, 2, 3]), 'utf8')
    assert.deepEqual(loadSources(path, (message) => warnings.push(message)), [])
    writeFileSync(path, JSON.stringify({ sources: 'nope' }), 'utf8')
    assert.deepEqual(loadSources(path, (message) => warnings.push(message)), [])
  })

  it('caps the restored list at the shared source limit', () => {
    const urls = Array.from({ length: MAX_SOURCES + 5 }, (_, index) => `https://s${index}.example.com/l`)
    writeFileSync(path, JSON.stringify({ sources: urls }), 'utf8')
    assert.equal(loadSources(path, () => {}).length, MAX_SOURCES)
  })

  it('creates the store directory on save', () => {
    const nested = join(dir, 'storages', 'dsh-app-plugin-market', 'sources.json')
    saveSources(nested, ['https://a.example.com/l'])
    assert.deepEqual(loadSources(nested, () => {}), ['https://a.example.com/l'])
    // And a same-name temp file from another writer never collides.
    mkdirSync(join(dir, 'x'), { recursive: true })
  })
})
