/**
 * Incremental pass contract: what gets re-parsed, what gets skipped, what gets
 * forgotten, and when the graph is considered stale.
 *
 * The failure these guard against is the one that makes a graph worse than no
 * graph: it keeps answering, with yesterday's answer, and nothing says so. A
 * skip that is too eager (wrong mtime comparison) and a removal that never runs
 * (renamed file) both look identical from the outside — a plausible symbol list
 * that no longer matches the code.
 *
 * @module plugin-codegraph/tests/indexer
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexProject, isStale, projectChanged, scanProject } from '../src/indexer.ts'
import { openGraph, readProjectMeta, graphStats, type ProjectMeta } from '../src/store.ts'
import type { ParsedFile } from '../src/parse.ts'

const scratch: string[] = []
const graphs: ReturnType<typeof openGraph>[] = []

after(() => {
  // Close every graph BEFORE removing the directories: SQLite keeps a handle on
  // Windows and `rmSync` fails with EPERM on an open file.
  for (const graph of graphs.splice(0)) {
    try { graph.close() } catch { /* already closed by the test */ }
  }
  for (const dir of scratch.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/** A temp project directory plus an open graph for it. */
function project(): { root: string, graph: ReturnType<typeof openGraph>, dbFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-idx-'))
  scratch.push(root)
  const dbFile = join(root, '.graph', 'graph.db')
  const graph = openGraph(dbFile)
  graphs.push(graph)
  return { root, graph, dbFile }
}

/**
 * A parse stub that reads a tiny made-up syntax: one symbol per `SYM <name>`
 * line and one call per `CALL <name>` line. The real tree-sitter path is covered
 * by `parse.test.ts`; this suite is about WHICH files get parsed, so a stub keeps
 * it from depending on a grammar.
 */
function stubParse(source: string, path: string): ParsedFile {
  const symbols: ParsedFile['symbols'] = []
  const calls: ParsedFile['calls'] = []
  source.split('\n').forEach((line, index) => {
    const sym = /^SYM (\w+)$/u.exec(line)
    if (sym !== null) {
      symbols.push({ id: `${path}#function:${sym[1]!}`, path, name: sym[1]!, kind: 'function', line: index + 1, parent: undefined })
    }
    const call = /^CALL (\w+)$/u.exec(line)
    if (call !== null) calls.push({ name: call[1]!, line: index + 1 })
  })
  return { symbols, calls, imports: [], heritage: [], typeRefs: [], exports: [], hasError: false, unsupported: false }
}

/** Write a file inside the project, creating parents. */
function write(root: string, path: string, body: string): void {
  const absolute = join(root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, body)
}

describe('scanProject', () => {
  it('finds parseable files and skips dependency trees and dot directories', () => {
    const { root } = project()
    write(root, 'a.ts', 'SYM a')
    write(root, 'src/b.py', 'SYM b')
    write(root, 'node_modules/x/c.ts', 'SYM c')
    write(root, '.git/d.ts', 'SYM d')

    const { files } = scanProject(root)
    assert.deepEqual(files.map(file => file.path).sort(), ['a.ts', 'src/b.py'])
  })

  it('walks documents too, marked apart from source', () => {
    // A document is a candidate — it contributes `documents` edges — but it must
    // never be handed to a parser. The flag is what carries that distinction out
    // of the walk; re-deriving it at the use site is how a `.md` one day reaches
    // tree-sitter and is reported as an unparseable source file.
    const { root } = project()
    write(root, 'a.ts', 'SYM a')
    write(root, 'README.md', '# not a language')
    write(root, 'docs/guide.md', 'prose')

    const { files } = scanProject(root)
    const byPath = new Map(files.map(file => [file.path, file.document]))
    assert.equal(byPath.get('a.ts'), false, 'source is not a document')
    assert.equal(byPath.get('README.md'), true, 'a markdown file is walked as a document')
    assert.equal(byPath.get('docs/guide.md'), true, 'a nested document is walked too')
  })

  it('does not walk a lockfile or an unknown extension as a document', () => {
    // The extension list is fixed on purpose: "anything the language table does
    // not claim" would pull in lockfiles and binaries and parse them as prose.
    const { root } = project()
    write(root, 'a.ts', 'SYM a')
    write(root, 'package-lock.json', '{}')
    write(root, 'image.png', 'binary')

    const { files } = scanProject(root)
    assert.deepEqual(files.map(file => file.path).sort(), ['a.ts'])
  })

  it('skips .NET build output', () => {
    // Measured on a real WPF project: `obj/Release/net9.0-windows` and its
    // `win-x64` variant added ten generated files that declare nothing, and the
    // view listed them as two blocks of "0 symbols" under a path nobody wrote.
    const { root } = project()
    write(root, 'Program.cs', 'SYM a')
    write(root, 'obj/Release/net9.0-windows/App.AssemblyInfo.cs', 'SYM generated')
    write(root, 'obj/Release/net9.0-windows/win-x64/App.AssemblyInfo.cs', 'SYM generated')
    write(root, 'bin/Debug/net9.0/App.cs', 'SYM generated')

    const { files } = scanProject(root)
    assert.deepEqual(files.map(file => file.path), ['Program.cs'])
  })

  it('reports truncation instead of silently covering part of a tree', () => {
    const { root } = project()
    for (let index = 0; index < 5; index += 1) write(root, `f${String(index)}.ts`, 'SYM x')
    const { files, truncated } = scanProject(root, 2)
    assert.equal(files.length, 2)
    assert.equal(truncated, true, 'a bounded walk must say it was bounded')
  })
})

describe('indexProject', () => {
  it('parses every file on the first pass and records the metadata', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha\nCALL beta')
    write(root, 'b.ts', 'SYM beta')

    const outcome = await indexProject(graph, root, stubParse)
    assert.equal(outcome.parsed, 2)
    assert.equal(outcome.skipped, 0)
    assert.equal(graphStats(graph.db).files, 2)
    assert.equal(graphStats(graph.db).symbols, 2)
    const meta = readProjectMeta(graph.db)
    assert.equal(meta?.cwd, root)
    assert.equal(meta?.fileCount, 2)
    graph.close()
  })

  it('resolves a call into a reference edge when the name is unique', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha\nCALL beta')
    write(root, 'b.ts', 'SYM beta')
    await indexProject(graph, root, stubParse)

    const row = graph.db.prepare("SELECT src, dst FROM edges WHERE kind = 'references'").get() as { src: string, dst: string } | undefined
    assert.equal(row?.dst, 'b.ts#function:beta')
    assert.equal(row?.src, 'file:a.ts')
    graph.close()
  })

  it('resolves a call into a file whose parse was SKIPPED this pass', async () => {
    // The core claim of the two-phase design: `resolveName` reads the GRAPH, not
    // a map built by this pass, so a reference to an unchanged file still
    // resolves. Without this, every edit to a caller would drop its edges to
    // every callee it did not re-parse.
    const { root, graph } = project()
    write(root, 'b.ts', 'SYM beta')
    await indexProject(graph, root, stubParse)

    await new Promise(resolve => setTimeout(resolve, 10))
    write(root, 'a.ts', 'SYM alpha\nCALL beta')
    const second = await indexProject(graph, root, stubParse)
    assert.equal(second.parsed, 1, 'only a.ts changed')
    assert.equal(second.skipped, 1, 'b.ts was skipped')

    const row = graph.db.prepare("SELECT dst FROM edges WHERE kind = 'references'").get() as { dst: string } | undefined
    assert.equal(row?.dst, 'b.ts#function:beta', 'the skipped file is still a resolvable target')
    graph.close()
  })

  it('resolves mutual calls between two files changed in the same pass', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha\nCALL beta')
    write(root, 'b.ts', 'SYM beta\nCALL alpha')
    await indexProject(graph, root, stubParse)
    const targets = (graph.db.prepare("SELECT dst FROM edges WHERE kind = 'references' ORDER BY dst").all() as unknown as { dst: string }[]).map(r => r.dst)
    assert.deepEqual(targets, ['a.ts#function:alpha', 'b.ts#function:beta'])
    graph.close()
  })

  it('updates the recorded stamp when the bytes are unchanged', async () => {
    // A checkout or a `touch` changes mtime without changing content. Without
    // recording the new stamp, this file is re-read and re-hashed on every pass
    // forever — the exact cost the stat comparison exists to avoid.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    await indexProject(graph, root, stubParse)
    const first = graph.db.prepare('SELECT mtime FROM files WHERE path = ?').get('a.ts') as { mtime: number }

    await new Promise(resolve => setTimeout(resolve, 10))
    // Same bytes, new mtime.
    write(root, 'a.ts', 'SYM alpha')
    const second = await indexProject(graph, root, stubParse)
    assert.equal(second.skipped, 1)
    assert.equal(second.parsed, 0)
    const after = graph.db.prepare('SELECT mtime FROM files WHERE path = ?').get('a.ts') as { mtime: number }
    assert.ok(after.mtime > first.mtime, 'the new stamp is recorded, so the next pass skips on the cheap comparison')
    graph.close()
  })

  it('skips the removal pass when the scan was truncated', async () => {
    // A truncated walk sees fewer files than the disk has. Treating that as
    // "these are gone" would delete most of a project and still report current.
    const { root, graph } = project()
    for (let index = 0; index < 5; index += 1) write(root, `f${String(index)}.ts`, 'SYM x')
    await indexProject(graph, root, stubParse)
    assert.equal(graphStats(graph.db).files, 5)

    const second = await indexProject(graph, root, stubParse, Date.now, 2)
    assert.equal(second.truncated, true)
    assert.equal(second.removalSkipped, true, 'a bounded walk must not drive deletion')
    assert.equal(second.removed, 0)
    assert.equal(graphStats(graph.db).files, 5, 'nothing was deleted')
    graph.close()
  })

  it('does not delete anything when the root cannot be read', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    await indexProject(graph, root, stubParse)

    // A root that does not exist stands in for a disconnected drive or a denied
    // permission: the scan learned nothing, so it must not claim the file is gone.
    const missing = join(root, 'no-such-dir')
    const outcome = await indexProject(graph, missing, stubParse)
    assert.equal(outcome.removalSkipped, true)
    assert.equal(graphStats(graph.db).files, 1, 'a graph that keeps stale rows is recoverable; one that deleted them is not')
    graph.close()
  })

  it('skips an unchanged file on the second pass', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    await indexProject(graph, root, stubParse)

    const second = await indexProject(graph, root, stubParse)
    assert.equal(second.parsed, 0)
    assert.equal(second.skipped, 1, 'an unchanged file must not be re-parsed')
    graph.close()
  })

  it('re-parses only the file that changed', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'b.ts', 'SYM beta')
    await indexProject(graph, root, stubParse)

    // A later mtime is what a real edit produces.
    await new Promise(resolve => setTimeout(resolve, 10))
    write(root, 'a.ts', 'SYM alpha2')
    const second = await indexProject(graph, root, stubParse)
    assert.equal(second.parsed, 1)
    assert.equal(second.skipped, 1)
    const names = (graph.db.prepare('SELECT name FROM symbols ORDER BY name').all() as unknown as { name: string }[]).map(r => r.name)
    assert.deepEqual(names, ['alpha2', 'beta'])
    graph.close()
  })

  it('forgets a file that is no longer on disk', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'b.ts', 'SYM beta')
    await indexProject(graph, root, stubParse)
    assert.equal(graphStats(graph.db).files, 2)

    unlinkSync(join(root, 'b.ts'))
    const second = await indexProject(graph, root, stubParse)
    assert.equal(second.removed, 1)
    assert.equal(graphStats(graph.db).files, 1)
    // The reference from b.ts is gone with it.
    assert.equal(graphStats(graph.db).symbols, 1)
    graph.close()
  })

  it('counts a file whose language has no extraction shape as unsupported, but still records its stat', async () => {
    const { root, graph } = project()
    write(root, 'a.rb', 'SYM rubything')
    const outcome = await indexProject(graph, root, (_source, path) => ({
      symbols: [], calls: [], imports: [], hasError: false, unsupported: 'noShape' as const,
    }))
    assert.equal(outcome.noRules, 1)
    assert.equal(outcome.parsed, 0)
    // The row IS written: it is the stat cache, and without it this file would be
    // read and re-parsed on every pass forever. It declares no symbols, which is
    // what "unsupported" means.
    assert.equal(graphStats(graph.db).files, 1)
    assert.equal(graphStats(graph.db).symbols, 0)
    graph.close()
  })

  it('counts a parse that produced an ERROR node, without dropping the file', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM partial')
    const outcome = await indexProject(graph, root, (source, path) => ({
      ...stubParse(source, path),
      hasError: true,
    }))
    assert.equal(outcome.parseErrors, 1)
    assert.equal(outcome.parsed, 1, 'a partly-readable file still contributes what it could read')
    graph.close()
  })
})

describe('documents edges', () => {
  it('records an edge from a symbol to the line of prose that names it', async () => {
    // The whole W11 contract: a paragraph is reachable from the symbol it
    // explains. `documentsFor` reads this back for `codegraph_context`.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'docs/guide.md', '# Guide\n\nCall `alpha` to start.')

    await indexProject(graph, root, stubParse)

    const edges = graph.db.prepare("SELECT src, dst, kind, line FROM edges WHERE kind = 'documents'").all() as { src: string, dst: string, kind: string, line: number }[]
    assert.equal(edges.length, 1, 'one paragraph names one symbol once')
    assert.equal(edges[0]!.src, 'a.ts#function:alpha', 'the edge starts at the SYMBOL, not the file')
    // The target is the document FILE and the detection line rides the edge's own
    // column. A `doc:<path>#<line>` pseudo-node was the first design and it leaked:
    // no table held that row, so nothing that reclaims a path reclaimed it.
    assert.equal(edges[0]!.dst, 'file:docs/guide.md', 'the target is the document file node')
    assert.equal(edges[0]!.line, 3, 'line points at the sentence, not the file start')
    graph.close()
  })

  it('keeps the document edges when an unrelated SOURCE file changes', async () => {
    // Measured defect: `replaceFile` deletes every outgoing edge of a file's
    // symbols, so editing `a.ts` removed the edges INTO a.ts's symbols from
    // documents nobody had touched — and the first version only rescanned changed
    // documents, so they never returned. The scan now covers every known document.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', '`alpha` is explained here.')
    await indexProject(graph, root, stubParse)
    const count = (): number => (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count(), 1, 'first pass')

    write(root, 'a.ts', 'SYM alpha\n// an edit that does not touch the document')
    await indexProject(graph, root, stubParse)
    assert.equal(count(), 1, 'a source edit must not delete the document edges')
    graph.close()
  })

  it('drops an edge when the sentence that made it is deleted', async () => {
    // The first version only INSERTed, so a removed paragraph kept its edge for
    // ever. Phase 3 now clears a document's edges before re-deriving them.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', '`alpha` is explained here.')
    await indexProject(graph, root, stubParse)
    const count = (): number => (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count(), 1, 'first pass')

    write(root, 'README.md', 'This paragraph mentions nothing declared.')
    await indexProject(graph, root, stubParse)
    assert.equal(count(), 0, 'a removed mention must lose its edge')
    graph.close()
  })

  it('drops every edge pointing at a document that was deleted', async () => {
    // A `doc:` pseudo-node id was in no table, so `forgetFile` could not reclaim
    // it and a deleted document left permanent orphans. A file node is what the
    // removal pass already sweeps.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', '`alpha` is explained here.')
    await indexProject(graph, root, stubParse)
    const count = (): number => (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count(), 1, 'first pass')

    unlinkSync(join(root, 'README.md'))
    await indexProject(graph, root, stubParse)
    assert.equal(count(), 0, 'a deleted document must not leave a dangling edge')
    graph.close()
  })

  it('matches an unquoted identifier too', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', 'alpha does the work.')

    await indexProject(graph, root, stubParse)
    const count = (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count, 1)
    graph.close()
  })

  it('records nothing for prose that names no declared symbol', async () => {
    // The failure this prevents: every English word becoming an edge.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', 'This document talks about things in general.')

    await indexProject(graph, root, stubParse)
    const count = (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count, 0)
    graph.close()
  })

  it('does not parse a document as source', async () => {
    // A document is walked and stored, never handed to the parser. If it were,
    // its "symbols" would be prose and the graph would fill with nonsense.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', 'SYM notReal\nCALL alsoNotReal')

    const outcome = await indexProject(graph, root, stubParse)
    assert.equal(outcome.parsed, 1, 'only the source file was parsed')
    const names = (graph.db.prepare('SELECT name FROM symbols').all() as { name: string }[]).map(row => row.name)
    assert.deepEqual(names, ['alpha'])
    // The document is still a ROW in `files`, which is what stops every pass
    // re-reading it forever.
    const paths = (graph.db.prepare('SELECT path FROM files').all() as { path: string }[]).map(row => row.path).sort()
    assert.deepEqual(paths, ['README.md', 'a.ts'])
    graph.close()
  })

  it('re-indexes a document when only the document changed', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    await indexProject(graph, root, stubParse)

    write(root, 'README.md', 'alpha is described here.')
    const outcome = await indexProject(graph, root, stubParse)
    assert.equal(outcome.parsed, 0, 'no source file changed')
    const count = (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count, 1, 'the new document produced its edge on the second pass')
    graph.close()
  })
})

describe('a failed pass does not lose edges permanently', () => {
  /**
   * The defect this pins, in the order it happens:
   *
   *   1. phase 1 commits each changed file's `mtime`/`size`/`hash`;
   *   2. phase 2 builds the reference edges in batches and throws part-way;
   *   3. the next pass compares mtime, sees "unchanged", and skips the file — so
   *      the edges phase 1's range delete removed are never rebuilt, while the
   *      graph reports `current`.
   *
   * The old single-transaction phase 2 got this for free. Batching it (for the
   * event loop) is what re-opened the hole, so the recovery has to be explicit:
   * a failed pass deletes the stat-cache row of every file still pending.
   */
  const failingOn = (failingPath: string): ((source: string, path: string) => ParsedFile) => {
    return (source, path) => {
      const parsed = stubParse(source, path)
      if (path !== failingPath) return parsed
      // A value SQLite cannot bind makes the INSERT throw — a real phase 2
      // failure, not a simulated flag. NaN was tried first and does NOT fail:
      // node:sqlite binds it as NULL, and the column accepts that.
      return { ...parsed, calls: parsed.calls.map(call => ({ ...call, line: { not: 'an integer' } as unknown as number })) }
    }
  }

  it('re-parses the file on the next pass and rebuilds its reference edge', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha\nCALL beta')
    write(root, 'b.ts', 'SYM beta')

    // First pass: phase 2 throws on a.ts's call edge.
    await assert.rejects(indexProject(graph, root, failingOn('a.ts')))

    const edgeCount = (): number => (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'references'").get() as { n: number }).n
    assert.equal(edgeCount(), 0, 'the failing phase produced no reference edge')

    // Second pass with a working parser: it must NOT skip a.ts as unchanged.
    const outcome = await indexProject(graph, root, stubParse)
    // `parsed` counts every file the pass re-read, and the recovery is deliberately
    // conservative: it drops the stat cache for EVERY file still pending, not only
    // the one that threw, because a batched phase cannot tell which of them got
    // their edges. b.ts is therefore re-read too — cheap, and correct.
    assert.ok(outcome.parsed >= 1, 'the failed file was re-parsed rather than skipped by mtime')
    const fileRow = graph.db.prepare("SELECT path FROM files WHERE path = 'a.ts'").get()
    assert.notEqual(fileRow, undefined, 'the stat-cache row is back after a successful pass')
    assert.equal(edgeCount(), 1, 'the reference edge came back')
    graph.close()
  })

  it('keeps the symbols of a failed file, so a lookup still answers', async () => {
    // Only the stat-cache row goes. Deleting the symbols too would turn a
    // repairable graph into one that reports "no such symbol" until the next pass.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha\nCALL beta')
    write(root, 'b.ts', 'SYM beta')

    await assert.rejects(indexProject(graph, root, failingOn('a.ts')))
    const symbols = graph.db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE path = 'a.ts'").get() as { n: number }
    assert.equal(symbols.n, 1, 'the symbol survives the failed pass')
    graph.close()
  })
})

describe('isStale', () => {
  const meta = (head: string): ProjectMeta => ({
    cwd: 'D:/x', name: 'x', head, indexedAt: 1, fileCount: 1, symbolCount: 1, edgeCount: 1,
    truncated: false, removalSkipped: false, missingLanguage: 0, noRules: 0, parseErrors: 0,
  })

  it('treats a graph with no metadata as stale', () => {
    assert.equal(isStale(undefined, 'abc'), true)
  })

  it('compares HEAD, and treats an unprovable comparison as NOT stale', () => {
    assert.equal(isStale(meta('abc'), 'abc'), false)
    assert.equal(isStale(meta('abc'), 'def'), true)
    // No repository, or no git on PATH: both sides answer ''. Reporting stale
    // here would re-index on every query and never converge, because a pass
    // writes '' again.
    assert.equal(isStale(meta(''), ''), false)
    // A project that BECAME a repository after indexing: the stored '' cannot
    // describe the new HEAD.
    assert.equal(isStale(meta(''), 'abc'), true)
    // A stored HEAD with no readable one now: freshness cannot be proven, and
    // the graph is older than what we know — treat it as stale.
    assert.equal(isStale(meta('abc'), ''), true)
  })
})

describe('documents edges — the cost of a mention', () => {
  it('points a mention at ONE declaration, not at every name-alike', async () => {
    // This number is the whole cost of the phase, measured on a real project: its
    // documents produced 103,334 mentions, and at 20 targets each that is two
    // million inserts — 64 seconds inside one phase, which froze the kernel (the
    // window stopped answering and the settings pane came up empty). At one target
    // the phase is linear in mentions.
    //
    // The case below is the shape that produced it: many declarations share a name,
    // and one paragraph names it once.
    const { root, graph } = project()
    for (let i = 0; i < 12; i += 1) write(root, `m${String(i)}.ts`, 'SYM index')
    write(root, 'README.md', 'Call `index` to start.')

    await indexProject(graph, root, stubParse)
    const rows = graph.db.prepare("SELECT src FROM edges WHERE kind = 'documents'").all() as { src: string }[]
    assert.equal(rows.length, 1, 'twelve same-named declarations must not become twelve edges')
    graph.close()
  })

  it('re-derives document edges only when the answer can have changed', async () => {
    // A pass that changed nothing must not re-read every document: on a real
    // project that was the most expensive step, and a second pass over an unchanged
    // tree now costs milliseconds instead of tens of seconds.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM alpha')
    write(root, 'README.md', '`alpha` is described here.')
    await indexProject(graph, root, stubParse)
    const count = (): number => (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'documents'").get() as { n: number }).n
    assert.equal(count(), 1, 'first pass')

    // Same bytes everywhere: nothing to re-derive, and the edge survives.
    await indexProject(graph, root, stubParse)
    assert.equal(count(), 1, 'an unchanged pass keeps the edge')

    // A DOCUMENT change must be re-derived even though no source moved: the
    // paragraph is what changed, and its edge has to follow.
    write(root, 'README.md', 'nothing here names a symbol')
    await indexProject(graph, root, stubParse)
    assert.equal(count(), 0, 'a changed document loses the mention it no longer makes')
    graph.close()
  })
})

describe('projectChanged — "unchanged" must be provable', () => {
  it('answers unchanged only after a pass over an intact tree', async () => {
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM a')
    await indexProject(graph, root, stubParse)
    assert.equal(projectChanged(graph, root), false, 'a settled, readable tree really is unchanged')
  })

  it('answers changed for a root it cannot read, and removes nothing', async () => {
    // THE DEFECT. `scanProject` reports `rootUnreadable` when the root's own `readdir`
    // fails, and the check used to answer `false` for it — "unchanged", a claim about a
    // comparison it never made. The caller then kept the project `current` with no
    // `removalSkipped`, so the model was told the graph had been checked and was
    // complete.
    //
    // The root is made unreadable the way Windows and POSIX both honour: the graph lives
    // in a SUBDIRECTORY of the project, and the project root is removed while the graph
    // handle (which lives outside it) stays open. `scanProject` then cannot `readdir` a
    // path that is not a directory at all.
    const base = mkdtempSync(join(tmpdir(), 'dsh-cg-unreadable-'))
    scratch.push(base)
    const root = join(base, 'project')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'SYM a')
    const graph = openGraph(join(base, 'graph', 'graph.db'))
    graphs.push(graph)
    await indexProject(graph, root, stubParse)
    const before = graphStats(graph.db)
    assert.equal(before.files, 1)

    // The root goes away entirely. Its `readdir` now fails with ENOENT, which is what
    // `scanProject` reports as `rootUnreadable` — the same branch a permissions failure
    // takes.
    rmSync(root, { recursive: true, force: true })
    assert.equal(projectChanged(graph, root), true, 'an unreadable root cannot prove "unchanged"')

    // The pass records the unreadable root instead of deleting the graph's rows.
    const outcome = await indexProject(graph, root, stubParse)
    assert.equal(outcome.removalSkipped, true, 'the pass says deletions were not verified')
    assert.equal(outcome.removed, 0, 'and removed nothing')
    assert.equal(graphStats(graph.db).files, before.files, 'the existing graph is intact')
    const meta = readProjectMeta(graph.db)
    assert.equal(meta?.removalSkipped, true, 'and the metadata carries it for every surface')
  })

  it('answers changed for a TRUNCATED walk without changing the removal rule', async () => {
    // The budget case keeps its existing behaviour: a truncated walk is not evidence of
    // deletion (`removalSkipped`), and the check must not claim it is unchanged either.
    const { root, graph } = project()
    write(root, 'a.ts', 'SYM a')
    write(root, 'b.ts', 'SYM b')
    await indexProject(graph, root, stubParse)
    assert.equal(projectChanged(graph, root, 1), true, 'a walk cut at one file proves nothing about the rest')
    // And the pass with the same budget skips removal rather than dropping `b.ts`.
    const outcome = await indexProject(graph, root, stubParse, Date.now, 1)
    assert.equal(outcome.removalSkipped, true)
    assert.ok(graphStats(graph.db).files >= 1, 'no rows were deleted on a truncated walk')
  })
})

describe('cancellation during phase 2 or phase 3', () => {
  /** Enough files that phase 2 crosses its 50-file commit boundary. */
  function bigProject(count: number): { root: string, graph: ReturnType<typeof openGraph> } {
    const { root, graph } = project()
    for (let index = 0; index < count; index += 1) {
      // Each file declares a symbol and calls it, so phase 2 has edges to insert.
      write(root, `f${String(index)}.ts`, `SYM fn${String(index)}\nCALL fn${String(index)}`)
    }
    return { root, graph }
  }

  it('stops phase 2 at its next batch boundary and writes nothing afterwards', async () => {
    // THE DEFECT. `checkAborted` ran at the phase's entry and at the removal/meta steps,
    // but NOT after the `setImmediate` each batch commits through — so a cancellation
    // that arrived during a yield was only noticed after the next transaction had already
    // opened. On unload that is a write against a handle the caller is closing.
    //
    // The signal has to come from INSIDE phase 2, which is what a `references` edge is:
    // phase 1 writes only files/symbols, so the first reference edge proves the call
    // phase is running. Both counters are then sampled at the abort and again once the
    // pass settled — a pass that keeps writing after the cancel moves them.
    const { root, graph } = bigProject(1200)
    const controller = new AbortController()
    const refs = (): number => (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'references'").get() as { n: number }).n
    const files = (): number => graphStats(graph.db).files
    let refsAtAbort = -1
    let filesAtAbort = -1
    const pass = indexProject(graph, root, stubParse, Date.now, undefined, controller.signal)
    const watcher = (async (): Promise<void> => {
      for (;;) {
        if (refs() > 0) {
          controller.abort()
          refsAtAbort = refs()
          filesAtAbort = files()
          return
        }
        await new Promise(resolve => { setTimeout(resolve, 0) })
      }
    })()
    await assert.rejects(async () => { await Promise.all([pass, watcher]) }, /aborted/u)
    assert.ok(refsAtAbort > 0, 'the abort landed inside phase 2, after its first batch committed')
    assert.equal(refs(), refsAtAbort, 'no reference edge was written after the cancel')
    assert.equal(files(), filesAtAbort, 'and no file row either')
    assert.equal(readProjectMeta(graph.db), undefined, 'a cancelled pass never declares itself complete')
  })

  it('dispose waits for the pass to settle before resolving', async () => {
    // THE OTHER HALF OF P1-D. `queue.dispose` used to abort and return synchronously, so
    // the caller closed the graph handles while a phase was still running. Two properties
    // are asserted here, and the second is the one a "dispose is async" edit alone would
    // not give: dispose must not resolve while the runner is still executing, and it must
    // resolve once it has.
    const { createIndexQueue } = await import('../src/queue.ts')
    const EMPTY = {
      parsed: 0, skipped: 0, removed: 0, truncated: false, missingLanguage: 0, noRules: 0,
      parseErrors: 0, durationMs: 1, removalSkipped: false,
    }
    let running = false
    let settled = false
    const queue = createIndexQueue(async (_cwd, signal) => {
      running = true
      // A pass that only ends when it is cancelled, like a long phase 2.
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          // Simulate a phase's last batch: the runner is still on the stack when the
          // abort arrives, so `settled` must stay false until this returns.
          // Long enough that the assertions below can run while it is still pending.
          setTimeout(() => { running = false; settled = true; resolve() }, 300)
        }, { once: true })
      })
      throw new Error('the index pass was aborted')
    })
    const pending = queue.request('D:/x')
    await new Promise(resolve => { setTimeout(resolve, 15) })
    assert.equal(running, true, 'the pass is in flight')

    // The order here is what makes the assertion reliable: dispose is started, then the
    // caller's own promise is awaited (it rejects when the queue cancels the job), and only
    // then is dispose awaited. `settled` must still be false at the moment the job's
    // rejection is observable, because the runner is still on the stack — that is exactly
    // "dispose has not resolved yet".
    let resolvedEarly = false
    const stopping = queue.dispose()
    void stopping.then(() => { resolvedEarly = true })
    // Sampled WHILE the runner is still inside its abort handler: dispose must still be
    // pending here, and must not resolve until that handler has returned.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    assert.equal(settled, false, 'the runner has not finished yet')
    assert.equal(resolvedEarly, false, 'dispose has not resolved while the runner is still finishing')
    await assert.rejects(() => pending, /cancelled|aborted|disposed/u)
    await stopping
    assert.equal(settled, true, 'dispose resolved only after the runner finished')
    assert.notEqual(queue.status('D:/x')?.state, 'failed', 'a cancellation is not a structural failure')
    void EMPTY
  })
})
