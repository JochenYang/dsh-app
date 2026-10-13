/**
 * The stylesheet, pinned: it is the one part of this plugin whose failure is
 * SILENT.
 *
 * `cssText` is a template literal, so an interpolation that does not resolve
 * ships `height: undefinedpx` — an invalid declaration the browser drops, which
 * collapses the track to zero height and leaves a control that is present in the
 * DOM and invisible on screen. That exact failure has been produced by this kind
 * of module before, and nothing in a build or a typecheck can see it: the string
 * is valid TypeScript either way.
 *
 * `document` is stubbed here because the real one is not the point — the
 * evaluation of the template and the id-guarded injection are.
 *
 * @module plugin-effort/tests/styles
 */

import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { BLOOM_WIDTH, KNOB_SIZE, TRACK_HEIGHT } from '../src/client/geometry.ts'
import { DRIFT_AMPLITUDE } from '../src/client/mosaic.ts'
import { adoptStyles } from '../src/client/styles.ts'
import { FILL_RAMP_DARK, FILL_RAMP_LIGHT, fillGradient } from '../src/client/value-color.ts'

/** Text of every stylesheet the module injected during one test. */
const injected: string[] = []
/** Elements the stub's `head.append` received, keyed by id, for the id guard. */
const appended = new Map<string, unknown>()

/** A document with just the surface `adoptStyles` touches. */
function stubDocument(): void {
  Object.assign(globalThis, {
    document: {
      getElementById: (id: string) => appended.get(id) ?? null,
      createElement: () => {
        const element: Record<string, unknown> = { id: '' }
        Object.defineProperty(element, 'textContent', {
          set(value: string) { injected.push(value) },
        })
        return element
      },
      head: { append: (element: { id: string }) => { appended.set(element.id, element) } },
    },
  })
}

afterEach(() => {
  injected.length = 0
  appended.clear()
  Object.assign(globalThis, { document: undefined })
})

describe('adoptStyles', () => {
  it('evaluates every interpolation into a real length', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    assert.ok(css.length > 0, 'nothing was injected')
    for (const token of ['${', 'undefined', 'NaN']) {
      assert.ok(!css.includes(token), `the stylesheet still carries ${token}`)
    }
    assert.ok(css.includes(`height: ${TRACK_HEIGHT}px`), 'the track height is not the geometry constant')
    assert.ok(css.includes(`width: ${KNOB_SIZE}px`), 'the knob width is not the geometry constant')
    assert.ok(css.includes(`margin: ${-KNOB_SIZE / 2}px 0 0 ${-KNOB_SIZE / 2}px`), 'the knob is not centred on its position')
  })

  it('carries both theme ramps and the reduced-motion opt-out', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // The fill is the ramp value-color.ts owns — the same stops the level name and
    // the capsule ring are read from. Asserted as the generated expression rather
    // than as a few hex strings, so a second copy of the ramp in this file (which
    // is how the three surfaces drift apart) fails here.
    assert.ok(css.includes(fillGradient(FILL_RAMP_LIGHT)), 'the light ramp is not the shared one')
    assert.ok(css.includes(fillGradient(FILL_RAMP_DARK)), 'the dark ramp is not the shared one')
    assert.ok(css.includes('body[data-ds-dark-theme]'), 'the dark ramp is not bound to the kernel theme hook')
    assert.ok(css.includes('prefers-reduced-motion'), 'the mosaic has no reduced-motion opt-out')
  })

  it('gives the container a line of its own inside the row', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // The row is `flex-wrap: wrap` (bridge.ts) and the container is a child of it
    // now; a full width is what keeps the track off the label's line.
    assert.ok(/\n\.dshAppEffort \{[^}]*width: 100%/u.test(css), 'the container does not claim its own line')
    // The container sits INSIDE the row, so the row's own padding-inline reaches
    // the track by itself — a copy of it here would indent the track twice.
    assert.ok(!css.includes('padding-inline'), 'the container still copies the row\'s inline padding')
  })

  it('takes the container out of hit-testing and gives the track its own area back', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // The click guard is a CSS fact, not a listener: the container is the React
    // portal's root, so React's delegated listeners are on that same node and a
    // `stopPropagation` of ours there would only take effect at the NEXT node.
    assert.ok(
      /\n\.dshAppEffort \{[^}]*pointer-events: none/u.test(css),
      'the container still receives pointer events',
    )
    assert.ok(
      /\n\.dshAppEffort-track \{[^}]*pointer-events: auto/u.test(css),
      'the track cannot take the pointer back from its container',
    )
  })

  it('keeps an unlit tile mounted, invisible and paused', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // Unmounting an unlit tile is what made squares appear and vanish in the
    // middle of the track; the fade needs the element to stay.
    assert.ok(
      /\.dshAppEffort-tile\[data-on="0"\] \{[^}]*animation-play-state: paused/u.test(css),
      'an unlit tile keeps sweeping invisibly',
    )
    assert.ok(
      /\n\.dshAppEffort-square \{[^}]*transition: opacity/u.test(css),
      'the square cannot fade between its tone and nothing',
    )
  })

  it('gates the drift on the top of the energy range, centring included', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    assert.ok(
      /\.dshAppEffort-track\[data-drift="1"\] \.dshAppEffort-tile\[data-on="1"\] \.dshAppEffort-square \{[^}]*animation-name: dshAppEffort-drift/u.test(css),
      'the drift is not gated on the track and on lit tiles',
    )
    // A keyframe replaces the element's transform outright: a drift that wrote
    // only the vertical offset would slide every square half a tile up and left.
    assert.ok(
      css.includes('translate(-50%, -50%) translateY('),
      'the drift keyframe dropped the centring transform',
    )
    assert.ok(css.includes(`translateY(${DRIFT_AMPLITUDE}px)`), 'the drift amplitude is not the constant')
    assert.ok(css.includes(`translateY(${-DRIFT_AMPLITUDE}px)`), 'the drift has no other end')
  })

  it('anchors the bloom on the knob\'s rim, inside the fill', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    assert.ok(/\n\.dshAppEffort-bloom \{/u.test(css), 'the bloom layer is missing')
    assert.ok(
      css.includes(`var(--dshAppEffort-head) - ${BLOOM_WIDTH}px`),
      'the bloom ramp is not the width constant',
    )
    assert.ok(css.includes('--dshAppEffort-bloom: rgb(255 255 255 / 26%)'), 'the light bloom is missing')
    assert.ok(css.includes('--dshAppEffort-bloom: rgb(255 255 255 / 34%)'), 'the dark bloom is missing')
  })

  it('injects once per document', () => {
    stubDocument()
    adoptStyles()
    adoptStyles()
    assert.equal(injected.length, 1)
  })
})
