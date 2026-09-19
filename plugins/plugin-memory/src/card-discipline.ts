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
 * The discipline text, verbatim, for every surface that asks for card text.
 * Kept as ONE constant: the tests assert that each surface includes it, so
 * adding a surface without the rule (or rewording it in one place) fails.
 */
export const CARD_TEXT_DISCIPLINE = [
  'Write the card text — BOTH the body/content AND the one-line summary — as the FACT ITSELF,',
  'standing alone, never as a note about the act of recording it ("I saved this…", "according',
  'to the memory index…"). A future session reads the content, not the story of how it got',
  'stored. Leave out what rots: dates, commit ids, session ids, "as discussed above".',
  'A card MAY be about this memory system itself (its topic keys, its index, its size limits) —',
  'state such facts directly. The ban is on narrating the SAVING, not on these words.',
].join('\n')

/** Surfaces that must carry {@link CARD_TEXT_DISCIPLINE}, for the tests to walk. */
export const CARD_TEXT_SURFACES = ['guidelines', 'memory_save', 'distiller', 'curator'] as const

/** One card-text surface, as named in {@link CARD_TEXT_SURFACES}. */
export type CardTextSurface = (typeof CARD_TEXT_SURFACES)[number]
