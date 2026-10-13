/**
 * What the injected control draws for one resolved state.
 *
 * The component renders from this and the tests assert on it, because the two
 * facts that matter here are invisible to both a typecheck and a screenshot:
 *
 *   1. **The note LINE is drawn in every shape.** Its sentence comes and goes —
 *      a state that needs no explanation shows an empty line — but the box it
 *      occupies must not, because the official menu is placed from its own height
 *      and re-laid out from its own content. A shape that left the line out would
 *      move the whole card by 20px the moment a drag turned "following the
 *      provider default" into a level, which is exactly the reported bug; taking
 *      the note out of the render is therefore a decision this module cannot
 *      express.
 *   2. **Only the knob distinguishes an unset track from a ready one.** Both are
 *      `interactive` (see `levels.ts`), both draw the note line, both draw their
 *      ticks; the unset track has no position, so it draws no knob. Anything else
 *      that differed between the two would be a difference in the DOM that the
 *      user sees as the control changing shape under the pointer.
 *
 * So the sentences live here rather than in the component: the copy is a pure
 * function of the state, and the component is left with the rendering.
 *
 * @module @dsh-app/plugin-effort/client/shape
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { trackModeOf, type EffortState } from './levels.ts'
import { NS, type EffortKey } from './locales.ts'

/**
 * The error state, kept coded so the dictionary stays the only place with copy.
 *
 * It is not an `EffortOutcome` with `ok: false`: that one is what the host
 * answered, while this is what the control is showing right now — the two differ
 * for the whole timeout window.
 */
export interface EffortFailure {
  /** Dictionary key of the sentence to show. */
  readonly code: EffortKey
  /** Values the sentence interpolates. */
  readonly params?: Readonly<Record<string, unknown>>
}

/** This plugin's namespace-bound translate, as the slot hands it to the entry. */
export type EffortTranslate = PropsLocale<typeof NS>['t']

/** The layers the container draws, for one state. */
export interface ControlShape {
  /**
   * The sentence under the track, or `''` when the state needs none.
   *
   * The component renders the line either way: this decides the sentence, never
   * whether the line exists.
   */
  readonly note: string
  /** Whether the sentence carries the failure tone. */
  readonly noteError: boolean
  /** Whether one tick per level is drawn. Only an interactive track has a scale. */
  readonly ticks: boolean
  /** Whether the knob is drawn. A track with no position draws none. */
  readonly knob: boolean
}

/**
 * The shape to draw for one state.
 *
 * @param state - the resolved state (see `levels.ts`).
 * @param failure - the coded failure to show, if any.
 * @param t - this plugin's namespace-bound translate.
 * @param shownIndex - the level being shown, or -1 when there is no position.
 * @returns the shape.
 */
export function controlShapeFor(
  state: EffortState,
  failure: EffortFailure | null,
  t: EffortTranslate,
  shownIndex: number,
): ControlShape {
  const mode = trackModeOf(state)
  return {
    note: noteTextFor(state, failure, t),
    noteError: failure !== null,
    ticks: mode === 'interactive',
    knob: shownIndex >= 0 && mode !== 'static',
  }
}

/**
 * The one line under the track, when there is something to say.
 *
 * A failure always wins: it is the only case where what the user sees is not what
 * the session will use. Otherwise the track speaks for itself — a full track with
 * one level, or an empty one following the provider default, is already visible —
 * and the line only names the reason. `''` means "nothing to say" and is NOT "no
 * line": see {@link ControlShape.note}.
 *
 * @param state - the resolved state.
 * @param failure - the coded failure, if any.
 * @param t - this plugin's namespace-bound translate.
 * @returns the sentence, or `''` when the track needs no explanation.
 */
export function noteTextFor(
  state: EffortState,
  failure: EffortFailure | null,
  t: EffortTranslate,
): string {
  if (failure !== null) return t(failure.code, failure.params)
  if (state.kind === 'unset') return t('effort.noteUnset')
  if (state.kind === 'unknown') return t('effort.noteUnknown', { id: state.raw })
  if (state.kind === 'ready' && state.levels.length <= 1) return t('effort.noteSingle')
  return ''
}
