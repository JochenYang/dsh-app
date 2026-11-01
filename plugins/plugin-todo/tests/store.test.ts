/**
 * Behavioral tests for the todo store.
 *
 * The invariants that matter here are the two the statistics depend on:
 *
 * 1. `daily` is SYMMETRIC under a toggle round trip. Ticking adds to the day the
 *    task was ticked and unticking takes the count back off THAT day, not off
 *    today — so a user who ticks something by mistake in the morning and unticks
 *    it after midnight does not leave a permanent "+1 completed" behind.
 * 2. `daily` is PERMANENT while `items` is bounded. Removing a task or pruning a
 *    finished one past the detail window must not rewrite history: "12 finished
 *    that day" is what the user remembers, whatever happened to the rows.
 *
 * A malformed file is exercised too, because the alternative to moving it aside is
 * overwriting the user's tasks on the first write after a bad edit.
 *
 * @module @dsh-app/plugin-todo/tests/store
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DETAIL_DAYS,
  addTodo,
  dayKey,
  emptyTodos,
  loadTodos,
  pruneDetail,
  removeTodo,
  saveTodos,
  setDone,
  statsFor,
  todoDir,
  todoFile,
  updateReminder,
  validDay,
  validText,
} from '../src/store.ts'

const roots: string[] = []

/** A fresh `$DSH_HOME`. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshtodo-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A local-time instant, so the day key does not depend on the test host's zone. */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

test('dayKey is the local calendar day, zero padded', () => {
  assert.equal(dayKey(at(2026, 3, 7)), '2026-03-07')
  assert.equal(dayKey(at(2026, 12, 31, 0)), '2026-12-31')
  assert.equal(dayKey(at(2026, 1, 1, 23)), '2026-01-01')
})

test('addTodo appends an open task and counts it as created that day', () => {
  const now = at(2026, 5, 4)
  const { file, item } = addTodo(emptyTodos(), '  write the release note  ', now, 'a1')

  assert.equal(item.text, '  write the release note  ')
  assert.equal(item.day, '2026-05-04')
  assert.equal(item.done, false)
  assert.equal(item.doneAt, undefined)
  assert.deepEqual(file.items, [item])
  assert.deepEqual(file.daily, { '2026-05-04': { created: 1, done: 0 } })
})

test('a toggle round trip leaves the aggregate exactly where it was', () => {
  const day = at(2026, 5, 4)
  const added = addTodo(emptyTodos(), 'ship it', day, 'a1').file

  const ticked = setDone(added, 'a1', true, at(2026, 5, 4, 18))
  assert.ok(ticked !== undefined)
  assert.deepEqual(ticked.file.daily, { '2026-05-04': { created: 1, done: 1 } })
  assert.equal(ticked.item.done, true)
  assert.equal(ticked.item.doneAt, at(2026, 5, 4, 18))

  const unticked = setDone(ticked.file, 'a1', false, at(2026, 5, 5, 1))
  assert.ok(unticked !== undefined)
  assert.deepEqual(unticked.file.daily, { '2026-05-04': { created: 1, done: 0 } })
  assert.equal(unticked.item.done, false)
  assert.equal(unticked.item.doneAt, undefined)
})

test('unticking takes the count off the day it was ticked, not off today', () => {
  const added = addTodo(emptyTodos(), 'ship it', at(2026, 5, 4), 'a1').file
  const ticked = setDone(added, 'a1', true, at(2026, 5, 4, 18))
  assert.ok(ticked !== undefined)

  const unticked = setDone(ticked.file, 'a1', false, at(2026, 5, 9, 9))
  assert.ok(unticked !== undefined)
  assert.deepEqual(unticked.file.daily, { '2026-05-04': { created: 1, done: 0 } })
})

test('setDone refuses an unknown id and is a no-op when the state already matches', () => {
  const added = addTodo(emptyTodos(), 'ship it', at(2026, 5, 4), 'a1').file

  assert.equal(setDone(added, 'nope', true, at(2026, 5, 4)), undefined)

  const same = setDone(added, 'a1', false, at(2026, 5, 4))
  assert.ok(same !== undefined)
  assert.equal(same.file, added)
})

test('removeTodo takes the task off that day\'s created count and leaves done alone', () => {
  const added = addTodo(emptyTodos(), 'ship it', at(2026, 5, 4), 'a1').file
  const ticked = setDone(added, 'a1', true, at(2026, 5, 4, 18))
  assert.ok(ticked !== undefined)

  const removed = removeTodo(ticked.file, 'a1')
  assert.deepEqual(removed.items, [])
  // created answers "how many tasks that day still holds"; done is a fact that
  // happened and stays.
  assert.deepEqual(removed.daily, { '2026-05-04': { created: 0, done: 1 } })

  assert.equal(removeTodo(removed, 'a1'), removed)
})

test('pruneDetail drops only finished rows past the window, and keeps the counts', () => {
  const old = at(2026, 1, 1)
  const now = at(2026, 6, 1)
  const fresh = emptyTodos()

  const keptOpen = addTodo(fresh, 'still open', old, 'open').file
  const staleDone = setDone(addTodo(keptOpen, 'done long ago', old, 'old').file, 'old', true, old)
  assert.ok(staleDone !== undefined)
  const recentDone = setDone(
    addTodo(staleDone.file, 'done lately', now - 2 * 86_400_000, 'new').file,
    'new',
    true,
    now - 86_400_000,
  )
  assert.ok(recentDone !== undefined)

  const pruned = pruneDetail(recentDone.file, now)
  assert.deepEqual(pruned.items.map(item => item.id), ['open', 'new'])
  assert.deepEqual(pruned.daily, recentDone.file.daily)

  // A day inside the window keeps its finished row.
  assert.equal(DETAIL_DAYS, 90)
})

test('statsFor zero-fills the days the map does not carry', () => {
  const added = addTodo(emptyTodos(), 'ship it', at(2026, 5, 4), 'a1').file
  assert.deepEqual(statsFor(added, ['2026-05-03', '2026-05-04']), [
    { created: 0, done: 0 },
    { created: 1, done: 0 },
  ])
})

test('a missing file is an empty store', () => {
  const home = scratch()
  assert.deepEqual(loadTodos(home), emptyTodos())
})

test('save and load round trip under $DSH_HOME/storages', () => {
  const home = scratch()
  const file = addTodo(emptyTodos(), 'ship it', at(2026, 5, 4), 'a1').file
  saveTodos(home, file)

  assert.equal(todoFile(home), join(todoDir(home), 'todos.json'))
  assert.deepEqual(loadTodos(home), file)

  const raw = JSON.parse(readFileSync(todoFile(home), 'utf8')) as { version: number }
  assert.equal(raw.version, 1)
  // No tmp files left behind by the atomic write.
  assert.deepEqual(readdirSync(todoDir(home)), ['todos.json'])
})

test('an unparseable file is moved aside, not overwritten, and the log names it', () => {
  const home = scratch()
  mkdirSync(todoDir(home), { recursive: true })
  writeFileSync(todoFile(home), '{ not json', 'utf8')

  const logged: string[] = []
  assert.deepEqual(loadTodos(home, message => logged.push(message)), emptyTodos())

  const files = readdirSync(todoDir(home))
  assert.equal(files.some(name => name.startsWith('todos.json.broken-')), true)
  assert.equal(files.includes('todos.json'), false)
  assert.equal(logged.length, 1)
  assert.match(logged[0]!, /kept it as .*todos\.json\.broken-/u)
})

test('loadTodos keeps only the rows a hand edit left valid', () => {
  const home = scratch()
  mkdirSync(todoDir(home), { recursive: true })
  writeFileSync(todoFile(home), JSON.stringify({
    version: 1,
    items: [
      { id: 'good', text: 'keep me', day: '2026-05-04', createdAt: 1, done: false },
      { text: 'no id', day: '2026-05-04', createdAt: 1, done: false },
      { id: 'bad-day', text: 'x', day: '5/4/2026', createdAt: 1, done: false },
      { id: 'bad-done', text: 'x', day: '2026-05-04', createdAt: 1, done: 'no' },
      { id: 'ticked', text: 'x', day: '2026-05-04', createdAt: 1, done: true, doneAt: 9 },
    ],
    daily: {
      '2026-05-04': { created: 2, done: 1 },
      'nonsense': { created: 4, done: 4 },
      '2026-05-05': { created: -3, done: 'x' },
    },
  }), 'utf8')

  const file = loadTodos(home)
  assert.deepEqual(file.items.map(item => item.id), ['good', 'ticked'])
  assert.equal(file.items[1]!.doneAt, 9)
  assert.deepEqual(file.daily, {
    '2026-05-04': { created: 2, done: 1 },
    '2026-05-05': { created: 0, done: 0 },
  })
})

test('validDay accepts a real local date and refuses the shapes that only look right', () => {
  assert.equal(validDay('2026-11-02'), '2026-11-02')
  assert.equal(validDay('2026-02-28'), '2026-02-28')
  assert.equal(validDay('2028-02-29'), '2028-02-29')
  // A day the calendar never draws: the shape matches and the date normalises away.
  assert.equal(validDay('2026-02-31'), null)
  assert.equal(validDay('2026-13-01'), null)
  assert.equal(validDay('2026-2-3'), null)
  assert.equal(validDay('2026-11-02T10:00'), null)
  assert.equal(validDay(20261102), null)
  assert.equal(validDay(undefined), null)
})

test('addTodo files a task on the day it was given, and counts it there', () => {
  const now = at(2026, 5, 4)
  const { file, item } = addTodo(emptyTodos(), 'write it on Friday', now, 'a1', '2026-05-08')

  assert.equal(item.day, '2026-05-08')
  assert.equal(item.createdAt, now)
  assert.deepEqual(file.daily, { '2026-05-08': { created: 1, done: 0 } })
})

test('validText trims, and refuses what the board cannot show', () => {
  assert.equal(validText('  ship it  '), 'ship it')
  assert.equal(validText('   '), null)
  assert.equal(validText(''), null)
  assert.equal(validText(42), null)
  assert.equal(validText('x'.repeat(500)), 'x'.repeat(500))
  assert.equal(validText('x'.repeat(501)), null)
})

test('updateReminder sets, updates, or clears reminderAt and reminded', () => {
  const now = at(2026, 5, 4)
  const { file } = addTodo(emptyTodos(), 'task 1', now, 't1', '2026-05-04')

  // Set reminder
  const withReminder = updateReminder(file, 't1', now + 3600_000, false)
  assert.equal(withReminder.items[0]!.reminderAt, now + 3600_000)
  assert.equal(withReminder.items[0]!.reminded, false)

  // Clear reminder
  const cleared = updateReminder(withReminder, 't1', undefined)
  assert.equal(cleared.items[0]!.reminderAt, undefined)
  assert.equal('reminderAt' in cleared.items[0]!, false)
})

test('marking a reminder as seen keeps it; only an explicit clear removes it', () => {
  const now = at(2026, 5, 4)
  const armed = updateReminder(addTodo(emptyTodos(), 'call the bank', now, 't1').file, 't1', now + 3600_000, false)

  // What the toast's close button asks for: it rang, the user closed it. The
  // reminder has to survive, or closing a notice silently deletes what the user set.
  const seen = updateReminder(armed, 't1', undefined, true)
  assert.equal(seen.items[0]!.reminderAt, now + 3600_000)
  assert.equal(seen.items[0]!.reminded, true)

  // No time and no flag is the picker's 清除: gone, both fields.
  const cleared = updateReminder(seen, 't1', undefined, false)
  assert.equal('reminderAt' in cleared.items[0]!, false)
  assert.equal('reminded' in cleared.items[0]!, false)

  // An unknown id is left alone rather than creating anything.
  const untouched = updateReminder(cleared, 'nope', undefined, true)
  assert.deepEqual(untouched.items, cleared.items)
})
