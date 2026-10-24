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
  calledBy,
  callsOf,
  documentsFor,
  findSymbols,
  freshnessNote,
  importsOf,
  projectOverview,
  referencesTo,
  resolveSymbol,
  symbolsInFile,
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
  parent,
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

  it('reports truncation rather than silently dropping matches', () => {
    const g = graph()
    // All three contain "x", so a limit of 2 leaves one out.
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'xone'), sym('a.ts', 'xtwo'), sym('a.ts', 'xthree')], [])
    const result = findSymbols(g, 'x', 2)
    assert.equal(result.symbols.length, 2)
    assert.equal(result.truncated, true, 'the caller must know matches were dropped')
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
    assert.deepEqual([...refs].sort((a, b) => a.line - b.line), [
      { path: 'caller.ts', line: 7, kind: 'references', name: 'run' },
      { path: 'caller.ts', line: 12, kind: 'references', name: undefined },
    ])
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
    assert.equal(referencesTo(g, target.id, 99).truncated, false)
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
  })

  it('names every reason an answer may be incomplete', () => {
    const note = freshnessNote('stale', true, true)
    assert.ok(note !== undefined)
    assert.match(note, /older than the working tree/u)
    assert.match(note, /file budget/u)
    assert.match(note, /could not verify deletions/u)
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
    const symbol: SymbolRecord = { id: 'a.ts#function:alpha', path: 'a.ts', name: 'alpha', kind: 'function', line: 1, parent: undefined }
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
