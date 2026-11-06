/**
 * The starfield: the track's own texture, and what the top level does to it.
 *
 * The fill colour answers "how much of the scale is in play" in one reading, and
 * the answer is coarse — four stops over five levels. The field is the second
 * reading, the one that survives a glance: a lattice of 2px squares over the whole
 * bar, denser toward the right, each one twinkling on its own phase so the bar is
 * never quite still.
 *
 * Three rules, and each one is a decision rather than a taste:
 *
 *   1. **It is drawn at EVERY level, faintly.** An earlier version of this layer
 *      started at a third of the travel, which left the bottom of the scale with
 *      nothing moving at all — the low levels read as a disabled control, and the
 *      difference between "level 0" and "no levels" was only the knob. The density
 *      floor ({@link DENSITY_FLOOR}) is therefore non-zero: a handful of dots are
 *      alight at the far left, and the count rises from there.
 *
 *   2. **It is deterministic per cell.** Every square's seed comes from its own
 *      index, never from `Math.random()`: the same position at the same instant
 *      always paints the same field, so the layer is assertable in a unit test and
 *      a repaint (a resize, a theme switch) does not reshuffle the sky.
 *
 *   3. **The top level is the same field, pushed.** The reference's "galaxy" is not
 *      a second ornament bolted beside the first: density goes up, the colour
 *      shifts from the theme's own near-white toward the end of the level ramp, and
 *      sparks fly out of the knob. Everything the swell needs is a multiplier on
 *      values this module already computes.
 *
 * The squares are `fillRect` rather than `roundRect`: at this size a rounded corner
 * is under a pixel and invisible, while the path work is paid on every one of ~200
 * cells at 60fps.
 *
 * @module @dsh-app/plugin-effort/client/starfield
 */

import { KNOB_RADIUS, KNOB_SIZE, clamp01 } from './geometry.ts'

/** Fraction of the travel below which the field is at its floor. */
export const ENERGY_START = 1 / 3

/** Density everywhere, whatever the position: rule 1 in the module header. */
export const DENSITY_FLOOR = 0.08

/**
 * How much the mid band adds to the floor at a fully-pushed track.
 *
 * Deliberately smaller than the galaxy's contribution: the mid band should read as
 * "more of this is in play", the top level as "this is a different thing".
 */
export const DENSITY_LIFT = 0.16

/**
 * How much the top level evens out the left-to-right falloff.
 *
 * A push toward coverage matters at the top more than a higher floor does. The
 * column ramp is what makes the bar read as a scale, and it is right for the
 * middle of it — but at the top level it left the left half at half the density of
 * the right one, and "the top level looks emptier than it should" is exactly what
 * that looks like. This blend keeps the ramp readable while filling the bar.
 */
export const GALAXY_SPREAD = 0.55

/**
 * How much the top level raises the ceiling on a cell's opacity.
 *
 * Multiplied in rather than added: a swell that added a constant would make the
 * dimmest cells nearly as bright as the brightest ones, flattening the twinkle it
 * is meant to intensify.
 */
export const GALAXY_ALPHA = 0.5

/** How far the twinkle swings a cell's likelihood of being alight, either way. */
export const TWINKLE_DEPTH = 0.18

/** How much the field grows toward the right of the track. */
export const COLUMN_RAMP = 0.7

/**
 * Distance between cell origins, in px.
 *
 * Five, not the six a first cut used: a 28px track with a 2px inset holds four rows
 * at six and five at five, and the number of rows is what decides whether the bar
 * reads as a texture or as a line of dashes.
 */
export const FIELD_PITCH = 5

/** A cell's edge, in px. */
export const FIELD_CELL = 2

/** Inset of the lattice from the track's box, in px. */
export const FIELD_PAD = 1

/** Golden angle in radians: any prefix of `ray * this` spreads evenly around a circle. */
export const GOLDEN_ANGLE = 2.399963229728653

/** How many rays the top level's burst has. */
export const SPARK_RAYS = 24

/** How many sparks ride each ray. */
export const SPARK_DOTS = 7

/**
 * Where the burst starts, in px from the knob's centre.
 *
 * Outside the knob's rim, not at its middle. The canvas is painted BENEATH the
 * knob, so every spark with a radius under the knob's own 14px was simply covered
 * by it — a third of the burst paid for and never seen.
 */
export const SPARK_INNER = 15

/** How far a spark travels before it fades out, in px. */
export const SPARK_SPAN = 30

/**
 * How much the burst is flattened vertically.
 *
 * The reference's burst is a circle on a 390px-tall canvas. This canvas is 28px
 * tall and clipped to the capsule, so a circular burst spends most of its rays
 * outside the clip and the visible ones are the few near horizontal. Flattening the
 * radius keeps every ray inside the bar, which is what makes the burst read as
 * energy along the track rather than as two wisps either side of the knob.
 */
export const SPARK_FLATTEN = 0.42

/**
 * How far the top level moves a cell's colour from the theme's near-white toward
 * the ramp's far end.
 *
 * Not 1.0, which is what the reference does and what a first cut of this module
 * did: at the far end the accent is the fill's OWN last stop, so cells drawn in it
 * sink into the bar they are drawn on — the field vanishes at exactly the level it
 * is supposed to announce. It is also not 0, which would make them plain white and
 * lose the level's colour. Under half is where the two readings meet: the cells stay
 * a clear step brighter than the fill in both themes while still being made of the
 * level's own hue.
 */
export const GALAXY_TINT = 0.45

/**
 * How much of a cell's computed opacity survives the additive blend.
 *
 * The field is painted with `globalCompositeOperation = 'lighter'`, so a cell ADDS
 * its colour to the fill instead of mixing toward it. That is what makes a sparkle
 * read as light on a saturated bar: plain alpha blending over a bright blue fill can
 * only push the cell toward the card's own colour, and at this size the difference
 * between a lilac dot and the blue behind it is a few percent of contrast.
 *
 * Additive drawing is also much stronger per unit of alpha — 100% additive white is
 * pure white, whatever is underneath — so the curve is scaled down here rather than
 * re-tuned: the same relative shape, half the amplitude, and the gaps between cells
 * keep the fill's own colour instead of washing over.
 */
export const FIELD_GAIN = 0.5

/** The same, for the top level's sparks: brighter than a cell, but not white-hot. */
export const SPARK_GAIN = 0.6

/** The cell colour in each theme, before the top level tints it. */
export const CELL_LIGHT: readonly [number, number, number] = [255, 255, 255]
export const CELL_DARK: readonly [number, number, number] = [242, 238, 255]

/** The lattice one canvas holds. */
export interface FieldGrid {
  /** Cells across. */
  readonly cols: number
  /** Cells down. */
  readonly rows: number
  /** Cell pitch in px. */
  readonly pitch: number
  /** Cell edge in px. */
  readonly cell: number
  /** x of the lattice's first cell, in px. */
  readonly originX: number
  /** y of the lattice's first cell, in px. */
  readonly originY: number
}

/**
 * The lattice for one canvas size, or null when there is no room for one.
 *
 * Whole cells only: a partial column at the right edge would read as a dimmer seam
 * whose position depends on the menu's width.
 *
 * @param width - the canvas's width, in CSS px.
 * @param height - its height, in CSS px.
 * @returns the grid, or null when it would hold nothing.
 */
export function fieldGrid(width: number, height: number): FieldGrid | null {
  if (!(width > 0) || !(height > 0)) return null
  const spanX = width - FIELD_PAD * 2
  const spanY = height - FIELD_PAD * 2
  const cols = Math.floor(spanX / FIELD_PITCH)
  const rows = Math.floor(spanY / FIELD_PITCH)
  if (cols < 1 || rows < 1) return null
  return {
    cols,
    rows,
    pitch: FIELD_PITCH,
    cell: FIELD_CELL,
    // Centred: the leftover pixels are split either side, so the lattice is not
    // keyed to the menu's own width.
    originX: FIELD_PAD + (spanX - cols * FIELD_PITCH) / 2,
    originY: FIELD_PAD + (spanY - rows * FIELD_PITCH) / 2,
  }
}

/**
 * A stable 0..1 value for an index and a salt.
 *
 * The same shape `./mosaic` used before this module replaced it: an integer hash
 * whose low bits are mixed well enough that adjacent indices are unrelated, which
 * is what keeps a row of cells from twinkling in step.
 *
 * @param index - a cell's index in the lattice.
 * @param salt - a different constant per property.
 * @returns a stable 0..1 value.
 */
export function cellSeed(index: number, salt: number): number {
  const value = ((index + 1) * salt * 2654435761) >>> 0
  return ((value >>> 8) % 1000) / 1000
}

/**
 * How far into the "more compute" half of the scale a position is.
 *
 * @param pct - fraction of the travel, 0..1.
 * @returns 0 at and below {@link ENERGY_START}, 1 at the far end.
 */
export function energyFor(pct: number): number {
  return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START))
}

/**
 * How likely one cell is to be alight.
 *
 * Three terms, in the order they matter: the floor (the track is never empty), the
 * position (a pushed track is busier), and the column (the right of the track is
 * busier than the left, which is the one asymmetry that survives every level —
 * "faster" at one end, "smarter" at the other).
 *
 * @param colNorm - the cell's column, 0 at the left edge and 1 at the right.
 * @param energy - {@link energyFor} of the displayed position.
 * @param galaxy - the top level's swell, 0..1.
 * @returns the likelihood, 0..1.
 */
export function cellDensityFor(colNorm: number, energy: number, galaxy: number): number {
  const swell = clamp01(galaxy)
  const floor = clamp01(DENSITY_FLOOR + DENSITY_LIFT * clamp01(energy))
  const ramp = 0.5 * clamp01(energy) + 0.5 * swell
  const across = (1 - COLUMN_RAMP) + COLUMN_RAMP * Math.pow(clamp01(colNorm), 1.5)
  // The top level evens the columns out; see GALAXY_SPREAD.
  const spread = across + (1 - across) * GALAXY_SPREAD * swell
  return clamp01(floor + (1 - floor) * ramp * spread)
}

/**
 * One lit cell's opacity.
 *
 * The twinkle is the multiplier, not the base: a cell that is merely alight is
 * already visible, and the wave varies it by a factor of about four rather than
 * from nothing. Cells past the knob are dimmed rather than dropped — the bar past
 * the current level is still part of the scale, and a texture that stopped dead at
 * the knob would read as a hard edge between two different controls.
 *
 * The column term is GENTLE and it evened out at the top level, because the density
 * already carries "busier to the right" ({@link cellDensityFor}). A first cut applied
 * the same ramp here as well, and the two multiplied: at the top level, where every
 * column is in play, the leftmost cells came out at 7% opacity over a saturated fill
 * — drawn, counted, and invisible. The reported symptom was "the left side of the
 * top level is empty"; the field was there, at one fifteenth of the contrast.
 *
 * @param wave - the cell's twinkle, 0..1.
 * @param colNorm - the cell's column, 0..1.
 * @param lit - whether the cell is left of the knob.
 * @param galaxy - the top level's swell, 0..1.
 * @returns the opacity, 0..1.
 */
export function cellAlphaFor(wave: number, colNorm: number, lit: boolean, galaxy = 0): number {
  const swing = clamp01(wave)
  const swell = 1 + GALAXY_ALPHA * clamp01(galaxy)
  const column = (3 + 7 * clamp01(colNorm)) / 10
  const across = column + (1 - column) * GALAXY_SPREAD * clamp01(galaxy)
  // The floor of this range is the number that decides whether the field reads at
  // all: a lit cell at 0.16 over a mid-tone fill is a rounding error.
  return clamp01((0.22 + 0.7 * swing) * across * (lit ? 1 : 0.45) * swell)
}

/**
 * The radius at which one spark sits, given the clock.
 *
 * Each ray's sparks run outward at their own speed and wrap, so the burst is a
 * continuous stream rather than one expanding shell — the same construction the
 * reference uses, kept because a single shell reads as a ripple and stops being an
 * ambient effect after its first pass.
 *
 * @param dot - the spark's index along its ray.
 * @param seconds - the field's clock.
 * @param seed - the ray's own seed.
 * @returns the offset from {@link SPARK_INNER}, in px, inside `0..SPARK_SPAN`.
 */
export function sparkRadiusFor(dot: number, seconds: number, seed: number): number {
  const speed = 10 + seed * 16
  const value = (dot * 13 + seconds * speed + seed * 40) % SPARK_SPAN
  return value < 0 ? value + SPARK_SPAN : value
}

/** Everything one painted frame needs. */
export interface FieldFrame {
  /** Canvas width in CSS px. */
  readonly width: number
  /** Canvas height in CSS px. */
  readonly height: number
  /** The displayed knob position, 0..1. May overshoot; clamped here. */
  readonly pct: number
  /** {@link energyFor} of the displayed position. */
  readonly energy: number
  /** The top level's swell, 0..1. */
  readonly galaxy: number
  /** The field's own clock, in ms. Frozen for a reduced-motion reader. */
  readonly timeMs: number
  /** The cell colour before the top level tints it. */
  readonly base: readonly [number, number, number]
  /** The ramp's far end: where the top level takes the colour. */
  readonly accent: readonly [number, number, number]
}

/**
 * Paint one frame.
 *
 * Clears first, because a canvas is opaque across frames while the field is
 * sparse: without it the squares would smear into the trails of where they were.
 *
 * @param ctx - the canvas's own context, already scaled for the device pixel ratio.
 * @param frame - what to draw.
 */
export function paintStarfield(ctx: CanvasRenderingContext2D, frame: FieldFrame): void {
  const width = Math.max(0, frame.width)
  const height = Math.max(0, frame.height)
  ctx.clearRect(0, 0, width, height)
  const grid = fieldGrid(width, height)
  if (grid === null) return
  const seconds = frame.timeMs / 1000
  const energy = clamp01(frame.energy)
  const galaxy = clamp01(frame.galaxy)
  const pct = clamp01(frame.pct)
  const knobX = KNOB_RADIUS + pct * (width - KNOB_SIZE)
  // One tint for the whole frame: every cell varies by opacity alone, which is
  // what keeps a 200-cell field to one colour computation. The move toward the
  // accent stops at GALAXY_TINT — see that constant for why not all the way.
  const tintBy = galaxy * GALAXY_TINT
  const tint = [
    Math.round(frame.base[0] + (frame.accent[0] - frame.base[0]) * tintBy),
    Math.round(frame.base[1] + (frame.accent[1] - frame.base[1]) * tintBy),
    Math.round(frame.base[2] + (frame.accent[2] - frame.base[2]) * tintBy),
  ]
  ctx.fillStyle = `rgb(${tint[0]} ${tint[1]} ${tint[2]})`
  // Additive from here to the end of the frame: a cell adds light to the bar
  // instead of mixing toward the card. See FIELD_GAIN.
  ctx.globalCompositeOperation = 'lighter'
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const index = row * grid.cols + col
      const seed = cellSeed(index, 17)
      const colNorm = grid.cols === 1 ? 1 : col / (grid.cols - 1)
      const wave = 0.5 + 0.5 * Math.sin(seconds * (0.9 + seed * 2.4) + index * 1.618)
      // The threshold, not the opacity, is what makes a cell appear and disappear:
      // a cell fading to zero and staying in the loop would read as a dim field of
      // constant count rather than as a sky.
      if (seed > cellDensityFor(colNorm, energy, galaxy) + TWINKLE_DEPTH * (wave - 0.5)) continue
      const x = grid.originX + col * grid.pitch
      const y = grid.originY + row * grid.pitch
      ctx.globalAlpha = cellAlphaFor(wave, colNorm, x <= knobX, galaxy) * FIELD_GAIN
      // Some cells are a pixel larger, which is what stops a dense field from
      // reading as graph paper. The top level raises the share of them: at this
      // size a mixed lattice is the only way to say "more" without adding rows.
      const edge = seed > 0.78 - 0.22 * galaxy ? grid.cell + 1 : grid.cell
      ctx.fillRect(x, y, edge, edge)
    }
  }
  if (galaxy > 0.002) paintSparks(ctx, frame, knobX, height / 2, galaxy, seconds)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/**
 * The top level's burst, clipped by the layer the canvas lives in.
 *
 * Kept inside the track on purpose. The reference throws sparks 80px out of its
 * bar; here that would paint over the official menu's own rows, and the menu's
 * box is not ours to decorate. Clipped to the capsule the same burst reads as
 * energy moving along the bar, which is what the control is about anyway.
 *
 * @param ctx - the field's context.
 * @param frame - the frame being painted.
 * @param knobX - the knob's centre x, in px.
 * @param centreY - the track's mid line, in px.
 * @param galaxy - the swell, 0..1.
 * @param seconds - the field's clock.
 */
function paintSparks(
  ctx: CanvasRenderingContext2D,
  frame: FieldFrame,
  knobX: number,
  centreY: number,
  galaxy: number,
  seconds: number,
): void {
  ctx.fillStyle = `rgb(${frame.accent[0]} ${frame.accent[1]} ${frame.accent[2]})`
  for (let ray = 0; ray < SPARK_RAYS; ray += 1) {
    const angle = ray * GOLDEN_ANGLE
    const seed = cellSeed(ray, 94)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (let dot = 0; dot < SPARK_DOTS; dot += 1) {
      const offset = sparkRadiusFor(dot, seconds, seed)
      const fade = Math.pow(1 - clamp01(offset / SPARK_SPAN), 1.6)
      const pulse = 0.45 + 0.55 * Math.sin(seconds * 4 + ray + dot) ** 2
      // Additive, like the cells: SPARK_GAIN is what keeps a spark a bright point
      // rather than a white one.
      ctx.globalAlpha = clamp01(galaxy * fade * pulse * SPARK_GAIN)
      const radius = SPARK_INNER + offset
      // Flattened vertically; see SPARK_FLATTEN. Without it every ray outside the
      // capsule's 14px half-height is clipped away and the burst looks like it has
      // a third of the rays it is actually drawing.
      ctx.fillRect(knobX + cos * radius, centreY + sin * radius * SPARK_FLATTEN, 2, 2)
    }
  }
}
