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
 * The file is v2. A v1 file is read without loss and copied to
 * {@link V1_BACKUP} before anything can overwrite it, so a rollback to the
 * previous build has the exact bytes it wrote — or, when that copy cannot be
 * written, the anchor keeps whatever it held and the failure is reported.
 *
 * @module @dsh-app/plugin-todo/store
 */

import { randomBytes } from 'node:crypto'
// The default export is read for ONE call — `renameInto` below, which a suite
// replaces. Everything else uses the named imports, the suite's usual style.
import fs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** How many days of FINISHED tasks stay in the detail list. */
export const DETAIL_DAYS = 90

/** The copy a pre-v2 file is kept as, beside the store. */
export const V1_BACKUP = 'todos.v1.bak.json'

/** Longest note kept, in characters: enough for a pasted paragraph, not a document. */
export const MAX_NOTES = 2_000

/**
 * Most steps one task holds.
 *
 * Bounded on purpose: the steps live INSIDE their task, so the whole checklist —
 * ids, text and flags — travels in every snapshot, and a task with a hundred steps
 * makes every route answer that much larger. Twenty steps is more than a task a
 * person does in one sitting needs and keeps one snapshot small.
 */
export const MAX_SUBTASKS = 20

/**
 * Longest step text kept, in characters.
 *
 * A step is one line of a checklist, not a note: the 500-character task limit is for
 * the line the board draws in full, and a step is indented under it.
 */
export const MAX_SUBTASK_TEXT = 200

/**
 * Longest list name kept, in characters.
 *
 * A list name is a rail entry, not a sentence: forty characters fit one line at the
 * narrowest rail width the board's own styles allow, and a cap is what keeps the
 * route from storing a paragraph a user cannot read back.
 */
export const MAX_LIST_NAME = 40

/** The frequencies a {@link RepeatRule} may name. */
const REPEAT_FREQS = ['daily', 'weekly', 'monthly', 'yearly', 'weekday'] as const

// The stored shapes live in `wire.ts`, because the browser half needs them too and
// must not import this module (it pulls `node:fs`). Imported for local use and
// re-exported so the host half keeps reading them from the store.
import type { RepeatRule, ReminderSource, Subtask, TodoDayStat, TodoFile, TodoItem, TodoList } from './wire.ts'
export type { RepeatRule, ReminderSource, Subtask, TodoDayStat, TodoFile, TodoItem, TodoList } from './wire.ts'
import { MAX_REPEAT_INTERVAL } from './wire.ts'
import { advanceDue, dueDay, presetReminderAt } from './views.ts'

/** An empty store. */
export function emptyTodos(): TodoFile {
  return { version: 2, items: [], daily: {}, lists: [] }
}

/** The store's directory. */
export function todoDir(home: string = resolveDshHome()): string {
  return join(home, 'storages', 'dsh-app-plugin-todo')
}

/** The store's file. */
export function todoFile(home: string = resolveDshHome()): string {
  return join(todoDir(home), 'todos.json')
}

/** Where the pre-v2 copy of the store is kept. */
export function v1BackupFile(home: string = resolveDshHome()): string {
  return join(todoDir(home), V1_BACKUP)
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
 * A file that is not already v2 also gets a byte copy at {@link V1_BACKUP}. This
 * read is the first moment the store learns it is old, and the copy has to exist
 * before any write can replace the file — a read-only session therefore leaves a
 * backup beside a file it did not change, which is harmless (it is a copy of what
 * is still there) and is the price of never being one write behind.
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
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
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
  const legacy = isLegacy(parsed)
  if (legacy) keepV1Backup(path, log)
  return normalize(parsed, legacy)
}

/**
 * Whether a parsed value is the pre-v2 shape that needs a rollback copy.
 *
 * `version: 1` is the only version written before this one; a file with no
 * `version` at all is the same data with a hand edit that dropped the line. Any
 * other value is not this store's history — a `version: 3` from a newer build, or
 * the string `"2"` — and copying it to `todos.v1.bak.json` would mislabel it as a
 * v1 rollback point.
 */
function isLegacy(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const version = (value as { version?: unknown }).version
  return version === 1 || version === undefined
}

/**
 * Keep {@link V1_BACKUP} equal to the exact bytes of the file being upgraded.
 *
 * Two failures this shape is built against, both observed on a real store:
 *
 * - A copy written straight to the anchor is visible to another process while it
 *   is half written, so an observer (a backup tool, the next start after a crash)
 *   can read an empty or truncated rollback point. The bytes are staged under a
 *   unique name and renamed into place, the way {@link saveTodos} publishes the
 *   store itself.
 * - An anchor that is empty, truncated or not JSON is a broken rollback point that
 *   nobody notices until the day they need it, so it is rebuilt from the file in
 *   front of us and reported.
 *
 * The anchor tracks the CURRENT pre-v2 bytes, not the first ones ever seen: after a
 * rollback the old build keeps writing v1, and an anchor left over from the
 * previous upgrade would restore a file missing everything the user did in
 * between.
 *
 * What that trades away, stated so nobody reads the anchor as more than it is: a
 * v1 file that still PARSES but is damaged (a hand edit that lost a task) replaces
 * the last good anchor on the next upgrade. The alternative — never overwrite an
 * anchor that parses — protects the last good bytes but loses every task written
 * during a rollback, which is the case the paragraph above chose.
 *
 * A copy that cannot be written leaves the file it was copying from untouched and
 * keeps whatever the anchor held (which may be stale); the warning says so. It is
 * not silently "repaired" later, because by then the store is v2 and no code path
 * looks at v1 again.
 */
function keepV1Backup(path: string, log: (message: string) => void): void {
  const backup = join(dirname(path), V1_BACKUP)
  let current: Buffer
  try {
    current = readFileSync(path)
  } catch (error) {
    log(`todo: could not read ${path} to keep the pre-v2 copy: ${String(error)}`)
    return
  }
  let corrupt = false
  if (existsSync(backup)) {
    let existing: Buffer | null = null
    try {
      existing = readFileSync(backup)
    } catch {
      existing = null
    }
    if (existing !== null && existing.equals(current)) return
    corrupt = existing === null || !parsesAsJson(existing)
  }
  try {
    publish(backup, current)
  } catch (error) {
    log(`todo: could not keep the pre-v2 copy at ${backup}: ${String(error)}`)
    return
  }
  log(corrupt
    ? `todo: the pre-v2 copy at ${backup} was empty or not valid JSON; rebuilt it from ${path}`
    : `todo: kept the pre-v2 file as ${backup}`)
}

/** Whether a buffer is a complete JSON document. */
function parsesAsJson(data: Buffer): boolean {
  try {
    JSON.parse(data.toString('utf8'))
    return true
  } catch {
    return false
  }
}

/**
 * Remove one staged file, and only that file.
 *
 * `unlinkSync`, not `rmSync`: this store never deletes a directory, and the link
 * form is the one shape that can be talked into following a junction out of the
 * tree — `test/recursive-delete-guard.test.mjs` audits every sync recursive
 * delete for exactly that reason. An absent file is the expected case (a rename
 * that failed may already have taken the staging name), so ENOENT is swallowed;
 * every other fault propagates, because a failed cleanup must not replace the
 * write error the caller is about to see.
 */
function discardStaged(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
}

/**
 * Write `data` to `path` so no reader ever sees a partial file.
 *
 * Staged under a unique name, then renamed over the destination in ONE step. The
 * rename REPLACES an existing file — measured, not assumed: on this machine's
 * Node 24 / Windows `renameSync` onto an existing file succeeds and replaces its
 * bytes, and {@link saveTodos} has always depended on that. Deleting the old file
 * first is therefore not a prerequisite but a hazard: whatever stops the rename (the
 * destination held open by another process without delete sharing, which surfaces as
 * EPERM or EBUSY, is the one observed on a real store) leaves the previous bytes
 * exactly where they were — but only if nothing unlinked them first.
 *
 * Hence the rule: a publish never unlinks its destination. A failed publish leaves
 * the old bytes in place, a destination that was absent stays absent, and only the
 * staged copy is discarded.
 */
function publish(path: string, data: string | Buffer): void {
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  try {
    renameInto(tmp, path)
  } catch (error) {
    discardStaged(tmp)
    throw error
  }
}

/**
 * The rename a publish is made of, read through `fs` at CALL time.
 *
 * One indirection, for one reason: the failing case this rule is about — a rename
 * that breaks while the destination is still deletable — is not one a fixture can
 * build. The faults that stop a rename (above) stop a delete of the same path too,
 * which is exactly why the old delete-first version looked fine until the delete
 * succeeded and the rename did not. So `tests/migration.test.ts` replaces the
 * rename instead. A named `renameSync` import would be snapshotted when the module
 * links and the replacement invisible; the default export's property is read on
 * every call.
 */
function renameInto(from: string, to: string): void {
  fs.renameSync(from, to)
}

/**
 * Validate one parsed value into a {@link TodoFile}.
 *
 * Every field is checked because the file is user-editable: a hand-edited `items`
 * entry without an `id` would otherwise reach the toggle path and match nothing, and
 * a `daily` value of `null` would make the statistics read `undefined`.
 *
 * A v1 file is read as v2 with the defaults the version added: `lists` empty and
 * every task's `due` taken from its `day` when that day is a real date. That
 * fallback is for the LEGACY shape only, and the distinction is the whole point:
 * from v2 on, an absent `due` MEANS "no deadline" (`wire.ts` `TodoItem.due`), so
 * filling one in would erase a state the file can now express. A malformed NEW
 * field falls back the same way rather than dropping the task — one bad
 * `priority` must not cost the user the row it sits on.
 *
 * @param value - parsed JSON.
 * @param legacy - whether `value` is the pre-v2 shape (`isLegacy`).
 * @returns a store with only the valid rows.
 */
function normalize(value: unknown, legacy: boolean): TodoFile {
  if (typeof value !== 'object' || value === null) return emptyTodos()
  const record = value as { items?: unknown, daily?: unknown, lists?: unknown }
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
      // A v1 row has no deadline axis, so it gets one: "due the day it was
      // written". The fallback goes through the calendar check because `day` is
      // only shape-checked above (an unchanged rule) and `2026-02-31` matches the
      // shape — copying it into `due` would hand every reader a deadline
      // `validDay` itself refuses, so such a row keeps none and `views.ts` reads it
      // as due on its `day`. A v2 row is never backfilled, not even from a
      // malformed `due`: absent is a real answer there, and a garbage deadline is
      // better dropped than silently rescheduled to the creation day.
      const due = validDay(row.due) ?? (legacy ? validDay(row.day) : null) ?? undefined
      const notes = typeof row.notes === 'string' && row.notes.trim() !== '' && row.notes.length <= MAX_NOTES
        ? row.notes
        : undefined
      const subtasks = normalizeSubtasks(row.subtasks)
      const repeat = normalizeRepeat(row.repeat)
      const priority = validPriority(row.priority)
      const reminderAt = typeof row.reminderAt === 'number' ? row.reminderAt : undefined
      items.push({
        id: row.id,
        text: row.text,
        day: row.day,
        createdAt: row.createdAt,
        done: row.done,
        ...(typeof row.doneAt === 'number' ? { doneAt: row.doneAt } : {}),
        ...(reminderAt === undefined ? {} : { reminderAt }),
        // A source without an armed reminder means nothing, and an absent source
        // under one means `custom` — the value every reminder written before this
        // field existed had. Written out explicitly so the file says which of the
        // two it is instead of leaving the reader to infer it (`wire.ts`
        // `ReminderSource`).
        ...(reminderAt === undefined ? {} : { reminderSource: validReminderSource(row.reminderSource) ?? 'custom' }),
        ...(typeof row.reminded === 'boolean' ? { reminded: row.reminded } : {}),
        ...(due === undefined ? {} : { due }),
        ...(typeof row.listId === 'string' && row.listId !== '' ? { listId: row.listId } : {}),
        ...(priority === null ? {} : { priority }),
        ...(notes === undefined ? {} : { notes }),
        ...(subtasks === undefined ? {} : { subtasks }),
        ...(repeat === undefined ? {} : { repeat }),
        ...(typeof row.seriesId === 'string' && row.seriesId !== '' ? { seriesId: row.seriesId } : {}),
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
  return { version: 2, items, daily, lists: normalizeLists(record.lists) }
}

/**
 * `0`, `1` or `2`, or `null` when the user never set a priority.
 *
 * A priority outside that range is "unset", not a clamped guess: the caller that
 * reads a hand-edited `9` has no way to know whether the user meant high or made a
 * typo, and every reader already treats absent as "no priority".
 *
 * @param value - a candidate from the file or from a request body.
 * @returns the priority, or null.
 */
export function validPriority(value: unknown): 0 | 1 | 2 | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value === 0 || value === 1 || value === 2 ? value : null
}

/** The valid steps, or `undefined` when the task carries none. */
function normalizeSubtasks(value: unknown): Subtask[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Subtask[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Partial<Subtask>
    if (typeof row.id !== 'string' || row.id === '') continue
    if (typeof row.text !== 'string') continue
    // Step ids inside one task are unique — the store's own invariant
    // (`addSubtask`). A hand edit that repeats one would leave the second row
    // unreachable, because every mutator finds a step by id and takes the first, so
    // the repeat is dropped here rather than kept as a row nothing can edit.
    if (out.some(step => step.id === row.id)) continue
    out.push({ id: row.id, text: row.text, done: row.done === true })
  }
  return out.length === 0 ? undefined : out
}

/**
 * A usable repeat rule, or `null`.
 *
 * One reader for the file, the edit route and the edit tool, because the answer is
 * a judgement about what the rule MEANS and two readers would drift. An unknown
 * `freq` is no rule rather than a guessed cadence — the wrong rhythm creates tasks
 * the user never asked for. A MISSING `interval` is one unit, which is what a
 * hand-written `{ "freq": "weekly" }` means. An interval that is PRESENT and
 * unusable (`0`, `-1`, `1.5`) is no rule either: reading it as one unit would turn a
 * typo into a cadence, and `advanceDue` refuses such a rule anyway, so keeping it
 * would only promise a repeat that never comes.
 *
 * An interval ABOVE {@link MAX_REPEAT_INTERVAL} is dropped for the same reason plus
 * a sharper one: the advancer WALKS the units one at a time, so a stored `1e9` is a
 * host request that never answers. The cap is enforced on the way in (the route and
 * the editor both read this) and on the way out of the file, so a hand-edited rule
 * cannot reach the walk.
 *
 * @param value - a candidate from the file, a request body or a tool argument.
 * @returns the rule, or null when it is not one.
 */
export function validRepeat(value: unknown): RepeatRule | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as { freq?: unknown, interval?: unknown }
  const freq = REPEAT_FREQS.find(candidate => candidate === row.freq)
  if (freq === undefined) return null
  if (row.interval === undefined) return { freq, interval: 1 }
  if (typeof row.interval !== 'number' || !Number.isInteger(row.interval) || row.interval < 1) return null
  if (row.interval > MAX_REPEAT_INTERVAL) return null
  return { freq, interval: row.interval }
}

/** A file field's rule, or `undefined` when it carries none ({@link validRepeat}). */
function normalizeRepeat(value: unknown): RepeatRule | undefined {
  return validRepeat(value) ?? undefined
}

/**
 * The valid lists, sorted into their display sequence and ranked dense.
 *
 * Sorted by `order` (a stable sort, so rows sharing a rank — which only a hand
 * edit can produce — keep their file order), then renumbered by
 * {@link renumberLists}. So `file.lists` is the display sequence everywhere, and no
 * reader has to sort it again. Names are trimmed: a hand-edited `" Work"` must not
 * become a second `Work` that {@link listNameTaken} cannot see.
 */
function normalizeLists(value: unknown): TodoList[] {
  if (!Array.isArray(value)) return []
  const out: TodoList[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Partial<TodoList>
    if (typeof row.id !== 'string' || row.id === '') continue
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (name === '') continue
    const order = typeof row.order === 'number' && Number.isFinite(row.order) ? Math.floor(row.order) : out.length
    out.push({ id: row.id, name, order })
  }
  out.sort((left, right) => left.order - right.order)
  return [...renumberLists(out)]
}

/**
 * Renumber `order` to the display rank.
 *
 * `order` is a sort key, never an array index in the file — but the store keeps it
 * DENSE and in sequence (0..n-1), because two rows sharing a rank would make the
 * display order depend on file order, and a dense rank is what makes applying the
 * same reorder twice a byte-identical no-op. A hand-edited sparse key is accepted
 * on read and renumbered here.
 *
 * @returns the same array when the ranks are already dense and in sequence.
 */
function renumberLists(lists: readonly TodoList[]): readonly TodoList[] {
  if (lists.every((list, index) => list.order === index)) return lists
  return lists.map((list, index) => ({ ...list, order: index }))
}

/**
 * Write the file atomically, through the same publish the rollback anchor uses.
 * @param home - the `$DSH_HOME` to write under.
 * @param file - the store to persist.
 */
export function saveTodos(home: string, file: TodoFile): void {
  const path = todoFile(home)
  mkdirSync(dirname(path), { recursive: true })
  publish(path, `${JSON.stringify(file, null, 2)}\n`)
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

/**
 * A list name as the user typed it, or `null` when the rail cannot draw it.
 *
 * Trimmed, and at most {@link MAX_LIST_NAME} characters. Trimmed because the rail
 * shows one line and two names differing only by padding read as a duplicate the
 * user cannot see — and a stored `" Work"` would be a second `Work` the duplicate
 * check (which compares trimmed) would refuse to create, so the store must not
 * create one either. Not sanitised for markup: the name is rendered as text.
 *
 * @param value - a candidate from a request body.
 * @returns the trimmed name, or null.
 */
export function validListName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_LIST_NAME) return null
  return trimmed
}

/**
 * What a task may be created with besides its line.
 *
 * Absent means "the default the composer gets": no list (the default list), no
 * priority, no steps, and a deadline equal to the day the task is written. Each
 * value is expected to be already validated by the caller — the store's mutators
 * stay total and the route and the tool are where a bad shape becomes a refusal.
 */
export interface NewTaskFields {
  /** Deadline, replacing the "due the day it is written" default. */
  readonly due?: string
  readonly listId?: string
  readonly priority?: 0 | 1 | 2
  /** The steps, in the user's order, with ids already minted by the caller. */
  readonly subtasks?: readonly Subtask[]
}

/**
 * Append a task and count it against `day`.
 *
 * `due` starts equal to `day`, the same default a v1 file is read with: a task
 * added from the composer is owed the day it was written until the user says
 * otherwise, and that keeps one invariant for every reader (a task always has a
 * deadline to compare against). {@link NewTaskFields.due} overrides it for a task
 * written today and owed on Friday, which is the case the two fields exist for.
 */
export function addTodo(
  file: TodoFile,
  text: string,
  now: number,
  id: string,
  day: string = dayKey(now),
  reminderAt?: number,
  fields: NewTaskFields = {},
): { file: TodoFile, item: TodoItem } {
  const item: TodoItem = {
    id,
    text,
    day,
    createdAt: now,
    done: false,
    due: fields.due ?? day,
    ...(fields.listId === undefined ? {} : { listId: fields.listId }),
    ...(fields.priority === undefined ? {} : { priority: fields.priority }),
    ...(fields.subtasks === undefined ? {} : { subtasks: fields.subtasks }),
    ...(typeof reminderAt === 'number' ? { reminderAt, reminded: false } : {}),
  }
  return {
    item,
    file: { ...file, items: [...file.items, item], daily: bump(file.daily, day, 'created', 1) },
  }
}

/**
 * Set, snooze, mark or clear a task's reminder.
 *
 * THREE transitions, because a caller asks for three different things:
 *
 * - a time given — set it (or snooze to it), and the reminder is armed again. The
 *   SOURCE travels with it: a time the editor derived from the deadline has to say
 *   so, or moving the deadline later would leave it behind (see
 *   {@link retimeDueReminder}). Anything that picks an instant by hand — the row's
 *   picker, a snooze, the toast — passes the default and is therefore `custom`.
 * - no time, `reminded: true` — it RANG and the user closed the notice: keep the
 *   reminder on the task and record that it was seen. This is the transition the
 *   toast's close button asks for, and treating it as "clear" deleted the reminder
 *   the user had set;
 * - no time, no flag — clear it, which is what the picker's 清除 asks for. The source
 *   goes with the instant: it describes a reminder, and there is none left.
 *
 * @param file - the store.
 * @param id - the task to change.
 * @param reminderAt - the instant to arm, or absent to clear.
 * @param reminded - whether the reminder has been seen.
 * @param source - which preset produced `reminderAt` ({@link ReminderSource}).
 */
export function updateReminder(
  file: TodoFile,
  id: string,
  reminderAt?: number,
  reminded: boolean = false,
  source: ReminderSource = 'custom',
): TodoFile {
  return {
    ...file,
    items: file.items.map(item => {
      if (item.id !== id) return item
      if (typeof reminderAt === 'number') {
        return { ...item, reminderAt, reminded, reminderSource: source }
      }
      if (reminded && typeof item.reminderAt === 'number') {
        return { ...item, reminded: true }
      }
      const { reminderAt: _reminderAt, reminded: _reminded, reminderSource: _source, ...rest } = item
      return rest
    }),
  }
}

/** The three sources a stored reminder may name, or `null` when it names none. */
export function validReminderSource(value: unknown): ReminderSource | null {
  return value === 'due-day' || value === 'hour-before' || value === 'custom' ? value : null
}

/**
 * Move a deadline-derived reminder along with the deadline.
 *
 * A reminder set from `due-day` or `hour-before` is a DERIVED value: it is 09:00 on
 * the deadline, or an hour before that. Reschedule the task to next week and the
 * instant has to follow, or the notice rings on the day the task is no longer owed —
 * which is exactly what "remind me before it is due" was asked to avoid. A `custom`
 * instant is the user's own choice and is never touched.
 *
 * Nothing to arm is a real answer: a deadline the calendar does not draw, one already
 * behind the clock, or no deadline at all (`views.ts` `presetReminderAt` answers
 * `undefined` for each) clears the reminder rather than leaving an instant that
 * belongs to a day the task no longer has.
 *
 * @param file - the store.
 * @param id - the task whose deadline just moved.
 * @param now - the current instant, for the "already passed" test.
 * @returns the new file, or the same one when there is nothing to re-derive.
 */
export function retimeDueReminder(file: TodoFile, id: string, now: number): TodoFile {
  return editItem(file, id, item => {
    const source = item.reminderSource
    if (source !== 'due-day' && source !== 'hour-before') return item
    const at = presetReminderAt(item.due, source, now)
    if (at === item.reminderAt) return item
    if (at === undefined) {
      const { reminderAt: _reminderAt, reminded: _reminded, reminderSource: _source, ...rest } = item
      return rest
    }
    return { ...item, reminderAt: at, reminded: false }
  })
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
  return { item: next, file: { ...file, items, daily } }
}

/**
 * Rewrite one task in place, and keep the file identical when nothing changed.
 *
 * Both halves are load-bearing: the routes answer the file they just wrote, and an
 * unchanged file is exactly what lets a batch of rows that were already in the
 * asked-for state skip the write (see `index.ts`, `POST /batch`).
 *
 * @returns the new file, or the same one when the id is unknown or the edit was a
 * no-op.
 */
function editItem(file: TodoFile, id: string, edit: (item: TodoItem) => TodoItem): TodoFile {
  const at = file.items.findIndex(item => item.id === id)
  if (at === -1) return file
  const current = file.items[at]!
  const next = edit(current)
  if (next === current) return file
  const items = [...file.items]
  items[at] = next
  return { ...file, items }
}

/**
 * File one task under a list, or back under the default list.
 *
 * `listId` absent is the DEFAULT list — not a reserved id (`wire.ts`
 * `TodoItem.listId`) — so "move to default" and "unfile" are one operation and no
 * migration ever runs for it. This is also what deleting a list does to the tasks
 * it held.
 *
 * @returns the new file, or the same one when the id is unknown.
 */
export function moveTodo(file: TodoFile, id: string, listId: string | undefined): TodoFile {
  return editItem(file, id, item => {
    if (item.listId === listId) return item
    const { listId: _listId, ...rest } = item
    return listId === undefined ? rest : { ...rest, listId }
  })
}

/**
 * Set or clear one task's priority.
 *
 * `undefined` clears it, which is a different state from `0` (low): a board sorted
 * by priority places unset tasks after the numbered ones instead of calling them
 * low (`wire.ts` `TodoItem.priority`).
 *
 * @returns the new file, or the same one when the id is unknown.
 */
export function setPriority(file: TodoFile, id: string, priority: 0 | 1 | 2 | undefined): TodoFile {
  return editItem(file, id, item => {
    if (item.priority === priority) return item
    const { priority: _priority, ...rest } = item
    return priority === undefined ? rest : { ...rest, priority }
  })
}

/**
 * Set or clear one task's deadline.
 *
 * The caller has already validated `due` with {@link validDay}: an impossible date
 * never reaches here, because storing one would put the task in no view at all
 * (`views.ts` compares day keys as strings).
 *
 * @returns the new file, or the same one when the id is unknown.
 */
export function setDue(file: TodoFile, id: string, due: string | undefined): TodoFile {
  return editItem(file, id, item => {
    if (item.due === due) return item
    const { due: _due, ...rest } = item
    return due === undefined ? rest : { ...rest, due }
  })
}

/**
 * One task's fields, as an edit asks for them.
 *
 * THE PRESENCE OF A KEY IS THE INSTRUCTION, which is why every field is optional
 * and clearing one is expressed by PRESENT WITH `undefined` rather than by
 * omitting it: a caller that cannot say "set this to nothing" cannot express the
 * two states the file already distinguishes (a task with no deadline and a task
 * owed today are different rows). `text` has no clear state — a task line is
 * required — so it is only ever set.
 */
export interface TodoEdit {
  readonly text?: string
  readonly due?: string | undefined
  readonly listId?: string | undefined
  readonly priority?: 0 | 1 | 2 | undefined
  readonly notes?: string | undefined
  readonly repeat?: RepeatRule | undefined
}

/** A {@link TodoItem} with its fields writable, for one copy-and-set pass. */
type MutableItem = { -readonly [K in keyof TodoItem]: TodoItem[K] }

/**
 * Rewrite several of one task's fields in ONE pass, and keep the file identical
 * when nothing changed.
 *
 * One pass rather than a chain of single-field mutators, because the chain writes
 * a file per field and a request that changes three fields should land once: the
 * routes answer the file they wrote, and a half-applied edit is a state the user
 * never asked for. The no-op answer is what lets the route skip the write.
 *
 * @param file - the store.
 * @param id - the task to edit.
 * @param edit - the fields to set, or clear.
 * @returns the new file, or the same one when the id is unknown or nothing changed.
 */
export function applyEdit(file: TodoFile, id: string, edit: TodoEdit): TodoFile {
  return editItem(file, id, item => {
    const next: MutableItem = { ...item }
    let changed = false
    if (edit.text !== undefined && next.text !== edit.text) {
      next.text = edit.text
      changed = true
    }
    if ('due' in edit) {
      if (edit.due === undefined) {
        if (next.due !== undefined) {
          delete next.due
          changed = true
        }
      } else if (next.due !== edit.due) {
        next.due = edit.due
        changed = true
      }
    }
    if ('listId' in edit) {
      if (edit.listId === undefined) {
        if (next.listId !== undefined) {
          delete next.listId
          changed = true
        }
      } else if (next.listId !== edit.listId) {
        next.listId = edit.listId
        changed = true
      }
    }
    if ('priority' in edit) {
      if (edit.priority === undefined) {
        if (next.priority !== undefined) {
          delete next.priority
          changed = true
        }
      } else if (next.priority !== edit.priority) {
        next.priority = edit.priority
        changed = true
      }
    }
    if ('notes' in edit) {
      if (edit.notes === undefined) {
        if (next.notes !== undefined) {
          delete next.notes
          changed = true
        }
      } else if (next.notes !== edit.notes) {
        next.notes = edit.notes
        changed = true
      }
    }
    if ('repeat' in edit) {
      const rule = edit.repeat ?? undefined
      const current = next.repeat
      const same = rule === undefined
        ? current === undefined
        : current !== undefined && current.freq === rule.freq && current.interval === rule.interval
      if (!same) {
        if (rule === undefined) delete next.repeat
        else next.repeat = rule
        changed = true
      }
    }
    return changed ? next : item
  })
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
  return { ...file, items, daily: bump(file.daily, target.day, 'created', -1) }
}

/**
 * A step's text as the checklist can draw it, or `null`.
 *
 * Trimmed, because a stored `"  find it"` and `"find it"` read as the same line and
 * the second would look like a duplicate the board cannot show; capped at
 * {@link MAX_SUBTASK_TEXT}, because a step is a line.
 *
 * @param value - a candidate from a request body.
 * @returns the trimmed text, or null.
 */
export function validSubtaskText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SUBTASK_TEXT) return null
  return trimmed
}

/**
 * Append one step to a task.
 *
 * Three refusals: the task is gone, the task already holds {@link MAX_SUBTASKS}
 * steps, or `id` is already used under that task. Only the first two reach a caller
 * with a minted UUID; the third is this store's own invariant — step ids inside one
 * task are unique, because every mutator below addresses a step BY ID and two rows
 * sharing one would make the second unreachable. Refusing keeps a hand-called write
 * from breaking that.
 *
 * @param file - the store.
 * @param taskId - the task to add to.
 * @param text - an already-validated step ({@link validSubtaskText}).
 * @param id - the step's id.
 * @returns the new file and the step, or `undefined` when it was refused.
 */
export function addSubtask(
  file: TodoFile,
  taskId: string,
  text: string,
  id: string,
): { file: TodoFile, subtask: Subtask } | undefined {
  const target = file.items.find(item => item.id === taskId)
  if (target === undefined) return undefined
  const current = target.subtasks ?? []
  if (current.length >= MAX_SUBTASKS) return undefined
  if (current.some(step => step.id === id)) return undefined
  const subtask: Subtask = { id, text, done: false }
  const next = editItem(file, taskId, item => ({ ...item, subtasks: [...(item.subtasks ?? []), subtask] }))
  return { file: next, subtask }
}

/**
 * Rewrite one task's steps, dropping the field when it ends up empty.
 *
 * `subtasks` ABSENT is how a task with no steps is stored everywhere else
 * (`normalizeSubtasks` drops an empty array), so removing the last step must not
 * leave `subtasks: []` behind: that is a second way to say "no steps", and a file
 * that reads differently from the one it was copied out of.
 */
function editSubtasks(
  file: TodoFile,
  taskId: string,
  edit: (steps: readonly Subtask[]) => readonly Subtask[],
): TodoFile {
  return editItem(file, taskId, item => {
    const current = item.subtasks ?? []
    const next = edit(current)
    if (next === current) return item
    const { subtasks: _subtasks, ...rest } = item
    return next.length === 0 ? rest : { ...rest, subtasks: next }
  })
}

/**
 * Remove one step. A no-op when the task or the step is gone — the mutators stay
 * total, and the route is where "no such step" becomes a 404.
 */
export function removeSubtask(file: TodoFile, taskId: string, subtaskId: string): TodoFile {
  return editSubtasks(file, taskId, steps => (
    steps.some(step => step.id === subtaskId) ? steps.filter(step => step.id !== subtaskId) : steps
  ))
}

/**
 * Replace one step's text. Its id, its flag and its position stay put.
 * @param text - an already-validated step ({@link validSubtaskText}).
 */
export function renameSubtask(file: TodoFile, taskId: string, subtaskId: string, text: string): TodoFile {
  return editSubtasks(file, taskId, steps => {
    const at = steps.findIndex(step => step.id === subtaskId)
    if (at === -1) return steps
    if (steps[at]!.text === text) return steps
    const next = [...steps]
    next[at] = { ...steps[at]!, text }
    return next
  })
}

/**
 * Tick or untick one step.
 *
 * NEITHER DIRECTION TOUCHES THE PARENT: ticking every step does not tick the task
 * ("the rest moved elsewhere" is a real answer), and ticking the task does not tick
 * its steps ({@link setDone} leaves them alone). Progress is a display figure
 * (`views.ts` `subtaskProgress`), never a second source of truth.
 */
export function setSubtaskDone(file: TodoFile, taskId: string, subtaskId: string, done: boolean): TodoFile {
  return editSubtasks(file, taskId, steps => {
    const at = steps.findIndex(step => step.id === subtaskId)
    if (at === -1 || steps[at]!.done === done) return steps
    const next = [...steps]
    next[at] = { ...steps[at]!, done }
    return next
  })
}

/** The ids one completion may mint. */
export interface CompletionIds {
  /** Id for the instance a repeat rule opens. */
  readonly task: string
  /** Series id, used only when the finished task does not carry one yet. */
  readonly series: string
}

/**
 * What completing one task did, including the instance a repeat rule opened.
 *
 * The completion time is the only trigger: there is no scheduler to miss a run while
 * the app is closed and no compensation pass for a day the app never started
 * (`docs/plans/workbench-todo-upgrade.md` ruled the timer out). `skipped` is what
 * makes a refusal reportable rather than silent.
 */
export interface Completion {
  readonly file: TodoFile
  /** The ticked task, carrying the `seriesId` of the series it belongs to. */
  readonly item: TodoItem
  /** The open instance the rule opened, when it opened one. */
  readonly next?: TodoItem
  /**
   * Why a repeating task opened no next instance.
   *
   * `open-instance` — the series already holds an open instance, and one series
   * never holds two (`wire.ts` `TodoItem.seriesId`).
   * `invalid-rule` — the rule cannot advance this deadline: an interval that is not
   * a whole positive number of units, or a deadline the calendar does not draw.
   */
  readonly skipped?: 'open-instance' | 'invalid-rule'
}

/**
 * Complete one task and, when it carries a repeat rule, open its next instance.
 *
 * The next instance is a NEW open task whose deadline comes from
 * `advanceDue(dueDay(task), rule)` — the deadline, or the creation day when there is
 * none, which is the same axis every view reads. It inherits the text, the list, the
 * priority, the notes, the checklist (UNCHECKED: redoing the steps is the point of a
 * routine) and the series; it does NOT inherit the reminder, whose timestamp belongs
 * to the occurrence that just rang and would ring the new one at once. Its `day` is
 * today, so the permanent `created` counter records that the series wrote a task now.
 *
 * Two guards keep one series from multiplying:
 *
 * - a retried completion does not advance it. `setDone` answers the same file it was
 *   given when the task was already done, and a repeat advances only when the file
 *   changed — otherwise every resent request would mint another instance.
 * - a series that already holds an open instance stays open once; the completion is
 *   recorded and `skipped: 'open-instance'` says so.
 *
 * The finished task joins the series even when nothing is opened, so the chain is one
 * series: unticking it afterwards leaves an open instance the duplicate check sees.
 *
 * One gap is left open here on purpose. Unticking the instance that was just
 * completed leaves its generated successor open as well, so that series holds two
 * open rows until one of them is closed — after which the check above refuses the
 * next generation. The alternative, deleting the successor on untick, cannot be done
 * safely: the store cannot tell a generated instance the user has not touched from
 * one they have already edited, and silently destroying work to restore an invariant
 * is worse than a duplicate the user can see and remove.
 *
 * @param file - the store.
 * @param id - the task to complete.
 * @param now - the completion instant.
 * @param ids - the ids this completion may mint.
 * @returns the outcome, or `undefined` when the id is unknown.
 */
export function completeTodo(file: TodoFile, id: string, now: number, ids: CompletionIds): Completion | undefined {
  const step = setDone(file, id, true, now)
  if (step === undefined) return undefined
  const rule = step.item.repeat
  if (rule === undefined) return { file: step.file, item: step.item }
  // `setDone` returns the file it was handed when the state already matched, which
  // is exactly the "this call did not tick it" signal.
  if (step.file === file) return { file: step.file, item: step.item }
  const seriesId = step.item.seriesId ?? ids.series
  const item: TodoItem = step.item.seriesId === undefined ? { ...step.item, seriesId } : step.item
  const ticked = item === step.item ? step.file : editItem(step.file, id, () => item)
  const due = advanceDue(dueDay(item), rule)
  if (due === undefined) return { file: ticked, item, skipped: 'invalid-rule' }
  if (ticked.items.some(other => other.seriesId === seriesId && !other.done)) {
    return { file: ticked, item, skipped: 'open-instance' }
  }
  const subtasks = item.subtasks?.map(entry => ({ id: entry.id, text: entry.text, done: false }))
  const day = dayKey(now)
  const next: TodoItem = {
    id: ids.task,
    text: item.text,
    day,
    createdAt: now,
    done: false,
    due,
    ...(item.listId === undefined ? {} : { listId: item.listId }),
    ...(item.priority === undefined ? {} : { priority: item.priority }),
    ...(item.notes === undefined ? {} : { notes: item.notes }),
    ...(subtasks === undefined ? {} : { subtasks }),
    repeat: rule,
    seriesId,
  }
  return {
    file: { ...ticked, items: [...ticked.items, next], daily: bump(ticked.daily, day, 'created', 1) },
    item,
    next,
  }
}

/**
 * Append a list at the end of the rail.
 * @param file - the store.
 * @param name - an already-validated name ({@link validListName}).
 * @param id - the new list's id.
 * @returns the new file and the row it added.
 */
export function addList(file: TodoFile, name: string, id: string): { file: TodoFile, list: TodoList } {
  const list: TodoList = { id, name, order: file.lists.length }
  return { list, file: { ...file, lists: [...renumberLists([...file.lists, list])] } }
}

/**
 * Rename one list. Its position, its tasks and their `listId` stay put.
 *
 * A no-op when no list has that id — the mutators stay total, and the route is where
 * "no such list" becomes a 404.
 */
export function renameList(file: TodoFile, id: string, name: string): TodoFile {
  if (!file.lists.some(list => list.id === id)) return file
  return { ...file, lists: file.lists.map(list => (list.id === id ? { ...list, name } : list)) }
}

/**
 * Whether a name is already a list's, ignoring `exceptId`.
 *
 * Compared case-insensitively: "Work" and "work" are the same rail entry to a
 * reader, and letting both exist turns every filing choice into a coin flip. (Both
 * sides arrive trimmed — names are stored and asked for through
 * {@link validListName}.) `exceptId` is what makes renaming a list to its own name a
 * no-op instead of a conflict.
 */
export function listNameTaken(file: TodoFile, name: string, exceptId?: string): boolean {
  const needle = name.toLowerCase()
  return file.lists.some(list => list.id !== exceptId && list.name.toLowerCase() === needle)
}

/**
 * One list, found by id or by name.
 *
 * Both, because the two callers know different things: an interface that just drew
 * the rail has the id, while a tool the model is typing for has the name the user
 * said out loud. The ID is tried first so a list literally named like another
 * list's id still resolves to the row whose id was asked for, and the name is
 * compared trimmed and case-insensitively — the same comparison
 * {@link listNameTaken} refuses duplicates with, so a name that created a list can
 * always find it again.
 *
 * @param file - the store.
 * @param value - a list id or a list name.
 * @returns the list, or `undefined` when neither matches (including the empty
 * string and the default list, which has no row).
 */
export function findList(file: TodoFile, value: string): TodoList | undefined {
  const needle = value.trim()
  if (needle === '') return undefined
  const byId = file.lists.find(list => list.id === needle)
  if (byId !== undefined) return byId
  const lower = needle.toLowerCase()
  return file.lists.find(list => list.name.toLowerCase() === lower)
}

/**
 * Delete one list, returning its tasks to the default list.
 *
 * THE TASKS STAY. A list is a place to file work, and deleting the place must not
 * delete the work: each task on it loses `listId` — which IS the default list
 * (`wire.ts` `TodoItem.listId`) — and keeps everything else, `due`, `done` and the
 * `daily` counters included. The remaining rows are reranked dense, so the rail has
 * no gap where the list was. A no-op when no list has that id.
 */
export function removeList(file: TodoFile, id: string): TodoFile {
  if (!file.lists.some(list => list.id === id)) return file
  const items = file.items.map(item => {
    if (item.listId !== id) return item
    const { listId: _listId, ...rest } = item
    return rest
  })
  return { ...file, items, lists: [...renumberLists(file.lists.filter(list => list.id !== id))] }
}

/**
 * Set the display sequence from an explicit order of ids.
 *
 * All of them, once each, or nothing: a short list would silently drop rows and a
 * repeat would silently drop one of them, so a caller that did not send a
 * permutation is refused instead of half-applied. Applying the same permutation
 * twice leaves the file unchanged — a dropped drag-and-drop retry is harmless.
 *
 * @returns the new file, or `undefined` when `ids` is not a permutation of the
 * lists.
 */
export function reorderLists(file: TodoFile, ids: readonly string[]): TodoFile | undefined {
  if (ids.length !== file.lists.length) return undefined
  const byId = new Map(file.lists.map(list => [list.id, list]))
  const lists: TodoList[] = []
  for (const [index, id] of ids.entries()) {
    const list = byId.get(id)
    // Deleting the id is the duplicate check: a repeated id cannot be found twice.
    if (list === undefined) return undefined
    byId.delete(id)
    lists.push({ ...list, order: index })
  }
  return { ...file, lists }
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
  return items.length === file.items.length ? file : { ...file, items }
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
