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
import { DEFAULT_SOURCE_URLS, MAX_SOURCES } from '../src/catalog.ts'
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

  it('presets both default directories for a missing file (first run)', () => {
    assert.deepEqual(loadSources(path, () => {}), [...DEFAULT_SOURCE_URLS])
    assert.equal(DEFAULT_SOURCE_URLS.length, 2)
  })

  it('respects an existing empty list (no preset re-injection)', () => {
    saveSources(path, [])
    assert.deepEqual(loadSources(path, () => {}), [])
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
