/**
 * The pick a user makes on the new-session hero before any session exists. PPT
 * mode is persisted per session, so a hero choice has nothing to write to yet:
 * it parks here, and the first session-bound capsule consumes it once and
 * applies it through the same route — the choice survives the transition from
 * hero to conversation without a second interaction.
 *
 * Module-level and in-memory on purpose: it bridges the two occurrences of the
 * capsule within one client boot, and the hero picker only exists while the
 * hero row is on screen, so there is nothing to restore after a reload.
 *
 * A parked pick always means "mode on": `template` is the chosen template or
 * `null` for 常规主题. Turning the mode off on the hero clears the slot instead
 * of parking a value, because the session default is already off.
 *
 * @module @dsh-app/plugin-ppt/client/pending-template
 */

/** One parked hero pick: mode on with this template (`null` = 常规主题). */
export interface PendingPick {
  readonly template: string | null
}

/** Parked pick, or `undefined` when the slot is empty. */
export type PendingTemplate = PendingPick | undefined

let parked: PendingTemplate
const listeners = new Set<() => void>()

function emit(): void {
  // Iterate a copy: a subscriber may unsubscribe while being notified.
  for (const listener of [...listeners]) listener()
}

/** The single parked slot shared by every capsule occurrence. */
export const pendingTemplate = {
  /** The parked pick, or `undefined` when the slot is empty. */
  get(): PendingTemplate { return parked },
  /** Park a pick for the next session-bound occurrence. */
  set(pick: PendingPick): void {
    parked = pick
    emit()
  },
  /** Empty the slot (hero turn-off, or nothing to hand over). */
  clear(): void {
    if (parked === undefined) return
    parked = undefined
    emit()
  },
  /** Take the parked pick, emptying the slot; `undefined` when it was empty. */
  consume(): PendingTemplate {
    const value = parked
    if (value === undefined) return undefined
    parked = undefined
    emit()
    return value
  },
  /** Observe slot changes (`useSyncExternalStore`-shaped). */
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
