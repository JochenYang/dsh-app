/**
 * Which of the cards a request did NOT receive in the prompt section bear on it.
 *
 * The section injects the newest bodies under a budget ({@link selectCards} in
 * prompt.ts); what is left out stays reachable through `memory_recall`, and the
 * read-side instruction asks the model to scan the index for it. This module is
 * the second, cheaper path: when the request and a left-out card share enough
 * SPECIFIC terms, the card's body is attached to that step as runtime context
 * (see index.ts), so the model has it without a recall.
 *
 * Why not similarity: `contentSimilarity` (character-bigram Jaccard) is the
 * store's near-duplicate measure and was the first candidate here. Replayed
 * over 443 human-authored turns against a real 227-card library, its precision
 * was 10-15% at EVERY threshold — a technical prompt shares path fragments,
 * "review" and "read-only" with every card, while the one plainly on-point pair
 * (an SVG `<title>` re-verification against the card about exactly that) scored
 * below the false positives. Jaccard answers "are these the same text", not "is
 * this about that".
 *
 * What is counted instead — a term is one of:
 *   - an ASCII identifier of 5+ letters/digits, lowercased: file, flag, API and
 *     tool names (`checkvisibility`, `settlems`, `126x37`). Four characters or
 *     fewer is where the noise lives (`type`, `apps`, `json`, `text`, `file`);
 *   - a run of three Han characters: Chinese is written without spaces, so a
 *     shared three-character run is a shared word or compound (`开发者工具`,
 *     `饮食偏好`). Runs never cross a non-Han character, so no term spans
 *     punctuation.
 *
 * and a term counts only while it is DISTINCTIVE in the store: carried by at
 * most {@link commonLimit} of the project's cards. That is what removes a
 * project's own common vocabulary (`agent`, `loop`, `问题任何`-style phrases)
 * without a stoplist.
 *
 * A card is relevant when the request and it share at least {@link floor}
 * terms — six, or half of a short request's terms (never fewer than three).
 * Calibrated with `scripts/relevance-replay.mjs` over 234 real sessions of a
 * 227-card library (504 human turns, 316 of them with left-out cards): 27
 * turns attached (9%), 47 cards, and 25-26 of those 27 were on point by a
 * manual read of every pair. The pairs between three and five shared terms,
 * read the same way, were about half generic overlap, and admitting them
 * doubles the firing rate (20% of turns). Precision is the point: the reminder
 * is retained in the conversation until compaction, and a noisy one every turn
 * teaches the model to ignore reminders. Re-run the replay after moving the
 * floor or the term rule.
 *
 * Lexical by design — no model call, no embeddings. It cannot see a connection
 * that shares no term, which is why the index and `memory_recall` stay the
 * primary path and this only ever ADDS a card.
 *
 * @module @dsh-app/plugin-memory/relevance
 */

import type { TopicCard } from './memory-store.ts'

/** ASCII identifiers: 5+ letters/digits, lowercased before matching. */
const IDENTIFIER = /[a-z0-9]{5,}/gu

/** One Han character. */
const HAN = /\p{Script=Han}/u

/** Length of the Han-character runs counted as terms. */
const HAN_RUN = 3

/** Terms a request and a card must share for the card to be attached. */
export const RELEVANT_TERMS = 6

/** The floor for a short request, which cannot reach {@link RELEVANT_TERMS}. */
export const RELEVANT_MIN_TERMS = 3

/** Cards attached per step at most. */
export const RELEVANT_MAX_CARDS = 2

/** The terms a text carries (see the module header). */
export function relevanceTerms(text: string): Set<string> {
  const terms = new Set<string>(text.toLowerCase().match(IDENTIFIER) ?? [])
  let run = ''
  const flush = (): void => {
    for (let i = 0; i + HAN_RUN <= run.length; i += 1) terms.add(run.slice(i, i + HAN_RUN))
    run = ''
  }
  for (const char of text) {
    if (HAN.test(char)) run += char
    else flush()
  }
  flush()
  return terms
}

/** How much of a request is read: its head and, when it is longer, its tail. A
 *  message that pastes a log and asks its question at the end must not lose
 *  the question to the paste. */
const REQUEST_HEAD_CHARS = 3_000
const REQUEST_TAIL_CHARS = 1_000

/**
 * The request a message carries, reduced to what relevance is judged on
 * (see the constants above); '' when there is no text.
 *
 * The one definition of "the request": the prompt provider (index.ts) and the
 * replay script (`scripts/relevance-replay.mjs`) both go through it, so the
 * numbers the script reports are the numbers the plugin acts on.
 */
export function clipRequest(text: string): string {
  const clipped = text.length > REQUEST_HEAD_CHARS + REQUEST_TAIL_CHARS
    ? `${text.slice(0, REQUEST_HEAD_CHARS)}\n…\n${text.slice(-REQUEST_TAIL_CHARS)}`
    : text
  return clipped.trim()
}

/** How many cards may carry a term before it is the store's common vocabulary.
 *  Two for every store up to 23 cards; one more per eight cards after that. */
function commonLimit(cardCount: number): number {
  return Math.max(2, Math.floor(cardCount / 8))
}

/**
 * Rank the cards a request bears on, best first.
 *
 * Deterministic: by shared-term count, ties by topic key, so the same store
 * state and the same request always attach the same cards.
 *
 * @param candidates - the visible cards whose body this assembly did NOT inject.
 * @param vocabulary - every visible card of the store, the population a term's
 *   commonness is measured against (the candidates alone would make a term the
 *   whole store shares look rare).
 * @param query - the text of the request (the user's message).
 * @returns at most {@link RELEVANT_MAX_CARDS} cards, or none when nothing
 *   clears the floor.
 */
export function rankRelevantCards(
  candidates: readonly TopicCard[],
  vocabulary: readonly TopicCard[],
  query: string,
): TopicCard[] {
  const queryTerms = relevanceTerms(query)
  if (queryTerms.size === 0 || candidates.length === 0) return []
  // Every card's terms are computed once: the vocabulary is walked for the
  // commonness count and the candidates again for their score, and most
  // candidates are in the vocabulary. This runs on the prompt path.
  const termsByCard = new Map<TopicCard, Set<string>>()
  const termsOf = (card: TopicCard): Set<string> => {
    let terms = termsByCard.get(card)
    if (terms === undefined) {
      terms = relevanceTerms(`${card.summary} ${card.body}`)
      termsByCard.set(card, terms)
    }
    return terms
  }
  const cardsWith = new Map<string, number>()
  for (const card of vocabulary) {
    for (const term of termsOf(card)) cardsWith.set(term, (cardsWith.get(term) ?? 0) + 1)
  }
  const common = commonLimit(vocabulary.length)
  const scored = candidates.map(card => {
    let shared = 0
    for (const term of termsOf(card)) {
      if (queryTerms.has(term) && (cardsWith.get(term) ?? 0) <= common) shared += 1
    }
    return { card, shared }
  })
  const floor = Math.max(RELEVANT_MIN_TERMS, Math.min(RELEVANT_TERMS, Math.floor(queryTerms.size / 2)))
  return scored
    .filter(row => row.shared >= floor)
    .sort((a, b) => b.shared - a.shared || a.card.name.localeCompare(b.card.name))
    .slice(0, RELEVANT_MAX_CARDS)
    .map(row => row.card)
}
