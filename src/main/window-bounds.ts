/**
 * Where the main window opens, and what it remembers about the last time.
 *
 * A window that always opens at a fixed size is either cramped on a large
 * display or taller than the screen on a small one — and Electron does not
 * clamp a window to the display, so a too-tall rect opens with its footer
 * below the screen. Two rules follow, and both live here rather than in
 * `window.ts`, so a test can drive them for displays this machine does not
 * have:
 *
 *   1. A display that has never seen this app gets {@link IDEAL_WINDOW_WIDTH}
 *      × {@link IDEAL_WINDOW_HEIGHT}, capped by the work area (minus a margin,
 *      so the window still reads as a window rather than a maximized one) and
 *      floored by the minimums the three-pane layout declares.
 *   2. A display that HAS gets the user's own geometry back — their size, not
 *      the ideal: the ideal is a default, never a maximum. It is still capped
 *      by the work area, because a size chosen on a 4K monitor must not open
 *      larger than the laptop screen it is restored onto.
 *
 * The classic bug in (2) is restoring a POSITION onto a monitor that is no
 * longer attached: the window opens off-screen and the user sees nothing at
 * all. So a saved position is only reused when it still lands on a display
 * that exists; otherwise the position is dropped and the OS places the window,
 * which is visible by construction. Size survives either way.
 *
 * Every failure path — no file, malformed JSON, wrong types, a geometry that
 * cannot be made to fit — resolves to the default in (1). Nothing here ever
 * throws into the boot.
 *
 * @module dsh-app/main/window-bounds
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Persisted main-window geometry — the shape this module WRITES. */
export interface WindowBounds {
  width: number
  height: number
  x: number
  y: number
  /** Whether the window was maximized when the geometry was last recorded. */
  maximized: boolean
}

/**
 * What a read produced. The size is the part worth keeping; the position
 * survives only when it validated as a pair, so a file with a damaged `x` or a
 * missing `y` still yields a usable size instead of nothing at all.
 */
export interface RememberedGeometry {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

/** Opens at this size on a display that has never run the app. */
export const IDEAL_WINDOW_WIDTH = 1440
export const IDEAL_WINDOW_HEIGHT = 900

/** The three-pane layout needs at least this much; below it the panes break. */
export const MIN_WINDOW_WIDTH = 900
export const MIN_WINDOW_HEIGHT = 600

/**
 * Inset kept when choosing a DEFAULT size, so a first launch reads as a window
 * rather than a maximized one. Not applied to a saved size: the user who
 * dragged the window to the screen edge meant it.
 */
const DEFAULT_MARGIN = 80

/** The slice of Electron's `Display` this module needs (and a test can fake). */
export interface DisplayLike {
  readonly workArea: { readonly x: number, readonly y: number, readonly width: number, readonly height: number }
}

/** A size the window is allowed to take. */
export interface WindowSize {
  width: number
  height: number
}

/**
 * Fit a size to one work area.
 *
 * @param workArea - the display's usable rectangle.
 * @param preferred - the user's own size, when one was remembered. Omitted
 *   (or unusable) means "choose a default for this display".
 * @returns a size within `[MIN, preferred-or-ideal]` and never larger than the
 *   work area — except that the MINIMUM wins when even that does not fit, in
 *   which case the display cannot run the layout at its declared minimum.
 */
export function fitWindowToWorkArea(
  workArea: { readonly width: number, readonly height: number },
  preferred?: WindowSize,
): WindowSize {
  const wantsDefault = preferred === undefined
  const wanted = preferred ?? { width: IDEAL_WINDOW_WIDTH, height: IDEAL_WINDOW_HEIGHT }
  const headroom = wantsDefault
    // The margin belongs to DEFAULT placement only: a remembered size is
    // capped by the work area itself, so a window the user sized to fill the
    // screen is restored at that size instead of being quietly narrowed.
    ? { width: workArea.width - DEFAULT_MARGIN, height: workArea.height - DEFAULT_MARGIN }
    : { width: workArea.width, height: workArea.height }
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(wanted.width, headroom.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(wanted.height, headroom.height)),
  }
}

/** Whether a rectangle overlaps some display's work area at all. */
export function intersectsSomeDisplay(
  rect: { x: number, y: number, width: number, height: number },
  displays: readonly DisplayLike[],
): boolean {
  return displays.some(({ workArea }) =>
    rect.x < workArea.x + workArea.width
    && rect.x + rect.width > workArea.x
    && rect.y < workArea.y + workArea.height
    && rect.y + rect.height > workArea.y)
}

/**
 * The geometry to open with: the remembered size if there is one, the default
 * otherwise, plus the remembered position only when a display still covers it.
 *
 * @param saved - whatever came off disk; validated here, not by the caller.
 * @param displays - the displays present NOW (not the ones present when the
 *   geometry was recorded).
 * @param workArea - the work area of the display the window will open on,
 *   used to cap the size.
 * @returns Electron-ready options. `x`/`y` are absent when the saved position
 *   cannot be trusted, which lets the OS place the window somewhere visible.
 */
export function resolveWindowGeometry(
  saved: unknown,
  displays: readonly DisplayLike[],
  workArea: { readonly width: number, readonly height: number },
): WindowSize & { x?: number, y?: number } {
  const bounds = toWindowBounds(saved)
  const size = fitWindowToWorkArea(workArea, bounds === undefined ? undefined : { width: bounds.width, height: bounds.height })
  if (bounds?.x === undefined || bounds.y === undefined) return size
  if (!intersectsSomeDisplay({ x: bounds.x, y: bounds.y, width: size.width, height: size.height }, displays)) return size
  return { ...size, x: bounds.x, y: bounds.y }
}

/**
 * The rectangle to persist for a live window, or undefined when there is
 * nothing worth remembering: a maximized or fullscreen window reports the
 * SCREEN's geometry as its bounds, and storing that would make the next launch
 * open screen-sized at position 0,0 — losing the size the user had before they
 * maximized. The pre-maximize rectangle is what the caller passes instead.
 */
/**
 * Validate whatever came off disk. The SIZE is what matters, so it is required
 * and everything else degrades around it: a position is only used when both
 * coordinates are finite numbers, and a missing or damaged pair costs the
 * position alone rather than the whole record. `maximized` is never inferred —
 * only an explicit `true` counts.
 *
 * @returns the usable geometry, or undefined when even the size is unusable.
 */
export function toWindowBounds(value: unknown): RememberedGeometry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const size = [candidate.width, candidate.height]
  if (size.some(raw => typeof raw !== 'number' || !Number.isFinite(raw))) return undefined
  const position = [candidate.x, candidate.y]
  const hasPosition = position.every(raw => typeof raw === 'number' && Number.isFinite(raw))
  return {
    width: Math.round(candidate.width as number),
    height: Math.round(candidate.height as number),
    ...(hasPosition
      ? { x: Math.round(candidate.x as number), y: Math.round(candidate.y as number) }
      : {}),
    maximized: candidate.maximized === true,
  }
}

/** Where the shell remembers the main window's geometry, inside userData. */
export function windowStateFile(userDataDir: string): string {
  return path.join(userDataDir, 'window-bounds.json')
}

/**
 * Read remembered geometry. Tolerant by contract: a missing file, malformed
 * JSON, or a shape this module does not recognize all mean "nothing
 * remembered", which the caller answers with the default size. */
export function readWindowBounds(file: string): RememberedGeometry | undefined {
  try {
    return toWindowBounds(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Persist geometry. Best-effort: a shell that cannot write its own window
 * state still has to open a window, so a failure here is swallowed rather
 * than thrown into the boot.
 */
export function writeWindowBounds(file: string, bounds: WindowBounds): void {
  try {
    writeFileSync(file, `${JSON.stringify(bounds, null, 2)}\n`, 'utf8')
  } catch {
    // unwritable state file: the next launch opens at the default size
  }
}
