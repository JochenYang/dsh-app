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
import { KNOB_SIZE, TRACK_HEIGHT } from '../src/client/geometry.ts'
import { adoptStyles } from '../src/client/styles.ts'

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
    // Light ramp, dark ramp, and the dark-theme hook the kernel actually toggles.
    assert.ok(css.includes('#5686FE') && css.includes('#4B3FD6'), 'the light ramp is incomplete')
    assert.ok(css.includes('#7AAAFF') && css.includes('#B9A6FF'), 'the dark ramp is incomplete')
    assert.ok(css.includes('body[data-ds-dark-theme]'), 'the dark ramp is not bound to the kernel theme hook')
    assert.ok(css.includes('prefers-reduced-motion'), 'the mosaic has no reduced-motion opt-out')
  })

  it('injects once per document', () => {
    stubDocument()
    adoptStyles()
    adoptStyles()
    assert.equal(injected.length, 1)
  })
})
