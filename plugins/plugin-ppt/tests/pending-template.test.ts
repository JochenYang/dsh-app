/**
 * Pending-pick slot: the hero pick parks here and the session-bound capsule
 * consumes it exactly once. A parked pick always means "mode on"; the hero
 * turn-off clears the slot because the session default is already off. The
 * store is module-level state shared by both capsule occurrences (node --test
 * runs each file in its own process, so these cases start from the empty slot).
 *
 * @module @dsh-app/plugin-ppt/tests/pending-template
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingTemplate } from '../src/client/pending-template.ts'

test('pending template: an untouched slot is empty', () => {
  pendingTemplate.consume()
  assert.equal(pendingTemplate.get(), undefined)
  assert.equal(pendingTemplate.consume(), undefined)
})

test('pending template: a parked 常规主题 pick is readable and subscribers are notified', () => {
  pendingTemplate.consume()
  let notifications = 0
  const unsubscribe = pendingTemplate.subscribe(() => { notifications += 1 })

  pendingTemplate.set({ template: null })
  assert.deepEqual(pendingTemplate.get(), { template: null })
  assert.equal(notifications, 1)

  unsubscribe()
  pendingTemplate.set({ template: 'dsh-broadside' })
  assert.equal(notifications, 1, 'an unsubscribed listener is not called again')
  pendingTemplate.consume()
})

test('pending template: consume returns the pick once and empties the slot', () => {
  pendingTemplate.consume()
  let notifications = 0
  const unsubscribe = pendingTemplate.subscribe(() => { notifications += 1 })

  pendingTemplate.set({ template: 'dsh-editorial-forest' })
  assert.deepEqual(pendingTemplate.consume(), { template: 'dsh-editorial-forest' })
  assert.equal(pendingTemplate.get(), undefined)
  assert.equal(pendingTemplate.consume(), undefined)
  assert.equal(notifications, 2, 'set and consume each notify once')

  unsubscribe()
})

test('pending template: clear empties a parked pick without notifying an empty slot', () => {
  pendingTemplate.consume()
  let notifications = 0
  const unsubscribe = pendingTemplate.subscribe(() => { notifications += 1 })

  pendingTemplate.clear()
  assert.equal(notifications, 0, 'an already-empty slot is a no-op')
  pendingTemplate.set({ template: null })
  pendingTemplate.clear()
  assert.equal(pendingTemplate.get(), undefined)
  assert.equal(notifications, 2)

  unsubscribe()
})
