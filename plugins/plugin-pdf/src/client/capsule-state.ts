/**
 * Presentation state of the PDF capsule, kept DOM- and React-free so the
 * two-state contract (neutral outline while off, theme outline while on) and
 * the meaning of a body click are unit-testable without the browser-only react
 * externals.
 *
 * PDF mode has no template, so the capsule is a plain toggle. The click target
 * is still part of the state, not the view: a click toggles the mode, and where
 * that toggle lands depends on whether a session exists at all. With one, the
 * mode persists through PUT /mode; without one (the new-session hero) the pick
 * waits in the shared pending slot and the session-bound occurrence applies it
 * once the session starts.
 *
 * @module @dsh-app/plugin-pdf/client/capsule-state
 */

/** Stable format id this capsule contributes to the shared office bar. */
export const PDF_FORMAT = 'pdf'

/** Format label, the capsule's whole text. */
export const PDF_LABEL = 'PDF'

/** One PDF mode as the capsule reads it, before or after the session load. */
export interface CapsuleMode {
  /** Whether PDF mode is on. */
  readonly enabled: boolean
  /** The entry's write time (`null` while off or unknown). */
  readonly updatedAt: number | null
}

/** The off mode a capsule stands for before its session mode has loaded. */
export const UNLOADED_MODE: CapsuleMode = { enabled: false, updatedAt: null }

/**
 * Resolve the mode the capsule renders. A mode that has not loaded is not a
 * reason to hide the capsule: it renders its inactive appearance like the
 * other three formats, so the office bar always shows all four. `loaded`
 * separates the two inactive cases for the hint text only.
 */
export function resolveCapsuleMode(mode: CapsuleMode | undefined): { readonly mode: CapsuleMode, readonly loaded: boolean } {
  return mode === undefined ? { mode: UNLOADED_MODE, loaded: false } : { mode, loaded: true }
}

/** Where a body click sends the mode. */
export type CapsuleToggle =
  /** No session yet: park the pick for the session-bound occurrence. */
  | { readonly kind: 'park', readonly enabled: boolean }
  /** Session-bound: one PUT /mode persists the state. */
  | { readonly kind: 'persist', readonly enabled: boolean }

/** Everything the capsule renders or acts on, derived from the mode state. */
export interface CapsuleState {
  /** Whether PDF mode is on. */
  readonly enabled: boolean
  /** Capsule text: always the bare label (PDF has no template). */
  readonly label: string
  /** What a click on the capsule body does. */
  readonly toggle: CapsuleToggle
}

/** Derive the capsule state: a body click always flips the current mode. */
export function capsuleState(state: {
  /** Whether a session exists to persist a mode to. */
  readonly sessionBound: boolean
  /** Whether PDF mode is on. */
  readonly enabled: boolean
}): CapsuleState {
  return {
    enabled: state.enabled,
    label: PDF_LABEL,
    toggle: {
      kind: state.sessionBound ? 'persist' : 'park',
      enabled: !state.enabled,
    },
  }
}
