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
}

let shown: ShownReminder | undefined
let seq = 0
let lastRefresh = 0
const listeners = new Set<() => void>()

/**
 * The one task that should ring now, or undefined.
 *
 * A task is due when it is open, armed, not already seen, not dismissed in this
 * session, and its time has passed. The FIRST such task wins: a notice is a
 * single-slot surface, and queueing five would bury the one that matters.
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
  return items.find(item =>
    !item.done
    && item.reminded !== true
    && !dismissed.has(item.id)
    && typeof item.reminderAt === 'number'
    && item.reminderAt <= now,
  )
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

function setShown(item: TodoItem | undefined): void {
  if (item === undefined) {
    if (shown === undefined) return
    shown = undefined
  } else {
    seq += 1
    shown = { item, seq }
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

    const due = dueReminder(items, now, dismissed)
    if (due !== undefined) setShown(due)
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
