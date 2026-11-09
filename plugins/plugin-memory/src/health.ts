/**
 * The memory store's HEALTH ROW: one line of numbers per project, and the
 * aggregate of all of them.
 *
 * Why a module and not only a script: every number here is also served by
 * `/status` or asserted by a test, and a shell script that recomputed them
 * would be a second definition that drifts. `scripts/memory-health.mjs` is
 * therefore a thin CLI: it bundles this module and prints what it returns.
 *
 * Read-only by construction — nothing here writes, and there is deliberately no
 * `--fix`. The plan's measurement discipline is that a baseline has to be
 * reproducible against a LIVE store (`--snapshot` pins the moment: timestamp,
 * card count and content fingerprint), because a store that gains a card
 * between two runs makes an unchanged number look like a regression.
 *
 * @module @dsh-app/plugin-memory/health
 */

import { join } from 'node:path'
import {
  CARD_CAP,
  CARD_WARN_AT,
  INDEX_WARN_AT,
  MemoryRoot,
  cardsFingerprint,
  contentHash,
  contentSimilarity,
  listProjects,
  type MemoryStore,
} from './memory-store.ts'
import { INDEX_LINE_CEILING, MAX_PROJECT_CHARS, selectCards } from './prompt.ts'
import type { TopicCard } from './card-file.ts'

/** One store's row. Every field is computed from ONE `list()` of that store. */
export interface StoreHealthRow {
  /** 'global' or the project slug. */
  scope: string
  cards: number
  pinned: number
  indexLines: number
  indexChars: number
  /** Summed card-body characters. */
  bodyChars: number
  /** Cards whose body the injection budget actually carries. */
  bodiesInjected: number
  /** `cards - bodiesInjected`: the loss every assembly of this project takes. */
  droppedCards: number
  /** Index lines the injection ceiling cuts. */
  indexOverflowLines: number
  /** A card count at or past the curator's target. */
  atCap: boolean
  /** A card count in the warning band. */
  cardWarn: boolean
  /** Index lines in the warning band. */
  indexWarn: boolean
  /** Cards naming decay-prone external state. */
  rotCards: number
  /** How many such mentions in total. */
  rotMarkers: number
  /** Cards not edited within `ROT_DAYS` (measured, never gated). */
  staleCards: number
  /** Highest pairwise content similarity in this store (0 with fewer than two cards). */
  maxPairwiseSim: number
  /** Distinct domains. */
  domains: number
  /** Cards in the biggest domain. */
  maxDomainCards: number
  /** Any structural cap crossed (cards or index lines). */
  overBudget: boolean
  /** Index lines naming a card that does not exist. */
  indexGhosts: number
  /** Cards the index names MORE THAN ONCE (the duplicate injects too). */
  indexDuplicates: number
  /** Index lines the host would never write (injected verbatim until rebuilt). */
  indexMalformed: number
  /** Cards no index line names. */
  indexUnlisted: number
  /** Content fingerprint of THIS store's cards (see `cardsFingerprint`). */
  fingerprint: string
}

/** One store's row, computed from a single read of its cards. */
export function storeHealth(store: MemoryStore, scope: string): StoreHealthRow {
  // ONE read of the cards feeds every column, including the fingerprint: the
  // audit already pays a quadratic `maxPairwiseSim`, and three separate
  // `list()` calls would parse each store three times for one table row.
  const cards: TopicCard[] = store.list()
  const metrics = store.metrics(cards)
  const pinned = store.pinnedSet()
  const injected = selectCards(cards, MAX_PROJECT_CHARS, pinned).selected.length
  const drift = store.indexDrift()
  return {
    scope,
    cards: metrics.cards,
    pinned: metrics.pinned,
    indexLines: metrics.indexLines,
    indexChars: metrics.indexChars,
    bodyChars: metrics.bodyChars,
    bodiesInjected: injected,
    droppedCards: metrics.cards - injected,
    indexOverflowLines: Math.max(0, metrics.indexLines - INDEX_LINE_CEILING),
    atCap: metrics.cards >= CARD_CAP,
    cardWarn: metrics.cards >= CARD_WARN_AT,
    indexWarn: metrics.indexLines >= INDEX_WARN_AT,
    rotCards: metrics.rotCards,
    rotMarkers: metrics.rotMarkers,
    staleCards: metrics.staleCards,
    maxPairwiseSim: maxPairwiseSimilarity(cards),
    domains: metrics.domains,
    maxDomainCards: metrics.maxDomainCards,
    overBudget: metrics.cards > CARD_CAP || metrics.indexLines > INDEX_LINE_CEILING,
    indexGhosts: drift?.ghostKeys.length ?? 0,
    indexDuplicates: drift?.duplicatedKeys.length ?? 0,
    indexMalformed: drift?.malformedLines.length ?? 0,
    indexUnlisted: drift?.unlistedKeys.length ?? 0,
    fingerprint: cardsFingerprint(cards),
  }
}

/**
 * The closest pair in one store, by the same similarity the write-time gate
 * uses — NOT a second metric, so the baseline and the gate can be read side by
 * side. Quadratic on purpose: a store holds tens of cards, and a sampled
 * estimate would make the baseline unreproducible.
 */
function maxPairwiseSimilarity(cards: readonly TopicCard[]): number {
  let best = 0
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i]!
      const b = cards[j]!
      const score = contentSimilarity(`${a.summary} ${a.body}`, `${b.summary} ${b.body}`)
      if (score > best) best = score
    }
  }
  return Math.round(best * 1000) / 1000
}

/** The aggregate line printed under the rows. */
export interface StoreHealthTotal {
  stores: number
  cards: number
  bodiesInjected: number
  droppedCards: number
  indexLines: number
  indexChars: number
  bodyChars: number
  rotCards: number
  rotMarkers: number
  staleCards: number
  atCap: number
  overBudget: number
  indexGhosts: number
  indexDuplicates: number
  indexMalformed: number
  indexUnlisted: number
  /** Content fingerprint over every store's cards — the snapshot's anchor. */
  fingerprint: string
}

/** A whole root's audit: rows (busiest first) plus the total. */
export interface RootHealth {
  root: string
  /** Epoch ms the audit read the stores. */
  at: number
  rows: StoreHealthRow[]
  total: StoreHealthTotal
}

/** Total a set of rows (shared with the CLI so one definition serves both). */
export function totalHealth(rows: readonly StoreHealthRow[]): StoreHealthTotal {
  return {
    stores: rows.length,
    cards: sum(rows, row => row.cards),
    bodiesInjected: sum(rows, row => row.bodiesInjected),
    droppedCards: sum(rows, row => row.droppedCards),
    indexLines: sum(rows, row => row.indexLines),
    indexChars: sum(rows, row => row.indexChars),
    bodyChars: sum(rows, row => row.bodyChars),
    rotCards: sum(rows, row => row.rotCards),
    rotMarkers: sum(rows, row => row.rotMarkers),
    staleCards: sum(rows, row => row.staleCards),
    atCap: rows.filter(row => row.atCap).length,
    overBudget: rows.filter(row => row.overBudget).length,
    indexGhosts: sum(rows, row => row.indexGhosts),
    indexDuplicates: sum(rows, row => row.indexDuplicates),
    indexMalformed: sum(rows, row => row.indexMalformed),
    indexUnlisted: sum(rows, row => row.indexUnlisted),
    // The rows' OWN content fingerprints, not their counts: a store whose card
    // was rewritten to the same length must move this anchor, or two runs of
    // "unchanged" would describe two different stores.
    fingerprint: contentHash(rows.map(row => `${row.scope}:${row.fingerprint}`).join('|')),
  }
}

function sum(rows: readonly StoreHealthRow[], pick: (row: StoreHealthRow) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0)
}

/**
 * Audit one memory root. A missing root answers zero rows — an empty directory
 * is a legitimate state (a fresh kernel), not an error.
 *
 * @param rootDir - the memory root (`$DSH_HOME/storages/dsh-app-plugin-memory`).
 */
export function auditRoot(rootDir: string): RootHealth {
  const root = new MemoryRoot(rootDir)
  const rows: StoreHealthRow[] = []
  // The root-level store only holds the shared state files now, but it can
  // still hold a `topics/` directory mid-migration — count it so the total
  // never hides cards.
  const global = storeHealth(root.global, 'global')
  if (global.cards > 0) rows.push(global)
  for (const project of listProjects(rootDir)) {
    const store = root.projectBySlug(project.slug)
    if (store === undefined) continue
    rows.push(storeHealth(store, project.slug))
  }
  rows.sort((a, b) => b.cards - a.cards || a.scope.localeCompare(b.scope))
  return { root: rootDir, at: Date.now(), rows, total: totalHealth(rows) }
}

/** The fixed column order of the table (and of the JSON, for readability). */
export const HEALTH_COLUMNS = [
  'scope', 'cards', 'pinned', 'indexLines', 'indexChars', 'bodyChars', 'bodiesInjected',
  'droppedCards', 'atCap', 'indexOverflowLines', 'rotCards', 'rotMarkers', 'staleCards',
  'maxPairwiseSim', 'domains', 'maxDomainCards', 'overBudget', 'indexGhosts', 'indexDuplicates', 'indexMalformed', 'indexUnlisted',
] as const

/** Render one value the way the table wants it (booleans as flags). */
function cell(value: string | number | boolean): string {
  return typeof value === 'boolean' ? (value ? 'Y' : '-') : String(value)
}

/**
 * Render the audit as a fixed-width table plus a total line.
 *
 * @param audit - what {@link auditRoot} returned.
 * @param snapshot - when set, prepend the frozen anchor line (timestamp, card
 *   count, fingerprint). Every before/after comparison must quote it: the store
 *   is live, and a card written between two runs moves the numbers.
 */
export function formatHealthTable(audit: RootHealth, snapshot = false): string {
  const lines: string[] = []
  if (snapshot) {
    lines.push([
      '# snapshot', new Date(audit.at).toISOString(),
      `cards=${String(audit.total.cards)}`,
      `stores=${String(audit.total.stores)}`,
      `fingerprint=${audit.total.fingerprint.slice(0, 12)}`,
      `root=${audit.root}`,
    ].join(' '))
  }
  const widths = HEALTH_COLUMNS.map((column) => {
    const cells = [column, ...audit.rows.map(row => cell(row[column]))]
    return Math.max(...cells.map(value => value.length))
  })
  const render = (values: string[]): string =>
    values.map((value, index) => (index === 0 ? value.padEnd(widths[0]!) : String(value).padStart(widths[index]!))).join('  ')
  lines.push(render([...HEALTH_COLUMNS]))
  for (const row of audit.rows) {
    lines.push(render(HEALTH_COLUMNS.map(column => cell(row[column]))))
  }
  const t = audit.total
  lines.push(render([
    'TOTAL', String(t.cards), '-', String(t.indexLines), String(t.indexChars), String(t.bodyChars),
    String(t.bodiesInjected), String(t.droppedCards), String(t.atCap), '-', String(t.rotCards),
    String(t.rotMarkers), String(t.staleCards), '-', '-', '-', String(t.overBudget),
    String(t.indexGhosts), String(t.indexDuplicates), String(t.indexMalformed), String(t.indexUnlisted),
  ]))
  return lines.join('\n')
}

/** Where a root's project directories live (for callers that print paths). */
export function projectsDirOf(rootDir: string): string {
  return join(rootDir, 'projects')
}
