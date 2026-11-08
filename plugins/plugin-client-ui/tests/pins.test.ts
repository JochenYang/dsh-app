/**
 * The pin list's two rules, pinned.
 *
 * A pin is a view preference, so the only failures worth locking are the quiet
 * ones: an id that never gets pruned (it holds a slot with no row behind it) and
 * a cap that applies on disk but not in memory (the UI shows a pin that vanishes
 * on reload).
 *
 * @module plugin-client-ui/tests/pins
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { togglePin } from '../src/client/models-advanced/pins.ts'

describe('togglePin', () => {
  it('pins in order and unpins by id', () => {
    assert.deepEqual(togglePin([], 'a'), ['a'])
    assert.deepEqual(togglePin(['a'], 'b'), ['a', 'b'])
    assert.deepEqual(togglePin(['a', 'b'], 'a'), ['b'])
  })

  it('never grows past the persisted cap', () => {
    const full = Array.from({ length: 32 }, (_value, index) => `r${String(index)}`)
    const next = togglePin(full, 'newest')
    assert.equal(next.length, 32)
    assert.equal(next[next.length - 1], 'newest')
    assert.equal(next.includes('r0'), false)
  })
})
