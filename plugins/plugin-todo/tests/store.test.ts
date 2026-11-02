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
  MAX_SUBTASKS,
  MAX_SUBTASK_TEXT,
  addSubtask,
  addTodo,
  dayKey,
  emptyTodos,
  loadTodos,
  pruneDetail,
  removeSubtask,
  removeTodo,
  renameSubtask,
  retimeDueReminder,
  saveTodos,
  setDone,
  setSubtaskDone,
  statsFor,
  todoDir,
  todoFile,
  updateReminder,
  validDay,
  validRepeat,
  validSubtaskText,
  validText,
  type TodoFile,
  type TodoItem,
} from '../src/store.ts'
import { MAX_REPEAT_INTERVAL } from '../src/wire.ts'
import { subtaskProgress } from '../src/views.ts'

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

test('the v2 fields survive a toggle, and the lists survive every write', () => {
  const now = at(2026, 5, 4)
  const base = addTodo(emptyTodos(), 'file the invoice', now, 'a1').file
  const lists = [{ id: 'work', name: 'Work', order: 0 }]
  // A task carrying everything v2 added: ticking it must not be the moment the
  // deadline, the steps or the series disappear.
  const rich: TodoItem = {
    ...base.items[0]!,
    due: '2026-05-09',
    listId: 'work',
    priority: 2,
    notes: 'invoice 42',
    subtasks: [{ id: 's1', text: 'find it', done: true }],
    repeat: { freq: 'weekly', interval: 1 },
    seriesId: 'series-1',
  }
  const file: TodoFile = { ...base, items: [rich], lists }

  const ticked = setDone(file, 'a1', true, at(2026, 5, 4, 18))
  assert.ok(ticked !== undefined)
  const item = ticked.file.items[0]!
  assert.equal(item.done, true)
  assert.equal(item.due, '2026-05-09')
  assert.equal(item.listId, 'work')
  assert.equal(item.priority, 2)
  assert.equal(item.notes, 'invoice 42')
  assert.deepEqual(item.subtasks, [{ id: 's1', text: 'find it', done: true }])
  assert.deepEqual(item.repeat, { freq: 'weekly', interval: 1 })
  assert.equal(item.seriesId, 'series-1')
  assert.deepEqual(ticked.file.lists, lists)
  assert.equal(ticked.file.version, 2)

  // Unticking and the prune pass leave them alone as well.
  const unticked = setDone(ticked.file, 'a1', false, at(2026, 5, 5, 1))
  assert.ok(unticked !== undefined)
  const pruned = pruneDetail(unticked.file, at(2026, 5, 5))
  assert.equal(pruned.items[0]!.due, '2026-05-09')
  assert.deepEqual(pruned.items[0]!.subtasks, [{ id: 's1', text: 'find it', done: true }])
  assert.deepEqual(pruned.lists, lists)

  // And removing a task must not take the lists with it.
  assert.deepEqual(removeTodo(pruned, 'a1').lists, lists)
})

test('a new task is owed the day it is written', () => {
  const now = at(2026, 5, 4)
  // The composer sends no deadline; "due today" is the default a v1 file is read
  // with too, so every task has a day to compare against.
  assert.equal(addTodo(emptyTodos(), 'ship it', now, 'a1').item.due, '2026-05-04')
  // An explicit day moves the deadline with it.
  assert.equal(addTodo(emptyTodos(), 'ship it', now, 'a1', '2026-05-08').item.due, '2026-05-08')
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
  // v2 is what the store writes now; the previous assertion pinned v1, which was
  // the shape before deadlines and lists existed.
  assert.equal(raw.version, 2)
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

/** A board with one task, `a1`, that the step cases add to. */
function withTask(): TodoFile {
  return addTodo(emptyTodos(), 'pack for the trip', at(2026, 5, 4), 'a1').file
}

test('steps are added, renamed, ticked and removed, and progress follows them', () => {
  // The store stores what `validSubtaskText` validated; trimming is that function's
  // job (asserted below), so these cases hand it already-trimmed text.
  const one = addSubtask(withTask(), 'a1', 'passport', 's1')
  assert.ok(one !== undefined)
  assert.deepEqual(one.subtask, { id: 's1', text: 'passport', done: false })
  const two = addSubtask(one.file, 'a1', 'charger', 's2')
  assert.ok(two !== undefined)
  const three = addSubtask(two.file, 'a1', 'tickets', 's3')
  assert.ok(three !== undefined)

  let file = three.file
  assert.deepEqual(file.items[0]!.subtasks?.map(step => step.text), ['passport', 'charger', 'tickets'])
  assert.deepEqual(subtaskProgress(file.items[0]!), { done: 0, total: 3 })

  file = setSubtaskDone(file, 'a1', 's2', true)
  assert.deepEqual(subtaskProgress(file.items[0]!), { done: 1, total: 3 })
  // The parent is NOT derived from its steps, in either direction.
  assert.equal(file.items[0]!.done, false)

  // Ticking again is a no-op, not a second count.
  assert.equal(setSubtaskDone(file, 'a1', 's2', true), file)
  // An unknown step or task leaves the file alone rather than creating anything.
  assert.equal(setSubtaskDone(file, 'a1', 'nope', true), file)
  assert.equal(setSubtaskDone(file, 'nope', 's2', true), file)

  file = renameSubtask(file, 'a1', 's2', 'charger and cable')
  assert.deepEqual(file.items[0]!.subtasks?.map(step => step.text), ['passport', 'charger and cable', 'tickets'])
  assert.deepEqual(file.items[0]!.subtasks?.[1], { id: 's2', text: 'charger and cable', done: true })
  assert.equal(renameSubtask(file, 'a1', 's2', 'charger and cable'), file)

  file = removeSubtask(file, 'a1', 's2')
  assert.deepEqual(file.items[0]!.subtasks?.map(step => step.id), ['s1', 's3'])
  assert.deepEqual(subtaskProgress(file.items[0]!), { done: 0, total: 2 })
  assert.equal(removeSubtask(file, 'a1', 's2'), file)
})

test('removing the last step drops the field rather than leaving an empty list', () => {
  const added = addSubtask(withTask(), 'a1', 'passport', 's1')
  assert.ok(added !== undefined)
  const file = removeSubtask(added.file, 'a1', 's1')
  // Absent is how a task with no steps is stored; `subtasks: []` would be a second
  // way to say the same thing and a file that reads differently from its twin.
  assert.equal('subtasks' in file.items[0]!, false)
  assert.deepEqual(subtaskProgress(file.items[0]!), { done: 0, total: 0 })
})

test('step ids are unique inside one task, and only inside it', () => {
  const first = addSubtask(withTask(), 'a1', 'one', 'dup')
  assert.ok(first !== undefined)
  // The second row could never be reached, because every mutator finds a step by id.
  assert.equal(addSubtask(first.file, 'a1', 'two', 'dup'), undefined)
  assert.equal(first.file.items[0]!.subtasks?.length, 1)

  // Another task may reuse the id: the invariant is per task, not per board.
  const board = addTodo(first.file, 'second task', at(2026, 5, 4), 'a2').file
  const other = addSubtask(board, 'a2', 'one again', 'dup')
  assert.ok(other !== undefined)
  assert.equal(other.file.items[1]!.subtasks?.length, 1)
})

test('a task holds at most MAX_SUBTASKS steps', () => {
  let file = withTask()
  for (let index = 0; index < MAX_SUBTASKS; index += 1) {
    const added = addSubtask(file, 'a1', `step ${String(index)}`, `s${String(index)}`)
    assert.ok(added !== undefined, `step ${String(index)} is inside the cap`)
    file = added.file
  }
  assert.equal(file.items[0]!.subtasks?.length, MAX_SUBTASKS)
  // One more is refused, and the refusal leaves the file exactly as it was.
  assert.equal(addSubtask(file, 'a1', 'one too many', 's-extra'), undefined)
  assert.equal(file.items[0]!.subtasks?.length, MAX_SUBTASKS)
})

test('validSubtaskText trims and refuses what a checklist cannot draw', () => {
  assert.equal(validSubtaskText('  find it  '), 'find it')
  assert.equal(validSubtaskText('   '), null)
  assert.equal(validSubtaskText(''), null)
  assert.equal(validSubtaskText(42), null)
  assert.equal(validSubtaskText('x'.repeat(MAX_SUBTASK_TEXT)), 'x'.repeat(MAX_SUBTASK_TEXT))
  assert.equal(validSubtaskText('x'.repeat(MAX_SUBTASK_TEXT + 1)), null)
  assert.equal(MAX_SUBTASK_TEXT, 200)
  assert.equal(MAX_SUBTASKS, 20)
})

test('ticking the parent leaves its steps alone, and ticking every step leaves the parent open', () => {
  const added = addSubtask(withTask(), 'a1', 'passport', 's1')
  assert.ok(added !== undefined)
  let file = added.file
  file = addSubtask(file, 'a1', 'charger', 's2')!.file
  assert.equal(file.items[0]!.subtasks?.length, 2)

  // The parent can be ticked with steps left over — "the rest moved elsewhere" is a
  // real answer, so completion is never forced down the checklist.
  const ticked = setDone(file, 'a1', true, at(2026, 5, 4, 18))
  assert.ok(ticked !== undefined)
  assert.equal(ticked.item.done, true)
  assert.deepEqual(ticked.item.subtasks?.map(step => step.done), [false, false])
  assert.deepEqual(subtaskProgress(ticked.item), { done: 0, total: 2 })

  // And every step ticked does not tick the task.
  let allSteps = setSubtaskDone(file, 'a1', 's1', true)
  allSteps = setSubtaskDone(allSteps, 'a1', 's2', true)
  assert.equal(allSteps.items[0]!.done, false)
  assert.deepEqual(subtaskProgress(allSteps.items[0]!), { done: 2, total: 2 })
})

test('removing the parent takes its steps with it, leaving no residue', () => {
  const added = addSubtask(withTask(), 'a1', 'passport', 's1')
  assert.ok(added !== undefined)
  const file = addSubtask(added.file, 'a1', 'charger', 's2')!.file

  const removed = removeTodo(file, 'a1')
  assert.deepEqual(removed.items, [])
  // The steps live INSIDE the task, so nothing can outlive it; the assertion is the
  // proof that no side table was introduced for them.
  assert.equal(JSON.stringify(removed).includes('passport'), false)
  assert.deepEqual(removeSubtask(removed, 'a1', 's1'), removed)
})


test('a repeat rule is capped at MAX_REPEAT_INTERVAL, and exactly at the cap is a rule', () => {
  // `weekday` walks one unit at a time, so an uncapped interval is a synchronous loop
  // inside a request handler: 1e9 units is a request that never answers.
  assert.deepEqual(validRepeat({ freq: 'weekly', interval: MAX_REPEAT_INTERVAL }), {
    freq: 'weekly',
    interval: MAX_REPEAT_INTERVAL,
  })
  assert.equal(validRepeat({ freq: 'weekly', interval: MAX_REPEAT_INTERVAL + 1 }), null)
  assert.equal(validRepeat({ freq: 'weekday', interval: 1_000_000_000 }), null)
  // The cap is not the only bound: the shape rules still apply.
  assert.equal(validRepeat({ freq: 'weekly', interval: 0 }), null)
  assert.equal(validRepeat({ freq: 'weekly', interval: 1.5 }), null)
  assert.equal(validRepeat({ freq: 'hourly', interval: 1 }), null)
  // A missing interval is one unit, which is what a hand-written rule means.
  assert.deepEqual(validRepeat({ freq: 'daily' }), { freq: 'daily', interval: 1 })
})

test('a stored rule past the cap is dropped on the way out of the file', () => {
  const home = scratch()
  mkdirSync(todoDir(home), { recursive: true })
  const row = {
    id: 'huge',
    text: 'walk to the moon',
    day: '2026-05-04',
    createdAt: at(2026, 5, 4),
    done: false,
    due: '2026-05-04',
    repeat: { freq: 'weekday', interval: 1_000_000_000 },
  }
  writeFileSync(todoFile(home), JSON.stringify({ version: 2, items: [row], daily: {}, lists: [] }), 'utf8')

  const file = loadTodos(home)
  // The task survives; the unusable RULE is what goes, so nothing ever walks it.
  assert.equal(file.items.length, 1)
  assert.equal('repeat' in file.items[0]!, false)
})

test('a reminder is re-derived from the deadline only when it came from one', () => {
  const file = emptyTodos()
  // Written yesterday, due in a week, armed for 09:00 on the due day.
  const base: TodoItem = {
    id: 't',
    text: 'pay the rent',
    day: '2026-05-04',
    createdAt: at(2026, 5, 4),
    done: false,
    due: '2026-05-11',
    reminderAt: at(2026, 5, 11, 9),
    reminderSource: 'due-day',
  }
  const withTasks: TodoFile = { ...file, items: [base] }

  // Moving the deadline moves the instant with it: 09:00 on the NEW day.
  const moved: TodoItem = { ...base, due: '2026-06-01' }
  const retimed = retimeDueReminder({ ...withTasks, items: [moved] }, 't', at(2026, 5, 4))
  assert.equal(retimed.items[0]!.reminderAt, at(2026, 6, 1, 9))
  assert.equal(retimed.items[0]!.reminderSource, 'due-day')

  // A hand-picked instant is the user's own and never moves.
  const custom: TodoItem = { ...base, due: '2026-06-01', reminderSource: 'custom' }
  assert.deepEqual(retimeDueReminder({ ...withTasks, items: [custom] }, 't', at(2026, 5, 4)).items, [custom])
  // An absent source reads as custom, which is what every reminder written before the
  // field existed was — re-deriving one of those would move a time the user chose.
  const legacy: TodoItem = { ...base, due: '2026-06-01' }
  const { reminderSource: _dropped, ...withoutSource } = legacy
  assert.deepEqual(retimeDueReminder({ ...withTasks, items: [withoutSource] }, 't', at(2026, 5, 4)).items, [withoutSource])

  // A deadline whose reminder moment has already gone arms NOTHING rather than leaving
  // an instant that belongs to a day the task no longer has.
  const past: TodoItem = { ...base, due: '2026-04-01' }
  const cleared = retimeDueReminder({ ...withTasks, items: [past] }, 't', at(2026, 5, 4))
  assert.equal('reminderAt' in cleared.items[0]!, false)
  assert.equal('reminderSource' in cleared.items[0]!, false)
})

test('a reminder written before the source field existed reads as custom', () => {
  const home = scratch()
  mkdirSync(todoDir(home), { recursive: true })
  const row = {
    id: 'old',
    text: 'call the bank',
    day: '2026-05-04',
    createdAt: at(2026, 5, 4),
    done: false,
    due: '2026-05-04',
    reminderAt: at(2026, 5, 4, 17),
    reminded: true,
  }
  writeFileSync(todoFile(home), JSON.stringify({ version: 2, items: [row], daily: {}, lists: [] }), 'utf8')

  // The migration fills the field out explicitly, so the next deadline move reads a
  // value instead of inferring one.
  assert.equal(loadTodos(home).items[0]!.reminderSource, 'custom')

  // A row with no armed reminder carries no source: it describes a reminder, and there
  // is none.
  writeFileSync(todoFile(home), JSON.stringify({
    version: 2,
    items: [{ ...row, reminderAt: undefined, reminded: undefined }],
    daily: {},
    lists: [],
  }), 'utf8')
  assert.equal('reminderSource' in loadTodos(home).items[0]!, false)
})
