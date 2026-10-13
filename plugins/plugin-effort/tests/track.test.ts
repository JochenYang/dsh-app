/**
 * Track geometry and the mosaic curves, pinned.
 *
 * The single-level case is the one that carries a user-visible rule rather than
 * arithmetic: a model that advertises one level must read as FULL, because that
 * level IS the maximum. `pctFromIndex(0, 1)` returning 0 — the "obvious" answer —
 * is what put a one-level model's knob at the empty end of the track.
 *
 * @module plugin-effort/tests/track
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  BLOOM_WIDTH,
  KNOB_RADIUS,
  KNOB_SIZE,
  TRACK_HEIGHT,
  clamp01,
  createGestureMap,
  fillClip,
  headEdgeExpr,
  indexFromPct,
  offsetExpr,
  pctAt,
  pctFromIndex,
} from '../src/client/geometry.ts'
import {
  DRIFT_MS,
  ENERGY_START,
  MOSAIC_TILES,
  TILE_MAX_SIZE,
  TILE_MIN_SIZE,
  driftDelayMsFor,
  energyFor,
  mosaicTiles,
  sweepDurationMsFor,
  sweepPctFor,
  sweepSpeedFor,
  tileCountFor,
  tileDelayMsFor,
  tileLayerOpacityFor,
  tileStateFor,
  type MosaicTile,
} from '../src/client/mosaic.ts'

describe('geometry constants', () => {
  it('keeps the knob the same size as the track', () => {
    assert.equal(KNOB_SIZE, TRACK_HEIGHT)
    assert.equal(KNOB_RADIUS * 2, TRACK_HEIGHT)
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

describe('mosaicTiles', () => {
  it('is deterministic: the same position always paints the same mosaic', () => {
    assert.deepEqual(mosaicTiles(), mosaicTiles())
  })

  it('gives every tile a distinct phase, so the sweep reads as a stream', () => {
    const phases = mosaicTiles().map(tile => tile.phase)
    assert.equal(new Set(phases).size, MOSAIC_TILES)
  })

  it('keeps size, height and tone inside the track', () => {
    for (const tile of mosaicTiles()) {
      assert.ok(tile.size >= TILE_MIN_SIZE && tile.size <= TILE_MAX_SIZE, `size ${tile.size}`)
      assert.ok(tile.top >= 0.12 && tile.top <= 0.78, `top ${tile.top}`)
      assert.ok(tile.tone >= 0.45 && tile.tone <= 1, `tone ${tile.tone}`)
      // A tile is centred on its line, so its real extent is half a size either
      // side; asserting the whole size keeps a margin against the track's edge.
      assert.ok(tile.top * TRACK_HEIGHT + tile.size <= TRACK_HEIGHT, `overflow at ${tile.top}`)
    }
  })
})

describe('mosaic curves', () => {
  it('paints nothing below the energy floor and everything at the far end', () => {
    assert.equal(tileCountFor(0), 0)
    assert.equal(tileCountFor(ENERGY_START), 0)
    assert.equal(tileLayerOpacityFor(ENERGY_START), 0)
    assert.equal(tileCountFor(1), MOSAIC_TILES)
    assert.equal(tileLayerOpacityFor(1), 1)
  })

  it('rises monotonically with the position', () => {
    let lastCount = -1
    let lastOpacity = -1
    for (let pct = 0; pct <= 1.0001; pct += 0.05) {
      const count = tileCountFor(pct)
      const opacity = tileLayerOpacityFor(pct)
      assert.ok(count >= lastCount, `count dropped at ${pct}`)
      assert.ok(opacity >= lastOpacity, `opacity dropped at ${pct}`)
      lastCount = count
      lastOpacity = opacity
    }
  })

  it('sweeps faster the further the track is pushed, within its bounds', () => {
    assert.ok(sweepSpeedFor(1) > sweepSpeedFor(0.2))
    assert.ok(sweepSpeedFor(0) >= 0.35)
    assert.ok(sweepSpeedFor(1) <= 2)
    assert.ok(sweepDurationMsFor(1, 0.5) < sweepDurationMsFor(0.2, 0.5))
  })

  it('starts every tile partway through its own sweep', () => {
    const duration = sweepDurationMsFor(0.8, 0.5)
    for (const tile of mosaicTiles()) {
      const delay = tileDelayMsFor(tile, duration)
      assert.ok(delay <= 0, `delay ${delay}`)
      assert.ok(delay > -duration, `delay ${delay} past one sweep`)
    }
  })

  it('clamps energy outside 0..1', () => {
    assert.equal(energyFor(-1), 0)
    assert.equal(energyFor(2), 1)
  })
})

describe('sweepPctFor', () => {
  it('reads the displayed position while the two are level', () => {
    assert.equal(sweepPctFor(0.8, false, 0.2), 0.8)
    assert.equal(sweepPctFor(0, false, 0.9), 0)
  })

  it('holds the settled position while a gesture is in flight', () => {
    // The whole point of the freeze: `animation-duration` re-times a RUNNING
    // animation rather than restarting it, so a duration that followed every
    // crossing remapped each square's progress and moved it. A drag crosses one
    // node per level, which was one jump per node.
    assert.equal(sweepPctFor(0.8, true, 0.2), 0.2)
    assert.equal(sweepPctFor(0, true, 0.2), 0.2)
    assert.equal(sweepPctFor(1, true, 0.2), 0.2)
    assert.equal(sweepPctFor(0.9, true, 0.9), 0.9)
  })

  it('clamps either position into the travel', () => {
    assert.equal(sweepPctFor(2, false, 0), 1)
    assert.equal(sweepPctFor(-1, false, 0), 0)
    assert.equal(sweepPctFor(0.5, true, 4), 1)
    assert.equal(sweepPctFor(0.5, true, Number.NaN), 0)
  })
})

describe('tileStateFor', () => {
  it('lights tiles in order, and an unlit one carries no opacity at all', () => {
    const tiles = mosaicTiles()
    for (const pct of [0, ENERGY_START, 0.5, 0.75, 1]) {
      const count = tileCountFor(pct)
      tiles.forEach((tile, index) => {
        const state = tileStateFor(tile, index, pct)
        assert.equal(state.on, index < count, `tile ${index} at ${pct}`)
        // Not "a small opacity": 0, so the fade comes to rest on exactly the tone
        // it returns to.
        assert.equal(state.opacity, index < count ? tile.tone : 0, `opacity of tile ${index} at ${pct}`)
      })
    }
  })

  it('keeps a tile that is off in the table rather than dropping it', () => {
    // The count is not a mount list: the component renders all MOSAIC_TILES and
    // this decides which of them are lit. Unmounting instead made squares appear
    // and vanish mid-track, because every tile starts partway through its sweep.
    const tiles = mosaicTiles()
    assert.equal(tiles.length, MOSAIC_TILES)
    assert.equal(tileStateFor(tiles[0] as MosaicTile, 0, 0).opacity, 0)
    assert.equal(tileStateFor(tiles[MOSAIC_TILES - 1] as MosaicTile, MOSAIC_TILES - 1, 0).on, false)
  })

  it('lights nothing below the energy floor and everything at the far end', () => {
    const tiles = mosaicTiles()
    assert.ok(tiles.every((tile, index) => !tileStateFor(tile, index, ENERGY_START).on))
    assert.ok(tiles.every((tile, index) => tileStateFor(tile, index, 1).on))
  })
})

describe('driftDelayMsFor', () => {
  it('spreads the drift across the tiles instead of bobbing in lockstep', () => {
    const delays = mosaicTiles().map(tile => driftDelayMsFor(tile))
    assert.equal(new Set(delays.map(delay => delay.toFixed(3))).size, MOSAIC_TILES)
    for (const delay of delays) {
      assert.ok(delay <= 0, `delay ${delay}`)
      assert.ok(delay > -DRIFT_MS, `delay ${delay} past one period`)
    }
  })
})
