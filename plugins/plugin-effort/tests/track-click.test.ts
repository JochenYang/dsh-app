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
