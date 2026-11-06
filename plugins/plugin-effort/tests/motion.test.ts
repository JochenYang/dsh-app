/**
 * The animation loop, against a fake clock.
 *
 * This plugin has no test that mounts React, and the loop is where the visible
 * half of the feature lives — but everything it does is observable without a
 * browser: it writes three custom properties on the track, it paints a canvas, and
 * it schedules frames. So the harness below is a document, a window with a manual
 * frame queue and a canvas that counts what it was asked to draw, which is enough
 * to pin the two facts a screenshot cannot:
 *
 *   - the position is written BEFORE the first frame (the caller is a layout
 *     effect, and the menu's first paint must not show the left end);
 *   - the loop parks while the document is hidden and while motion is reduced,
 *     because a menu left open in a background window must not keep painting.
 *
 * @module plugin-effort/tests/motion
 */

import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { ENERGY_VAR, GALAXY_VAR, PCT_VAR } from '../src/client/geometry.ts'
import { createTrackMotion, type TrackMotion } from '../src/client/motion.ts'
import { FILL_RAMP_LIGHT } from '../src/client/value-color.ts'

/** A 2d context that records what it was asked to paint. */
class RecordingContext {
  cleared = 0
  rects = 0
  transform: readonly number[] | null = null
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  fillStyle = ''

  clearRect(): void {
    this.cleared += 1
  }

  fillRect(): void {
    this.rects += 1
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f]
  }
}

/** One mounted control, with a clock the test advances by hand. */
interface Harness {
  readonly motion: TrackMotion
  readonly context: RecordingContext
  readonly canvas: { width: number, height: number }
  readonly props: Map<string, string>
  /** Frames waiting to run. */
  readonly queue: () => number
  /** Run every queued frame, `count` times, advancing the clock. */
  pump(count?: number): void
  /** Flip the document's visibility and fire the event the loop listens for. */
  setHidden(hidden: boolean): void
}

/** Build a control against fake DOM objects. */
function harness(options: { reduced?: boolean } = {}): Harness {
  const context = new RecordingContext()
  const props = new Map<string, string>()
  const listeners = new Map<string, Set<() => void>>()
  const frames = new Map<number, (now: number) => void>()
  let nextFrame = 1
  let now = 0
  const doc = {
    hidden: false,
    body: undefined,
    addEventListener(type: string, listener: () => void): void {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: () => void): void {
      listeners.get(type)?.delete(listener)
    },
  }
  const win = {
    devicePixelRatio: 2,
    requestAnimationFrame(callback: (now: number) => void): number {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id: number): void {
      frames.delete(id)
    },
    matchMedia: () => ({
      matches: options.reduced === true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 300, height: 28 }),
  }
  const track = {
    style: {
      setProperty(name: string, value: string): void {
        props.set(name, value)
      },
    },
  }
  const motion = createTrackMotion({
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    track: () => track as unknown as HTMLElement,
    canvas: () => canvas as unknown as HTMLCanvasElement,
    ramp: () => FILL_RAMP_LIGHT,
  })
  assert.ok(motion !== null, 'the loop refused a fake but sufficient DOM')
  return {
    motion,
    context,
    canvas,
    props,
    queue: () => frames.size,
    pump(count = 1): void {
      for (let index = 0; index < count; index += 1) {
        const due = [...frames.entries()]
        frames.clear()
        now += 16
        for (const [, callback] of due) callback(now)
      }
    },
    setHidden(hidden: boolean): void {
      doc.hidden = hidden
      for (const listener of listeners.get('visibilitychange') ?? []) listener()
    },
  }
}

/** Every harness cleaned up, so one test's loop cannot keep another's alive. */
const mounted: Harness[] = []
/** A harness registered for cleanup. */
function mount(options: { reduced?: boolean } = {}): Harness {
  const built = harness(options)
  mounted.push(built)
  return built
}

afterEach(() => {
  for (const built of mounted.splice(0)) built.motion.dispose()
})

describe('the track loop', () => {
  it('writes the position before the first frame, at the level the menu opened on', () => {
    const view = mount()
    view.motion.setTarget(0.6, false)
    // The caller is a layout effect: this is the last chance before paint, and a
    // value written only by the first tick would show the knob at the left end for
    // one frame every time the menu opens.
    assert.equal(view.props.get(PCT_VAR), '0.6000')
    assert.ok(Number(view.props.get(ENERGY_VAR)) > 0)
    assert.equal(view.props.get(GALAXY_VAR), '0.0000')
    assert.equal(view.context.cleared, 1, 'the field was not painted')
  })

  it('sizes the canvas for the device pixel ratio, once per size', () => {
    const view = mount()
    view.motion.setTarget(0.5, false)
    assert.equal(view.canvas.width, 600)
    assert.equal(view.canvas.height, 56)
    // The scale is applied once per size change: writing `canvas.width` also resets
    // the context's transform, so doing it per frame would undo the very scale it
    // was setting.
    assert.deepEqual(view.context.transform, [2, 0, 0, 2, 0, 0])
  })

  it('springs toward a new level instead of jumping to it', () => {
    const view = mount()
    view.motion.setTarget(0, false)
    view.motion.setTarget(1, false)
    // Still where it was: the target moved, the spring has not.
    assert.equal(view.props.get(PCT_VAR), '0.0000')
    view.pump(1)
    const afterOne = Number(view.props.get(PCT_VAR))
    assert.ok(afterOne > 0 && afterOne < 1, `one frame moved the whole way: ${String(afterOne)}`)
    view.pump(40)
    assert.equal(view.props.get(PCT_VAR), '1.0000')
  })

  it('paints the field at the bottom of the scale too', () => {
    const view = mount()
    view.motion.setTarget(0, false)
    const before = view.context.rects
    view.pump(60)
    // The floor is the whole point: the low levels used to be a dead track. The
    // exact squares are the twinkle's business; that something is alight over a
    // second is not.
    assert.ok(view.context.rects > before, 'the field is empty at the lowest level')
  })

  it('paints far more at the top level than at the bottom', () => {
    const view = mount()
    view.motion.setTarget(0, false)
    view.pump(30)
    const bottom = view.context.rects
    view.motion.setTarget(1, true)
    view.pump(30)
    const top = view.context.rects - bottom
    assert.ok(top > bottom, `the top level painted ${String(top)} against ${String(bottom)} at the bottom`)
  })

  it('leaves the canvas in a normal blend mode, and the alpha reset', () => {
    const view = mount()
    view.motion.setTarget(1, true)
    view.pump(2)
    // The field is drawn additively (see FIELD_GAIN). A frame that did not put the
    // context back would leave every later draw — the sparks of the next frame, a
    // second control sharing the sheet — adding instead of blending.
    assert.equal(view.context.globalCompositeOperation, 'source-over')
    assert.equal(view.context.globalAlpha, 1)
  })

  it('parks while the document is hidden, and resumes when it comes back', () => {
    const view = mount()
    view.motion.setTarget(0.5, false)
    view.pump(2)
    assert.ok(view.queue() > 0, 'the loop is not running')
    view.setHidden(true)
    assert.equal(view.queue(), 0, 'the loop kept scheduling frames in a hidden document')
    view.setHidden(false)
    assert.ok(view.queue() > 0, 'the loop did not come back')
  })

  it('stops on dispose, listener included', () => {
    const view = mount()
    view.motion.setTarget(0.5, false)
    view.pump(1)
    view.motion.dispose()
    assert.equal(view.queue(), 0, 'the loop outlived its control')
    view.setHidden(true)
    view.setHidden(false)
    assert.equal(view.queue(), 0, 'a disposed control restarted itself')
  })
})

describe('the track loop under reduced motion', () => {
  it('lands on the level without a single frame', () => {
    const view = mount({ reduced: true })
    view.motion.setTarget(1, true)
    // No spring and no loop: the position IS the level, and the field is one frozen
    // frame. The texture still arrives — it carries "how much is in play" — but
    // nothing moves.
    assert.equal(view.props.get(PCT_VAR), '1.0000')
    assert.equal(view.props.get(GALAXY_VAR), '1.0000')
    assert.equal(view.queue(), 0, 'a reduced-motion control scheduled a frame')
    assert.ok(view.context.cleared > 0, 'a reduced-motion control painted nothing')
  })

  it('follows a second target instantly as well', () => {
    const view = mount({ reduced: true })
    view.motion.setTarget(0.25, false)
    view.motion.setTarget(0.75, false)
    assert.equal(view.props.get(PCT_VAR), '0.7500')
    assert.equal(view.props.get(GALAXY_VAR), '0.0000')
  })
})
