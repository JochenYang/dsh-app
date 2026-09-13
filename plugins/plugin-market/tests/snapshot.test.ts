/**
 * Offline snapshot tests: the builder's selection/truncation rules (top-by-
 * stars, description cap, aggregated-schema shape that reuses the catalog
 * parser) and the committed snapshot asset itself (parses into a meaningful
 * fallback catalog).
 *
 * @module plugin-market/tests/snapshot
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  SNAPSHOT_DESCRIPTION_CAP,
  SNAPSHOT_ENTRY_LIMIT,
  buildSnapshotDocument,
  truncateForSnapshot,
} from '../src/snapshot-builder.ts'
import { loadSnapshot } from '../src/snapshot.ts'

/** One aggregated-schema source row (the shape the awesome preset serves). */
const sourceEntry = (name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  owner: `owner-${name.toLowerCase()}`,
  url: `https://github.com/owner/${name}`,
  page: `https://dir.example.com/p/owner/${name}/`,
  category: 'tools',
  description: { zh: `${name} 的功能描述。` },
  npm: `pkg-${name.toLowerCase()}`,
  stars: 10,
  ...overrides,
})

describe('buildSnapshotDocument', () => {
  it('ranks by stars descending and keeps only named+described rows', () => {
    const plugins = [
      sourceEntry('Low', { stars: 1 }),
      sourceEntry('High', { stars: 99 }),
      sourceEntry('NoStars', { stars: null }),
      sourceEntry('NoDesc', { description: { zh: '' } }),
      sourceEntry('Mid', { stars: 50 }),
    ]
    const document = buildSnapshotDocument({ categories: {}, plugins }, { now: () => new Date(0) })
    // Star order: High, Mid, Low, then the starless row; the undescribed row
    // is dropped (an offline card without copy carries no value).
    assert.deepEqual(document.plugins.map(entry => entry.name), ['High', 'Mid', 'Low', 'NoStars'])
    assert.equal(document.generatedAt, '1970-01-01T00:00:00.000Z')
  })

  it('caps the row count at the entry limit', () => {
    const plugins = Array.from({ length: SNAPSHOT_ENTRY_LIMIT + 5 }, (_, index) => sourceEntry(`Filler${index}`))
    const document = buildSnapshotDocument({ categories: {}, plugins })
    assert.equal(document.plugins.length, SNAPSHOT_ENTRY_LIMIT)
  })

  it('truncates descriptions to the cap and emits the aggregated row shape', () => {
    const document = buildSnapshotDocument({
      categories: {},
      plugins: [sourceEntry('Alpha', { description: { zh: '长'.repeat(SNAPSHOT_DESCRIPTION_CAP + 40) } })],
    }, { now: () => new Date(0) })
    const row = document.plugins[0]!
    assert.equal(row.description.length, SNAPSHOT_DESCRIPTION_CAP)
    assert.equal(row.description.endsWith('…'), true)
    // The shape must re-parse as an aggregated document: category key present,
    // npm identity on installable rows, page as the stable id.
    assert.deepEqual(row, {
      name: 'Alpha',
      owner: 'owner-alpha',
      url: 'https://github.com/owner/Alpha',
      page: 'https://dir.example.com/p/owner/Alpha/',
      category: 'tools',
      categoryId: 'tools',
      description: row.description,
      npm: 'pkg-alpha',
      installable: true,
      stars: 10,
    })
  })

  it('keeps npm-less rows browsable as source-only entries with an explicit category key', () => {
    const document = buildSnapshotDocument({
      categories: {},
      plugins: [sourceEntry('SourceOnly', { npm: null, category: undefined })],
    })
    const row = document.plugins[0]!
    assert.equal(row.installable, false)
    assert.equal(row.npm, undefined)
    // An uncategorized first row must not make the snapshot sniff as a
    // custom-schema document (which would drop every row).
    assert.equal(row.category, '')
  })
})

describe('truncateForSnapshot', () => {
  it('keeps short text verbatim and caps long text with an ellipsis', () => {
    assert.equal(truncateForSnapshot('short', 10), 'short')
    assert.equal(truncateForSnapshot('x'.repeat(11), 10).length, 10)
    assert.equal(truncateForSnapshot('x'.repeat(11), 10).endsWith('…'), true)
  })
})

describe('committed snapshot asset', () => {
  it('parses into a meaningful offline fallback catalog', () => {
    const snapshot = loadSnapshot()
    assert.ok(snapshot !== null)
    // The generator pins the top-500 slice; a regression below a usable
    // catalog (or above the entry cap) must fail loudly.
    assert.ok(snapshot.entries.length >= 100, `snapshot too small: ${snapshot.entries.length}`)
    assert.ok(snapshot.entries.length <= SNAPSHOT_ENTRY_LIMIT)
    assert.equal(snapshot.entries.every(entry => entry.name !== '' && entry.description !== ''), true)
    assert.ok(snapshot.entries.some(entry => entry.installable !== false), 'snapshot lost every installable row')
    assert.ok(typeof snapshot.snapshotAt === 'string' && snapshot.snapshotAt !== '')
  })
})
