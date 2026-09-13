/**
 * The Word capsule's presentation contract, kept DOM- and React-free: the
 * two-state label, the active flag and where a body click sends the toggle
 * (persist against a session, park without one). These are the properties the
 * view and the api layer both depend on.
 *
 * @module @dsh-app/plugin-doc/tests/capsule-state
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capsuleState, WORD_FORMAT, WORD_LABEL } from '../src/client/capsule-state.ts'
import { OFFICE_FORMAT_ORDER } from '../src/client/office-bar.ts'

test('capsule: the format id and label match the shared bar convention', () => {
  assert.equal(WORD_FORMAT, 'word')
  assert.equal(WORD_LABEL, 'Word')
  assert.ok(OFFICE_FORMAT_ORDER.includes(WORD_FORMAT))
  assert.deepEqual(OFFICE_FORMAT_ORDER, ['ppt', 'word', 'excel', 'pdf'])
})

test('capsule: an off capsule asks to turn the mode on', () => {
  const state = capsuleState({ sessionBound: true, enabled: false })
  assert.equal(state.enabled, false)
  assert.equal(state.label, 'Word')
  assert.deepEqual(state.toggle, { kind: 'persist', enabled: true })
})

test('capsule: an on capsule asks to turn the mode off', () => {
  const state = capsuleState({ sessionBound: true, enabled: true })
  assert.equal(state.enabled, true)
  assert.equal(state.label, 'Word')
  assert.deepEqual(state.toggle, { kind: 'persist', enabled: false })
})

test('capsule: without a session the same toggle is parked instead of persisted', () => {
  const on = capsuleState({ sessionBound: false, enabled: false })
  assert.deepEqual(on.toggle, { kind: 'park', enabled: true })
  const off = capsuleState({ sessionBound: false, enabled: true })
  assert.deepEqual(off.toggle, { kind: 'park', enabled: false })
})
