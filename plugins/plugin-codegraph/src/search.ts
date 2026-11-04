/**
 * How a query string becomes a search: the fields a caller may filter by, and the
 * words a multi-word query is made of.
 *
 * Two rules, one module, because they are the same question seen from two sides. A
 * caller who knows more than a name — the kind, a directory, the language — states it
 * as a field prefix here instead of every call site growing its own `LIKE` clause. And
 * a query of several words has to be turned into something a name scan can ask; that
 * is `queryTokens`.
 *
 * What is NOT here: any database access, and any index of symbol names. A word-part
 * match is always also a substring match (`ruler` is inside `diffRulerMarks`), so an
 * inverted index would add no recall to a search that does not rank by score — and the
 * one thing a substring scan cannot ask is a bag of words, which needs no index either.
 * Keeping the rules pure is what lets the parsing and the tokenising be tested against
 * strings, which is the only way to see them: a parsing bug looks exactly like a
 * missing symbol.
 *
 * @module @dsh-app/plugin-codegraph/host/search
 */

/** A symbol query, split into the free text and the filters a caller stated. */
export interface SymbolQuery {
  /** What is left after the field prefixes; empty when the caller only filtered. */
  readonly text: string
  /** Restrict to one symbol kind (`function`, `class`, …). */
  readonly kind?: string | undefined
  /** Case-insensitive substring of the file path. */
  readonly path?: string | undefined
  /** One indexed language id (`typescript`, `python`, …). */
  readonly lang?: string | undefined
  /** Case-insensitive substring of the symbol's own name. */
  readonly name?: string | undefined
}

/**
 * Split a raw query into filters and free text.
 *
 * A token is a filter only when its prefix is one of the four field names, which is
 * spelled in the tokenizer's own alternation below: `TODO: fix` and a Windows drive
 * path stay text, because refusing them as unknown fields would turn a search that
 * used to work into an error. Quoted values are supported for the one case that
 * needs them — a path with a space — and the quotes are
 * stripped rather than searched for.
 *
 * @param raw - what the model passed as the query.
 * @returns the filters it stated, plus the remaining text.
 */
export function parseSymbolQuery(raw: string): SymbolQuery {
  const filters: { kind?: string, path?: string, lang?: string, name?: string } = {}
  const rest: string[] = []
  const tokens = raw.match(/[A-Za-z]+:"[^"]*"|"[^"]*"|\S+/gu) ?? []
  for (const token of tokens) {
    const match = /^(kind|path|lang|name):(.*)$/u.exec(token)
    if (match === null) {
      rest.push(token)
      continue
    }
    const field = match[1] as 'kind' | 'path' | 'lang' | 'name'
    const value = unquote(match[2] ?? '')
    // The tokenizer's own alternation already limits the prefix to the four fields, so
    // there is no "unknown field" branch to write here — an unrecognised prefix never
    // becomes a match in the first place (it stays free text, which is the wanted
    // behaviour). An EMPTY value is the case that needs refusing: `name:` alone would
    // filter on the empty string, which every row matches.
    if (value === '') {
      rest.push(token)
      continue
    }
    filters[field] = value
  }
  return { text: rest.join(' ').trim(), ...filters }
}

/** Strip one layer of surrounding double quotes. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/**
 * The words a multi-word query is made of.
 *
 * Only used for queries of MORE than one word: a word-part hit is always also a
 * substring hit (`ruler` is inside `diffRulerMarks`), so one word is already answered by
 * the substring scan. What that scan cannot answer is a bag of words — `marks ruler` is
 * not a substring of anything — and the tokens are AND-ed into the name, which is the
 * meaning FTS5 gives a bare multi-token query too.
 *
 * One-character tokens are dropped from the SEARCH. Under AND they could only narrow,
 * so they do no harm, but they also cannot identify an identifier (`x`, `a`, `1` are
 * the most common letters in a codebase) and each one costs a full name scan. The
 * caller's own WORD COUNT is a different question — `a star` is a two-word query even
 * though only one token survives — so the gate that decides whether this tier runs at
 * all asks with `keepShort`, and the search asks without it.
 *
 * @param text - the free text of a query.
 * @param options - `keepShort` keeps one-character words, for counting them only.
 * @returns the tokens worth searching for, in query order.
 */
export function queryTokens(text: string, options?: { readonly keepShort?: boolean }): string[] {
  const keepShort = options?.keepShort === true
  return text
    .split(/[^A-Za-z0-9_]+/u)
    .map(token => token.trim())
    .filter(token => token !== '' && (keepShort || token.length > 1))
}
