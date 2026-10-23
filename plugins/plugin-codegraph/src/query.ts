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
  readonly symbol?: SymbolView | undefined
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
  /**
   * The project's shape, present only when no symbol was named.
   *
   * The one question the other fields cannot answer: they all describe a symbol,
   * and "what is this project" starts from no symbol at all.
   */
  readonly overview?: ProjectOverview | undefined
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

/** One entry point candidate: a file nothing else in the project imports. */
export interface EntryCandidate {
  /** The project-relative path. */
  readonly path: string
  /** The symbol a reader starts at, when the file declares one. */
  readonly symbol: SymbolView | undefined
  /** How many symbols the file declares. */
  readonly symbols: number
}

/** One symbol that many others depend on. */
export interface HubSymbol {
  readonly symbol: SymbolView
  /** How many distinct places reference it. */
  readonly references: number
}

/**
 * What a project consists of, for the question no symbol name can answer.
 *
 * The three tools answered "where is X" and "what does X touch"; every one of
 * them needed a name, so a model asked "where does this project start" had
 * nothing to call and fell back to listing directories and reading files — the
 * exact cost this plugin exists to remove. Measured: a session with the graph
 * built still answered an orientation question with `working_directory`,
 * `查找文件` and four `读取` calls, because the question names no symbol.
 *
 * So this answers from the graph's own shape:
 *   - **entry candidates**: files whose imports-in degree is zero. In a project
 *     with one entry that is the entry; in a library it is the public surface.
 *   - **hubs**: the most-referenced symbols, i.e. what to read before changing
 *     anything, and the fastest way to learn the vocabulary of an unfamiliar repo.
 *   - **by language**: how the project splits, so a model can tell a TypeScript
 *     service from the Go tool beside it without opening a file.
 *
 * Every list is bounded and reports its own truncation, because "there are 400
 * files" is a fact and "here are 40 of them" is what fits.
 */
export interface ProjectOverview {
  /** Files, symbols and edges in the graph. */
  readonly files: number
  readonly symbols: number
  readonly edges: number
  /** Files per language id, largest first. */
  readonly byLanguage: { readonly lang: string, readonly files: number }[]
  /** Files nothing else imports, most-substantial first. */
  readonly entryCandidates: EntryCandidate[]
  /** The most-referenced symbols. */
  readonly hubs: HubSymbol[]
  /** True when any list was cut to its limit. */
  readonly truncated: boolean
}

/**
 * Answer "what is this project" from the graph alone.
 *
 * @param graph - the open graph.
 * @param limit - how many rows each of the three lists may carry.
 * @returns the bounded overview.
 */
export function projectOverview(graph: Graph, limit: number): ProjectOverview {
  const counts = oneRow<{ files: number, symbols: number, edges: number }>(
    graph.db,
    `SELECT (SELECT COUNT(*) FROM files) AS files,
            (SELECT COUNT(*) FROM symbols) AS symbols,
            (SELECT COUNT(*) FROM edges) AS edges`,
  ) ?? { files: 0, symbols: 0, edges: 0 }

  // Documents hold no symbols and import nothing, so counting them as entry
  // candidates would fill the list with READMEs. The `lang` column is what tells
  // them apart without a second table.
  const languages = allRows<{ lang: string, files: number }>(
    graph.db,
    `SELECT lang, COUNT(*) AS files FROM files WHERE lang <> 'document'
     GROUP BY lang ORDER BY files DESC, lang ASC`,
  )

  // In-degree zero over `imports` edges, computed in one statement: a file is an
  // entry candidate when nothing imports it. `LIMIT ? + 1` so truncation is
  // observed rather than guessed, the same rule `findSymbols` follows.
  //
  // Test, example and script files are ordered LAST rather than filtered out.
  // Measured on a real 1771-file monorepo: the unguarded query filled all six
  // rows with `*.test.ts` files, because a test is imported by nothing — true,
  // and useless as "where does this project start". Filtering them out entirely
  // would answer an empty list for a project made mostly of tests, so they stay
  // in the list at the end, where a reader can still see them.
  //
  // A conventional entry FILENAME is promoted above a plain zero-in-degree file.
  // In-degree alone misses the real entry: measured on the same monorepo, the
  // CLI is imported by its own `bun/cli.ts` wrapper, so it has in-degree one and
  // never appeared — while a 371-symbol HTML template did. `cli`/`main`/`index`
  // is what a project's own convention calls a start, and that signal is worth
  // more than the edge count here.
  const entryRows = allRows<{ path: string, n: number }>(
    graph.db,
    `SELECT f.path AS path, COUNT(s.id) AS n
     FROM files f
     LEFT JOIN symbols s ON s.path = f.path
     WHERE f.lang <> 'document'
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE e.kind = 'imports' AND e.dst = ('file:' || f.path)
       )
     GROUP BY f.path
     ORDER BY
       CASE
         WHEN f.path LIKE '%test%' OR f.path LIKE '%spec%'
           OR f.path LIKE '%example%' OR f.path LIKE '%fixture%'
           OR f.path LIKE '%/scripts/%' THEN 2
         WHEN f.path LIKE '%/cli.ts' OR f.path LIKE '%/main.ts'
           OR f.path LIKE '%/index.ts' OR f.path LIKE '%/entry.ts'
           OR f.path LIKE '%/app.ts' OR f.path LIKE '%/cli.js'
           OR f.path LIKE '%/main.js' OR f.path LIKE '%/index.js' THEN 0
         ELSE 1
       END ASC,
       n DESC, f.path ASC
     LIMIT ?`,
    limit + 1,
  )

  const hubRows = allRows<{ id: string, n: number }>(
    graph.db,
    // Top-level declarations only, and never a `variable`.
    //
    // Measured on a real 1771-file project: the unguarded query ranked
    // `.filter` (975 referrers), `.trim` (512) and `.includes` (476) as the
    // project's hubs — built-in method names that happen to match a variable the
    // parser recorded, which tell a reader nothing about this codebase. Nested
    // declarations and bare variables are where those collisions live; a
    // top-level function or type is a real public surface.
    //
    // A test helper is demoted for the same reason a test file is: measured on
    // the same project, `chatSetup` in `test/chat-support.ts` outranked every
    // production symbol because tests call it everywhere. It is a real hub — but
    // not the one to read first when learning the codebase.
    `SELECT e.dst AS id, COUNT(DISTINCT e.src) AS n
     FROM edges e JOIN symbols s ON s.id = e.dst
     WHERE e.kind = 'references'
       AND s.parent IS NULL
       AND s.kind IN ('function', 'class', 'interface', 'type', 'enum')
     GROUP BY e.dst
     ORDER BY
       CASE WHEN s.path LIKE '%test%' OR s.path LIKE '%spec%'
                  OR s.path LIKE '%fixture%' THEN 1 ELSE 0 END ASC,
       n DESC, e.dst ASC
     LIMIT ?`,
    limit + 1,
  )

  const entryCandidates = entryRows.slice(0, limit).map(row => {
    // The first symbol in the file is the reader's starting point; a file of
    // pure re-exports has none, which the type admits.
    const first = oneRow<SymbolRow>(
      graph.db,
      `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE path = ? ORDER BY line LIMIT 1`,
      row.path,
    )
    return {
      path: row.path,
      symbol: first === undefined ? undefined : toSymbolView(first),
      symbols: row.n,
    }
  })

  const hubs = hubRows.slice(0, limit).flatMap(row => {
    const symbol = readSymbol(graph, row.id)
    return symbol === undefined ? [] : [{ symbol, references: row.n }]
  })

  return {
    files: counts.files,
    symbols: counts.symbols,
    edges: counts.edges,
    byLanguage: languages,
    entryCandidates,
    hubs,
    truncated: entryRows.length > limit || hubRows.length > limit,
  }
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
