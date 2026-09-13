/**
 * Capsule presentation state: the format id this plugin claims in the shared
 * office bar, the label it renders, and where a body click sends the toggle
 * (persist with a session, park without one). Keeping this DOM-free is what
 * lets the office-bar DOM tests and this one stay independent.
 *
 * @module @dsh-app/plugin-pdf/tests/capsule-state
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDF_FORMAT, PDF_LABEL, capsuleState } from '../src/client/capsule-state.ts'
import { OFFICE_FORMAT_ORDER, PDF_FORMAT as BAR_FORMAT } from '../src/client/office-bar.ts'

test('capsule: the format id matches the office-bar contract and its slot order', () => {
  assert.equal(PDF_FORMAT, 'pdf')
  assert.equal(BAR_FORMAT, PDF_FORMAT)
  assert.ok(OFFICE_FORMAT_ORDER.includes(PDF_FORMAT), OFFICE_FORMAT_ORDER.join(','))
})

test('capsule: the label is the bare format name', () => {
  assert.equal(PDF_LABEL, 'PDF')
  assert.equal(capsuleState({ sessionBound: true, enabled: false }).label, 'PDF')
})

test('capsule: a session-bound click persists the flipped state', () => {
  assert.deepEqual(capsuleState({ sessionBound: true, enabled: false }), {
    enabled: false,
    label: 'PDF',
    toggle: { kind: 'persist', enabled: true },
  })
  assert.deepEqual(capsuleState({ sessionBound: true, enabled: true }).toggle, {
    kind: 'persist',
    enabled: false,
  })
})

test('capsule: without a session the click is parked for the session that follows', () => {
  assert.deepEqual(capsuleState({ sessionBound: false, enabled: false }).toggle, {
    kind: 'park',
    enabled: true,
  })
  assert.deepEqual(capsuleState({ sessionBound: false, enabled: true }).toggle, {
    kind: 'park',
    enabled: false,
  })
})
