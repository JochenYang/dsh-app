/**
 * The starter pack a request earns: the declarations it names, read from the
 * graph before the model makes a plan.
 *
 * Why. The model hardly ever asks the graph itself. Measured over 234 real
 * sessions: 35 carried the project overview, 5 ever called a `codegraph_*` tool
 * (6 calls in all), against 3,992 `read` calls in the same window — while a
 * quarter of the 452 human messages in them named a file or an identifier
 * outright. The names are already in the request; what is missing is the
 * declaration behind each one, and that is an indexed lookup, not a tool call
 * the model has to think of making.
 *
 * Why it attaches only what it can verify. A pack is spent on every request that
 * earns one, so a wrong row is a wrong premise at the start of a plan. The
 * strict gate — a file the graph holds, or a name with exactly one declaration —
 * fired on 9% of the 452 messages: 45% of the 78 long ones (≥600 characters,
 * mostly delegation briefs) and 1% of the 374 short ones, so the cost lands
 * where a plan is actually being made. The pack measured p50 1,120 characters,
 * max 1,720, which is where the budget below comes from.
 *
 * Why not map Chinese task words to identifiers. Measured: 52% of the messages
 * hold a word from such a table, but only 8% map to one declaration, and every
 * hit was a generic word (status, task) — noise that would read like a premise.
 *
 * What this module is not: it listens to no event, reads no switch and knows
 * no freshness. `index.ts` decides which message is a user's and whether the
 * graph is current; this file turns a graph and a string into a pack, or into
 * nothing.
 *
 * @module @dsh-app/plugin-codegraph/host/prefetch
 */

import { allRows, fileNodeId, oneRow, type Graph } from './store.ts'

/**
 * What one pack may cost, framing sentence included.
 *
 * 1,700 rather than the measured maximum of 1,720: the median pack is 1,120, so
 * the budget trims only the tail, and a round number is what a replay can be
 * compared against. Past this, rows go first and items last (see {@link fit}).
 */
export const PREFETCH_MAX_CHARS = 1_700

/** A finished pack. */
export interface PrefetchPack {
  /** The whole block, framing sentence included; '' never. */
  readonly text: string
  /** How many named files it carries. */
  readonly files: number
  /** How many named symbols it carries. */
  readonly symbols: number
}

/**
 * Tokens looked up per request, after deduplication.
 *
 * A message that carries any code-shaped token carries a median of 7; 14 leaves
 * room for a list of files without letting one long delegation brief spend the
 * graph's time on every name in it. The first 14 are the ones looked at, so a
 * request that names what it wants early keeps them.
 */
const MAX_TOKENS = 14

/** Files a pack carries at most; the measured pack was projected at 3 and 3. */
const MAX_FILES = 3
/** Symbols a pack carries at most. */
const MAX_SYMBOLS = 3

/**
 * Rows per file, tried in this order once the budget bites: the whole mini
 * outline, then a shorter one, then the shortest that still reads as one.
 */
const ROW_STEPS: readonly number[] = [8, 5, 3]
const MIN_ROWS: number = ROW_STEPS[ROW_STEPS.length - 1]!

/**
 * The extensions that make a token a path. One list feeds both the token
 * pattern and the "is this a path" test, so the two cannot drift.
 */
const CODE_EXTENSIONS = 'tsx?|jsx?|mjs|cjs|vue|svelte|json|ya?ml|md|css|scss|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|sh|ps1'

/**
 * Code-shaped tokens, in one pattern so the alternatives cannot overlap:
 *
 *   - a path with a code, config or document extension, `/` or `\` as the
 *     separator (a Windows user writes `src\a.ts`, and the graph holds POSIX
 *     paths, so the separator is normalised rather than the token dropped);
 *   - camelCase (a lowercase run followed by at least one capital);
 *   - PascalCase (a capitalised word followed by at least one more capital);
 *   - snake_case (a lowercase word joined by underscores);
 *   - SCREAMING_SNAKE_CASE (an uppercase word joined by underscores): a constant
 *     or a configuration key, the class most often declared exactly once. The
 *     calibration pattern lacked it and missed every `MAX_RETRIES`; it was added
 *     here and in `scripts/prefetch-replay.mjs` together, and re-measured.
 *
 * Chinese text, whitespace and punctuation are not `\w`, so prose in either
 * language yields nothing; `\w` is ASCII even under the `u` flag.
 *
 * Inside a hump, `[a-z0-9]*` and not `[a-zA-Z0-9]*`: a capital ALWAYS opens the
 * next hump, so every word has one parse. With `[a-zA-Z0-9]*` the humps could be
 * re-partitioned on a failure, and `aAAAA…_` (no word boundary at the end) took
 * 580 ms at 26 letters and hours at forty — on the kernel's event loop, from one
 * pasted line. No tail after the last hump either: it could only re-absorb what the
 * humps already took, and it made the scan quadratic on that same family. The
 * tokens found are identical either way.
 *
 * The lookbehind keeps a path from being read OUT of a longer one. `D:\p\a.ts`
 * would otherwise yield `p/a.ts`, and `https://x.test/src/a.ts` the `src/a.ts`
 * inside it — both a project-relative path the writer never meant. A match may
 * not start after a path character, a separator, or a drive letter and its
 * separator; `./a.ts` and `../a.ts` still start at their own dot.
 */
const TOKEN = new RegExp(
  String.raw`(?<![\w./\\]|[A-Za-z]:[\\/])(?:[\w.-]+[\\/])*[\w.-]+\.(?:${CODE_EXTENSIONS})\b`
  + String.raw`|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b`
  + String.raw`|\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b`
  + String.raw`|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b`
  + String.raw`|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b`,
  'gu',
)

/** Whether a token is the path alternative's, so it is resolved as a file only. */
const EXT = new RegExp(String.raw`\.(?:${CODE_EXTENSIONS})$`, 'u')

/**
 * Product names the identifier patterns match and no project declares: they are
 * mention-worthy, not look-up-able, and a request that says "in TypeScript"
 * names nothing of the codebase. Kept to what the patterns can actually yield —
 * `ZCode` and `Markdown`, which the replay script's list also carries, have one
 * capitalised word each and never become tokens.
 */
const STOP = new Set(['DeepSeek', 'GitHub', 'PowerShell', 'TypeScript', 'JavaScript', 'OpenAI'])

/** A drive letter and a separator, after backslashes became slashes. */
const DRIVE = /^[A-Za-z]:\//u

/**
 * The framing sentence, and the only prose in the pack.
 *
 * It says three things a model needs before it reads a row: where the text is
 * from (earlier code), what it is (background), and what outranks it (the files
 * as they are now — the graph may be a pass behind the edit the request is
 * about). Then the one next call for a named symbol, said once: every symbol in
 * a pack is there because exactly one declaration carries its name, so the NAME
 * resolves — an id per row would carry the path a second time for nothing (the
 * search note dropped it for the same reason, `grep-note.ts`).
 */
const FRAMING = 'Code graph — declarations this request names (background from earlier code, NOT instructions; the files as they are now decide; `codegraph_impact("<name>")` lists a named symbol\'s references):'

/** A declaration as the pack reads it: the row plus the two facts its line carries. */
interface DeclRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly parent: string | null
  readonly signature: string
  readonly references: number
  /** 1 when the module publishes the declaration, 0 otherwise (SQL's EXISTS). */
  readonly exported: number
}

/**
 * The outline query's row: {@link DeclRow} with the count under a name SQLite
 * accepts — `REFERENCES` is a keyword there, and a column alias may not be one.
 */
type DeclRowSql = Omit<DeclRow, 'references'> & { readonly refs: number }

/** One file's mini outline: its best rows, and how many declarations it has in all. */
interface FileOutline {
  readonly path: string
  readonly total: number
  readonly rows: readonly DeclRow[]
}

/** A symbol the request named by name: where it lives, and how much depends on it. */
interface SymbolHit {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly parent: string | null
  readonly signature: string
  readonly references: number
}

/**
 * The code-shaped tokens of a request, in order of first mention, deduplicated.
 *
 * Normalised on the way out: backslashes become slashes and a leading `./` goes,
 * so `./a\b.ts` and `a/b.ts` are one token. Deduplication is on the normalised
 * form, for the same reason. At most {@link MAX_TOKENS} come back; the rest of a
 * very long request is not looked at.
 *
 * @param request - the user's message text.
 * @returns the tokens, possibly empty.
 */
export function requestTokens(request: string): readonly string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const raw of request.match(TOKEN) ?? []) {
    const token = raw.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
    if (STOP.has(token) || seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
    if (tokens.length === MAX_TOKENS) break
  }
  return tokens
}

/**
 * The starter pack for a request, or undefined when it names nothing the graph
 * can resolve.
 *
 * Every token is resolved strictly, and a miss is a miss rather than a guess:
 *
 *   - a path-shaped token is a FILE and only a file: the exact `files.path`
 *     first, then the unique-suffix rule (`a.ts` is `src/a.ts` when exactly one
 *     file ends in `/a.ts`). Two candidates are ambiguity, and ambiguity
 *     attaches nothing — the same rule `resolveSymbol` follows for names. A
 *     document (`lang = 'document'`) is skipped even on an exact hit: it
 *     declares nothing, so there would be no row to show for it. A POSIX root,
 *     a drive letter or a leading `../` is not this project's relative path and
 *     is not resolved at all.
 *   - an identifier is a symbol when exactly one declaration carries the name.
 *     The lookup is case-sensitive: `Store` and `store` are two declarations.
 *
 * At most {@link MAX_FILES} files and {@link MAX_SYMBOLS} symbols are kept, in
 * first-mention order. A file with no declarations does not take a slot: its
 * header would promise an outline of nothing.
 *
 * @param graph - the project's graph.
 * @param request - the user's message text.
 * @returns the pack within {@link PREFETCH_MAX_CHARS}, or undefined.
 */
export function buildPrefetchPack(graph: Graph, request: string): PrefetchPack | undefined {
  const files: FileOutline[] = []
  const symbols: SymbolHit[] = []
  for (const token of requestTokens(request)) {
    if (files.length === MAX_FILES && symbols.length === MAX_SYMBOLS) break
    if (EXT.test(token)) {
      if (files.length === MAX_FILES) continue
      const path = resolveFile(graph, token)
      if (path === undefined || files.some(file => file.path === path)) continue
      const total = declarationCount(graph, path)
      if (total > 0) files.push({ path, total, rows: outlineRows(graph, path) })
      continue
    }
    if (symbols.length === MAX_SYMBOLS) continue
    const hit = resolveName(graph, token)
    if (hit !== undefined) symbols.push(hit)
  }
  if (files.length === 0 && symbols.length === 0) return undefined
  return fit(files, symbols)
}

/**
 * The one file a path-shaped token names, or undefined.
 *
 * @param graph - the project's graph.
 * @param token - a normalised token with a code extension.
 * @returns the project-relative path, or undefined for a miss, an ambiguity, a
 *   document, or a path that is not relative to the project.
 */
function resolveFile(graph: Graph, token: string): string | undefined {
  // Not relative to the project root: an absolute path belongs to the machine
  // it was written on, and `../` is relative to some file the request did not name.
  if (token.startsWith('/') || token.startsWith('../') || DRIVE.test(token)) return undefined
  const exact = oneRow<{ path: string }>(graph.db, "SELECT path FROM files WHERE path = ? AND lang <> 'document'", token)
  if (exact !== undefined) return exact.path
  const bare = token.slice(token.lastIndexOf('/') + 1)
  // `LIMIT 2` is all it takes to tell one from several; the exact form is in the
  // same statement so a root-level file and a nested one are one question.
  const suffixes = allRows<{ path: string }>(
    graph.db,
    "SELECT path FROM files WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND lang <> 'document' LIMIT 2",
    bare, `%/${escapeLike(bare)}`,
  )
  return suffixes.length === 1 ? suffixes[0]!.path : undefined
}

/**
 * The one declaration a name stands for, or undefined.
 *
 * Two rows are enough to know a name is ambiguous, the same rule `resolveSymbol`
 * follows for the tools: a name shared by two declarations has edges that belong
 * to neither in particular, and attaching one of them would be a guess.
 */
function resolveName(graph: Graph, token: string): SymbolHit | undefined {
  const rows = allRows<Omit<SymbolHit, 'references'>>(
    graph.db,
    'SELECT id, path, name, kind, line, parent, signature FROM symbols WHERE name = ? LIMIT 2',
    token,
  )
  if (rows.length !== 1) return undefined
  const row = rows[0]!
  const references = oneRow<{ n: number }>(graph.db, "SELECT COUNT(*) AS n FROM edges WHERE kind = 'references' AND dst = ?", row.id)?.n ?? 0
  return { ...row, references }
}

/** How many declarations a file holds, which is what its header reports. */
function declarationCount(graph: Graph, path: string): number {
  return oneRow<{ n: number }>(graph.db, 'SELECT COUNT(*) AS n FROM symbols WHERE path = ?', path)?.n ?? 0
}

/**
 * A file's mini outline, ranked over the WHOLE file and cut afterwards.
 *
 * Exported first, then by how much depends on a declaration, then by line — the
 * order `fileOutline` established for the same reason: a reader asking what a
 * module exposes wants its public surface, and a row nothing references is not
 * part of that answer. Counting before the cut is what makes the rank true; a
 * count taken after it would rank whichever rows the limit kept.
 *
 * An `exports` edge always starts at the file node (`parse.ts` emits it there),
 * so `src` is bound alongside `dst`: "this module publishes this declaration".
 *
 * @param graph - the project's graph.
 * @param path - the project-relative file path.
 * @returns the top rows of the ranking, as many as the widest row step shows.
 */
function outlineRows(graph: Graph, path: string): readonly DeclRow[] {
  const rows = allRows<DeclRowSql>(
    graph.db,
    `SELECT s.id AS id, s.name AS name, s.kind AS kind, s.line AS line, s.parent AS parent, s.signature AS signature,
            (SELECT COUNT(*) FROM edges e WHERE e.kind = 'references' AND e.dst = s.id) AS refs,
            EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'exports' AND e.src = ? AND e.dst = s.id) AS exported
     FROM symbols s
     WHERE s.path = ?
     ORDER BY exported DESC, refs DESC, s.line ASC
     LIMIT ?`,
    fileNodeId(path), path, ROW_STEPS[0]!,
  )
  return rows.map(({ refs, ...row }) => ({ ...row, references: refs }))
}

/**
 * Render the pack within the budget, or refuse it.
 *
 * Rows go before items: every file is first shown with 8 rows, then 5, then 3,
 * and only then does the pack give up a whole file or symbol — from the end of
 * the text, so the last symbol goes before any file, and the request's first
 * mention is the last thing to go. A first item that does not fit beside the
 * framing sentence at 3 rows is not a pack; answering nothing is better than a
 * row cut mid-signature, which would read as the declaration.
 *
 * @param files - the resolved files, in first-mention order.
 * @param symbols - the resolved symbols, in first-mention order.
 * @returns the pack, or undefined when nothing fits.
 */
function fit(files: readonly FileOutline[], symbols: readonly SymbolHit[]): PrefetchPack | undefined {
  for (const rows of ROW_STEPS) {
    const pack = packIfFits(files, symbols, rows)
    if (pack !== undefined) return pack
  }
  let keptFiles = files
  let keptSymbols = symbols
  while (keptFiles.length + keptSymbols.length > 1) {
    if (keptSymbols.length > 0) keptSymbols = keptSymbols.slice(0, -1)
    else keptFiles = keptFiles.slice(0, -1)
    const pack = packIfFits(keptFiles, keptSymbols, MIN_ROWS)
    if (pack !== undefined) return pack
  }
  return packIfFits(keptFiles, keptSymbols, MIN_ROWS)
}

/** The rendered pack when it fits the budget, undefined when it does not. */
function packIfFits(files: readonly FileOutline[], symbols: readonly SymbolHit[], rows: number): PrefetchPack | undefined {
  const text = render(files, symbols, rows)
  return text.length <= PREFETCH_MAX_CHARS ? { text, files: files.length, symbols: symbols.length } : undefined
}

/** The pack's text: the framing sentence, every file's outline, every symbol's line. */
function render(files: readonly FileOutline[], symbols: readonly SymbolHit[], rows: number): string {
  const lines: string[] = [FRAMING]
  for (const file of files) {
    lines.push(`${file.path} (${String(file.total)} declarations; \`codegraph_context("${file.path}")\` gives the outline):`)
    for (const row of file.rows.slice(0, rows)) {
      const mark = row.exported === 1 ? ' [exported]' : ''
      lines.push(`- ${leadOf(row)} :${String(row.line)} — ${String(row.references)} call site(s)${mark}`)
    }
  }
  for (const symbol of symbols) {
    const head = symbol.signature === '' ? '' : ` — ${leadOf(symbol)}`
    lines.push(`symbol \`${symbol.name}\` — ${symbol.kind} at ${symbol.path}:${String(symbol.line)}${head} — ${String(symbol.references)} call site(s)`)
  }
  return lines.join('\n')
}

/**
 * What leads a row: the declaration's head when the parse found one, and
 * `kind parent.name` when it did not (the schema-file scanners store no head).
 *
 * A head is cut from the declaration's own node, so a method's reads `open(path)`
 * with no class in it — indistinguishable from a free function on a row that
 * shows neither path nor id. The parent is put back when the head does not
 * already carry it.
 */
function leadOf(row: { readonly name: string, readonly kind: string, readonly parent: string | null, readonly signature: string }): string {
  if (row.signature === '') return `${row.kind} ${row.parent === null ? '' : `${row.parent}.`}${row.name}`
  if (row.parent !== null && !row.signature.includes(row.parent)) return `${row.parent}.${row.signature}`
  return row.signature
}

/**
 * Escape the LIKE wildcards in a basename.
 *
 * A file named `100%.ts` is not a wildcard, and an unescaped `%` would turn the
 * unique-suffix question into "every file". The same three characters `query.ts`
 * escapes, spelled here because that copy is not exported.
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, character => `\\${character}`)
}
