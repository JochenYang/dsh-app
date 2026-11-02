/**
 * Behavioral tests for how the calendar faces read a day.
 *
 * The invariants: rows come from the detail, counts come from the aggregate, and no
 * face draws a count as a list or a list as a fact the store cannot back. These are
 * pure functions, so every case builds its input in memory and touches no file.
 *
 * @module @dsh-app/plugin-todo/tests/daydata
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dayView,
  itemsByDay,
  overdueCount,
  runSummary,
  statOf,
  tierOf,
  totalsOf,
} from '../src/client/daydata.ts'
import type { TodoItem } from '../src/wire.ts'

/** A local noon, so a DST shift cannot move the calendar day. */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

/** An open task written on `day`. */
function open(id: string, day: string, createdAt: number): TodoItem {
  return { id, text: id, day, createdAt, done: false }
}

/** A finished task written on `day` and ticked at `doneAt`. */
function finished(id: string, day: string, createdAt: number, doneAt: number): TodoItem {
  return { id, text: id, day, createdAt, done: true, doneAt }
}

test('itemsByDay files a finished task under the day it was finished', () => {
  const index = itemsByDay([finished('a', '2026-05-01', at(2026, 5, 1), at(2026, 5, 3, 9))])
  assert.equal(index.has('2026-05-01'), false)
  assert.deepEqual(index.get('2026-05-03')?.done.map(item => item.id), ['a'])
})

test('itemsByDay keeps an open task under the day it was written', () => {
  const index = itemsByDay([open('b', '2026-05-02', at(2026, 5, 2))])
  assert.deepEqual(index.get('2026-05-02')?.open.map(item => item.id), ['b'])
})

test('itemsByDay orders each side oldest first', () => {
  const index = itemsByDay([
    open('late', '2026-05-02', at(2026, 5, 2, 15)),
    open('early', '2026-05-02', at(2026, 5, 2, 8)),
  ])
  assert.deepEqual(index.get('2026-05-02')?.open.map(item => item.id), ['early', 'late'])
})

test('dayView shows rows when the detail holds the day, and says how many it left out', () => {
  const group = itemsByDay([
    open('1', '2026-05-02', at(2026, 5, 2, 8)),
    open('2', '2026-05-02', at(2026, 5, 2, 9)),
    open('3', '2026-05-02', at(2026, 5, 2, 10)),
  ]).get('2026-05-02')
  const view = dayView({ created: 4, done: 1 }, group, 2)
  assert.equal(view.kind, 'rows')
  if (view.kind !== 'rows') return
  assert.deepEqual(view.rows.map(item => item.id), ['1', '2'])
  assert.equal(view.hidden, 1)
})

test('dayView answers counts, not a list, when only the aggregate remains', () => {
  assert.deepEqual(dayView({ created: 3, done: 2 }, undefined, 2), { kind: 'counts' })
})

test('dayView answers empty for a day nothing touched', () => {
  assert.deepEqual(dayView({ created: 0, done: 0 }, undefined, 2), { kind: 'empty' })
})

test('tierOf bands the finished count into the same five steps as the heat map', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(done => tierOf({ created: done, done })), [0, 1, 2, 2, 3, 3, 4])
})

test('runSummary counts active days and the longest unbroken run, and a gap resets only the run', () => {
  const daily = {
    '2026-05-01': { created: 1, done: 1 },
    '2026-05-02': { created: 0, done: 2 },
    '2026-05-03': { created: 0, done: 0 },
    '2026-05-04': { created: 1, done: 1 },
    '2026-05-05': { created: 0, done: 1 },
    '2026-05-06': { created: 0, done: 1 },
  }
  const days = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07']
  assert.deepEqual(runSummary(daily, days), { done: 6, created: 2, active: 5, longest: 3 })
})

test('overdueCount asks the shared predicate, so the deadline is the axis', () => {
  const items = [
    open('old', '2026-05-01', at(2026, 5, 1)),
    open('today', '2026-05-04', at(2026, 5, 4)),
    finished('done-old', '2026-05-01', at(2026, 5, 1), at(2026, 5, 2)),
    // Written today, owed last week: late. The `day < today` comparison this
    // function used to make called it "not late" while the host tool called it late.
    { id: 'written-today-owed', text: 'written-today-owed', day: '2026-05-04', createdAt: at(2026, 5, 4), done: false, due: '2026-04-27' },
    // Written last week, owed next month: not late.
    { id: 'written-old-owed', text: 'written-old-owed', day: '2026-04-27', createdAt: at(2026, 4, 27), done: false, due: '2026-06-01' },
  ]
  assert.equal(overdueCount(items, '2026-05-04'), 2)
})

test('statOf and totalsOf zero-fill days the map does not carry', () => {
  const daily = { '2026-05-02': { created: 2, done: 1 } }
  assert.deepEqual(statOf(daily, '2026-05-09'), { created: 0, done: 0 })
  assert.deepEqual(totalsOf(daily, ['2026-05-01', '2026-05-02']), { created: 2, done: 1 })
})
