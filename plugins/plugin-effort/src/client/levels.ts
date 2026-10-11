/**
 * Which reasoning level is in effect, and where it sits on the track.
 *
 * Everything here is a pure function over the directory snapshot, because the
 * two failures this module exists to prevent are both reasoning bugs rather than
 * rendering bugs:
 *
 *   1. **Position inferred from an index.** A level is identified by its `id`
 *      and nothing else. The list is whatever the CURRENT model advertises, in
 *      the order it advertises it — providers differ, and a level id that is
 *      absent from that list must never be drawn as "the first one". A slider
 *      parked at the left end while the model is actually running at `max` is
 *      worse than no slider at all.
 *
 *   2. **A position carried across a model switch.** Every derived value is
 *      keyed by {@link levelKey}, which folds the provider, the model and the
 *      ordered level ids into one string. A different model — or the same model
 *      whose advertised list changed — produces a different key, and the caller
 *      drops its draft on that transition instead of reusing an index that meant
 *      something else a moment ago.
 *
 * @module @dsh-app/plugin-effort/client/levels
 */

/** One level as the current model advertises it. */
export interface EffortLevel {
  /** Provider-owned level id: the ONLY thing a position may be resolved from. */
  readonly id: string
  /** Display name, falling back to the id when the host sent none. */
  readonly name: string
}

/**
 * The slice of the directory snapshot these helpers read.
 *
 * Structural rather than an import of the kernel's `ModelDirectoryState`: the
 * store's own type satisfies it, and a test can build one without inventing the
 * fields (status, failures, pending, error) this module never looks at.
 */
export interface EffortSnapshot {
  /** The session's saved selection, or null before the projection resolves. */
  readonly current: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  } | null
  /** Loaded provider groups (last good load). */
  readonly groups: readonly {
    readonly id: string
    readonly models: readonly {
      readonly id: string
      readonly reasoning?: {
        readonly efforts: readonly { readonly id: string, readonly name: string }[]
        readonly defaultEffort?: string
      }
    }[]
  }[]
}

/** What the track should show, in the four cases that are actually different. */
export type EffortState =
  /** Nothing to drive: no selection yet, an unloaded catalog, or a model without levels. */
  | { readonly kind: 'absent' }
  /** Levels exist, but nothing marks a position: no explicit value and no advertised default. */
  | { readonly kind: 'unset', readonly levels: readonly EffortLevel[] }
  /** An explicit value the current model does not list, and no usable default to fall back to. */
  | { readonly kind: 'unknown', readonly levels: readonly EffortLevel[], readonly raw: string }
  /** A known level, either the explicit selection or the model's advertised default. */
  | {
    readonly kind: 'ready'
    readonly levels: readonly EffortLevel[]
    readonly index: number
    /** True when the position comes from the model's default rather than the saved selection. */
    readonly fallback: boolean
  }

/** How the track behaves for one state. */
export type TrackMode =
  /** Two or more levels and a usable scale: draggable, keyboard-operable. */
  | 'interactive'
  /** Exactly one level: the track is full and there is nothing to choose. */
  | 'single'
  /** No scale to show: the track is inert. */
  | 'static'

/**
 * The current model's own level list, in the host's order.
 *
 * Order is deliberately NOT normalised. The official menu renders the same list
 * in the same order, so re-sorting here would put the two surfaces at odds —
 * a level that is second in the menu would be third on the track.
 *
 * @param snapshot - the directory snapshot.
 * @returns the usable levels; entries without an id, and repeat ids, are dropped.
 */
export function levelsOf(snapshot: EffortSnapshot): readonly EffortLevel[] {
  const efforts = modelOf(snapshot)?.reasoning?.efforts ?? []
  const out: EffortLevel[] = []
  const seen = new Set<string>()
  for (const effort of efforts) {
    if (typeof effort?.id !== 'string' || effort.id === '') continue
    if (seen.has(effort.id)) continue
    seen.add(effort.id)
    out.push({ id: effort.id, name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id })
  }
  return out
}

/**
 * Identity of the level list a position was computed against.
 *
 * @param snapshot - the directory snapshot.
 * @returns `provider/model/id,id,id`, or an empty string with no selection.
 */
export function levelKey(snapshot: EffortSnapshot): string {
  const current = snapshot.current
  if (current === null) return ''
  const ids = levelsOf(snapshot).map(level => level.id).join(',')
  return `${current.provider}/${current.model}/${ids}`
}

/**
 * Index of one level id, or -1 when the current list does not carry it.
 * @param levels - the current model's levels.
 * @param id - the level id to locate.
 * @returns the index, or -1. Never a stand-in for "first".
 */
export function indexOfLevel(levels: readonly EffortLevel[], id: string | undefined): number {
  if (typeof id !== 'string' || id === '') return -1
  for (let index = 0; index < levels.length; index += 1) {
    if (levels[index]?.id === id) return index
  }
  return -1
}

/**
 * Resolve what the track should show for one snapshot.
 *
 * The order of the branches IS the rule set: an explicit selection wins, the
 * model's advertised default is the honest stand-in for "the host will use
 * this", and a value the model does not list is reported as unknown rather than
 * snapped onto the first level.
 *
 * @param snapshot - the directory snapshot.
 * @returns the state to render.
 */
export function resolveEffort(snapshot: EffortSnapshot): EffortState {
  const levels = levelsOf(snapshot)
  if (snapshot.current === null || levels.length === 0) return { kind: 'absent' }
  const selected = snapshot.current.reasoningEffort
  const selectedIndex = indexOfLevel(levels, selected)
  if (selectedIndex >= 0) return { kind: 'ready', levels, index: selectedIndex, fallback: false }
  const fallbackIndex = indexOfLevel(levels, modelOf(snapshot)?.reasoning?.defaultEffort)
  if (fallbackIndex >= 0) return { kind: 'ready', levels, index: fallbackIndex, fallback: true }
  // The saved value is not in this model's list and there is no default to
  // stand in for it. Naming the raw id is the honest answer: it is what the
  // session will send, and inventing a position for it would misreport it.
  if (typeof selected === 'string' && selected !== '') return { kind: 'unknown', levels, raw: selected }
  return { kind: 'unset', levels }
}

/**
 * The track's behaviour for one state.
 *
 * `unset` is INTERACTIVE on purpose. It is the state a session starts in
 * whenever the model advertises no default effort — there is nothing set yet —
 * so an inert track there would make the control useless exactly when it is most
 * useful. The position is what is missing, not the scale: the track draws empty
 * and the first drag pins a level.
 *
 * `unknown` is inert for the opposite reason: the level in use is not on this
 * scale, so there is no honest position AND no obvious meaning for a drag. The
 * official menu is still there for that case.
 *
 * @param state - the resolved state.
 * @returns the mode the component renders with.
 */
export function trackModeOf(state: EffortState): TrackMode {
  if (state.kind === 'absent' || state.kind === 'unknown') return 'static'
  if (state.levels.length <= 1) return 'single'
  return 'interactive'
}

/**
 * The level index a position should commit, for the given mode.
 *
 * @param mode - the track's behaviour.
 * @param index - the position the user moved to.
 * @param count - number of levels.
 * @returns the index to commit, or null when this mode commits nothing (a
 *   single-level track has nothing to change, an inert track has no position).
 */
export function commitIndexFor(mode: TrackMode, index: number, count: number): number | null {
  if (mode !== 'interactive') return null
  if (!Number.isInteger(index) || index < 0 || index >= count) return null
  return index
}

/**
 * The current model's catalog entry.
 * @param snapshot - the directory snapshot.
 * @returns the entry, or undefined when the selection is not in the catalog.
 */
function modelOf(snapshot: EffortSnapshot): EffortSnapshot['groups'][number]['models'][number] | undefined {
  const current = snapshot.current
  if (current === null) return undefined
  for (const group of snapshot.groups) {
    if (group.id !== current.provider) continue
    for (const model of group.models) {
      if (model.id === current.model) return model
    }
  }
  return undefined
}
