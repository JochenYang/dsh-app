/**
 * The track's animation loop: one rAF, two springs, one canvas.
 *
 * ## Why this is not React state
 *
 * Everything this module moves changes every frame — the knob's offset, the fill's
 * clip, the bloom's edge, ~200 canvas cells. Routing that through `setState` would
 * re-render the portal subtree (which lives inside the official menu's row) sixty
 * times a second, for values no element in that subtree reads as markup: the
 * position is a CSS custom property and the field is a canvas, and neither is
 * React's. So the loop writes:
 *
 *   - `--dshAppEffort-pct`, `--dshAppEffort-energy` and `--dshAppEffort-galaxy` on
 *     the track, which the stylesheet reads for the knob, the fill and the fade;
 *   - the canvas, through {@link paintStarfield}.
 *
 * React still renders on a level change, and it still writes those properties as
 * inline style on the first paint — the loop takes over from the first frame and
 * writes the same values, so there is no frame where the control is unpositioned.
 *
 * ## Lifecycle
 *
 * The loop runs while the control is mounted, because the field twinkles at every
 * level (see `starfield.ts`, rule 1) — there is no settled frame to stop on. It
 * stops on `dispose`, and while the document is hidden: a menu left open in a
 * background window must not keep a canvas painting.
 *
 * A reduced-motion reader gets the same field at a frozen instant, and no loop at
 * all: the springs snap on every target, one frame is painted, and that is the
 * whole animation. The texture is then decoration rather than motion, which is what
 * the preference asks for.
 *
 * @module @dsh-app/plugin-effort/client/motion
 */

import { ENERGY_VAR, GALAXY_VAR, PCT_VAR, clamp01 } from './geometry.ts'
import { advanceSpring, createSpring, GALAXY_SPRING, POSITION_SPRING } from './spring.ts'
import { CELL_DARK, CELL_LIGHT, energyFor, paintStarfield, type FieldFrame } from './starfield.ts'
import { isDarkTheme, rampColorAt, rgbOf, type RampStop } from './value-color.ts'

/** What the track needs from its surroundings; all lazy, because refs are. */
export interface TrackMotionOptions {
  /** The host document, or null outside a DOM. */
  readonly doc: Document | null
  /** The host window, or null outside a DOM. */
  readonly win: Window | null
  /** The element the custom properties are written to. */
  readonly track: () => HTMLElement | null
  /** The canvas the field is painted on. */
  readonly canvas: () => HTMLCanvasElement | null
  /** The level ramp for the current theme: the field's accent is its far end. */
  readonly ramp: () => readonly RampStop[]
}

/** The handle the component holds. */
export interface TrackMotion {
  /**
   * Point the springs at a level's position and at whether the top level is in use.
   * @param pct - the level's fraction of the travel.
   * @param galaxy - whether the top level is the level being shown.
   */
  setTarget(pct: number, galaxy: boolean): void
  /** Stop the loop and release everything. */
  dispose(): void
}

/**
 * Start the track's motion loop.
 *
 * @param options - the refs the loop reads.
 * @returns the handle, or null when there is no DOM to animate in.
 */
export function createTrackMotion(options: TrackMotionOptions): TrackMotion | null {
  // Read through locals with the narrowed types: the guard below is what makes
  // them non-null, and a hoisted function declaration does not keep that narrowing.
  if (options.doc === null || options.win === null) return null
  const doc: Document = options.doc
  const win: Window = options.win

  const position = createSpring(0)
  const galaxy = createSpring(0)
  let targetPct = 0
  let targetGalaxy = 0
  /** The field's clock, in ms. Only advances while the loop runs. */
  let clock = 0
  let last = 0
  let frame = 0
  let width = 0
  let height = 0
  let canvas: HTMLCanvasElement | null = null
  let context: CanvasRenderingContext2D | null = null
  let observer: ResizeObserver | null = null
  /** Whether a target has ever been set; see the first-target case in `setTarget`. */
  let initialised = false
  let reduced: MediaQueryList | null = null
  try {
    reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  } catch {
    // A host without matchMedia is a host without the preference: animate.
  }

  /** Whether the springs should be skipped entirely. */
  const isReduced = (): boolean => reduced?.matches === true

  /**
   * Take the canvas's CSS size into its backing store.
   *
   * The device pixel ratio is applied once per size change rather than per frame:
   * `canvas.width` also RESETS the context's transform, so writing it every frame
   * would undo the scale that was just set.
   */
  const measure = (): void => {
    const node = canvas
    if (node === null) return
    const rect = node.getBoundingClientRect()
    width = Math.max(0, rect.width)
    height = Math.max(0, rect.height)
    const ratio = Math.max(1, win.devicePixelRatio || 1)
    const backingWidth = Math.max(1, Math.round(width * ratio))
    const backingHeight = Math.max(1, Math.round(height * ratio))
    if (node.width !== backingWidth || node.height !== backingHeight) {
      node.width = backingWidth
      node.height = backingHeight
    }
    context?.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  /** Bind the canvas if the portal has produced one, and size it. */
  const ensure = (): void => {
    const node = options.canvas()
    if (node === canvas) {
      if (node !== null && (width === 0 || height === 0)) measure()
      return
    }
    observer?.disconnect()
    observer = null
    canvas = node
    context = node === null ? null : node.getContext('2d')
    if (node === null) return
    measure()
    // The menu re-lays itself out from its own content, so the track's width is
    // not known until it has been placed; this is what re-sizes the field when the
    // card grows (a note line arriving) without a resize event.
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        measure()
        draw()
      })
      observer.observe(node)
    }
    if (reduced !== null && typeof reduced.addEventListener === 'function') {
      reduced.addEventListener('change', onReducedChange)
    }
  }

  /** Write the frame: three custom properties, then the field. */
  const draw = (): void => {
    const track = options.track()
    const pct = clamp01(position.value)
    const swell = clamp01(galaxy.value)
    if (track !== null) {
      track.style.setProperty(PCT_VAR, pct.toFixed(4))
      track.style.setProperty(ENERGY_VAR, energyFor(pct).toFixed(4))
      track.style.setProperty(GALAXY_VAR, swell.toFixed(4))
    }
    if (context === null) return
    const dark = isDarkTheme(doc)
    const field: FieldFrame = {
      width,
      height,
      pct,
      energy: energyFor(pct),
      galaxy: swell,
      timeMs: clock,
      base: dark ? CELL_DARK : CELL_LIGHT,
      accent: rgbOf(rampColorAt(options.ramp(), 1)),
    }
    paintStarfield(context, field)
  }

  /** One frame. Reschedules itself while the control is mounted and visible. */
  const tick = (now: number): void => {
    frame = 0
    if (doc.hidden) return
    // The first frame after a wake has no predecessor to measure against; a
    // nominal 60fps step is the right guess, and the springs absorb it.
    const seconds = last === 0 ? 1 / 60 : (now - last) / 1000
    last = now
    clock += Math.min(seconds, 0.032) * 1000
    advanceSpring(position, targetPct, seconds, POSITION_SPRING)
    advanceSpring(galaxy, targetGalaxy, seconds, GALAXY_SPRING)
    draw()
    frame = win.requestAnimationFrame(tick)
  }

  /** Start the loop if it is not already running (and motion is allowed). */
  function wake(): void {
    if (isReduced() || doc.hidden || frame !== 0) return
    last = 0
    frame = win.requestAnimationFrame(tick)
  }

  /**
   * The preference was changed while the control is mounted.
   *
   * Turning it ON has to LAND the control, not just stop the loop: the springs are
   * what carry it between levels, so stopping mid-flight would leave the knob
   * between two ticks for as long as the menu stays open.
   */
  function onReducedChange(): void {
    if (isReduced()) {
      position.value = targetPct
      position.velocity = 0
      galaxy.value = targetGalaxy
      galaxy.velocity = 0
      sleep()
      draw()
      return
    }
    wake()
  }

  /** Leave the loop; the next {@link wake} restarts it. */
  const sleep = (): void => {
    if (frame === 0) return
    win.cancelAnimationFrame(frame)
    frame = 0
    last = 0
  }

  const onVisibility = (): void => {
    if (doc.hidden) sleep()
    else wake()
  }
  doc.addEventListener('visibilitychange', onVisibility)

  return {
    setTarget(pct: number, nextGalaxy: boolean): void {
      targetPct = clamp01(pct)
      targetGalaxy = nextGalaxy ? 1 : 0
      ensure()
      if (!initialised) {
        // The first target is not a movement: the menu is opening on the session's
        // own level, and a knob that slid in from the left end would be announcing
        // a change nobody made.
        initialised = true
        position.value = targetPct
        position.velocity = 0
        galaxy.value = targetGalaxy
        galaxy.velocity = 0
      }
      if (isReduced()) {
        // No spring, no loop: the control arrives at each level and stays there.
        position.value = targetPct
        position.velocity = 0
        galaxy.value = targetGalaxy
        galaxy.velocity = 0
        draw()
        return
      }
      // Painted once HERE, not only on the next frame. `setTarget` runs from a
      // layout effect, so this is the last moment before the browser paints: leave
      // it to the rAF and the first frame of a freshly opened menu would show the
      // knob at the left end of the track for one frame. The value drawn is the
      // spring's current one, which is what the last frame already showed, so the
      // extra paint costs nothing visible.
      draw()
      wake()
    },
    dispose(): void {
      sleep()
      observer?.disconnect()
      observer = null
      doc.removeEventListener('visibilitychange', onVisibility)
      if (reduced !== null && typeof reduced.removeEventListener === 'function') {
        reduced.removeEventListener('change', onReducedChange)
      }
      canvas = null
      context = null
    },
  }
}
