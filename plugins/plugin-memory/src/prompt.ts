/**
 * System-prompt contributions: static guidelines (how to save, and how to use
 * what is saved) + a dynamic section injecting the CURRENT PROJECT's cards
 * (only sessions of that workspace). Every other project's cards — and the
 * retired root-level scope's — are physically absent from the assembly;
 * isolation is structural, not prompt-level discipline.
 *
 * The section carries:
 *   1. the INDEX (one line per topic card, capped at {@link MAX_INDEX_LINES}
 *      with an overflow note) — the write-side routing map: before saving, the
 *      model checks whether a card already covers the subject and updates it
 *      instead of creating a near-duplicate;
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
 * Body budget (the index is the routing map, so it is never budget-trimmed —
 * only capped, and the cap announces itself):
 *   project ≤ {@link MAX_PROJECT_CHARS} — the growth valve
 *
 * @module @dsh-app/plugin-memory/prompt
 */

import type { MemoryRoot, MemoryStore, TopicCard } from './memory-store.ts'
import type { MemoryCategory } from './types.ts'
import { CARD_LIFECYCLE_RULES, CARD_TEXT_DISCIPLINE } from './card-discipline.ts'
import { MAX_SUMMARY_CHARS } from './memory-store.ts'

/** Hard ceiling on the injected PROJECT card bodies (characters). */
export const MAX_PROJECT_CHARS = 2_800

/** Guidelines shown to the model whenever memory is enabled. English, to
 * match the harness's own prompt sections; the model writes CARD CONTENT in
 * the user's language as instructed below.
 *
 * The saving instruction is what replaced the retired background extractor:
 * nothing else writes memory any more, so the prompt has to ask for the save
 * explicitly and at the moment the material is still at hand. It is worded
 * MODEL-driven ("when you learned something", "before the task ends") — a
 * user-driven wording ("when the user asks") silently drops implicit
 * preferences the user never states and facts the model digs out on its own.
 * Kept lean: this block rides along with EVERY prompt assembly in every
 * session. */
const GUIDELINES_TEXT = [
  '## Cross-session memory',
  '',
  'Memory is stored PER PROJECT as TOPIC CARDS: one card per subject, injected into',
  'later sessions of this workspace and of no other. The index below lists every topic',
  'of this project, one line each; memory_recall reads any card in full.',
  '',
  // The three lifecycle rules come from the shared constant so this surface and
  // `memory_save` cannot drift apart. Measured before this existed: the same three
  // were spelled twice, ~300 characters per turn, with nothing catching a reword.
  ...CARD_LIFECYCLE_RULES.split('\n'),
  '',
  'Save, without waiting to be asked, when you learned:',
  '- an explicit request to remember something;',
  '- a preference or working habit of this project that will recur;',
  '- a settled decision, a hard-won root cause, a non-obvious constraint or pitfall.',
  'The moment you notice it is the moment writing it is cheapest.',
  '',
  'ONE TOPIC, ONE CARD: pick a stable ASCII kebab-case topic key for the subject',
  '(e.g. "pnpm11-allowscripts"). memory_recall reads a card in full when unsure.',
  '',
  'NEVER save: credentials (even when asked); work logs — what this conversation implemented,',
  'fixed, or committed (commit ids, "已完成" reports, file-by-file change lists); how far the',
  'current task has got, or what is left to do; task summaries; anything a future session reads',
  'from the repo in one tool call (paths, API signatures, config values, build commands).',
  'The test: would a future session in a DIFFERENT conversation act better because this card',
  'exists? When unsure, skip — do not save guesses.',
  '',
  'BEFORE USING a card: it is a SNAPSHOT of the moment it was written, not a claim about now.',
  'If it names a file path, check the file still exists; if it names a function, flag or config',
  'key, read or grep for it before relying on it. On the present state of the repo, the repo (or',
  'git) outweighs any card. When a card contradicts what you observe, trust the observation, fix',
  'the card with memory_save (same topic) — or memory_forget when the fact is retracted — and say',
  'what changed instead of acting on the stale text.',
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

/**
 * The character ledger of ONE prompt assembly. Recorded at the call site
 * (`index.ts`) and served by `/status`, because a budget nobody measures cannot
 * be shown to bind: `MAX_PROJECT_CHARS` bounds the card BODIES only, while the
 * guidelines and the (separately capped) index ride every assembly outside that
 * ledger. Without these numbers the "over 80% of budget" trigger has no
 * denominator.
 */
export interface InjectionMetrics {
  /** The static guidelines block (fixed cost, outside every budget). */
  guidelinesChars: number
  /** The injected index text: the routing map, capped but never budget-trimmed. */
  indexChars: number
  /** The injected card BODIES — the only number `MAX_PROJECT_CHARS` bounds. */
  bodyChars: number
  /** The whole injected section, as the prompt receives it. */
  totalChars: number
  /** Cards whose body was injected. */
  cardCount: number
  /** Index lines injected (capped at {@link MAX_INDEX_LINES}). */
  indexLines: number
  /** Cards this assembly LEFT OUT — the store's size minus what it carried.
   *  This is the loss the budget and the per-category quota incur every turn,
   *  and it is the number the plan's "18 of 26 cards dropped" baseline names. */
  droppedCards: number
  /** Index lines the ceiling cut (`0` when the index fits). A non-zero value
   *  means topics exist that no session of this project is told about. */
  indexOverflowLines: number
  /** Whether any card was left out (budget or per-category quota). */
  truncated: boolean
}

/** One assembly: the text plus its ledger.
 *
 * `metrics` is absent exactly when nothing project-scoped was rendered (the
 * plugin is off, or the session has no workspace): those assemblies carry only
 * static text and measure nothing about a project.
 */
export interface MemoryAssembly {
  text: string
  metrics?: InjectionMetrics
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
  // ROTATION, not blocks: taking one bucket to exhaustion before the next made
  // the comment on CATEGORY_QUOTA false the moment cards are long — preference
  // (3) + convention (3) consumed the whole budget and the budget loop's `break`
  // left decision / lesson / fact with ZERO bodies in the prompt, every turn
  // (measured: bodiesInjectedByCategory = {preference: 3, convention: 3}).
  // Each round now takes one card from every category, so the budget is spent
  // across the classes instead of on the first two; the quotas still cap each
  // class, and pins/hand-notes still ride ahead of all of it.
  const buckets = [...byCategory.values()].map(list => list.slice(0, CATEGORY_QUOTA[list[0]!.category] ?? 2))
  const deepest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0)
  for (let round = 0; round < deepest; round += 1) {
    for (const bucket of buckets) {
      const card = bucket[round]
      if (card !== undefined) priority.push(card)
    }
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
 *  a store only ever grows, and an uncapped index would inflate every system
 *  prompt linearly. What was dropped stays reachable through memory_recall —
 *  and the note below carries the other half the ceiling needs: the ceiling is
 *  structural, so the only durable fix is fewer, coarser topics. */
const MAX_INDEX_LINES = 50

/** The ceiling, exported for the warning band (80% is `INDEX_WARN_AT`) and for
 *  the health audit's overflow count — one definition, three readers. */
export const INDEX_LINE_CEILING = MAX_INDEX_LINES

/** The index text for injection, capped with an overflow note that states BOTH
 *  where the dropped topics can still be reached AND the consolidation that
 *  stops the overflow — a ceiling without a growth policy turns into a silent
 *  leak of every topic past the cut. */
function cappedIndex(store: MemoryStore): string {
  const text = store.indexText()
  const lines = text.split('\n').filter(line => line.startsWith('- '))
  if (lines.length <= MAX_INDEX_LINES) return text
  const header = text.split('\n').filter(line => !line.startsWith('- ') && line !== '').join('\n')
  const missing = lines.length - MAX_INDEX_LINES
  const absent = missing === 1 ? '1 more topic is' : `${String(missing)} more topics are`
  return [
    header,
    '',
    ...lines.slice(0, MAX_INDEX_LINES),
    `— ${absent} NOT listed above: the index is over its `
      + `${String(MAX_INDEX_LINES)}-line ceiling and is cut here. memory_recall reaches any card `
      + 'by topic or keyword. To stop the overflow, consolidate rather than add: merge the topics '
      + `that cover one subject and keep every summary within ${String(MAX_SUMMARY_CHARS)} `
      + 'characters — one card per subject, the index a routing map.',
  ].join('\n')
}

/** One scope's injection block: index in full + selected card bodies, with the
 *  character counts the caller records (see {@link InjectionMetrics}). */
interface ScopeAssembly {
  parts: string[]
  indexChars: number
  indexLines: number
  bodyChars: number
  cardCount: number
  droppedCards: number
  indexOverflowLines: number
  truncated: boolean
}

/** One scope's injection block: index in full + selected card bodies. */
function renderScope(store: MemoryStore, heading: string, budget: number): ScopeAssembly | undefined {
  const cards = store.list()
  if (cards.length === 0) return undefined
  const pinned = store.pinnedSet()
  const selection = selectCards(cards, budget, pinned)
  const storeIndexLines = store.indexText().split('\n').filter(line => line.startsWith('- ')).length
  const index = cappedIndex(store)
  const parts = [`### ${heading} — index`, '', index]
  // renderCardBlock carries malformed cards (and clipped pins, marked
  // malformed) verbatim — both paths agree, so no special-casing here.
  const bodies = selection.selected.map(card => renderCardBlock(card))
  if (bodies.length > 0) {
    parts.push('', `### ${heading} — cards`, '', bodies.join('\n\n'))
  }
  if (selection.truncated) {
    parts.push('', '— some cards not injected; memory_recall reads them by topic or keyword.')
  }
  return {
    parts,
    indexChars: index.length,
    indexLines: index.split('\n').filter(line => line.startsWith('- ')).length,
    bodyChars: bodies.reduce((sum, body) => sum + body.length, 0),
    cardCount: bodies.length,
    // Counted from the SELECTION, not from the text: a clipped pin is injected
    // (partially) and must not be reported as dropped.
    droppedCards: cards.length - selection.selected.length,
    // Counted against the STORE's index, not the rendered block: once the
    // ceiling is hit the block only ever carries the allowed lines, so the
    // rendered block cannot say how many topics it had to leave out.
    indexOverflowLines: Math.max(0, storeIndexLines - MAX_INDEX_LINES),
    truncated: selection.truncated,
  }
}

/**
 * Assemble the injected memory block AND its character ledger.
 *
 * The retired root-level scope is never rendered: its cards are relocated into
 * a project directory at boot (see `MemoryRoot.migrateLegacyGlobalScope`), so
 * a card can no longer be injected into every project's sessions.
 *
 * @param root - the two-level memory root.
 * @param cwd - the assembling session's workspace path; undefined (agentless
 *   diagnostics) injects nothing but the guidelines — memory is per project.
 * @returns the section text and, when a project scope was rendered, its
 *   {@link InjectionMetrics}; `text` is '' when the master toggle is off.
 */
export function assembleMemoryText(root: MemoryRoot, cwd: string | undefined): MemoryAssembly {
  if (!root.global.isEnabled()) return { text: '' }
  const guidelinesChars = GUIDELINES_TEXT.length
  const parts: string[] = [GUIDELINES_TEXT]
  if (cwd === undefined) {
    parts.push('', '## Memory (persisted)', '', '(this session has no workspace — memory is stored per project, so none is injected)')
    return { text: parts.join('\n') }
  }
  const projectName = cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? ''
  const scope = renderScope(root.projectFor(cwd), `Memory — current project (${projectName})`, MAX_PROJECT_CHARS)
  if (scope === undefined) {
    parts.push('', '## Memory (persisted)', '', '(empty — nothing saved for this workspace yet)')
    const text = parts.join('\n')
    return {
      text,
      metrics: {
        guidelinesChars,
        indexChars: 0,
        bodyChars: 0,
        totalChars: text.length,
        cardCount: 0,
        indexLines: 0,
        droppedCards: 0,
        indexOverflowLines: 0,
        truncated: false,
      },
    }
  }
  parts.push('', ...scope.parts)
  const text = parts.join('\n')
  return {
    text,
    metrics: {
      guidelinesChars,
      indexChars: scope.indexChars,
      bodyChars: scope.bodyChars,
      totalChars: text.length,
      cardCount: scope.cardCount,
      indexLines: scope.indexLines,
      droppedCards: scope.droppedCards,
      indexOverflowLines: scope.indexOverflowLines,
      truncated: scope.truncated,
    },
  }
}

/**
 * Render the whole injected memory block for one assembly.
 *
 * Kept as the text-only entry point (the prompt provider and the tests read
 * it); {@link assembleMemoryText} carries the metrics beside it.
 *
 * @param root - the two-level memory root.
 * @param cwd - the assembling session's workspace path.
 * @returns the section text; '' when the master toggle is off.
 */
export function renderMemoryText(root: MemoryRoot, cwd: string | undefined): string {
  return assembleMemoryText(root, cwd).text
}
