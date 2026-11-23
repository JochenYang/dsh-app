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
import { parseSymbolQuery, queryTokens, type SymbolQuery } from './search.ts'
import type { SourceRefusal } from './source.ts'
import type { OutlineDetail } from './budget.ts'

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
export interface FoundSymbol extends SignedSymbol {
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
  /**
   * The callee's signature, when this call resolves to exactly one declaration.
   *
   * A shared name links to every declaration of it, and a call line that could
   * mean two functions has no one signature to print — so the field is absent
   * rather than the first candidate's.
   */
  readonly signature?: string | undefined
}

/** The result of `codegraph_find`. */
export interface FindResult extends ToolEnvelope {
  readonly symbols: readonly FoundSymbol[]
  /** True when the name matched more symbols than were returned. */
  readonly truncated: boolean
}

/**
 * How much of ONE list an answer carries.
 *
 * Truncation used to be one boolean for the whole `impact` answer, and the render
 * warned only about `references` — so a symbol whose IMPORTS list was cut at 40 said
 * nothing, and its type-relationship groups said nothing either. Worse, the single
 * boolean made three different quantities share one meaning: a reader could not tell
 * "40 of 664 references" from "40 of 41 imports".
 *
 * Each list now reports its own cut, with the total it was cut from. The aggregate
 * boolean stays for compatibility (a consumer that only wants "is anything missing"
 * keeps working), and it is computed from these — never the other way round.
 */
export interface ListMeta {
  /** Rows in the array the answer carries. */
  readonly shown: number
  /**
   * Rows that exist, when they are known.
   *
   * Absent for the relationship groups: their totals are only counted when the list
   * was actually cut, because counting every kind on every answer would cost a query
   * per kind for a number nobody reads in the common case.
   */
  readonly total?: number | undefined
  /** True when rows exist beyond `shown`. */
  readonly truncated: boolean
}

/** One relationship group: its kind, its rows, and how many of them are shown. */
export interface RelatedGroup {
  readonly kind: string
  readonly rows: readonly Referrer[]
  /** How many rows this kind has in total, when the answer was cut. */
  readonly total?: number | undefined
  /** True when this KIND's list was cut — not the answer's other lists. */
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
  readonly related: readonly RelatedGroup[]
  /**
   * How many declarations share the name, when the selector was ambiguous.
   *
   * Present only in that case: a number here means "the edges for this name were
   * never built", which is the fact the old answer hid.
   */
  readonly ambiguity?: number | undefined
  /**
   * The count for each list this answer carries, one entry per list.
   *
   * The rendering needs it: `truncated` alone says "something was cut" and the
   * text then has to guess which list, which is how the imports and relationship
   * lists ended up silent about their own cuts. Optional so an older consumer that
   * builds an `ImpactResult` by hand still type-checks.
   */
  readonly lists?: ImpactLists | undefined
  /**
   * The test files that reference the target, when any do.
   *
   * A change the tests catch is a change found before a user does, so the test
   * files come out of the reference rows and into a group of their own, where
   * "run these first" is one glance. Absent when no test file references the
   * symbol: an empty group would be a heading with nothing under it.
   */
  readonly tests?: TestFiles | undefined
  /**
   * The callers expanded to `depth` levels, when more than one level was asked
   * for. At the default depth the `referencing` rows are the whole answer.
   */
  readonly callers?: CallerTree | undefined
}

/**
 * Per-list counts for one `impact` answer.
 *
 * One field per list rather than a map: the lists are a fixed, schema-declared set,
 * and a map would let a new list reach the renderer without a schema row — an
 * `additionalProperties: false` failure for the whole answer. The relationship
 * groups are not here: each `RelatedGroup` carries its own `total`/`truncated`,
 * because they are cut independently of each other.
 */
export interface ImpactLists {
  /** The references list — what `total`/`truncated` at the top level describe. */
  readonly references: ListMeta
  /** The target file's imports, which are cut on their own row budget. */
  readonly imports: ListMeta
}

/**
 * The test files that reference a symbol, deduplicated.
 *
 * Mutable arrays, not `readonly`: this value is handed to the tool's output
 * schema, whose inferred type is a mutable array (the JSON snapshot's shape),
 * and typing it `readonly` would force a cast at the boundary — the same
 * trade {@link FileOutline.starReExports} documents.
 */
export interface TestFiles {
  /** The test files, by path, at most {@link MAX_TEST_FILES} of them. */
  readonly files: string[]
  /** How many test files reference the symbol in total. */
  readonly total: number
}

/**
 * One caller in the `depth` tree.
 *
 * A TYPE alias rather than an interface: the tool's output schema writes the
 * tree out to three levels and the innermost `children` is an untyped JSON
 * array, whose element type (`JsonValue`) accepts a type alias's implicit
 * index signature and refuses an interface's lack of one.
 */
export type CallerNode = {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** The file the caller is declared in. */
  readonly path: string
  /** Where it first calls the node above it. */
  readonly line: number
  /** Its own callers, one level down; empty at the requested depth. */
  readonly children: CallerNode[]
  /**
   * True when this symbol already appears higher up the tree, which is where a
   * cycle stops: the node is named and not expanded again.
   */
  readonly repeated?: boolean
  /**
   * How many distinct symbols call this one, present only when that list was
   * cut at {@link MAX_CALLERS_PER_SYMBOL} — so the reader can tell a hub with
   * 300 callers shown as 12 from a function with 12.
   */
  readonly callers?: number
}

/** The caller tree behind one symbol, to the requested depth. */
export interface CallerTree {
  /** The depth that was asked for, after clamping. */
  readonly depth: number
  /** How many nodes the tree carries. */
  readonly nodes: number
  /** True when the NODE budget stopped the walk, so callers are missing from every level it reached. */
  readonly truncated: boolean
  /** The symbols that call the target, one level down from it. */
  readonly roots: CallerNode[]
  /**
   * How many distinct symbols call the target, present only when the roots were
   * cut at {@link MAX_CALLERS_PER_SYMBOL} — the same statement as a node's
   * `callers`, made about the symbol the question was asked of.
   */
  readonly callers?: number | undefined
}

/** How many test files one `impact` answer lists. */
export const MAX_TEST_FILES = 15

/** How many callers one node in the `depth` tree lists. */
export const MAX_CALLERS_PER_SYMBOL = 12

/** How many nodes one `depth` tree may carry before the walk stops. */
export const MAX_CALLER_NODES = 60

/**
 * One row of a file outline, as `codegraph_context` reports it.
 *
 * Named, not inline in {@link ContextResult}: the renderer draws one row per
 * detail level, and the budget has to measure the same row before the level is
 * chosen — two callers that must agree on the shape.
 */
export interface OutlineEntry {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly line: number
  readonly parent: string | undefined
  readonly references: number
  /** True when this module publishes the symbol. */
  readonly exported: boolean
  /** The declaration's head, when the parse found one. */
  readonly signature?: string | undefined
  /** The first sentence of the comment above it, when there is one. */
  readonly doc?: string | undefined
}

/** The result of `codegraph_context`. */
export interface ContextResult extends ToolEnvelope {
  readonly symbol?: SymbolView | undefined
  /** Symbols declared in the same file, each with its head when it has one. */
  readonly siblings: readonly SignedSymbol[]
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
    /**
     * How much each row says — decided in `execute` and read back by the
     * renderer, so the JSON value and the text name one level. The first line
     * prints it.
     */
    readonly detail: OutlineDetail
    /**
     * How many rows the list budget dropped. Present only when it dropped any:
     * the rows shown are the exported and most-referenced ones, and a reader
     * told the count knows what the file still holds that this answer does not.
     */
    readonly cut?: number | undefined
    readonly symbols: readonly OutlineEntry[]
    /** Modules this file republishes whole (`export * from './x'`). */
    readonly reExports: readonly string[]
  } | undefined
  /**
   * The declaration's own source, numbered like `Read` numbers it.
   *
   * Present only on the symbol branch, and only when the file could be read: this
   * is the difference between an answer that says WHERE a declaration is and one a
   * model can edit from. `drift` is carried rather than hidden because the bytes are
   * read now, from disk, while the graph's view of the file may be older.
   */
  readonly source?: SourceView | undefined
  /**
   * Why there is no source, when a symbol was named and none came back.
   *
   * A stable code, not prose: the render turns it into a sentence, so the same
   * refusal does not acquire a second wording on the other side of the wire.
   */
  readonly sourceRefused?: SourceRefusalCode | undefined
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

/** A declaration's source, as a tool reports it. */
export interface SourceView {
  /** The file the text came from. */
  readonly path: string
  /** 1-based first line `text` carries. */
  readonly startLine: number
  /** 1-based last line `text` carries. */
  readonly endLine: number
  /** Line-numbered source, `<n>\t<line>`. */
  readonly text: string
  /** True when the declaration is longer than the answer's budget. */
  readonly truncated: boolean
  /** True when the bytes on disk no longer match what the graph indexed. */
  readonly drift: boolean
}

/**
 * Why a source slice is missing.
 *
 * Re-exported from the reader rather than re-declared: the set is the reader's
 * vocabulary, and a second copy here would let the tool answer with a code the render
 * has no sentence for. The TYPE import keeps this module free of the filesystem work
 * behind it.
 */
export type SourceRefusalCode = SourceRefusal

/** The note a freshness value carries. */
export function freshnessNote(freshness: Freshness, truncated: boolean, removalSkipped: boolean, generatedSkipped = 0): string | undefined {
  const parts: string[] = []
  if (freshness === 'indexing') parts.push('The graph is being built right now; this answer may be incomplete (a project touched for the first time is indexing). Ask again in a moment.')
  if (freshness === 'stale') parts.push('The graph is older than the working tree. Results describe an earlier state; a rebuild is running, so ask again in a moment.')
  if (truncated) parts.push('The index hit its file budget, so only part of the project is covered.')
  if (removalSkipped) parts.push('The last pass could not verify deletions, so removed files may still appear.')
  // The generated-file rule is a shape, not a verdict: a hand-written file with
  // machine-long lines is caught with the bundles. "No such symbol" must not read
  // as final while that is possible, so the count travels with every answer, as
  // `truncated` does.
  if (generatedSkipped > 0) parts.push(`The index skipped ${String(generatedSkipped)} file(s) as generated output (bundles, minified or machine-written files); a name that lives in one of them is not in this answer.`)
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

/**
 * The view-side conversion, applied once per row.
 *
 * Field by field, not `{ ...row }`. A detail row ({@link SymbolDetailRow}) is a
 * `SymbolRow` too, so a spread here would carry `signature` and `doc` into every
 * `SymbolView` — and a tool schema with `additionalProperties: false` turns one
 * undeclared key into an INVALID_TOOL_OUTPUT for the whole answer. Measured the
 * first time this ran: `find` answered `doc: ""` and the schema refused it.
 */
function toSymbolView(row: SymbolRow): SymbolView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    path: row.path,
    line: row.line,
    parent: row.parent ?? undefined,
  }
}

/** Read one symbol row by id. */
export function readSymbol(graph: Graph, id: string): SymbolView | undefined {
  const row = oneRow<SymbolRow>(graph.db, 'SELECT id, name, kind, path, line, parent FROM symbols WHERE id = ?', id)
  return row === undefined ? undefined : toSymbolView(row)
}

/**
 * One symbol's line extent, for a source slice.
 *
 * Deliberately NOT part of {@link SymbolView}: a view is what a tool hands the
 * model, and its output schema lists every property (`additionalProperties:
 * false`). Adding `endLine` to the view would therefore force it into six nested
 * schemas where nothing reads it, and one of them would drift. The extent is an
 * input to the reader in `source.ts`, so it is its own one-row query.
 *
 * @param graph - the project's graph.
 * @param id - the symbol id.
 * @returns both ends when the row exists, `undefined` when it does not.
 */
export function symbolSpan(graph: Graph, id: string): { line: number, endLine: number } | undefined {
  const row = oneRow<{ line: number, endLine: number }>(
    graph.db,
    'SELECT line, end_line AS endLine FROM symbols WHERE id = ?',
    id,
  )
  return row === undefined ? undefined : { line: row.line, endLine: row.endLine }
}

/**
 * How many files the graph holds.
 *
 * Its own function rather than a side effect of `projectOverview`, because it is
 * what tiers the source budget: the overview runs four more queries to answer a
 * question about the project, and a caller that only needs the size must not pay
 * for them.
 *
 * @param graph - the project's graph.
 * @returns the indexed file count.
 */
export function fileCount(graph: Graph): number {
  return oneRow<{ n: number }>(graph.db, 'SELECT COUNT(*) AS n FROM files')?.n ?? 0
}

/** The SELECT list every symbol query shares; a change here is a schema change. */
function symbolColumns(prefix = ''): string {
  return ['id', 'name', 'kind', 'path', 'line', 'parent'].map(column => `${prefix}${column}`).join(', ')
}

/**
 * A symbols-table row with the two v5 columns a detail read adds.
 *
 * Kept apart from {@link SymbolRow} on purpose. Every tool schema is
 * `additionalProperties: false`, so a column must reach only the views whose
 * schema declares it: the plain views keep reading {@link symbolColumns}, and
 * only the queries that hand their rows to a signed or detailed view read these.
 */
interface SymbolDetailRow extends SymbolRow {
  readonly signature: string
  readonly doc: string
}

/** {@link symbolColumns} plus `signature` and `doc`, for the queries that report them. */
function symbolDetailColumns(prefix = ''): string {
  return `${symbolColumns(prefix)}, ${prefix}signature, ${prefix}doc`
}

/**
 * A symbol view that may also carry its head.
 *
 * Carried so a short `find` answer or an outline row can lead with what the
 * symbol takes and returns; absent for a declaration the parser found no head
 * for (a scanner language, a modifiers-only head), never `''`.
 */
export interface SignedSymbol extends SymbolView {
  readonly signature?: string | undefined
}

/** A symbol view that may also carry its head and its summary. */
export interface SymbolDetail extends SignedSymbol {
  readonly doc?: string | undefined
}

/** `''` is how the store says "none": the view omits the key rather than carry it. */
function toSigned(row: SymbolDetailRow): SignedSymbol {
  return {
    ...toSymbolView(row),
    ...(row.signature === '' ? {} : { signature: row.signature }),
  }
}

/** The view with head and summary, each present only when the parse found one. */
function toDetail(row: SymbolDetailRow): SymbolDetail {
  return {
    ...toSigned(row),
    ...(row.doc === '' ? {} : { doc: row.doc }),
  }
}

/**
 * Find symbols, through four tiers of increasingly weak evidence.
 *
 * The ordering is the answer's quality: a caller who types `diffRulerMarks` means
 * THAT symbol, and a substring scan that lists it beside every `diff`-prefixed name
 * makes the right row one of forty. So exact comes first, then a prefix, then a
 * substring scan, and last a multi-word scan.
 *
 * **An exact hit ends the search.** That is not a micro-optimisation: it is the rule
 * that a name the caller typed in full IS the answer, and padding it with
 * `diffRulerMarks` beside `diff` makes the row they wanted one of several. The other
 * tiers merge instead of short-circuiting, because none of them is exact — a tier that
 * fills must not starve the rows a weaker query needs, or `auth` would stop finding
 * `oauth_handler`. Duplicates collapse by id, and the merge order is the priority.
 *
 * Filter prefixes (`kind:`, `path:`, `lang:`, `name:`) narrow every tier alike: they
 * are the caller stating a fact, not a weaker kind of match.
 *
 * @param graph - the project's graph.
 * @param raw - the query, field prefixes included.
 * @param limit - how many rows the answer may carry.
 * @returns the ranked matches, and whether more exist.
 */
export function findSymbols(graph: Graph, raw: string, limit: number): { symbols: FoundSymbol[], truncated: boolean } {
  const query = parseSymbolQuery(raw)
  const text = query.text
  const rows: SymbolDetailRow[] = []
  const merged = new Map<string, SymbolDetailRow>()
  const tier = (extra: readonly string[], params: readonly (string | number)[]): void => {
    for (const row of rowsIn(graph, query, extra, params, limit + 1)) {
      if (!merged.has(row.id)) merged.set(row.id, row)
    }
  }
  if (text === '') {
    tier([], [])
  } else {
    // Case-insensitive on purpose: `LIKE` below is, so a case-sensitive `=` here would
    // make `ruler` miss a symbol named `Ruler` and then rank `RulerFactory` above it in
    // the prefix tier — an order that contradicts "an exact name ends the search".
    const exact = rowsIn(graph, query, ['s.name = ? COLLATE NOCASE'], [text], limit + 1)
    if (exact.length > 0) {
      for (const row of exact) merged.set(row.id, row)
    } else {
      tier(["s.name LIKE ? ESCAPE '\\'"], [`${escapeLike(text)}%`])
      // The substring scan runs BEFORE the multi-word one, and the order is load-bearing:
      // one word is the common query, and a tier that could only repeat its rows must
      // not decide the limit. Every row is ordered by path and line at the end anyway, so
      // tier order decides WHICH rows survive the limit, not how they read.
      tier(["s.name LIKE ? ESCAPE '\\'"], [`%${escapeLike(text)}%`])
      // A MULTI-WORD query: every word must appear in the name (AND, the same meaning
      // FTS5 gives a bare multi-token query). This is the one question a substring scan
      // cannot answer — `marks ruler` is not a substring of anything — and it runs LAST
      // because for one word it could only repeat what the scan above already found.
      //
      // The gate counts the words as WRITTEN, not the tokens left after dropping short
      // ones: `a star` is a two-word query for `aStar`, and gating on the filtered list
      // would skip the only tier that can find it.
      if (queryTokens(text, { keepShort: true }).length > 1) {
        const tokens = queryTokens(text)
        if (tokens.length > 0) {
          tier(
            tokens.map(() => "s.name LIKE ? ESCAPE '\\'"),
            tokens.map(token => `%${escapeLike(token)}%`),
          )
        }
      }
    }
  }
  rows.push(...merged.values())
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
    symbols: kept.map(row => ({ ...toSigned(row), references: counts.get(row.id) ?? 0 })),
    truncated: rows.length > limit,
  }
}

/**
 * One tier: the rows the query's filters and this tier's own condition select.
 *
 * `lang` is the one filter that is not on the symbols table — it is the file's
 * recorded language — so it joins `files`. The join is only added when the filter is
 * present: every extra join on the hot path is paid by the common query that names
 * none of it.
 */
function rowsIn(
  graph: Graph,
  query: SymbolQuery,
  extra: readonly string[],
  params: readonly (string | number)[],
  limit: number,
): SymbolDetailRow[] {
  const conditions = [...extra]
  const values: (string | number)[] = [...params]
  if (query.kind !== undefined) { conditions.push('s.kind = ?'); values.push(query.kind.toLowerCase()) }
  if (query.path !== undefined) { conditions.push("s.path LIKE ? ESCAPE '\\'"); values.push(`%${escapeLike(query.path)}%`) }
  if (query.name !== undefined) { conditions.push("s.name LIKE ? ESCAPE '\\'"); values.push(`%${escapeLike(query.name)}%`) }
  // Lowercased on the VALUE, not on the column: stored kinds and language ids are
  // already lowercase, and `lower(s.kind)` would throw away the index for a filter a
  // caller wrote as `kind:Function`.
  if (query.lang !== undefined) { conditions.push('f.lang = ?'); values.push(query.lang.toLowerCase()) }
  const from = query.lang === undefined ? 'symbols s' : 'symbols s JOIN files f ON f.path = s.path'
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
  return allRows<SymbolDetailRow>(
    graph.db,
    `SELECT ${symbolDetailColumns('s.')} FROM ${from}${where} ORDER BY s.path, s.line LIMIT ?`,
    ...values, limit,
  )
}

/**
 * Escape the LIKE wildcards in a caller's text.
 *
 * A symbol named `parse_100%` is not a wildcard, and unescaped `%` would turn every
 * query for it into "everything". `LIKE ... ESCAPE` is spelled out at the one place
 * that needs it rather than guessed from the string.
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, character => `\\${character}`)
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
  /**
   * True when the referring file itself named the target — a declaration in the
   * same file, or the import clause the name came through. False (or absent
   * from a hand-built row) when the name was matched project-wide: a guess the
   * reader can check. This is what the `✓` on a reference row means.
   */
  readonly narrowed?: boolean | undefined
  /**
   * The referring symbol's id, when the reference sits inside a declaration.
   *
   * Absent for a file-level reference, which has no symbol to expand. This is
   * the key the `depth` tree deduplicates callers by.
   */
  readonly callerId?: string | undefined
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
 * @returns one group per kind that has any rows, each with its own cut and total,
 *   plus whether ANY group was cut.
 */
export function relatedTo(graph: Graph, symbolId: string, limit: number): { groups: RelatedGroup[], truncated: boolean } {
  const kinds = ['extends', 'implements', 'type_refs', 'exports'] as const
  const groups: RelatedGroup[] = []
  let truncated = false
  for (const kind of kinds) {
    const rows = allRows<{ src: string, line: number, name: string | null, path: string | null }>(
      graph.db,
      `SELECT e.src AS src, e.line AS line, s.name AS name, s.path AS path
       FROM edges e LEFT JOIN symbols s ON s.id = e.src
       WHERE e.dst = ? AND e.kind = ? ORDER BY e.src, e.line LIMIT ?`,
      symbolId, kind, limit + 1,
    )
    const cut = rows.length > limit
    if (cut) truncated = true
    if (rows.length === 0) continue
    groups.push({
      kind,
      rows: rows.slice(0, limit).map(row => ({
        path: row.path ?? row.src.replace(/^file:/u, ''),
        line: row.line,
        kind,
        name: row.name ?? undefined,
      })),
      // Counted ONLY when this kind was cut. A group that fits already knows its
      // total (`rows.length`), and counting every kind on every answer would add one
      // query per kind for a number nobody reads in the common case.
      ...(cut ? { total: countEdgesTo(graph, symbolId, kind) } : {}),
      truncated: cut,
    })
  }
  return { groups, truncated }
}

/** How many edges of one kind point at a symbol. Only called when a list was cut. */
function countEdgesTo(graph: Graph, symbolId: string, kind: string): number {
  return (graph.db.prepare('SELECT COUNT(*) AS n FROM edges WHERE dst = ? AND kind = ?').get(symbolId, kind) as { n: number }).n
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
  const rows = allRows<{ src: string, line: number, kind: string, name: string | null, path: string | null, narrowed: number }>(
    graph.db,
    `SELECT src, line, kind, name, path, narrowed FROM (
       SELECT e.src AS src, e.line AS line, e.kind AS kind, s.name AS name, s.path AS path, e.narrowed AS narrowed,
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
      // The confidence mark and the caller's id ride on every row: `narrowed` is
      // 1 only when the referring file itself resolved the name (parse.ts's
      // `linkFor`), and the id is what lets a reader expand a caller in place
      // instead of searching for its name.
      const confidence = { ...(row.narrowed === 1 ? { narrowed: true } : {}) }
      if (row.src.startsWith('file:')) {
        return { path: row.src.replace(/^file:/u, ''), line: row.line, kind: row.kind, name: undefined, ...confidence }
      }
      // A symbol id is `<path>#<kind>:<name>`; the join gives both parts, but fall
      // back to unpacking the id when the row is gone (a symbol removed between two
      // passes, which the next pass settles).
      if (row.path !== null && row.name !== null) {
        return { path: row.path, line: row.line, kind: row.kind, name: row.name, ...confidence, callerId: row.src }
      }
      const hash = row.src.lastIndexOf('#')
      return { path: hash > 0 ? row.src.slice(0, hash) : row.src, line: row.line, kind: row.kind, name: undefined, ...confidence, callerId: row.src }
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
export function importsOf(graph: Graph, path: string, limit: number): { rows: string[], truncated: boolean, total: number } {
  const rows = allRows<{ dst: string }>(
    graph.db,
    "SELECT dst FROM edges WHERE src = ? AND kind = 'imports' ORDER BY dst LIMIT ?",
    `file:${path}`, limit + 1,
  )
  const truncated = rows.length > limit
  return {
    rows: rows.slice(0, limit).map(row => row.dst.replace(/^file:/u, '')),
    truncated,
    // Same rule as `referencesTo`: the total is only queried when the list was cut,
    // so the common answer costs one statement, not two.
    total: truncated ? countEdgesFrom(graph, `file:${path}`, 'imports') : rows.length,
  }
}

/** How many edges of one kind leave a node. Only called when a list was cut. */
function countEdgesFrom(graph: Graph, src: string, kind: string): number {
  return (graph.db.prepare('SELECT COUNT(*) AS n FROM edges WHERE src = ? AND kind = ?').get(src, kind) as { n: number }).n
}

/**
 * Whether a project-relative path is a test file, by the conventions projects
 * actually use rather than by one language's.
 *
 * A directory (`test/`, `tests/`, `__tests__/`, `spec/`), a suffix before the
 * extension (`.test.`, `.spec.`, `.e2e.`), and the three languages whose
 * convention is a filename pattern: Go's `_test.go`, Python's `test_*.py`, and
 * the `FooTest`/`FooTests` class of C#, Java, Kotlin and Swift. That last one
 * is scoped to those extensions on purpose: `*Test.*` unscoped would match a
 * React component named `UnitTest`, which is a test's SUBJECT, not a test.
 *
 * Project-relative with forward slashes, which is how the graph keys a path.
 */
export const TEST_PATH: RegExp = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec|e2e)\.|_test\.go$|(?:^|\/)test_[^/]*\.py$|(?:^|\/)[^/]*Tests?\.(?:cs|java|kt|kts|swift)$/u

/**
 * The test files that reference a symbol, deduplicated.
 *
 * Both kinds of reference count: a call inside a declaration (the edge's `src`
 * is a symbol, whose file is looked up) and a call at file scope (`src` is
 * `file:<path>`). "Run these first" is only true if a test that calls the symbol
 * at top level is in the list, and a test file's calls are often at top level.
 *
 * @param graph - the open graph.
 * @param id - the symbol's node id.
 * @param limit - how many files the answer may carry.
 * @returns the files by path, and how many there are in total.
 */
export function testFilesReferencing(graph: Graph, id: string, limit = MAX_TEST_FILES): { files: string[], total: number } {
  // No REGEXP in SQLite without an application function, so the shape test is
  // done here, on the distinct paths — bounded by how many files reference one
  // symbol, which for the busiest hub in this repository is a few hundred.
  const paths = allRows<{ path: string }>(
    graph.db,
    `SELECT s.path AS path FROM edges e JOIN symbols s ON s.id = e.src
     WHERE e.dst = ? AND e.kind = 'references'
     UNION
     SELECT substr(e.src, 6) FROM edges e
     WHERE e.dst = ? AND e.kind = 'references' AND e.src LIKE 'file:%'`,
    id, id,
  ).map(row => row.path).filter(path => TEST_PATH.test(path))
  paths.sort()
  return { files: paths.slice(0, limit), total: paths.length }
}

/** One caller of a symbol, as the tree's SQL reads it. */
interface CallerRow {
  readonly src: string
  readonly name: string
  readonly path: string
  readonly kind: string
  readonly line: number
}

/**
 * The distinct symbols that call one symbol, in first-call order.
 *
 * Grouped by `src`, so a function that calls the target five times is one
 * caller and its `line` is the first of the five. File-level references are
 * left out: they have no symbol to expand, and `impact`'s `referencing` rows
 * already list them.
 */
function callersOf(graph: Graph, id: string, limit: number): { rows: CallerRow[], total?: number } {
  const rows = allRows<CallerRow>(
    graph.db,
    `SELECT e.src AS src, s.name AS name, s.path AS path, s.kind AS kind, MIN(e.line) AS line
     FROM edges e JOIN symbols s ON s.id = e.src
     WHERE e.dst = ? AND e.kind = 'references'
     GROUP BY e.src
     ORDER BY line, src
     LIMIT ?`,
    id, limit + 1,
  )
  if (rows.length <= limit) return { rows }
  // Counted only when cut, the rule `referencesTo` follows: the common caller
  // pays nothing for a number nobody reads.
  const total = (graph.db.prepare(
    "SELECT COUNT(DISTINCT e.src) AS n FROM edges e JOIN symbols s ON s.id = e.src WHERE e.dst = ? AND e.kind = 'references'",
  ).get(id) as { n: number }).n
  return { rows: rows.slice(0, limit), total }
}

/**
 * The callers of one symbol, expanded breadth-first to `depth` levels.
 *
 * The tree is the `depth > 1` shape of "who calls this": `referencing` names
 * the first level, and this walks the same edges further. Three rules keep it
 * both bounded and true:
 *
 *   - **Breadth first.** Every root is listed before any root's callers are,
 *     so a tree cut by the node budget is complete at every level it shows,
 *     rather than one deep branch and nothing of the others.
 *   - **Deduplicated by id.** A symbol already in the tree reappears as a
 *     `repeated` leaf — which is where a cycle (A calls B calls A) stops
 *     without the walk looping.
 *   - **Two budgets, both reported.** At most `perLevel` callers per node, and
 *     the count of the cut on that node's row; at most `maxNodes` nodes in the
 *     whole tree, which is what `truncated` says.
 *
 * @param graph - the open graph.
 * @param id - the symbol whose callers are wanted.
 * @param depth - how many levels to expand; 1 is the roots alone.
 * @param limits - `perLevel` callers per node and `maxNodes` in total.
 * @returns the tree, its node count and whether the node budget cut it.
 */
export function callerTree(
  graph: Graph,
  id: string,
  depth: number,
  limits: { perLevel?: number, maxNodes?: number } = {},
): CallerTree {
  const perLevel = limits.perLevel ?? MAX_CALLERS_PER_SYMBOL
  const maxNodes = limits.maxNodes ?? MAX_CALLER_NODES
  // Built mutable, read as `CallerNode`: a node's `callers` is known only after
  // its own callers were read, which is after the node itself was placed.
  type Building = { -readonly [K in keyof CallerNode]: CallerNode[K] }
  // NOT seeded with the asked symbol. A recursive function is its own caller, and
  // seeding made that row a `(see above)` leaf with nothing above it; unseeded, the
  // symbol appears once as a caller and its callers — the roots, already placed —
  // are the `(see above)` leaves, which is a true pointer. Every id is added as it
  // is placed, so a cycle still stops.
  const seen = new Set<string>()
  const roots: CallerNode[] = []
  let nodes = 0
  let truncated = false
  /** The nodes of the level being expanded, whose callers the next level adds. */
  let frontier: Building[] = []

  /**
   * Append `parentId`'s callers to `into`, and record on `parent` how many it
   * has when the list was cut — the count belongs to the node whose callers
   * they are, not to the children that happen to be listed.
   */
  const expand = (parentId: string, into: CallerNode[], parent?: Building): number | undefined => {
    const found = callersOf(graph, parentId, perLevel)
    for (const row of found.rows) {
      if (nodes >= maxNodes) { truncated = true; break }
      const repeated = seen.has(row.src)
      const node: Building = {
        id: row.src,
        name: row.name,
        kind: row.kind,
        path: row.path,
        line: row.line,
        children: [],
        ...(repeated ? { repeated: true } : {}),
      }
      seen.add(row.src)
      into.push(node)
      nodes += 1
      if (!repeated) frontier.push(node)
    }
    return found.total
  }

  const rootCallers = expand(id, roots)
  for (let level = 2; level <= depth && !truncated; level += 1) {
    const parents = frontier
    frontier = []
    for (const parent of parents) {
      if (truncated) break
      const total = expand(parent.id, parent.children, parent)
      if (total !== undefined) parent.callers = total
    }
  }
  return {
    depth,
    nodes,
    truncated,
    roots,
    ...(rootCallers === undefined ? {} : { callers: rootCallers }),
  }
}

/** An outgoing edge joined to the symbol it points at. */
interface OutgoingRow {
  readonly kind: string
  readonly line: number
  readonly name: string | null
  readonly path: string | null
  readonly signature: string | null
}

/**
 * Outgoing reference edges of one symbol, resolved to names.
 *
 * A row also carries the callee's SIGNATURE when the call resolves to exactly
 * one declaration. A shared name links to every declaration of it (up to ten),
 * so one call can hold several edges; the signature of the first candidate
 * would be a guess printed as a fact. Ambiguity is counted per line AND callee
 * name, in one statement after the rows: `return target(x) + dup()` holds two
 * calls on one line, each unambiguous, and counting the line's distinct targets
 * would have read that as a shared name.
 */
export function callsOf(graph: Graph, symbolId: string, limit: number): { rows: EdgeView[], truncated: boolean } {
  const rows = allRows<OutgoingRow>(
    graph.db,
    `SELECT e.kind AS kind, e.line AS line, s.name AS name, s.path AS path, s.signature AS signature
     FROM edges e LEFT JOIN symbols s ON s.id = e.dst
     WHERE e.src = ? AND e.kind = 'references' ORDER BY e.line LIMIT ?`,
    symbolId, limit + 1,
  )
  const kept = rows.slice(0, limit)
  const shared = new Set(
    allRows<{ line: number, name: string }>(
      graph.db,
      `SELECT e.line AS line, s.name AS name FROM edges e JOIN symbols s ON s.id = e.dst
       WHERE e.src = ? AND e.kind = 'references'
       GROUP BY e.line, s.name HAVING COUNT(DISTINCT e.dst) > 1`,
      symbolId,
    ).map(row => `${String(row.line)}\u0000${row.name}`),
  )
  return {
    rows: kept.map(row => ({
      kind: row.kind,
      line: row.line,
      name: row.name ?? undefined,
      path: row.path ?? undefined,
      ...(row.signature !== null && row.signature !== '' && !shared.has(`${String(row.line)}\u0000${row.name ?? ''}`) ? { signature: row.signature } : {}),
    })),
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

/**
 * Every symbol declared in one file, with each one's head.
 *
 * Head but no summary: this is the `same file` list of a symbol answer, whose
 * rows say what a neighbour takes and returns, not what it is for.
 */
export function symbolsInFile(graph: Graph, path: string, limit: number): SignedSymbol[] {
  const rows = allRows<SymbolDetailRow>(
    graph.db,
    `SELECT ${symbolDetailColumns()} FROM symbols WHERE path = ? ORDER BY line LIMIT ?`,
    path, limit,
  )
  return rows.map(toSigned)
}

/** One symbol of a file, with the count that says whether anything depends on it. */
export interface FileSymbol {
  readonly symbol: SymbolDetail
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
  const rows = allRows<SymbolDetailRow>(
    graph.db,
    `SELECT ${symbolDetailColumns()} FROM symbols WHERE path = ? ORDER BY line`,
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
    // Head AND summary per row: which of them a row prints is the renderer's
    // decision, made against the list budget (`budget.ts`), not the query's.
    symbols: ordered.slice(0, limit).map(entry => ({
      symbol: toDetail(entry.row),
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
  /** Files nothing else imports, conventional entry filenames first, then by path. */
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
  //
  // WITHIN a class, by PATH — not by symbol count. `n DESC` used to sit between
  // the class and the path, and it reordered the list on every edit that added or
  // removed a declaration: measured on 234 real sessions, 82 of the 274 re-pushed
  // overview diffs were entry rows, a reorder among them. The count stays in the
  // SELECT because `codegraph_context`'s outline still prints it; it no longer
  // decides an order. The symbol count a file happens to have is not a statement
  // about where a project starts, so nothing is lost by reading alphabetically.
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
       END ASC, f.path ASC
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
    //
    // AND the name is not shared by several declarations.
    //
    // Measured after widening the list to ten rows: `startsWith` appeared three times
    // (554 / 554 / 553) and `ok` eight. The reference count of a SHARED NAME is the
    // sum over every unrelated declaration of it, so the number says how common the
    // word is, not how important any one symbol is. A hub list exists to teach the
    // vocabulary of THIS project, and `startsWith` is not part of it.
    `SELECT e.dst AS id, COUNT(*) AS n
     FROM edges e JOIN symbols s ON s.id = e.dst
     WHERE e.kind = 'references'
       AND s.parent IS NULL
       AND s.kind IN ('function', 'class', 'interface', 'type', 'enum')
       AND (SELECT COUNT(*) FROM symbols s2 WHERE s2.name = s.name) <= 2
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
      `SELECT ${symbolColumns()} FROM symbols WHERE path = ?
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
    `SELECT ${symbolColumns()} FROM symbols WHERE name = ? ORDER BY path, line LIMIT ?`,
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

/**
 * The graph's top-level directories, each with its exact file count.
 *
 * The one fact about a project the overview could not state: the entry list
 * names files and the hub list names symbols, and neither says WHERE the project
 * lives — so "is this a `src/` with a `plugins/` beside it" was still a listing
 * question, which is the chain this plugin exists to replace.
 *
 * Counted EXACTLY and sorted by name, with no cut. The prompt line prints rungs
 * and orders by rung, and that rule lives there (`prompt.ts`) so it has exactly one
 * home; a query that pre-bucketed or pre-sorted by size would make the second
 * copy drift. The tool side may want the exact numbers one day, and this is
 * already the shape for that.
 *
 * Documents count. A `docs/` directory is part of what the project looks like —
 * the overview's own coverage line says the docs that name a symbol are indexed —
 * and excluding them would print `docs 0` beside `src ~500`, which reads as a
 * project without documentation rather than one with 60 files of it.
 *
 * Files at the root (no `/` in the path) are not a directory and are not counted:
 * a `package.json` is not a place, and a synthetic `.` bucket would sort first
 * in every project for no informational gain.
 *
 * @param graph - the open graph.
 * @returns every top-level directory, by name ascending.
 */
export function projectLayout(graph: Graph): readonly { readonly dir: string, readonly files: number }[] {
  const counts = new Map<string, number>()
  for (const row of allRows<{ path: string }>(graph.db, 'SELECT path FROM files')) {
    const slash = row.path.indexOf('/')
    if (slash <= 0) continue
    const dir = row.path.slice(0, slash)
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dir, files]) => ({ dir, files }))
}
