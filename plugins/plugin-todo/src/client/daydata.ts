/**
 * How the calendar faces read a day.
 *
 * The store keeps two layers (see `store.ts`): `daily` is the permanent count per
 * day, `items` the detail for the last ninety days. Every face asks the same two
 * questions of them, so the answer is worked out once, here: rows when the detail
 * still holds the day, counts when only the aggregate does, and nothing otherwise.
 * A face that re-derived this would draw "three finished" and "no detail left" the
 * same way, and they are different facts.
 *
 * A row belongs to the day it was finished on when it is finished, and to the day
 * it was written while it is still open: a task ticked today is a fact about today,
 * whenever it was written.
 *
 * @module @dsh-app/plugin-todo/client/daydata
 */

import { heatLevel, keyOf } from './format.ts'
import { countInView } from '../views.ts'
import type { TodoDayStat, TodoItem } from '../wire.ts'

/** One day's rows, split by state, each side oldest first. */
export interface DayGroup {
  readonly done: readonly TodoItem[]
  readonly open: readonly TodoItem[]
}

/** Rows grouped by local day key. */
export type DayIndex = ReadonlyMap<string, DayGroup>

/**
 * Group rows by the day each one belongs to.
 * @param items - the board's detail rows.
 * @returns every day that holds at least one row.
 */
export function itemsByDay(items: readonly TodoItem[]): DayIndex {
  const index = new Map<string, { done: TodoItem[], open: TodoItem[] }>()
  for (const item of items) {
    const day = item.done ? keyOf(item.doneAt ?? item.createdAt) : item.day
    const bucket = index.get(day) ?? { done: [], open: [] }
    if (item.done) bucket.done.push(item)
    else bucket.open.push(item)
    index.set(day, bucket)
  }
  for (const bucket of index.values()) {
    bucket.done.sort((left, right) => (left.doneAt ?? left.createdAt) - (right.doneAt ?? right.createdAt))
    bucket.open.sort((left, right) => left.createdAt - right.createdAt)
  }
  return index
}

/**
 * One day's counts, zero-filled when the map has no row.
 * @param daily - the store's aggregate.
 * @param day - a local day key.
 */
export function statOf(daily: Readonly<Record<string, TodoDayStat>>, day: string): TodoDayStat {
  return daily[day] ?? { created: 0, done: 0 }
}

/**
 * Sum the counts of a list of days.
 * @param daily - the store's aggregate.
 * @param days - local day keys.
 */
export function totalsOf(daily: Readonly<Record<string, TodoDayStat>>, days: readonly string[]): TodoDayStat {
  let created = 0
  let done = 0
  for (const day of days) {
    const stat = statOf(daily, day)
    created += stat.created
    done += stat.done
  }
  return { created, done }
}

/** Figures across a run of days, for the year face's summary line. */
export interface RunSummary {
  /** Tasks finished in the run. */
  readonly done: number
  /** Tasks written in the run. */
  readonly created: number
  /** Days with at least one finished task. */
  readonly active: number
  /** The longest run of consecutive active days. */
  readonly longest: number
}

/**
 * Summarise a chronological run of days.
 * @param daily - the store's aggregate.
 * @param days - local day keys, oldest first.
 */
export function runSummary(daily: Readonly<Record<string, TodoDayStat>>, days: readonly string[]): RunSummary {
  let done = 0
  let created = 0
  let active = 0
  let run = 0
  let longest = 0
  for (const day of days) {
    const stat = statOf(daily, day)
    done += stat.done
    created += stat.created
    if (stat.done > 0) {
      active += 1
      run += 1
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
  }
  return { done, created, active, longest }
}

/**
 * Count the open rows the board calls late.
 *
 * THE PREDICATE IS NOT HERE. Lateness is one definition shared with the card, the
 * page and the host tool, and it lives in `views.ts` `inView` / `countInView`: the
 * deadline (`due`) is the axis, so a task written today and owed last week is late
 * and a task written last week and owed next month is not. This used to compare
 * `day < today`, which got both of those backwards for the card alone.
 *
 * @param items - the board's detail rows.
 * @param today - the host's local day key.
 */
export function overdueCount(items: readonly TodoItem[], today: string): number {
  return countInView(items, 'overdue', today)
}

/** What a face draws for one day. */
export type DayView =
  | { readonly kind: 'rows', readonly rows: readonly TodoItem[], readonly hidden: number }
  | { readonly kind: 'counts' }
  | { readonly kind: 'empty' }

/**
 * Pick what a day shows.
 * @param stat - the day's counts.
 * @param group - the day's rows, when the detail still holds them.
 * @param limit - how many rows the face can show before it says how many it left out.
 */
export function dayView(stat: TodoDayStat, group: DayGroup | undefined, limit: number): DayView {
  const all = group === undefined ? [] : [...group.open, ...group.done]
  if (all.length > 0) {
    const rows = all.slice(0, limit)
    return { kind: 'rows', rows, hidden: all.length - rows.length }
  }
  return stat.created + stat.done > 0 ? { kind: 'counts' } : { kind: 'empty' }
}

/**
 * The heat tier of a day, 0 to 4, from its finished count.
 * @param stat - the day's counts.
 */
export function tierOf(stat: TodoDayStat): 0 | 1 | 2 | 3 | 4 {
  return heatLevel(stat.done)
}
