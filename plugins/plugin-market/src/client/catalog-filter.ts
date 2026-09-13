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
 * Whether one entry matches the search needle (already trimmed + lowercased):
 * name, description, and the author handle all weigh the same — a user pasting
 * an author's handle expects their plugins, not an empty result.
 */
export function entryMatchesQuery(entry: FilterableEntry, needle: string): boolean {
  if (needle === '') return true
  return entry.name.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle)
    || (entry.owner !== undefined && entry.owner.toLowerCase().includes(needle))
}
