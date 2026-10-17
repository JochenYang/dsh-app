/**
 * Pure helpers for the `/rewind` popup and the transcript command row.
 *
 * Kept free of cordis and of React so the option-building and time formatting
 * are unit-testable, and so the client entry stays a thin wiring layer.
 *
 * @module @dsh-app/plugin-rewind/client/popup
 */

import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'

/** One recallable point, as the host projection publishes it. */
export interface Anchor {
  /** User-facing ordinal: 1 is the newest recallable message. */
  readonly n: number
  /** Surface node sequence of this user message. */
  readonly seq: number
  /** Turn this message opened, for whole-turn hiding on the client. */
  readonly turn: number | null
  /** Event time (epoch ms). */
  readonly time: number
  /** Whitespace-collapsed preview of the message text. */
  readonly preview: string
}

/**
 * The `rewindAnchors` projection value, as the client half reads it.
 *
 * Deliberately carries NO prefill text. The recalled message's original text
 * travels with the command RESULT instead (see `prefillRecalled` in the client
 * entry), because the prefill must fire exactly once per recall: this
 * projection is durable state that a page reload replays, so a prompt kept here
 * came back into the composer on every reload.
 */
export interface RewindView {
  readonly anchors?: readonly Anchor[]
  readonly hiddenTurns?: readonly number[]
  /**
   * Whether a compaction bounds the list.
   *
   * The picker has one place to say that older messages are missing — a group
   * heading over the rows, which the host's popup shell renders once for a group
   * shared by every row. See {@link anchorsToOptions}.
   */
  readonly stoppedAtCompaction?: boolean
}

/** Format one epoch-ms stamp as a local `HH:MM:SS`, or `''` when unusable. */
export function clockOf(time: number): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Group name of the boundary note's heading.
 *
 * Equal group names share one heading in the host's popup shell; the value is
 * never shown, so it only has to be unique within this popup.
 */
const COMPACTION_GROUP = 'compaction-boundary'

/**
 * Turn the projection's anchors into popup rows.
 *
 * The ordinal `n` is the row id, so a pick needs no second lookup: `onSelect`
 * submits `/rewind <id>` straight back through the command executor, and the
 * host command keeps owning the cut. The detail column carries the local clock
 * time, which is what a user scanning their own history recognises.
 *
 * When a compaction bounds the list, every row joins ONE group whose heading is
 * the boundary sentence. The popup shell is the host's and renders a heading once
 * per group, so this is how the picker says why older messages are missing
 * without drawing a note of its own — and without a row that cannot be picked,
 * which the option shape has no way to express.
 *
 * @param view - the projection value, or undefined while it has not loaded.
 * @param boundaryNote - the sentence to show when a compaction bounds the list;
 *   omitted keeps the rows ungrouped, exactly as before.
 * @returns one row per recallable message, newest first.
 */
export function anchorsToOptions(
  view: RewindView | undefined,
  boundaryNote?: string,
): SelectOption[] {
  const anchors = view?.anchors ?? []
  const group = view?.stoppedAtCompaction === true && boundaryNote !== undefined && boundaryNote !== ''
    ? { name: COMPACTION_GROUP, label: boundaryNote }
    : undefined
  return anchors.map((anchor) => {
    const time = clockOf(anchor.time)
    return {
      id: String(anchor.n),
      label: anchor.preview === '' ? String(anchor.seq) : anchor.preview,
      ...(time === '' ? {} : { detail: time }),
      ...(group === undefined ? {} : { group }),
    }
  })
}
