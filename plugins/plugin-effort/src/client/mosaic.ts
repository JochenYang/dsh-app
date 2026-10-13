/**
 * The mosaic sweep: square tiles crossing the filled part of the track.
 *
 * The effect answers one question the fill colour alone answers slowly — "how
 * much of this scale is actually in play" — so its intensity is driven by the
 * POSITION, not by the level's name: nothing below a third of the track, a
 * growing count of tiles above it, and the whole set at the far end.
 *
 * Every tile is derived from its own index, never from `Math.random()`: the
 * same position always paints the same mosaic, which is what makes the layer
 * assertable in a unit test and keeps a re-render from reshuffling the squares
 * under the pointer.
 *
 * Two of the rules here are about TIME rather than about a position, and both
 * exist because the obvious implementation was visibly wrong:
 *
 *   - **A tile is faded, never unmounted** — {@link tileStateFor}.
 *   - **The sweep's timing is frozen while a gesture is in flight** —
 *     {@link sweepPctFor}.
 *
 * Geometry lives in {@link ./geometry}; this module owns the tile table, the
 * curves that read a position (count, opacity, sweep speed) and the two that read
 * a gesture (the frozen sweep position, the high-energy drift).
 *
 * @module @dsh-app/plugin-effort/client/mosaic
 */

/** Fraction of the track below which no tile is painted at all. */
export const ENERGY_START = 1 / 3

/** Fraction at which the mosaic reaches its full intensity. */
export const ENERGY_END = 2 / 3

/** How many tiles the layer can show at full intensity. */
export const MOSAIC_TILES = 14

/** Smallest and largest tile edge, in px. */
export const TILE_MIN_SIZE = 3
export const TILE_MAX_SIZE = 6

/** Sweep duration at the fastest end, in ms. Longer positions sweep slower. */
export const SWEEP_BASE_MS = 2600

/** Sweep-speed multiplier bounds; the curve is `3 * pct - 1` clamped into them. */
export const SPEED_MIN = 0.35
export const SPEED_MAX = 2

/** Per-tile duration jitter, as a fraction of the sweep duration. */
export const TILE_SPREAD = 0.16

/** The high-energy drift's amplitude, in px, either side of the tile's line. */
export const DRIFT_AMPLITUDE = 1.5

/** The drift's period, in ms. Slow on purpose: it reads as breathing, not as motion. */
export const DRIFT_MS = 2400

/** Low-discrepancy constant: any prefix of `(i + 1) * phi % 1` spreads evenly. */
const GOLDEN_RATIO = 0.6180339887498949

/** One square in the sweep. */
export interface MosaicTile {
  /** Where in the sweep this tile starts, 0..1. Also its animation's negative delay. */
  readonly phase: number
  /** Vertical position inside the track, 0..1 of the track's height. */
  readonly top: number
  /** Tile edge in px. */
  readonly size: number
  /** Brightness multiplier, 0..1. */
  readonly tone: number
}

/**
 * Clamp to 0..1, mapping NaN and negatives to 0.
 * @param value - any number.
 * @returns the value inside 0..1.
 */
function clamp01(value: number): number {
  if (!(value > 0)) return 0
  return value > 1 ? 1 : value
}

/**
 * A deterministic 0..1 value for an index and a salt.
 *
 * Two different salts over the same index give two unrelated values, which is
 * how phase, height, size and tone stay independent of each other instead of
 * marching together down the track.
 *
 * @param index - tile index.
 * @param salt - an odd-ish constant; a different one per property.
 * @returns a stable 0..1 value.
 */
function hash01(index: number, salt: number): number {
  const value = ((index + 1) * salt * 2654435761) >>> 0
  return ((value >>> 8) % 1000) / 1000
}

/**
 * The tile table, built once.
 * @returns one entry per tile index, in sweep order.
 */
export function mosaicTiles(): readonly MosaicTile[] {
  const out: MosaicTile[] = []
  for (let index = 0; index < MOSAIC_TILES; index += 1) {
    out.push({
      phase: ((index + 1) * GOLDEN_RATIO) % 1,
      top: 0.12 + hash01(index, 29) * 0.66,
      size: TILE_MIN_SIZE + Math.round(hash01(index, 53) * (TILE_MAX_SIZE - TILE_MIN_SIZE)),
      tone: 0.45 + hash01(index, 71) * 0.55,
    })
  }
  return out
}

/**
 * How far into the "more compute" part of the scale a position is.
 * @param pct - fraction of the travel, 0..1.
 * @returns 0 at and below {@link ENERGY_START}, 1 at the far end.
 */
export function energyFor(pct: number): number {
  return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START))
}

/**
 * How many tiles are visible at a position.
 * @param pct - fraction of the travel, 0..1.
 * @returns 0 below {@link ENERGY_START}, up to {@link MOSAIC_TILES} at the far end.
 */
export function tileCountFor(pct: number): number {
  return Math.round(energyFor(pct) * MOSAIC_TILES)
}

/** One tile's presentation at a position. */
export interface TileState {
  /** Whether this tile is part of the mosaic here. */
  readonly on: boolean
  /** The square's opacity: its own tone while on, 0 while not. */
  readonly opacity: number
}

/**
 * One tile's presentation at a position.
 *
 * The count is NOT a mount list. Every tile starts partway through its own sweep
 * (see {@link tileDelayMsFor}), so a tile added at a higher position pops into
 * existence somewhere in the MIDDLE of the track, and one removed blinks out —
 * which is what the mosaic used to do. Instead every tile stays mounted and the
 * square fades between its own tone and 0, so the tile keeps its phase and comes
 * back exactly where it left.
 *
 * @param tile - the tile.
 * @param index - its position in the table.
 * @param pct - fraction of the travel, 0..1.
 * @returns whether it is on, and the opacity its square carries.
 */
export function tileStateFor(tile: MosaicTile, index: number, pct: number): TileState {
  const on = index < tileCountFor(pct)
  return { on, opacity: on ? tile.tone : 0 }
}

/**
 * The drift delay for one tile, in ms.
 *
 * Its own phase, so the column breathes out of step: fourteen squares rising and
 * falling together reads as the whole track twitching rather than as the mosaic
 * being alive.
 *
 * @param tile - the tile.
 * @returns the delay (zero or negative).
 */
export function driftDelayMsFor(tile: MosaicTile): number {
  return -(tile.phase % 1) * DRIFT_MS
}

/**
 * The position the sweep's TIMING is read from.
 *
 * `animation-duration` does not restart a running animation, it re-times it: every
 * tile's progress is remapped onto the new duration, so the squares jump. A drag
 * crosses one level per node, and the position changes on every one of those
 * crossings, so reading the timing straight off the displayed position meant a jump
 * per node. The timing therefore follows the position only while the display is
 * level with the session: while a gesture (or the write it started) is in flight it
 * stays where the last settled position left it, and changes once, when the level
 * is actually adopted.
 *
 * @param shownPct - the position being displayed.
 * @param ahead - whether the display is ahead of the session.
 * @param settledPct - the last position the session adopted.
 * @returns the position to read the sweep's timing from.
 */
export function sweepPctFor(shownPct: number, ahead: boolean, settledPct: number): number {
  return clamp01(ahead ? settledPct : shownPct)
}

/**
 * The layer's opacity at a position.
 * @param pct - fraction of the travel, 0..1.
 * @returns 0 where the count is 0, 1 at the far end.
 */
export function tileLayerOpacityFor(pct: number): number {
  return energyFor(pct)
}

/**
 * Sweep speed at a position: faster the further the track is pushed.
 * @param pct - fraction of the travel, 0..1.
 * @returns the multiplier, clamped to {@link SPEED_MIN}..{@link SPEED_MAX}.
 */
export function sweepSpeedFor(pct: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, 3 * clamp01(pct) - 1))
}

/**
 * One tile's sweep duration.
 * @param pct - fraction of the travel, 0..1.
 * @param spread - this tile's duration jitter, as a fraction.
 * @returns the duration in ms.
 */
export function sweepDurationMsFor(pct: number, spread: number): number {
  const speed = sweepSpeedFor(pct)
  const jitter = 1 - TILE_SPREAD + 2 * TILE_SPREAD * spread
  return (SWEEP_BASE_MS * SPEED_MAX) / speed * jitter
}

/**
 * One tile's animation delay.
 *
 * Negative on purpose: a positive delay would hold every tile off-screen for its
 * own fraction of a sweep, so opening the menu would show a queue assembling
 * itself. A negative delay starts each tile already partway through, which is
 * what makes the layer read as an even stream from the first frame.
 *
 * @param tile - the tile.
 * @param duration - its sweep duration in ms.
 * @returns the delay in ms (zero or negative).
 */
export function tileDelayMsFor(tile: MosaicTile, duration: number): number {
  return -(tile.phase % 1) * duration
}
