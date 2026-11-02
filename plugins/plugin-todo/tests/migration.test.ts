/**
 * Behavioral tests for the v1 → v2 upgrade.
 *
 * Two things are being bought here, and neither is visible in a green type check:
 *
 * 1. A v1 file is read WITHOUT LOSS. `daily` is the permanent statistics layer —
 *    it is what the week/month/year views draw — so an upgrade that loses a day
 *    count silently rewrites the user's history. The fixture is a real v1 file,
 *    finished rows included, and every key is compared.
 * 2. The upgrade is REVERSIBLE. `todos.v1.bak.json` is the rollback anchor, and it
 *    is worth exactly as much as it is exact and complete: byte-for-byte, never
 *    half written, never left as the previous upgrade's copy.
 *
 * The malformed-field cases are here because v2 added seven fields a user can hand
 * edit. The contract is that one bad field costs that field and never the task.
 *
 * Two more belong to the same contract. Once the file is v2 an absent `due` is a
 * VALUE ("no deadline"), so the v1 backfill must not reach those rows. And the copy
 * above is published by rename: a publish that fails must leave whatever the anchor
 * held — stale or not — rather than delete it on the way to a write that never
 * happened.
 *
 * @module @dsh-app/plugin-todo/tests/migration
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
// The default export, not a named `renameSync`: the store reads the rename through
// `fs` at call time so this suite can replace it for one test (see "a publish that
// fails" below), and a named import here would be a different, snapshotted binding.
import fs from 'node:fs'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  V1_BACKUP,
  emptyTodos,
  loadTodos,
  saveTodos,
  todoDir,
  todoFile,
  v1BackupFile,
} from '../src/store.ts'

const roots: string[] = []

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A fresh `$DSH_HOME` with the store's directory already there. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshtodo-migrate-'))
  roots.push(dir)
  mkdirSync(todoDir(dir), { recursive: true })
  return dir
}

/** One row of a v1 file, as the shipped build wrote it. */
interface V1Row {
  readonly id: string
  readonly text: string
  readonly day: string
  readonly createdAt: number
  readonly done: boolean
  readonly doneAt?: number
  readonly reminderAt?: number
  readonly reminded?: boolean
  /** Only a hand edit (or a newer build's file) puts a v2 deadline on a v1 row. */
  readonly due?: string
}

/** The day counts of the v1 fixture, kept apart so the assertions can name them. */
const V1_DAILY = {
  '2026-05-02': { created: 1, done: 0 },
  '2026-05-03': { created: 1, done: 1 },
  '2026-05-04': { created: 1, done: 0 },
}

/** Three tasks: one open, one finished, one carrying a reminder. */
const V1_ROWS: readonly V1Row[] = [
  { id: 'open', text: 'water the plants', day: '2026-05-04', createdAt: 1_777_000_000_000, done: false },
  { id: 'ticked', text: 'ship the release', day: '2026-05-03', createdAt: 1_776_900_000_000, done: true, doneAt: 1_777_000_000_000 },
  { id: 'armed', text: 'call the bank', day: '2026-05-02', createdAt: 1_776_800_000_000, done: false, reminderAt: 1_776_990_000_000, reminded: false },
]

/** A v1 file of the shape the shipped build wrote. */
function v1Text(rows: readonly V1Row[] = V1_ROWS, daily: Readonly<Record<string, { created: number, done: number }>> = V1_DAILY): string {
  return `${JSON.stringify({ version: 1, items: rows, daily }, null, 2)}\n`
}

/** Put `text` at the store's path. */
function seed(home: string, text: string): void {
  writeFileSync(todoFile(home), text, 'utf8')
}

/** The anchor's bytes, as text. */
function anchorOf(home: string): string {
  return readFileSync(v1BackupFile(home), 'utf8')
}

test('a v1 file reads as v2 with every task, every count, and due filled from day', () => {
  const home = scratch()
  seed(home, v1Text())

  const file = loadTodos(home)

  assert.equal(file.version, 2)
  assert.deepEqual(file.lists, [])
  assert.deepEqual(file.items.map(item => item.id), ['open', 'ticked', 'armed'])
  // The deadline axis starts where the old file only had a creation day.
  assert.deepEqual(file.items.map(item => item.due), ['2026-05-04', '2026-05-03', '2026-05-02'])
  // Nothing else was invented or dropped on the way through.
  assert.deepEqual(file.items.map(item => item.day), ['2026-05-04', '2026-05-03', '2026-05-02'])
  assert.equal(file.items[1]!.done, true)
  assert.equal(file.items[1]!.doneAt, 1_777_000_000_000)
  assert.equal(file.items[2]!.reminderAt, 1_776_990_000_000)
  // The permanent layer: every day, every count, unchanged.
  assert.deepEqual(file.daily, V1_DAILY)
  assert.equal('listId' in file.items[0]!, false)
})

test('reading a v1 file leaves its exact bytes beside it as the rollback anchor', () => {
  const home = scratch()
  const original = v1Text()
  seed(home, original)

  loadTodos(home)

  // The anchor is the file, not a fragment of it: a copy that is still being
  // written would read as `[]` here, and as a JSON syntax error below.
  const anchor = anchorOf(home)
  assert.equal(anchor, original)
  assert.deepEqual(JSON.parse(anchor), JSON.parse(original))
  // Published by rename, so nothing is left staged.
  assert.deepEqual(readdirSync(todoDir(home)).sort(), ['todos.json', V1_BACKUP])
})

test('the anchor follows the file across an upgrade, a rollback and a second upgrade', () => {
  const home = scratch()
  const first = v1Text()
  seed(home, first)

  const upgraded = loadTodos(home)
  assert.equal(anchorOf(home), first)
  saveTodos(home, upgraded)

  // The documented rollback: the anchor goes back over the store.
  copyFileSync(v1BackupFile(home), todoFile(home))
  // The old build then keeps working — it writes v1 and the user adds a task.
  const extra: V1Row = { id: 'added', text: 'added while rolled back', day: '2026-05-05', createdAt: 1_777_100_000_000, done: false }
  const second = v1Text([...V1_ROWS, extra])
  seed(home, second)

  const reupgraded = loadTodos(home)
  assert.deepEqual(reupgraded.items.map(item => item.id), ['open', 'ticked', 'armed', 'added'])
  // An anchor left over from the FIRST upgrade would restore a file missing the
  // task the user added in between, so it tracks the current pre-v2 bytes.
  assert.equal(anchorOf(home), second)
})

test('an empty or truncated anchor is rebuilt and reported', () => {
  const truncated = scratch()
  const original = v1Text()
  seed(truncated, original)
  // What a half-written copy leaves behind: the path exists, the JSON does not.
  writeFileSync(v1BackupFile(truncated), original.slice(0, 36), 'utf8')

  const logged: string[] = []
  loadTodos(truncated, message => logged.push(message))

  assert.equal(anchorOf(truncated), original)
  assert.equal(logged.length, 1)
  assert.match(logged[0]!, /rebuilt/u)
  assert.ok(logged[0]!.includes(v1BackupFile(truncated)), 'the warning names the anchor')

  // An empty file is the same failure and gets the same repair.
  const empty = scratch()
  seed(empty, original)
  writeFileSync(v1BackupFile(empty), '', 'utf8')
  const emptyLogged: string[] = []
  loadTodos(empty, message => emptyLogged.push(message))
  assert.equal(anchorOf(empty), original)
  assert.equal(emptyLogged.length, 1)
  assert.match(emptyLogged[0]!, /rebuilt/u)
})

/**
 * A publish that fails must not be the moment the rollback anchor disappears.
 *
 * The fault is injected because no fixture can produce it: every filesystem state
 * that stops the rename (a read-only attribute, a handle held without delete
 * sharing, a directory in the way) stops a delete of the same path too, so the one
 * case that separates "replaced in one step" from "deleted, then renamed" has to be
 * built here. What is asserted is the whole contract: the anchor keeps its OWN bytes
 * even though they are stale, the store file keeps its bytes, the staged copy is
 * cleaned up, and the read still answers the migrated board with one warning.
 */
test('a publish that fails leaves the old anchor in place, stale bytes and all', (t) => {
  const home = scratch()
  const stale = v1Text(V1_ROWS.slice(0, 1), { '2026-05-04': { created: 1, done: 0 } })
  const current = v1Text()
  writeFileSync(v1BackupFile(home), stale, 'utf8')
  seed(home, current)
  // Before the fix this suite's assertion failed with the anchor ABSENT: the old
  // code unlinked it first, so the failed rename took it with it.
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EPERM: injected'), { code: 'EPERM' })
  })

  const logged: string[] = []
  const file = loadTodos(home, message => logged.push(message))

  // The anchor was not deleted and not rewritten: it is the previous copy, byte for
  // byte, which is what a rollback would restore.
  assert.equal(anchorOf(home), stale)
  // The file being upgraded is untouched too, so the next start reads the same v1
  // bytes and tries again.
  assert.equal(readFileSync(todoFile(home), 'utf8'), current)
  // Nothing staged is left behind.
  assert.deepEqual(readdirSync(todoDir(home)).sort(), ['todos.json', V1_BACKUP].sort())
  // One warning, naming the anchor, and no claim that the copy was kept.
  assert.equal(logged.length, 1)
  assert.match(logged[0]!, /could not keep the pre-v2 copy/u)
  assert.ok(logged[0]!.includes(v1BackupFile(home)), 'the warning names the anchor')
  // The read still answered the migrated board: a failed copy loses the anchor's
  // freshness, never the user's tasks.
  assert.equal(file.version, 2)
  assert.deepEqual(file.items.map(item => item.id), V1_ROWS.map(row => row.id))
})

test('a valid anchor that already matches is left alone', () => {
  const home = scratch()
  seed(home, v1Text())
  loadTodos(home)

  const logged: string[] = []
  loadTodos(home, message => logged.push(message))
  // Nothing to do and nothing to say: the bytes are already the anchor's.
  assert.deepEqual(logged, [])
})

test('a v2 row with no deadline keeps it that way', () => {
  const home = scratch()
  // Absent `due` MEANS "no deadline" once the file is v2 (`wire.ts` `TodoItem.due`),
  // so the v1 backfill must not reach these rows: filling it from `day` would turn a
  // state the file can express into one it cannot.
  seed(home, JSON.stringify({
    version: 2,
    items: [
      { id: 'no-due', text: 'no deadline', day: '2026-05-04', createdAt: 1, done: false },
      { id: 'with-due', text: 'owed friday', day: '2026-05-04', createdAt: 1, done: false, due: '2026-05-08' },
    ],
    daily: {},
    lists: [],
  }), 'utf8')

  const file = loadTodos(home)
  assert.equal('due' in file.items[0]!, false)
  assert.equal(file.items[1]!.due, '2026-05-08')

  // And it stays absent across a write and a read, rather than arriving on the next
  // upgrade pass.
  saveTodos(home, file)
  assert.equal('due' in loadTodos(home).items[0]!, false)
})

test('a v1 row that already carries a deadline keeps it through the upgrade', () => {
  const home = scratch()
  // A hand edit is enough to put a v2 field on a v1 file. The row's own deadline
  // wins over the fallback: the creation day is the default, never an overwrite.
  seed(home, v1Text([{ id: 'hand', text: 'written monday, owed friday', day: '2026-05-04', createdAt: 1, done: false, due: '2026-05-08' }], {}))

  const file = loadTodos(home)
  assert.equal(file.items[0]!.day, '2026-05-04')
  assert.equal(file.items[0]!.due, '2026-05-08')
})

test('a file that is not v1 gets no rollback anchor', () => {
  const home = scratch()
  saveTodos(home, emptyTodos())

  assert.deepEqual(loadTodos(home), emptyTodos())
  assert.equal(existsSync(v1BackupFile(home)), false)
  assert.deepEqual(readdirSync(todoDir(home)), ['todos.json'])

  // `version: 3` is another build's file, not this store's history, so it must not
  // be copied to an anchor named after v1.
  const future = scratch()
  seed(future, JSON.stringify({ version: 3, items: [], daily: {}, lists: [] }))
  loadTodos(future)
  assert.equal(existsSync(v1BackupFile(future)), false)
})

test('an impossible creation day leaves due absent instead of copying it', () => {
  const home = scratch()
  // `day` is only shape-checked (an unchanged rule), so a hand edit can land here.
  // The deadline must not inherit a date the calendar does not draw.
  seed(home, v1Text([{ id: 'impossible', text: 'written on a day that does not exist', day: '2026-02-31', createdAt: 1, done: false }], {}))

  const file = loadTodos(home)
  assert.deepEqual(file.items.map(item => item.id), ['impossible'])
  assert.equal(file.items[0]!.day, '2026-02-31')
  assert.equal('due' in file.items[0]!, false)
  // And it stays absent across a write and a read, rather than becoming a null or
  // an `undefined` key that only looks gone.
  saveTodos(home, file)
  assert.equal('due' in loadTodos(home).items[0]!, false)

  // A real creation day still gets its deadline, so the fallback is not switched
  // off wholesale.
  const real = scratch()
  seed(real, v1Text([{ id: 'real', text: 'a day that exists', day: '2028-02-29', createdAt: 1, done: false }], {}))
  assert.equal(loadTodos(real).items[0]!.due, '2028-02-29')
})

test('malformed new fields fall back one field at a time and never cost the task', () => {
  const home = scratch()
  seed(home, JSON.stringify({
    version: 2,
    items: [
      { id: 'priority', text: 'out of range', day: '2026-05-04', createdAt: 1, done: false, due: '2026-05-09', priority: 9 },
      { id: 'due', text: 'a day the calendar never draws', day: '2026-05-04', createdAt: 1, done: false, due: '2026-13-40' },
      { id: 'subtasks', text: 'steps that are not a list', day: '2026-05-04', createdAt: 1, done: false, due: '2026-05-04', subtasks: 'nope' },
      { id: 'repeat', text: 'an unknown cadence', day: '2026-05-04', createdAt: 1, done: false, due: '2026-05-04', repeat: { freq: 'hourly', interval: 2 } },
      {
        id: 'kept',
        text: 'everything valid',
        day: '2026-05-04',
        createdAt: 1,
        done: false,
        due: '2026-05-09',
        listId: 'work',
        priority: 2,
        notes: 'the number is on the invoice',
        subtasks: [{ id: 's1', text: 'find the invoice', done: true }, { id: '', text: 'no id', done: false }],
        repeat: { freq: 'weekly' },
        seriesId: 'series-1',
      },
    ],
    daily: {},
    lists: [
      { id: 'work', name: 'Work', order: 0 },
      { id: '', name: 'no id', order: 1 },
      { id: 'later', name: 'Later', order: 'first' },
    ],
  }), 'utf8')

  const file = loadTodos(home)
  assert.deepEqual(file.items.map(item => item.id), ['priority', 'due', 'subtasks', 'repeat', 'kept'])

  const [priority, due, subtasks, repeat, kept] = file.items
  // A priority outside 0..2 means "unset", not a clamped guess.
  assert.equal('priority' in priority!, false)
  assert.equal(priority!.due, '2026-05-09')
  // An impossible deadline on a v2 row is DROPPED, not moved to the creation day:
  // absent means "no deadline" here, and `views.ts` reads it as due on its `day`
  // anyway. (It falls back to `day` only for a v1 row — see the deadline tests
  // above, and the suite's history: this assertion used to pin the fallback.)
  assert.equal('due' in due!, false)
  assert.equal('subtasks' in subtasks!, false)
  // An unknown cadence drops the rule rather than inventing a rhythm.
  assert.equal('repeat' in repeat!, false)

  assert.equal(kept!.priority, 2)
  assert.equal(kept!.due, '2026-05-09')
  assert.equal(kept!.listId, 'work')
  assert.equal(kept!.notes, 'the number is on the invoice')
  assert.equal(kept!.seriesId, 'series-1')
  assert.deepEqual(kept!.subtasks, [{ id: 's1', text: 'find the invoice', done: true }])
  // A hand-written `{ "freq": "weekly" }` means one week.
  assert.deepEqual(kept!.repeat, { freq: 'weekly', interval: 1 })

  assert.deepEqual(file.lists.map(list => list.id), ['work', 'later'])
  // A list whose `order` is not a number keeps the file's own sequence.
  assert.deepEqual(file.lists.map(list => list.order), [0, 1])

  // And the normalized shape survives a write and a read without drifting.
  saveTodos(home, file)
  assert.deepEqual(loadTodos(home), file)
})
