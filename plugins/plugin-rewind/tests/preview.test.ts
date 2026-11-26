/**
 * Tests for the preview payload's three budgets.
 *
 * `/rewind plan <n>` carries a would-be recall's file diff, and the kernel
 * appends that command result to the session log verbatim: every load replays
 * it, and the transcript row parsed it per render. Measured before the caps,
 * 2,000 files of 42 KB produced a 179.9 MB payload (+170 MB on the host heap)
 * while the dialog shows at most 24 diff lines per file. The caps are therefore
 * a storage bound, not a display preference, and each of them is pinned here.
 *
 * The helper is pure, so these cases need no workspace. `previewRevert`'s wiring
 * to it is covered end to end in `revert.test.ts`.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  MAX_PREVIEW_ROWS,
  MAX_PREVIEW_SIDE_CHARS,
  MAX_PREVIEW_TOTAL_CHARS,
  previewPayload,
  type PreviewEntry,
} from '../src/index.ts'

/**
 * A text body of about `chars` characters, one 79-character line after another.
 *
 * Line breaks are deliberate: they are what the per-side cap prefers to cut at,
 * and they are the characters JSON escaping doubles, so the total-budget case
 * exercises the accounting rather than plain ASCII.
 */
function body(chars: number, seed = 'x'): string {
  const line = `${seed.repeat(79)}\n`
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
}

/** Whether a string holds an unpaired UTF-16 surrogate (which would encode as U+FFFD). */
function hasLoneSurrogate(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(at + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true
      at += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

test('the budgets are the published values, not local guesses', () => {
  // The client's note and the tests derive their expectations from these, so a
  // quiet edit here would change what the dialog promises without a failing test.
  assert.equal(MAX_PREVIEW_SIDE_CHARS, 64 * 1024)
  assert.equal(MAX_PREVIEW_TOTAL_CHARS, 4 * 1024 * 1024)
  assert.equal(MAX_PREVIEW_ROWS, 500)
})

test('every side of every large file is capped and marked truncated', () => {
  const payload = previewPayload([
    {
      path: '/w/big-a.ts',
      action: 'restore',
      current: body(200_000, 'a'),
      next: body(200_000, 'b'),
    },
    {
      path: '/w/big-b.md',
      action: 'restore',
      current: body(200_000, 'c'),
      next: body(200_000, 'd'),
    },
  ])
  assert.equal(payload.restore.length, 2)
  for (const row of payload.restore) {
    assert.ok(row.current !== undefined, 'the current side is still previewed')
    assert.ok(row.next !== undefined, 'and so is the restored side')
    assert.ok(row.current.length <= MAX_PREVIEW_SIDE_CHARS, `${row.path}: current is over the cap`)
    assert.ok(row.next.length <= MAX_PREVIEW_SIDE_CHARS, `${row.path}: next is over the cap`)
    assert.equal(row.currentTruncated, true)
    assert.equal(row.nextTruncated, true)
    // The cap prefers a line boundary, so the shown text reads as whole lines.
    assert.equal(row.current.endsWith('\n'), true)
    assert.equal(row.next.endsWith('\n'), true)
    // A truncated side is still a real diff; it must not lose the affordance.
    assert.equal(row.textOmitted, undefined)
  }
})

test('one very long line is cut at the cap rather than at its only boundary', () => {
  // A newline in the first quarter is not taken: it would throw away most of the
  // cap for a single line and show almost nothing.
  const long = `${'y'.repeat(MAX_PREVIEW_SIDE_CHARS * 2)}\ntail`
  const payload = previewPayload([{ path: '/w/minified.js', action: 'restore', current: long, next: long }])
  const row = payload.restore[0]
  assert.equal(row.current?.length, MAX_PREVIEW_SIDE_CHARS)
  assert.equal(row.current?.endsWith('\n'), false)
  assert.equal(row.currentTruncated, true)
})

test('a difference past the cap moves the window onto it, both sides aligned', () => {
  // Two sides that agree for 120 KB used to show two identical 64 KB prefixes:
  // an empty diff beside a "truncated" label, which reads as "no change".
  const lineOf = (index: number, filler: string): string => `${String(index).padStart(5, '0')}${filler.repeat(74)}\n`
  const lines = Array.from({ length: 2_500 }, (_, index) => lineOf(index, 'a'))
  const current = lines.join('')
  const changedLine = 1_500
  const next = lines
    .map((line, index) => (index === changedLine ? lineOf(index, 'b') : line))
    .join('')
  const row = previewPayload([{ path: '/w/late.ts', action: 'restore', current, next }]).restore[0]
  assert.ok(row.current !== undefined && row.next !== undefined)
  assert.equal(row.current.length <= MAX_PREVIEW_SIDE_CHARS, true)
  assert.equal(row.next.length <= MAX_PREVIEW_SIDE_CHARS, true)
  assert.equal(row.currentTruncated, true)
  assert.equal(row.nextTruncated, true)
  // The window starts at a line boundary in the middle of the file, not at 0.
  const startLine = Number(row.current.slice(0, 5))
  assert.equal(Number.isSafeInteger(startLine), true, 'the window starts mid-line')
  assert.ok(startLine > 0 && startLine < changedLine, `window starts at line ${String(startLine)}`)
  // The difference is inside the window, with leading context, and the shared
  // window start keeps everything before it identical on both sides.
  const changedOffset = row.next.indexOf('b'.repeat(74))
  assert.ok(changedOffset > 0, 'the window keeps some leading context')
  assert.equal(row.current.slice(0, changedOffset), row.next.slice(0, changedOffset))
  assert.equal(row.current.slice(changedOffset, changedOffset + 74), 'a'.repeat(74))
  assert.equal(row.next.slice(changedOffset, changedOffset + 74), 'b'.repeat(74))
})

test('a line-boundary back-off inside the prefix cannot cut the difference away', () => {
  // The geometry that closed the previous round but reopened this one: 100-char
  // lines for 20 KB, then one 50 KB line, with the first difference at 40,000.
  // The prefix window's last newline is at 19,999, so a prefix kept to that
  // boundary would end BEFORE the difference and show two identical texts — an
  // empty diff beside a "truncated" label.
  const lines = Array.from(
    { length: 200 },
    (_, index) => `${String(index).padStart(3, '0')}${'a'.repeat(96)}\n`,
  )
  const current = `${lines.join('')}${'b'.repeat(50_000)}`
  const diffAt = 40_000
  const next = `${current.slice(0, diffAt)}Z${current.slice(diffAt + 1)}`
  const row = previewPayload([{ path: '/w/back-off.ts', action: 'restore', current, next }]).restore[0]
  assert.equal(row.currentTruncated, true)
  assert.equal(row.nextTruncated, true)
  assert.notEqual(row.current, row.next, 'the kept windows must show the difference')
  assert.equal(row.next?.includes('Z'), true, 'the differing character is inside the window')
  assert.equal((row.current ?? '').length <= MAX_PREVIEW_SIDE_CHARS, true)
  assert.equal((row.next ?? '').length <= MAX_PREVIEW_SIDE_CHARS, true)
})

test('a window boundary never splits a surrogate pair', () => {
  const pair = '😀'.repeat(40_000)
  // A prefix window whose untrimmed end lands on the low half of a pair.
  const prefix = previewPayload(
    [{ path: '/w/emoji-prefix.ts', action: 'restore', current: pair, next: `Z${pair.slice(2)}` }],
    { sideChars: 65_535 },
  ).restore[0]
  assert.equal(hasLoneSurrogate(prefix.current ?? ''), false)
  assert.equal(hasLoneSurrogate(prefix.next ?? ''), false)
  // A moved window whose start lands on the low half of a pair.
  const moved = previewPayload(
    [{
      path: '/w/emoji-moved.ts',
      action: 'restore',
      current: pair,
      next: `${pair.slice(0, 70_000)}Z${pair.slice(70_000)}`,
    }],
    { sideChars: 65_535 },
  ).restore[0]
  assert.equal(hasLoneSurrogate(moved.current ?? ''), false)
  assert.equal(hasLoneSurrogate(moved.next ?? ''), false)
  assert.notEqual(moved.current, moved.next, 'the moved window still shows the difference')
})

test('a difference inside the cap keeps the file beginning', () => {
  const current = body(200_000, 'a')
  const next = `Z${current.slice(1)}`
  const row = previewPayload([{ path: '/w/early.ts', action: 'restore', current, next }]).restore[0]
  assert.equal(row.currentTruncated, true)
  assert.equal(row.current?.[0], 'a', 'the first difference is already inside the prefix')
  assert.equal(row.next?.[0], 'Z')
})

test('a row with one empty side keeps the beginning of the other', () => {
  // This is the deleted-file shape after the host resolves "gone" to `''`: there
  // is no difference to move towards, and the present side starts at the top.
  const next = body(200_000, 'n')
  const row = previewPayload([{ path: '/w/deleted.ts', action: 'restore', current: '', next }]).restore[0]
  assert.equal(row.current, '')
  assert.equal(row.currentTruncated, undefined)
  assert.equal(row.currentOmitted, undefined, 'a gone file is a real change, not an unreadable one')
  assert.equal(row.next?.startsWith('n'), true)
  assert.equal(row.nextTruncated, true)
})

test('once the total text budget is gone, later rows carry no text and say so', () => {
  const entries: PreviewEntry[] = [
    { path: '/w/first.ts', action: 'restore', current: 'a'.repeat(40), next: 'b'.repeat(40) },
    { path: '/w/second.ts', action: 'restore', current: 'c'.repeat(40), next: 'd'.repeat(40) },
  ]
  // 80 characters fit, the next 80 do not: the budget is spent by the first row.
  const payload = previewPayload(entries, { totalChars: 100 })
  assert.equal(payload.restore[0].current, 'a'.repeat(40))
  assert.equal(payload.restore[0].textOmitted, undefined)
  const second = payload.restore[1]
  assert.equal(second.path, '/w/second.ts', 'the row keeps its place')
  assert.equal(second.action, 'restore', 'and the action it describes')
  assert.equal(second.textOmitted, true)
  assert.equal('current' in second, false)
  assert.equal('next' in second, false)
})

test('a zero text budget still lists every row, marked and textless', () => {
  const payload = previewPayload([
    { path: '/w/a.txt', action: 'restore', current: 'A', next: 'B' },
    { path: '/w/b.txt', action: 'remove', current: 'C' },
  ], { totalChars: 0 })
  for (const row of [...payload.restore, ...payload.remove]) {
    assert.equal(row.textOmitted, true)
    assert.equal('current' in row, false)
    assert.equal('next' in row, false)
  }
})

test('past the row cap exactly the cap is listed and the rest is counted', () => {
  const entries: PreviewEntry[] = Array.from({ length: MAX_PREVIEW_ROWS + 7 }, (_, index) => ({
    path: `/w/file-${String(index).padStart(4, '0')}.txt`,
    action: index % 2 === 0 ? 'restore' as const : 'remove' as const,
    current: 'x',
  }))
  const payload = previewPayload(entries)
  assert.equal(payload.restore.length + payload.remove.length, MAX_PREVIEW_ROWS)
  assert.equal(payload.omitted, 7)
  // The listed rows are the first ones in the recall's own order, not a sample.
  assert.equal(payload.restore[0].path, '/w/file-0000.txt')
  const last = payload.remove[payload.remove.length - 1]
  assert.equal(last.path, `/w/file-${String(MAX_PREVIEW_ROWS - 1).padStart(4, '0')}.txt`)
})

test('the encoded payload stays under a bound derived from the text budget', () => {
  // 40 files of 200 KB per side: enough to exhaust the 4 MiB text budget, which
  // is the case the old code turned into a ~2.2x-of-the-change payload.
  const entries: PreviewEntry[] = Array.from({ length: 40 }, (_, index) => ({
    path: `/w/src/file-${String(index).padStart(3, '0')}.ts`,
    action: 'restore' as const,
    current: body(200_000, 'a'),
    next: body(200_000, 'b'),
  }))
  const payload = previewPayload(entries)
  const encoded = JSON.stringify(payload)
  // Text is charged as its escaped length, so the only bytes above the budget are
  // each listed row's short path and its fixed JSON field names.
  const perRowAllowance = 200
  const bound = MAX_PREVIEW_TOTAL_CHARS + MAX_PREVIEW_ROWS * perRowAllowance
  assert.ok(
    encoded.length < bound,
    `payload is ${String(encoded.length)} characters, over the ${String(bound)} bound`,
  )
  assert.equal(
    payload.restore.some((row) => row.textOmitted === true),
    true,
    'the fixture must actually exhaust the budget, or the bound proves nothing',
  )
})

test('a small change produces exactly the rows it produced before the caps', () => {
  const payload = previewPayload([
    { path: 'a.ts', action: 'restore', current: 'A', next: 'B' },
    { path: 'b.ts', action: 'remove', current: 'C' },
  ])
  // No marker field appears on a row that needed no cap: the confirmation dialog
  // is unchanged for an ordinary recall. The JSON string is pinned as well
  // because the command result IS that string in the session log.
  assert.deepEqual(payload, {
    restore: [{ path: 'a.ts', action: 'restore', current: 'A', next: 'B' }],
    remove: [{ path: 'b.ts', action: 'remove', current: 'C' }],
    omitted: 0,
  })
  assert.equal(
    JSON.stringify(payload),
    '{"restore":[{"path":"a.ts","action":"restore","current":"A","next":"B"}],'
      + '"remove":[{"path":"b.ts","action":"remove","current":"C"}],"omitted":0}',
  )
})
