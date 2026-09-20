/**
 * The one place that says how a card's TEXT must read.
 *
 * A card body (and its index summary) is injected into every future session,
 * so text about the act of remembering — "I saved a note that…", "according
 * to memory card X" — would be re-injected forever and later read as if it
 * were the fact itself. Four surfaces ask a model to WRITE card text: the
 * always-on guidelines ({@link ./prompt.ts}), the distiller, the curator, and
 * the `memory_save` tool description. They share this constant so the rule
 * cannot drift between them, and so a surface that forgets it is visible.
 *
 * Why not a word blacklist: this plugin's OWN memory is about the memory
 * system — topic keys, the index, the 400-char cap are exactly the facts a
 * card about this codebase must state. The rule therefore bans narrating the
 * SAVING, not the vocabulary, and says so explicitly.
 *
 * @module @dsh-app/plugin-memory/card-discipline
 */

/**
 * The shortest body a BACKGROUND proposal may carry.
 *
 * A net, not the whole answer: it catches the one-liner a model reaches for
 * when it has nothing to say ("沟通要简洁", "注意边界情况"), and it is set well
 * below anything that states a fact — the real store's shortest card is 48
 * characters (median 219 over 45 cards), and even a terse preference card runs
 * about 20. Only the distiller's proposals go through it; the user's own
 * `memory_save` and hand-edited cards are never screened.
 */
export const MIN_CARD_BODY_CHARS = 16

/** The same floor for the index hook, which is read on its own in every prompt. */
export const MIN_CARD_SUMMARY_CHARS = 6

/**
 * Narration of the SESSION rather than a fact: what the guidelines already ban
 * and what arrives anyway.
 *
 * Why a list here when the discipline above refuses one: that rule bans
 * narrating the SAVING, and this bans narrating the CONVERSATION — "we
 * discussed…", "this session…", "已修复…". Those are never the fact itself, and
 * unlike the vocabulary the discipline protects (topic keys, the index, size
 * limits), no legitimate card needs them. Kept deliberately narrow: markers
 * that describe a conversation or a just-finished action, in either language.
 */
const SESSION_NARRATION: readonly RegExp[] = [
  /本次|这次|刚刚|接下来|我们已经|我们讨论|我们决定|已修复|已完成|已提交|已落地/u,
  /\bthis (session|run|change|conversation|time)\b|\bwe (discussed|decided|agreed)\b|\bhas been (fixed|added|implemented|done)\b|\bjust (now|fixed)\b|\bnext step\b/iu,
]

/**
 * Why a BACKGROUND proposal may not become a card, or undefined when it may.
 *
 * The guidelines ask the model for the same thing (see
 * {@link CARD_TEXT_DISCIPLINE}), and the project's own record says why that is
 * not enough: prompts have banned work logs since the first version, and
 * measured over the real store the distiller still writes ~41 cards against
 * ONE curation edit ever — the shape has to be refused in code, not requested
 * in prose.
 *
 * @param text - the proposal's body or summary.
 * @param kind - which floor applies (the summary is read on its own).
 * @returns the code the caller logs and counts.
 */
export function screenCardText(text: string, kind: 'body' | 'summary'): 'narration' | 'too-short' | undefined {
  const trimmed = text.trim()
  if (trimmed.length < (kind === 'body' ? MIN_CARD_BODY_CHARS : MIN_CARD_SUMMARY_CHARS)) return 'too-short'
  if (SESSION_NARRATION.some((pattern) => pattern.test(trimmed))) return 'narration'
  return undefined
}

/**
 * The discipline text, verbatim, for every surface that asks for card text.
 * Kept as ONE constant: the tests assert that each surface includes it, so
 * adding a surface without the rule (or rewording it in one place) fails.
 */
export const CARD_TEXT_DISCIPLINE = [
  'Write the card text — BOTH the body/content AND the one-line summary — as the FACT ITSELF,',
  'standing alone, never as a note about the act of recording it ("I saved this…", "according',
  'to the memory index…"). A future session reads the content, not the story of how it got',
  'stored. Leave out what rots: dates, commit ids, session ids, "as discussed above".',
  'Never narrate the CONVERSATION either ("we discussed…", "本次…", "已修复…", "接下来…"):',
  'that is a work log, and a fact is what survives every session it will be read in.',
  'A card MAY be about this memory system itself (its topic keys, its index, its size limits) —',
  'state such facts directly. The ban is on narrating the SAVING, not on these words.',
].join('\n')

/** Surfaces that must carry {@link CARD_TEXT_DISCIPLINE}, for the tests to walk. */
export const CARD_TEXT_SURFACES = ['guidelines', 'memory_save', 'distiller', 'curator'] as const

/** One card-text surface, as named in {@link CARD_TEXT_SURFACES}. */
export type CardTextSurface = (typeof CARD_TEXT_SURFACES)[number]
