/**
 * Unit tests for the `/rewind` popup's pure helpers (`src/client/popup.ts`).
 *
 * The popup is the entry point a user reaches by typing `/rewind`, so its row
 * building is pinned here: one row per recallable message, the ordinal as the
 * row id (a pick submits `/rewind <id>` with no second lookup), and a time
 * detail that survives a malformed stamp.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { anchorsToOptions, clockOf } from '../src/client/popup.ts'

test('anchorsToOptions carries the ordinal as the row id', () => {
  const options = anchorsToOptions({
    anchors: [
      { n: 1, seq: 9, turn: 3, time: 0, preview: 'newest' },
      { n: 2, seq: 4, turn: 2, time: 0, preview: 'older' },
    ],
  })
  assert.equal(options.length, 2)
  // The id IS the ordinal the host command expects, so onSelect can submit
  // `/rewind <id>` without consulting the projection again.
  assert.deepEqual(options.map((o) => o.id), ['1', '2'])
  assert.deepEqual(options.map((o) => o.label), ['newest', 'older'])
})

test('anchorsToOptions tolerates a missing or empty projection', () => {
  assert.deepEqual(anchorsToOptions(undefined), [])
  assert.deepEqual(anchorsToOptions({}), [])
  assert.deepEqual(anchorsToOptions({ anchors: [] }), [])
})

test('anchorsToOptions falls back to the seq when the preview is empty', () => {
  // A message with no text (an attachment-only prompt) still needs a label the
  // user can pick; the surface seq is the honest fallback.
  const options = anchorsToOptions({ anchors: [{ n: 1, seq: 42, turn: 1, time: 0, preview: '' }] })
  assert.equal(options[0].label, '42')
})

test('anchorsToOptions adds a clock detail when the time is usable', () => {
  const noon = new Date(2026, 0, 2, 12, 34, 56).getTime()
  const options = anchorsToOptions({ anchors: [{ n: 1, seq: 1, turn: 1, time: noon, preview: 'x' }] })
  assert.equal(options[0].detail, '12:34:56')
})

test('anchorsToOptions omits the detail rather than showing an invalid date', () => {
  const options = anchorsToOptions({ anchors: [{ n: 1, seq: 1, turn: 1, time: Number.NaN, preview: 'x' }] })
  assert.equal('detail' in options[0], false)
})

test('clockOf formats a real stamp and rejects an unusable one', () => {
  assert.equal(clockOf(new Date(2026, 0, 2, 3, 4, 5).getTime()), '03:04:05')
  assert.equal(clockOf(Number.NaN), '')
  assert.equal(clockOf(Number.POSITIVE_INFINITY), '')
})
