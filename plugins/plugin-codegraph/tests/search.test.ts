/**
 * The search rules, tested as strings — the only way to see them.
 *
 * A parsing bug and a tokenising bug both look like "the symbol is missing", so they
 * are pinned here where a failure names the rule instead of a query. No database is
 * involved; `query.test.ts` owns the SQL these rules feed.
 *
 * @module plugin-codegraph/tests/search
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseSymbolQuery, queryTokens } from '../src/search.ts'

describe('parseSymbolQuery', () => {
  it('splits the filters off the free text', () => {
    assert.deepEqual(parseSymbolQuery('kind:function path:src/api authenticate'), {
      text: 'authenticate',
      kind: 'function',
      path: 'src/api',
    })
  })

  it('keeps an unknown prefix as text, because a search that worked must not become an error', () => {
    // `TODO:` and a Windows drive letter look exactly like a field. Refusing them
    // would break a query nobody changed.
    assert.deepEqual(parseSymbolQuery('TODO: refactor'), { text: 'TODO: refactor' })
    assert.deepEqual(parseSymbolQuery('C:\\repo\\src'), { text: 'C:\\repo\\src' })
  })

  it('accepts a quoted value, for the one case that needs it — a path with a space', () => {
    assert.deepEqual(parseSymbolQuery('path:"src/my dir" helper'), { text: 'helper', path: 'src/my dir' })
  })

  it('treats an empty field as text rather than as a filter for nothing', () => {
    // `name:` alone would otherwise filter on the empty string, which every row
    // matches — silently disabling the search instead of answering it.
    assert.deepEqual(parseSymbolQuery('name:'), { text: 'name:' })
  })

  it('answers with no text at all when the query is only filters', () => {
    assert.deepEqual(parseSymbolQuery('kind:class lang:typescript'), { text: '', kind: 'class', lang: 'typescript' })
  })
})

describe('queryTokens', () => {
  it('splits a bag of words, which is the one thing a substring scan cannot answer', () => {
    assert.deepEqual(queryTokens('marks ruler'), ['marks', 'ruler'])
    assert.deepEqual(queryTokens('fix-bug (auth)'), ['fix', 'bug', 'auth'])
  })

  it('drops one-character words', () => {
    // `x`, `a`, `1` cannot identify an identifier, and OR-ing one into the scan matches
    // most of the table — pushing the rows the caller meant past the answer's limit.
    assert.deepEqual(queryTokens('a id x'), ['id'])
    assert.deepEqual(queryTokens('x'), [])
  })

  it('answers nothing for text with no word in it', () => {
    assert.deepEqual(queryTokens('   -- '), [])
  })
})
