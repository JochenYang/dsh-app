/**
 * Presentation state of the Excel capsule, kept DOM- and React-free so the
 * two-state contract (neutral outline while off, theme outline while on) and
 * the meaning of a body click are unit-testable without the browser-only
 * react externals.
 *
 * The click target is part of the state, not the view: with a session the
 * toggle persists through PUT /mode; without one (the new-session hero) it
 * waits in the shared pending slot and the session-bound occurrence applies it
 * once the session starts. Unlike the PPT capsule there is no per-session
 * pick, so the label never changes — the mode itself is the visible state.
 *
 * @module @dsh-app/plugin-sheet/client/capsule-state
 */

/** Stable format id this capsule contributes to the shared office bar. */
export const SHEET_FORMAT = 'excel'

/** Format label, the capsule's whole text. */
export const SHEET_LABEL = 'Excel'

/** One spreadsheet mode as the capsule reads it, before or after the load. */
export interface CapsuleMode {
  /** Whether the spreadsheet mode is on. */
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
  /** Session-bound: one PUT /mode persists the flipped value. */
  | { readonly kind: 'persist', readonly enabled: boolean }

/** Everything the capsule renders or acts on, derived from the mode state. */
export interface CapsuleState {
  /** Whether the spreadsheet mode is on. */
  readonly enabled: boolean
  /** Capsule text (constant — the outline carries the on/off state). */
  readonly label: string
  /** What a click on the capsule body does. */
  readonly toggle: CapsuleToggle
  /** Tooltip / accessible hint for the body click. */
  readonly hint: string
}

/**
 * Derive the capsule state: a body click always flips the mode, and where the
 * flip lands depends on whether a session exists.
 * @param state - the session-bound flag and the current mode state.
 */
export function capsuleState(state: {
  /** Whether a session exists to persist a mode to. */
  readonly sessionBound: boolean
  /** Whether the mode is currently on. */
  readonly enabled: boolean
  /** Whether the persisted mode has loaded; defaults to loaded. */
  readonly loaded?: boolean
}): CapsuleState {
  return {
    enabled: state.enabled,
    label: SHEET_LABEL,
    toggle: {
      kind: state.sessionBound ? 'persist' : 'park',
      enabled: !state.enabled,
    },
    hint: state.enabled
      ? '点击关闭表格模式'
      : state.sessionBound && (state.loaded ?? true)
        ? '点击开启表格模式'
        : '点击开启表格模式，将在会话开始后生效',
  }
}
