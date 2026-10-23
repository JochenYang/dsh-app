/**
 * The graph view's projection, pinned.
 *
 * The rules here decide what a PICTURE claims. A view draws everything it is
 * handed, so the projection — not the store — is where "this is what the project
 * looks like" is decided, and each case below is a way that claim could be
 * wrong while the code still runs:
 *
 *   - an edge to a node the budget dropped draws a line to nowhere, which reads
 *     as a rendering bug rather than as a truncation;
 *   - a document node would be a dot with nothing to say (a document declares no
 *     symbols and imports nothing);
 *   - a detail view that silently shows the first 200 of 700 symbols is the same
 *     failure as a tool answering "no callers" from a stale snapshot — the reader
 *     cannot tell the picture from the truth, so `truncated` is asserted with it.
 *
 * @module plugin-codegraph/tests/graph-view
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileGraph, symbolGraph } from '../src/graph-view.ts'
import { fileNodeId, openGraph, replaceFile, type FileRecord, type SymbolRecord } from '../src/store.ts'

const scratch: string[] = []
const graphs: ReturnType<typeof openGraph>[] = []

after(() => {
  for (const graph of graphs.splice(0)) { try { graph.close() } catch { /* already closed */ } }
  for (const dir of scratch.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
})

const file = (path: string, lang = 'typescript'): FileRecord => ({ path, mtime: 1, size: 1, hash: `h-${path}`, lang })

const sym = (path: string, name: string, line = 1, parent?: string): SymbolRecord => ({
  id: `${path}#function:${parent === undefined ? '' : `${parent}.`}${name}`,
  path, name, kind: 'function', line, parent,
})

/** A fresh graph for one case. */
const graph = (): ReturnType<typeof openGraph> => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-view-'))
  scratch.push(dir)
  const opened = openGraph(join(dir, 'graph.db'))
  graphs.push(opened)
  return opened
}

describe('fileGraph', () => {
  it('draws one node per source file, with its symbol count', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'one'), sym('a.ts', 'two', 2)], [])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'three')], [])
    const view = fileGraph(g)
    assert.deepEqual(view.nodes.map(node => [node.path, node.symbols]), [['a.ts', 2], ['b.ts', 1]])
    assert.equal(view.nodes[0]!.name, 'a.ts', 'the label is the file name, not the path')
    assert.equal(view.truncated, false)
    assert.equal(view.totalFiles, 2)
  })

  it('leaves documents out of the picture', () => {
    // A document holds no symbols and imports nothing: drawing one would be a dot
    // with nothing to say. Its prose is reachable through `codegraph_context`.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'one')], [])
    replaceFile(g.db, file('README.md', 'document'), [], [])
    assert.deepEqual(fileGraph(g).nodes.map(node => node.path), ['a.ts'])
  })

  it('drops an edge whose END the budget cut, rather than drawing a line to nowhere', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'one')], [
      { from: fileNodeId('a.ts'), to: fileNodeId('b.ts'), kind: 'imports', line: 1 },
      { from: fileNodeId('a.ts'), to: fileNodeId('gone.ts'), kind: 'imports', line: 2 },
    ])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'two')], [])
    const view = fileGraph(g)
    assert.equal(view.nodes.length, 2)
    assert.deepEqual(view.edges.map(edge => [edge.from, edge.to]), [[fileNodeId('a.ts'), fileNodeId('b.ts')]])
  })

  it('says it was cut short instead of drawing a fraction silently', () => {
    const g = graph()
    for (let index = 0; index < 5; index += 1) replaceFile(g.db, file(`f${String(index)}.ts`), [sym(`f${String(index)}.ts`, 'x')], [])
    const view = fileGraph(g, 2)
    assert.equal(view.nodes.length, 2)
    assert.equal(view.truncated, true, 'a bounded picture must say it was bounded')
    assert.equal(view.totalFiles, 5)
  })

  it('orders by symbol count so the substantial files take the space', () => {
    const g = graph()
    replaceFile(g.db, file('small.ts'), [sym('small.ts', 'a')], [])
    replaceFile(g.db, file('big.ts'), [sym('big.ts', 'a'), sym('big.ts', 'b', 2), sym('big.ts', 'c', 3)], [])
    assert.deepEqual(fileGraph(g).nodes.map(node => node.path), ['big.ts', 'small.ts'])
  })
})

describe('symbolGraph', () => {
  it('returns one file’s symbols in line order', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'second', 9), sym('a.ts', 'first', 2)], [])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'other')], [])
    const view = symbolGraph(g, 'a.ts')
    assert.deepEqual(view.nodes.map(node => node.name), ['first', 'second'], 'ordered by line')
    assert.equal(view.path, 'a.ts')
  })

  it('carries the parent name for a method', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'run', 3, 'C')], [])
    assert.equal(symbolGraph(g, 'a.ts').nodes[0]?.parent, 'C')
  })

  it('leaves `parent` ABSENT for a top-level symbol, never undefined', () => {
    // The route answers through the suite envelope, and a property holding
    // `undefined` is not lossless JSON — the same rule tool output follows.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'top')], [])
    const node = symbolGraph(g, 'a.ts').nodes[0]!
    assert.equal('parent' in node, false, 'the key must be absent, not present-and-undefined')
  })

  it('draws only the calls that stay inside the file', () => {
    const g = graph()
    const a = sym('a.ts', 'alpha')
    const b = sym('a.ts', 'beta', 2)
    const outside = sym('b.ts', 'other')
    replaceFile(g.db, file('a.ts'), [a, b], [
      { from: a.id, to: b.id, kind: 'references', line: 1 },
      { from: a.id, to: outside.id, kind: 'references', line: 2 },
    ])
    replaceFile(g.db, file('b.ts'), [outside], [])
    const view = symbolGraph(g, 'a.ts')
    assert.deepEqual(view.edges.map(edge => [edge.from, edge.to]), [[a.id, b.id]])
  })

  it('says it was cut short instead of showing a silent subset', () => {
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'a'), sym('a.ts', 'b', 2), sym('a.ts', 'c', 3)], [])
    const view = symbolGraph(g, 'a.ts', 2)
    assert.equal(view.nodes.length, 2)
    assert.equal(view.truncated, true)
    assert.equal(view.totalSymbols, 3)
  })

  it('answers an empty view for a file the graph does not hold', () => {
    const g = graph()
    const view = symbolGraph(g, 'nope.ts')
    assert.deepEqual(view.nodes, [])
    assert.equal(view.totalSymbols, 0)
  })
})
