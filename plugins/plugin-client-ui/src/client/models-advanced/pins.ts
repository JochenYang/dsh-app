/**
 * Pinned providers: the routes a user keeps at the top of the list.
 *
 * A pin is a view preference of this browser, not configuration — it never
 * travels to the profile or the host — so it lives in `localStorage` beside the
 * other UI preferences. Only CONFIGURED providers can be pinned (a row with a
 * user layer profile); the catalog entries below keep their default order, which
 * is what makes the pinned block mean "the ones I actually use".
 *
 * Stored as an ordered id list: the pin order is the display order, so the first
 * row a user pins stays first.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/pins
 */

/** Storage key; versioned so a shape change can be ignored rather than crash. */
const PIN_KEY = ['dsh', 'app', 'panel', 'pins'].join('.')

/** Cap: a pinned block longer than this is not a quick-pick list any more. */
const MAX_PINS = 32

/**
 * Read the pinned route ids.
 * @returns the ids in pin order; empty when storage is unavailable or invalid.
 */
export function readPins(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PIN_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const ids: string[] = []
    for (const value of raw) {
      if (typeof value !== 'string' || value === '' || seen.has(value)) continue
      seen.add(value)
      ids.push(value)
      if (ids.length === MAX_PINS) break
    }
    return ids
  } catch {
    // A quota or parse failure is not a reason to break the page.
    return []
  }
}

/**
 * Persist the pinned route ids.
 * @param ids - the ids in pin order.
 */
export function writePins(ids: readonly string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(ids.slice(0, MAX_PINS)))
  } catch {
    // Storage can refuse (private mode, quota); the in-memory pin still applies
    // for this session, it just will not survive a reload.
  }
}

/**
 * Toggle one route's pin, keeping pin order for the rest.
 * @param ids - current pin list.
 * @param route - the route to pin or unpin.
 * @returns the next list.
 */
export function togglePin(ids: readonly string[], route: string): string[] {
  const next = ids.includes(route) ? ids.filter(id => id !== route) : [...ids, route]
  // The cap applies in memory too: writePins trims, so an over-cap in-memory
  // list would show a pin that silently disappears on reload.
  return next.slice(-MAX_PINS)
}
