/**
 * The reminder watcher: who is due, and what the notice is currently showing.
 *
 * It lives at PLUGIN level, not in the page, because a reminder is meant to interrupt
 * whatever the user is doing. The page is the wrong owner on both counts: the
 * workbench container unmounts a domain page when the user leaves the panel (so a
 * watcher inside it stopped the moment a conversation was opened), and the notice it
 * rendered lived inside that page's tree (so it could not paint over a conversation
 * either).
 *
 * Three pieces, each with one job:
 *
 * - {@link dueReminder} — a pure selection over the board, so the "which one" rule is
 *   testable without a clock or a DOM.
 * - {@link startReminderWatch} — a tick that keeps the board fresh enough to answer
 *   it, and publishes the due task into the store.
 * - {@link subscribeReminder} — the store the mounted host renders from.
 *
 * The board is refreshed at most every {@link REFRESH_MS}: the file is local and
 * small, but a read every tick would be six file reads a minute for a reminder that
 * fires once a day.
 *
 * @module @dsh-app/plugin-todo/client/reminders
 */

import { applyBoard, boardState, refreshBoard } from './board.ts'
import { toggleTask, updateTaskReminder } from './api.ts'
import type { TodoItem } from '../wire.ts'

/** How often the watcher looks. */
const TICK_MS = 5_000

/** How stale the cached board may get before the watcher re-reads it. */
const REFRESH_MS = 30_000

/** Snooze length, in ms. */
export const SNOOZE_MS = 10 * 60 * 1000

/** The notice currently on screen, with the sequence that makes it re-mount. */
export interface ShownReminder {
  readonly item: TodoItem
  readonly seq: number
  /** How many OTHER reminders are waiting behind this one. */
  readonly waiting: number
}

let shown: ShownReminder | undefined
let seq = 0
let lastRefresh = 0
const listeners = new Set<() => void>()

/**
 * The one task that should ring now, or undefined.
 *
 * A task is due when it is open, armed, not already seen, not dismissed in this
 * session, and its time has passed. The EARLIEST such task wins: a notice is a
 * single-slot surface, and queueing five would bury the one that matters — the oldest
 * miss is the one the user has been ignoring longest.
 *
 * There is deliberately NO upper bound on how far in the past `reminderAt` may be.
 * That is the catch-up contract: a reminder whose time passed while the app was closed
 * still rings on the next start, however many days later, until the user acts on it
 * (done / snooze / dismiss). A window here would mean "missed while you were away" is
 * silently the same as "never set", which is the one failure a reminder cannot afford.
 *
 * @param items - the board's tasks.
 * @param now - the current epoch ms.
 * @param dismissed - ids this session has already closed.
 */
export function dueReminder(
  items: readonly TodoItem[],
  now: number,
  dismissed: ReadonlySet<string>,
): TodoItem | undefined {
  return dueReminders(items, now, dismissed)[0]
}

/**
 * Every task that should ring now, earliest first.
 *
 * The notice shows one at a time; the count is what lets it say "还有 N 条" instead of
 * letting the user believe a weekend's worth of reminders was one reminder.
 *
 * @param items - the board's tasks.
 * @param now - the current epoch ms.
 * @param dismissed - ids this session has already closed.
 * @returns the due tasks, ordered by their reminder time ascending.
 */
export function dueReminders(
  items: readonly TodoItem[],
  now: number,
  dismissed: ReadonlySet<string>,
): TodoItem[] {
  return items
    .filter(item =>
      !item.done
      && item.reminded !== true
      && !dismissed.has(item.id)
      && typeof item.reminderAt === 'number'
      && item.reminderAt <= now,
    )
    .sort((left, right) => (left.reminderAt ?? 0) - (right.reminderAt ?? 0))
}

/** How far behind the clock a reminder has to be before the notice calls it missed. */
export const LATE_GRACE_MS = 60_000

/**
 * Whether this notice is a CATCH-UP rather than an on-time ring.
 *
 * A minute of slack because the watcher ticks every five seconds and a reminder that
 * rang three seconds late is not news. Beyond that the notice says so: showing
 * "09:00" at 11:30 the next day, with no word about the day it belonged to, reads as a
 * reminder that fired on time.
 *
 * @param item - the task whose reminder is on screen.
 * @param now - the current epoch ms.
 * @param graceMs - how late is still "on time".
 * @returns whether to mark the notice as missed.
 */
export function isLateReminder(item: TodoItem, now: number, graceMs: number = LATE_GRACE_MS): boolean {
  return typeof item.reminderAt === 'number' && now - item.reminderAt > graceMs
}

/** Subscribe to the shown reminder (the `useSyncExternalStore` contract). */
export function subscribeReminder(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The reminder currently on screen (the `useSyncExternalStore` contract). */
export function shownReminder(): ShownReminder | undefined {
  return shown
}

function setShown(item: TodoItem | undefined, waiting = 0): void {
  if (item === undefined) {
    if (shown === undefined) return
    shown = undefined
  } else {
    seq += 1
    shown = { item, seq, waiting }
  }
  for (const listener of listeners) listener()
}

/** Ids closed in this session, so a closed notice does not reappear on the next tick. */
const dismissed = new Set<string>()

/**
 * Start the watcher.
 *
 * @returns the disposer that stops it.
 */
export function startReminderWatch(): () => void {
  const tick = (): void => {
    const now = Date.now()
    if (now - lastRefresh > REFRESH_MS) {
      lastRefresh = now
      void refreshBoard()
    }
    const items = boardState().snapshot?.items ?? []

    if (shown !== undefined) {
      // Keep what is on screen honest: a task finished, deleted, marked seen or
      // closed elsewhere takes its notice with it. One at a time, so nothing else
      // is published while a notice is up.
      const live = items.find(item => item.id === shown?.item.id)
      if (live === undefined || live.done || live.reminded === true || dismissed.has(live.id)) {
        setShown(undefined)
      }
      if (shown !== undefined) return
    }

    const due = dueReminders(items, now, dismissed)
    if (due.length > 0) setShown(due[0], due.length - 1)
  }
  const timer = setInterval(tick, TICK_MS)
  tick()
  return () => { clearInterval(timer) }
}

/** Close the notice for `id`, remembering it so the next tick does not re-open it. */
function close(id: string): void {
  dismissed.add(id)
  setShown(undefined)
}

/**
 * Tick the task and close the notice.
 * @param id - the task.
 */
export async function completeReminder(id: string): Promise<void> {
  close(id)
  applyBoard(await toggleTask(id, true))
}

/**
 * Push the reminder ten minutes out and close the notice.
 * @param id - the task.
 */
export async function snoozeReminder(id: string): Promise<void> {
  close(id)
  applyBoard(await updateTaskReminder(id, Date.now() + SNOOZE_MS, false))
}

/**
 * Mark the reminder as seen and close the notice.
 *
 * Seen, not cleared: closing a notice must not delete the reminder the user set —
 * that is the difference between `reminded: true` and no flag at all.
 *
 * @param id - the task.
 */
export async function dismissReminder(id: string): Promise<void> {
  close(id)
  applyBoard(await updateTaskReminder(id, undefined, true))
}
