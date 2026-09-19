/**
 * The main window's geometry across launches (src/main/window-bounds.ts).
 *
 * Three rules worth pinning, each of which has a visible failure mode:
 *
 *   1. A display that has never run the app gets a size fitted to it — a fixed
 *      default is cramped on a large screen and TALLER than a small one, and
 *      Electron does not clamp a window to the display, so a too-tall rect
 *      opens with its footer below the screen.
 *   2. A remembered size comes back as the user left it, not as the ideal: the
 *      ideal is a default, never a maximum. It is still capped by the work
 *      area, so a size chosen on a 4K monitor cannot open larger than the
 *      laptop it is restored onto.
 *   3. A remembered POSITION is only reused when a display still covers it.
 *      Restoring a position onto a monitor that was unplugged puts the window
 *      off-screen where the user cannot see or reach it.
 *
 * Everything is driven through the exported pure rules, so no real display and
 * no Electron runtime are involved.
 *
 * @module dsh-app/tests/window-size
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  IDEAL_WINDOW_HEIGHT,
  IDEAL_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  fitWindowToWorkArea,
  intersectsSomeDisplay,
  readWindowBounds,
  resolveWindowGeometry,
  toWindowBounds,
  windowStateFile,
  writeWindowBounds,
} = require('../dist/main/window-bounds.js')

const IDEAL = { width: IDEAL_WINDOW_WIDTH, height: IDEAL_WINDOW_HEIGHT }
const MIN = { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT }

/** The display this machine actually has, plus a small laptop for contrast. */
const DESKTOP = { workArea: { x: 0, y: 0, width: 1920, height: 1032 } }
const LAPTOP = { workArea: { x: 0, y: 0, width: 1366, height: 728 } }
/** A second monitor to the LEFT of the primary one: negative coordinates. */
const LEFT_MONITOR = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }

test('a display that has never run the app gets the ideal size, not the whole screen', () => {
  const size = fitWindowToWorkArea(DESKTOP.workArea)
  assert.deepEqual(size, IDEAL)
  assert.ok(size.width < DESKTOP.workArea.width && size.height < DESKTOP.workArea.height,
    'a default that fills the screen is just a maximized window')
})

test('a screen larger than the ideal still opens at the ideal', () => {
  assert.deepEqual(fitWindowToWorkArea({ width: 2560, height: 1400 }), IDEAL)
  assert.deepEqual(fitWindowToWorkArea({ width: 3840, height: 2160 }), IDEAL)
})

test('a default size NEVER exceeds the work area when the layout fits in it', () => {
  // The regression this guards: a fixed 1440x900 on a 1366x768 laptop is 172px
  // taller than the screen and would open partly offscreen.
  for (const workArea of [
    LAPTOP.workArea,
    { width: 1280, height: 680 },
    { width: 1536, height: 824 },
    { width: 1600, height: 860 },
  ]) {
    const size = fitWindowToWorkArea(workArea)
    assert.ok(
      size.width <= workArea.width && size.height <= workArea.height,
      `${workArea.width}x${workArea.height} produced ${size.width}x${size.height}, which does not fit`,
    )
  }
})

test('the minimums win only where the work area cannot hold them', () => {
  // 1024x560: the WIDTH still fits (944 <= 1024), only the height cannot go
  // below the layout's 600 — shrinking further breaks the panes rather than
  // making the app usable, so the declared minimum stands.
  const tiny = fitWindowToWorkArea({ width: 1024, height: 560 })
  assert.equal(tiny.width, 944)
  assert.equal(tiny.height, MIN_WINDOW_HEIGHT)
  assert.deepEqual(fitWindowToWorkArea({ width: 100, height: 100 }), MIN)
})

test('a REMEMBERED size comes back as the user left it, not as the ideal', () => {
  // Chosen on a big monitor: bigger than the ideal, and that is the point —
  // clamping this to 1440x900 would silently undo the user's own resize.
  const size = fitWindowToWorkArea(DESKTOP.workArea, { width: 1800, height: 1000 })
  assert.deepEqual(size, { width: 1800, height: 1000 })
  // Smaller than the ideal is equally the user's call.
  assert.deepEqual(fitWindowToWorkArea(DESKTOP.workArea, { width: 1000, height: 700 }), { width: 1000, height: 700 })
})

test('a remembered size is still capped by the display it is restored onto', () => {
  // Picked on a 4K monitor, restored on a laptop: it must fit the laptop, and
  // the margin that applies to a DEFAULT (so it reads as a window) must NOT
  // apply here — the user sized this deliberately.
  const size = fitWindowToWorkArea(LAPTOP.workArea, { width: 3000, height: 2000 })
  assert.deepEqual(size, { width: 1366, height: 728 })
})

test('a remembered position is kept while a display still covers it', () => {
  const saved = { width: 1200, height: 800, x: 300, y: 120, maximized: false }
  const geometry = resolveWindowGeometry(saved, [DESKTOP], DESKTOP.workArea)
  assert.deepEqual(geometry, { width: 1200, height: 800, x: 300, y: 120 })
})

test('a remembered position on an UNPLUGGED monitor is dropped, the size kept', () => {
  // Saved while a second monitor sat to the left at x=-1920; that monitor is
  // gone now, so this rect ends at -400 and lies entirely off the primary
  // display — the window would be invisible and unreachable.
  const saved = { width: 1000, height: 800, x: -1400, y: 100, maximized: false }
  const geometry = resolveWindowGeometry(saved, [DESKTOP], DESKTOP.workArea)
  assert.deepEqual(geometry, { width: 1000, height: 800 }, 'no x/y: the OS places it somewhere visible')
  assert.equal(geometry.x, undefined)
})

test('a position that still overlaps a display by a sliver is kept', () => {
  // Partly off-screen is not the same as unreachable: the user can grab the
  // visible edge and drag it back, which is what people expect after
  // rearranging monitors.
  const saved = { width: 1200, height: 800, x: -900, y: 100, maximized: false }
  const geometry = resolveWindowGeometry(saved, [DESKTOP], DESKTOP.workArea)
  assert.deepEqual(geometry, { width: 1200, height: 800, x: -900, y: 100 })
})

test('a position on a monitor that IS still attached is kept, including negatives', () => {
  const saved = { width: 1200, height: 800, x: -1800, y: 100, maximized: false }
  const geometry = resolveWindowGeometry(saved, [DESKTOP, LEFT_MONITOR], DESKTOP.workArea)
  assert.deepEqual(geometry, { width: 1200, height: 800, x: -1800, y: 100 })
})

test('an off-screen rectangle is recognized as such', () => {
  assert.equal(intersectsSomeDisplay({ x: 0, y: 0, width: 100, height: 100 }, [DESKTOP]), true)
  // Entirely to the left of the only display.
  assert.equal(intersectsSomeDisplay({ x: -1200, y: 0, width: 1000, height: 800 }, [DESKTOP]), false)
  // Entirely below it.
  assert.equal(intersectsSomeDisplay({ x: 0, y: 2000, width: 800, height: 600 }, [DESKTOP]), false)
  // Overlapping by a single pixel counts — the user can still grab it.
  assert.equal(intersectsSomeDisplay({ x: -1199, y: 0, width: 1200, height: 800 }, [DESKTOP]), true)
})

test('nothing remembered, or nothing usable, opens at the default', () => {
  for (const saved of [undefined, null, 'nonsense', {}, { width: 'wide', height: 800, x: 0, y: 0 }]) {
    assert.deepEqual(
      resolveWindowGeometry(saved, [DESKTOP], DESKTOP.workArea),
      IDEAL,
      `${JSON.stringify(saved)} must degrade to the default`,
    )
  }
})

test('the persisted shape is validated field by field', () => {
  assert.deepEqual(
    toWindowBounds({ width: 1200.4, height: 800.6, x: 10, y: 20, maximized: true }),
    { width: 1200, height: 801, x: 10, y: 20, maximized: true },
  )
  assert.equal(toWindowBounds({ width: 1200, height: 800, x: 10, y: 20 }).maximized, false,
    'maximized is never inferred: only an explicit true counts')

  // A damaged POSITION costs the position alone — the size still comes back,
  // because a window at the remembered size is what the user asked for.
  for (const broken of [
    { width: 1200, height: 800 }, // no position at all
    { width: 1200, height: 800, x: 10 }, // half a position
    { width: 1200, height: 800, x: Number.NaN, y: 0 },
    { width: 1200, height: 800, x: 0, y: Number.POSITIVE_INFINITY },
    { width: 1200, height: 800, x: '0', y: 0 },
  ]) {
    const parsed = toWindowBounds(broken)
    assert.equal(parsed.width, 1200, `${JSON.stringify(broken)} keeps its size`)
    assert.equal(parsed.height, 800)
    assert.equal(parsed.x, undefined, 'and drops the unusable position')
  }

  // A damaged SIZE has nothing to fall back on.
  assert.equal(toWindowBounds({ height: 800, x: 0, y: 0 }), undefined)
  assert.equal(toWindowBounds({ width: Number.NaN, height: 800, x: 0, y: 0 }), undefined)
})

test('the state file survives a round trip and tolerates a broken one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-window-bounds-'))
  const file = windowStateFile(dir)
  assert.equal(readWindowBounds(file), undefined, 'nothing written yet')

  const bounds = { width: 1200, height: 800, x: 40, y: 60, maximized: true }
  writeWindowBounds(file, bounds)
  assert.deepEqual(readWindowBounds(file), bounds)

  writeFileSync(file, '{ not json')
  assert.equal(readWindowBounds(file), undefined, 'malformed JSON is not an exception')
})
