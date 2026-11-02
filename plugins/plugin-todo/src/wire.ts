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

/** One step inside a task. */
export interface Subtask {
  readonly id: string
  readonly text: string
  readonly done: boolean
}

/**
 * How many `freq` units one repeat rule may name.
 *
 * A CAP, not a formatting nicety. `interval` is a count the advancer walks: `weekday`
 * steps one working day per unit, so a stored `1e6` is a multi-second synchronous
 * loop inside a route handler and a stored `1e9` is a request that never answers —
 * one bad number in one task hangs the whole host. 999 units is more than a year of
 * weekly repetitions and still cheap to walk, and it keeps every result a four-digit
 * year, which is what a day key can hold.
 *
 * Lives here rather than in `store.ts` because BOTH halves enforce it: the store drops
 * an out-of-range rule it reads, and the editor refuses to type one.
 */
export const MAX_REPEAT_INTERVAL = 999

/** How a repeated task comes back. */
export interface RepeatRule {
  /** `weekday` means "every working day": Monday to Friday, weekends skipped. */
  readonly freq: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekday'
  /** How many `freq` units between instances; 1 to {@link MAX_REPEAT_INTERVAL}. */
  readonly interval: number
}

/**
 * What an armed reminder was derived from.
 *
 * `due-day` and `hour-before` are DERIVED: the instant hangs off the deadline, so
 * moving the deadline has to move them (`views.ts` `presetReminderAt`). `custom` is
 * the user's own instant and never moves on its own. Absent means `custom` — every
 * reminder written before this field existed was a picked instant, and re-deriving
 * one of those would move a time the user chose by hand.
 */
export type ReminderSource = 'due-day' | 'hour-before' | 'custom'

/**
 * What completing one repeating task did.
 *
 * The completion is the only trigger a repeat rule has (`store.ts` `completeTodo`), so
 * the answer has to say what happened: `next` is the instance the rule opened, and
 * `skipped` is why it opened none — `open-instance` (the series already holds an
 * unfinished instance, and one series never holds two) or `invalid-rule` (the rule
 * cannot advance this deadline).
 *
 * `undefined` as a whole means the task carried no rule, which is the ordinary case;
 * a route answers it only for a task that repeats, so "no `repeat` key" and "no rule"
 * are the same statement and the client has nothing to explain.
 */
export interface CompletionReport {
  /** The instance the rule opened, with the deadline it was filed under. */
  readonly next?: { readonly id: string, readonly due: string }
  /** Why it opened none. */
  readonly skipped?: 'open-instance' | 'invalid-rule'
}

/**
 * One named list tasks can be filed under.
 *
 * `order` is a sort key, not an array index: a list's position is a number it
 * carries. The store keeps it DENSE and in sequence (0..n-1) — `store.ts`
 * `renumberLists` — so the snapshot array is the display sequence and a repeated
 * reorder is a no-op; a sparse number is a shape a hand edit can leave behind and
 * the reader accepts.
 */
export interface TodoList {
  readonly id: string
  readonly name: string
  readonly order: number
}

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
  /**
   * Which preset produced {@link reminderAt}, when one did.
   *
   * The two deadline presets are derived values: moving `due` has to move them, or a
   * task rescheduled to next week still rings on the old day. A `custom` instant is
   * the user's own and never moves. Absent reads as `custom` (`wire.ts`
   * {@link ReminderSource}), which is what every reminder written before this field
   * existed was.
   */
  readonly reminderSource?: ReminderSource
  /** Whether the user has dismissed or acknowledged the reminder. */
  readonly reminded?: boolean
  /**
   * Deadline, `YYYY-MM-DD` in LOCAL time, kept apart from {@link TodoItem.day}.
   *
   * The two answer different questions and must stay separate: `day` is when the
   * user wrote the task and is what the permanent `daily` counters are filed
   * under, while `due` is when it is owed and moves when the user reschedules.
   * One field cannot be both — "written today, due Friday" is the ordinary case,
   * and re-filing a moved deadline would rewrite history.
   *
   * A file written before this field existed is read with `due` filled from
   * `day` when that day is a real date, so a task upgraded from v1 normally carries
   * one. When it is absent anyway — a task built in the client, a deadline the
   * user cleared, a hand-edited row whose `day` is not a date the calendar draws —
   * read it as "as due as the day it was written" — `views.ts` does exactly that.
   * From v2 on the absence is a VALUE, never a gap to be filled on the next read.
   */
  readonly due?: string
  /**
   * Owning list id, or absent for the default list.
   *
   * Absent rather than a reserved id: the default list is not a row the user can
   * rename or delete, and an empty value keeps every pre-lists file valid without
   * a migration pass.
   */
  readonly listId?: string
  /**
   * How urgent the task is: `0` low, `1` normal, `2` high.
   *
   * Absent means the user never set one, which is NOT the same as low — a board
   * sorted by priority has to be able to place unset tasks after the numbered
   * ones instead of silently calling them low.
   */
  readonly priority?: 0 | 1 | 2
  /** Free-form detail the one-line task cannot hold. Capped by the store. */
  readonly notes?: string
  /**
   * The steps inside this task, in the user's order.
   *
   * The parent's `done` is never derived from these: the user may tick the parent
   * with steps left over ("the rest moved elsewhere"), so progress is a display
   * figure and never a second source of truth for the task itself.
   */
  readonly subtasks?: readonly Subtask[]
  /**
   * The rule that brings this task back when it is ticked.
   *
   * The next instance is derived from the deadline (falling back to `day`) at
   * completion time, so there is no scheduler to miss a run while the app is
   * closed and no compensation pass to design.
   */
  readonly repeat?: RepeatRule
  /**
   * Shared by every instance one `repeat` rule generated.
   *
   * It is what keeps a series from holding two open instances at once. Absent for
   * a one-off task.
   */
  readonly seriesId?: string
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
  /** `2` since deadlines, lists and the task fields above. `normalize()` still reads a v1 file. */
  readonly version: 2
  readonly items: readonly TodoItem[]
  /** Keyed `YYYY-MM-DD`, local time. Permanent: this is the statistics layer. */
  readonly daily: Readonly<Record<string, TodoDayStat>>
  /**
   * The user's own lists, unordered — read `order` for the display sequence.
   *
   * The default list is not a row here; see {@link TodoItem.listId}.
   */
  readonly lists: readonly TodoList[]
}

/** What every route answers: the whole board, so the client never merges diffs. */
export interface TodoSnapshot {
  /** The host's "today", so a clock-skewed client does not draw the wrong column. */
  readonly today: string
  readonly items: readonly TodoItem[]
  readonly daily: Readonly<Record<string, TodoDayStat>>
  /** The lists this snapshot's items can be filed under. */
  readonly lists: readonly TodoList[]
}

/**
 * What a batch answered, row by row.
 *
 * `failed` carries a stable code (`task-not-found`, `list-not-found`) and never
 * prose: the client maps it to its own dictionary. A refused row does not undo the
 * rows that already landed — the whole point of the shape is that one stale id in a
 * selection of forty applies the other thirty-nine.
 *
 * A `done` row carries `repeat` when that row COMPLETED A REPEATING TASK: a batch of
 * forty completions can open forty successors and skip some, and a single summary on
 * the answer could not say which. Absent means "this row had no rule".
 */
export interface BatchOutcome {
  readonly done: readonly { readonly id: string, readonly repeat?: CompletionReport }[]
  readonly failed: readonly { readonly id: string, readonly code: string }[]
}
