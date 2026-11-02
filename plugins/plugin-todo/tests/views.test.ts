/**
 * Behavioral tests for the pure rules in `views.ts`: the five derived views and the
 * reminder presets.
 *
 * The board has two axes now — the day a task was WRITTEN (`day`) and the day it
 * is OWED (`due`) — and every bug this file guards against is a bug about which
 * axis a view reads. Three properties are load-bearing:
 *
 * 1. `today`, `overdue` and `upcoming` never overlap. The card sums them, so an
 *    item counted twice reads as two tasks.
 * 2. A task with no deadline whose `day` has passed is OVERDUE. It is the
 *    ordinary case for every task written before v2 ("noted yesterday, still not
 *    done"), and the failure mode of getting it wrong is that the task appears in
 *    no view but `all` — a todo board that hides work.
 * 3. The upcoming window is seven local days, so it has to survive a month end
 *    and a leap year without a date library.
 *
 * The preset cases pin the one decision a reminder preset cannot avoid: a derived
 * time that has already passed arms NOTHING, because the alternative raises a notice
 * the instant a task due today is typed.
 *
 * @module @dsh-app/plugin-todo/tests/views
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DUE_REMINDER_HOUR,
  UPCOMING_DAYS,
  addDays,
  advanceDue,
  countInView,
  dueDay,
  inView,
  presetReminderAt,
  type TodoView,
} from '../src/views.ts'
import { MAX_REPEAT_INTERVAL } from '../src/wire.ts'
import type { TodoItem } from '../src/wire.ts'

/** The host's "today" for every case below; a fixed day, never the clock. */
const TODAY = '2026-05-04'

const OPEN_VIEWS: readonly TodoView[] = ['today', 'overdue', 'upcoming']

/** One task, written today unless the case says otherwise. */
function item(id: string, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, text: id, day: TODAY, createdAt: 1_777_000_000_000, done: false, ...extra }
}

/** Which of the three open views the task lands in, as a list. */
function openViewsOf(entry: TodoItem, today = TODAY): TodoView[] {
  return OPEN_VIEWS.filter(view => inView(entry, view, today))
}

test('a deadline puts a task in exactly one open view', () => {
  const cases: readonly { id: string, due: string, expect: TodoView | undefined }[] = [
    { id: 'yesterday', due: '2026-05-03', expect: 'overdue' },
    { id: 'today', due: TODAY, expect: 'today' },
    { id: 'tomorrow', due: '2026-05-05', expect: 'upcoming' },
    // Eight days out is past the window: it is neither late nor imminent.
    { id: 'eight-days', due: addDays(TODAY, 8), expect: undefined },
  ]

  for (const entry of cases) {
    const task = item(entry.id, { due: entry.due })
    assert.deepEqual(openViewsOf(task), entry.expect === undefined ? [] : [entry.expect], entry.id)
    // `all` holds everything, and `done` holds nothing open.
    assert.equal(inView(task, 'all', TODAY), true, entry.id)
    assert.equal(inView(task, 'done', TODAY), false, entry.id)
  }
})

test('with no deadline the creation day is the deadline', () => {
  assert.equal(dueDay(item('no-due')), TODAY)
  assert.equal(dueDay(item('with-due', { due: '2026-06-01' })), '2026-06-01')

  // Written today, no deadline: today's work.
  assert.deepEqual(openViewsOf(item('written-today')), ['today'])

  // Written yesterday, no deadline, still open: late. This is the case a board
  // that only looked at `due` would lose — every task recorded before v2 is here.
  const yesterday = item('written-yesterday', { day: '2026-05-03' })
  assert.deepEqual(openViewsOf(yesterday), ['overdue'])
  assert.equal(inView(yesterday, 'today', TODAY), false)
})

test('a ticked task is in `done` and in none of the open views', () => {
  const late = item('late-but-done', { due: '2026-04-01', done: true, doneAt: 1_777_100_000_000 })
  assert.deepEqual(openViewsOf(late), [])
  assert.equal(inView(late, 'done', TODAY), true)
  assert.equal(inView(late, 'all', TODAY), true)

  const dueToday = item('done-today', { due: TODAY, done: true })
  assert.deepEqual(openViewsOf(dueToday), [])
  assert.equal(inView(dueToday, 'today', TODAY), false)
  assert.equal(inView(dueToday, 'done', TODAY), true)
})

test('the upcoming window ends seven days out, inclusive', () => {
  assert.equal(UPCOMING_DAYS, 7)
  const edge = item('edge', { due: addDays(TODAY, UPCOMING_DAYS) })
  assert.equal(inView(edge, 'upcoming', TODAY), true)
  assert.deepEqual(openViewsOf(item('past-edge', { due: addDays(TODAY, UPCOMING_DAYS + 1) })), [])

  // `today` is the near edge and is excluded: it belongs to the today view.
  assert.equal(inView(item('near-edge', { due: TODAY }), 'upcoming', TODAY), false)
})

test('addDays advances local days across a month end, a year end and a leap day', () => {
  assert.equal(addDays('2026-05-04', 7), '2026-05-11')
  // 31 May + 7 = 7 June, not "31 + 7 = 38".
  assert.equal(addDays('2026-05-31', 7), '2026-06-07')
  assert.equal(addDays('2026-12-28', 7), '2027-01-04')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addDays('2027-02-28', 1), '2027-03-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2026-05-04', 0), '2026-05-04')
})

test('a window that crosses a month end still finds its tasks', () => {
  // Today is the last day of the month: the window has to leave May.
  const monthEnd = '2026-05-31'
  assert.equal(inView(item('next-week', { due: '2026-06-07' }), 'upcoming', monthEnd), true)
  assert.equal(inView(item('too-far', { due: '2026-06-08' }), 'upcoming', monthEnd), false)
  // And the same day is still late relative to a task owed yesterday.
  assert.equal(inView(item('late', { due: '2026-05-30' }), 'overdue', monthEnd), true)
})

/** A local instant, so the expected reminder does not depend on the machine's zone. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

test('the due-day preset rings at 09:00 on the deadline, and arms nothing once that has passed', () => {
  const due = '2026-05-04'
  assert.equal(DUE_REMINDER_HOUR, 9)

  // Written the day before: 09:00 is still ahead.
  assert.equal(presetReminderAt(due, 'due-day', at(2026, 5, 3, 20)), at(2026, 5, 4, 9))
  // Typed at 00:00 ON the due day: still ahead, so it arms — the boundary the plan
  // asks about resolves to "yes, until 09:00".
  assert.equal(presetReminderAt(due, 'due-day', at(2026, 5, 4, 0)), at(2026, 5, 4, 9))
  // Typed at 10:00: the moment is behind the clock, so there is no reminder to arm
  // rather than one that rings the instant it is set.
  assert.equal(presetReminderAt(due, 'due-day', at(2026, 5, 4, 10)), undefined)
  // Exactly at 09:00 it is already due: the watcher rings at `reminderAt <= now`.
  assert.equal(presetReminderAt(due, 'due-day', at(2026, 5, 4, 9)), undefined)
})

test('hour-before is one hour ahead of the same 09:00 anchor', () => {
  assert.equal(presetReminderAt('2026-05-04', 'hour-before', at(2026, 5, 4, 7)), at(2026, 5, 4, 8))
  // 08:00 has passed by 09:00, so the preset arms nothing.
  assert.equal(presetReminderAt('2026-05-04', 'hour-before', at(2026, 5, 4, 9)), undefined)
  // A reminder for tomorrow is unaffected by the clock today.
  assert.equal(presetReminderAt('2026-05-05', 'hour-before', at(2026, 5, 4, 23)), at(2026, 5, 5, 8))
})

test('a preset over no deadline answers nothing rather than guessing', () => {
  assert.equal(presetReminderAt(undefined, 'due-day', at(2026, 5, 1, 12)), undefined)
  assert.equal(presetReminderAt(undefined, 'hour-before', at(2026, 5, 1, 12)), undefined)
  // A deadline the calendar never draws is no deadline either.
  assert.equal(presetReminderAt('2026-02-31', 'due-day', at(2026, 5, 1, 12)), undefined)
})

test('none arms nothing, and custom passes the user\'s own instant through', () => {
  assert.equal(presetReminderAt('2026-05-04', 'none', at(2026, 5, 1, 12), at(2026, 5, 4, 7)), undefined)
  assert.equal(presetReminderAt(undefined, 'none', at(2026, 5, 1, 12)), undefined)

  assert.equal(presetReminderAt('2026-05-04', 'custom', at(2026, 5, 1, 12), at(2026, 5, 4, 7, 30)), at(2026, 5, 4, 7, 30))
  // Custom is the user's own choice, so a past instant is passed through as given:
  // the picker is where they correct it, not here.
  assert.equal(presetReminderAt('2026-05-04', 'custom', at(2026, 5, 4, 12), at(2026, 5, 4, 7)), at(2026, 5, 4, 7))
  // Custom without an instant has nothing to arm.
  assert.equal(presetReminderAt('2026-05-04', 'custom', at(2026, 5, 1, 12)), undefined)
  assert.equal(presetReminderAt('2026-05-04', 'custom', at(2026, 5, 1, 12), Number.NaN), undefined)
})

test('countInView sums exactly the rows inView keeps, view by view', () => {
  const items = [
    item('late', { due: addDays(TODAY, -3) }),
    item('due-today', { due: TODAY }),
    item('soon', { due: addDays(TODAY, 2) }),
    item('far', { due: addDays(TODAY, 30) }),
    item('ticked', { due: TODAY, done: true, doneAt: 1_777_100_000_000 }),
  ]
  // The three open views are disjoint, so they add up to the open rows.
  const openTotal = items.filter(entry => !entry.done).length
  assert.equal(countInView(items, 'today', TODAY), 1)
  assert.equal(countInView(items, 'overdue', TODAY), 1)
  assert.equal(countInView(items, 'upcoming', TODAY), 1)
  assert.equal(
    countInView(items, 'today', TODAY) + countInView(items, 'overdue', TODAY) + countInView(items, 'upcoming', TODAY),
    openTotal - 1,
    'the far-out row is in no open view, and the ticked one is in none of them',
  )
  assert.equal(countInView(items, 'done', TODAY), 1)
  assert.equal(countInView(items, 'all', TODAY), items.length)
})

test('a preset across a month end, a year end and a leap day keeps the deadline\'s own day', () => {  assert.equal(presetReminderAt('2026-06-01', 'due-day', at(2026, 5, 31, 23)), at(2026, 6, 1, 9))
  assert.equal(presetReminderAt('2027-01-01', 'hour-before', at(2026, 12, 31, 20)), at(2027, 1, 1, 8))
  assert.equal(presetReminderAt('2028-02-29', 'due-day', at(2028, 2, 28, 12)), at(2028, 2, 29, 9))
})


test('a step the calendar cannot carry is refused instead of handed to the store', () => {
  // What the arithmetic answers for these is a key like "NaN-NaN-NaN" or a seven-digit
  // year. Either one sorts after every real day, so the successor would sit in NO view
  // — not today, not overdue, not upcoming — and `normalize()` would drop the row on
  // the next read. The completion therefore reports `invalid-rule` instead.
  assert.equal(advanceDue('2026-01-31', { freq: 'daily', interval: 1_000_000_000 }), undefined)
  assert.equal(advanceDue('2026-01-31', { freq: 'monthly', interval: 1_000_000_000 }), undefined)
  assert.equal(advanceDue('2026-01-31', { freq: 'yearly', interval: 1_000_000_000 }), undefined)
  // The cap on the WALK: `weekday` moves one unit at a time, so an unbounded interval is
  // a loop that would hang the caller. It is refused before the first step.
  assert.equal(advanceDue('2026-01-31', { freq: 'weekday', interval: 1_000_000_000 }), undefined)
  assert.equal(advanceDue('2026-01-31', { freq: 'weekday', interval: MAX_REPEAT_INTERVAL + 1 }), undefined)
  // Right at the cap is still a real step, so the refusal is the bound and not "any
  // large number".
  assert.equal(advanceDue('2026-01-31', { freq: 'daily', interval: MAX_REPEAT_INTERVAL }), '2028-10-26')
})

test('stepping back day keys lands on distinct calendar days', () => {
  // The host's week strip is built this way (`index.ts` `recentDays`), and a fixed
  // 24-hour subtraction is wrong on a spring-forward day: a 23-hour day makes two
  // offsets name the same calendar day. Seven calendar steps are seven days, whatever
  // the zone's clocks did — 2026-03-08 is the US transition.
  const keys = Array.from({ length: 7 }, (_unused, index) => addDays('2026-03-09', -index))
  assert.deepEqual(keys, [
    '2026-03-09', '2026-03-08', '2026-03-07', '2026-03-06', '2026-03-05', '2026-03-04', '2026-03-03',
  ])
  assert.equal(new Set(keys).size, 7)
  // The arithmetic reads calendar parts only: a key carries no time of day, so the same
  // input answers the same key whatever the machine's clock says.
  assert.equal(addDays('2026-03-08', -1), '2026-03-07')
  assert.equal(addDays('2026-03-08', 1), '2026-03-09')
})
