/**
 * Offline snapshot builder: turns a parsed aggregated-directory document into
 * the compact fallback catalog bundled with the plugin
 * (src/catalog-snapshot.json). A pure, network-free module so the generator
 * script and the tests exercise the exact same selection/truncation rules.
 *
 * Selection: top N by stars (missing stars rank last, name breaks ties) — the
 * snapshot exists for disaster recovery, not completeness, and the most-starred
 * slice is the one an offline user most plausibly wants. Descriptions truncate
 * to a fixed cap so the committed JSON stays small enough to bundle.
 *
 * The output deliberately mirrors the aggregated source schema (entries carry
 * a `category` label plus a `categoryId`, an optional `npm` name, and a
 * top-level id→label map) so the host replays it through the ordinary
 * parseCatalogDocument validation — a snapshot row can never be weaker than a
 * fetched one.
 *
 * @module @dsh-app/plugin-market/snapshot-builder
 */

import { DEFAULT_SOURCE_URL, parseCatalogDocument } from './catalog.ts'

/** Committed snapshot row cap. */
export const SNAPSHOT_ENTRY_LIMIT = 500

/** Per-entry description cap (chars, ellipsis included). */
export const SNAPSHOT_DESCRIPTION_CAP = 140

/** One snapshot plugin row (aggregated-schema shape; only snapshot fields). */
export interface SnapshotPluginRecord {
  readonly name: string
  readonly owner?: string
  /** Repository/homepage URL (display only). */
  readonly url?: string
  /** Directory page — becomes the entry id on parse (stable dedupe key). */
  readonly page: string
  /** Category display label (zh preferred); '' keeps the aggregated sniff unambiguous. */
  readonly category: string
  /** Stable category key the panel filters on; absent = the label is the key. */
  readonly categoryId?: string
  readonly description: string
  /** npm package name; absent = source-only row. */
  readonly npm?: string
  readonly installable: boolean
  readonly stars?: number
}

/** The committed snapshot document (parseable by parseCatalogDocument). */
export interface SnapshotDocument {
  readonly name: string
  readonly generatedAt: string
  readonly sourceUrl: string
  readonly categories: Record<string, { en?: string, zh?: string }>
  readonly plugins: readonly SnapshotPluginRecord[]
}

/** Fixed-cap ellipsis truncation (the cap counts every emitted character). */
export function truncateForSnapshot(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap - 1)}…` : value
}

export interface BuildSnapshotOptions {
  readonly limit?: number
  readonly descriptionCap?: number
  readonly now?: () => Date
  readonly sourceUrl?: string
}

/**
 * Build the snapshot document from a parsed (unknown-shape) directory
 * document. Validation, zh-preferred labels and npm-grammar checks all reuse
 * the catalog parser, so only rows the live panel would accept are kept.
 */
export function buildSnapshotDocument(json: unknown, options: BuildSnapshotOptions = {}): SnapshotDocument {
  const limit = options.limit ?? SNAPSHOT_ENTRY_LIMIT
  const cap = options.descriptionCap ?? SNAPSHOT_DESCRIPTION_CAP
  const entries = parseCatalogDocument(json)
  const ranked = entries
    .filter(entry => entry.description !== '')
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit)
  // The top-level map keys the stable category ids to their zh labels, so the
  // ordinary parser can replay the snapshot into fully labeled rows. Without
  // it a snapshot entry would resolve its own label as the category id.
  const categories: Record<string, { zh?: string }> = {}
  for (const entry of ranked) {
    if (entry.categoryId !== undefined && entry.category !== undefined) {
      categories[entry.categoryId] = { zh: entry.category }
    }
  }
  return {
    name: 'dsh-app plugin market offline snapshot',
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceUrl: options.sourceUrl ?? DEFAULT_SOURCE_URL,
    categories,
    plugins: ranked.map((entry): SnapshotPluginRecord => ({
      name: entry.name,
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
      ...(entry.homepage !== undefined ? { url: entry.homepage } : {}),
      page: entry.id,
      // Always present (possibly ''): the aggregated sniff keys on the
      // `category`/`npm` field names, so an uncategorized first row must not
      // look like a custom-schema document.
      category: entry.category ?? '',
      ...(entry.categoryId !== undefined ? { categoryId: entry.categoryId } : {}),
      description: truncateForSnapshot(entry.description, cap),
      ...(entry.installable === false ? {} : { npm: entry.package }),
      installable: entry.installable !== false,
      ...(entry.stars !== undefined ? { stars: entry.stars } : {}),
    })),
  }
}
