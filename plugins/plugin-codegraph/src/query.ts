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

import { allRows, fileNodeId, oneRow, type Graph } from './store.ts'

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

/**
 * One `codegraph_find` match, with the count that decides the next tool.
 *
 * The count is here so the model can choose between `codegraph_impact` and a text
 * search before paying for either. Measured: `streamWithDeltas` has 7 grep matches
 * and 6 edges, so grep is cheaper and choosing it is correct; `setResponses` has 482
 * grep matches — about 15k tokens plus a line-by-line judgement — and the model
 * still reached for grep, because nothing in the answer said how large the question
 * was. A caller count is that statement.
 */
export interface FoundSymbol extends SymbolView {
  /** How many reference edges point at it. */
  readonly references: number
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
  readonly symbols: readonly FoundSymbol[]
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
  /**
   * True when a list was cut to the row limit.
   *
   * Without it a symbol with 200 callers answered 40 rows and looked complete: the
   * model would edit the symbol believing it had seen every caller. This plugin's
   * own rule — a truncated answer must say so — is what `findSymbols` and
   * `projectOverview` already follow; this was the one place that broke it in the
   * direction that changes code.
   */
  readonly truncated: boolean
  /**
   * How many reference edges exist in total, when the list was cut.
   *
   * "There are more" without a size is a warning the reader cannot act on: 45 or
   * 6000 is the difference between "read a bit more" and "this symbol is load
   * bearing, do not judge it from a sample".
   */
  readonly total: number
  /**
   * The declarations that share this name, when the selector resolved to none.
   *
   * An ambiguous name and an absent one used to render identically — "no
   * unambiguous symbol matched" — so a symbol declared twice looked like a symbol
   * nobody calls. Measured: `streamWithDeltas` is declared in both `faux.ts` and a
   * test harness, every edge to it was dropped as ambiguous, and the answer read as
   * "no callers". Naming the candidates turns that into a next step.
   */
  readonly candidates: readonly SymbolView[]
  /**
   * The other relationships pointing at this symbol, one group per kind.
   *
   * `extends`, `implements` and `type_refs` are separate from `referencing` because
   * they answer different questions: a class that implements an interface does not
   * call it, and "who implements this" is the question a reader has about an
   * interface. Merging them would make the call count wrong in both directions.
   */
  readonly related: readonly { readonly kind: string, readonly rows: readonly Referrer[] }[]
  /**
   * How many declarations share the name, when the selector was ambiguous.
   *
   * Present only in that case: a number here means "the edges for this name were
   * never built", which is the fact the old answer hid.
   */
  readonly ambiguity?: number | undefined
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
  /**
   * One file's outline, present when the selector named a FILE instead of a symbol.
   *
   * "What does this file declare" is a structural question: no keyword search can
   * answer "list the methods of this class", because the definitions do not mention
   * it. Each row carries its own reference count, which is what separates a file's
   * public surface from its internal helpers.
   */
  readonly file?: {
    readonly path: string
    readonly symbols: readonly {
      readonly id: string
      readonly name: string
      readonly kind: string
      readonly path: string
      readonly line: number
      readonly parent: string | undefined
      readonly references: number
      /** True when this module publishes the symbol. */
      readonly exported: boolean
    }[]
    /** Modules this file republishes whole (`export * from './x'`). */
    readonly reExports: readonly string[]
  } | undefined
  /**
   * True when any of the symbol's lists was cut to the row limit.
   *
   * Same reason as `ImpactResult.truncated`: a 40-entry `calledBy` that is really
   * 300 is a wrong answer stated confidently.
   */
  readonly truncated?: boolean | undefined
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
export function findSymbols(graph: Graph, query: string, limit: number): { symbols: FoundSymbol[], truncated: boolean } {
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
  const kept = rows.slice(0, limit)
  // ONE query for every kept symbol's caller count, not one per row.
  //
  // This number is what lets the model choose between `codegraph_impact` and a text
  // search BEFORE spending either. Measured: `streamWithDeltas` has 7 grep matches
  // and 6 graph edges, so `grep` is the cheaper tool and the model correctly picked
  // it; `setResponses` has 482 grep matches, where grep costs ~15k tokens and a row
  // of judgement per line, and the model still reached for grep because nothing told
  // it the size beforehand. A caller count in this answer is that signal.
  const counts = new Map<string, number>()
  if (kept.length > 0) {
    const placeholders = kept.map(() => '?').join(', ')
    for (const row of allRows<{ dst: string, n: number }>(
      graph.db,
      `SELECT dst, COUNT(*) AS n FROM edges WHERE kind = 'references' AND dst IN (${placeholders}) GROUP BY dst`,
      ...kept.map(row => row.id),
    )) counts.set(row.dst, row.n)
  }
  return {
    symbols: kept.map(row => ({ ...toSymbolView(row), references: counts.get(row.id) ?? 0 })),
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
/**
 * The other relationships that point at one symbol, grouped by kind.
 *
 * Kept apart from `referencesTo` on purpose: "who calls this" and "what implements
 * this" are different questions, and merging them would make a call count wrong.
 * Before this existed, `impact` on an interface answered only the places that NAME
 * it — never the classes that implement it — which is the question a reader actually
 * has about an interface.
 *
 * @param graph - the open graph.
 * @param symbolId - the destination symbol.
 * @param limit - how many rows a single kind may carry.
 * @returns one group per kind that has any rows, plus whether anything was cut.
 */
export function relatedTo(graph: Graph, symbolId: string, limit: number): { groups: { kind: string, rows: Referrer[] }[], truncated: boolean } {
  const kinds = ['extends', 'implements', 'type_refs', 'exports'] as const
  const groups: { kind: string, rows: Referrer[] }[] = []
  let truncated = false
  for (const kind of kinds) {
    const rows = allRows<{ src: string, line: number, name: string | null, path: string | null }>(
      graph.db,
      `SELECT e.src AS src, e.line AS line, s.name AS name, s.path AS path
       FROM edges e LEFT JOIN symbols s ON s.id = e.src
       WHERE e.dst = ? AND e.kind = ? ORDER BY e.src, e.line LIMIT ?`,
      symbolId, kind, limit + 1,
    )
    if (rows.length > limit) truncated = true
    if (rows.length === 0) continue
    groups.push({
      kind,
      rows: rows.slice(0, limit).map(row => ({
        path: row.path ?? row.src.replace(/^file:/u, ''),
        line: row.line,
        kind,
        name: row.name ?? undefined,
      })),
    })
  }
  return { groups, truncated }
}

/**
 * The type references one declaration carries in its signature.
 *
 * The forward direction of `type_refs`: "what does this function's signature depend
 * on". Named after the field it answers, not after the edge kind, so the tool's
 * output reads as a sentence.
 *
 * @param graph - the open graph.
 * @param symbolId - the declaration whose signature is in question.
 * @param limit - how many references to return.
 * @returns the type names it mentions.
 */
export function typeRefsOf(graph: Graph, symbolId: string, limit: number): { rows: { path: string | undefined, name: string | undefined, line: number }[], truncated: boolean } {
  const rows = allRows<{ dst: string, line: number }>(
    graph.db,
    `SELECT dst, line FROM edges WHERE src = ? AND kind = 'type_refs' ORDER BY line LIMIT ?`,
    symbolId, limit + 1,
  )
  return {
    rows: rows.slice(0, limit).map(row => {
      const hash = row.dst.lastIndexOf('#')
      return { path: hash > 0 ? row.dst.slice(0, hash) : undefined, name: hash > 0 ? row.dst.slice(hash + 1) : row.dst, line: row.line }
    }),
    truncated: rows.length > limit,
  }
}

/**
 * The relationships that point at one symbol, for `codegraph_impact`.
 *
 * @param graph - the open graph.
 * @param symbolId - the destination symbol.
 * @param limit - how many rows a single kind may carry.
 * @returns one group per kind that has any rows.
 */

export function referencesTo(graph: Graph, symbolId: string, limit: number): { rows: Referrer[], truncated: boolean, total: number } {
  // ROUND-ROBIN ACROSS FILES, not lexicographic order.
  //
  // `ORDER BY e.src LIMIT 40` clusters: measured on a real project, the 40 rows
  // returned for a symbol with 664 call sites across 110 files came from THREE files,
  // and for another symbol from ONE. A sample that concentrated in one file is not a
  // sample — it says "the callers live here", which is false. `ROW_NUMBER()` partitioned
  // by source file makes the first pass take one row per file, so 40 rows name 40
  // different call sites whenever 40 files exist.
  //
  // `limit + 1` keeps `truncated` a fact rather than a guess: a symbol with 200 callers
  // used to answer 40 rows with NO signal, so the model read a complete-looking list
  // that was missing 80% of the callers and would then edit the symbol and miss them.
  const rows = allRows<{ src: string, line: number, kind: string, name: string | null, path: string | null }>(
    graph.db,
    `SELECT src, line, kind, name, path FROM (
       SELECT e.src AS src, e.line AS line, e.kind AS kind, s.name AS name, s.path AS path,
              ROW_NUMBER() OVER (PARTITION BY e.src ORDER BY e.line) AS rank_in_source
       FROM edges e LEFT JOIN symbols s ON s.id = e.src
       WHERE e.dst = ? AND e.kind = 'references'
     )
     ORDER BY rank_in_source, src, line LIMIT ?`,
    symbolId, limit + 1,
  )
  const truncated = rows.length > limit
  return {
    rows: rows.slice(0, limit).map((row) => {
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
    }),
    truncated,
    // "There are more" without "how many" is a warning the reader cannot size:
    // measured on a real project, a symbol with 664 call sites answered 40 rows and
    // `truncated: true`, and the model had no way to know whether "more" meant 45 or
    // 6000. The count is only computed when the answer was actually cut, so the
    // common case pays nothing.
    total: truncated
      ? (graph.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE dst = ? AND kind = 'references'").get(symbolId) as { n: number }).n
      : rows.length,
  }
}

/** Files this file imports. */
export function importsOf(graph: Graph, path: string, limit: number): { rows: string[], truncated: boolean } {
  const rows = allRows<{ dst: string }>(
    graph.db,
    "SELECT dst FROM edges WHERE src = ? AND kind = 'imports' ORDER BY dst LIMIT ?",
    `file:${path}`, limit + 1,
  )
  return {
    rows: rows.slice(0, limit).map(row => row.dst.replace(/^file:/u, '')),
    truncated: rows.length > limit,
  }
}

/** An outgoing edge joined to the symbol it points at. */
interface OutgoingRow {
  readonly kind: string
  readonly line: number
  readonly name: string | null
  readonly path: string | null
}

/** Outgoing reference edges of one symbol, resolved to names. */
export function callsOf(graph: Graph, symbolId: string, limit: number): { rows: EdgeView[], truncated: boolean } {
  const rows = allRows<OutgoingRow>(
    graph.db,
    `SELECT e.kind AS kind, e.line AS line, s.name AS name, s.path AS path
     FROM edges e LEFT JOIN symbols s ON s.id = e.dst
     WHERE e.src = ? AND e.kind = 'references' ORDER BY e.line LIMIT ?`,
    symbolId, limit + 1,
  )
  return {
    rows: rows.slice(0, limit).map(row => ({ kind: row.kind, line: row.line, name: row.name ?? undefined, path: row.path ?? undefined })),
    truncated: rows.length > limit,
  }
}

/** Incoming reference edges of one symbol, resolved to the calling file. */
export function calledBy(graph: Graph, symbolId: string, limit: number): { rows: EdgeView[], truncated: boolean } {
  const rows = allRows<EdgeRow>(
    graph.db,
    "SELECT src, line, kind FROM edges WHERE dst = ? AND kind = 'references' ORDER BY src, line LIMIT ?",
    symbolId, limit + 1,
  )
  return {
    rows: rows.slice(0, limit).map(row => ({ kind: row.kind, line: row.line, path: row.src.replace(/^file:/u, ''), name: undefined })),
    truncated: rows.length > limit,
  }
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
 * @returns the document locations, in document order, and whether more exist.
 */
export function documentsFor(graph: Graph, symbolId: string, limit: number): { rows: DocumentRef[], truncated: boolean } {
  const rows = allRows<{ dst: string, line: number }>(
    graph.db,
    "SELECT dst, line FROM edges WHERE src = ? AND kind = 'documents' ORDER BY dst, line LIMIT ?",
    symbolId, limit + 1,
  )
  return {
    rows: rows.slice(0, limit).map(row => ({ path: row.dst.replace(/^file:/u, ''), line: row.line })),
    truncated: rows.length > limit,
  }
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

/** One symbol of a file, with the count that says whether anything depends on it. */
export interface FileSymbol {
  readonly symbol: SymbolView
  /** How many reference edges point at it, from anywhere including this file. */
  readonly references: number
  /**
   * True when this module publishes the symbol.
   *
   * Not derivable from the count: an exported symbol with no internal caller is
   * still the API, and that is the row a reader wants first.
   */
  readonly exported: boolean
}

/** One file's outline: what it declares, the public surface first. */
export interface FileOutline {
  readonly path: string
  readonly symbols: readonly FileSymbol[]
  /**
   * The modules this file republishes whole (`export * from './x'`).
   *
   * Names a MODULE rather than a declaration, so it has no row in `symbols`; a
   * reader asking what a file publishes still needs to know it re-exports another
   * module's surface.
   *
   * A mutable array, not `readonly`: the tool's output schema describes mutable
   * arrays because that is what the JSON snapshot carries, and typing this `readonly`
   * forced an `as unknown as` at the boundary — a type escape the ratchet counts.
   */
  readonly starReExports: string[]
  /** True when the file declares more symbols than the answer carries. */
  readonly truncated: boolean
}

/**
 * Every symbol one file declares, with each one's reference count.
 *
 * Why this exists. "What does this file define" and "which methods does this class
 * have" are STRUCTURAL questions, and text search answers them badly — measured by
 * the structural/semantic taxonomy work at **6.5% accuracy for refactor-style
 * queries** and **0–10% for "list the symbols in this file"**, because a method
 * definition does not mention its class name and a symbol is not a keyword. The
 * graph holds exactly this list, so it should be askable directly instead of through
 * a symbol the model has to name first.
 *
 * ORDERED BY REFERENCE COUNT, then line. Measured on a real 103-symbol file: line
 * order put only 14 referenced symbols in the first 40 rows, and the file's most
 * depended-on function (664 call sites) happened to land at position 15 by luck.
 * The list exists to answer "what is this module's public surface", and a row that
 * nothing references is not part of that answer — so the surface comes first and the
 * internal helpers follow. Line order is kept as the tiebreak, so a file of equal
 * symbols still reads top to bottom.
 *
 * @param graph - the open graph.
 * @param path - the project-relative file path.
 * @param limit - how many symbols to return.
 * @returns the outline, most-depended-on first.
 */
export function fileOutline(graph: Graph, path: string, limit: number): FileOutline {
  // Counted for the WHOLE file before slicing, so the order is decided by every
  // symbol's references rather than by whichever ones the limit happened to keep.
  const counted = new Map<string, number>()
  for (const row of allRows<{ dst: string, n: number }>(
    graph.db,
    `SELECT e.dst AS dst, COUNT(*) AS n
     FROM edges e JOIN symbols s ON s.id = e.dst
     WHERE e.kind = 'references' AND s.path = ?
     GROUP BY e.dst`,
    path,
  )) counted.set(row.dst, row.n)

  // Which of them this module publishes. Not derivable from the counts above: an
  // exported symbol with no internal caller is still the API, and that is exactly
  // the row a reader wants when asking "what is this module's public surface".
  const exported = new Set<string>()
  for (const row of allRows<{ dst: string }>(
    graph.db,
    "SELECT dst FROM edges WHERE src = ? AND kind = 'exports'",
    fileNodeId(path),
  )) exported.add(row.dst)
  // `export * from './x'` names a MODULE rather than a declaration, so it has no row
  // in the symbol list. Reported separately below, because a reader asking what a
  // file publishes needs to know it republishes another module's surface.
  const starReExports = allRows<{ dst: string }>(
    graph.db,
    "SELECT dst FROM edges WHERE src = ? AND kind = 'exports' AND dst LIKE 'file:%'",
    fileNodeId(path),
  ).map(row => row.dst.replace(/^file:/u, ''))

  const total = (graph.db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE path = ?').get(path) as { n: number }).n
  const rows = allRows<SymbolRow>(
    graph.db,
    `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE path = ? ORDER BY line`,
    path,
  )
  const ordered = rows
    .map(row => ({ row, references: counted.get(row.id) ?? 0 }))
    // Exported first, then by how much depends on it. On a 103-symbol file this is
    // the difference between listing the public surface and listing forty `const`
    // helpers nobody calls.
    .sort((a, b) => {
      const aExported = exported.has(a.row.id) ? 0 : 1
      const bExported = exported.has(b.row.id) ? 0 : 1
      return (aExported - bExported) || (b.references - a.references) || (a.row.line - b.row.line)
    })
  return {
    path,
    symbols: ordered.slice(0, limit).map(entry => ({
      symbol: toSymbolView(entry.row),
      references: entry.references,
      exported: exported.has(entry.row.id),
    })),
    starReExports,
    truncated: total > limit,
  }
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
  /**
   * How many reference edges point at it.
   *
   * Edge count, not distinct sources: this is the number `codegraph_impact`
   * reports and the number its row limit applies to, so one symbol has one count
   * whether the model reads it from the overview or from the tool.
   */
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
    //
    // COUNT(*) over the edges, NOT COUNT(DISTINCT e.src).
    //
    // The distinct-source count was measured at 203 for a symbol whose edge count
    // is 664, and `codegraph_impact` reports the edge count — so the overview named
    // a number a third of what the tool the model is being invited to call would
    // say. Two numbers for one concept is worse than either number alone: the model
    // cannot tell which to trust. This count also matches what the row limit is
    // applied to, so "664 call site(s)" and "TRUNCATED at 40" describe one list.
    `SELECT e.dst AS id, COUNT(*) AS n
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
    // The reader's starting point in the file: the first DECLARATION that does
    // something, not the first symbol of any kind.
    //
    // Measured on a real project, "first by line" answered `type EvalCliOptions`,
    // `variable scriptDir` and `variable AUTH_FILE` as the entry points — true
    // statements about line order and useless as "begin here", because a type
    // alias is a shape and a top-level constant is a config read. A function or a
    // class is what an entry file actually does first.
    const first = oneRow<SymbolRow>(
      graph.db,
      `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE path = ?
       ORDER BY CASE WHEN kind IN ('function', 'class', 'method') THEN 0 ELSE 1 END, line
       LIMIT 1`,
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
 * Why a selector failed to resolve, when it failed because the NAME is shared.
 *
 * `resolveSymbol` answers `undefined` for both "no such symbol" and "several
 * symbols share this name", and the tools rendered those the same way — which made
 * the second case look like the first. Measured on a real project: `streamWithDeltas`
 * was declared twice (a production function and a test helper), so every call edge
 * to it was dropped as ambiguous, and `codegraph_impact` answered "no unambiguous
 * symbol matched" with nothing to act on. The model had no way to learn that the
 * name was shared rather than absent, and concluded the symbol had no callers.
 *
 * Returning the candidates turns a dead end into a next step: pick one of these ids.
 *
 * @param graph - the open graph.
 * @param selector - the name that failed to resolve.
 * @param limit - how many candidates to name.
 * @returns the candidates and how many exist in total.
 */
export function ambiguousCandidates(graph: Graph, selector: string, limit: number): { candidates: SymbolView[], total: number } {
  const total = (graph.db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE name = ?').get(selector) as { n: number }).n
  const rows = allRows<SymbolRow>(
    graph.db,
    `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE name = ? ORDER BY path, line LIMIT ?`,
    selector, limit,
  )
  return { candidates: rows.map(toSymbolView), total }
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
