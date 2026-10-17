/**
 * Tests for the entry point's copy.
 *
 * The dock button was removed: it opened a picker under the input box, read as a
 * stray element there, and duplicated an affordance the per-message icon already
 * covers. The icon is now the only visible entry point, so these tests cover the
 * icon's two keys and nothing else — the picker copy it used to be compared
 * against is gone, and a test that still demanded it would keep the deleted
 * surface alive.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { en, zh } from '../src/client/locales.ts'

test('the icon carries both a tooltip and an accessible name', () => {
  for (const dict of [zh, en]) {
    for (const key of ['rewind.message.action.hint', 'rewind.message.action.aria']) {
      assert.ok(typeof dict[key] === 'string' && dict[key] !== '', `${key} must be present`)
    }
  }
})

test('the per-message copy names the message it acts on', () => {
  // "this message", not "a message": the tooltip sits under one specific bubble.
  assert.match(zh['rewind.message.action.hint'], /这条消息/)
  assert.match(zh['rewind.message.action.aria'], /这条消息/)
  assert.match(en['rewind.message.action.hint'], /this message/i)
  assert.match(en['rewind.message.action.aria'], /this message/i)
})

test('the two dictionaries cover the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('the compaction-boundary answers say the older messages cannot be recalled', () => {
  // The whole point of the separate code: an ordinal past a compaction is not a
  // typo, it is history the user can never get back. Both languages must say that,
  // not just "no such number".
  for (const dict of [zh, en]) {
    for (const key of ['rewind.host.compactionBoundary', 'rewind.host.listBoundary', 'rewind.picker.boundary', 'rewind.confirm.boundary']) {
      assert.ok(typeof dict[key] === 'string' && dict[key] !== '', `${key} must be present`)
    }
  }
  assert.match(zh['rewind.host.compactionBoundary'], /压缩边界之前的消息已经无法撤回/)
  assert.match(en['rewind.host.compactionBoundary'], /compaction boundary can no longer be recalled/i)
  assert.match(zh['rewind.host.listBoundary'], /压缩边界之前.*无法撤回/)
  assert.match(en['rewind.host.listBoundary'], /compaction boundary can no longer be recalled/i)
})
