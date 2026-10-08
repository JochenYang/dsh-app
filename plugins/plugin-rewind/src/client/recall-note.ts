/**
 * Where a recall's outcome is reported.
 *
 * The note used to sit inside the icon's own row. That row lives in the turn the
 * recall just hid, so `display:none` took the note with it — the diagnostic was
 * invisible in exactly the case it existed for: a recall that landed while the
 * composer prefill did not, which is what a user reports as "nothing happened".
 *
 * ## The host's own Toast, not a hand-rolled overlay
 *
 * The second attempt wrote a fixed `div` onto `document.body` with plugin CSS.
 * That is the same mistake as redrawing a dialog: it got the tokens right and the
 * placement, layering, fade and dismissal wrong, so it read as a stray element
 * floating over the composer. `Toast` from `@deepseek-ai/dsh-client-ui-primitives`
 * is the host's own announcement surface — it portals to the body, sits above
 * every overlay, fades itself out on a single `--dsh-toast-hold` value, never
 * intercepts a click, and anchors under a given element. The kernel's own
 * agent-preset refusal uses it exactly this way (`anchor: the composer card`),
 * which is why this module anchors there too.
 *
 * ## The hold time
 *
 * A refusal is longer than the primitive's 3s default on purpose: the kernel's own
 * refusal banner holds 8s (`REFUSAL_HOLD_MS` in the agent-preset client), because
 * a sentence a user must READ before acting cannot vanish at announcement speed.
 * A diagnostic that explains a skipped prefill is the same kind of message, so it
 * gets the same 8s.
 *
 * @module @dsh-app/plugin-rewind/client/recall-note
 */

/** How long a note stays on screen, in ms. Matches the kernel's refusal hold. */
export const NOTE_HOLD_MS = 8_000

/** The composer card a note anchors under, as the conversation package marks it. */
export const COMPOSER_CARD_SELECTOR = 'div[data-composer-card]'

/** One note to show: a finished sentence, plus how it should read. */
export interface RecallNote {
  /** The already-localized sentence. This module owns no copy of its own. */
  readonly text: string
  /** `error` for a refusal, `success` for a confirmation. */
  readonly tone: 'error' | 'success'
}

/**
 * The element a note should anchor under, when the composer is on screen.
 *
 * Returning null lets `Toast` fall back to its own top-centre placement, which is
 * correct when there is no composer to sit above (a settings page, a closed
 * session) — better than anchoring to a rect that is not there.
 *
 * @returns the composer card element, or null.
 */
export function noteAnchor(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const found = document.querySelector(COMPOSER_CARD_SELECTOR)
  return found instanceof HTMLElement ? found : null
}
