/**
 * Documentation edges: which prose mentions which symbol.
 *
 * The graph already knows where a symbol is declared and who calls it. It cannot
 * answer "why does this exist" or "what contract does this carry", and that is
 * prose. This module reads the project's own documents and records, for each one,
 * the symbols it NAMES — so `codegraph_context` can return the paragraph beside
 * the code it explains.
 *
 * What this is NOT, stated first because the temptation is to make it more: this
 * is not a markdown parser and not a documentation tool. It does not build a
 * section tree, resolve heading anchors, or follow links. It finds identifier-like
 * tokens in the text and asks the graph whether each one is a declared symbol.
 * That is the whole mechanism, and it is deliberate:
 *
 *   - A markdown parser would be a dependency for a fact we do not need. The
 *     edges point at a LINE, which is what lets a reader open the file at the
 *     sentence that explains the code.
 *   - Guessing at structure (this heading "belongs to" that function) produces
 *     confident edges from a layout the author never intended as structure.
 *   - A token that matches no declared symbol is dropped, so the output is a
 *     small set of real names rather than a bag of English words.
 *
 * The failure mode this has to avoid is the same one the whole plugin exists to
 * prevent: an edge that looks authoritative and is wrong. So prose is matched
 * only where prose can be unambiguous — a backticked token (`` `symbolId` ``) or
 * an identifier-shaped word — and never against short common words, which would
 * match a one-letter variable in every paragraph.
 *
 * @module @dsh-app/plugin-codegraph/host/docs
 */

import type { SymbolRecord } from './store.ts'

/** A file this module will read as a document. */
export interface DocumentFile {
  /** Project-relative path, POSIX separators. */
  readonly path: string
  /** The file's text. */
  readonly text: string
}

/** One place a document names a symbol. */
export interface DocumentMention {
  /** The document's own path. */
  readonly path: string
  /** 1-based line in the document. */
  readonly line: number
  /** The name as it was written, which may be a member name (`Store.open`). */
  readonly name: string
}

/**
 * Extensions read as documents.
 *
 * A fixed list rather than "anything not in the language table": that would pull
 * in lockfiles, minified JSON and binary data. These are the formats whose prose
 * or keys a reader actually consults.
 */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.txt', '.rst']

/**
 * The smallest identifier this module will match in prose.
 *
 * A one-letter name is a real symbol and a terrible thing to search for: `x` and
 * `i` appear in every sentence that mentions a variable, so every document would
 * claim to describe them. Three characters is the floor where a prose match is
 * more likely to be about the code than about the language.
 */
export const MIN_MENTION_LENGTH = 3

/**
 * Words that LOOK like identifiers but are the language they are written in.
 *
 * Kept small and lowercase-only: this list exists to stop the most obvious noise
 * (`the`, `and`, `for`), not to be a dictionary. A word here that happens to be a
 * declared symbol is still matched — a function really named `map` must keep its
 * document edge — because this list is consulted only when the graph has the
 * name, and the check is on the WORD's own frequency-independent shape.
 */
const PROSE_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'not', 'but', 'you', 'are', 'was', 'with', 'this', 'that',
  'from', 'into', 'when', 'then', 'than', 'they', 'them', 'its', 'has', 'have',
  'can', 'will', 'may', 'must', 'should', 'would', 'could', 'one', 'two', 'all',
  'any', 'each', 'every', 'also', 'only', 'just', 'same', 'such', 'some', 'more',
  'most', 'other', 'over', 'under', 'than', 'then', 'there', 'these', 'those',
])

/** One identifier-shaped token found in a line of text. */
interface Token {
  readonly name: string
  /** True when the token was inside backticks, which raises its confidence. */
  readonly quoted: boolean
}

/**
 * The identifier-shaped tokens in one line.
 *
 * Two shapes, both unambiguous about being code references:
 *
 *   - a backticked run, which an author writes precisely to say "this is code";
 *     it may be a path, a command or a symbol, so it is a CANDIDATE that the
 *     graph still has to confirm;
 *   - a bare identifier — one word, no spaces — optionally with a member access
 *     (`Store.open`).
 *
 * A backticked run is trimmed to its LAST dotted segment when it contains a path
 * separator, because `` `src/main/window.ts` `` names a file rather than a symbol.
 *
 * @param line - one line of document text.
 * @returns the candidate tokens, in reading order.
 */
export function tokensOf(line: string): Token[] {
  const tokens: Token[] = []
  // Backticks first, then the same line with them blanked out, so a quoted run is
  // not also picked up as a bare identifier.
  //
  // The blank-out is done with a SECOND regex literal rather than by reusing the
  // one above: a `/g` regex carries `lastIndex` between calls, and `replace` on a
  // regex whose `lastIndex` is non-zero starts mid-line. Measured — the bare scan
  // then missed the first word and matched unrelated text elsewhere.
  const quotedSource = /`([^`\n]+)`/gu
  for (const match of line.matchAll(quotedSource)) {
    const run = match[1]!.trim()
    // A command line or a path is not a symbol; take the last segment so
    // `dsh-app/src/main/window.ts` still offers `window.ts`, which the graph then
    // rejects on its own.
    const last = run.split(/[\s/\\/]+/u).pop() ?? ''
    const cleaned = last.replace(/[^A-Za-z0-9_$.]/gu, '')
    if (cleaned !== '') tokens.push({ name: cleaned, quoted: true })
  }
  const bare = line.replace(/`[^`\n]*`/gu, ' ')
  for (const match of bare.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b/gu)) {
    tokens.push({ name: match[0], quoted: false })
  }
  return tokens
}

/**
 * Whether one token may be matched against the symbol table.
 *
 * The rule has to hold in BOTH directions, which is why it is a function:
 *
 *   - a token shorter than {@link MIN_MENTION_LENGTH} is too common in prose;
 *   - a plain English word in {@link PROSE_STOP_WORDS} is prose, not code — but a
 *     QUOTED one is the author explicitly naming code, so quoting wins.
 *
 * @param token - one candidate.
 * @returns true when the graph should be asked about it.
 */
export function isMentionCandidate(token: Token): boolean {
  // Quoting is the author saying "this is code", so it outranks BOTH rules below
  // — including the length floor. Checked first because the length test would
  // otherwise reject the one case that most needs to survive: a short variable
  // named in backticks.
  if (token.quoted) return true
  // A member access (`Store.open`) is never an English word, whatever its head.
  if (token.name.includes('.')) return token.name.length > 2
  const last = token.name.slice(token.name.lastIndexOf('.') + 1)
  if (last.length < MIN_MENTION_LENGTH) return false
  return !PROSE_STOP_WORDS.has(token.name.toLowerCase())
}

/**
 * The symbols one document names, as mentions with their line numbers.
 *
 * Only names the graph actually declares survive: the document is scanned, then
 * each candidate is looked up in `known`. That direction matters — scanning the
 * SYMBOLS and searching each document's text would be O(symbols × documents) and
 * would match a short name inside a longer word.
 *
 * @param document - the file to read.
 * @param known - every declared symbol name, mapped to its part of speech.
 * @returns one mention per (line, symbol name) pair, deduplicated.
 */
export function documentMentions(
  document: DocumentFile,
  known: ReadonlyMap<string, string>,
): DocumentMention[] {
  const mentions: DocumentMention[] = []
  // Dedupe per line: a sentence that names a symbol three times is one place in
  // the document, and three identical edges would only inflate counts.
  const lines = document.text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const seen = new Set<string>()
    for (const token of tokensOf(lines[index]!)) {
      if (!isMentionCandidate(token)) continue
      // A member access looks up its LAST segment too: prose says `Store.open`,
      // the declaration is `open`, and the parent carries the qualification.
      const candidates = token.name.includes('.')
        ? [token.name, token.name.slice(token.name.lastIndexOf('.') + 1)]
        : [token.name]
      for (const candidate of candidates) {
        if (!known.has(candidate)) continue
        if (seen.has(candidate)) continue
        seen.add(candidate)
        mentions.push({ path: document.path, line: index + 1, name: candidate })
      }
    }
  }
  return mentions
}

/**
 * Every name the graph declares, mapped to its kind.
 *
 * A `Map` rather than a `Set` so a caller can tell a function from a class
 * without a second query; the value is not read by the mention scan itself.
 *
 * @param symbols - the graph's symbol rows.
 * @returns name → kind.
 */
export function knownNames(symbols: readonly SymbolRecord[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const symbol of symbols) {
    // First writer wins: two languages can declare the same name, and the point
    // here is only "the graph knows this word", not which declaration it is.
    if (!names.has(symbol.name)) names.set(symbol.name, symbol.kind)
  }
  return names
}
