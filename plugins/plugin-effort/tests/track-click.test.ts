/**
 * The track swallows the `click` that follows a press-and-release on it.
 *
 * The failure this pins came from a user report rather than a theory: dragging the
 * knob and letting go opened the official level picker over the capsule. The
 * track's own handling is `pointer*`, so nothing in it stopped the `click` the
 * browser also emits for a down-and-up on one element — and that click bubbles out
 * of the container into the official row, whose `onClick` drills into the list.
 *
 * A source assertion rather than a rendered one, for the same reason
 * plugin-rewind's icon is pinned this way: this plugin has no test that mounts
 * React. The bridge has a DOM harness; the component does not.
 *
 * @module plugin-effort/tests/track-click
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const slider = readFileSync(
  fileURLToPath(new URL('../src/client/slider.tsx', import.meta.url)),
  'utf8',
)

test('the track carries a click handler that stops propagation', () => {
  assert.match(slider, /onClick=\{onTrackClick\}/, 'the track has no click handler')
  assert.match(
    slider,
    /const onTrackClick = useCallback\([\s\S]*?\n\s*event\.stopPropagation\(\)/u,
    'onTrackClick does not stop propagation',
  )
})

test('the handler is documented as the row-drill guard, not decoration', () => {
  assert.match(slider, /drills into the level list/u, 'the handler lost its reason')
})

/**
 * The hover mark and the themed hint, pinned at the source.
 *
 * Both are one-line wiring facts that a green suite of geometry and CSS would not
 * notice losing: the component could fall back to a native `title` and the tests
 * would still pass, and the tick could stop deriving `data-hover` from the hover
 * state while the CSS rule stayed correct. This plugin has no test that mounts
 * React (see the module header), so the wiring is read here.
 */
test('the hint rides the kernel Tooltip, not a native title', () => {
  assert.match(slider, /import \{ Tooltip \} from '@deepseek-ai\/dsh-client-ui-primitives'/u, 'the themed tooltip is not imported')
  // Loose on purpose: the label is a dictionary lookup today and could be hoisted
  // to a const, which is a refactor and not a regression.
  assert.match(slider, /<Tooltip[\s\S]*?effort\.hint\.keys/u, 'the hint text is not on the Tooltip')
  assert.match(slider, /<Tooltip[\s\S]*?portal/u, 'the bubble is not portaled; `contain: inline-size` would misplace it')
  // `\s` rather than `\b`: `title="…"` is the natural way to put the native hint
  // back, and a `\btitle=\{` guard (this test's first draft) let it through — the
  // exact regression this case exists to catch.
  assert.doesNotMatch(slider, /\stitle=/u, 'a native title is back, which the themed tooltip replaced')
})

test('the tick derives its hover mark from the hover state', () => {
  assert.match(slider, /data-hover=\{index === hoverIndex \? '1' : '0'\}/u, 'the tick no longer reports the hovered level')
  // The state, not its identifier: renaming the pair is a refactor.
  assert.match(slider, /useState<number \| null>\(null\)/u, 'the hover state is gone')
  // One mapping for the mark and the write: the helper is the only place a pointer
  // x becomes a level for the hover path.
  assert.match(slider, /hoverIndexAt\(event\.clientX, node\.getBoundingClientRect\(\), count\)/u, 'the hover index is not derived from the shared mapping')
  assert.doesNotMatch(slider, /indexFromPct\(pct, count\)\)\n\s*setHoverIndex/u, 'the hover path re-implements the mapping inline')
})

test('the keys hint still reaches assistive technology', () => {
  // Replacing a native `title` with a hover-only bubble drops the description from
  // the accessibility tree, so the track states the shortcut itself.
  assert.match(slider, /aria-keyshortcuts="ArrowLeft ArrowRight"/u, 'the track no longer states its arrow keys')
})
