/**
 * The one line appended after a search, when the pattern is one identifier the
 * graph declares exactly once.
 *
 * Why this exists. Measured on this machine's 234 real sessions: the model reached
 * for `grep` 1,942 times and for `codegraph_*` six times, and in one session
 * `codegraph_find` answered a name with "5 call site(s)" and the model then read the
 * same file FIVE times to work out which function each call site sat in. Telling it
 * about the graph does not move it; one line after the result it already chose might.
 * So the line says where the name is declared, how many references point at it, and
 * which tool lists each reference with its containing function — and says nothing
 * when it is not certain.
 *
 * Why "declared exactly once". In this repository 20,470 of 28,918 declarations
 * (71%) share their name with another, so a bare name is usually ambiguous, and a
 * line about the wrong `store` is worse than none. A name declared once is the one
 * case the graph can answer without guessing — the same rule `resolveSymbol` applies
 * before `codegraph_impact` will name a target.
 *
 * Why it is bounded at {@link SEARCH_NOTE_MAX_CHARS}. The line rides on ANOTHER
 * tool's output: the 1,942 `grep` answers in those sessions totalled 3.98M characters,
 * about 2,000 each, so a note of more than a few hundred characters would cost more
 * than the read it is meant to save. The signature goes first (the position is the
 * fact), the closing pointer second, and a path too long for even that gets no note.
 *
 * Why pure functions. The wiring — any search call, a `run_code` sub-dispatch
 * included, at most a few per outer call and once per identifier per session, only
 * while the graph is `current`, and the switch — is `index.ts`'s. This file listens
 * to nothing and registers nothing, so the text and the per-session rule can be
 * tested on a real graph.
 *
 * @module @dsh-app/plugin-codegraph/grep-note
 */

import { allRows, NAME_RESOLVABLE, type Graph } from './store.ts'

/** The longest note that may ride on another tool's answer. */
export const SEARCH_NOTE_MAX_CHARS = 320

/**
 * A bare identifier and nothing else: no dot, bracket, wildcard, pipe, regex
 * metacharacter or space. `\w` is ASCII in JavaScript whatever the flag, so the
 * pattern has to be the kind of name a declaration in this graph can equal.
 */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

/** The most names one session is remembered for. Past it a new name is still answered and simply not kept. */
const MAX_NAMES_PER_SESSION = 200

/** The columns the note reads off the one declaration it found. */
interface Declaration {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly line: number
  /** Empty string, never NULL: the schema says so, so the reader never branches on null. */
  readonly signature: string
}

/** One referencing edge's source, with the symbol row it names when it has one. */
interface Source {
  readonly src: string
  readonly path: string | null
}

/**
 * Which identifiers a session has already been told about.
 *
 * Keyed by the session OBJECT in a `WeakMap`: the kernel owns that object's
 * lifetime, and a `Map` keyed by it would keep every session of the process alive
 * for as long as the plugin ran. The cap exists because the set is per session and
 * the model can grep hundreds of distinct names in one; past it the rule degrades
 * to "answer true", which costs a repeated note, never a missing one.
 *
 * Call it only once {@link searchNote} has produced a note: a name that produced
 * nothing has not been "told about", and recording it would spend the cap on
 * patterns that never annotate. A pattern that is not a bare identifier is refused
 * for the same reason — it can never produce a note, so it must never spend a slot.
 */
export class SearchNoteMemory {
  private readonly bySession = new WeakMap<object, Set<string>>()
  /** Every `undefined` session shares this one entry: there is no object to tell them apart by. */
  private readonly anonymous = new Set<string>()

  /** True the first time this session asks about `name`, false ever after. */
  shouldNote(session: object | undefined, name: string): boolean {
    const key = name.trim()
    // Not an identifier, so not a name a note can ever be about: refuse without
    // remembering, whatever order the caller asks in.
    if (!BARE_IDENTIFIER.test(key)) return false
    const seen = session === undefined ? this.anonymous : this.seenFor(session)
    if (seen.has(key)) return false
    // A full set still answers true: the cap bounds memory, and a repeat is the
    // whole cost of exceeding it.
    if (seen.size < MAX_NAMES_PER_SESSION) seen.add(key)
    return true
  }

  private seenFor(session: object): Set<string> {
    let seen = this.bySession.get(session)
    if (seen === undefined) {
      seen = new Set<string>()
      this.bySession.set(session, seen)
    }
    return seen
  }
}

/**
 * The note to append after a search, or undefined when there is nothing certain to say.
 *
 * Certain means: the pattern is one bare identifier, and `symbols` holds exactly one
 * row with that name. Zero rows is a typo or a name outside the graph; two or more
 * is the ambiguity above — both answer nothing, and the search result stands as it
 * is. The reference count is the edge count `findSymbols` and `referencesTo` report
 * (every `references` edge to the symbol, file-scope and self-references included),
 * so the three answers cannot disagree about one symbol; the file count is the
 * distinct files those edges come from.
 *
 * Query failures (a closed graph, a corrupt file) are the caller's to handle: this
 * function adds no catch, so an error keeps its cause. An empty graph is not an
 * error — it simply declares nothing.
 *
 * @param graph - the open graph.
 * @param pattern - the search pattern as the model wrote it; surrounding whitespace is tolerated.
 * @returns the note, at most {@link SEARCH_NOTE_MAX_CHARS} characters, or undefined.
 */
export function searchNote(graph: Graph, pattern: string): string | undefined {
  const name = pattern.trim()
  if (!BARE_IDENTIFIER.test(name)) return undefined
  // LIMIT 2, not the whole table: one row is the answer and two is the refusal, and
  // a name shared by 317 declarations should not read all of them to say nothing.
  const declared = allRows<Declaration>(
    graph.db,
    `SELECT id, name, kind, path, line, signature FROM symbols WHERE name = ? AND ${NAME_RESOLVABLE} LIMIT 2`,
    name,
  )
  if (declared.length !== 1) return undefined
  const symbol = declared[0]!
  const sources = allRows<Source>(
    graph.db,
    `SELECT e.src AS src, s.path AS path
     FROM edges e LEFT JOIN symbols s ON s.id = e.src
     WHERE e.kind = 'references' AND e.dst = ?`,
    symbol.id,
  )
  const files = new Set<string>()
  for (const source of sources) files.add(source.path ?? fileOfSource(source.src))
  return fit(symbol, sources.length, files.size)
}

/**
 * The note for one declaration, stepped down to fit the budget.
 *
 * Three candidates, each the one before it with one part removed: the whole line,
 * the line without its signature, the line without the pointer that follows the
 * counts. The first that fits is the answer; none fitting means the path alone is
 * too long to be worth appending, and the search result is better left alone.
 *
 * The path is paid for ONCE — the pointer names the symbol, not its id — so the
 * signature is the first thing to go and the pointer, ~80 characters, the second.
 * The stepping order is pinned by a test that grows the path one character at a time;
 * the exact thresholds move with the name and the signature.
 */
function fit(symbol: Declaration, references: number, files: number): string | undefined {
  const head = `codegraph: "${symbol.name}" is declared once in this project — ${symbol.kind} at ${symbol.path}:${String(symbol.line)}`
  const counts = ` — with ${String(references)} reference(s) from ${String(files)} file(s).`
  // The NAME, not the id: `codegraph_impact` resolves a name declared exactly once by
  // the same rule this note fired under (`resolveSymbol`), and the id would carry the
  // path a second time — in this repository that alone moved a 48-character path from
  // "signature and pointer" to "counts only".
  const pointer = ` \`codegraph_impact("${symbol.name}")\` lists each reference with the function that contains it.`
  const full = `${symbol.signature === '' ? head : `${head} (${symbol.signature})`}${counts}${pointer}`
  if (full.length <= SEARCH_NOTE_MAX_CHARS) return full
  const withoutSignature = `${head}${counts}${pointer}`
  if (withoutSignature.length <= SEARCH_NOTE_MAX_CHARS) return withoutSignature
  const withoutPointer = `${head}${counts}`
  return withoutPointer.length <= SEARCH_NOTE_MAX_CHARS ? withoutPointer : undefined
}

/**
 * The file a referencing edge comes from, read off the edge's source id.
 *
 * A `file:` node carries its path after the prefix; a symbol id is `<path>#<kind>:…`,
 * and the path is everything before the LAST `#` (a path may hold one). This is the
 * fallback `referencesTo` uses when the symbol row itself is gone — removed between
 * two passes — so both readers name the same file for the same edge.
 */
function fileOfSource(src: string): string {
  if (src.startsWith('file:')) return src.slice('file:'.length)
  const hash = src.lastIndexOf('#')
  return hash > 0 ? src.slice(0, hash) : src
}
