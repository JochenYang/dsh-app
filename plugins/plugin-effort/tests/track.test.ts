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
  KNOB_RADIUS,
  KNOB_SIZE,
  TRACK_HEIGHT,
  clamp01,
  fillClip,
  indexFromPct,
  offsetExpr,
  pctAt,
  pctFromIndex,
} from '../src/client/geometry.ts'
import {
  ENERGY_START,
  MOSAIC_TILES,
  TILE_MAX_SIZE,
  TILE_MIN_SIZE,
  energyFor,
  mosaicTiles,
  sweepDurationMsFor,
  sweepSpeedFor,
  tileCountFor,
  tileDelayMsFor,
  tileLayerOpacityFor,
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
