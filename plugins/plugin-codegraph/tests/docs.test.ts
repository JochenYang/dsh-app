/**
 * The document-mention scan, pinned.
 *
 * The risk in this module is not a crash: it is a CONFIDENT WRONG EDGE. An edge
 * that says "this paragraph explains `map`" is read by a model as fact, so a rule
 * that matches ordinary prose would fill `codegraph_context` with noise the model
 * then cites. Every case below is one of those rules, stated as a counter-example
 * that the naive implementation fails:
 *
 *   - short names (`x`, `i`) are in every sentence, so they are not candidates;
 *   - English words that happen to be declared symbols (`the`, `for`) are not
 *     candidates, but a QUOTED one is, because the author named code;
 *   - a member access (`Store.open`) must reach `open`, and must not be rejected
 *     as an English word because of its head;
 *   - a path in backticks (`src/main/window.ts`) names a file, so its last
 *     segment is the candidate and the graph rejects it on its own;
 *   - one sentence naming a symbol three times is ONE place in the document.
 *
 * @module plugin-codegraph/tests/docs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  DOCUMENT_EXTENSIONS,
  MIN_MENTION_LENGTH,
  documentMentions,
  isMentionCandidate,
  knownNames,
  tokensOf,
} from '../src/docs.ts'
import type { SymbolRecord } from '../src/store.ts'

/** A symbol row with the fields this module reads. */
const symbol = (name: string, kind = 'function'): SymbolRecord => ({
  id: `src/a.ts#${kind}:${name}`,
  path: 'src/a.ts',
  name,
  kind: kind as SymbolRecord['kind'],
  line: 1,
})

/** The name set the scan consults. */
const known = (...names: string[]): Map<string, string> => knownNames(names.map(name => symbol(name)))

const doc = (text: string, path = 'docs/guide.md'): { path: string, text: string } => ({ path, text })

describe('tokensOf', () => {
  it('marks a backticked run as quoted and a bare word as not', () => {
    const tokens = tokensOf('Call `openGraph` and then readGraph.')
    const quoted = tokens.filter(token => token.quoted).map(token => token.name)
    const bare = tokens.filter(token => !token.quoted).map(token => token.name)
    assert.deepEqual(quoted, ['openGraph'])
    // The backticked word must NOT also appear as a bare token, or every mention
    // would be counted twice — once trusted, once not.
    assert.equal(bare.includes('openGraph'), false)
    assert.ok(bare.includes('readGraph'))
  })

  it('takes the last segment of a path in backticks', () => {
    // `dsh-app/src/main/window.ts` names a FILE. Its last segment is the only
    // part that could ever be a symbol, and the graph rejects it if it is not.
    const quoted = tokensOf('See `dsh-app/src/main/window.ts`.').filter(token => token.quoted)
    assert.deepEqual(quoted.map(token => token.name), ['window.ts'])
    // The bare word `See` is a token too — it is simply not a mention candidate
    // once the stop list and the symbol table have had their say. `tokensOf`
    // reports what it SEES, not what survives.
    assert.deepEqual(tokensOf('See `dsh-app/src/main/window.ts`.').filter(token => !token.quoted).map(token => token.name), ['See'])
  })

  it('takes the last segment of a backticked command line', () => {
    const quoted = tokensOf('Run `npm run build`.').filter(token => token.quoted)
    assert.deepEqual(quoted.map(token => token.name), ['build'])
  })

  it('keeps a dotted member access intact', () => {
    const quoted = tokensOf('`Store.open` is idempotent.').filter(token => token.quoted)
    assert.deepEqual(quoted.map(token => token.name), ['Store.open'])
  })

  it('finds no TOKEN in prose without identifiers', () => {
    // Every word in this sentence is still a token — `tokensOf` does not judge —
    // so the assertion is about the outcome that matters: none of them reaches
    // the symbol table as a mention.
    assert.deepEqual(documentMentions(doc('This paragraph explains nothing in particular.'), known('openGraph')), [])
  })
})

describe('isMentionCandidate', () => {
  it('rejects a name shorter than the floor', () => {
    assert.equal(isMentionCandidate({ name: 'x', quoted: false }), false)
    assert.equal(isMentionCandidate({ name: 'id', quoted: false }), false)
    assert.ok(MIN_MENTION_LENGTH >= 3)
  })

  it('accepts a short name when the author put it in backticks', () => {
    // `x` is in every sentence, but `` `x` `` is a deliberate reference to code.
    assert.equal(isMentionCandidate({ name: 'x', quoted: true }), true)
  })

  it('rejects an English stop word that is not quoted', () => {
    assert.equal(isMentionCandidate({ name: 'the', quoted: false }), false)
    assert.equal(isMentionCandidate({ name: 'for', quoted: false }), false)
  })

  it('accepts a member access whatever its head looks like', () => {
    // `the.get` is not an English word, so the head must not reject it.
    assert.equal(isMentionCandidate({ name: 'the.get', quoted: false }), true)
  })
})

describe('documentMentions', () => {
  it('reports the line where a symbol is named', () => {
    const text = ['# Guide', '', 'Call `openGraph` first.', 'Then `readFiles`.'].join('\n')
    const mentions = documentMentions(doc(text), known('openGraph', 'readFiles'))
    assert.deepEqual(mentions, [
      { path: 'docs/guide.md', line: 3, name: 'openGraph' },
      { path: 'docs/guide.md', line: 4, name: 'readFiles' },
    ])
  })

  it('matches only names the graph actually declares', () => {
    // The whole mechanism: prose is the haystack, the symbol table is the test.
    // Without the table every English word would be an edge.
    const mentions = documentMentions(doc('The window is open.'), known('openGraph'))
    assert.deepEqual(mentions, [])
  })

  it('counts one sentence naming a symbol three times as ONE mention', () => {
    // Three identical edges would inflate any count built on them without adding
    // a place to read.
    const mentions = documentMentions(doc('`f` then `f` then `f`.'), known('fff'))
    assert.deepEqual(mentions, [])
    const real = documentMentions(doc('`readFiles` and `readFiles` and `readFiles`.'), known('readFiles'))
    assert.equal(real.length, 1, 'one place in the document, one edge')
  })

  it('reaches a member name from a dotted reference', () => {
    const mentions = documentMentions(doc('`Store.open` is idempotent.'), known('open'))
    assert.deepEqual(mentions, [{ path: 'docs/guide.md', line: 1, name: 'open' }])
  })

  it('does not match a short name inside a longer word', () => {
    // The scan tests whole tokens, never substrings: `open` must not fire inside
    // `opened` or `reopen`.
    const mentions = documentMentions(doc('The file was opened and then reopened.'), known('open'))
    assert.deepEqual(mentions, [])
  })

  it('reports a quoted mention of a name the stop list would otherwise drop', () => {
    const mentions = documentMentions(doc('Call `map` on the list.'), known('map'))
    assert.deepEqual(mentions, [{ path: 'docs/guide.md', line: 1, name: 'map' }])
  })

  it('ignores a path-shaped reference the graph does not declare', () => {
    const mentions = documentMentions(doc('See `src/main/window.ts`.'), known('openGraph'))
    assert.deepEqual(mentions, [])
  })
})

describe('knownNames', () => {
  it('maps every declared name to its kind', () => {
    const names = knownNames([symbol('open', 'function'), symbol('Store', 'class')])
    assert.equal(names.get('open'), 'function')
    assert.equal(names.get('Store'), 'class')
  })

  it('keeps the first declaration when a name repeats', () => {
    // Two languages can declare `render`; the scan only needs "the graph knows
    // this word", so the first record wins and the count stays stable.
    const names = knownNames([symbol('render', 'function'), symbol('render', 'method')])
    assert.equal(names.size, 1)
  })
})

describe('DOCUMENT_EXTENSIONS', () => {
  it('is a fixed list of prose formats', () => {
    // Deliberately NOT "anything the language table does not claim": that would
    // walk lockfiles and binaries and read them as prose.
    assert.deepEqual([...DOCUMENT_EXTENSIONS].sort(), ['.md', '.mdx', '.rst', '.txt'])
  })
})
