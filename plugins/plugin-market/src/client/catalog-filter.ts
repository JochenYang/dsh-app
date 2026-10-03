/**
 * Client projections over the catalog rows, kept free of node/framework
 * imports so the node:test suite can pin them: the category dropdown's
 * options (stable filter key + display label + per-category count) and the
 * search match. The filter key is `categoryId` when the host resolved one and
 * the display label otherwise (entries persisted before the id existed) — a
 * dropdown value must survive label drift between refreshes, so the raw id is
 * the key whenever it exists.
 *
 * @module @dsh-app/plugin-market/client/catalog-filter
 */

/** The CatalogEntry slice these projections need. */
export interface FilterableEntry {
  /** Display label (zh preferred); absent = uncategorized. */
  readonly category?: string
  /** Stable category key (the source's raw id); absent on legacy rows. */
  readonly categoryId?: string
  readonly name: string
  readonly description: string
  /** Source-declared author/maintainer handle (searchable; absent = none). */
  readonly owner?: string
}

/** One category dropdown row: first-seen order, count over the whole catalog. */
export interface CategoryOption {
  /** The stable filter value (`categoryId`, falling back to the label). */
  readonly key: string
  /** The zh-preferred display label. */
  readonly label: string
  /** How many catalog rows carry this category. */
  readonly count: number
}

/** The filter key of one entry (the label is the key when no id was resolved). */
export function categoryKeyOf(entry: FilterableEntry): string | undefined {
  return entry.categoryId ?? entry.category
}

/**
 * Distinct category options in first-seen order; "全部" stays the implicit
 * first choice and is never emitted here.
 */
export function categoryOptionsOf(entries: readonly FilterableEntry[]): CategoryOption[] {
  // Draft rows are mutable while counting; the emitted shape is CategoryOption.
  const byKey = new Map<string, { key: string, label: string, count: number }>()
  for (const entry of entries) {
    if (entry.category === undefined) continue
    const key = categoryKeyOf(entry)!
    const known = byKey.get(key)
    if (known !== undefined) {
      known.count += 1
      continue
    }
    byKey.set(key, { key, label: entry.category, count: 1 })
  }
  return [...byKey.values()]
}

/**
 * The weighted search match behind the panel's needle. Multi-term: the query
 * is split on whitespace, and an entry is a candidate when EVERY term hits
 * some field (an AND — "pdf 渲染" must not match every pdf plugin); terms it
 * did not hit simply lower its score, and a candidate with a zero score is
 * not a match.
 *
 * Field weights pin the intuition that a name hit outranks a description
 * hit: name ×8, owner ×4 (a pasted handle must find its author), category
 * ×2, description ×1. A term hit in MORE than one field sums its weights,
 * so "memory" in the name of a memory-category plugin outranks one that
 * merely mentions it.
 *
 * Word-start bonus (×2): a hit at a field's start or after a separator
 * (`-`, `_`, `/`, `.`, space) reads as the word itself rather than a
 * substring accident — "git" in "git-log" is the match the user meant;
 * "git" inside "digit" usually is not.
 *
 * CJK needles match directly against the zh description text; latin needles
 * ALSO try the entry's pinyin skeleton (name + zh description folded to
 * pinyin initial letters), so a user typing "jy" for 记忆 or "yxq" for
 * 渲染器 finds the Chinese-named entry without knowing how it romanizes.
 */
export interface SearchableEntry extends FilterableEntry {
  readonly categoryId?: string
}

/** Field weight of one term hit. */
const WEIGHT_NAME = 8
const WEIGHT_OWNER = 4
const WEIGHT_CATEGORY = 2
const WEIGHT_DESCRIPTION = 1

/** The needle's terms, lowercased; empty for a browse-mode empty needle. */
function termsOf(needle: string): string[] {
  return needle.toLowerCase().split(/\s+/).filter(term => term !== '')
}

/** Word-start positions of `term` in `text` (index 0 or after a separator). */
function wordStartHits(text: string, term: string): boolean {
  if (term === '') return false
  let from = 0
  for (;;) {
    const index = text.indexOf(term, from)
    if (index === -1) return false
    if (index === 0) return true
    const before = text[index - 1]
    if (before === '-' || before === '_' || before === '/' || before === '.' || before === ' ') return true
    from = index + 1
  }
}

/**
 * Whether one lowercased term hits one lowercased field. Latin terms also
 * match a pinyin-initial skeleton through the caller's per-entry skeleton
 * (built once per catalog, not per term).
 */
function termHitsField(term: string, field: string | undefined, skeleton: string | undefined): boolean {
  if (field === undefined || field === '') return false
  if (field.includes(term)) return true
  // A latin needle can ride the pinyin skeleton; a CJK needle cannot hit a
  // skeleton made of latin initials, so it only ever matches direct text.
  if (skeleton !== undefined && skeleton.includes(term)) return true
  return false
}

/** Score one entry against the (already lowercased) needle terms. */
export function entryScoreOf(
  entry: FilterableEntry,
  terms: readonly string[],
  skeleton?: string | undefined,
): number {
  if (terms.length === 0) return 1
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  const owner = entry.owner?.toLowerCase()
  const category = entry.category?.toLowerCase()
  const categoryKey = entry.categoryId?.toLowerCase()
  let score = 0
  for (const term of terms) {
    let termScore = 0
    if (termHitsField(term, name, skeleton)) {
      termScore += WEIGHT_NAME * (wordStartHits(name, term) ? 2 : 1)
    }
    if (termHitsField(term, owner, undefined)) {
      termScore += WEIGHT_OWNER * (owner !== undefined && wordStartHits(owner, term) ? 2 : 1)
    }
    if (termHitsField(term, category, undefined) || termHitsField(term, categoryKey, undefined)) {
      termScore += WEIGHT_CATEGORY
    }
    if (termHitsField(term, description, skeleton)) {
      termScore += WEIGHT_DESCRIPTION
    }
    // A term that hit nothing disqualifies the entry (the AND contract).
    if (termScore === 0) return 0
    score += termScore
  }
  return score
}

/**
 * Whether one entry matches the search needle (already trimmed + lowercased).
 * Boolean form of {@link entryScoreOf} for callers that do not rank.
 */
export function entryMatchesQuery(entry: FilterableEntry, needle: string): boolean {
  return entryScoreOf(entry, termsOf(needle)) > 0
}

/**
 * Rank the entries that match the needle, best first. Splitting on
 * whitespace makes "pdf 渲染" an AND of two terms; entries hitting more
 * terms (or stronger fields) sort ahead, and equal scores keep their
 * catalog order (a stable sort over the input order).
 */
export function searchEntries<T extends FilterableEntry>(entries: readonly T[], needle: string): T[] {
  const terms = termsOf(needle)
  if (terms.length === 0) return [...entries]
  const scored: Array<{ entry: T, score: number }> = []
  for (const entry of entries) {
    const score = entryScoreOf(entry, terms)
    if (score > 0) scored.push({ entry, score })
  }
  // Array.prototype.sort is stable where this runs (Node ≥ 12, Chromium ≥ 70).
  return scored.sort((left, right) => right.score - left.score).map(row => row.entry)
}