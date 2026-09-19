/**
 * System-prompt contributions: static saving guidelines + a dynamic section
 * injecting TWO scopes — the global cards (every session) and the current
 * project's cards (only sessions of that workspace). Other projects' cards
 * are physically absent from the assembly; isolation is structural, not
 * prompt-level discipline.
 *
 * Per scope the section carries:
 *   1. the INDEX in full (one line per topic card) — the write-side routing
 *      map: before saving, the model checks whether a card already covers
 *      the subject and updates it instead of creating a near-duplicate;
 *   2. selected card BODIES under the budget (pinned always win, then the
 *      most recently updated of each category up to a quota — one bucket
 *      cannot crowd out the others; whatever is dropped stays reachable via
 *      memory_recall).
 *
 * The section text is a provider evaluated per assembly with the AssembleContext
 * the agent package extends (context.agent?.session.header.cwd), so a
 * memory_save mid-session is visible to the NEXT turn, and the master
 * toggle is honored live.
 *
 * Body budgets (index is always whole — it is the routing map):
 *   global  ≤ {@link MAX_GLOBAL_CHARS}   — preferences stay small by discipline
 *   project ≤ {@link MAX_PROJECT_CHARS}  — the growth valve
 *
 * @module @dsh-app/plugin-memory/prompt
 */

import type { MemoryRoot, MemoryStore, TopicCard } from './memory-store.ts'
import type { MemoryCategory } from './types.ts'
import { CARD_TEXT_DISCIPLINE } from './card-discipline.ts'

/** Hard ceiling on the injected GLOBAL card bodies (characters). */
export const MAX_GLOBAL_CHARS = 1_200

/** Hard ceiling on the injected PROJECT card bodies (characters). */
export const MAX_PROJECT_CHARS = 2_800

/** Guidelines shown to the model whenever memory is enabled. English, to
 * match the harness's own prompt sections; the model writes CARD CONTENT in
 * the user's language as instructed below. The save triggers are worded
 * MODEL-driven ("whenever you observe") — a user-driven wording ("when the
 * user asks") silently drops implicit preferences the user never states and
 * facts the model digs out on its own. Kept lean: this block rides along
 * with EVERY prompt assembly in every session. */
const GUIDELINES_TEXT = [
  '## Cross-session memory',
  '',
  'Memory persists across sessions as TOPIC CARDS in two scopes:',
  '- GLOBAL: user preferences and habits, valid in every project.',
  '- PROJECT: decisions, conventions, and lessons of this workspace only.',
  'Each scope injects its INDEX (every topic, one line) plus selected cards below;',
  'memory_recall reads any card in full.',
  '',
  'SAVE proactively via memory_save — do not wait to be asked — whenever you observe:',
  '- an explicit request to remember something;',
  '- a durable user preference, stated or inferred from repeated behavior → scope "global";',
  '- a settled project decision or a hard-won lesson (root cause, non-obvious constraint, pitfall)',
  '  → scope "project".',
  '',
  'ONE TOPIC, ONE CARD: pick a stable ASCII kebab-case topic key for the subject',
  '(e.g. "pnpm11-allowscripts"). To correct or extend a saved fact, SAVE THE SAME TOPIC',
  'again with the revised content — the card is rewritten, never duplicated. Check the',
  'index BEFORE saving: if a card already covers the subject, update it instead of',
  'creating a near-duplicate (memory_recall reads it first when unsure).',
  '',
  'NEVER save: credentials (even when asked); work logs — what this conversation implemented,',
  'fixed, or committed (commit ids, "已完成" reports, file-by-file change lists); task summaries;',
  'anything a future session reads from the repo in one tool call (paths, API signatures, config',
  'values, build commands). The test: would a future session in a DIFFERENT conversation act',
  'better because this card exists? When unsure, skip — do not save guesses.',
  '',
  'The body is one concise paragraph in the user\'s language; the summary (≤40 chars) must say',
  'what the card covers — it is the index line future saves route by.',
  '',
  CARD_TEXT_DISCIPLINE,
].join('\n')

/** Per-category quota inside the body budget: every category keeps its most
 *  recently updated cards so one class cannot crowd out the others. */
const CATEGORY_QUOTA: Record<MemoryCategory, number> = {
  preference: 3,
  convention: 3,
  decision: 2,
  lesson: 2,
  fact: 2,
}

/** One injection selection: the picked cards plus whether anything was dropped. */
interface CardSelection {
  selected: TopicCard[]
  truncated: boolean
}

/** Shortest clipped remainder worth injecting: a card needs its heading line
 *  (~50 chars) plus a body fragment to carry any information, so below this a
 *  pin is skipped rather than emitted as a heading-only stub. */
const MIN_PIN_CLIP_CHARS = 64

/** Render one card for injection: a heading line the model can cite, then the body. */
export function renderCardBlock(card: TopicCard): string {
  if (card.malformed) return card.body
  return `### ${card.name} [${card.category}] (updated ${card.updated})\n${card.body}`
}

/**
 * Pick the cards whose bodies fit the budget:
 *  1. pinned cards always win (the user's hard guarantee — they survive
 *     growth regardless of how the rest is truncated);
 *  2. malformed (hand-edited) cards are carried verbatim, like the old
 *     hand-note lines;
 *  3. per category the most recently updated {@link CATEGORY_QUOTA} cards.
 * Budget is accumulated in that priority order with the same per-group
 * reservation rule as before (a long pin cannot starve the pins behind it).
 * What is dropped under the budget stays reachable via memory_recall.
 */
export function selectCards(cards: readonly TopicCard[], budget: number, pinned: Set<string>): CardSelection {
  if (cards.length === 0) return { selected: [], truncated: false }
  const pinnedCards: TopicCard[] = []
  const handNotes: TopicCard[] = []
  const byCategory = new Map<MemoryCategory, TopicCard[]>()
  for (const card of cards) {
    if (pinned.has(card.name)) {
      pinnedCards.push(card)
    } else if (card.malformed) {
      handNotes.push(card)
    } else {
      const list = byCategory.get(card.category) ?? []
      list.push(card)
      byCategory.set(card.category, list)
    }
  }
  // list() arrives sorted category → updated-desc already, so each bucket's
  // head IS the freshest; take the quota off the head.
  const priority: TopicCard[] = [...pinnedCards, ...handNotes]
  for (const list of byCategory.values()) {
    const quota = CATEGORY_QUOTA[list[0]!.category] ?? 2
    priority.push(...list.slice(0, quota))
  }

  const pinnedSet = new Set(pinnedCards)
  const picked: TopicCard[] = []
  let used = 0
  let pinsSeen = 0
  let handsSeen = 0
  for (const card of priority) {
    const isPinned = pinnedSet.has(card)
    const isHandNote = !isPinned && card.malformed
    if (isPinned) pinsSeen += 1
    if (isHandNote) handsSeen += 1
    const reserve = isPinned
      ? Math.max(0, pinnedCards.length - pinsSeen) * MIN_PIN_CLIP_CHARS
      : isHandNote
        ? Math.max(0, handNotes.length - handsSeen) * MIN_PIN_CLIP_CHARS
        : 0
    const width = renderCardBlock(card).length + 1
    if (used + width <= budget - reserve) {
      picked.push(card)
      used += width
      continue
    }
    // An ordinary card that no longer fits means the budget is spent: by the
    // priority order above, nothing behind it outranks it.
    if (!isPinned && !isHandNote) break
    const room = budget - used - 1 - reserve
    if (room < MIN_PIN_CLIP_CHARS) continue
    // A pin MUST reach the prompt — that is the contract — but "whole" used to
    // mean an over-long hand-written card could grow every session's system
    // prompt without bound. It is clipped to the budget with a marked cut.
    picked.push({ ...card, body: `${renderCardBlock(card).slice(0, Math.max(0, room - 1))}…`, malformed: true })
    used += room + 1
  }
  if (picked.length === 0) {
    const fallback = pinnedCards[0]
    if (fallback !== undefined) {
      const text = renderCardBlock(fallback)
      return {
        selected: [{ ...fallback, body: `${text.slice(0, Math.max(0, budget - 1))}…`, malformed: true }],
        truncated: true,
      }
    }
    return { selected: [], truncated: true }
  }
  // "truncated" means some card was not injected — whether the budget dropped
  // it or the per-category quota did (quota-dropped cards are exactly what the
  // recall hint exists for).
  return { selected: picked, truncated: picked.length < cards.length }
}

/** Index lines injected per scope at most. The index is the write-side
 *  routing map and rides every assembly in full, so it needs its own ceiling:
 *  on a kernel without the background passes (no agents/llm services) a store
 *  only ever grows, and an uncapped index would inflate every system prompt
 *  linearly. Overflow stays discoverable through memory_recall. */
const MAX_INDEX_LINES = 50

/** The index text for injection, capped with an explicit overflow note. */
function cappedIndex(store: MemoryStore): string {
  const text = store.indexText()
  const lines = text.split('\n').filter(line => line.startsWith('- '))
  if (lines.length <= MAX_INDEX_LINES) return text
  const header = text.split('\n').filter(line => !line.startsWith('- ') && line !== '').join('\n')
  return [
    header,
    '',
    ...lines.slice(0, MAX_INDEX_LINES),
    `— …and ${String(lines.length - MAX_INDEX_LINES)} more topics; memory_recall lists them.`,
  ].join('\n')
}

/** One scope's injection block: index in full + selected card bodies. */
function renderScope(store: MemoryStore, heading: string, budget: number): string[] {
  const cards = store.list()
  if (cards.length === 0) return []
  const pinned = store.pinnedSet()
  const selection = selectCards(cards, budget, pinned)
  const parts = [`### ${heading} — index`, '', cappedIndex(store)]
  // renderCardBlock carries malformed cards (and clipped pins, marked
  // malformed) verbatim — both paths agree, so no special-casing here.
  const bodies = selection.selected.map(card => renderCardBlock(card))
  if (bodies.length > 0) {
    parts.push('', `### ${heading} — cards`, '', bodies.join('\n\n'))
  }
  if (selection.truncated) {
    parts.push('', '— some cards not injected; memory_recall reads them by topic or keyword.')
  }
  return parts
}

/**
 * Render the whole injected memory block for one assembly.
 * @param root - the two-level memory root.
 * @param cwd - the assembling session's workspace path; undefined (agentless
 *   diagnostics) injects the global scope only.
 * @returns the section text; '' when the master toggle is off.
 */
export function renderMemoryText(root: MemoryRoot, cwd: string | undefined): string {
  if (!root.global.isEnabled()) return ''
  const projectStore = cwd === undefined ? undefined : root.projectFor(cwd)
  const projectName = cwd === undefined ? '' : cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? ''

  const parts: string[] = [GUIDELINES_TEXT]
  const globalParts = renderScope(root.global, 'Memory — global', MAX_GLOBAL_CHARS)
  const projectParts = projectStore === undefined
    ? []
    : renderScope(projectStore, `Memory — current project (${projectName})`, MAX_PROJECT_CHARS)

  if (globalParts.length === 0 && projectParts.length === 0) {
    parts.push('', '## Memory (persisted)', '', '(empty — nothing saved yet)')
    return parts.join('\n')
  }
  if (globalParts.length > 0) parts.push('', ...globalParts)
  if (projectParts.length > 0) parts.push('', ...projectParts)
  return parts.join('\n')
}
