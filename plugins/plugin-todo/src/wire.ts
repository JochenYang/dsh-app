/**
 * The wire between the two halves: route prefix, stored shapes, snapshot shape.
 *
 * Shared because both sides need the same string and the same field names, and
 * neither can import the other's implementation — `store.ts` is host-only (it
 * reads and writes files) and the client is browser-only. Types here carry no Node
 * imports, so this module is safe in both bundles.
 *
 * @module @dsh-app/plugin-todo/wire
 */

/** Route prefix, matching the suite's convention for plugin-owned routes. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-todo'

/** One task. */
export interface TodoItem {
  readonly id: string
  readonly text: string
  /** Creation day, `YYYY-MM-DD` in LOCAL time (the day the user wrote it). */
  readonly day: string
  readonly createdAt: number
  readonly done: boolean
  /** When it was ticked, epoch ms. Present only while `done` is true. */
  readonly doneAt?: number
  /** When to ring the in-app reminder, epoch ms. Absent for untimed tasks. */
  readonly reminderAt?: number
  /** Whether the user has dismissed or acknowledged the reminder. */
  readonly reminded?: boolean
}

/** One day's aggregate. */
export interface TodoDayStat {
  /** Tasks created that day. */
  readonly created: number
  /** Tasks ticked that day. */
  readonly done: number
}

/** The stored file. */
export interface TodoFile {
  readonly version: 1
  readonly items: readonly TodoItem[]
  /** Keyed `YYYY-MM-DD`, local time. Permanent: this is the statistics layer. */
  readonly daily: Readonly<Record<string, TodoDayStat>>
}

/** What every route answers: the whole board, so the client never merges diffs. */
export interface TodoSnapshot {
  /** The host's "today", so a clock-skewed client does not draw the wrong column. */
  readonly today: string
  readonly items: readonly TodoItem[]
  readonly daily: Readonly<Record<string, TodoDayStat>>
}
