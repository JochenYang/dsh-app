/**
 * The code graph's storage: one SQLite database per project, built on the
 * kernel's own `node:sqlite` (no third-party driver, no native build step).
 *
 * Why a real database rather than a JSON dump. The graph is queried by
 * relationship — "who references this symbol", "which files import this one" —
 * and those are joins over an index, not a scan over a blob. A 800-file project
 * holds tens of thousands of edges; loading them all to answer one question
 * would cost more than the index that answers it.
 *
 * Why one database per project. A corrupted or half-written graph must never
 * take another project's graph with it, and deleting a project should be one
 * directory removal. The cost is that cross-project queries are impossible by
 * construction, which is the trade this plugin wants: `docs/plans/plugin-codegraph.md`
 * lists cross-repo intelligence as out of scope.
 *
 * Schema versioning is deliberate rather than automatic: `SCHEMA_VERSION` is
 * stored in `meta`, and a mismatch DROPS and rebuilds. A graph is derived data —
 * rebuilding costs one index pass — so a migration path would be more code than
 * the thing it saves.
 *
 * @module @dsh-app/plugin-codegraph/host/store
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Bumped whenever a table or index changes shape.
 *
 * A stored value that differs makes {@link openGraph} rebuild from scratch. Do
 * not add migrations for a derived graph: the rebuild is the migration.
 */
export const SCHEMA_VERSION = 2

/** One indexed file, as the incremental pass sees it. */
export interface FileRecord {
  /** Project-relative path, POSIX separators. */
  readonly path: string
  /** Modification time in ms, from `stat`. */
  readonly mtime: number
  /** Byte size, from `stat`. */
  readonly size: number
  /** Content hash, used to catch a same-size rewrite with a preserved mtime. */
  readonly hash: string
  /** Grammar id this file was parsed with ('typescript', 'python', …). */
  readonly lang: string
}

/** What a symbol node is, at the granularity this plugin resolves. */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'type'
  | 'module'
  | 'constant'
  | 'variable'
  | 'unknown'

/** One symbol node. */
export interface SymbolRecord {
  /**
   * Stable id: `<path>#<kind>:<parent>.<name>` (`parent` omitted at top level).
   *
   * NO line number, deliberately. An id that carried one would change when a
   * line is inserted above the declaration, which invalidates every reference
   * other files hold to that symbol — a re-format would look like "this function
   * is no longer used anywhere". The line lives in its own column for display;
   * disambiguating two same-named siblings in one scope is the parser's job,
   * through `parent` or a trailing `#<ordinal>`.
   */
  readonly id: string
  readonly path: string
  readonly name: string
  readonly kind: SymbolKind
  /** 1-based line of the declaration. */
  readonly line: number
  /** The enclosing symbol's name, when the grammar nests one (a method in a class). */
  readonly parent: string | undefined
}

/** What an edge means. */
export type EdgeKind = 'contains' | 'references' | 'imports' | 'documents'

/** One edge. `from` and `to` are node ids. */
export interface EdgeRecord {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
  /** 1-based line where the edge was observed. */
  readonly line: number
}

/** Index state of one project, as the settings page and the tools report it. */
export type IndexState = 'unindexed' | 'indexing' | 'current' | 'stale' | 'failed'

/** Per-project bookkeeping kept beside the graph in `meta`. */
export interface ProjectMeta {
  /** The absolute working directory this graph describes. */
  readonly cwd: string
  /** Human label for the settings page (the directory's basename). */
  readonly name: string
  /** `git rev-parse HEAD` at the last successful index, or '' outside a repo. */
  readonly head: string
  /** Epoch ms of the last successful index. */
  readonly indexedAt: number
  /** Files in the graph after the last pass. */
  readonly fileCount: number
  /** Symbols and edges in the graph after the last pass. */
  readonly symbolCount: number
  readonly edgeCount: number
  /**
   * True when the last pass hit the file budget.
   *
   * Persisted rather than kept in memory: "this graph covers only the first N
   * files" is exactly the fact a tool must be able to report after a restart, and
   * a graph that silently covers part of a project is the failure this plugin
   * exists to avoid.
   */
  readonly truncated: boolean
  /** True when the last pass skipped its removal step because the scan was partial. */
  readonly removalSkipped: boolean
  /** Files that exist but were not indexed because their language is not installed. */
  readonly unsupported: number
  /** Files whose last parse produced an ERROR node. */
  readonly parseErrors: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path  TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size  INTEGER NOT NULL,
  hash  TEXT NOT NULL,
  lang  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id     TEXT PRIMARY KEY,
  path   TEXT NOT NULL,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL,
  line   INTEGER NOT NULL,
  parent TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  src  TEXT NOT NULL,
  dst  TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  -- The same reference can be observed twice in one parse (a duplicate match, or
  -- an import emitted from both the file node and a symbol). Without this, the
  -- duplicate survives into impact output and inflates every count.
  PRIMARY KEY (src, dst, kind, line)
) WITHOUT ROWID;

-- The queries this plugin actually runs, as indexes rather than scans:
-- find-by-name (symbols), impact (edges by destination), file outline
-- (symbols by path). The edges table is WITHOUT ROWID keyed on
-- (src, dst, kind, line), so its primary key already answers "edges by source";
-- only the destination direction needs its own index.
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS edges_dst  ON edges(dst);
`

/** One open graph: the handle plus the statements this module owns. */
export interface Graph {
  /** The underlying database, for statements a caller needs that this file does not own. */
  readonly db: DatabaseSync
  close(): void
}

/**
 * Open (or create) one project's graph.
 *
 * A schema-version mismatch drops every table and rebuilds: the graph is derived
 * data, so a rebuild is cheaper and safer than a migration nobody will test.
 *
 * A file that is not a SQLite database (or is corrupt) is DELETED and recreated.
 * Without that, every open of that project would throw forever, which turns a
 * derived artifact into a permanent outage — the opposite of the premise above.
 *
 * `file` must be derived from the project's cwd by this plugin, never from a
 * request body: a caller-chosen path here is an arbitrary file create/overwrite.
 *
 * @param file - absolute path to the `.db`; its parent directory is created.
 * @returns the open handle.
 */
export function openGraph(file: string): Graph {
  mkdirSync(dirname(file), { recursive: true })
  const db = openOrRecreate(file)
  // WAL keeps a reader (a tool call) from blocking the background indexer, and
  // `synchronous = NORMAL` is the standard WAL pairing: a crash can lose the
  // last transaction, which for derived data means one rebuild.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  const stored = readMetaValue(db, 'schema_version')
  if (stored !== undefined && stored !== String(SCHEMA_VERSION)) {
    db.exec('DROP TABLE IF EXISTS edges')
    db.exec('DROP TABLE IF EXISTS symbols')
    db.exec('DROP TABLE IF EXISTS files')
    db.exec('DROP TABLE IF EXISTS meta')
  }
  db.exec(SCHEMA)
  writeMetaValue(db, 'schema_version', String(SCHEMA_VERSION))

  return { db, close: () => { db.close() } }
}

/** Whether a table exists in this database. */
function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { name: string } | undefined
  return row !== undefined
}

/**
 * Open the database, recreating it once if the file is not a usable database.
 *
 * The busy timeout is not optional: the graph is a file two processes can reach
 * (a dev run beside an installed one), and the default timeout of 0 turns the
 * first write collision into an immediate `SQLITE_BUSY` instead of a short wait.
 *
 * @param file - absolute path.
 * @returns the open database.
 */
function openOrRecreate(file: string): DatabaseSync {
  try {
    const db = new DatabaseSync(file, { timeout: 5000 })
    // A file that is not a database opens lazily; the first query is what
    // throws, so prove the schema table is readable before handing it out.
    hasTable(db, 'meta')
    return db
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    const unusable = /SQLITE_NOTADB|SQLITE_CORRUPT|file is not a database|malformed/i.test(`${code} ${message}`)
    if (!unusable) throw error
    // Derived data: dropping the file is the repair. `unlinkSync` on three exact
    // files, never a directory — the graph directory holds only these, and a
    // recursive delete here could follow a link out of the storage root.
    for (const target of [file, `${file}-wal`, `${file}-shm`]) {
      try { unlinkSync(target) } catch { /* absent is the normal case for the two sidecars */ }
    }
    return new DatabaseSync(file, { timeout: 5000 })
  }
}

/** Read one `meta` value, or undefined. */
function readMetaValue(db: DatabaseSync, key: string): string | undefined {
  // A first open has no `meta` table yet, and asking for a row there throws
  // rather than answering empty — so the existence check comes first.
  if (!hasTable(db, 'meta')) return undefined
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

/** Write one `meta` value. */
function writeMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Replace the project metadata. */
export function writeProjectMeta(db: DatabaseSync, meta: ProjectMeta): void {
  writeMetaValue(db, 'project', JSON.stringify(meta))
}

/**
 * Read the project metadata, or undefined when it is absent OR unusable.
 *
 * `undefined` means "this graph has no trustworthy metadata", which is the
 * caller's cue to rebuild. It deliberately does not distinguish absent from
 * corrupt: both lead to the same action, and a corrupt blob that parses into the
 * wrong shapes is worse than a missing one — `head` compared as a number would
 * read as permanently stale and rebuild on every query, forever.
 */
export function readProjectMeta(db: DatabaseSync): ProjectMeta | undefined {
  const raw = readMetaValue(db, 'project')
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const meta = parsed as Record<string, unknown>
  const strings = ['cwd', 'name', 'head'] as const
  const numbers = ['indexedAt', 'fileCount', 'symbolCount', 'edgeCount', 'unsupported', 'parseErrors'] as const
  const booleans = ['truncated', 'removalSkipped'] as const
  for (const key of strings) if (typeof meta[key] !== 'string') return undefined
  for (const key of numbers) if (typeof meta[key] !== 'number' || !Number.isFinite(meta[key])) return undefined
  for (const key of booleans) if (typeof meta[key] !== 'boolean') return undefined
  return parsed as ProjectMeta
}

/** A value a query may bind. All queries here bind parameters; none interpolate. */
export type SqlValue = string | number | bigint | null | Uint8Array

/**
 * Run a SELECT returning many rows, typed by its column list.
 *
 * `node:sqlite` answers `Record<string, SQLOutputValue>[]`, which shares no
 * structural overlap with any row interface, so every caller would otherwise
 * repeat the double cast. This module is where that cast is allowed to live
 * exactly twice: a statement's SELECT list is the contract, a schema change is
 * already guarded by SCHEMA_VERSION, and one reviewed pair of casts beats a
 * dozen per-call-site ones that can each drift.
 */
export function allRows<Row>(db: DatabaseSync, sql: string, ...params: readonly SqlValue[]): Row[] {
  return db.prepare(sql).all(...params) as unknown as Row[]
}

/** Run a SELECT returning at most one row. See {@link allRows} for the cast. */
export function oneRow<Row>(db: DatabaseSync, sql: string, ...params: readonly SqlValue[]): Row | undefined {
  return db.prepare(sql).get(...params) as unknown as Row | undefined
}

/** Every indexed file, keyed by path, for the incremental comparison. */
export function readFiles(db: DatabaseSync): Map<string, FileRecord> {
  const rows = allRows<FileRecord>(db, 'SELECT path, mtime, size, hash, lang FROM files')
  return new Map(rows.map(row => [row.path, row]))
}

/**
 * Apply one file's parse result, replacing whatever that file contributed before.
 *
 * Delete-then-insert rather than a diff: a file's symbols and edges are only
 * meaningful as a set, and a partial update is how a stale symbol outlives the
 * code it named.
 *
 * @param db - the open database.
 * @param file - the file row.
 * @param symbols - symbols declared in the file.
 * @param edges - edges whose source is one of those symbols (or the file itself).
 */
export function replaceFile(
  db: DatabaseSync,
  file: FileRecord,
  symbols: readonly SymbolRecord[],
  edges: readonly EdgeRecord[],
): void {
  const previous = db.prepare('SELECT id FROM symbols WHERE path = ?').all(file.path) as { id: string }[]
  const ids = new Set(previous.map(row => row.id))
  const fileId = fileNodeId(file.path)
  ids.add(fileId)
  // Only ids that will NOT exist after this write may take their inbound edges
  // with them. An id that survives (a renamed function body, a re-parsed file
  // whose symbols are unchanged) keeps every reference other files made to it —
  // deleting those would be silent data loss that the incremental pass never
  // repairs, because the referencing files are not re-parsed.
  const next = new Set(symbols.map(symbol => symbol.id))
  // The file node itself always survives: `imports` edges target it, and it has
  // no symbol row to appear in `next`.
  const retired = [...ids].filter(id => id !== fileId && !next.has(id))

  const deleteOutgoing = db.prepare('DELETE FROM edges WHERE src = ?')
  const deleteIncoming = db.prepare('DELETE FROM edges WHERE dst = ?')

  db.exec('BEGIN')
  try {
    // Every outgoing edge is re-emitted by this write, so all of them go.
    for (const id of ids) deleteOutgoing.run(id)
    // Inbound edges go only for ids this file no longer declares.
    for (const id of retired) deleteIncoming.run(id)
    db.prepare('DELETE FROM symbols WHERE path = ?').run(file.path)

    db.prepare('INSERT INTO files (path, mtime, size, hash, lang) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash, lang = excluded.lang')
      .run(file.path, file.mtime, file.size, file.hash, file.lang)

    const insertSymbol = db.prepare('INSERT INTO symbols (id, path, name, kind, line, parent) VALUES (?, ?, ?, ?, ?, ?)')
    for (const symbol of symbols) {
      insertSymbol.run(symbol.id, symbol.path, symbol.name, symbol.kind, symbol.line, symbol.parent ?? null)
    }
    // OR IGNORE, not a bare INSERT: the primary key is what collapses a
    // duplicate observation, and a parse that reports the same reference twice
    // is not an error worth failing the whole file over.
    const insertEdge = db.prepare('INSERT OR IGNORE INTO edges (src, dst, kind, line) VALUES (?, ?, ?, ?)')
    for (const edge of edges) {
      insertEdge.run(edge.from, edge.to, edge.kind, edge.line)
    }
    db.exec('COMMIT')
  } catch (error) {
    // `COMMIT` itself can fail (SQLITE_BUSY, a full disk), and SQLite may have
    // rolled the transaction back already. A second ROLLBACK then throws "no
    // transaction is active", which would REPLACE the real cause — so it gets
    // its own guard and the original error always wins.
    try { db.exec('ROLLBACK') } catch { /* already rolled back, or never began */ }
    throw error
  }
}

/**
 * Drop a file and everything it contributed.
 *
 * The CALLER owns detecting that a path is gone: `replaceFile` only touches rows
 * under the path it is given, so a rename leaves the old path's symbols behind
 * until someone calls this. The incremental pass is that someone — it diffs the
 * disk against {@link readFiles} and calls `forgetFile` for every path in the
 * graph that no longer exists.
 *
 * @param db - the open database.
 * @param path - the project-relative path to forget.
 */
export function forgetFile(db: DatabaseSync, path: string): void {
  const rows = db.prepare('SELECT id FROM symbols WHERE path = ?').all(path) as { id: string }[]
  const ids = new Set(rows.map(row => row.id))
  ids.add(fileNodeId(path))
  db.exec('BEGIN')
  try {
    for (const id of ids) {
      db.prepare('DELETE FROM edges WHERE src = ?').run(id)
      db.prepare('DELETE FROM edges WHERE dst = ?').run(id)
    }
    db.prepare('DELETE FROM symbols WHERE path = ?').run(path)
    db.prepare('DELETE FROM files WHERE path = ?').run(path)
    db.exec('COMMIT')
  } catch (error) {
    // `COMMIT` itself can fail (SQLITE_BUSY, a full disk), and SQLite may have
    // rolled the transaction back already. A second ROLLBACK then throws "no
    // transaction is active", which would REPLACE the real cause — so it gets
    // its own guard and the original error always wins.
    try { db.exec('ROLLBACK') } catch { /* already rolled back, or never began */ }
    throw error
  }
}

/** The node id a file itself carries (the source of `imports` and `contains`). */
export function fileNodeId(path: string): string {
  return `file:${path}`
}

/** The node id a document paragraph carries (the source of `documents`). */
export function documentNodeId(path: string, line: number): string {
  return `doc:${path}#${String(line)}`
}

/** Counts for the settings page and the tool output. */
export function graphStats(db: DatabaseSync): { files: number, symbols: number, edges: number } {
  const files = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n
  const symbols = (db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n
  const edges = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n
  return { files, symbols, edges }
}
