/**
 * Track geometry and the two CSS expressions that place everything on it.
 *
 * One module owns the numbers because they have to agree in three places at
 * once: the stylesheet (track height, knob size), the React layer (knob offset,
 * fill clip, tick positions) and the pointer math (which maps a client x to a
 * percentage of the knob's travel). A single number changed in one of them and
 * not the others is the "knob sits off its tick" class of bug.
 *
 * The knob is deliberately the SAME size as the track: the track is 28px tall,
 * so a 28px knob reads as the track's own end cap rather than a bead riding on
 * top of it, and the travel inset is exactly the radius at both ends.
 *
 * @module @dsh-app/plugin-effort/client/geometry
 */

/** Track height in px; also the knob diameter. */
export const TRACK_HEIGHT = 28

/** Knob diameter in px — the track height, so the two can never disagree. */
export const KNOB_SIZE = TRACK_HEIGHT

/** Knob radius in px: the travel inset at each end of the track. */
export const KNOB_RADIUS = KNOB_SIZE / 2

/**
 * Horizontal padding the injected row borrows from the official cell, in px.
 *
 * The official effort row is `padding: 0 8px` inside a menu that carries its own
 * 4px padding, and our row is that row's SIBLING. Copying the cell's inline
 * padding is what puts the track's left edge on the label's left edge instead of
 * 8px to its left.
 */
export const ROW_PADDING_INLINE = 8

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

/**
 * The track fraction under a pointer, in the knob's own travel.
 *
 * @param clientX - pointer x in viewport coordinates.
 * @param rect - the track's bounding rect.
 * @returns the fraction, or null when the track has no usable width (hidden or
 *   mid-layout, where any answer would be a guess).
 */
export function pctAt(clientX: number, rect: { readonly left: number, readonly width: number }): number | null {
  const usable = rect.width - KNOB_RADIUS * 2
  if (!(usable > 0)) return null
  return clamp01((clientX - rect.left - KNOB_RADIUS) / usable)
}
