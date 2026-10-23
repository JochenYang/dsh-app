/**
 * The three model-facing tools, and the query layer under them.
 *
 * Why exactly three. A tool list is prompt budget and a choice the model has to
 * make on every turn; the previous round in this repository paid for that with
 * two delegation sections competing for the same decision. These three split by
 * the QUESTION asked, not by the data touched:
 *
 *   - `codegraph_find`    "where is X declared" — a name lookup.
 *   - `codegraph_impact`  "who is affected if I change X" — a reverse walk.
 *   - `codegraph_context` "what do I need to know about X" — the node plus its
 *                         edges plus the documents that describe it.
 *
 * Every answer carries the graph's freshness. A tool that returns symbols from a
 * snapshot two hours old without saying so is worse than one that refuses: the
 * model cannot tell "no callers" from "we did not look".
 *
 * @module @dsh-app/plugin-codegraph/host/tools
 */

import { allRows, oneRow, type Graph } from './store.ts'

/**
 * How fresh the graph is, as every answer reports it.
 *
 * Only three states are reachable: a project touched for the first time is put on
 * the queue and reports `indexing`, never `unindexed` — the store type keeps
 * `unindexed` for the queue's own pre-first-run bookkeeping, but a tool answer
 * that reported it would promise a state nothing ever produces.
 */
export type Freshness = 'current' | 'stale' | 'indexing'

/** The envelope every tool result shares. */
export interface ToolEnvelope {
  /** Whether the graph reflects the working tree. */
  readonly freshness: Freshness
  /** One sentence the model can act on when `freshness` is not `current`. */
  readonly note: string | undefined
}

/** One symbol row as a tool reports it. */
export interface SymbolView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly line: number
  readonly parent: string | undefined
}

/** One edge as a tool reports it. */
export interface EdgeView {
  readonly kind: string
  readonly line: number
  /** The other end of the edge, resolved to a path when it names a file. */
  readonly path: string | undefined
  /** The other end's symbol name, when it is a symbol. */
  readonly name: string | undefined
}

/** The result of `codegraph_find`. */
export interface FindResult extends ToolEnvelope {
  readonly symbols: readonly SymbolView[]
  /** True when the name matched more symbols than were returned. */
  readonly truncated: boolean
}

/** The result of `codegraph_impact`. */
export interface ImpactResult extends ToolEnvelope {
  /** The symbol the question was about, when the id or name resolved. */
  readonly target: SymbolView | undefined
  /**
   * What references the target, with the line and the calling symbol.
   *
   * Typed as {@link Referrer} rather than as an inline shape: an inline
   * `{path, line, kind}` was structurally satisfied by the richer value W11b
   * produces, so `tsc` accepted a result whose `name` the output schema had not
   * declared — and `additionalProperties: false` turns an undeclared field into
   * INVALID_TOOL_OUTPUT for the whole answer. The type now names every field the
   * value carries, so a schema that falls behind is a type error rather than a
   * tool that fails on its most common input.
   */
  readonly referencing: readonly Referrer[]
  /** Files the target's file imports (the forward direction, for orientation). */
  readonly imports: readonly string[]
}

/** The result of `codegraph_context`. */
export interface ContextResult extends ToolEnvelope {
  readonly symbol: SymbolView | undefined
  /** Symbols declared in the same file. */
  readonly siblings: readonly SymbolView[]
  /** What this symbol calls (outgoing references). */
  readonly calls: readonly EdgeView[]
  /** What calls it (incoming references). */
  readonly calledBy: readonly EdgeView[]
  /** Files this symbol's file imports. */
  readonly imports: readonly string[]
  /**
   * Where this project's own prose names this symbol.
   *
   * The point of the whole `documents` edge: "what is this for" is answered by a
   * paragraph, and a model given only the declaration will guess. Each entry
   * names the file and the line, so a reader can open the sentence that explains
   * the code rather than a whole document.
   */
  readonly documents: readonly DocumentRef[]
}

/** One place a document mentions a symbol. */
export interface DocumentRef {
  /** The document's project-relative path. */
  readonly path: string
  /** 1-based line in that document. */
  readonly line: number
}

/** The note a freshness value carries. */
export function freshnessNote(freshness: Freshness, truncated: boolean, removalSkipped: boolean): string | undefined {
  const parts: string[] = []
  if (freshness === 'indexing') parts.push('The graph is being built right now; this answer may be incomplete (a project touched for the first time is indexing). Ask again in a moment.')
  if (freshness === 'stale') parts.push('The graph is older than the working tree. Results describe an earlier state; a rebuild is running, so ask again in a moment.')
  if (truncated) parts.push('The index hit its file budget, so only part of the project is covered.')
  if (removalSkipped) parts.push('The last pass could not verify deletions, so removed files may still appear.')
  return parts.length === 0 ? undefined : parts.join(' ')
}

/**
 * The raw shape of a symbols-table row.
 *
 * `parent` is NULL in SQL and `undefined` in this plugin's view; the helpers
 * below do that one conversion, which is the only place the two differ.
 */
interface SymbolRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly line: number
  readonly parent: string | null
}

/** The view-side conversion, applied once per row. */
function toSymbolView(row: SymbolRow): SymbolView {
  return { ...row, parent: row.parent ?? undefined }
}

/** Read one symbol row by id. */
export function readSymbol(graph: Graph, id: string): SymbolView | undefined {
  const row = oneRow<SymbolRow>(graph.db, 'SELECT id, name, kind, path, line, parent FROM symbols WHERE id = ?', id)
  return row === undefined ? undefined : toSymbolView(row)
}

/** The SELECT list every symbol query shares; a change here is a schema change. */
const SYMBOL_COLUMNS = 'id, name, kind, path, line, parent'

/** Find symbols by exact name, or by a case-insensitive substring. */
export function findSymbols(graph: Graph, query: string, limit: number): { symbols: SymbolView[], truncated: boolean } {
  const exact = allRows<SymbolRow>(
    graph.db,
    `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE name = ? ORDER BY path, line LIMIT ?`,
    query, limit + 1,
  )
  // Exact matches win outright: a model asking for `diffRulerMarks` means that
  // symbol, not every symbol containing "diff". The +1 in each LIMIT is what
  // lets `truncated` be a fact rather than a guess.
  const rows = exact.length > 0
    ? exact
    : allRows<SymbolRow>(
      graph.db,
      `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE name LIKE ? ORDER BY path, line LIMIT ?`,
      `%${query}%`, limit + 1,
    )
  return {
    symbols: rows.slice(0, limit).map(toSymbolView),
    truncated: rows.length > limit,
  }
}

/** The raw shape of an edge row read by its source or destination. */
interface EdgeRow {
  readonly src: string
  readonly line: number
  readonly kind: string
}

/** One place that references a symbol. */
export interface Referrer {
  /** The referring file. */
  readonly path: string
  /** The line of the reference. */
  readonly line: number
  /** The edge kind (always `references` here). */
  readonly kind: string
  /**
   * The referring SYMBOL's name, or undefined when the reference is at file
   * scope.
   *
   * "`resolveName` calls this" is actionable; "somewhere in this file" is not.
   */
  readonly name: string | undefined
}

/**
 * What points at this symbol: the calling symbol, its file, and the line.
 *
 * The edge's `src` is a SYMBOL id when the call sits inside a declaration, and
 * `file:<path>` when it sits at file scope. Both are unpacked here, so a caller
 * never has to know which kind it is looking at — and the answer names the
 * FUNCTION that calls this one, which is what makes `impact` actionable.
 *
 * @param graph - the open graph.
 * @param symbolId - the destination symbol.
 * @param limit - how many edges to return.
 * @returns the referrers in a stable order.
 */
export function referencesTo(graph: Graph, symbolId: string, limit: number): Referrer[] {
  // Joined on the SOURCE symbol so a symbol-level edge can name its caller. A
  // file-level edge has no symbol row to join, which is what the LEFT JOIN and
  // the `name` fallback handle.
  const rows = allRows<{ src: string, line: number, kind: string, name: string | null, path: string | null }>(
    graph.db,
    `SELECT e.src AS src, e.line AS line, e.kind AS kind, s.name AS name, s.path AS path
     FROM edges e LEFT JOIN symbols s ON s.id = e.src
     WHERE e.dst = ? AND e.kind = 'references' ORDER BY e.src, e.line LIMIT ?`,
    symbolId, limit,
  )
  return rows.map((row) => {
    if (row.src.startsWith('file:')) {
      return { path: row.src.replace(/^file:/u, ''), line: row.line, kind: row.kind, name: undefined }
    }
    // A symbol id is `<path>#<kind>:<name>`; the join gives both parts, but fall
    // back to unpacking the id when the row is gone (a symbol removed between two
    // passes, which the next pass settles).
    if (row.path !== null && row.name !== null) {
      return { path: row.path, line: row.line, kind: row.kind, name: row.name }
    }
    const hash = row.src.lastIndexOf('#')
    return { path: hash > 0 ? row.src.slice(0, hash) : row.src, line: row.line, kind: row.kind, name: undefined }
  })
}

/** Files this file imports. */
export function importsOf(graph: Graph, path: string, limit: number): string[] {
  const rows = allRows<{ dst: string }>(
    graph.db,
    "SELECT dst FROM edges WHERE src = ? AND kind = 'imports' ORDER BY dst LIMIT ?",
    `file:${path}`, limit,
  )
  return rows.map(row => row.dst.replace(/^file:/u, ''))
}

/** An outgoing edge joined to the symbol it points at. */
interface OutgoingRow {
  readonly kind: string
  readonly line: number
  readonly name: string | null
  readonly path: string | null
}

/** Outgoing reference edges of one symbol, resolved to names. */
export function callsOf(graph: Graph, symbolId: string, limit: number): EdgeView[] {
  const rows = allRows<OutgoingRow>(
    graph.db,
    `SELECT e.kind AS kind, e.line AS line, s.name AS name, s.path AS path
     FROM edges e LEFT JOIN symbols s ON s.id = e.dst
     WHERE e.src = ? AND e.kind = 'references' ORDER BY e.line LIMIT ?`,
    symbolId, limit,
  )
  return rows.map(row => ({ kind: row.kind, line: row.line, name: row.name ?? undefined, path: row.path ?? undefined }))
}

/** Incoming reference edges of one symbol, resolved to the calling file. */
export function calledBy(graph: Graph, symbolId: string, limit: number): EdgeView[] {
  const rows = allRows<EdgeRow>(
    graph.db,
    "SELECT src, line, kind FROM edges WHERE dst = ? AND kind = 'references' ORDER BY src, line LIMIT ?",
    symbolId, limit,
  )
  return rows.map(row => ({ kind: row.kind, line: row.line, path: row.src.replace(/^file:/u, ''), name: undefined }))
}

/**
 * The documents that name one symbol.
 *
 * The edge targets the document FILE (`file:<path>`) and carries the mention's
 * line in its own `line` column, so this is a plain read — no id to unpack, and
 * a path containing `#` is just a path.
 *
 * @param graph - the open graph.
 * @param symbolId - the symbol's node id.
 * @param limit - how many mentions to return.
 * @returns the document locations, in document order.
 */
export function documentsFor(graph: Graph, symbolId: string, limit: number): DocumentRef[] {
  const rows = allRows<{ dst: string, line: number }>(
    graph.db,
    "SELECT dst, line FROM edges WHERE src = ? AND kind = 'documents' ORDER BY dst, line LIMIT ?",
    symbolId, limit,
  )
  return rows.map(row => ({ path: row.dst.replace(/^file:/u, ''), line: row.line }))
}

/** Every symbol declared in one file. */
export function symbolsInFile(graph: Graph, path: string, limit: number): SymbolView[] {
  const rows = allRows<SymbolRow>(
    graph.db,
    `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE path = ? ORDER BY line LIMIT ?`,
    path, limit,
  )
  return rows.map(toSymbolView)
}

/**
 * Resolve a tool argument to a symbol: an exact id, or an unambiguous name.
 *
 * Ambiguity answers `undefined` rather than the first match — the same rule the
 * parser follows for call edges, for the same reason: a wrong answer that looks
 * right is worse than a refusal the model can react to.
 *
 * @param graph - the open graph.
 * @param selector - an id or a name.
 * @returns the symbol, or undefined when nothing matched or several did.
 */
export function resolveSymbol(graph: Graph, selector: string): SymbolView | undefined {
  const byId = readSymbol(graph, selector)
  if (byId !== undefined) return byId
  // Two rows is enough to know a name is ambiguous; asking for all of them
  // would read the whole table for a question that only needs "is it 1?".
  const rows = allRows<{ id: string }>(graph.db, 'SELECT id FROM symbols WHERE name = ? LIMIT 2', selector)
  if (rows.length !== 1) return undefined
  return readSymbol(graph, rows[0]!.id)
}

/**
 * Drop every `undefined`-valued key, recursively.
 *
 * The kernel's tool-result pipeline runs `snapshotJsonValue` before the schema
 * check, and a single `undefined` property makes it return `undefined` —
 * measured: `snapshotJsonValue({ a: 1, b: undefined })` is `undefined`, which
 * `createSuccessResult` turns into `INVALID_TOOL_OUTPUT`. The schema validator
 * would tolerate it; the snapshot step does not, and it runs first.
 *
 * So an optional field is omitted, never set to `undefined`. `null` is not a
 * substitute: the schema declares these as `string`, and `null` fails it.
 *
 * Called at the tool boundary rather than inside each query helper: the shape the
 * model receives is what has to be lossless, and one exit point is easier to keep
 * honest than a dozen return statements.
 */
export function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    return items.map(item => dropUndefined(item)) as T
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(source)) {
      if (item === undefined) continue
      out[key] = dropUndefined(item)
    }
    return out as T
  }
  return value
}

/** Render a symbol as the one line a tool result shows. */
export function formatSymbol(symbol: SymbolView): string {
  const parent = symbol.parent === undefined ? '' : `${symbol.parent}.`
  return `${symbol.kind} ${parent}${symbol.name} — ${symbol.path}:${String(symbol.line)}`
}
