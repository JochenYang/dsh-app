/**
 * The one place that says how a card's TEXT must read.
 *
 * A card body (and its index summary) is injected into every future session,
 * so text about the act of remembering — "I saved a note that…", "according
 * to memory card X" — would be re-injected forever and later read as if it
 * were the fact itself. Three surfaces ask a model to WRITE card text: the
 * always-on guidelines ({@link ./prompt.ts}), the `memory_save` tool
 * description, and the curator's prompt. They share this constant so the rule
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
  'Never narrate the CONVERSATION either ("we discussed…", "本次…", "已修复…", "接下来…"):',
  'that is a work log, and a fact is what survives every session it will be read in.',
  'GUIDANCE cards (convention, lesson, decision) lead with the rule or the settled choice, then',
  'the reason it holds and the case it does NOT cover — a rule read on its own cannot be judged',
  'against a situation it never anticipated. State the reason as a FACT (the constraint, the',
  'failure it prevents), not as the story of how it was agreed.',
  'A card MAY be about this memory system itself (its topic keys, its index, its size limits) —',
  'state such facts directly. The ban is on narrating the SAVING, not on these words.',
].join('\n')

/** Surfaces that must carry {@link CARD_TEXT_DISCIPLINE}, for the tests to walk. */
export const CARD_TEXT_SURFACES = ['guidelines', 'memory_save', 'curator'] as const

/** One card-text surface, as named in {@link CARD_TEXT_SURFACES}. */
export type CardTextSurface = (typeof CARD_TEXT_SURFACES)[number]

/**
 * The three lifecycle rules BOTH the injected guidelines and `memory_save` state.
 *
 * Kept as one constant for the reason `CARD_TEXT_DISCIPLINE` is: these are
 * behaviour-sensitive (each of them prevents a specific, observed failure), and two
 * hand-maintained copies drift. Measured before this existed, the same three rules
 * were spelled twice in ~300 characters each turn, and nothing would have caught one
 * side being reworded into a different rule.
 *
 *   - saving before the task ends, because nothing writes memory in the background;
 *   - the same topic rewrites its card, because one subject gets one card;
 *   - reading the index before saving, because a near-duplicate is how a store rots.
 *
 * A surface may say MORE around it (the guidelines explain WHY, the tool description
 * explains the arguments); none may say these three differently.
 */
export const CARD_LIFECYCLE_RULES = [
  'Save BEFORE the task ends: no background pass writes memory for you.',
  'One topic is one card — saving the same topic again rewrites it, never duplicates it.',
  'Read the injected index BEFORE saving: if a card covers the subject, update that topic.',
].join('\n')
