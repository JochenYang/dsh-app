/**
 * The one path end to end: real tree-sitter → the index pass → the query layer.
 *
 * Every other suite tests one layer against a stub. `indexer.test.ts` uses a fake
 * parser so it can test WHICH files get parsed; `parse.test.ts` uses the real
 * grammar but stops at the extraction; `query.test.ts` hand-builds edges. None of
 * them proves the three agree — that a symbol id the parser writes is the id the
 * query layer reads, that a call the parser records becomes an edge a walk finds.
 * A contract that only exists inside one module's tests is how two modules come to
 * disagree about an id format and neither turn red.
 *
 * This test is the seam: it parses TypeScript with the real grammar, indexes two
 * files with a mutual call, and reads the reference back through the query layer.
 *
 * @module plugin-codegraph/tests/e2e
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexProject } from '../src/indexer.ts'
import { parseFile } from '../src/tree-sitter.ts'
import { resolveSymbol, findSymbols, referencesTo, importsOf, callsOf, documentsFor } from '../src/query.ts'
import { openGraph, graphStats, type Graph } from '../src/store.ts'
import { LANGUAGES, grammarPath } from '../src/languages.ts'

const scratch: string[] = []
const graphs: Graph[] = []

after(() => {
  for (const graph of graphs.splice(0)) {
    try { graph.close() } catch { /* already closed */ }
  }
  for (const dir of scratch.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

// The real grammars live in the plugin's own `grammars/`, resolved from this
// file rather than `__dirname` (absent under ESM) — the same directory the
// shipped plugin reads.
const here = dirname(fileURLToPath(import.meta.url))
const GRAMMAR_DIR = join(here, '..', 'grammars')
const RUNTIME_WASM = join(GRAMMAR_DIR, 'web-tree-sitter.wasm')

function fixture(): { root: string, graph: Graph } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-e2e-'))
  scratch.push(root)
  const graph = openGraph(join(root, '.graph', 'graph.db'))
  graphs.push(graph)
  return { root, graph }
}

/** Parse through the real grammar, as the plugin's queue callback does. */
async function realParse(source: string, path: string, languageId: string) {
  const spec = LANGUAGES.find(language => language.id === languageId)!
  const grammar = grammarPath(spec, { bundledDir: GRAMMAR_DIR, downloadDir: GRAMMAR_DIR })
  assert.ok(grammar !== undefined, `the ${languageId} grammar must ship with the plugin`)
  return await parseFile(grammar, RUNTIME_WASM, source, path, languageId)
}

describe('real parse → index → query', () => {
  it('carries a call from one file to another all the way into a reference edge', async () => {
    const { root, graph } = fixture()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'lib.ts'), 'export function shared(): number { return 1 }\n')
    writeFileSync(join(root, 'src', 'use.ts'), [
      "import { shared } from './lib'",
      'export function caller(): number { return shared() }',
    ].join('\n'))

    const outcome = await indexProject(graph, root, realParse)
    assert.equal(outcome.parsed, 2)
    assert.equal(outcome.unsupported, 0, 'TypeScript is supported')
    assert.ok(outcome.skipped === 0)

    // The parser's symbol id must be exactly what the query layer reads.
    const shared = resolveSymbol(graph, 'shared')
    assert.ok(shared !== undefined, 'the shared symbol resolves by name')
    assert.equal(shared.path, 'src/lib.ts')

    // The call in use.ts resolves to an edge pointing AT shared, and the edge now
    // names the SYMBOL that makes the call (`caller`), not just its file. That is
    // the W11b contract: "which function calls this" is the question.
    const refs = referencesTo(graph, shared.id, 10)
    assert.deepEqual(refs.map(ref => ref.path), ['src/use.ts'], 'the caller lives in use.ts')
    assert.deepEqual(refs.map(ref => ref.name), ['caller'], 'and the caller is the function, not the file')

    // And the import the parser recorded became a file→file edge.
    assert.deepEqual(importsOf(graph, 'src/use.ts', 10), ['src/lib.ts'])

    // Everything is reachable through the public find entry too.
    const found = findSymbols(graph, 'caller', 10)
    assert.deepEqual(found.symbols.map(symbol => symbol.name), ['caller'])
    assert.equal(found.symbols[0]?.kind, 'function')
    assert.equal(graphStats(graph.db).files, 2)
  })

  it('indexes a second language and keeps its symbols addressable', async () => {
    const { root, graph } = fixture()
    writeFileSync(join(root, 'a.py'), 'def helper():\n    return 1\n\ndef use_it():\n    return helper()\n')
    const outcome = await indexProject(graph, root, realParse)
    assert.equal(outcome.parsed, 1)

    const useIt = resolveSymbol(graph, 'use_it')
    assert.ok(useIt !== undefined)
    assert.equal(useIt.path, 'a.py')
    assert.deepEqual(referencesTo(graph, resolveSymbol(graph, 'helper')!.id, 10).map(r => r.path), ['a.py'])
  })

  it('answers one symbol with only ITS calls, plus the documents that name it', async () => {
    // The end-to-end shape of W11 + W11b together: a file with two functions that
    // call different things, and a README that names one of them.
    const { root, graph } = fixture()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'lib.ts'), [
      'export function first(): number { return 1 }',
      'export function second(): number { return 2 }',
    ].join('\n'))
    writeFileSync(join(root, 'src', 'use.ts'), [
      "import { first, second } from './lib'",
      'export function alpha(): number { return first() }',
      'export function beta(): number { return second() }',
    ].join('\n'))
    writeFileSync(join(root, 'README.md'), '# Project\n\n`alpha` starts the pipeline.\n')

    await indexProject(graph, root, realParse)

    const alpha = resolveSymbol(graph, 'alpha')
    assert.ok(alpha !== undefined)
    // Only alpha's call. Before W11b this answered with BOTH `first` and `second`
    // because the edge started at the file.
    const own = callsOf(graph, alpha.id, 10)
    assert.deepEqual(own.map(edge => edge.name), ['first'], 'alpha calls only first')

    // And the prose that names alpha is reachable from alpha.
    assert.deepEqual(documentsFor(graph, alpha.id, 10), [{ path: 'README.md', line: 3 }])
  })

  it('re-running the pass on unchanged files resolves the same edges without duplicating', async () => {
    const { root, graph } = fixture()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'lib.ts'), 'export function shared() { return 1 }')
    writeFileSync(join(root, 'src', 'use.ts'), "import { shared } from './lib'\nexport function caller() { return shared() }")
    await indexProject(graph, root, realParse)
    const before = graphStats(graph.db)

    await indexProject(graph, root, realParse)
    const after = graphStats(graph.db)
    assert.equal(after.edges, before.edges, 'a re-run over unchanged files is idempotent')
    assert.equal(after.symbols, before.symbols)
  })
})
