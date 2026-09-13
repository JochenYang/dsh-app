/**
 * The client-side contract this plugin must honour as one contributor to the
 * shared office bar: the format id and the canonical slot order (the DOM
 * contract other suite plugins coordinate through), the bar placement and
 * ordering decisions, the capsule's two-state presentation, and the pending
 * slot a hero toggle waits in.
 *
 * @module @dsh-app/plugin-sheet/tests/capsule
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPOSER_CARD_SELECTOR,
  OFFICE_BAR_CLASS,
  OFFICE_FORMAT_ATTR,
  OFFICE_FORMAT_ORDER,
  OFFICE_SLOT_CLASS,
  officeBarPlacement,
  orderOfficeFormats,
} from '../src/client/office-bar.ts'
import { capsuleState, SHEET_FORMAT, SHEET_LABEL } from '../src/client/capsule-state.ts'
import { pendingMode } from '../src/client/pending-mode.ts'
import { ROUTE_PREFIX } from '../src/client/api.ts'
import { ROUTE_PREFIX as HOST_ROUTE_PREFIX } from '../src/routes.ts'

test('office bar: the Excel format is contributed under the shared contract', () => {
  assert.equal(SHEET_FORMAT, 'excel')
  assert.equal(SHEET_LABEL, 'Excel')
  assert.equal(OFFICE_BAR_CLASS, 'dshOfficeBar')
  assert.equal(OFFICE_SLOT_CLASS, 'dshOfficeFormat')
  assert.equal(OFFICE_FORMAT_ATTR, 'data-office-format')
  assert.equal(COMPOSER_CARD_SELECTOR, 'div[data-composer-card]')
  assert.deepEqual([...OFFICE_FORMAT_ORDER], ['ppt', 'word', 'excel', 'pdf'])
  assert.equal(OFFICE_FORMAT_ORDER.indexOf(SHEET_FORMAT), 2)
})

test('office bar: slot order is canonical and unknown formats keep their insert order', () => {
  assert.deepEqual(orderOfficeFormats(['excel', 'ppt']), ['ppt', 'excel'])
  assert.deepEqual(orderOfficeFormats(['pdf', 'word', 'excel', 'ppt']), ['ppt', 'word', 'excel', 'pdf'])
  assert.deepEqual(orderOfficeFormats(['excel', 'mindmap', 'ppt', 'excel']), ['ppt', 'excel', 'mindmap'])
})

test('office bar: placement detaches without a composer and never re-inserts blindly', () => {
  assert.equal(officeBarPlacement({ cardPresent: false, barPresent: false, barAnchored: false }), 'none')
  assert.equal(officeBarPlacement({ cardPresent: false, barPresent: true, barAnchored: false }), 'detach')
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: false, barAnchored: false }), 'insert')
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: true, barAnchored: false }), 'insert')
  // The termination rule: an anchored bar must produce no write.
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: true, barAnchored: true }), 'keep')
})

test('capsule: a body click flips the mode and the flip target depends on the session', () => {
  const unbound = capsuleState({ sessionBound: false, enabled: false })
  assert.equal(unbound.enabled, false)
  assert.equal(unbound.label, 'Excel')
  assert.deepEqual(unbound.toggle, { kind: 'park', enabled: true })
  assert.match(unbound.hint, /会话开始后生效/u)

  const boundOn = capsuleState({ sessionBound: true, enabled: true })
  assert.equal(boundOn.enabled, true)
  assert.deepEqual(boundOn.toggle, { kind: 'persist', enabled: false })
  assert.equal(boundOn.hint, '点击关闭表格模式')

  assert.deepEqual(capsuleState({ sessionBound: true, enabled: false }).toggle, { kind: 'persist', enabled: true })
})

test('pending slot: a hero toggle is consumed exactly once by the session-bound pass', () => {
  assert.equal(pendingMode.get(), undefined)
  assert.equal(pendingMode.consume(), undefined)

  const seen: (boolean | undefined)[] = []
  const unsubscribe = pendingMode.subscribe(() => { seen.push(pendingMode.get()) })
  pendingMode.set(true)
  assert.equal(pendingMode.get(), true)
  assert.equal(pendingMode.consume(), true)
  assert.equal(pendingMode.get(), undefined)
  assert.equal(pendingMode.consume(), undefined)
  unsubscribe()
  pendingMode.set(false)
  assert.equal(seen.length, 2, 'subscribers hear set and consume; consume of an empty slot stays silent')
  assert.equal(pendingMode.consume(), false)
  assert.equal(pendingMode.get(), undefined)
})

test('client and host halves agree on the route prefix', () => {
  assert.equal(ROUTE_PREFIX, HOST_ROUTE_PREFIX)
  assert.equal(ROUTE_PREFIX, '/plugins/@dsh-app/plugin-sheet/api')
})
