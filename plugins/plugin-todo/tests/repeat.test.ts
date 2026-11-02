/**
 * Behavioral tests for repeating tasks: `advanceDue` (the calendar step) and
 * `completeTodo` (what a completion does to the board).
 *
 * Every date here is built from local calendar parts, so the cases do not depend on
 * the machine's zone or on the clock. The three properties this file pins are the
 * ones a hand-written scheduler gets wrong:
 *
 * 1. A monthly or yearly step CLAMPS instead of overflowing. 31 January plus one
 *    month is 28 February, not 3 March; 29 February plus one year is 28 February, and
 *    plus four years is 29 February again. `Date`'s own carry would walk a series
 *    out of its month and nobody would notice until a payment landed in the wrong
 *    one.
 * 2. `weekday` counts WORKING days. Friday plus one is Monday, and the weekend is
 *    not two units.
 * 3. One series holds ONE open instance. A completion always records the tick, but
 *    it opens the next instance only when the series has none open — and a retried
 *    completion opens nothing at all.
 *
 * @module @dsh-app/plugin-todo/tests/repeat
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addTodo, completeTodo, emptyTodos, type TodoFile, type TodoItem } from '../src/store.ts'
import { advanceDue } from '../src/views.ts'

/** The ids one completion may mint, fixed so the cases can assert on them. */
const IDS = { task: 'next-instance', series: 'series-new' }

/** A local noon, unless the case needs another hour. */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

/**
 * A board holding one open task, written and due on 2026-05-04.
 *
 * `due` is DROPPED before the override is spread in, so a case that does not name a
 * deadline gets a task with no `due` key at all — the shape `dueDay` falls back from.
 */
function board(extra: Partial<TodoItem> = {}): TodoFile {
  const base = addTodo(emptyTodos(), 'water the plants', at(2026, 5, 4), 'a1', '2026-05-04').file
  const { due: _due, ...rest } = base.items[0]!
  return { ...base, items: [{ ...rest, ...extra }] }
}

test('daily and weekly move by whole intervals, across a year end', () => {
  assert.equal(advanceDue('2026-05-04', { freq: 'daily', interval: 1 }), '2026-05-05')
  assert.equal(advanceDue('2026-05-04', { freq: 'daily', interval: 3 }), '2026-05-07')
  assert.equal(advanceDue('2026-05-04', { freq: 'weekly', interval: 1 }), '2026-05-11')
  // 28 December 2026 is a Monday; the next Monday is in the next year.
  assert.equal(advanceDue('2026-12-28', { freq: 'weekly', interval: 1 }), '2027-01-04')
  assert.equal(advanceDue('2026-12-28', { freq: 'weekly', interval: 2 }), '2027-01-11')
})

test('weekday counts working days and skips the weekend, not holidays', () => {
  // Friday + 1 working day is Monday: the weekend is not one of them.
  assert.equal(advanceDue('2026-05-01', { freq: 'weekday', interval: 1 }), '2026-05-04')
  assert.equal(advanceDue('2026-05-01', { freq: 'weekday', interval: 2 }), '2026-05-05')
  // Wednesday + 5 working days is the next Wednesday.
  assert.equal(advanceDue('2026-05-06', { freq: 'weekday', interval: 5 }), '2026-05-13')
  // A Saturday instance still lands on a working day: the step starts by moving on.
  assert.equal(advanceDue('2026-05-02', { freq: 'weekday', interval: 1 }), '2026-05-04')
  // The board models no public holidays, so a Friday before one still moves on
  // Monday rather than guessing a day the user considers ordinary.
  assert.equal(advanceDue('2026-05-01', { freq: 'weekday', interval: 3 }), '2026-05-06')
})

test('monthly clamps to the last day of the month it lands in', () => {
  // The headline case: 31 January + one month is the last day of February.
  assert.equal(advanceDue('2026-01-31', { freq: 'monthly', interval: 1 }), '2026-02-28')
  assert.equal(advanceDue('2028-01-31', { freq: 'monthly', interval: 1 }), '2028-02-29')
  assert.equal(advanceDue('2026-03-31', { freq: 'monthly', interval: 1 }), '2026-04-30')
  assert.equal(advanceDue('2026-12-15', { freq: 'monthly', interval: 1 }), '2027-01-15')
  assert.equal(advanceDue('2026-11-30', { freq: 'monthly', interval: 3 }), '2027-02-28')
  // Clamped once, the series carries the day it now holds: 28 February + one month
  // is 28 March, not the 31st it started on.
  assert.equal(advanceDue('2026-02-28', { freq: 'monthly', interval: 1 }), '2026-03-28')
})

test('yearly clamps 29 February to 28 in a common year', () => {
  assert.equal(advanceDue('2028-02-29', { freq: 'yearly', interval: 1 }), '2029-02-28')
  // Four years on is a leap year again, so the 29th survives the wider interval.
  assert.equal(advanceDue('2028-02-29', { freq: 'yearly', interval: 4 }), '2032-02-29')
  assert.equal(advanceDue('2026-07-04', { freq: 'yearly', interval: 1 }), '2027-07-04')
})

test('an unusable rule advances nothing', () => {
  // The refusal the plan asks for: interval 0 (and every other non-positive or
  // fractional interval) generates no instance rather than one a day, or one for ever.
  assert.equal(advanceDue('2026-05-04', { freq: 'daily', interval: 0 }), undefined)
  assert.equal(advanceDue('2026-05-04', { freq: 'weekly', interval: -1 }), undefined)
  assert.equal(advanceDue('2026-05-04', { freq: 'monthly', interval: 1.5 }), undefined)
  assert.equal(advanceDue('2026-05-04', { freq: 'weekday', interval: Number.NaN }), undefined)
  // A deadline the calendar never draws cannot be advanced from: the step would
  // start from a day that does not exist.
  assert.equal(advanceDue('2026-02-31', { freq: 'daily', interval: 1 }), undefined)
  assert.equal(advanceDue('not-a-day', { freq: 'daily', interval: 1 }), undefined)
})

test('completing a repeating task opens the next instance and starts a series', () => {
  const file = board({
    due: '2026-05-04',
    listId: 'work',
    priority: 2,
    notes: 'the can is under the sink',
    subtasks: [{ id: 's1', text: 'fill the can', done: true }],
    repeat: { freq: 'weekly', interval: 1 },
    reminderAt: at(2026, 5, 4, 9),
    reminded: true,
  })

  const outcome = completeTodo(file, 'a1', at(2026, 5, 4, 18), IDS)
  assert.ok(outcome !== undefined)
  // The tick itself, and the series the task now belongs to.
  assert.equal(outcome.item.done, true)
  assert.equal(outcome.item.seriesId, 'series-new')
  assert.equal(outcome.skipped, undefined)
  // The permanent counter moved: completed today, and a task created today.
  assert.deepEqual(outcome.file.daily['2026-05-04'], { created: 2, done: 1 })

  const next = outcome.next
  assert.ok(next !== undefined)
  assert.equal(next.id, 'next-instance')
  assert.equal(next.text, 'water the plants')
  assert.equal(next.due, '2026-05-11')
  assert.equal(next.day, '2026-05-04')
  assert.equal(next.createdAt, at(2026, 5, 4, 18))
  assert.equal(next.done, false)
  assert.equal(next.seriesId, 'series-new')
  assert.equal(next.listId, 'work')
  assert.equal(next.priority, 2)
  assert.equal(next.notes, 'the can is under the sink')
  assert.deepEqual(next.repeat, { freq: 'weekly', interval: 1 })
  // The checklist comes along UNCHECKED: redoing the steps is the point.
  assert.deepEqual(next.subtasks, [{ id: 's1', text: 'fill the can', done: false }])
  // The reminder does not: its timestamp belongs to the occurrence that just rang.
  assert.equal('reminderAt' in next, false)
  assert.equal('reminded' in next, false)

  // Both rows are on the board.
  assert.deepEqual(outcome.file.items.map(item => item.id), ['a1', 'next-instance'])
})

test('an existing series id is inherited by the next instance', () => {
  const file = board({ due: '2026-05-04', repeat: { freq: 'daily', interval: 1 }, seriesId: 'series-1' })
  const outcome = completeTodo(file, 'a1', at(2026, 5, 4, 18), IDS)
  assert.equal(outcome?.item.seriesId, 'series-1')
  assert.equal(outcome?.next?.seriesId, 'series-1')
})

test('a task with no deadline advances from the day it was written', () => {
  const outcome = completeTodo(board({ repeat: { freq: 'daily', interval: 2 } }), 'a1', at(2026, 5, 4, 18), IDS)
  assert.equal(outcome?.next?.due, '2026-05-06')
})

test('the next instance advances from its own deadline', () => {
  const file = board({ due: '2026-05-31', repeat: { freq: 'monthly', interval: 1 } })
  const first = completeTodo(file, 'a1', at(2026, 5, 31, 9), { task: 'n1', series: 's1' })
  assert.equal(first?.next?.due, '2026-06-30')

  const second = completeTodo(first!.file, 'n1', at(2026, 6, 30, 9), { task: 'n2', series: 's2' })
  assert.equal(second?.next?.due, '2026-07-30')
  // The series is one chain, so the second instance keeps the first one's series.
  assert.equal(second?.next?.seriesId, 's1')
})

test('a series that already has an open instance gets no second one', () => {
  const file = board({ due: '2026-05-04', repeat: { freq: 'daily', interval: 1 }, seriesId: 'series-1' })
  const open: TodoItem = { ...file.items[0]!, id: 'open-one', due: '2026-05-09' }
  const withOpen: TodoFile = { ...file, items: [...file.items, open] }

  const outcome = completeTodo(withOpen, 'a1', at(2026, 5, 4, 18), IDS)
  assert.ok(outcome !== undefined)
  // The completion is recorded and SAID, not swallowed.
  assert.equal(outcome.item.done, true)
  assert.equal(outcome.skipped, 'open-instance')
  assert.equal(outcome.next, undefined)
  assert.equal(outcome.file.items.length, 2)
  assert.equal(outcome.file.items.filter(item => !item.done).length, 1)
  // Only the completion moved the counter; no instance was created.
  assert.deepEqual(outcome.file.daily['2026-05-04'], { created: 1, done: 1 })
})

test('a retried completion does not mint a second instance', () => {
  const file = board({ due: '2026-05-04', repeat: { freq: 'daily', interval: 1 } })
  const first = completeTodo(file, 'a1', at(2026, 5, 4, 18), IDS)
  assert.ok(first?.next !== undefined)

  const again = completeTodo(first.file, 'a1', at(2026, 5, 4, 18), { task: 'another', series: 'another' })
  assert.ok(again !== undefined)
  assert.equal(again.next, undefined)
  assert.equal(again.skipped, undefined)
  // Nothing was written at all: the file is the one the first call produced.
  assert.equal(again.file, first.file)
  assert.equal(again.file.items.length, 2)
})

test('an interval the rule cannot use opens nothing, and says so', () => {
  const file = board({ due: '2026-05-04', repeat: { freq: 'daily', interval: 0 } })
  const outcome = completeTodo(file, 'a1', at(2026, 5, 4, 18), IDS)
  assert.ok(outcome !== undefined)
  assert.equal(outcome.item.done, true)
  assert.equal(outcome.skipped, 'invalid-rule')
  assert.equal(outcome.next, undefined)
  assert.equal(outcome.file.items.length, 1)
})

test('a task with no rule opens nothing and joins no series', () => {
  const outcome = completeTodo(board({ due: '2026-05-04' }), 'a1', at(2026, 5, 4, 18), IDS)
  assert.ok(outcome !== undefined)
  assert.equal(outcome.next, undefined)
  assert.equal(outcome.skipped, undefined)
  assert.equal(outcome.item.seriesId, undefined)
  assert.deepEqual(outcome.file.items.map(item => item.id), ['a1'])
})

test('completing an unknown id is refused', () => {
  assert.equal(completeTodo(board(), 'nope', at(2026, 5, 4), IDS), undefined)
})

test('a rule that walks past the calendar opens nothing and reports invalid-rule', () => {
  // The arithmetical step for these lands on a key like "NaN-NaN-NaN" or a seven-digit
  // year. Written as the successor's `due` it sorts after every real day, so the task
  // would sit in NO view and `normalize()` would drop it on the next read — the user
  // completes a routine and the next instance disappears.
  for (const rule of [
    { freq: 'daily', interval: 1_000_000_000 },
    { freq: 'monthly', interval: 1_000_000_000 },
    { freq: 'yearly', interval: 1_000_000_000 },
    // `weekday` walks its units one at a time, so this one is refused before the walk.
    { freq: 'weekday', interval: 1_000_000_000 },
  ] as const) {
    const outcome = completeTodo(board({ due: '2026-01-31', repeat: rule }), 'a1', at(2026, 5, 4, 18), IDS)
    assert.ok(outcome !== undefined, rule.freq)
    assert.equal(outcome.item.done, true, rule.freq)
    assert.equal(outcome.next, undefined, `${rule.freq}: no successor`)
    assert.equal(outcome.skipped, 'invalid-rule', rule.freq)
    assert.deepEqual(outcome.file.items.map(item => item.id), ['a1'], `${rule.freq}: nothing was written`)
  }
})

test('a completion that CAN advance still writes a day the calendar draws', () => {
  const outcome = completeTodo(board({ due: '2026-01-31', repeat: { freq: 'monthly', interval: 1 } }), 'a1', at(2026, 5, 4, 18), IDS)
  assert.ok(outcome?.next !== undefined)
  assert.equal(outcome.next.due, '2026-02-28')
  assert.match(String(outcome.next.due), /^\d{4}-\d{2}-\d{2}$/u)
})
