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
import { dueReminder } from '../src/client/reminders.ts'
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
