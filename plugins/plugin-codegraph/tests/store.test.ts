/**
 * Storage contract: the schema builds once and stays, a file's replacement is
 * atomic and complete, and a schema-version change rebuilds rather than
 * migrates.
 *
 * These are the facts the indexer and the three tools rest on. A schema that
 * rebuilds on every open would make every index pass a cold pass; a replacement
 * that leaves a stale symbol behind would make `codegraph_impact` name a file
 * that no longer declares the symbol.
 *
 * @module plugin-codegraph/tests/store
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SCHEMA_VERSION,
  fileNodeId,
  forgetFile,
  graphStats,
  openGraph,
  readFiles,
  readProjectMeta,
  replaceFile,
  writeProjectMeta,
  type EdgeRecord,
  type FileRecord,
  type SymbolRecord,
} from '../src/store.ts'

const scratch: string[] = []

after(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh database path under a temp directory the suite cleans up. */
function tempGraph(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cg-'))
  scratch.push(dir)
  return join(dir, 'graph.db')
}

const file = (path: string, overrides: Partial<FileRecord> = {}): FileRecord => ({
  path,
  mtime: 1,
  size: 10,
  hash: 'h1',
  lang: 'typescript',
  ...overrides,
})

const symbol = (path: string, name: string, line: number, kind: SymbolRecord['kind'] = 'function'): SymbolRecord => ({
  id: `${path}#${kind}:${name}@${String(line)}`,
  path,
  name,
  kind,
  line,
  parent: undefined,
})

describe('openGraph', () => {
  it('creates the schema on first open and keeps it on the second', () => {
    const path = tempGraph()
    const first = openGraph(path)
    first.db.prepare('INSERT INTO files (path, mtime, size, hash, lang) VALUES (?, ?, ?, ?, ?)').run('a.ts', 1, 1, 'h', 'typescript')
    first.close()

    // Re-opening must NOT drop the row: a schema that rebuilds every open would
    // make every index pass a cold pass.
    const second = openGraph(path)
    assert.equal(readFiles(second.db).size, 1)
    assert.equal(readProjectMeta(second.db), undefined)
    second.close()
  })

  it('rebuilds every table when the stored schema version differs', () => {
    const path = tempGraph()
    const first = openGraph(path)
    first.db.prepare('INSERT INTO files (path, mtime, size, hash, lang) VALUES (?, ?, ?, ?, ?)').run('a.ts', 1, 1, 'h', 'typescript')
    // Pretend a previous build wrote another version.
    first.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('0', 'schema_version')
    first.close()

    const second = openGraph(path)
    assert.equal(readFiles(second.db).size, 0, 'a version mismatch must drop the derived graph, not migrate it')
    const version = second.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }
    assert.equal(version.value, String(SCHEMA_VERSION))
    second.close()
  })

  it('keeps the project metadata round-tripping', () => {
    const path = tempGraph()
    const graph = openGraph(path)
    writeProjectMeta(graph.db, {
      cwd: 'D:/codes/x',
      name: 'x',
      head: 'abc123',
      indexedAt: 42,
      fileCount: 2,
      symbolCount: 3,
      edgeCount: 4,
      truncated: false,
      removalSkipped: false,
      missingLanguage: 0,
      noRules: 0,
      parseErrors: 0,
    })
    assert.deepEqual(readProjectMeta(graph.db), {
      cwd: 'D:/codes/x',
      name: 'x',
      head: 'abc123',
      indexedAt: 42,
      fileCount: 2,
      symbolCount: 3,
      edgeCount: 4,
      truncated: false,
      removalSkipped: false,
      missingLanguage: 0,
      noRules: 0,
      parseErrors: 0,
    })
    graph.close()
  })

  it('treats a corrupt metadata blob as missing, so the caller rebuilds', () => {
    const path = tempGraph()
    const graph = openGraph(path)
    graph.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('project', '{not json')
    assert.equal(readProjectMeta(graph.db), undefined)
    graph.close()
  })
})

describe('replaceFile', () => {
  it('writes a file with its symbols and edges, and counts them', () => {
    const graph = openGraph(tempGraph())
    const a = file('a.ts')
    const fnA = symbol('a.ts', 'alpha', 3)
    replaceFile(graph.db, a, [fnA], [
      { from: fileNodeId('a.ts'), to: fnA.id, kind: 'contains', line: 3 },
    ])
    assert.deepEqual(graphStats(graph.db), { files: 1, symbols: 1, edges: 1 })
    graph.close()
  })

  it('replaces rather than appends when a file is re-indexed', () => {
    // The failure this prevents: a renamed function leaves the old symbol in the
    // graph, and `codegraph_impact` then names a symbol nobody declares.
    const graph = openGraph(tempGraph())
    replaceFile(graph.db, file('a.ts'), [symbol('a.ts', 'before', 3)], [])
    replaceFile(graph.db, file('a.ts', { mtime: 2 }), [symbol('a.ts', 'after', 5)], [])

    const names = (graph.db.prepare('SELECT name FROM symbols WHERE path = ?').all('a.ts') as { name: string }[]).map(r => r.name)
    assert.deepEqual(names, ['after'])
    assert.equal(readFiles(graph.db).get('a.ts')?.mtime, 2)
    graph.close()
  })

  it('drops edges that POINT AT a symbol the file no longer declares', () => {
    // A reference to a deleted symbol must not survive: impact would report the
    // deleted file as affected forever.
    const graph = openGraph(tempGraph())
    const b = symbol('b.ts', 'beta', 1)
    replaceFile(graph.db, file('b.ts'), [b], [])
    replaceFile(graph.db, file('a.ts'), [symbol('a.ts', 'alpha', 1)], [
      { from: symbol('a.ts', 'alpha', 1).id, to: b.id, kind: 'references', line: 1 },
    ])
    assert.equal(graphStats(graph.db).edges, 1)

    // b.ts is re-indexed without `beta`.
    replaceFile(graph.db, file('b.ts', { mtime: 2 }), [symbol('b.ts', 'gamma', 1)], [])
    assert.equal(graphStats(graph.db).edges, 0, 'the dangling reference must go with its target')
    graph.close()
  })

  it('KEEPS inbound edges when the target symbol survives a re-index', () => {
    // The defect this pins: an earlier version deleted inbound edges for EVERY
    // id the file had before, so re-indexing a file whose symbols were unchanged
    // wiped every reference other files held to it. The incremental pass never
    // repairs them (the referencing files are not re-parsed), so `impact` would
    // report zero callers for exactly the symbols that gained some.
    const graph = openGraph(tempGraph())
    const target = symbol('target.ts', 'shared', 1)
    replaceFile(graph.db, file('target.ts'), [target], [])

    const caller = symbol('caller.ts', 'useIt', 1)
    replaceFile(graph.db, file('caller.ts'), [caller], [
      { from: caller.id, to: target.id, kind: 'references', line: 2 },
    ])
    assert.equal(graphStats(graph.db).edges, 1)

    // target.ts re-indexed with the SAME symbol id (a body edit), so the
    // reference from caller.ts must survive.
    replaceFile(graph.db, file('target.ts', { mtime: 9 }), [target], [])
    assert.equal(graphStats(graph.db).edges, 1, 'a surviving symbol keeps its callers')

    // And when the symbol really is gone, the reference goes with it.
    replaceFile(graph.db, file('target.ts', { mtime: 10 }), [symbol('target.ts', 'renamed', 1)], [])
    assert.equal(graphStats(graph.db).edges, 0)
    graph.close()
  })

  it('keeps a file-level import edge across a re-index of the imported file', () => {
    // `imports` targets `file:<path>`, which always survives — so the inbound
    // delete must never touch it, whatever else the file declared.
    const graph = openGraph(tempGraph())
    replaceFile(graph.db, file('lib.ts'), [symbol('lib.ts', 'libFn', 1)], [])
    replaceFile(graph.db, file('app.ts'), [], [
      { from: fileNodeId('app.ts'), to: fileNodeId('lib.ts'), kind: 'imports', line: 1 },
    ])
    assert.equal(graphStats(graph.db).edges, 1)

    replaceFile(graph.db, file('lib.ts', { mtime: 5 }), [symbol('lib.ts', 'libFn2', 1)], [])
    assert.equal(graphStats(graph.db).edges, 1, 'the file node never disappears, so the import stays')
    graph.close()
  })

  it('does not duplicate an identical edge observed twice in one parse', () => {
    const graph = openGraph(tempGraph())
    const a = symbol('a.ts', 'alpha', 1)
    const b = symbol('b.ts', 'beta', 1)
    const edge = { from: a.id, to: b.id, kind: 'references' as const, line: 3 }
    replaceFile(graph.db, file('a.ts'), [a], [edge, edge])
    assert.equal(graphStats(graph.db).edges, 1, 'the primary key collapses a duplicate observation')
    graph.close()
  })

  it('rolls back a failed write, leaving the previous state', () => {
    const graph = openGraph(tempGraph())
    replaceFile(graph.db, file('a.ts'), [symbol('a.ts', 'keep', 1)], [])
    // A duplicate primary key inside the transaction must abort the whole write.
    assert.throws(() => {
      replaceFile(graph.db, file('a.ts', { mtime: 2 }), [symbol('a.ts', 'x', 1), symbol('a.ts', 'x', 1)], [])
    })
    const names = (graph.db.prepare('SELECT name FROM symbols WHERE path = ?').all('a.ts') as { name: string }[]).map(r => r.name)
    assert.deepEqual(names, ['keep'], 'a failed replace must leave the old rows intact')
    graph.close()
  })
})

describe('forgetFile', () => {
  it('removes the file, its symbols and both directions of its edges', () => {
    const graph = openGraph(tempGraph())
    const a = symbol('a.ts', 'alpha', 1)
    const b = symbol('b.ts', 'beta', 1)
    replaceFile(graph.db, file('a.ts'), [a], [{ from: a.id, to: b.id, kind: 'references', line: 1 }])
    replaceFile(graph.db, file('b.ts'), [b], [])

    forgetFile(graph.db, 'a.ts')
    assert.equal(readFiles(graph.db).has('a.ts'), false)
    assert.equal(graphStats(graph.db).edges, 0)
    // b.ts itself is untouched.
    assert.equal(readFiles(graph.db).has('b.ts'), true)
    graph.close()
  })
})

describe('openGraph file handling', () => {
  it('creates the database file it is given', () => {
    const path = tempGraph()
    assert.equal(existsSync(path), false)
    const graph = openGraph(path)
    graph.close()
    assert.equal(existsSync(path), true)
  })
})
