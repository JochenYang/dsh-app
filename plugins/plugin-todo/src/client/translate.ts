/**
 * The `t` seat and the two labels every calendar face needs.
 *
 * Kept in one module so the faces, the hover cards and the page share ONE
 * definition of how a date and a weekday read — three copies of "month first or
 * day first" is how a calendar starts disagreeing with its own tooltip.
 *
 * @module @dsh-app/plugin-todo/client/translate
 */

import { partsOf } from './format.ts'
import type { TodoKey } from './locales.ts'

/** The `t` seat, narrowed to this plugin's keys. */
export type Translate = (key: TodoKey, params?: Record<string, string | number>) => string

/** Weekday names in interface order (Monday first), index = `DayParts.weekday`. */
export const WEEKDAY_KEYS = [
  'todo.weekday.mon',
  'todo.weekday.tue',
  'todo.weekday.wed',
  'todo.weekday.thu',
  'todo.weekday.fri',
  'todo.weekday.sat',
  'todo.weekday.sun',
] as const satisfies readonly TodoKey[]

/** Complete weekday names, for a line that also carries a full date. */
export const WEEKDAY_LONG_KEYS = [
  'todo.weekdayLong.mon',
  'todo.weekdayLong.tue',
  'todo.weekdayLong.wed',
  'todo.weekdayLong.thu',
  'todo.weekdayLong.fri',
  'todo.weekdayLong.sat',
  'todo.weekdayLong.sun',
] as const satisfies readonly TodoKey[]

/** Short weekday names that still say "weekday": the form a date card leads with. */
export const WEEKDAY_CARD_KEYS = [
  'todo.weekdayCard.mon',
  'todo.weekdayCard.tue',
  'todo.weekdayCard.wed',
  'todo.weekdayCard.thu',
  'todo.weekdayCard.fri',
  'todo.weekdayCard.sat',
  'todo.weekdayCard.sun',
] as const satisfies readonly TodoKey[]

/**
 * One weekday's name, as it follows a date.
 *
 * The FULL form, because every caller here prints it after a complete date: a line
 * that ends "2026年11月1日 · 日" reads like a typo against the 日 the date itself ends
 * with, and a list column that says only 一 makes the reader supply the rest. The
 * calendar grid's own column labels are the bare characters, and they read the key
 * table directly rather than through this function.
 *
 * @param t - the dictionary seat.
 * @param weekday - Monday-first index, 0-6.
 * @returns the localized name.
 */
export function weekdayName(t: Translate, weekday: number): string {
  return t(WEEKDAY_LONG_KEYS[weekday] ?? WEEKDAY_LONG_KEYS[0])
}

/**
 * One weekday's short-but-complete name (周一), for a compact card.
 * @param t - the dictionary seat.
 * @param weekday - Monday-first index, 0-6.
 */
export function weekdayCardName(t: Translate, weekday: number): string {
  return t(WEEKDAY_CARD_KEYS[weekday] ?? WEEKDAY_CARD_KEYS[0])
}

/**
 * One day key as a readable date.
 * @param t - the dictionary seat.
 * @param day - local `YYYY-MM-DD`.
 * @param form - `ymd` for a page heading, `md` for a card or tooltip.
 * @returns the localized date.
 */
export function dateLabel(t: Translate, day: string, form: 'ymd' | 'md' = 'md'): string {
  const parts = partsOf(day)
  return t(form === 'ymd' ? 'todo.date.ymd' : 'todo.date.md', {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  })
}
