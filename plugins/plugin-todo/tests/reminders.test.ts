/**
 * Behavioral tests for the reminder selection.
 *
 * `dueReminder` is the whole "which task should ring" rule, kept pure so it can be
 * pinned without a clock or a DOM. The rest of the watcher is a timer and a store; the
 * rule is where a mistake is invisible (a notice that never comes, or one that comes
 * back every five seconds).
 *
 * @module @dsh-app/plugin-todo/tests/reminders
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueReminder, dueReminders, isLateReminder } from '../src/client/reminders.ts'
import type { TodoItem } from '../src/wire.ts'

/** An open task with a reminder at `reminderAt`. */
function armed(id: string, reminderAt: number, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, text: id, day: '2026-05-04', createdAt: 1, done: false, reminderAt, ...extra }
}

test('a due, open, unseen task is the one that rings', () => {
  const now = 10_000
  const due = dueReminder([armed('a', 9_000)], now, new Set())
  assert.equal(due?.id, 'a')
})

test('a task whose time has not come is not due', () => {
  assert.equal(dueReminder([armed('a', 11_000)], 10_000, new Set()), undefined)
})

test('done, already-seen, unarmed and dismissed tasks are all skipped', () => {
  const now = 10_000
  const items: TodoItem[] = [
    armed('done', 9_000, { done: true }),
    armed('seen', 9_000, { reminded: true }),
    { id: 'unarmed', text: 'unarmed', day: '2026-05-04', createdAt: 1, done: false },
    armed('closed', 9_000),
  ]
  assert.equal(dueReminder(items, now, new Set(['closed'])), undefined)
})

test('the first due task wins, so one notice never buries another', () => {
  const now = 10_000
  const items: TodoItem[] = [armed('first', 8_000), armed('second', 9_000)]
  assert.equal(dueReminder(items, now, new Set())?.id, 'first')
})

// --- the catch-up contract ----------------------------------------------------
//
// A reminder whose time passed while the app was CLOSED still rings on the next start,
// however late that is. This is the property a user relies on without saying it: "remind
// me at 9" means "make sure I know", not "make sure I know if I happen to be looking at
// 9:00". Anything that bounds how far into the past a reminder may be turns a missed
// reminder into a reminder that never existed.

test('a reminder from YESTERDAY still rings when the app starts the next morning', () => {
  const now = Date.parse('2026-11-05T11:30:00+08:00')
  const reminderAt = Date.parse('2026-11-04T09:00:00+08:00')
  const due = dueReminder([armed('yesterday', reminderAt)], now, new Set())
  assert.equal(due?.id, 'yesterday', '26 hours late is still a reminder, not a miss')
})

test('a reminder from a week ago still rings, and is not treated as expired', () => {
  const now = Date.parse('2026-11-11T08:00:00+08:00')
  const reminderAt = Date.parse('2026-11-04T09:00:00+08:00')
  assert.equal(dueReminder([armed('old', reminderAt)], now, new Set())?.id, 'old')
})

test('the OLDEST waiting reminder is the one that rings first', () => {
  // The notice is single-slot, so the order is the queue. Oldest first: that is the
  // one the user has been ignoring longest, and it is what a backlog read top-down
  // would show.
  const now = 10_000
  const items: TodoItem[] = [armed('newer', 9_500), armed('older', 2_000)]
  assert.equal(dueReminder(items, now, new Set())?.id, 'older')
})

test('dueReminders counts the backlog behind the notice', () => {
  const now = 10_000
  const items: TodoItem[] = [armed('a', 1_000), armed('b', 2_000), armed('c', 11_000), armed('d', 3_000, { done: true })]
  assert.deepEqual(dueReminders(items, now, new Set()).map(item => item.id), ['a', 'b'],
    'the not-yet-due and the finished task are not in the queue')
})

test('isLateReminder calls a next-day notice late and an on-time one not', () => {
  const item = armed('a', Date.parse('2026-11-04T09:00:00+08:00'))
  assert.equal(isLateReminder(item, Date.parse('2026-11-04T09:00:30+08:00')), false, 'half a minute is the tick, not news')
  assert.equal(isLateReminder(item, Date.parse('2026-11-04T09:05:00+08:00')), true)
  assert.equal(isLateReminder(item, Date.parse('2026-11-05T11:30:00+08:00')), true)
  assert.equal(isLateReminder({ id: 'x', text: 'x', day: '2026-11-04', createdAt: 1, done: false }, Date.now()), false,
    'an unarmed task is never late')
})
