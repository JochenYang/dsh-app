/**
 * The source reader: what a slice IS, and the four ways it is refused.
 *
 * Every case here is about bytes on a disk, so the suite writes real files into a
 * real temp directory and records them the way the index pass does (a `files` row
 * carrying the content hash). A stubbed filesystem would prove the function
 * against a shape this author imagined; the failures that matter — a file edited
 * after indexing, a path that leaves the root, a file deleted between the pass and
 * the read — only exist against a real disk.
 *
 * @module plugin-codegraph/tests/source
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGraph, replaceFile, type FileRecord, type Graph } from '../src/store.ts'
import { readSourceSlice } from '../src/source.ts'

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

/** A project root, a graph beside it, and the writer that records one file. */
function fixture(): { root: string, graph: Graph, record: (path: string, content: string) => void } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cg-source-'))
  scratch.push(base)
  const root = join(base, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  const graph = openGraph(join(base, 'graph.db'))
  graphs.push(graph)
  const record = (path: string, content: string): void => {
    const bytes = Buffer.from(content, 'utf8')
    const file: FileRecord = {
      path,
      mtime: 1,
      size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
      lang: 'typescript',
    }
    replaceFile(graph.db, file, [], [])
  }
  return { root, graph, record }
}

/** Read a slice with the widest budget unless a case says otherwise. */
function read(
  graph: Graph,
  root: string,
  path: string,
  span: { startLine: number, endLine: number },
  budget: { maxLines: number, maxChars: number } = { maxLines: 500, maxChars: 100_000 },
) {
  return readSourceSlice({ db: graph.db, root, path, ...span, ...budget })
}

describe('readSourceSlice — what the text is', () => {
  it('returns exactly the declared lines, numbered the way Read numbers them', () => {
    const { root, graph, record } = fixture()
    const source = ['export function alpha() {', '  const x = 1', '  return x', '}', 'const after = 2'].join('\n')
    writeFileSync(join(root, 'src', 'a.ts'), source)
    record('src/a.ts', source)

    const result = read(graph, root, 'src/a.ts', { startLine: 1, endLine: 4 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual([result.slice.startLine, result.slice.endLine], [1, 4])
    assert.equal(result.slice.text, [
      '1\texport function alpha() {',
      '2\t  const x = 1',
      '3\t  return x',
      '4\t}',
    ].join('\n'))
    assert.equal(result.slice.truncated, false)
    assert.equal(result.slice.drift, false, 'the bytes still hash to what was indexed')
  })

  it('starts at the declaration, not at the top of the file', () => {
    const { root, graph, record } = fixture()
    const source = ['const pad = 0', 'const pad2 = 0', 'export function beta() {', '  return 1', '}'].join('\n')
    writeFileSync(join(root, 'src', 'b.ts'), source)
    record('src/b.ts', source)

    const result = read(graph, root, 'src/b.ts', { startLine: 3, endLine: 5 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.slice.text, /^3\texport function beta\(\) \{/u)
    assert.equal(result.slice.text.split('\n').length, 3)
  })
})

describe('readSourceSlice — the budget', () => {
  it('cuts at maxLines and says the declaration continues', () => {
    const { root, graph, record } = fixture()
    const source = Array.from({ length: 20 }, (_, index) => `const line${String(index)} = ${String(index)}`).join('\n')
    writeFileSync(join(root, 'src', 'long.ts'), source)
    record('src/long.ts', source)

    const result = read(graph, root, 'src/long.ts', { startLine: 1, endLine: 20 }, { maxLines: 5, maxChars: 100_000 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual([result.slice.startLine, result.slice.endLine], [1, 5])
    assert.equal(result.slice.text.split('\n').length, 5)
    assert.equal(result.slice.truncated, true, 'a cut declaration must say so, not look complete')
  })

  it('cuts on maxChars, so one minified line cannot fill the answer', () => {
    const { root, graph, record } = fixture()
    const source = `const huge = ${'x'.repeat(5_000)}`
    writeFileSync(join(root, 'src', 'min.ts'), source)
    record('src/min.ts', source)

    const result = read(graph, root, 'src/min.ts', { startLine: 1, endLine: 1 }, { maxLines: 100, maxChars: 200 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    // The line is CUT, not handed over whole: a minified line is one line and a hundred
    // thousand characters, so "the first line always fits" would be an unbounded answer.
    assert.equal(result.slice.text.split('\n').length, 1)
    assert.ok(result.slice.text.length <= 200, 'the answer stays inside its character budget')
    assert.match(result.slice.text, /…$/u, 'and says it was cut rather than ending mid-token silently')
    assert.equal(result.slice.truncated, true)
  })
})

describe('readSourceSlice — freshness', () => {
  it('serves the CURRENT bytes and flags the drift when the file changed after indexing', () => {
    const { root, graph, record } = fixture()
    const indexed = ['export function gamma() {', '  return 1', '}'].join('\n')
    writeFileSync(join(root, 'src', 'c.ts'), indexed)
    record('src/c.ts', indexed)
    // The edit a session's own `write` would make: no new index pass has run, so the
    // graph still holds the old hash.
    writeFileSync(join(root, 'src', 'c.ts'), ['export function gamma() {', '  return 2', '}'].join('\n'))

    const result = read(graph, root, 'src/c.ts', { startLine: 1, endLine: 3 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.slice.drift, true, 'the answer must not pass itself off as the indexed state')
    assert.match(result.slice.text, /return 2/u, 'the bytes are from disk, so the edit is visible')
  })

  it('clamps a span that runs past the end of the file, and calls it drift', () => {
    const { root, graph, record } = fixture()
    const source = 'export function delta() {}\n'
    writeFileSync(join(root, 'src', 'd.ts'), source)
    record('src/d.ts', source)

    // A graph that spans 40 lines of a file that now has one: the file shrank after
    // the pass wrote the row. What is true is the one line plus the drift; claiming
    // `truncated` would say the budget cut it, which is a different fact.
    const result = read(graph, root, 'src/d.ts', { startLine: 1, endLine: 40 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.slice.endLine, 1, 'a trailing newline is not a line of its own')
    assert.equal(result.slice.truncated, false, 'the budget did not cut this; the file is shorter')
    assert.equal(result.slice.drift, true)
  })
})

describe('readSourceSlice — the four refusals', () => {
  it('refuses a path the graph never indexed', () => {
    const { root, graph } = fixture()
    assert.deepEqual(read(graph, root, 'src/never.ts', { startLine: 1, endLine: 1 }), { ok: false, reason: 'not-indexed' })
  })

  it('refuses a path that resolves outside the project root', () => {
    // The attack shape: a tool answer carries a path a MODEL produced, so the row is
    // what a malicious or confused caller would write. The `files` row exists (this
    // is the case a "does the graph know it" check would wave through).
    const { root, graph, record } = fixture()
    const outside = join(root, '..', 'secret.ts')
    writeFileSync(outside, 'const secret = 1\n')
    record('../secret.ts', 'const secret = 1\n')

    assert.deepEqual(read(graph, root, '../secret.ts', { startLine: 1, endLine: 1 }), { ok: false, reason: 'outside-root' })
  })

  it('refuses a file that is indexed but no longer readable', () => {
    const { root, graph, record } = fixture()
    const source = 'export function epsilon() {}\n'
    writeFileSync(join(root, 'src', 'e.ts'), source)
    record('src/e.ts', source)
    unlinkSync(join(root, 'src', 'e.ts'))

    assert.deepEqual(read(graph, root, 'src/e.ts', { startLine: 1, endLine: 1 }), { ok: false, reason: 'unreadable' })
  })

  it('refuses a span whose first line the file no longer has', () => {
    // The graph records a declaration at line 12 of a file that is now one line. The
    // file is perfectly readable, so this must NOT be reported as `unreadable`: that
    // sends a reader to check permissions instead of to re-index.
    const { root, graph, record } = fixture()
    const source = 'const only = 1\n'
    writeFileSync(join(root, 'src', 'shrunk.ts'), source)
    record('src/shrunk.ts', source)

    assert.deepEqual(read(graph, root, 'src/shrunk.ts', { startLine: 12, endLine: 20 }), { ok: false, reason: 'shortened' })
  })

  it('refuses everything when the kill switch is off, and recovers when it is back on', () => {
    const { root, graph, record } = fixture()
    const source = 'export function zeta() {}\n'
    writeFileSync(join(root, 'src', 'z.ts'), source)
    record('src/z.ts', source)

    process.env.DSH_APP_CODEGRAPH_SOURCE = '0'
    try {
      assert.deepEqual(read(graph, root, 'src/z.ts', { startLine: 1, endLine: 1 }), { ok: false, reason: 'disabled' })
    } finally {
      delete process.env.DSH_APP_CODEGRAPH_SOURCE
    }
    assert.equal(read(graph, root, 'src/z.ts', { startLine: 1, endLine: 1 }).ok, true)
  })
})
