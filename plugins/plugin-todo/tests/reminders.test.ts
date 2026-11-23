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
import { applyBoard } from '../src/client/board.ts'
import { dismissReminder, dueReminder, dueReminders, isLateReminder, shownReminder, startReminderWatch } from '../src/client/reminders.ts'
import type { TodoItem, TodoSnapshot } from '../src/wire.ts'

/** An open task with a reminder at `reminderAt`. */
function armed(id: string, reminderAt: number, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, text: id, day: '2026-05-04', createdAt: 1, done: false, reminderAt, ...extra }
}

const snapshotOf = (items: readonly TodoItem[]): TodoSnapshot => ({ today: '2026-05-04', items, daily: {}, lists: [] })

/** The dictionary seat as a test sees it: the key, then the params it was handed. */
const t = (key: string, params?: Record<string, string | number>): string => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)

/**
 * Run the watcher's first tick over `items` with the window hidden or shown, and
 * collect what it told the desktop.
 *
 * The notice that tick publishes stays in the module's store, so it is dismissed
 * through the real path afterwards — which writes the "seen" flag back, hence the
 * fetch stand-in answering the same board for every call.
 */
async function ringsWhile(hidden: boolean, items: readonly TodoItem[]): Promise<string[]> {
  const told: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, value: snapshotOf(items) }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  try {
    applyBoard(snapshotOf(items))
    const dispose = startReminderWatch({
      t,
      hidden: () => hidden,
      notify: async (title, body) => { told.push(`${title} | ${body}`); return true },
    })
    dispose()
    const shownId = shownReminder()?.item.id
    if (shownId !== undefined) await dismissReminder(shownId)
  } finally {
    globalThis.fetch = originalFetch
  }
  return told
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

test('a ring reaches the desktop only while the window is hidden, and only once', async () => {
  // The in-app notice cannot be seen in a minimised window, so that is the one
  // state in which the same ring also becomes a system notification; a visible
  // window already shows the notice and a second copy would be noise.
  const now = Date.now()
  const due = armed('desktop-due', now - 1_000, { text: 'file the invoice' })
  const hidden = await ringsWhile(true, [due])
  // A COUNT, never the task's text: the notification lands in the desktop's own
  // store (notification history, lock screen), outside what the app controls.
  assert.deepEqual(hidden, ['todo.reminder.toastTitle | todo.reminder.notifyBody {"count":1}'])
  assert.ok(!hidden[0]?.includes('file the invoice'))
  const visible = await ringsWhile(false, [armed('desktop-visible', now - 1_000, { text: 'water the plant' })])
  assert.deepEqual(visible, [], 'a visible window is told nothing')
})

test('the notification carries the late title and the waiting count the notice shows', async () => {
  const now = Date.now()
  const late = armed('desktop-late', now - 3 * 60 * 60 * 1000, { text: 'renew the certificate' })
  const behind = armed('desktop-behind', now - 1_000, { text: 'call the bank' })
  const told = await ringsWhile(true, [late, behind])
  assert.deepEqual(told, ['todo.reminder.toastLateTitle | todo.reminder.notifyBody {"count":2}'])
})
