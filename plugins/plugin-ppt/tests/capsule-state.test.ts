/**
 * Capsule presentation contract: the mode flag and the template are separate,
 * so an active capsule with no template shows the bare label (常规主题) while a
 * picked template extends it to `PPT · <name>`; the ▾ dropdown and what a body
 * click means are pinned here too. The state is a pure function of the mode and
 * of whether a session exists, so the toggle semantics are unit-tested rather
 * than through the browser-only react consumer.
 *
 * @module @dsh-app/plugin-ppt/tests/capsule-state
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PPT_FORMAT, PPT_LABEL, capsuleState } from '../src/client/capsule-state.ts'

test('capsule state: an idle format shows the bare label and no dropdown', () => {
  const state = capsuleState({ sessionBound: true, enabled: false, template: null })
  assert.equal(PPT_FORMAT, 'ppt')
  assert.equal(PPT_LABEL, 'PPT')
  assert.equal(state.enabled, false)
  assert.equal(state.label, 'PPT')
  assert.equal(state.caret, false)
})

test('capsule state: an active format with no template stays neutral and offers the dropdown', () => {
  const state = capsuleState({ sessionBound: true, enabled: true, template: null })
  assert.equal(state.enabled, true)
  assert.equal(state.label, 'PPT')
  assert.equal(state.caret, true)
})

test('capsule state: an active format shows the label with the template name', () => {
  const state = capsuleState({
    sessionBound: true,
    enabled: true,
    template: 'dsh-signal',
    name: '信号蓝',
  })
  assert.equal(state.enabled, true)
  assert.equal(state.label, 'PPT · 信号蓝')
  assert.equal(state.caret, true)
})

test('capsule state: an unnamed template falls back to its id in the label', () => {
  const state = capsuleState({ sessionBound: true, enabled: true, template: 'dsh-signal' })
  assert.equal(state.label, 'PPT · dsh-signal')
})

test('capsule state: a session-bound body click flips the mode without a template', () => {
  assert.deepEqual(
    capsuleState({ sessionBound: true, enabled: false, template: null }).toggle,
    { kind: 'persist', enabled: true },
  )
  assert.deepEqual(
    capsuleState({ sessionBound: true, enabled: true, template: 'dsh-signal' }).toggle,
    { kind: 'persist', enabled: false },
  )
})

test('capsule state: without a session the body click parks the same toggle', () => {
  // The unbound capsule cannot persist, so the identical toggle is parked for
  // the first session-bound pass instead of being dropped.
  assert.deepEqual(
    capsuleState({ sessionBound: false, enabled: false, template: null }).toggle,
    { kind: 'park', enabled: true },
  )
  assert.deepEqual(
    capsuleState({ sessionBound: false, enabled: true, template: null }).toggle,
    { kind: 'park', enabled: false },
  )
})
