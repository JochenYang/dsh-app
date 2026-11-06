/**
 * Track geometry, the starfield's curves and the springs, pinned.
 *
 * The single-level case is the one that carries a user-visible rule rather than
 * arithmetic: a model that advertises one level must read as FULL, because that
 * level IS the maximum. `pctFromIndex(0, 1)` returning 0 — the "obvious" answer —
 * is what put a one-level model's knob at the empty end of the track.
 *
 * The field's curves are here rather than in a rendering test because this plugin
 * has no test that mounts React: what a canvas paints is not observable in a node
 * test, but the density floor that makes the low levels alive, the determinism that
 * keeps a repaint from reshuffling the sky and the bounds every spark stays inside
 * are all pure functions.
 *
 * @module plugin-effort/tests/track
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  BLOOM_WIDTH,
  GALAXY_VAR,
  KNOB_RADIUS,
  KNOB_SIZE,
  PCT_VAR,
  TRACK_HEIGHT,
  clamp01,
  createGestureMap,
  fillClip,
  headEdgeExpr,
  hoverIndexAt,
  indexFromPct,
  offsetExpr,
  pctAt,
  pctFromIndex,
} from '../src/client/geometry.ts'
import {
  DENSITY_FLOOR,
  FIELD_PAD,
  SPARK_DOTS,
  SPARK_INNER,
  SPARK_SPAN,
  cellAlphaFor,
  cellDensityFor,
  cellSeed,
  energyFor,
  fieldGrid,
  sparkRadiusFor,
} from '../src/client/starfield.ts'
import {
  MAX_STEP_SECONDS,
  POSITION_SPRING,
  advanceSpring,
  createSpring,
} from '../src/client/spring.ts'

describe('geometry constants', () => {
  it('keeps the knob the same size as the track', () => {
    assert.equal(KNOB_SIZE, TRACK_HEIGHT)
    assert.equal(KNOB_RADIUS * 2, TRACK_HEIGHT)
  })
})

describe('hoverIndexAt', () => {
  /** The x of level `index`'s tick centre, for a track at `rect`. */
  const tickCentre = (index, count, rect) => rect.left + KNOB_RADIUS + pctFromIndex(index, count) * (rect.width - KNOB_SIZE)

  it('answers the index whose tick is drawn under the pointer', () => {
    // The round trip is the property that matters: a hover that lit a different
    // tick than the one under the pointer would claim a level the click does not
    // write, which is worse than no hover at all. Positions come from
    // `pctFromIndex`, the same function `offsetExpr` places the ticks with.
    const rect = { left: 100, width: 320 }
    for (const count of [2, 3, 4, 5, 8]) {
      for (let index = 0; index < count; index += 1) {
        assert.equal(
          hoverIndexAt(tickCentre(index, count, rect), rect, count),
          index,
          `count ${count}, index ${index}`,
        )
      }
    }
  })

  it('clamps outside the travel to the end levels', () => {
    const rect = { left: 100, width: 320 }
    assert.equal(hoverIndexAt(-500, rect, 4), 0)
    assert.equal(hoverIndexAt(9999, rect, 4), 3)
  })

  it('answers null for a track with no usable width', () => {
    // A hidden or mid-layout track: any answer would be a guess, and a guessed
    // level under the pointer is a mark in the wrong place.
    for (const width of [0, KNOB_SIZE - 1, NaN]) {
      assert.equal(hoverIndexAt(150, { left: 100, width }, 4), null, `width ${width}`)
    }
  })

  it('agrees with indexFromPct on every sampled position', () => {
    // It is a composition of two tested functions, so this pins the composition
    // rather than the arithmetic: a future edit that swapped one half would change
    // the hover mark without touching either piece's own suite.
    const rect = { left: 40, width: 280 }
    for (let step = 0; step <= 40; step += 1) {
      const x = rect.left + (step / 40) * rect.width
      const pct = pctAt(x, rect)
      assert.equal(hoverIndexAt(x, rect, 5), pct === null ? null : indexFromPct(pct, 5), `x ${x}`)
    }
  })
})

describe('pctFromIndex', () => {
  it('spreads a multi-level track end to end', () => {
    assert.equal(pctFromIndex(0, 4), 0)
    assert.equal(pctFromIndex(1, 4), 1 / 3)
    assert.equal(pctFromIndex(3, 4), 1)
  })

  it('is FULL for a single level, and for none', () => {
    assert.equal(pctFromIndex(0, 1), 1)
    assert.equal(pctFromIndex(0, 0), 1)
  })

  it('clamps an out-of-range index instead of extrapolating', () => {
    assert.equal(pctFromIndex(-3, 4), 0)
    assert.equal(pctFromIndex(9, 4), 1)
  })
})

describe('indexFromPct', () => {
  it('snaps to the nearest level', () => {
    assert.equal(indexFromPct(0, 4), 0)
    assert.equal(indexFromPct(0.4, 4), 1)
    assert.equal(indexFromPct(0.6, 4), 2)
    assert.equal(indexFromPct(1, 4), 3)
  })

  it('answers 0 when there is nothing to choose between, and clamps the rest', () => {
    assert.equal(indexFromPct(0.9, 1), 0)
    assert.equal(indexFromPct(-1, 4), 0)
    assert.equal(indexFromPct(2, 4), 3)
  })

  it('round-trips every level of a track', () => {
    for (let count = 2; count <= 6; count += 1) {
      for (let index = 0; index < count; index += 1) {
        assert.equal(indexFromPct(pctFromIndex(index, count), count), index)
      }
    }
  })
})

describe('offsetExpr and fillClip', () => {
  it('insets the travel by one radius at each end', () => {
    assert.equal(offsetExpr(0), 'calc(14px + 0.0000 * (100% - 28px))')
    assert.equal(offsetExpr(0.5), 'calc(14px + 0.5000 * (100% - 28px))')
    assert.equal(offsetExpr(1), 'calc(14px + 1.0000 * (100% - 28px))')
  })

  it('clips the full-width fill to the same position', () => {
    assert.equal(fillClip(0), 'inset(0 calc(100% - 14px - 0.0000 * (100% - 28px)) 0 0)')
    assert.equal(fillClip(1), 'inset(0 calc(100% - 14px - 1.0000 * (100% - 28px)) 0 0)')
  })

  it('clamps and rounds a fraction before it enters a CSS expression', () => {
    assert.equal(offsetExpr(2), offsetExpr(1))
    assert.equal(offsetExpr(-1), offsetExpr(0))
    assert.equal(offsetExpr(0.123456789), 'calc(14px + 0.1235 * (100% - 28px))')
  })

  it('puts the bloom on the edge the eye sees, not on the clip', () => {
    // The clip runs to the knob's CENTRE, and its last radius is behind the knob;
    // this is that centre minus the radius, i.e. the knob's left rim.
    assert.equal(headEdgeExpr(0), 'calc(0.0000 * (100% - 28px))')
    assert.equal(headEdgeExpr(0.5), 'calc(0.5000 * (100% - 28px))')
    assert.equal(headEdgeExpr(1), 'calc(1.0000 * (100% - 28px))')
    assert.equal(headEdgeExpr(0.123456789), 'calc(0.1235 * (100% - 28px))')
    assert.equal(headEdgeExpr(2), headEdgeExpr(1))
    assert.equal(headEdgeExpr(-1), headEdgeExpr(0))
    // The ramp has to fit in the fill's visible span, which is one knob short of
    // the clip's.
    assert.ok(BLOOM_WIDTH < KNOB_SIZE, 'the bloom is wider than the knob it hugs')
  })
})

describe('pctAt', () => {
  const rect = { left: 100, width: 200 }

  it('maps the knob-centre travel, so both ends are reachable', () => {
    assert.equal(pctAt(100 + KNOB_RADIUS, rect), 0)
    assert.equal(pctAt(300 - KNOB_RADIUS, rect), 1)
    assert.equal(pctAt(200, rect), 0.5)
  })

  it('clamps past either end rather than overshooting', () => {
    assert.equal(pctAt(-500, rect), 0)
    assert.equal(pctAt(5000, rect), 1)
  })

  it('refuses a track with no usable width', () => {
    assert.equal(pctAt(100, { left: 0, width: TRACK_HEIGHT }), null)
    assert.equal(pctAt(100, { left: 0, width: 0 }), null)
  })
})

describe('createGestureMap', () => {
  /**
   * The two boxes one drag really went through, measured on the running app: the
   * card was 334px wide while the track said "following the provider default" and
   * 248px once a level was pinned, with its RIGHT edge pinned by the menu's own
   * placement, so the track lost 86px and moved 87px right under a pointer that
   * had not moved.
   */
  const WIDE = { left: 980.9, width: 310.5 }
  const NARROW = { left: 1067.9, width: 224 }

  it('maps every sample of one gesture through the box it started on', () => {
    let box = WIDE
    const gesture = createGestureMap(() => box)
    gesture.begin()
    const x = 1136.1
    assert.equal(gesture.pctAt(x), pctAt(x, WIDE))
    // The card re-lays itself out in the middle of the gesture.
    box = NARROW
    assert.equal(gesture.pctAt(x), pctAt(x, WIDE), 'the sample was re-mapped against the new box')
  })

  it('reads the box again for the next gesture', () => {
    let box = WIDE
    const gesture = createGestureMap(() => box)
    gesture.begin()
    box = NARROW
    gesture.end()
    gesture.begin()
    assert.equal(gesture.pctAt(1136.1), pctAt(1136.1, NARROW))
  })

  it('answers nothing outside a gesture, and nothing without a track', () => {
    const gesture = createGestureMap(() => WIDE)
    assert.equal(gesture.pctAt(1136.1), null, 'a sample was mapped with no gesture open')
    gesture.begin()
    gesture.end()
    assert.equal(gesture.pctAt(1136.1), null)
    const gone = createGestureMap(() => null)
    gone.begin()
    assert.equal(gone.pctAt(1136.1), null, 'a track with no box still answered')
  })

  it('is what stops one pointer position from asking for two levels', () => {
    // The regression, in one line: a press near the left of the wide track sits in
    // the second level's band, and the same clientX after the re-layout sits in the
    // first — so a per-sample measurement asks the host for a level the user never
    // pointed at. Held at the press-time box, the answer cannot move.
    const x = WIDE.left + KNOB_RADIUS + (WIDE.width - KNOB_RADIUS * 2) * 0.26
    const before = indexFromPct(pctAt(x, WIDE)!, 3)
    const after = indexFromPct(pctAt(x, NARROW)!, 3)
    assert.notEqual(before, after, 'the two boxes agree, so this test proves nothing')
    let box = WIDE
    const gesture = createGestureMap(() => box)
    gesture.begin()
    const held = gesture.pctAt(x)!
    box = NARROW
    assert.equal(indexFromPct(gesture.pctAt(x)!, 3), before)
    assert.equal(held, pctAt(x, WIDE))
  })
})

describe('clamp01', () => {
  it('maps NaN and negatives to 0', () => {
    assert.equal(clamp01(Number.NaN), 0)
    assert.equal(clamp01(-0.5), 0)
    assert.equal(clamp01(0.25), 0.25)
    assert.equal(clamp01(1.5), 1)
  })
})

describe('the animated position operand', () => {
  it('passes a CSS expression through instead of rounding it', () => {
    // The animation writes the position as a custom property; the same three
    // formulas place the knob, the clip and the bloom for both callers, so the one
    // operand has to accept a variable as well as a number.
    const token = `var(${PCT_VAR}, 0)`
    assert.equal(offsetExpr(token), `calc(${KNOB_RADIUS}px + ${token} * (100% - ${KNOB_SIZE}px))`)
    assert.equal(headEdgeExpr(token), `calc(${token} * (100% - ${KNOB_SIZE}px))`)
    assert.ok(fillClip(token).includes(token))
  })

  it('names the variables the stylesheet reads', () => {
    // Two names for one value is how the animation and the sheet drift apart.
    assert.equal(PCT_VAR, '--dshAppEffort-pct')
    assert.equal(GALAXY_VAR, '--dshAppEffort-galaxy')
  })
})

describe('fieldGrid', () => {
  it('holds whole cells only, and centres the leftover pixels', () => {
    const grid = fieldGrid(300, 28)
    assert.ok(grid !== null)
    const pad = FIELD_PAD * 2
    assert.equal(grid.cols, Math.floor((300 - pad) / grid.pitch))
    assert.equal(grid.rows, Math.floor((28 - pad) / grid.pitch))
    // Centred rather than left-aligned: otherwise the lattice is keyed to the
    // menu's own width and the leftmost column moves when the card resizes.
    const span = 300 - pad
    assert.ok(Math.abs(grid.originX - (FIELD_PAD + (span - grid.cols * grid.pitch) / 2)) < 1e-9)
  })

  it('holds the rows a 28px track needs to read as a texture', () => {
    // Measured against the real control: at a 6px pitch the bar held four rows and
    // read as a line of dashes. The row count is what the pitch is chosen for.
    const grid = fieldGrid(230, TRACK_HEIGHT)
    assert.ok(grid !== null)
    assert.ok(grid.rows >= 5, `only ${String(grid.rows)} rows fit`)
    assert.ok(grid.cols >= 40, `only ${String(grid.cols)} columns fit`)
  })

  it('answers null where no cell fits', () => {
    assert.equal(fieldGrid(0, 28), null)
    assert.equal(fieldGrid(300, 0), null)
    assert.equal(fieldGrid(4, 4), null)
  })
})

describe('cellSeed', () => {
  it('is deterministic, and unrelated between neighbouring cells', () => {
    // Determinism is what keeps the field assertable and a repaint from shuffling
    // the sky; the low correlation is what stops a row twinkling in lockstep.
    assert.equal(cellSeed(7, 17), cellSeed(7, 17))
    const values = Array.from({ length: 40 }, (_, index) => cellSeed(index, 17))
    assert.ok(new Set(values).size > 30, 'the hash repeats too much to be a sky')
    for (let index = 1; index < values.length; index += 1) {
      assert.notEqual(values[index], values[index - 1], `cells ${index - 1} and ${index} share a seed`)
    }
  })
})

describe('cellDensityFor', () => {
  it('never empties the track, at any position', () => {
    // The whole point of the floor: the bottom of the scale used to show nothing
    // moving at all, which read as a disabled control rather than as a low level.
    for (const col of [0, 0.25, 0.5, 1]) {
      assert.ok(cellDensityFor(col, 0, 0) >= DENSITY_FLOOR, `col ${col} at the bottom of the scale`)
    }
  })

  it('rises with the position, with the swell, and toward the right', () => {
    assert.ok(cellDensityFor(0.5, 1, 0) > cellDensityFor(0.5, 0, 0))
    assert.ok(cellDensityFor(0.5, 1, 1) > cellDensityFor(0.5, 1, 0))
    assert.ok(cellDensityFor(1, 0.5, 0) > cellDensityFor(0, 0.5, 0))
  })

  it('stays a likelihood', () => {
    for (const energy of [0, 0.5, 1, 2]) {
      for (const galaxy of [0, 0.5, 1]) {
        const density = cellDensityFor(1, energy, galaxy)
        assert.ok(density >= 0 && density <= 1, `density ${density}`)
      }
    }
  })
})

describe('cellAlphaFor', () => {
  it('keeps a lit cell visible and dims the ones past the knob', () => {
    assert.ok(cellAlphaFor(0, 0, true) > 0, 'a cell at the dimmest end is invisible')
    assert.ok(cellAlphaFor(1, 1, true) <= 1)
    // Past the knob is dimmer, never gone: the bar to the right is still the scale,
    // and a texture that stopped dead at the knob would read as a hard edge.
    assert.ok(cellAlphaFor(0.5, 0.5, false) < cellAlphaFor(0.5, 0.5, true))
    assert.ok(cellAlphaFor(0.5, 0.5, false) > 0)
  })

  it('lights the left of the top level as brightly as the rest of it', () => {
    // The reported defect: at the top level the left third of the bar looked
    // empty. It was not — 171 cells were drawn there. The column ramp was applied
    // TWICE (once in the density, once in the opacity), so those cells landed at
    // about 7% over a saturated fill and none of them read.
    const topLeft = cellAlphaFor(0.5, 0, true, 1)
    const plainLeft = cellAlphaFor(0.5, 0, true, 0)
    const topRight = cellAlphaFor(0.5, 1, true, 1)
    assert.ok(
      topLeft > plainLeft * 2,
      `the top level's left end is ${String(topLeft)} against ${String(plainLeft)} at the same column elsewhere`,
    )
    assert.ok(topLeft > topRight * 0.6, 'the top level still dies out toward the left')
    assert.ok(cellDensityFor(0, 1, 1) > 0.7, 'the top level leaves its left columns half-empty')
  })
})

describe('sparkRadiusFor', () => {
  it('stays inside the burst, for every dot and every instant', () => {
    for (const seed of [0, 0.37, 0.91]) {
      for (let dot = 0; dot < SPARK_DOTS; dot += 1) {
        for (const seconds of [0, 0.5, 3.25, 100]) {
          const radius = sparkRadiusFor(dot, seconds, seed)
          assert.ok(radius >= 0 && radius < SPARK_SPAN, `radius ${radius}`)
        }
      }
    }
  })

  it('moves: the same dot is elsewhere a moment later', () => {
    assert.notEqual(sparkRadiusFor(0, 0, 0.5), sparkRadiusFor(0, 0.4, 0.5))
    assert.ok(SPARK_INNER > 0)
  })
})

describe('energyFor', () => {
  it('starts at a third of the travel and reaches 1 at the far end', () => {
    assert.equal(energyFor(0), 0)
    assert.equal(energyFor(1 / 3), 0)
    assert.equal(energyFor(1), 1)
  })

  it('clamps energy outside 0..1', () => {
    assert.equal(energyFor(-1), 0)
    assert.equal(energyFor(2), 1)
  })
})

describe('springs', () => {
  it('arrives and stops, so the loop can stop with it', () => {
    const state = createSpring(0)
    let moving = true
    let frames = 0
    while (moving && frames < 600) {
      moving = advanceSpring(state, 1, 1 / 60, POSITION_SPRING)
      frames += 1
    }
    assert.ok(!moving, 'the spring never settled')
    assert.equal(state.value, 1)
    assert.equal(state.velocity, 0)
    // Under a second at 60fps: a level change that took longer would read as lag
    // behind the pointer, which is what the position spring exists to avoid.
    assert.ok(frames < 60, `the spring took ${String(frames)} frames`)
  })

  it('overshoots on the way, which is the whole point of a spring', () => {
    const state = createSpring(0)
    let peak = 0
    for (let frame = 0; frame < 60; frame += 1) {
      advanceSpring(state, 1, 1 / 60, POSITION_SPRING)
      peak = Math.max(peak, state.value)
    }
    assert.ok(peak > 1, 'the position arrives without any movement')
  })

  it('survives a frame far longer than the clamp', () => {
    // A backgrounded tab or a layout stall hands the loop a frame of hundreds of
    // milliseconds; integrating that in one step is what makes a spring ring.
    const state = createSpring(0)
    advanceSpring(state, 1, 5, POSITION_SPRING)
    assert.ok(state.value > 0 && state.value < 2, `diverged to ${String(state.value)}`)
    assert.ok(MAX_STEP_SECONDS > 0)
  })

  it('treats a negative or missing duration as no movement rather than as backwards time', () => {
    const state = createSpring(0.4)
    assert.equal(advanceSpring(state, 1, -1, POSITION_SPRING), true)
    assert.equal(state.value, 0.4)
  })
})

