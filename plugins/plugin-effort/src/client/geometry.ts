/**
 * Track geometry and the two CSS expressions that place everything on it.
 *
 * One module owns the numbers because they have to agree in three places at
 * once: the stylesheet (track height, knob size, the note line's band), the React
 * layer (knob offset, fill clip, tick positions) and the pointer math (which maps
 * a client x to a percentage of the knob's travel). A single number changed in one
 * of them and not the others is the "knob sits off its tick" class of bug.
 *
 * The knob is deliberately the SAME size as the track: the track is 28px tall,
 * so a 28px knob reads as the track's own end cap rather than a bead riding on
 * top of it, and the travel inset is exactly the radius at both ends.
 *
 * The note under the track is the other half of that: its line height is also the
 * floor its own box keeps, whether or not it has a sentence to show, because the
 * injected container's height is what decides where the official menu places
 * itself. See {@link NOTE_LINE_HEIGHT}.
 *
 * @module @dsh-app/plugin-effort/client/geometry
 */

/** Track height in px; also the knob diameter. */
export const TRACK_HEIGHT = 28

/**
 * The note line's height in px: its `line-height`, and the floor its box keeps.
 *
 * The floor is the point of it. The note explains the state when there is
 * something to explain and stays silent when the track speaks for itself, so its
 * sentence comes and goes while the container around it must not: the official
 * menu is placed from its own height (`top = trigger.top − 8 − height`, read from
 * the installed model-selection component), and a card that shrinks by this line
 * is a card that jumps by it AND re-measures the track under the pointer. An empty
 * `<p>` collapses to zero, so the reservation has to be declared.
 */
export const NOTE_LINE_HEIGHT = 16

/** The air between the track and the note, in px — the note's own `margin-top`. */
export const NOTE_MARGIN_TOP = 4

/** Knob diameter in px — the track height, so the two can never disagree. */
export const KNOB_SIZE = TRACK_HEIGHT

/** Knob radius in px: the travel inset at each end of the track. */
export const KNOB_RADIUS = KNOB_SIZE / 2

/**
 * Width of the leading-edge bloom, in px.
 *
 * A ramp, not a bar: it fades back into the fill over this distance, so the
 * highlight reads as the fill being pushed rather than as a second segment. Kept
 * shorter than the knob's diameter (28px) so the whole ramp stays inside the
 * fill's own visible span.
 */
export const BLOOM_WIDTH = 26

/** Fractions are rounded to this many decimals before they enter a CSS expression. */
const FRACTION_DIGITS = 4

/**
 * Clamp to 0..1, mapping NaN and negatives to 0.
 * @param value - any number, including NaN.
 * @returns the value inside 0..1.
 */
export function clamp01(value: number): number {
  if (!(value > 0)) return 0
  return value > 1 ? 1 : value
}

/**
 * The position of one level on the track.
 *
 * A single level is the whole story — there is no second position to be between
 * — so it reads as FULL rather than as the left end. That is the whole fix for
 * "a model with one level should just show it as maxed out": the level IS the
 * maximum, and a knob parked at 0 would say the opposite.
 *
 * @param index - level index.
 * @param count - number of levels.
 * @returns the fraction of the travel, 0..1.
 */
export function pctFromIndex(index: number, count: number): number {
  if (count <= 1) return 1
  const safe = Math.max(0, Math.min(count - 1, index))
  return safe / (count - 1)
}

/**
 * The nearest level index for a position on the track.
 * @param pct - fraction of the travel, 0..1.
 * @param count - number of levels.
 * @returns the clamped index; 0 when there is nothing to choose between.
 */
export function indexFromPct(pct: number, count: number): number {
  if (count <= 1) return 0
  return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))))
}

/**
 * Where a knob at `pct` sits, as a CSS length.
 *
 * `14px + pct * (100% - 28px)` is the knob's CENTRE measured from the track's
 * left edge: the travel is the track width minus one diameter, and the first
 * half-diameter is the inset that keeps the knob inside the rounded ends.
 *
 * @param pct - fraction of the travel, 0..1.
 * @returns a `calc()` length, relative to the element's own width.
 */
export function offsetExpr(pct: number): string {
  const t = clamp01(pct).toFixed(FRACTION_DIGITS)
  return `calc(${KNOB_RADIUS}px + ${t} * (100% - ${KNOB_SIZE}px))`
}

/**
 * Where the fill's VISIBLE leading edge is, as a CSS length.
 *
 * The fill's clip runs to the knob's CENTRE, so its last 14px sit behind the knob;
 * what the eye reads as the edge is the knob's left rim. That rim is the knob's
 * offset minus one radius, which collapses to `pct * (100% - KNOB_SIZE)` from the
 * track's left end — the same travel the knob's own expression uses, without the
 * radius term. The bloom anchors here rather than at the clip, so its bright end
 * lands on the edge that is actually visible.
 *
 * @param pct - fraction of the travel, 0..1.
 * @returns a `calc()` length, relative to the element's own width.
 */
export function headEdgeExpr(pct: number): string {
  const t = clamp01(pct).toFixed(FRACTION_DIGITS)
  return `calc(${t} * (100% - ${KNOB_SIZE}px))`
}

/**
 * The clip that keeps a full-width layer inside the filled part of the track.
 *
 * The fill and the mosaic layer are painted at the track's full width with a
 * gradient anchored to the track itself, then clipped — rather than being sized
 * to `pct` with the gradient inside them. The difference is visible while
 * dragging: an anchored gradient keeps the colour at a given x constant and only
 * changes how far it reaches, so the bar looks like a cover sliding off a fixed
 * scale instead of a colour that recomputes itself on every frame.
 *
 * @param pct - fraction of the travel, 0..1.
 * @returns an `inset()` clip for the element's own box.
 */
export function fillClip(pct: number): string {
  const t = clamp01(pct).toFixed(FRACTION_DIGITS)
  return `inset(0 calc(100% - ${KNOB_RADIUS}px - ${t} * (100% - ${KNOB_SIZE}px)) 0 0)`
}

/** The track's box, as far as the pointer math is concerned. */
export interface TrackRect {
  /** Viewport x of the track's left edge. */
  readonly left: number
  /** The track's width. */
  readonly width: number
}

/**
 * The track fraction under a pointer, in the knob's own travel.
 *
 * @param clientX - pointer x in viewport coordinates.
 * @param rect - the track's box.
 * @returns the fraction, or null when the track has no usable width (hidden or
 *   mid-layout, where any answer would be a guess).
 */
export function pctAt(clientX: number, rect: TrackRect): number | null {
  const usable = rect.width - KNOB_RADIUS * 2
  if (!(usable > 0)) return null
  return clamp01((clientX - rect.left - KNOB_RADIUS) / usable)
}

/** A gesture's mapping from the pointer to a position; see {@link createGestureMap}. */
export interface GestureMap {
  /** Open a gesture on the box the track has right now. */
  begin(): void
  /** Close it. Every sample until the next {@link GestureMap.begin} answers null. */
  end(): void
  /**
   * The fraction of the travel under `clientX`.
   * @param clientX - pointer x in viewport coordinates.
   * @returns the fraction, or null when no gesture is open.
   */
  pctAt(clientX: number): number | null
}

/**
 * One gesture's own mapping from a pointer x to a position on the track.
 *
 * The box is read ONCE, when the gesture opens, and every sample of that gesture
 * goes through that one box. Re-measuring the track on every sample is the bug this
 * exists to prevent: the box moves under a pointer that has not moved, because the
 * card is placed from its own height and re-laid out from its own content — an
 * error line arriving, a locale switch, the note's sentence changing length — and a
 * sample re-mapped against the new box lands on a level the user never pointed at.
 * In measured round numbers: a 310px track that becomes 224px with its right edge
 * pinned moves the same `clientX` from 0.500 of the travel to 0.277 — and a press
 * at 0.27 of that travel starts one level up and finishes at the lowest, so the knob
 * walks out from under a stationary pointer and the host is asked for a level nobody
 * chose.
 *
 * Holding the box for the length of one gesture makes the position a function of the
 * pointer and of nothing else. A NEW gesture reads the box again, so the control is
 * never stuck on a box that is already gone — and this is the only place that has to
 * know either of those things.
 *
 * @param measure - reads the track's box right now, or null when there is no track.
 * @returns the map.
 */
export function createGestureMap(measure: () => TrackRect | null): GestureMap {
  let held: TrackRect | null = null
  return {
    begin(): void {
      held = measure()
    },
    end(): void {
      held = null
    },
    pctAt(clientX: number): number | null {
      return held === null ? null : pctAt(clientX, held)
    },
  }
}
