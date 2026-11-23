/**
 * Query contract: what each of the three tools answers, and how ambiguity and
 * freshness are reported.
 *
 * The rules pinned here are the ones that decide whether an answer can be
 * trusted: exact name beats substring, an ambiguous name answers nothing rather
 * than the first match, a reverse walk names the SYMBOL a call came from (or its
 * file, for a call at file scope), and every answer says how fresh the graph is.
 *
 * @module plugin-codegraph/tests/query
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_PATH,
  calledBy,
  callerTree,
  callsOf,
  documentsFor,
  fileOutline,
  findSymbols,
  freshnessNote,
  importsOf,
  projectLayout,
  projectOverview,
  referencesTo,
  ambiguousCandidates,
  resolveSymbol,
  symbolsInFile,
  testFilesReferencing,
} from '../src/query.ts'
import { fileNodeId, openGraph, replaceFile, type FileRecord, type SymbolRecord } from '../src/store.ts'

const scratch: string[] = []
const graphs: ReturnType<typeof openGraph>[] = []

after(() => {
  for (const graph of graphs.splice(0)) {
    try { graph.close() } catch { /* already closed */ }
  }
  for (const dir of scratch.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

function graph(): ReturnType<typeof openGraph> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cg-q-'))
  scratch.push(dir)
  const opened = openGraph(join(dir, 'graph.db'))
  graphs.push(opened)
  return opened
}

const file = (path: string): FileRecord => ({ path, mtime: 1, size: 1, hash: 'h', lang: 'typescript' })

const sym = (path: string, name: string, line = 1, parent?: string): SymbolRecord => ({
  id: parent === undefined ? `${path}#function:${name}` : `${path}#method:${parent}.${name}`,
  path,
  name,
  kind: parent === undefined ? 'function' : 'method',
  line,
  endLine: line,
  parent,
})

/** A function with a signature and a doc, as a real v5 parse writes it. */
const signed = (path: string, name: string, signature: string, doc = ''): SymbolRecord => ({
  ...sym(path, name),
  signature,
  doc,
})

describe('findSymbols', () => {
  it('prefers an exact name over a substring match', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'diffRulerMarks'), sym('a.ts', 'diff')], [])
    const result = findSymbols(g, 'diff', 10)
    assert.deepEqual(result.symbols.map(symbol => symbol.name), ['diff'], 'an exact match wins outright')
  })

  it('falls back to a case-insensitive substring when nothing matches exactly', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'diffRulerMarks')], [])
    const result = findSymbols(g, 'RulerMark', 10)
    assert.deepEqual(result.symbols.map(symbol => symbol.name), ['diffRulerMarks'])
  })

  it('finds a name through a word inside it', () => {
    // `ruler` is inside `diffRulerMarks`, so the substring tier answers it. No inverted
    // index is involved: a word-part match is always a substring match, which is why
    // this plugin does not pay for a full-text table it would never need.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'diffRulerMarks'), sym('a.ts', 'markup')], [])
    const result = findSymbols(g, 'ruler', 10)
    assert.deepEqual(result.symbols.map(symbol => symbol.name), ['diffRulerMarks'])
  })

  it('still finds a substring match when no whole word matches', () => {
    // The merge, not a short-circuit: a tier that fills must not starve the rows a
    // weaker query needs.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'oauth_handler')], [])
    assert.deepEqual(findSymbols(g, 'auth', 10).symbols.map(symbol => symbol.name), ['oauth_handler'])
  })

  it('finds a symbol from two words that never appear together in its name', () => {
    // The one thing the substring scan genuinely cannot do: `marks ruler` is not a
    // substring of `diffRulerMarks`, but it is two words of it. This is the only tier
    // that a word list is for, and it runs LAST so it can only fill, never displace.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'diffRulerMarks')], [])
    assert.deepEqual(findSymbols(g, 'marks ruler', 5).symbols.map(symbol => symbol.name), ['diffRulerMarks'])
  })

  it('keeps a plain substring match, in path order, when the query is one word', () => {
    // The tiers are disjoint by construction: a bag-of-words scan only runs for a
    // multi-word query, and a multi-word query cannot be a substring of anything. So a
    // single word's answer is decided by the substring scan alone and stays in path
    // order — a later tier can fill, never reorder or displace.
    const g = graph()
    replaceFile(g.db, file('a.ts'), ['Baruler1', 'Baruler2', 'Baruler3', 'Baruler4', 'Baruler5'].map(name => sym('a.ts', name)), [])
    assert.deepEqual(
      findSymbols(g, 'ruler', 3).symbols.map(symbol => symbol.name),
      ['Baruler1', 'Baruler2', 'Baruler3'],
    )
  })

  it('requires EVERY word of a multi-word query, so a partial match is not a match', () => {
    // The tier is AND, like a bare multi-token FTS5 query. An OR would fill the answer
    // with rows that share one word and push out the rows the caller meant — and this
    // tier runs last precisely because it may only add, never displace.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'marksOnly'), sym('a.ts', 'rulerOnly')], [])
    assert.deepEqual(findSymbols(g, 'marks ruler', 5).symbols.map(symbol => symbol.name), [])
  })

  it('still runs the multi-word tier when only one word survives filtering', () => {
    // The gate counts the words as WRITTEN: `a star` is two words for `aStar`, and
    // counting the filtered tokens would skip the only tier that can find it.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'aStar')], [])
    assert.deepEqual(findSymbols(g, 'a star', 5).symbols.map(symbol => symbol.name), ['aStar'])
  })

  it('treats an exact name case-insensitively, so an exact hit still ends the search', () => {
    // `LIKE` is case-insensitive for ASCII and `=` is not, so `ruler` would miss
    // `Ruler` and then rank `RulerFactory` above it in the prefix tier.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'RulerFactory')], [])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'Ruler')], [])
    assert.deepEqual(findSymbols(g, 'ruler', 5).symbols.map(symbol => symbol.name), ['Ruler'])
  })

  it('narrows with kind:, path:, lang: and name:', () => {
    const g = graph()
    replaceFile(g.db, file('src/api/a.ts'), [sym('src/api/a.ts', 'Service')], [])
    replaceFile(g.db, { ...file('lib/b.py'), lang: 'python' }, [sym('lib/b.py', 'Service')], [])
    replaceFile(g.db, file('src/api/c.ts'), [sym('src/api/c.ts', 'service')], [])

    assert.deepEqual(findSymbols(g, 'kind:class Service', 10).symbols.map(symbol => symbol.path), [], 'neither row is a class')
    assert.deepEqual(findSymbols(g, 'path:src/api serv', 10).symbols.map(symbol => symbol.path), ['src/api/a.ts', 'src/api/c.ts'])
    assert.deepEqual(findSymbols(g, 'lang:python Service', 10).symbols.map(symbol => symbol.path), ['lib/b.py'])
    assert.deepEqual(findSymbols(g, 'kind:function Service', 10).symbols.map(symbol => symbol.path), ['lib/b.py', 'src/api/a.ts', 'src/api/c.ts'], 'the kind filter reads a caller’s capitalisation, and the exact tier compares case-insensitively')
  })

  it('treats LIKE wildcards in the query as characters, not as a pattern', () => {
    // A symbol named `100%` is not "everything"; unescaped, the query would answer
    // with the whole table — a wrong answer that looks like a working search.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'parse_100%'), sym('a.ts', 'unrelated')], [])
    const result = findSymbols(g, '100%', 10)
    assert.deepEqual(result.symbols.map(symbol => symbol.name), ['parse_100%'])
  })

  it('reports truncation rather than silently dropping matches', () => {
    const g = graph()
    // All three contain "x", so a limit of 2 leaves one out.
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'xone'), sym('a.ts', 'xtwo'), sym('a.ts', 'xthree')], [])
    const result = findSymbols(g, 'x', 2)
    assert.equal(result.symbols.length, 2)
    assert.equal(result.truncated, true, 'the caller must know matches were dropped')
  })

  it('counts each match\u2019s call sites, which is what picks the next tool', () => {
    // The count is the decision input, not decoration. Measured: `streamWithDeltas`
    // has 7 grep matches and 6 edges, so grep is cheaper and choosing it is right;
    // `setResponses` has 482 grep matches (~15k tokens plus a judgement per line) and
    // the model still reached for grep, because no answer said how large the question
    // was. Two symbols in one graph, one cheap and one not, is the smallest case that
    // proves the numbers differ per symbol rather than per query.
    const g = graph()
    const cheap = sym('a.ts', 'cheap')
    const expensive = sym('b.ts', 'expensive')
    replaceFile(g.db, file('a.ts'), [cheap, expensive], [])
    const callers = Array.from({ length: 5 }, (_, i) => sym(`c${String(i)}.ts`, `caller${String(i)}`))
    for (const caller of callers) {
      replaceFile(g.db, file(caller.path), [caller], [
        { from: caller.id, to: expensive.id, kind: 'references', line: 1 },
      ])
    }
    const result = findSymbols(g, 'exp', 10)
    assert.equal(result.symbols[0]?.name, 'expensive')
    assert.equal(result.symbols[0]?.references, 5, 'five call sites, so the answer says 5')

    const cheapResult = findSymbols(g, 'cheap', 10)
    assert.equal(cheapResult.symbols[0]?.references, 0, 'and a symbol nobody calls says 0')
  })

  it('carries each match\u2019s signature, and never its doc', () => {
    // The row leads with what the symbol takes and returns when the answer is
    // short. The doc is a `full`-level fact and the find schema does not declare
    // it — `additionalProperties: false` would refuse the whole answer. Measured:
    // the first version of the detail read spread the whole row and `find`
    // answered `doc: ""`, which the registered schema rejected.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [signed('a.ts', 'exported', 'function exported(a: number): number', 'Adds.'), sym('a.ts', 'bare')], [])
    const byName = new Map(findSymbols(g, 'exported', 10).symbols.map(symbol => [symbol.name, symbol]))
    assert.equal(byName.get('exported')?.signature, 'function exported(a: number): number')
    assert.equal('doc' in (byName.get('exported') ?? {}), false, 'the doc never reaches a find row')
    const bare = findSymbols(g, 'bare', 10).symbols[0]
    assert.equal(bare !== undefined && 'signature' in bare, false, 'a declaration with no head carries no key, not an empty string')
  })
})

describe('resolveSymbol', () => {
  it('resolves an exact id and a unique name', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'unique')], [])
    assert.equal(resolveSymbol(g, 'a.ts#function:unique')?.name, 'unique')
    assert.equal(resolveSymbol(g, 'unique')?.name, 'unique')
  })

  it('answers nothing for an ambiguous name', () => {
    // Two files declaring the same name: a tool must not pick one, because the
    // impact answer would then describe the wrong symbol and look correct.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'shared')], [])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'shared')], [])
    assert.equal(resolveSymbol(g, 'shared'), undefined)
    // An exact id still resolves, because it names one symbol.
    assert.equal(resolveSymbol(g, 'b.ts#function:shared')?.path, 'b.ts')
  })
})

describe('referencesTo', () => {
  it('names the calling SYMBOL, and falls back to the file for a file-scope call', () => {
    // Both shapes exist in one graph and a caller must not have to know which:
    // a call inside a declaration is owned by that symbol, a top-level call by the
    // file. W11b changed the first from "the file" to "the function".
    const g = graph()
    const target = sym('target.ts', 'shared')
    const caller = sym('caller.ts', 'run')
    replaceFile(g.db, file('target.ts'), [target], [])
    replaceFile(g.db, file('caller.ts'), [caller], [
      { from: caller.id, to: target.id, kind: 'references', line: 7 },
      { from: fileNodeId('caller.ts'), to: target.id, kind: 'references', line: 12 },
    ])
    const refs = referencesTo(g, target.id, 10).rows
    // The rows come back ordered by `src`, so the SYMBOL-sourced edge sorts before
    // the `file:` one ("caller.ts#function:run" < "file:caller.ts"). Sorted here
    // by line so the case states what it means rather than pinning that order.
    // The symbol-sourced row also carries the caller's id; the file-sourced one
    // cannot, which is why `name` and `callerId` are both optional.
    assert.deepEqual([...refs].sort((a, b) => a.line - b.line), [
      { path: 'caller.ts', line: 7, kind: 'references', name: 'run', callerId: caller.id },
      { path: 'caller.ts', line: 12, kind: 'references', name: undefined },
    ])
  })

  it('marks a reference the referring file resolved itself, and leaves a name match unmarked', () => {
    // `edges.narrowed` is 1 only when parse.ts's `linkFor` answered from a
    // same-file declaration or an import clause; a project-wide name match is
    // a candidate, and the row must let a reader tell the two apart.
    const g = graph()
    const target = sym('target.ts', 'shared')
    const sure = sym('a.ts', 'alpha')
    const guess = sym('b.ts', 'beta')
    replaceFile(g.db, file('target.ts'), [target], [])
    replaceFile(g.db, file('a.ts'), [sure], [
      { from: sure.id, to: target.id, kind: 'references', line: 3, narrowed: true },
    ])
    replaceFile(g.db, file('b.ts'), [guess], [
      { from: guess.id, to: target.id, kind: 'references', line: 5, narrowed: false },
    ])
    const byPath = new Map(referencesTo(g, target.id, 10).rows.map(ref => [ref.path, ref]))
    assert.equal(byPath.get('a.ts')?.narrowed, true)
    assert.equal(byPath.get('b.ts')?.narrowed, undefined, 'an unmarked row carries no key, so the legend is only printed when a mark was')
    assert.equal(byPath.get('a.ts')?.callerId, sure.id)
  })

  it('does not report a `contains` edge as a reference', () => {
    // A file "contains" its own symbols; counting that as a caller would make
    // every symbol look used by the file that declares it.
    const g = graph()
    const own = sym('a.ts', 'own')
    replaceFile(g.db, file('a.ts'), [own], [
      { from: fileNodeId('a.ts'), to: own.id, kind: 'contains', line: 1 },
    ])
    assert.deepEqual(referencesTo(g, own.id, 10).rows, [])
  })

  it('reports truncation, because an incomplete caller list reads as complete', () => {
    // The failure this pins: a symbol with 200 callers answered 40 rows with no
    // signal, so the model edited it believing it had seen every caller.
    const g = graph()
    const target = sym('target.ts', 'shared')
    replaceFile(g.db, file('target.ts'), [target], [])
    const callers = Array.from({ length: 5 }, (_, i) => sym(`c${String(i)}.ts`, `caller${String(i)}`))
    for (const caller of callers) {
      replaceFile(g.db, file(caller.path), [caller], [
        { from: caller.id, to: target.id, kind: 'references', line: 1 },
      ])
    }
    const result = referencesTo(g, target.id, 2)
    assert.equal(result.rows.length, 2, 'the limit still bounds the answer')
    assert.equal(result.truncated, true, 'and the answer says it was cut')
    // "There are more" without a size is a warning the reader cannot act on: 45 or
    // 6000 changes the decision. Measured on a real project, a symbol with 664 call
    // sites answered 40 rows and `truncated: true` with no total.
    assert.equal(result.total, 5, 'the total says HOW many more')
    assert.equal(referencesTo(g, target.id, 99).truncated, false)
    assert.equal(referencesTo(g, target.id, 99).total, 5, 'a complete answer reports the same total')
  })
})

describe('ambiguousCandidates', () => {
  it('names the declarations that share a name, instead of answering nothing', () => {
    // The failure this pins, measured: `streamWithDeltas` is declared in both the
    // production file and a test harness, so every call edge to it was dropped as
    // ambiguous and `codegraph_impact` said "no unambiguous symbol matched" — which
    // reads exactly like "nothing calls this". The candidates turn a dead end into a
    // next step.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'shared')], [])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'shared')], [])
    assert.equal(resolveSymbol(g, 'shared'), undefined, 'still refuses to pick one')
    const shared = ambiguousCandidates(g, 'shared', 10)
    assert.equal(shared.total, 2)
    assert.deepEqual(shared.candidates.map(candidate => candidate.path), ['a.ts', 'b.ts'])
  })

  it('answers no candidates for a name that genuinely is not declared', () => {
    // The other half: "not declared" and "declared twice" must stay distinguishable,
    // because one is a typo and the other is a reason the edges were never built.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'only')], [])
    assert.deepEqual(ambiguousCandidates(g, 'nowhere', 10), { candidates: [], total: 0 })
  })
})

describe('importsOf', () => {
  it('reports the imported files', () => {
    const g = graph()
    replaceFile(g.db, file('lib.ts'), [sym('lib.ts', 'libFn')], [])
    replaceFile(g.db, file('app.ts'), [], [
      { from: fileNodeId('app.ts'), to: fileNodeId('lib.ts'), kind: 'imports', line: 1 },
    ])
    assert.deepEqual(importsOf(g, 'app.ts', 10).rows, ['lib.ts'])
    assert.equal(importsOf(g, 'app.ts', 10).truncated, false)
  })
})

describe('callsOf and calledBy', () => {
  it('reports both directions of a reference with the other end resolved', () => {
    const g = graph()
    const target = sym('b.ts', 'beta')
    replaceFile(g.db, file('b.ts'), [target], [])
    const caller = sym('a.ts', 'alpha')
    replaceFile(g.db, file('a.ts'), [caller], [
      { from: fileNodeId('a.ts'), to: target.id, kind: 'references', line: 3 },
    ])

    const incoming = calledBy(g, target.id, 10).rows
    assert.deepEqual(incoming.map(edge => [edge.path, edge.line]), [['a.ts', 3]])

    // `callsOf` is symbol-scoped; the call edge is owned by the FILE, so it
    // answers nothing for the symbol. That asymmetry is why `calledBy` reads the
    // file id — see the note in query.ts.
    assert.deepEqual(callsOf(g, caller.id, 10).rows, [])
  })

  it('resolves a symbol-owned reference to its target name', () => {
    const g = graph()
    const callee = sym('b.ts', 'beta')
    replaceFile(g.db, file('b.ts'), [callee], [])
    const caller = sym('a.ts', 'alpha')
    replaceFile(g.db, file('a.ts'), [caller], [
      { from: caller.id, to: callee.id, kind: 'references', line: 2 },
    ])
    const outgoing = callsOf(g, caller.id, 10).rows
    assert.deepEqual(outgoing.map(edge => [edge.name, edge.line]), [['beta', 2]])
  })

  it('carries the callee\u2019s signature only when the call resolves to one declaration', () => {
    // A shared name links to every declaration of it, so one call line can hold
    // two edges to two different `shared`s; the first candidate's signature
    // printed as "the" signature would be a guess stated as a fact.
    const g = graph()
    const unique = signed('b.ts', 'beta', 'function beta(x: number): number')
    const first = signed('c.ts', 'shared', 'function shared(a: string): string')
    const second = signed('d.ts', 'shared', 'function shared(a: number): number')
    const headless = sym('e.ts', 'gamma')
    replaceFile(g.db, file('b.ts'), [unique], [])
    replaceFile(g.db, file('c.ts'), [first], [])
    replaceFile(g.db, file('d.ts'), [second], [])
    replaceFile(g.db, file('e.ts'), [headless], [])
    const caller = sym('a.ts', 'alpha')
    replaceFile(g.db, file('a.ts'), [caller], [
      { from: caller.id, to: unique.id, kind: 'references', line: 2 },
      { from: caller.id, to: first.id, kind: 'references', line: 3 },
      { from: caller.id, to: second.id, kind: 'references', line: 3 },
      { from: caller.id, to: headless.id, kind: 'references', line: 4 },
    ])
    const rows = callsOf(g, caller.id, 10).rows
    assert.deepEqual(rows.map(edge => [edge.name, edge.line, edge.signature]), [
      ['beta', 2, 'function beta(x: number): number'],
      ['shared', 3, undefined],
      ['shared', 3, undefined],
      ['gamma', 4, undefined],
    ])
    // A second call to the same callee, on another line, is its own row with the
    // same signature: the uniqueness is per line, not per callee.
    replaceFile(g.db, file('a.ts'), [caller], [
      { from: caller.id, to: unique.id, kind: 'references', line: 2 },
      { from: caller.id, to: unique.id, kind: 'references', line: 9 },
    ])
    assert.deepEqual(callsOf(g, caller.id, 10).rows.map(edge => edge.signature), ['function beta(x: number): number', 'function beta(x: number): number'])
  })
})

describe('symbolsInFile and fileOutline — the head and the summary', () => {
  it('symbolsInFile carries each head and no summary', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [
      signed('a.ts', 'documented', 'function documented(x: number): number', 'Adds.'),
      sym('a.ts', 'bare', 5),
    ], [])
    const rows = symbolsInFile(g, 'a.ts', 10)
    assert.equal(rows[0]?.signature, 'function documented(x: number): number')
    assert.equal('doc' in (rows[0] ?? {}), false, 'the summary is the outline\u2019s to print, not the sibling list\u2019s')
    assert.equal(rows[1] !== undefined && 'signature' in rows[1], false)
  })

  it('fileOutline carries the head and the summary on every row, in the order it already kept', () => {
    const g = graph()
    const api = signed('a.ts', 'publicApi', 'export function publicApi(): void', 'The surface.')
    const helper = signed('a.ts', 'helper', 'function helper()', 'Internal.')
    replaceFile(g.db, file('a.ts'), [helper, api], [
      { from: fileNodeId('a.ts'), to: helper.id, kind: 'references', line: 9 },
      { from: fileNodeId('a.ts'), to: api.id, kind: 'exports', line: 2 },
    ])
    const outline = fileOutline(g, 'a.ts', 10)
    assert.deepEqual(outline.symbols.map(entry => [entry.symbol.name, entry.symbol.signature, entry.symbol.doc, entry.exported]), [
      ['publicApi', 'export function publicApi(): void', 'The surface.', true],
      ['helper', 'function helper()', 'Internal.', false],
    ])
  })
})

describe('symbolsInFile', () => {
  it('lists a file\u2019s declarations in line order', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'second', 10), sym('a.ts', 'first', 2)], [])
    assert.deepEqual(symbolsInFile(g, 'a.ts', 10).map(symbol => symbol.name), ['first', 'second'])
  })
})

describe('projectOverview', () => {
  it('answers "what is this project" with no symbol name at all', () => {
    // The question that motivated this: "where does this project start" names no
    // symbol, so before this the model had nothing to call and fell back to
    // listing directories. Measured in a real session: one orientation question
    // produced `working_directory` + `查找文件` + four `读取` calls.
    const g = graph()
    replaceFile(g.db, file('src/entry.ts'), [sym('src/entry.ts', 'start')], [])
    replaceFile(g.db, file('src/lib.ts'), [sym('src/lib.ts', 'helper')], [
      { from: fileNodeId('src/entry.ts'), to: fileNodeId('src/lib.ts'), kind: 'imports', line: 1 },
    ])
    const overview = projectOverview(g, 10)
    assert.equal(overview.files, 2)
    assert.equal(overview.symbols, 2)
    assert.deepEqual(
      overview.entryCandidates.map(entry => entry.path),
      ['src/entry.ts'],
      'the file nothing imports is the entry point; the imported one is not',
    )
    assert.equal(overview.entryCandidates[0]?.symbol?.name, 'start')
  })

  it('ranks the most-referenced symbols first, counting the same edges impact counts', () => {
    // ONE count per symbol, everywhere.
    //
    // This used to assert "two distinct referrers, not three references", and that
    // rule was itself the defect: measured on a real project the overview said 203
    // for a symbol whose `codegraph_impact` answer carries 664 rows. The model reads
    // 203 in its context, asks the tool, gets 664, and has no way to tell which is
    // real. The edge count is what the tool reports and what its row limit applies
    // to, so that is the number the overview names too.
    const g = graph()
    const hub = sym('hub.ts', 'shared')
    const a = sym('a.ts', 'one')
    const b = sym('b.ts', 'two')
    replaceFile(g.db, file('hub.ts'), [hub], [])
    replaceFile(g.db, file('a.ts'), [a], [{ from: a.id, to: hub.id, kind: 'references', line: 1 }])
    replaceFile(g.db, file('b.ts'), [b], [
      { from: b.id, to: hub.id, kind: 'references', line: 1 },
      { from: b.id, to: hub.id, kind: 'references', line: 9 },
    ])
    const overview = projectOverview(g, 10)
    assert.equal(overview.hubs[0]?.symbol.name, 'shared')
    assert.equal(overview.hubs[0]?.references, 3, 'the edge count, the same number impact reports')
    // The cross-check that makes the rule enforceable: both numbers come from the
    // same table under the same predicate.
    assert.equal(referencesTo(g, hub.id, 10).rows.length, 3, 'impact sees the same three call sites')
  })

  it('excludes documents from the entry candidates and reports the language split', () => {
    // A README imports nothing, so an unguarded in-degree query would rank every
    // document as an entry point and bury the real one.
    const g = graph()
    replaceFile(g.db, { ...file('README.md'), lang: 'document' }, [], [])
    replaceFile(g.db, file('main.ts'), [sym('main.ts', 'main')], [])
    const overview = projectOverview(g, 10)
    assert.deepEqual(overview.entryCandidates.map(entry => entry.path), ['main.ts'])
    assert.deepEqual(
      overview.byLanguage.map(entry => `${entry.lang}:${String(entry.files)}`),
      ['typescript:1'],
      'the document must not appear as a language',
    )
  })

  it('reports truncation instead of silently cutting a long list', () => {
    const g = graph()
    for (const name of ['a', 'b', 'c']) {
      replaceFile(g.db, file(`${name}.ts`), [sym(`${name}.ts`, `fn${name}`)], [])
    }
    const overview = projectOverview(g, 2)
    assert.equal(overview.entryCandidates.length, 2)
    assert.equal(overview.truncated, true)
  })

  it('ranks a conventional entry filename above a bigger file', () => {
    // Measured on a real 1771-file monorepo: in-degree alone answered a 371-symbol
    // HTML template as the entry and never showed the CLI, which is imported by
    // its own wrapper. The filename is the project's own statement of where it
    // starts, so it outranks symbol count.
    const g = graph()
    replaceFile(g.db, file('src/cli.ts'), [sym('src/cli.ts', 'run')], [])
    replaceFile(g.db, file('src/template.js'), [
      sym('src/template.js', 'a'), sym('src/template.js', 'b'), sym('src/template.js', 'c'),
    ], [])
    const overview = projectOverview(g, 10)
    assert.equal(overview.entryCandidates[0]?.path, 'src/cli.ts')
  })

  it('orders tests last rather than dropping them', () => {
    // A test imports nothing, so it is a legitimate zero-in-degree file — but it
    // is not where a project starts. Dropping it would answer an empty list for a
    // test-heavy project, so it is demoted, not removed.
    const g = graph()
    replaceFile(g.db, file('src/main.ts'), [sym('src/main.ts', 'main')], [])
    replaceFile(g.db, file('test/thing.test.ts'), [
      sym('test/thing.test.ts', 't1'), sym('test/thing.test.ts', 't2'), sym('test/thing.test.ts', 't3'),
    ], [])
    const overview = projectOverview(g, 10)
    assert.deepEqual(
      overview.entryCandidates.map(entry => entry.path),
      ['src/main.ts', 'test/thing.test.ts'],
      'the test stays visible, but after the entry',
    )
  })

  it('ranks top-level declarations as hubs, not built-in method names', () => {
    // Measured: the unguarded query answered `.filter`, `.trim` and `.includes`
    // as the project's most-referenced symbols — same-named variables the parser
    // recorded, which say nothing about this codebase. A top-level function is a
    // real public surface; a nested declaration or a bare variable is where the
    // collisions live.
    const g = graph()
    const real = sym('api.ts', 'createServer')
    const noise = sym('noise.ts', 'filter', 3, 'Thing')
    const caller = sym('caller.ts', 'use')
    replaceFile(g.db, file('api.ts'), [real], [])
    replaceFile(g.db, file('noise.ts'), [noise], [])
    replaceFile(g.db, file('caller.ts'), [caller], [
      { from: caller.id, to: real.id, kind: 'references', line: 1 },
      { from: caller.id, to: noise.id, kind: 'references', line: 2 },
    ])
    const overview = projectOverview(g, 10)
    assert.deepEqual(overview.hubs.map(hub => hub.symbol.name), ['createServer'])
  })
})

describe('freshnessNote', () => {
  it('says nothing when the graph is current and complete', () => {
    assert.equal(freshnessNote('current', false, false), undefined)
    assert.equal(freshnessNote('current', false, false, 0), undefined, 'no generated file skipped is no reason to speak')
  })

  it('names every reason an answer may be incomplete', () => {
    const note = freshnessNote('stale', true, true)
    assert.ok(note !== undefined)
    assert.match(note, /older than the working tree/u)
    assert.match(note, /file budget/u)
    assert.match(note, /could not verify deletions/u)
    // The generated-file rule is a shape: a hand-written file with long lines is
    // caught with the bundles, so the answer says how many files it never saw.
    assert.match(freshnessNote('current', false, false, 25) ?? '', /skipped 25 file\(s\) as generated output.*not in this answer/u)
  })

  it('distinguishes indexing from stale, and says a first touch is indexing', () => {
    // "Being built" and "behind" call for different model behaviour: wait, versus
    // trust-then-refresh. A first touch must NOT report an unindexed dead-end —
    // the store type keeps `unindexed` but no tool answer emits it, because the
    // first call queues a pass and reports `indexing`.
    const indexing = freshnessNote('indexing', false, false) ?? ''
    assert.match(indexing, /being built/u)
    assert.match(indexing, /first time/u)
    assert.match(freshnessNote('stale', false, false) ?? '', /older than the working tree/u)
  })
})

describe('documentsFor', () => {
  /** A graph holding one symbol and whichever document edges the case needs. */
  const withDocs = (targets: readonly { readonly path: string, readonly line: number }[]): ReturnType<typeof openGraph> => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-docsfor-'))
    scratch.push(dir)
    const graph = openGraph(join(dir, 'graph.db'))
    graphs.push(graph)
    const file: FileRecord = { path: 'a.ts', mtime: 1, size: 1, hash: 'h', lang: 'typescript' }
    const symbol: SymbolRecord = { id: 'a.ts#function:alpha', path: 'a.ts', name: 'alpha', kind: 'function', line: 1, endLine: 1, parent: undefined }
    replaceFile(graph.db, file, [symbol], targets.map(t => ({ from: symbol.id, to: `file:${t.path}`, kind: 'documents' as const, line: t.line })))
    return graph
  }

  it('reads the document path from the file node and the line from the edge', () => {
    const graph = withDocs([{ path: 'docs/guide.md', line: 3 }])
    assert.deepEqual(documentsFor(graph, 'a.ts#function:alpha', 10).rows, [{ path: 'docs/guide.md', line: 3 }])
  })

  it('keeps a path that contains a hash intact', () => {
    // The `doc:<path>#<line>` id this used to unpack forced a split on the last
    // `#`, so a file genuinely named `notes#1.md` had to be special-cased. The
    // line now lives in its own column and the path is just a path.
    const graph = withDocs([{ path: 'docs/notes#1.md', line: 7 }])
    assert.deepEqual(documentsFor(graph, 'a.ts#function:alpha', 10).rows, [{ path: 'docs/notes#1.md', line: 7 }])
  })

  it('answers nothing when no document mentions the symbol', () => {
    const graph = withDocs([])
    assert.deepEqual(documentsFor(graph, 'a.ts#function:alpha', 10).rows, [])
  })

  it('honours the row limit and reports when it cut the list', () => {
    const graph = withDocs([{ path: 'a.md', line: 1 }, { path: 'a.md', line: 2 }, { path: 'a.md', line: 3 }])
    const cut = documentsFor(graph, 'a.ts#function:alpha', 2)
    assert.equal(cut.rows.length, 2)
    assert.equal(cut.truncated, true)
    assert.equal(documentsFor(graph, 'a.ts#function:alpha', 3).truncated, false)
  })
})

describe('fileOutline', () => {
  it('puts the public surface first, even when nothing inside calls it', () => {
    // The failure this pins: measured on a real 103-symbol file, line order put only
    // 14 referenced symbols in the first 40 rows, and an exported type with ZERO
    // internal callers — the module's actual API — sat below forty `const` helpers
    // nobody uses. A reader asking "what does this file expose" got the opposite
    // answer.
    const g = graph()
    const helper = sym('a.ts', 'helper')
    const api = sym('a.ts', 'publicApi')
    replaceFile(g.db, file('a.ts'), [helper, api], [
      // `helper` is called; `api` is not, but it IS exported.
      { from: fileNodeId('a.ts'), to: helper.id, kind: 'references', line: 9 },
      { from: fileNodeId('a.ts'), to: api.id, kind: 'exports', line: 2 },
    ])
    const outline = fileOutline(g, 'a.ts', 10)
    assert.equal(outline.symbols[0]?.symbol.name, 'publicApi', 'the exported one leads despite zero callers')
    assert.equal(outline.symbols[0]?.exported, true)
    assert.equal(outline.symbols[1]?.symbol.name, 'helper')
    assert.equal(outline.symbols[1]?.exported, false)
  })

  it('reports a star re-export as a module, not a declaration', () => {
    // `export * from './x'` names a module; it has no symbol row, and dropping it
    // would make a re-exporting file look like it publishes nothing.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'own')], [
      { from: fileNodeId('a.ts'), to: 'file:src/other.ts', kind: 'exports', line: 1 },
    ])
    assert.deepEqual(fileOutline(g, 'a.ts', 10).starReExports, ['src/other.ts'])
  })
})

describe('TEST_PATH', () => {
  it('recognises every convention the group is built from', () => {
    // One row per shape the rule names; the list is the rule's own spec, so a
    // convention added to one and not the other fails here.
    const tests = [
      'test/a.ts', 'tests/a.spec.ts', '__tests__/a.js', 'spec/a.ts', 'src/spec/a.ts',
      'src/a.test.ts', 'src/a.spec.tsx', 'e2e/a.e2e.ts',
      'pkg/x_test.go', 'tests/test_parser.py', 'src/FooTest.java', 'src/FooTests.cs', 'src/BarTest.kt', 'src/BazTests.swift',
    ]
    for (const path of tests) assert.equal(TEST_PATH.test(path), true, `${path} is a test file`)
  })

  it('does not read a subject for its test', () => {
    // `*Test.*` unscoped would match a component named `UnitTest`; `latest.ts`
    // has no `.test.` in it; `test-utils/` is a directory of helpers, not tests;
    // `contest.py` is not `test_*.py`.
    const notTests = [
      'src/UnitTest.tsx', 'src/latest.ts', 'src/test-utils/a.ts', 'src/testing/a.ts', 'src/contest.py',
      'src/FooTest.ts', 'src/FooTestable.cs', 'docs/testing.md', 'src/attest.ts',
    ]
    for (const path of notTests) assert.equal(TEST_PATH.test(path), false, `${path} is not a test file`)
  })
})

describe('testFilesReferencing', () => {
  /** A target referenced from the given source symbols and files. */
  function referenced(sources: { symbol?: SymbolRecord, file?: string }[]): ReturnType<typeof openGraph> {
    const g = graph()
    const target = sym('src/target.ts', 'shared')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    for (const source of sources) {
      if (source.symbol !== undefined) {
        replaceFile(g.db, file(source.symbol.path), [source.symbol], [
          { from: source.symbol.id, to: target.id, kind: 'references', line: 3 },
        ])
      }
      if (source.file !== undefined) {
        replaceFile(g.db, file(source.file), [], [
          { from: fileNodeId(source.file), to: target.id, kind: 'references', line: 1 },
        ])
      }
    }
    return g
  }
  const targetId = 'src/target.ts#function:shared'

  it('counts a call inside a test declaration and a call at a test file\u2019s top level alike', () => {
    // A test file often calls the subject at top level (a describe block is not
    // always a declaration the parser records); counting only symbol-sourced
    // edges would leave it out of "run these first".
    const g = referenced([
      { symbol: sym('tests/unit/a.test.ts', 'checksIt') },
      { file: 'tests/top/b.spec.ts' },
      { symbol: sym('src/caller.ts', 'run') },
    ])
    assert.deepEqual(testFilesReferencing(g, targetId), { files: ['tests/top/b.spec.ts', 'tests/unit/a.test.ts'], total: 2 })
  })

  it('names one file once however many of its symbols call the target', () => {
    const g = referenced([
      { symbol: sym('tests/many.test.ts', 'one') },
      { symbol: sym('tests/many.test.ts', 'two') },
      { file: 'tests/many.test.ts' },
    ])
    assert.deepEqual(testFilesReferencing(g, targetId), { files: ['tests/many.test.ts'], total: 1 })
  })

  it('caps the list and says how many test files there are', () => {
    const g = referenced(Array.from({ length: 20 }, (_, i) => ({ file: `tests/t${String(i).padStart(2, '0')}.test.ts` })))
    const found = testFilesReferencing(g, targetId)
    assert.equal(found.files.length, 15)
    assert.equal(found.total, 20)
    assert.equal(found.files[0], 'tests/t00.test.ts', 'by path, so the sample is stable from call to call')
    assert.equal(testFilesReferencing(g, targetId, 3).files.length, 3, 'the limit is the caller\u2019s to lower')
  })

  it('answers nothing for a symbol no test references', () => {
    const g = referenced([{ symbol: sym('src/caller.ts', 'run') }])
    assert.deepEqual(testFilesReferencing(g, targetId), { files: [], total: 0 })
  })
})

describe('callerTree', () => {
  /** A graph holding target <- top <- mid, each call on one line. */
  function threeDeep(): { g: ReturnType<typeof openGraph>, target: string } {
    const g = graph()
    const target = sym('src/target.ts', 'target')
    const top = sym('src/top.ts', 'top')
    const mid = sym('src/mid.ts', 'mid')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    replaceFile(g.db, file('src/top.ts'), [top], [{ from: top.id, to: target.id, kind: 'references', line: 9 }])
    replaceFile(g.db, file('src/mid.ts'), [mid], [{ from: mid.id, to: top.id, kind: 'references', line: 4 }])
    return { g, target: target.id }
  }

  it('expands three levels deep, each node at the line it first called', () => {
    // leaf -> mid -> top -> target, asked to depth 3.
    const g = graph()
    const target = sym('src/target.ts', 'target')
    const top = sym('src/top.ts', 'top')
    const mid = sym('src/mid.ts', 'mid')
    const leaf = sym('src/leaf.ts', 'leaf')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    replaceFile(g.db, file('src/top.ts'), [top], [{ from: top.id, to: target.id, kind: 'references', line: 9 }])
    replaceFile(g.db, file('src/mid.ts'), [mid], [
      { from: mid.id, to: top.id, kind: 'references', line: 4 },
      { from: mid.id, to: top.id, kind: 'references', line: 12 },
    ])
    replaceFile(g.db, file('src/leaf.ts'), [leaf], [{ from: leaf.id, to: mid.id, kind: 'references', line: 2 }])
    const tree = callerTree(g, target.id, 3)
    assert.equal(tree.depth, 3)
    assert.equal(tree.nodes, 3)
    assert.equal(tree.truncated, false)
    assert.deepEqual(tree.roots.map(root => [root.name, root.line, root.kind, root.path]), [['top', 9, 'function', 'src/top.ts']])
    // `mid` calls `top` on lines 4 and 12; the node sits at the FIRST call.
    assert.deepEqual(tree.roots[0]?.children.map(child => [child.name, child.line]), [['mid', 4]])
    assert.deepEqual(tree.roots[0]?.children[0]?.children.map(child => [child.name, child.line]), [['leaf', 2]])
    assert.deepEqual(tree.roots[0]?.children[0]?.children[0]?.children, [], 'depth 3 stops here')
  })

  it('stops at the depth asked for', () => {
    const { g, target } = threeDeep()
    assert.deepEqual(callerTree(g, target, 1).roots.map(root => [root.name, root.children.length]), [['top', 0]])
    assert.deepEqual(callerTree(g, target, 2).roots.map(root => root.children.map(child => child.name)), [['mid']])
  })

  it('leaves file-level references out of the tree', () => {
    // They have no symbol to expand, and `referencing` already lists them.
    const g = graph()
    const target = sym('src/target.ts', 'target')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    replaceFile(g.db, file('src/script.ts'), [], [{ from: fileNodeId('src/script.ts'), to: target.id, kind: 'references', line: 1 }])
    const caller = sym('src/caller.ts', 'run')
    replaceFile(g.db, file('src/caller.ts'), [caller], [{ from: caller.id, to: target.id, kind: 'references', line: 3 }])
    assert.deepEqual(callerTree(g, target.id, 2).roots.map(root => root.name), ['run'])
  })

  it('ends a cycle on a repeated leaf instead of walking it forever, and the asked symbol is a caller like any other', () => {
    // A -> B -> A. Depth 2: B calls A, A calls the asked symbol — shown, because
    // A IS a caller of B and nothing above it is A. Depth 3: A's callers are B,
    // which is already in the tree — named and not expanded, which is what
    // `repeated` and the render's `(see above)` mean.
    const g = graph()
    const a = sym('src/a.ts', 'a')
    const b = sym('src/b.ts', 'b')
    replaceFile(g.db, file('src/a.ts'), [a], [{ from: a.id, to: b.id, kind: 'references', line: 3 }])
    replaceFile(g.db, file('src/b.ts'), [b], [{ from: b.id, to: a.id, kind: 'references', line: 5 }])
    const two = callerTree(g, a.id, 2)
    assert.equal(two.nodes, 2)
    assert.deepEqual(two.roots.map(root => [root.name, root.repeated]), [['b', undefined]])
    assert.deepEqual(two.roots[0]?.children.map(child => [child.name, child.repeated, child.children.length]), [['a', undefined, 0]])
    const tree = callerTree(g, a.id, 3)
    assert.equal(tree.nodes, 3)
    assert.deepEqual(tree.roots[0]?.children[0]?.children.map(child => [child.name, child.repeated, child.children.length]), [['b', true, 0]], 'the cycle closes on a leaf that IS above it')
    // A self-recursive function: its own caller at depth 1, and `(see above)` only
    // from depth 2 on — never a pointer to nothing at the top of the tree.
    const walk = sym('src/walk.ts', 'walk')
    replaceFile(g.db, file('src/walk.ts'), [walk], [{ from: walk.id, to: walk.id, kind: 'references', line: 7 }])
    assert.deepEqual(callerTree(g, walk.id, 1).roots.map(root => [root.name, root.repeated]), [['walk', undefined]])
    assert.deepEqual(callerTree(g, walk.id, 2).roots[0]?.children.map(child => [child.name, child.repeated]), [['walk', true]])
  })

  it('lists a caller once however many times it calls the node', () => {
    const g = graph()
    const target = sym('src/target.ts', 'target')
    const caller = sym('src/caller.ts', 'run')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    replaceFile(g.db, file('src/caller.ts'), [caller], [
      { from: caller.id, to: target.id, kind: 'references', line: 2 },
      { from: caller.id, to: target.id, kind: 'references', line: 7 },
    ])
    assert.deepEqual(callerTree(g, target.id, 2).roots.map(root => [root.name, root.line]), [['run', 2]])
  })

  it('cuts a hub at 12 callers per node and reports the count on the node and at the top', () => {
    const g = graph()
    const target = sym('src/target.ts', 'target')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    for (let index = 0; index < 300; index += 1) {
      const caller = sym(`src/c${String(index).padStart(3, '0')}.ts`, `caller${String(index)}`)
      replaceFile(g.db, file(caller.path), [caller], [{ from: caller.id, to: target.id, kind: 'references', line: 1 }])
    }
    const tree = callerTree(g, target.id, 2)
    assert.equal(tree.roots.length, 12)
    assert.equal(tree.callers, 300, 'the top-level cut is counted')
    assert.equal(tree.nodes, 12)
    assert.equal(tree.truncated, false, 'the node budget was not reached; this is a per-symbol cut')
    assert.equal(tree.roots[0]?.callers, undefined, 'a caller with no callers of its own has no count to report')
  })

  it('stops at 60 nodes, breadth first, and says so', () => {
    // A hub with 12 callers, each with 12 callers of its own: level 1 is 12 nodes,
    // level 2 would add 144 and is cut at 60 — after 48 of them. Breadth first
    // means every root is listed before any root's callers are expanded, so the
    // tree is complete at level 1 whatever the budget does to level 2.
    const g = graph()
    const target = sym('src/target.ts', 'target')
    replaceFile(g.db, file('src/target.ts'), [target], [])
    for (let level1 = 0; level1 < 12; level1 += 1) {
      const parent = sym(`src/p${String(level1)}.ts`, `parent${String(level1)}`)
      replaceFile(g.db, file(parent.path), [parent], [{ from: parent.id, to: target.id, kind: 'references', line: 1 }])
      for (let level2 = 0; level2 < 12; level2 += 1) {
        const child = sym(`src/p${String(level1)}c${String(level2)}.ts`, `child${String(level2)}`)
        replaceFile(g.db, file(child.path), [child], [{ from: child.id, to: parent.id, kind: 'references', line: 1 }])
      }
    }
    const tree = callerTree(g, target.id, 2)
    assert.equal(tree.nodes, 60)
    assert.equal(tree.truncated, true)
    assert.equal(tree.roots.length, 12, 'every root is in')
    assert.equal(tree.roots.filter(root => root.children.length === 12).length, 4, 'four roots were expanded in full')
    const partial = tree.roots[4]
    assert.equal(partial?.children.length, 0, 'the walk stopped at the fifth')
    assert.equal(tree.roots.slice(5).every(root => root.children.length === 0), true)
  })

  it('takes its limits from the caller', () => {
    const { g, target } = threeDeep()
    const tree = callerTree(g, target, 2, { perLevel: 1, maxNodes: 1 })
    assert.equal(tree.nodes, 1)
    assert.equal(tree.truncated, true)
  })
})

describe('projectLayout', () => {
  it('counts every indexed file under its top-level directory, documents included, root files excluded', () => {
    // The pushed overview prints this as one line. The counts are EXACT and the
    // order is by name: bucketing, ranking and the five-row cut happen once, in
    // the renderer, so two places cannot disagree about which directory leads.
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [], [])
    replaceFile(g.db, file('src/deep/b.ts'), [], [])
    replaceFile(g.db, { ...file('docs/guide.md'), lang: 'document' }, [], [])
    replaceFile(g.db, file('z.ts'), [], [])
    assert.deepEqual(projectLayout(g), [
      { dir: 'docs', files: 1 },
      { dir: 'src', files: 2 },
    ])
  })

  it('answers an empty list for a graph that holds nothing but root files', () => {
    const g = graph()
    replaceFile(g.db, file('index.ts'), [], [])
    assert.deepEqual(projectLayout(g), [])
  })
})
