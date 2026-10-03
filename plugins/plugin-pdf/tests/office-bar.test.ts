/**
 * The office-bar contract as this plugin implements it. Only the DOM-free half
 * is pinned here — placement decisions and slot ordering — because the capsule
 * is otherwise exercised through the client bundle; the point of these cases is
 * that adding PDF to the suite never reorders or duplicates a sibling's slot,
 * and that a pass which has nothing to fix stays silent (the observer must not
 * feed itself).
 *
 * @module @dsh-app/plugin-pdf/tests/office-bar
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPOSER_CARD_SELECTOR,
  OFFICE_BAR_CLASS,
  OFFICE_FORMAT_ATTR,
  OFFICE_FORMAT_ORDER,
  OFFICE_SLOT_CLASS,
  officeBarPlacement,
  orderOfficeFormats,
} from '../src/client/office-bar.ts'

test('office bar: the cross-plugin DOM contract is spelled exactly', () => {
  assert.equal(OFFICE_BAR_CLASS, 'dshOfficeBar')
  assert.equal(OFFICE_SLOT_CLASS, 'dshOfficeFormat')
  assert.equal(OFFICE_FORMAT_ATTR, 'data-office-format')
  assert.equal(COMPOSER_CARD_SELECTOR, 'div[data-composer-card]')
  assert.deepEqual([...OFFICE_FORMAT_ORDER], ['ppt', 'word', 'excel', 'pdf'])
})

test('office bar: known formats follow the suite order regardless of insertion order', () => {
  assert.deepEqual(orderOfficeFormats(['pdf', 'excel', 'ppt', 'word']), ['ppt', 'word', 'excel', 'pdf'])
})

test('office bar: unknown formats keep their first-seen order after the known ones', () => {
  assert.deepEqual(orderOfficeFormats(['pdf', 'foo', 'ppt', 'bar']), ['ppt', 'pdf', 'foo', 'bar'])
})

test('office bar: duplicate format ids collapse so no format can host twice', () => {
  assert.deepEqual(orderOfficeFormats(['pdf', 'pdf', 'word', 'pdf']), ['word', 'pdf'])
})

test('office bar: placement detaches without a card, inserts when unanchored, keeps when anchored', () => {
  assert.equal(officeBarPlacement({ cardPresent: false, barPresent: false, barAnchored: false }), 'none')
  assert.equal(officeBarPlacement({ cardPresent: false, barPresent: true, barAnchored: false }), 'detach')
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: false, barAnchored: false }), 'insert')
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: true, barAnchored: false }), 'insert')
  // The termination rule: an anchored bar must produce no write, or the pass
  // would schedule itself forever.
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: true, barAnchored: true }), 'keep')
})

// The stylesheet is injected ONCE by apply() and nothing owns its lifetime:
// measured on a live install 2026-10-03, the document dropped all four office
// <style> tags under a running mount and the bar rendered as a bare div
// (display block, four stacked hosts, no width, no margin). The reconcile pass
// re-injects it, so the entry file must hand adoptStyles to the bar as its
// third argument. This file pins the DOM-free half only (see its header), so
// the wiring is asserted where it lives rather than re-derived in a DOM double.
test('office bar: the entry hands the bar its style self-heal hook', () => {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const entry = readFileSync(join(pluginRoot, 'src', 'client', 'office-entry.tsx'), 'utf8')
  assert.match(entry, /import \{ adoptStyles \} from '\.\/styles\.ts'/u)
  assert.match(
    entry,
    /contributeOfficeCapsule\(\s*PDF_FORMAT,[\s\S]*?\},\s*adoptStyles\s*\)/u,
  )
})
