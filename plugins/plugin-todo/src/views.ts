/**
 * The pure rules both halves have to agree on: which view a task is in, how far
 * through its steps it is, how a repeat rule advances a deadline, and when a
 * deadline's reminder rings.
 *
 * Host and client both end up agreeing on what "overdue" means — the tool that
 * answers the model, the card that draws a count, the tab that filters the page and
 * the row that tags a deadline all ask the same question, and two implementations of
 * a date comparison drift the moment one of them is edited. So the rule lives here
 * once: no Node modules, no `Date.now()`, no locale, no imported clock — `today` and
 * `now` are parameters the host reads and the client receives in the snapshot.
 *
 * What is wired to what, so nobody has to guess:
 *
 * - the host's `todo_list` answers `range=overdue` / `range=upcoming` from
 *   {@link inView}, and completing a task advances a repeat rule through
 *   {@link advanceDue} (`index.ts`, `store.ts`);
 * - the card counts today and overdue with {@link countInView}, and the board filters
 *   its tabs and tags its rows with {@link inView} (`client/card.tsx`,
 *   `client/view.tsx`, `client/rows.tsx`);
 * - the editor derives a reminder from a deadline with {@link presetReminderAt}
 *   (`client/editor.tsx`), and progress on a task's steps is {@link subtaskProgress}.
 *
 * @module @dsh-app/plugin-todo/views
 */

import { MAX_REPEAT_INTERVAL, type RepeatRule, type TodoItem } from './wire.ts'

/** The five views the board offers. */
export type TodoView = 'today' | 'overdue' | 'upcoming' | 'done' | 'all'

/**
 * How many days after today `upcoming` reaches.
 *
 * The window is `(today, today + 7]`: the seventh day ahead is inside it and today
 * itself is not (today has its own view).
 */
export const UPCOMING_DAYS = 7

/**
 * Advance a `YYYY-MM-DD` key by whole local days.
 *
 * Noon rather than midnight, so a daylight-saving shift cannot move the calendar
 * day either way, and `Date`'s own month/year carry does the arithmetic — the
 * month-end and leap-year cases are the reason not to add 7 to the day number.
 */
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const at = new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + count, 12, 0, 0, 0)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The day a task is owed on: its deadline, or the day it was written.
 *
 * The fallback is what makes a pre-deadline task behave: "written last Tuesday and
 * still open" is late, and the store fills `due` from `day` for exactly that
 * reason. An item built in memory without either still reads as due on its
 * creation day rather than never.
 */
export function dueDay(item: TodoItem): string {
  return item.due ?? item.day
}

/**
 * Whether one task belongs in one view.
 *
 * The rules, and why each is drawn where it is:
 *
 * - `today` — open, and owed today. The deadline is the axis; `day` only decides
 *   which column of the calendar the task was written under.
 * - `overdue` — open, and owed BEFORE today. A task with no deadline whose `day`
 *   is earlier than today lands here: "written yesterday, not done" is late in the
 *   only sense the board can observe, and leaving it out of both `today` and
 *   `overdue` would hide it from every view except `all`.
 * - `upcoming` — open, and owed after today but within {@link UPCOMING_DAYS}.
 *   Strictly after, so an item is never counted in `today` and here at once.
 * - `done` — ticked, whatever its dates say.
 * - `all` — everything, ticked or not.
 *
 * The three open views are mutually exclusive by construction (before / equal to /
 * after `today`), so a task is never counted twice when the card sums them.
 *
 * @param item - one task.
 * @param view - which view is being asked about.
 * @param today - the host's `YYYY-MM-DD`, never read from the clock here.
 * @returns whether the task is in that view.
 */
export function inView(item: TodoItem, view: TodoView, today: string): boolean {
  if (view === 'all') return true
  if (view === 'done') return item.done
  if (item.done) return false
  const due = dueDay(item)
  // Zero-padded ISO keys compare correctly as strings, which is why `due` is
  // stored as a day key and not as a timestamp.
  if (view === 'today') return due === today
  if (view === 'overdue') return due < today
  return due > today && due <= addDays(today, UPCOMING_DAYS)
}

/**
 * How many tasks one view holds — the figure a card or a tab draws.
 *
 * Counting is the same predicate as deciding ({@link inView}), so a badge and the
 * list under it cannot disagree; a second loop with its own comparison is exactly how
 * the card came to call a task written today and owed last week "not late".
 *
 * @param items - the board's rows.
 * @param view - which view to count.
 * @param today - the host's `YYYY-MM-DD`.
 * @returns how many rows are in that view.
 */
export function countInView(items: readonly TodoItem[], view: TodoView, today: string): number {
  let count = 0
  for (const item of items) if (inView(item, view, today)) count += 1
  return count
}

/**
 * How far through its steps one task is: `done` of `total`.
 *
 * A DISPLAY figure, never a second source of truth. The parent's `done` is the
 * user's own statement and is not derived from these (`wire.ts`
 * `TodoItem.subtasks`), so a task can be ticked with steps left over and every step
 * can be ticked on a task that is still open. A task with no steps answers
 * `0 of 0`, which a renderer draws as "no progress bar" rather than "0%".
 *
 * @param item - one task.
 * @returns the step counts.
 */
export function subtaskProgress(item: TodoItem): { done: number, total: number } {
  const steps = item.subtasks ?? []
  return { done: steps.filter(step => step.done).length, total: steps.length }
}

/** `YYYY-MM-DD` from calendar parts. */
function dayOf(year: number, month: number, date: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(year)}-${pad(month)}-${pad(date)}`
}

/**
 * Whether a string is a day key the calendar actually draws.
 *
 * The round trip through `addDays` is the check: `2026-02-31` matches the shape and
 * normalises to 3 March, so a shape test alone would advance a deadline from a date
 * that never existed.
 */
function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && addDays(value, 0) === value
}

/** Day of the week for one key: `0` Sunday to `6` Saturday, local time. */
function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12, 0, 0, 0).getDay()
}

/**
 * Last day of one local month; `month` is 1-based.
 *
 * Day `0` of the next month is the last day of this one. Noon, so a daylight-saving
 * shift at midnight cannot move the answer a day either way.
 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0, 12, 0, 0, 0).getDate()
}

/**
 * Advance a day key by whole local months, CLAMPING the day number to the month it
 * lands in.
 *
 * The clamp is the whole point. `Date` would carry 31 February forward into
 * 3 March, so a monthly rent task set on the 31st would walk out of its month; the
 * rule the board documents is "the same day, or the last one that month". The base
 * is always the instance's own deadline, so a series set on the 31st goes
 * 31 Jan → 28 Feb → 28 Mar → 28 Apr, which is the accepted meaning of a clamped
 * month step (it does not drift back out to the 31st).
 *
 * @param day - a real day key.
 * @param count - how many months to move.
 * @returns the advanced day key.
 */
function addMonths(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const shifted = (month ?? 1) - 1 + count
  const targetYear = (year ?? 1970) + Math.floor(shifted / 12)
  const targetMonth = (((shifted % 12) + 12) % 12) + 1
  return dayOf(targetYear, targetMonth, Math.min(date ?? 1, lastDayOfMonth(targetYear, targetMonth)))
}

/**
 * Advance a day key by whole WORKING days: Saturday and Sunday are skipped.
 *
 * Public holidays are deliberately not modelled: the board has no calendar source,
 * and guessing one would move a task on a day the user considers ordinary. One
 * `interval` unit is one working day, so a Friday task with `interval: 1` comes back
 * on Monday and `interval: 2` on Tuesday.
 */
function addWorkdays(day: string, count: number): string {
  let current = day
  for (let step = 0; step < count; step += 1) {
    current = addDays(current, 1)
    while (weekdayOf(current) === 0 || weekdayOf(current) === 6) current = addDays(current, 1)
  }
  return current
}

/**
 * The deadline one repeat rule moves a task to.
 *
 * `monthly` and `yearly` are calendar steps with a clamp, not fixed day counts, and
 * `weekday` counts working days — see {@link addMonths} and {@link addWorkdays}.
 *
 * THE RESULT IS CHECKED, not only the argument. A number the arithmetic cannot carry
 * (an interval past what a `Date` can hold, so `addDays` answers `"NaN-NaN-NaN"`)
 * would otherwise become the next instance's deadline, and a key starting with `N`
 * sorts after every real day: the task lands in no view at all — not today, not
 * overdue, not upcoming — and `normalize()` drops it on the next read. So a step the
 * calendar cannot draw answers "this rule cannot advance", the same refusal as a
 * rule with no usable interval, and `completeTodo` writes no successor.
 *
 * @param due - the finishing instance's deadline, a real local day key.
 * @param rule - the cadence.
 * @returns the next deadline, or `undefined` when the rule cannot advance this
 * deadline: an interval that is not a whole positive number of units, or one past
 * `MAX_REPEAT_INTERVAL` (a stored rule is normalized to 1..999, so either is a rule
 * built in memory), a cadence a newer build wrote, a deadline the calendar does not
 * draw, or a step that lands outside the calendar's own range.
 */
export function advanceDue(due: string, rule: RepeatRule): string | undefined {
  if (!isDayKey(due)) return undefined
  const interval = rule.interval
  // The upper bound is the second half of the same guard: `weekday` WALKS its units,
  // so an interval nobody capped is a synchronous loop inside a request handler
  // (`wire.ts` `MAX_REPEAT_INTERVAL`). The store drops such a rule on the way in; this
  // refuses to walk one that reached here anyway.
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_REPEAT_INTERVAL) return undefined
  let next: string
  switch (rule.freq) {
    case 'daily': next = addDays(due, interval); break
    case 'weekly': next = addDays(due, interval * 7); break
    case 'weekday': next = addWorkdays(due, interval); break
    case 'monthly': next = addMonths(due, interval); break
    case 'yearly': next = addMonths(due, interval * 12); break
    default: return undefined
  }
  return isDayKey(next) ? next : undefined
}

/** How the reminder picker derives a time from the deadline. */
export type ReminderPreset = 'due-day' | 'hour-before' | 'custom' | 'none'

/** The local hour `due-day` and `hour-before` ring at. */
export const DUE_REMINDER_HOUR = 9

/** One hour in ms: the gap `hour-before` keeps. */
const HOUR_MS = 3_600_000

/**
 * The instant one reminder preset means, or `undefined` when it means none.
 *
 * The two deadline presets hang off the SAME anchor — {@link DUE_REMINDER_HOUR} on
 * the deadline's own day — because a day key carries no time of day: "one hour
 * before" is therefore 08:00 on that day, and both are built from local calendar
 * parts, so a month end, a year end and a leap day all land on their own day
 * without any fixed 24-hour arithmetic.
 *
 * A deadline that is absent or is not a day the calendar draws answers `undefined`
 * for both: the board has no other axis to hang a reminder on, and picking one for
 * the user (midnight? now?) fires at the wrong moment.
 *
 * A derived time that has ALREADY PASSED also answers `undefined` — "no reminder",
 * not "ring now". A task written at 10:00 is due today at 09:00, a time that is
 * behind the clock: arming it would raise a notice the instant the task was typed,
 * for a deadline the user can already see is today. The comparison is `<=`, not
 * `<`, because the watcher rings at `reminderAt <= now` (`client/reminders.ts`), so
 * an instant equal to now is already due.
 *
 * `custom` is the user's own instant and is passed through as given — including a
 * past one, which the picker lets them correct — while `none` always answers
 * `undefined`, whatever `due` and `customAt` say.
 *
 * @param due - the task's deadline, absent when it has none.
 * @param preset - which preset the user picked.
 * @param now - the current epoch ms, a parameter so this stays pure.
 * @param customAt - the instant `custom` means.
 * @returns the reminder timestamp, or `undefined`.
 */
export function presetReminderAt(
  due: string | undefined,
  preset: ReminderPreset,
  now: number,
  customAt?: number,
): number | undefined {
  if (preset === 'none') return undefined
  if (preset === 'custom') {
    return typeof customAt === 'number' && Number.isFinite(customAt) ? Math.floor(customAt) : undefined
  }
  if (due === undefined || !isDayKey(due)) return undefined
  const [year, month, date] = due.split('-').map(Number)
  const atDue = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, DUE_REMINDER_HOUR, 0, 0, 0).getTime()
  const at = preset === 'hour-before' ? atDue - HOUR_MS : atDue
  return at > now ? at : undefined
}
