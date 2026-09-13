/**
 * Catalog-filter tests: the category dropdown options (stable key, first-seen
 * order, per-category count) and the search match — name, description, and
 * the author handle at equal weight, so an owner search finds the plugins.
 *
 * @module plugin-market/tests/catalog-filter
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { categoryKeyOf, categoryOptionsOf, entryMatchesQuery, type FilterableEntry } from '../src/client/catalog-filter.ts'

/** One row with the label always resolved (the panel never sees raw ids alone). */
const row = (overrides: Partial<FilterableEntry>): FilterableEntry => ({
  name: 'row',
  description: 'a plugin',
  ...overrides,
})

describe('categoryOptionsOf', () => {
  it('keys options on categoryId and counts rows per category', () => {
    const entries = [
      row({ category: '工具与能力', categoryId: 'tools' }),
      row({ category: '工具与能力', categoryId: 'tools' }),
      row({ category: '界面', categoryId: 'ui' }),
    ]
    assert.deepEqual(categoryOptionsOf(entries), [
      { key: 'tools', label: '工具与能力', count: 2 },
      { key: 'ui', label: '界面', count: 1 },
    ])
  })

  it('falls back to the label as the key when a legacy row carries no categoryId', () => {
    // Cache/snapshot rows persisted before the id existed: the label is both
    // display and filter key, so the dropdown still filters correctly.
    const entries = [row({ category: 'memory' }), row({ category: 'memory' }), row({ category: 'docs' })]
    assert.deepEqual(categoryOptionsOf(entries), [
      { key: 'memory', label: 'memory', count: 2 },
      { key: 'docs', label: 'docs', count: 1 },
    ])
    assert.equal(categoryKeyOf(row({ category: 'memory' })), 'memory')
  })

  it('keeps first-seen order and skips uncategorized rows', () => {
    const entries = [
      row({ category: '界面', categoryId: 'ui' }),
      row({ name: 'no-cat' }),
      row({ category: '工具与能力', categoryId: 'tools' }),
      row({ category: '界面', categoryId: 'ui' }),
    ]
    assert.deepEqual(categoryOptionsOf(entries).map(option => option.key), ['ui', 'tools'])
  })

  it('answers empty for a catalog without categories', () => {
    assert.deepEqual(categoryOptionsOf([row({ name: 'plain' })]), [])
  })
})

describe('entryMatchesQuery', () => {
  const entry = row({
    name: 'DeepSeek Memory',
    description: '长期记忆与上下文注入',
    owner: 'volcengine',
  })

  it('matches the name case-insensitively', () => {
    assert.equal(entryMatchesQuery(entry, 'deepseek'), true)
  })

  it('matches the description', () => {
    assert.equal(entryMatchesQuery(entry, '记忆'), true)
  })

  it('matches the owner handle at the same weight as name/description', () => {
    // The needle arrives lowercased from the panel (query.trim().toLowerCase()).
    assert.equal(entryMatchesQuery(entry, 'volcengine'), true)
    assert.equal(entryMatchesQuery(entry, 'volc'), true)
  })

  it('rejects a needle that hits none of the fields', () => {
    assert.equal(entryMatchesQuery(entry, 'nothing-here'), false)
  })

  it('admits everything for an empty needle (browse mode)', () => {
    assert.equal(entryMatchesQuery(entry, ''), true)
  })

  it('tolerates a row without an owner', () => {
    assert.equal(entryMatchesQuery(row({ name: 'x', description: 'y' }), 'volcengine'), false)
  })
})
