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
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGraph, replaceFile, type FileRecord, type Graph } from '../src/store.ts'
import { MAX_SOURCE_FILE_BYTES } from '../src/budget.ts'
import { changedFilesSinceIndex, readCallSites, readSourceSlice } from '../src/source.ts'

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

/** `readCallSites` with generous bounds; a test narrows what it needs. */
function sites(root: string, graph: Graph, list: { path: string, line: number }[], over: Partial<Parameters<typeof readCallSites>[0]> = {}): ReturnType<typeof readCallSites> {
  return readCallSites({ db: graph.db, root, sites: list, maxFiles: 40, maxBytes: 1_000_000, maxChars: 120, maxTotalChars: 3_000, ...over })
}

describe('readCallSites — the line of each call', () => {
  it('walks the sites in list order, reads each file once, and keys every site by its path and line', () => {
    const { root, graph, record } = fixture()
    const source = 'const x = 1\nfoo(\n  1,\n)\nbar()\n'
    writeFileSync(join(root, 'src', 'a.ts'), source)
    record('src/a.ts', source)
    const result = sites(root, graph, [{ path: 'src/a.ts', line: 5 }, { path: 'src/a.ts', line: 2 }, { path: 'src/a.ts', line: 2 }])
    assert.ok(result !== undefined)
    assert.equal(result.filesRead, 1, 'two sites in one file are one read, and a repeat is not another')
    assert.equal(result.sites.get('src/a.ts:2')?.text, 'foo(')
    assert.equal(result.sites.get('src/a.ts:5')?.text, 'bar()')
    assert.equal(result.sites.get('src/a.ts:2')?.drift, false, 'the bytes match the record')
    assert.equal(result.truncated, false)
  })

  it('folds the line to one line of text: trimmed, whitespace collapsed, backticks and control characters replaced, long lines cut inside the bound', () => {
    const { root, graph, record } = fixture()
    const source = '\t foo(  1,\u0001\u202E   2 )  \n   \nconst s = `tick ${x}`\nconst long = "' + 'x'.repeat(200) + '"\n'
    writeFileSync(join(root, 'src', 'a.ts'), source)
    record('src/a.ts', source)
    const result = sites(root, graph, [{ path: 'src/a.ts', line: 1 }, { path: 'src/a.ts', line: 2 }, { path: 'src/a.ts', line: 3 }, { path: 'src/a.ts', line: 4 }], { maxChars: 40 })
    assert.ok(result !== undefined)
    assert.equal(result.sites.get('src/a.ts:1')?.text, 'foo( 1,?? 2 )', 'a control character and a bidi override both become a placeholder')
    assert.equal(result.sites.has('src/a.ts:2'), false, 'a blank line is no text')
    assert.equal(result.sites.get('src/a.ts:3')?.text, "const s = 'tick ${x}'", 'a backtick would end the code span the row quotes the line in')
    const cut = result.sites.get('src/a.ts:4')?.text ?? ''
    assert.ok(cut.endsWith('…') && cut.length === 40, `cut inside the bound with an ellipsis: ${String(cut.length)} characters`)
    assert.ok(cut.startsWith('const long = "xxxx'), cut)
  })

  it('refuses a file that grew past the size bound after it was indexed, before reading it', () => {
    const { root, graph, record } = fixture()
    record('src/huge.ts', 'small()\n')
    writeFileSync(join(root, 'src', 'huge.ts'), 'x'.repeat(MAX_SOURCE_FILE_BYTES + 1))
    assert.deepEqual(read(graph, root, 'src/huge.ts', { startLine: 1, endLine: 1 }), { ok: false, reason: 'too-large' })
  })

  it('reads a file in the root whose name starts with two dots', () => {
    // `..notes.md` is a file, not a parent directory; the containment check must
    // not read a prefix as a traversal.
    const { root, graph, record } = fixture()
    record('src/..notes.md', 'one()\n')
    writeFileSync(join(root, 'src', '..notes.md'), 'one()\n')
    assert.equal(read(graph, root, 'src/..notes.md', { startLine: 1, endLine: 1 }).ok, true)
  })

  it('flags a file whose bytes no longer match the graph, and still gives its current line', () => {
    const { root, graph, record } = fixture()
    record('src/a.ts', 'one()\ntwo()\n')
    writeFileSync(join(root, 'src', 'a.ts'), 'zero()\none()\ntwo()\n')
    const result = sites(root, graph, [{ path: 'src/a.ts', line: 2 }])
    assert.ok(result !== undefined)
    assert.equal(result.sites.get('src/a.ts:2')?.text, 'one()', 'the file as it is now')
    assert.equal(result.sites.get('src/a.ts:2')?.drift, true, 'and the graph meant another line')
  })

  it('stops at the file, byte and text bounds, and says so', () => {
    const { root, graph, record } = fixture()
    for (const name of ['a', 'b']) {
      writeFileSync(join(root, 'src', `${name}.ts`), 'one()\ntwo()\n')
      record(`src/${name}.ts`, 'one()\ntwo()\n')
    }
    const list = [{ path: 'src/a.ts', line: 1 }, { path: 'src/b.ts', line: 1 }]
    const oneFile = sites(root, graph, list, { maxFiles: 1 })
    assert.ok(oneFile !== undefined)
    assert.equal(oneFile.sites.has('src/b.ts:1'), false, 'the second file was not opened')
    assert.equal(oneFile.truncated, true)
    const noBytes = sites(root, graph, list, { maxBytes: 10 })
    assert.ok(noBytes !== undefined)
    assert.equal(noBytes.filesRead, 0, 'a file larger than the byte bound is not read')
    assert.equal(noBytes.truncated, true, 'and that is a cut, not a refusal')
    // The text bound is spent in LIST order, and once it is spent nothing more is
    // read: the first file's line is in, the second file is never opened.
    const littleText = sites(root, graph, list, { maxTotalChars: 5 })
    assert.ok(littleText !== undefined)
    assert.equal(littleText.sites.get('src/a.ts:1')?.text, 'one()')
    assert.equal(littleText.filesRead, 1, 'the walk stopped at the bound')
    assert.equal(littleText.sites.has('src/b.ts:1'), false)
    assert.equal(littleText.truncated, true)
  })

  it('serves the text budget by list order, not by file', () => {
    // Two calls in a.ts and one in b.ts, listed a, b, a: the budget covers the
    // first two rows whatever file they are in, and the third is a location.
    const { root, graph, record } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'one()\ntwo()\n')
    record('src/a.ts', 'one()\ntwo()\n')
    writeFileSync(join(root, 'src', 'b.ts'), 'three()\n')
    record('src/b.ts', 'three()\n')
    // `one()` and `three()` are 12 characters together; the third row would be 17.
    const result = sites(root, graph, [{ path: 'src/a.ts', line: 1 }, { path: 'src/b.ts', line: 1 }, { path: 'src/a.ts', line: 2 }], { maxTotalChars: 12 })
    assert.ok(result !== undefined)
    assert.deepEqual([...result.sites.keys()], ['src/a.ts:1', 'src/b.ts:1'])
    assert.equal(result.truncated, true)
  })

  it('answers nothing when source reading is off, and nothing for a path the graph does not hold', () => {
    const { root, graph, record } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'one()\n')
    record('src/a.ts', 'one()\n')
    writeFileSync(join(root, 'src', 'b.ts'), 'two()\n')
    process.env.DSH_APP_CODEGRAPH_SOURCE = '0'
    try {
      assert.equal(sites(root, graph, [{ path: 'src/a.ts', line: 1 }]), undefined)
    } finally {
      delete process.env.DSH_APP_CODEGRAPH_SOURCE
    }
    const result = sites(root, graph, [{ path: 'src/b.ts', line: 1 }, { path: '../outside.ts', line: 1 }])
    assert.ok(result !== undefined)
    assert.equal(result.sites.size, 0, 'not indexed, so not read — the same two refusals as the slice')
    assert.equal(result.filesRead, 0)
    assert.equal(result.truncated, false, 'a refusal is not a cut')
  })
})

describe('changedFilesSinceIndex — one stat, no read', () => {
  /** Record a file as the indexer would, from the bytes on disk right now. */
  function recordAsIndexed(root: string, graph: Graph, path: string, content: string): void {
    const file = join(root, ...path.split('/'))
    writeFileSync(file, content)
    const stat = statSync(file)
    replaceFile(graph.db, { path, mtime: Math.floor(stat.mtimeMs), size: stat.size, hash: createHash('sha256').update(content).digest('hex'), lang: 'typescript' }, [], [])
  }

  it('names the files that moved since the index, in first-mention order, once each', () => {
    const { root, graph } = fixture()
    recordAsIndexed(root, graph, 'src/same.ts', 'a()\n')
    recordAsIndexed(root, graph, 'src/moved.ts', 'b()\n')
    writeFileSync(join(root, 'src', 'moved.ts'), 'b(1)\n')
    assert.deepEqual(changedFilesSinceIndex(graph.db, root, ['src/same.ts', 'src/moved.ts', 'src/same.ts']), ['src/moved.ts'])
    assert.deepEqual(changedFilesSinceIndex(graph.db, root, ['src/same.ts']), [], 'an unchanged file is not named')
  })

  it('names nothing for a path that is not indexed or leaves the root', () => {
    const { root, graph } = fixture()
    recordAsIndexed(root, graph, 'src/a.ts', 'a()\n')
    assert.deepEqual(changedFilesSinceIndex(graph.db, root, ['src/never.ts', '../elsewhere.ts', 'D:/abs.ts']), [])
    // Even with a row — which the walker never writes — an absolute path stays
    // outside the root, so it is neither stat'ed nor named.
    replaceFile(graph.db, { path: 'D:/abs.ts', mtime: 1, size: 1, hash: 'h', lang: 'typescript' }, [], [])
    assert.deepEqual(changedFilesSinceIndex(graph.db, root, ['D:/abs.ts']), [])
  })
})
