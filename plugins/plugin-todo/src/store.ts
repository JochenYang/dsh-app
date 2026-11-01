/**
 * Todo storage.
 *
 * TWO LAYERS, deliberately. `items` is the detail — every open task plus the last
 * {@link DETAIL_DAYS} days of finished ones, which is what "what did I do
 * yesterday" needs. `daily` is a permanent per-day aggregate (`created`, `done`)
 * that the week/month/year statistics read: a year heat map needs 365 numbers, not
 * 365 days of task text, and deriving it from detail alone would keep every
 * finished task for ever.
 *
 * One file, one directory under `$DSH_HOME/storages/`, so `plugin-presets`' backup
 * carries it and a reinstall does not lose the list.
 *
 * @module @dsh-app/plugin-todo/store
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** How many days of FINISHED tasks stay in the detail list. */
export const DETAIL_DAYS = 90

// The stored shapes live in `wire.ts`, because the browser half needs them too and
// must not import this module (it pulls `node:fs`). Imported for local use and
// re-exported so the host half keeps reading them from the store.
import type { TodoDayStat, TodoFile, TodoItem } from './wire.ts'
export type { TodoDayStat, TodoFile, TodoItem } from './wire.ts'

/** An empty store. */
export function emptyTodos(): TodoFile {
  return { version: 1, items: [], daily: {} }
}

/** The store's directory. */
export function todoDir(home: string = resolveDshHome()): string {
  return join(home, 'storages', 'dsh-app-plugin-todo')
}

/** The store's file. */
export function todoFile(home: string = resolveDshHome()): string {
  return join(todoDir(home), 'todos.json')
}

/** Local-time `YYYY-MM-DD` for one instant. */
export function dayKey(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Read the file.
 *
 * A missing file is an empty list (first run). An UNREADABLE or malformed one is
 * moved aside rather than overwritten: the tasks are the user's, and a parse
 * failure must not be the moment they disappear. The caller gets an empty list and
 * the log line names the backup.
 *
 * @param home - the `$DSH_HOME` to read under.
 * @param log - diagnostic sink.
 * @returns the parsed file, or an empty one.
 */
export function loadTodos(home: string = resolveDshHome(), log: (message: string) => void = () => {}): TodoFile {
  const path = todoFile(home)
  if (!existsSync(path)) return emptyTodos()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    log(`todo: could not read ${path}: ${String(error)}`)
    return emptyTodos()
  }
  try {
    return normalize(JSON.parse(raw))
  } catch (error) {
    const backup = `${path}.broken-${String(Date.now())}`
    try {
      renameSync(path, backup)
      log(`todo: ${path} is not valid JSON; kept it as ${backup} and started empty (${String(error)})`)
    } catch {
      log(`todo: ${path} is not valid JSON and could not be moved aside: ${String(error)}`)
    }
    return emptyTodos()
  }
}

/**
 * Validate one parsed value into a {@link TodoFile}.
 *
 * Every field is checked because the file is user-editable: a hand-edited `items`
 * entry without an `id` would otherwise reach the toggle path and match nothing, and
 * a `daily` value of `null` would make the statistics read `undefined`.
 *
 * @param value - parsed JSON.
 * @returns a store with only the valid rows.
 */
function normalize(value: unknown): TodoFile {
  if (typeof value !== 'object' || value === null) return emptyTodos()
  const record = value as { items?: unknown, daily?: unknown }
  const items: TodoItem[] = []
  if (Array.isArray(record.items)) {
    for (const entry of record.items) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Partial<TodoItem>
      if (typeof row.id !== 'string' || row.id === '') continue
      if (typeof row.text !== 'string') continue
      if (typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(row.day)) continue
      if (typeof row.createdAt !== 'number') continue
      if (typeof row.done !== 'boolean') continue
      items.push({
        id: row.id,
        text: row.text,
        day: row.day,
        createdAt: row.createdAt,
        done: row.done,
        ...(typeof row.doneAt === 'number' ? { doneAt: row.doneAt } : {}),
        ...(typeof row.reminderAt === 'number' ? { reminderAt: row.reminderAt } : {}),
        ...(typeof row.reminded === 'boolean' ? { reminded: row.reminded } : {}),
      })
    }
  }
  const daily: Record<string, TodoDayStat> = {}
  if (typeof record.daily === 'object' && record.daily !== null) {
    for (const [day, stat] of Object.entries(record.daily as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) continue
      if (typeof stat !== 'object' || stat === null) continue
      const counts = stat as Partial<TodoDayStat>
      daily[day] = {
        created: typeof counts.created === 'number' && counts.created > 0 ? Math.floor(counts.created) : 0,
        done: typeof counts.done === 'number' && counts.done > 0 ? Math.floor(counts.done) : 0,
      }
    }
  }
  return { version: 1, items, daily }
}

/**
 * Write the file atomically.
 * @param home - the `$DSH_HOME` to write under.
 * @param file - the store to persist.
 */
export function saveTodos(home: string, file: TodoFile): void {
  const path = todoFile(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Add one day's count, keeping zeroes out of the map. */
function bump(daily: Readonly<Record<string, TodoDayStat>>, day: string, field: keyof TodoDayStat, delta: number): Record<string, TodoDayStat> {
  const current = daily[day] ?? { created: 0, done: 0 }
  const next = { ...current, [field]: Math.max(0, current[field] + delta) }
  const out: Record<string, TodoDayStat> = { ...daily, [day]: next }
  if (next.created === 0 && next.done === 0) delete out[day]
  return out
}

/**
 * Split one pasted line into a task text, or `null` when it is empty.
 * @param text - the caller's text.
 * @returns the trimmed text, or null.
 */
export function validText(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 500) return null
  return trimmed
}

/** Append a task and count it against `day`. */
export function addTodo(
  file: TodoFile,
  text: string,
  now: number,
  id: string,
  day: string = dayKey(now),
  reminderAt?: number,
): { file: TodoFile, item: TodoItem } {
  const item: TodoItem = {
    id,
    text,
    day,
    createdAt: now,
    done: false,
    ...(typeof reminderAt === 'number' ? { reminderAt, reminded: false } : {}),
  }
  return {
    item,
    file: {
      version: 1,
      items: [...file.items, item],
      daily: bump(file.daily, day, 'created', 1),
    },
  }
}

/**
 * Set, snooze, mark or clear a task's reminder.
 *
 * THREE transitions, because a caller asks for three different things:
 *
 * - a time given — set it (or snooze to it), and the reminder is armed again;
 * - no time, `reminded: true` — it RANG and the user closed the notice: keep the
 *   reminder on the task and record that it was seen. This is the transition the
 *   toast's close button asks for, and treating it as "clear" deleted the reminder
 *   the user had set;
 * - no time, no flag — clear it, which is what the picker's 清除 asks for.
 */
export function updateReminder(
  file: TodoFile,
  id: string,
  reminderAt?: number,
  reminded: boolean = false,
): TodoFile {
  return {
    ...file,
    items: file.items.map(item => {
      if (item.id !== id) return item
      if (typeof reminderAt === 'number') {
        return { ...item, reminderAt, reminded }
      }
      if (reminded && typeof item.reminderAt === 'number') {
        return { ...item, reminded: true }
      }
      const { reminderAt: _reminderAt, reminded: _reminded, ...rest } = item
      return rest
    }),
  }
}

/**
 * A day key a caller asked for, or `null` when it is not one.
 *
 * The round trip through a LOCAL `Date` is what rejects a date that looks right and
 * does not exist: `2026-02-31` matches the shape and normalises to 3 March, so a
 * shape check alone would file a task on a day the calendar never draws.
 *
 * @param value - a candidate from a request body or a tool argument.
 * @returns the day key, or null.
 */
export function validDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const at = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0)
  return dayKey(at.getTime()) === value ? value : null
}

/**
 * Tick or untick one task.
 *
 * The `daily` counter moves with it in BOTH directions: ticking adds to the day it
 * was ticked, unticking takes it back off that same day (not today), so a
 * toggle-twice round trip leaves the aggregate exactly where it was. That symmetry
 * is the only reason `doneAt` is kept after an untick — the caller sees it cleared,
 * the counter uses it first.
 *
 * @returns the new file and item, or `undefined` when the id is unknown.
 */
export function setDone(file: TodoFile, id: string, done: boolean, now: number): { file: TodoFile, item: TodoItem } | undefined {
  const at = file.items.findIndex(item => item.id === id)
  if (at === -1) return undefined
  const item = file.items[at]!
  if (item.done === done) return { file, item }
  const tickedDay = dayKey(item.doneAt ?? now)
  const next: TodoItem = done
    ? { ...item, done: true, doneAt: now, reminded: true }
    : { ...item, done: false, doneAt: undefined, reminded: false }
  const daily = bump(file.daily, done ? dayKey(now) : tickedDay, 'done', done ? 1 : -1)
  const items = [...file.items]
  items[at] = next
  return { item: next, file: { version: 1, items, daily } }
}

/**
 * Drop one task's detail row, and take it back off the day it was created on.
 *
 * TWO COUNTERS, two answers. `created` answers "how many tasks does that day still
 * hold", which is what the calendar cell shows beside the count — so deleting a task
 * has to take it off, or the cell says three while the card lists two. `done` is
 * untouched: finishing something is a thing that happened, and deleting the row later
 * does not un-happen it.
 *
 * @returns the new file, or the same one when the id is unknown.
 */
export function removeTodo(file: TodoFile, id: string): TodoFile {
  const target = file.items.find(item => item.id === id)
  if (target === undefined) return file
  const items = file.items.filter(item => item.id !== id)
  return { version: 1, items, daily: bump(file.daily, target.day, 'created', -1) }
}

/**
 * Drop finished tasks older than {@link DETAIL_DAYS}.
 *
 * Only the detail list: `daily` keeps the counts. Run on every write, so the file
 * cannot grow past what the view can show.
 */
export function pruneDetail(file: TodoFile, now: number): TodoFile {
  const cutoff = dayKey(now - DETAIL_DAYS * 24 * 60 * 60 * 1000)
  const items = file.items.filter(item => !item.done || dayKey(item.doneAt ?? item.createdAt) >= cutoff)
  return items.length === file.items.length ? file : { version: 1, items, daily: file.daily }
}

/**
 * One day's counts, with zeroes filled in for days the map does not carry.
 * @param file - the store.
 * @param days - `YYYY-MM-DD` keys, in the order the caller wants them.
 * @returns one stat per requested day.
 */
export function statsFor(file: TodoFile, days: readonly string[]): TodoDayStat[] {
  return days.map(day => file.daily[day] ?? { created: 0, done: 0 })
}
