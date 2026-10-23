/**
 * Query contract: what each of the three tools answers, and how ambiguity and
 * freshness are reported.
 *
 * The rules pinned here are the ones that decide whether an answer can be
 * trusted: exact name beats substring, an ambiguous name answers nothing rather
 * than the first match, a reverse walk reports the FILE a call came from, and
 * every answer says how fresh the graph is.
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
  findSymbols,
  freshnessNote,
  importsOf,
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
  it('reports the FILE a call came from, because call edges are file-owned', () => {
    const g = graph()
    const target = sym('target.ts', 'shared')
    replaceFile(g.db, file('target.ts'), [target], [])
    replaceFile(g.db, file('caller.ts'), [], [
      { from: fileNodeId('caller.ts'), to: target.id, kind: 'references', line: 7 },
    ])
    const refs = referencesTo(g, target.id, 10)
    assert.deepEqual(refs, [{ path: 'caller.ts', line: 7, kind: 'references' }])
  })

  it('does not report a `contains` edge as a reference', () => {
    // A file "contains" its own symbols; counting that as a caller would make
    // every symbol look used by the file that declares it.
    const g = graph()
    const own = sym('a.ts', 'own')
    replaceFile(g.db, file('a.ts'), [own], [
      { from: fileNodeId('a.ts'), to: own.id, kind: 'contains', line: 1 },
    ])
    assert.deepEqual(referencesTo(g, own.id, 10), [])
  })
})

describe('importsOf', () => {
  it('reports the imported files', () => {
    const g = graph()
    replaceFile(g.db, file('lib.ts'), [sym('lib.ts', 'libFn')], [])
    replaceFile(g.db, file('app.ts'), [], [
      { from: fileNodeId('app.ts'), to: fileNodeId('lib.ts'), kind: 'imports', line: 1 },
    ])
    assert.deepEqual(importsOf(g, 'app.ts', 10), ['lib.ts'])
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

    const incoming = calledBy(g, target.id, 10)
    assert.deepEqual(incoming.map(edge => [edge.path, edge.line]), [['a.ts', 3]])

    // `callsOf` is symbol-scoped; the call edge is owned by the FILE, so it
    // answers nothing for the symbol. That asymmetry is why `calledBy` reads the
    // file id — see the note in query.ts.
    assert.deepEqual(callsOf(g, caller.id, 10), [])
  })

  it('resolves a symbol-owned reference to its target name', () => {
    const g = graph()
    const callee = sym('b.ts', 'beta')
    replaceFile(g.db, file('b.ts'), [callee], [])
    const caller = sym('a.ts', 'alpha')
    replaceFile(g.db, file('a.ts'), [caller], [
      { from: caller.id, to: callee.id, kind: 'references', line: 2 },
    ])
    const outgoing = callsOf(g, caller.id, 10)
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
