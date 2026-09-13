/**
 * Presentation state of the PPT capsule, kept DOM- and React-free so the
 * state contract (neutral outline while off, filled theme color while on) and
 * the meaning of a body click are unit-testable without the browser-only react
 * externals.
 *
 * The mode being on is one fact and the chosen template is another: an active
 * capsule with no template shows the bare label (常规主题), and only a picked
 * template extends it to `PPT · <name>`. The click target is part of the
 * state, not the view: a body click toggles the mode, and where that toggle
 * lands depends on whether a session exists at all. With one, the mode
 * persists through PUT /mode; without one (the new-session hero) the decision
 * waits in the shared pending slot and the session-bound occurrence applies it
 * once the session starts.
 *
 * @module @dsh-app/plugin-ppt/client/capsule-state
 */

/** Stable format id this capsule contributes to the shared office bar. */
export const PPT_FORMAT = 'ppt'

/** Format label, the capsule's whole text while off or on 常规主题. */
export const PPT_LABEL = 'PPT'

/** One PPT mode as the capsule reads it, before or after the session load. */
export interface CapsuleMode {
  /** Whether the PPT mode is on. */
  readonly enabled: boolean
  /** Active template id, or `null` while off or on 常规主题. */
  readonly template: string | null
  /** The entry's write time (`null` while off or unknown). */
  readonly updatedAt: number | null
}

/** The off mode a capsule stands for before its session mode has loaded. */
export const UNLOADED_MODE: CapsuleMode = { enabled: false, template: null, updatedAt: null }

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
  /** No session yet: park the decision for the session-bound occurrence. */
  | { readonly kind: 'park', readonly enabled: boolean }
  /** Session-bound: one PUT /mode persists the state. */
  | { readonly kind: 'persist', readonly enabled: boolean }

/** Everything the capsule renders or acts on, derived from the mode state. */
export interface CapsuleState {
  /** Whether the PPT mode is on. */
  readonly enabled: boolean
  /** Capsule text: the bare label, or label + template name once picked. */
  readonly label: string
  /** Whether the ▾ dropdown is offered (an active capsule only). */
  readonly caret: boolean
  /** What a click on the capsule body does. */
  readonly toggle: CapsuleToggle
}

/**
 * Derive the capsule state. A body click turns the mode off while it is on,
 * and on with the neutral 常规主题 (no template) while it is off.
 *
 * @param state - the session-bound flag, the mode flag and the template.
 */
export function capsuleState(state: {
  /** Whether a session exists to persist a mode to. */
  readonly sessionBound: boolean
  /** Whether the PPT mode is on. */
  readonly enabled: boolean
  /** Active template id, or `null` while off or on 常规主题. */
  readonly template: string | null
  /** Display name of the active template; falls back to its id. */
  readonly name?: string | undefined
}): CapsuleState {
  const named = state.enabled && state.template !== null
  return {
    enabled: state.enabled,
    label: named ? `${PPT_LABEL} · ${state.name ?? state.template}` : PPT_LABEL,
    caret: state.enabled,
    toggle: {
      kind: state.sessionBound ? 'persist' : 'park',
      enabled: !state.enabled,
    },
  }
}
