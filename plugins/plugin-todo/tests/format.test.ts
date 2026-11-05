/**
 * Behavioral tests for the calendar arithmetic behind the three statistics faces.
 *
 * These are the parts of the plugin that are easy to get subtly wrong and hard to
 * notice on screen: a week that starts on Sunday, a month grid whose blanks land on
 * the wrong side, a year map missing its last days. Every case is built from local
 * `new Date(y, m, d)` instants rather than ISO strings, so the expectations hold in
 * whatever timezone the suite runs in.
 *
 * @module @dsh-app/plugin-todo/tests/format
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatStamp,
  heatLevel,
  keyOf,
  monthGrid,
  percent,
  shortDay,
  tipDivider,
  weekKeys,
  weekStart,
  yearGrid,
} from '../src/client/format.ts'
import type { MonthCell } from '../src/client/format.ts'

/** A local noon, so a DST shift cannot move the calendar day. */
function at(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime()
}

/** The days a year grid carries, in grid order. */
function daysOf(grid: (string | null)[][]): string[] {
  return grid.flat().filter((day): day is string => day !== null)
}

/** The days a MONTH grid carries that belong to the month, in grid order. */
function insideOf(grid: MonthCell[][]): string[] {
  return grid.flat().filter(cell => !cell.outside).map(cell => cell.day)
}

test('keyOf writes the local day, zero padded', () => {
  assert.equal(keyOf(at(2026, 3, 7)), '2026-03-07')
  assert.equal(keyOf(at(2026, 11, 30)), '2026-11-30')
})

test('weekStart is the Monday of that week, for every weekday', () => {
  // 2026-03-02 is a Monday; the loop walks Monday → Sunday.
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(2026, 2, 2 + offset, 12)
    assert.equal(keyOf(weekStart(day.getTime())), '2026-03-02', `offset ${String(offset)}`)
  }
})

test('weekKeys is seven consecutive days starting on Monday', () => {
  const days = weekKeys(at(2026, 3, 5))
  assert.equal(days.length, 7)
  assert.equal(days[0], '2026-03-02')
  assert.equal(days[6], '2026-03-08')
})

test('monthGrid is six Monday-first rows of real days, with the neighbours marked outside', () => {
  // March 2026 starts on a Sunday: the widest lead a Monday-first grid can have.
  const grid = monthGrid(at(2026, 3, 15))
  assert.equal(grid.length, 6)
  assert.ok(grid.every(row => row.length === 7))

  const cells = grid.flat()
  assert.equal(cells.length, 42)
  // The grid opens on Monday 23 February, drawn as a neighbour rather than a blank.
  assert.equal(cells[0]!.day, '2026-02-23')
  assert.equal(cells[0]!.outside, true)
  // 1 March sits in the Sunday column of the first row.
  assert.equal(cells[6]!.day, '2026-03-01')
  assert.equal(cells[6]!.outside, false)

  const days = insideOf(grid)
  assert.equal(days.length, 31)
  assert.equal(new Set(days).size, 31)
  assert.equal(days[0], '2026-03-01')
  assert.equal(days.at(-1), '2026-03-31')
  assert.equal(cells.filter(cell => cell.outside).length, 11)
})

test('monthGrid keeps a short month at six rows and still fills its edges', () => {
  const grid = monthGrid(at(2026, 2, 10))
  assert.equal(grid.length, 6)
  const days = insideOf(grid)
  assert.equal(days.length, 28)
  assert.equal(days.at(-1), '2026-02-28')
  // Every cell holds a day: nothing is blank any more.
  assert.equal(grid.flat().length, 42)
  assert.ok(grid.flat().every(cell => /^\d{4}-\d{2}-\d{2}$/u.test(cell.day)))
})

test('yearGrid covers the whole year once, in seven-day columns', () => {
  const columns = yearGrid(at(2026, 6, 15))
  assert.ok(columns.length >= 52 && columns.length <= 54)
  assert.ok(columns.every(column => column.length === 7))

  const days = daysOf(columns)
  assert.equal(days.length, 365)
  assert.equal(new Set(days).size, 365)
  assert.equal(days[0], '2026-01-01')
  assert.equal(days.at(-1), '2026-12-31')
  // Each column is one Monday-first week: 1 January 2026 is a Thursday.
  assert.equal(columns[0]!.indexOf('2026-01-01'), 3)

  // A leap year adds exactly one day.
  assert.equal(daysOf(yearGrid(at(2028, 6, 15))).length, 366)
})

test('percent clamps to 0…100 and refuses to divide by zero', () => {
  assert.equal(percent(0, 0), 0)
  assert.equal(percent(1, 4), 25)
  assert.equal(percent(4, 4), 100)
  assert.equal(percent(9, 4), 100)
})

test('heatLevel bands the finished count into five steps', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(heatLevel), [0, 1, 2, 2, 3, 3, 4, 4])
})

test('shortDay is the MM-DD tail of a key', () => {
  assert.equal(shortDay('2026-03-07'), '03-07')
})

test('tipDivider adapts to content length and never wraps', () => {
  const short = tipDivider(['2026-03-07', 'task'])
  assert.equal(short.length, 18)
  const long = tipDivider(['11月2日 · 星期一 (完成 0 · 新增 2)', '○ 优化coding usage的antigravity用量接口协议'])
  assert.equal(long.length, 25)
  assert.equal(tipDivider(['a'.repeat(200)]).length, 25)
})

test('formatStamp names the day once the reminder is not from today', () => {
  // The catch-up case: a notice that rang yesterday evening must not print "21:30" and
  // read as if it were on time today.
  //
  // Built from LOCAL components, not from an offset string: `formatStamp` renders in
  // the machine's local time, so a `+08:00` literal asserts 21:30 only on a machine in
  // that zone — it read 13:30 on CI's UTC runner, which is how this test failed the
  // release build.
  const evening = new Date(2026, 10, 4, 21, 30).getTime()
  assert.equal(formatStamp(evening, new Date(2026, 10, 4, 21, 31).getTime()), '21:30')
  assert.equal(formatStamp(evening, new Date(2026, 10, 5, 11, 30).getTime()), '2026-11-04 21:30')
})
