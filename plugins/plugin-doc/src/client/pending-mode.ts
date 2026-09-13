/**
 * The mode a user toggles on the new-session hero before any session exists.
 * Word mode is persisted per session, so a hero toggle has nothing to write to
 * yet: it parks here, and the first session-bound capsule consumes it once and
 * applies it through the same route — the choice survives the transition from
 * hero to conversation without a second interaction.
 *
 * Module-level and in-memory on purpose: it bridges the two occurrences of the
 * capsule within one client boot, and the hero row only exists while the hero
 * is on screen, so there is nothing to restore after a reload.
 *
 * `false` is a real parked value (the user turned the mode off from the hero)
 * and must stay distinguishable from `undefined` (nothing parked).
 *
 * @module @dsh-app/plugin-doc/client/pending-mode
 */

/** Parked toggle: `true`/`false` for a decision, `undefined` for nothing. */
export type PendingMode = boolean | undefined

let parked: PendingMode
const listeners = new Set<() => void>()

function emit(): void {
  // Iterate a copy: a subscriber may unsubscribe while being notified.
  for (const listener of [...listeners]) listener()
}

/** The single parked slot shared by every capsule occurrence. */
export const pendingMode = {
  /** The parked decision, or `undefined` when the slot is empty. */
  get(): PendingMode { return parked },
  /** Park a decision for the next session-bound occurrence. */
  set(enabled: boolean): void {
    parked = enabled
    emit()
  },
  /** Take the parked decision, emptying the slot; `undefined` when empty. */
  consume(): PendingMode {
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
