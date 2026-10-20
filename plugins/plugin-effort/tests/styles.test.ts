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
import { BLOOM_WIDTH, KNOB_SIZE, NOTE_LINE_HEIGHT, NOTE_MARGIN_TOP, TICK_HOVER_SCALE, TICK_SIZE, TRACK_HEIGHT } from '../src/client/geometry.ts'
import { DRIFT_AMPLITUDE } from '../src/client/mosaic.ts'
import { EFFORT_TEXT_ATTRIBUTE, EFFORT_TEXT_WEIGHT, adoptStyles } from '../src/client/styles.ts'
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

  it('makes the composer capsule\'s level mark a heavier weight, and nothing else', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // Spelled out rather than read from the constants: the selector IS the contract
    // with the bridge's write, and an assertion against a shared constant would pass
    // on a rename that left the two halves disagreeing.
    assert.ok(
      /\n\[data-dshAppEffort\] \{[^}]*font-weight: 600/u.test(css),
      'the mark does not buy a heavier weight',
    )
    // One declaration and no more: the element is the kernel's own span, and the
    // colour is a per-level value the bridge writes. A rule that set the colour, a
    // size or a width here would be a second source for one of them.
    const rule = /\n\[data-dshAppEffort\] \{([^}]*)\}/u.exec(css)
    assert.ok(rule !== null, 'the mark rule is missing')
    const declarations = (rule[1] ?? '').split(';').map(part => part.trim()).filter(part => part.length > 0)
    assert.deepEqual(declarations, ['font-weight: 600'], `the mark rule declares more than the weight: ${declarations.join('; ')}`)
    assert.equal(EFFORT_TEXT_ATTRIBUTE, 'data-dshAppEffort', 'the mark the bridge writes is not the one this sheet styles')
    assert.equal(EFFORT_TEXT_WEIGHT, '600', 'the weight is not the one this sheet declares')
  })

  it('grows the tick under the pointer by a transform, never by its size', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // Three properties matter here and none is visible to a typecheck:
    //   - the mark grows by `scale`, so no layout pass runs per pointer sample and
    //     the growth stays centred on the tick (a width change would keep the
    //     box's top-left corner and shift the circle by half the growth);
    //   - the transition is on `transform` ALONE, so a level change (a background
    //     swap on the ticks at or below the value) stays instant while the hover
    //     size animates — a shared `transition: all` would fade every level
    //     change and read as lag on a drag;
    //   - the mark is its own state (`data-hover`), not a reuse of `data-on`,
    //     which already means "at or below the current level".
    // String checks rather than a regex: the selector's braces and dots need two
    // levels of escaping inside a template, and getting that wrong produces a
    // SyntaxError at run time instead of a failing assertion.
    const tickRule = css.slice(css.indexOf('.dshAppEffort-tick {'), css.indexOf('.dshAppEffort-tick {') + 400)
    assert.ok(
      tickRule.includes(`width: ${TICK_SIZE}px`),
      'the tick size is not the geometry constant',
    )
    assert.ok(
      css.includes(`transform: scale(${TICK_HOVER_SCALE})`),
      'the hover mark does not use the geometry scale',
    )
    // The whole declaration, not a prefix: `transition: transform 120ms,
    // background 120ms` passes a bare `transition: transform \d+ms` match, and that
    // rule would make every level change fade. The easing function itself contains
    // commas, so they are stripped before asking whether a SECOND property is
    // named — the only thing a split can be evidence of here.
    const declared = /transition: ([^;]+);/u.exec(
      /\.dshAppEffort-tick \{[^}]*\}/u.exec(css)?.[0] ?? '',
    )?.[1] ?? ''
    const withoutEasing = declared.replace(/[a-z-]*cubic-bezier\([^)]*\)/gu, '').replace(/\([^)]*\)/gu, '')
    assert.ok(declared.startsWith('transform '), `the tick transition does not lead with transform: ${declared}`)
    assert.equal(withoutEasing.split(',').length, 1, `the tick transitions more than one property: ${declared}`)
    assert.ok(!/all/u.test(declared), `the tick uses transition: all: ${declared}`)
    assert.ok(
      /\.dshAppEffort-tick\[data-hover="1"\]/.test(css),
      'no rule keys on the hover mark',
    )
  })

  it('stops the tick transition under reduced motion', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    const tail = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    assert.ok(tail.includes('.dshAppEffort-tick'), 'the tick keeps animating for a reduced-motion reader')
  })

  it('reserves the note line, so the shape cannot move the card', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // The note's sentence comes and goes with the state while the LINE stays: the
    // official menu is placed from its own height, so a line that un-mounted with
    // the sentence would move the whole card by its own 20px on the first drag.
    // An empty <p> collapses, so the floor is the load-bearing half — and it is the
    // half a reading of the built bundle cannot confirm, because the sheet ships as
    // a template literal. Measured instead, on the running app, in the state where
    // the sentence is gone: the note's computed `min-height` is 16px, its
    // `display` is block, its border box is 16px tall and it reports one client
    // rect, so the container stays 48px and the row stays 96px in both shapes.
    assert.ok(
      /\n\.dshAppEffort-note \{[^}]*min-height: \d+px/u.test(css),
      'the note line has no height floor, so an empty one collapses',
    )
    assert.ok(
      css.includes(`min-height: ${NOTE_LINE_HEIGHT}px`),
      'the note floor is not the geometry constant',
    )
    assert.ok(css.includes(`line-height: ${NOTE_LINE_HEIGHT}px`), 'the note line height is not the constant')
    assert.ok(css.includes(`margin: ${NOTE_MARGIN_TOP}px 0 0`), 'the note margin is not the constant')
  })

  it('keeps the note out of the card\'s own width', () => {
    stubDocument()
    adoptStyles()
    const css = injected.join('')
    // The menu is `width: max-content`: a note with text has a max-content width,
    // and that width became the CARD's — 334px with the sentence, 248px without,
    // measured on the running app. Inline-size containment is what stops a
    // sentence from resizing the control under the pointer.
    assert.ok(
      /\n\.dshAppEffort \{[^}]*contain: inline-size/u.test(css),
      'the container still contributes its contents\' inline size',
    )
  })

  it('injects once per document', () => {
    stubDocument()
    adoptStyles()
    adoptStyles()
    assert.equal(injected.length, 1)
  })
})
