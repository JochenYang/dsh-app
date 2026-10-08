/**
 * The outcome of one recall attempt, as the client's two halves exchange it.
 *
 * The client entry owns the service lookup and the command call; the components
 * own the `t` seat and therefore the copy. This type is the boundary between
 * them, and it carries a CODE rather than a sentence for exactly that reason —
 * a pre-rendered string could never follow a locale switch.
 *
 * @module @dsh-app/plugin-rewind/client/outcome
 */

import type { RewindKey } from './locales.ts'

/** One recall attempt's outcome, already resolved to a dictionary key. */
export interface RecallOutcome {
  readonly ok: boolean
  /** Dictionary key of the sentence to show, when the host answered. */
  readonly code?: RewindKey
  readonly params?: Readonly<Record<string, string | number>>
  /**
   * A diagnostic shown even on success, when a step the user expects did not
   * happen — today only the composer prefill. It is English on purpose: it is a
   * machine-facing reason, not product copy.
   */
  readonly note?: string
}
