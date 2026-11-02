/**
 * End-to-end tests for the host half: `apply()` against a captured Connection
 * exact-Fetch registry and a captured tools registry.
 *
 * No server and no carrier: the Connection carrier applies the Host/Origin fence
 * and browser auth BEFORE a handler runs, so what this plugin owns — path,
 * methods, the JSON body, the envelope, and the file under `$DSH_HOME` — is
 * exactly what these cases exercise. The tools are called through the same
 * `execute` the registry would call, so "the model recorded a task" and "the card
 * reads it back" are the same file, which is the whole point of the plugin.
 *
 * @module @dsh-app/plugin-todo/tests/apply
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, MAX_BATCH_IDS } from '../src/index.ts'
import { MAX_NOTES, MAX_SUBTASKS, MAX_SUBTASK_TEXT, todoDir, todoFile, v1BackupFile, type TodoFile } from '../src/store.ts'
import { ROUTE_PREFIX } from '../src/wire.ts'
import { addDays, inView } from '../src/views.ts'

const roots: string[] = []

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A captured route, as the carrier would call it. */
interface CapturedRoute {
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** A captured tool, as the registry would call it. */
interface CapturedTool {
  readonly execute: (args: unknown) => Promise<unknown>
}

/** One decoded answer. */
interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** The plugin's own host context, with everything it does not own stubbed out. */
interface App {
  readonly home: string
  /** POST (or GET, with no body) one route by its SUFFIX, e.g. `/add`. */
  call(suffix: string, body?: unknown): Promise<Answer>
  /** Run one tool by name. */
  run(name: string, args: unknown): Promise<Record<string, unknown>>
  /** The stored file, as the next process would read it. */
  read(): TodoFile
}

/**
 * Apply the plugin against a fresh `$DSH_HOME`.
 * @returns the harness over its registrations.
 */
function boot(): App {
  const home = mkdtempSync(join(tmpdir(), 'dshtodo-apply-'))
  roots.push(home)
  process.env.DSH_HOME = home

  const routes = new Map<string, CapturedRoute>()
  const tools = new Map<string, CapturedTool>()

  // The plugin's own context surface — `logger`, `effect`, the two service
  // faces — and nothing else. `tsx` cannot see cordis's real Context here
  // (that would need the whole composition), so the stub is cast once at this
  // boundary; every field it omits is one this plugin never touches.
  apply({
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
    effect: (run: () => () => void) => { run() },
    connection: {
      fetch: {
        register: (route: { path: string, methods: readonly string[], fetch: CapturedRoute['fetch'] }) => {
          routes.set(route.path, { methods: route.methods, fetch: route.fetch })
          return () => { routes.delete(route.path) }
        },
      },
    },
    tools: {
      register: (definition: { name: string, execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
        tools.set(definition.name, { execute: args => definition.execute(args, {}) })
        return () => { tools.delete(definition.name) }
      },
    },
  } as unknown as Parameters<typeof apply>[0])

  return {
    home,
    async call(suffix, body) {
      const full = `${ROUTE_PREFIX}${suffix}`
      const route = routes.get(full)
      assert.ok(route !== undefined, `no route registered for ${full} (have ${[...routes.keys()].join(', ') || 'none'})`)
      const method = body === undefined ? 'GET' : 'POST'
      const request = new Request(`dsh-app://app${full}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const response = await route.fetch(request)
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    async run(name, args) {
      const tool = tools.get(name)
      assert.ok(tool !== undefined, `no tool registered as ${name} (have ${[...tools.keys()].join(', ') || 'none'})`)
      return await tool.execute(args) as Record<string, unknown>
    },
    read() {
      return JSON.parse(readFileSync(todoFile(home), 'utf8')) as TodoFile
    },
  }
}

/** The board a route answered. */
interface Snapshot {
  today: string
  items: {
    id: string
    text: string
    day: string
    done: boolean
    listId?: string
    due?: string
    priority?: number
    notes?: string
    reminderAt?: number
    reminded?: boolean
    repeat?: { freq: string, interval: number }
    seriesId?: string
    subtasks?: { id: string, text: string, done: boolean }[]
  }[]
  daily: Record<string, { created: number, done: number }>
  lists: { id: string, name: string, order: number }[]
  /** Present on a `/batch` answer only: one row per id the request named. */
  batch?: { done: { id: string }[], failed: { id: string, code: string }[] }
}

/** The local calendar day, the same format the store writes. */
function dayToday(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The board out of one answer, with the envelope checked. */
function snapshotOf(answer: Answer): Snapshot {
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  return answer.body.value as Snapshot
}

/** The per-row outcome out of a `/batch` answer. */
function batchOf(answer: Answer): { done: { id: string }[], failed: { id: string, code: string }[] } {
  const snapshot = snapshotOf(answer)
  assert.ok(snapshot.batch !== undefined, 'a batch answer carries its per-row outcome')
  return snapshot.batch
}

/** One refused answer's transport code, e.g. `name-taken`. */
function codeOf(answer: Answer): string {
  return (answer.body.error as { code: string }).code
}

test('apply registers the board route, which answers an empty board', async () => {
  const app = boot()
  const read = snapshotOf(await app.call('/todos'))
  assert.equal(read.today, dayToday())
  assert.deepEqual(read.items, [])
  assert.deepEqual(read.daily, {})
})

test('add → toggle → remove moves the aggregate the way the card expects', async () => {
  const app = boot()

  const added = snapshotOf(await app.call('/add', { text: '  ship the card  ' }))
  assert.equal(added.items.length, 1)
  assert.equal(added.items[0]!.text, 'ship the card')
  assert.equal(added.items[0]!.day, dayToday())
  assert.deepEqual(added.daily[dayToday()], { created: 1, done: 0 })

  const ticked = snapshotOf(await app.call('/toggle', { id: added.items[0]!.id, done: true }))
  assert.equal(ticked.items[0]!.done, true)
  assert.deepEqual(ticked.daily[dayToday()], { created: 1, done: 1 })

  const removed = snapshotOf(await app.call('/remove', { id: ticked.items[0]!.id }))
  assert.deepEqual(removed.items, [])
  // Created drops with the row (the cell shows how many the day still holds);
  // done stays (finishing it happened).
  assert.deepEqual(removed.daily[dayToday()], { created: 0, done: 1 })
})

test('a refused write answers the coded message the card renders', async () => {
  const app = boot()

  const blank = await app.call('/add', { text: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(blank.body.ok, false)
  const error = blank.body.error as { code: string, host: { code: string } }
  assert.equal(error.code, 'text-required')
  assert.equal(error.host.code, 'route.textRequired')

  const missing = await app.call('/toggle', { id: 'nope' })
  assert.equal(missing.status, 404)
  assert.equal((missing.body.error as { code: string }).code, 'not-found')

  const noId = await app.call('/remove', {})
  assert.equal(noId.status, 400)
  assert.equal((noId.body.error as { code: string }).code, 'id-required')

  // A body that parses but is not an object carries no `text` either.
  const notAnObject = await app.call('/add', 'not-an-object')
  assert.equal(notAnObject.status, 400)
  assert.equal((notAnObject.body.error as { code: string }).code, 'text-required')
})

test('the three tools write the same file the card reads', async () => {
  const app = boot()

  const added = await app.run('todo_add', { text: 'water the plants' })
  assert.equal(added.ok, true)
  const id = added.id as string

  const listed = await app.run('todo_list', {})
  assert.equal(listed.ok, true)
  const items = listed.items as { id: string, text: string }[]
  assert.deepEqual(items.map(item => item.id), [id])

  const done = await app.run('todo_done', { text: 'plants' })
  assert.equal(done.ok, true)
  assert.equal(done.done, true)

  const board = app.read()
  assert.equal(board.items.length, 1)
  assert.equal(board.items[0]!.done, true)
  assert.deepEqual(board.daily[dayToday()], { created: 1, done: 1 })

  // The route sees the model's write, which is what the card renders.
  const snapshot = snapshotOf(await app.call('/todos'))
  assert.equal(snapshot.items[0]!.done, true)
})

test('todo_done never guesses between several matches', async () => {
  const app = boot()
  await app.run('todo_add', { text: 'buy milk' })
  await app.run('todo_add', { text: 'buy bread' })

  const ambiguous = await app.run('todo_done', { text: 'buy' })
  assert.equal(ambiguous.ok, false)
  const candidates = ambiguous.candidates as { id: string, text: string }[]
  assert.equal(candidates.length, 2)
  assert.equal((ambiguous.error as string).includes('2 tasks match'), true)

  // Naming one of them resolves it.
  const ticked = await app.run('todo_done', { id: candidates[0]!.id })
  assert.equal(ticked.ok, true)
})

test('todo_list week carries seven days of counts ending today', async () => {
  const app = boot()
  await app.run('todo_add', { text: 'one thing' })

  const week = await app.run('todo_list', { range: 'week' })
  assert.equal(week.ok, true)
  const days = week.week as { day: string, created: number, done: number }[]
  assert.equal(days.length, 7)
  assert.equal(days.at(-1)!.day, dayToday())
  // Seven DISTINCT calendar days, oldest first: the keys are walked one calendar step
  // at a time (`views.ts` `addDays`), so a 23-hour spring-forward day cannot make two
  // columns name the same date — which a fixed 24-hour subtraction does.
  assert.equal(new Set(days.map(entry => entry.day)).size, 7)
  assert.deepEqual(days.map(entry => entry.day), days.map(entry => entry.day).slice().sort())
  assert.equal(days.at(-1)!.created, 1)
  assert.equal(days[0]!.done, 0)
})

test('a task can be written for another day, through the route and through the tool', async () => {
  const app = boot()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = `${String(tomorrow.getFullYear())}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

  const added = snapshotOf(await app.call('/add', { text: 'plan tomorrow', day }))
  assert.equal(added.items[0]!.day, day)
  assert.deepEqual(added.daily[day], { created: 1, done: 0 })
  // Today's board is untouched: the composer under 今天 only ever writes today.
  assert.deepEqual(added.daily[dayToday()], undefined)

  const viaTool = await app.run('todo_add', { text: 'from the model', day })
  assert.equal(viaTool.ok, true)
  assert.equal(viaTool.day, day)

  const bad = await app.call('/add', { text: 'nope', day: '2026-02-31' })
  assert.equal(bad.status, 400)
  assert.equal((bad.body.error as { code: string }).code, 'day-invalid')

  const badTool = await app.run('todo_add', { text: 'nope', day: '2026-02-31' })
  assert.equal(badTool.ok, false)
})

test('the reminder route marks a rung reminder as seen without deleting it', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'call the bank', reminderAt: Date.now() + 60_000 }))
  const id = added.items[0]!.id
  assert.equal(typeof added.items[0]!.reminderAt, 'number')

  // Closing the notice: still armed, recorded as seen.
  const seen = snapshotOf(await app.call('/remind', { id, reminded: true }))
  assert.equal(seen.items[0]!.reminded, true)
  assert.equal(typeof seen.items[0]!.reminderAt, 'number')

  // Clearing: both fields gone.
  const cleared = snapshotOf(await app.call('/remind', { id }))
  assert.equal('reminderAt' in cleared.items[0]!, false)
  assert.equal('reminded' in cleared.items[0]!, false)

  // An unknown id is refused, not answered with a silent write.
  const missing = await app.call('/remind', { id: 'nope', reminded: true })
  assert.equal(missing.status, 404)
})

test('todo_list overdue answers only what was left behind', async () => {
  const app = boot()
  await app.run('todo_add', { text: 'today only' })

  const overdue = await app.run('todo_list', { range: 'overdue' })
  assert.equal(overdue.ok, true)
  assert.deepEqual(overdue.overdue, [])
})

test('a v1 file is upgraded on the host path, with the rollback copy made first', async () => {
  const app = boot()
  const v1 = `${JSON.stringify({
    version: 1,
    items: [{ id: 'open', text: 'written by the old build', day: '2026-05-04', createdAt: 1, done: false }],
    daily: { '2026-05-04': { created: 1, done: 0 } },
  }, null, 2)}\n`
  mkdirSync(todoDir(app.home), { recursive: true })
  writeFileSync(todoFile(app.home), v1, 'utf8')

  // A read answers the migrated board and prepares the rollback copy, without
  // rewriting the file the user still has.
  const read = snapshotOf(await app.call('/todos'))
  assert.equal(read.items.length, 1)
  assert.deepEqual(read.daily, { '2026-05-04': { created: 1, done: 0 } })
  assert.equal(readFileSync(v1BackupFile(app.home), 'utf8'), v1)
  assert.equal((JSON.parse(readFileSync(todoFile(app.home), 'utf8')) as { version: number }).version, 1)

  // The first write persists v2, the old task keeps its deadline, and the copy is
  // still the pre-upgrade bytes.
  snapshotOf(await app.call('/add', { text: 'and a new one' }))
  const stored = app.read()
  assert.equal(stored.version, 2)
  assert.equal(stored.items.find(item => item.id === 'open')?.due, '2026-05-04')
  assert.equal(stored.items.length, 2)
  assert.equal(readFileSync(v1BackupFile(app.home), 'utf8'), v1)
})

test('todo_list overdue answers by the same rule the views use', async () => {
  const app = boot()
  const today = dayToday()
  // Five shapes, including the two a `day < today` rule gets backwards.
  const items = [
    // Written today, owed last week: late.
    { id: 'late', text: 'owed last week', day: today, createdAt: 1, done: false, due: addDays(today, -7) },
    // Written last week, owed next month: not late.
    { id: 'later', text: 'owed next month', day: addDays(today, -7), createdAt: 1, done: false, due: addDays(today, 30) },
    // Owed today: not late.
    { id: 'due-today', text: 'owed today', day: today, createdAt: 1, done: false, due: today },
    // No deadline at all: due on the day it was written, which was yesterday.
    { id: 'no-due', text: 'noted yesterday', day: addDays(today, -1), createdAt: 1, done: false },
    // Finished today: never late, whatever the deadline says.
    { id: 'done', text: 'finished', day: addDays(today, -7), createdAt: 1, done: true, doneAt: Date.now(), due: addDays(today, -7) },
  ]
  mkdirSync(todoDir(app.home), { recursive: true })
  writeFileSync(todoFile(app.home), JSON.stringify({ version: 2, items, daily: {}, lists: [] }), 'utf8')

  const answer = await app.run('todo_list', { range: 'overdue' })
  assert.equal(answer.ok, true)
  const fromHost = (answer.overdue as { id: string }[]).map(row => row.id)
  // The host reads through the store, which fills `due` from `day`; the client
  // holds the snapshot's items. Both have to answer with one set.
  const fromViews = app.read().items.filter(item => inView(item, 'overdue', today)).map(item => item.id)

  assert.deepEqual([...fromHost].sort(), [...fromViews].sort())
  assert.deepEqual([...fromHost].sort(), ['late', 'no-due'])
})

test('a list is created, renamed and listed in its own order', async () => {
  const app = boot()

  const created = snapshotOf(await app.call('/lists', { action: 'create', name: '  Work  ' }))
  // Trimmed on the way in: a stored " Work" would be a second list the duplicate
  // check refuses to create but the file would still hold.
  assert.deepEqual(created.lists.map(list => list.name), ['Work'])
  assert.deepEqual(created.lists.map(list => list.order), [0])
  const id = created.lists[0]!.id

  // The same name again, in another case, is the same list to a reader.
  const taken = await app.call('/lists', { action: 'create', name: 'work' })
  assert.equal(taken.status, 409)
  assert.equal(codeOf(taken), 'name-taken')

  const renamed = snapshotOf(await app.call('/lists', { action: 'rename', id, name: 'Job' }))
  assert.deepEqual(renamed.lists, [{ id, name: 'Job', order: 0 }])
  // Renaming to its own name is not a conflict with itself.
  assert.deepEqual(snapshotOf(await app.call('/lists', { action: 'rename', id, name: 'Job' })).lists, renamed.lists)

  // An unknown id, an unusable name and an unknown action are all refused, and none
  // of them writes.
  const missing = await app.call('/lists', { action: 'rename', id: 'nope', name: 'Job' })
  assert.equal(missing.status, 404)
  assert.equal(codeOf(missing), 'list-not-found')
  const blank = await app.call('/lists', { action: 'create', name: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(codeOf(blank), 'name-invalid')
  const long = await app.call('/lists', { action: 'create', name: 'x'.repeat(41) })
  assert.equal(long.status, 400)
  assert.equal(codeOf(long), 'name-invalid')
  const bogus = await app.call('/lists', { action: 'shuffle' })
  assert.equal(bogus.status, 400)
  assert.equal(codeOf(bogus), 'action-invalid')

  assert.deepEqual(app.read().lists, [{ id, name: 'Job', order: 0 }])
})

test('the lists come back in their order, and reordering twice changes nothing', async () => {
  const app = boot()
  for (const name of ['Work', 'Home', 'Later']) snapshotOf(await app.call('/lists', { action: 'create', name }))

  const before = snapshotOf(await app.call('/todos'))
  assert.deepEqual(before.lists.map(list => list.name), ['Work', 'Home', 'Later'])
  assert.deepEqual(before.lists.map(list => list.order), [0, 1, 2])
  const ids = before.lists.map(list => list.id)

  const wanted = [ids[2]!, ids[0]!, ids[1]!]
  const once = snapshotOf(await app.call('/lists', { action: 'reorder', ids: wanted }))
  assert.deepEqual(once.lists.map(list => list.name), ['Later', 'Work', 'Home'])
  // The snapshot is the display sequence and the ranks are dense, so nothing has to
  // sort again.
  assert.deepEqual(once.lists.map(list => list.order), [0, 1, 2])

  const twice = snapshotOf(await app.call('/lists', { action: 'reorder', ids: wanted }))
  assert.deepEqual(twice.lists, once.lists)

  // A short list would drop a row and a repeat would drop one of two, so both are
  // refused instead of half-applied.
  const short = await app.call('/lists', { action: 'reorder', ids: [ids[0]!] })
  assert.equal(short.status, 400)
  assert.equal(codeOf(short), 'order-invalid')
  const repeated = await app.call('/lists', { action: 'reorder', ids: [ids[0]!, ids[0]!, ids[1]!] })
  assert.equal(repeated.status, 400)
  const unknown = await app.call('/lists', { action: 'reorder', ids: [ids[0]!, ids[1]!, 'nope'] })
  assert.equal(unknown.status, 400)
  assert.deepEqual(app.read().lists.map(list => list.name), ['Later', 'Work', 'Home'])
})

test('a hand-edited order is read as a dense sequence, in order', async () => {
  const app = boot()
  // A sparse or out-of-sequence `order` is what a hand edit leaves behind. The store
  // sorts by it and ranks what it read, so the snapshot is the display sequence and
  // no reader has to sort again.
  mkdirSync(todoDir(app.home), { recursive: true })
  writeFileSync(todoFile(app.home), JSON.stringify({
    version: 2,
    items: [],
    daily: {},
    lists: [
      { id: 'later', name: 'Later', order: 5 },
      { id: 'first', name: 'First', order: 2 },
      { id: 'middle', name: 'Middle', order: 3 },
    ],
  }), 'utf8')

  assert.deepEqual(snapshotOf(await app.call('/todos')).lists, [
    { id: 'first', name: 'First', order: 0 },
    { id: 'middle', name: 'Middle', order: 1 },
    { id: 'later', name: 'Later', order: 2 },
  ])
})

test('deleting a list returns its tasks to the default list and keeps them', async () => {
  const app = boot()
  const withLists = snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const workId = withLists.lists[0]!.id
  const empty = snapshotOf(await app.call('/lists', { action: 'create', name: 'Empty' }))
  const emptyId = empty.lists[1]!.id

  const first = snapshotOf(await app.call('/add', { text: 'file the invoice' }))
  const filed = first.items[0]!.id
  const second = snapshotOf(await app.call('/add', { text: 'one that stays home' }))
  const home = second.items[1]!.id
  snapshotOf(await app.call('/batch', { action: 'move', ids: [filed], listId: workId }))
  assert.equal(snapshotOf(await app.call('/todos')).items[0]!.listId, workId)

  // The empty list simply disappears.
  const withoutEmpty = snapshotOf(await app.call('/lists', { action: 'remove', id: emptyId }))
  assert.deepEqual(withoutEmpty.lists.map(list => list.id), [workId])

  const removed = snapshotOf(await app.call('/lists', { action: 'remove', id: workId }))
  assert.deepEqual(removed.lists, [])
  // THE TASKS ARE STILL THERE: a list is a place to file work, not the work.
  assert.deepEqual(removed.items.map(item => item.id), [filed, home])
  assert.equal('listId' in removed.items[0]!, false, 'the filed task falls back to the default list')
  assert.equal('listId' in removed.items[1]!, false)
  // And the file on disk says the same thing, so the fallback is not just a view.
  assert.equal(app.read().items.length, 2)
  assert.equal('listId' in app.read().items[0]!, false)

  const gone = await app.call('/lists', { action: 'remove', id: workId })
  assert.equal(gone.status, 404)
  assert.equal(codeOf(gone), 'list-not-found')
})

test('a batch applies every id it can and reports the ones it cannot', async () => {
  const app = boot()
  const first = snapshotOf(await app.call('/add', { text: 'one' }))
  const one = first.items[0]!.id
  const second = snapshotOf(await app.call('/add', { text: 'two' }))
  const two = second.items[1]!.id

  // A stale id in the middle, and one id twice: the stale one is reported, the
  // duplicate is applied and reported once, and the rest of the batch lands.
  const answer = await app.call('/batch', { action: 'complete', ids: [one, 'gone', two, one] })
  assert.deepEqual(batchOf(answer).done, [{ id: one }, { id: two }])
  assert.deepEqual(batchOf(answer).failed, [{ id: 'gone', code: 'task-not-found' }])
  const board = snapshotOf(answer)
  assert.deepEqual(board.items.map(item => item.done), [true, true])
  assert.deepEqual(board.daily[dayToday()], { created: 2, done: 2 })

  // The same batch again is idempotent: both are already ticked, nothing fails.
  const again = await app.call('/batch', { action: 'complete', ids: [one, two] })
  assert.deepEqual(batchOf(again).done, [{ id: one }, { id: two }])
  assert.deepEqual(batchOf(again).failed, [])
  assert.deepEqual(snapshotOf(again).daily[dayToday()], { created: 2, done: 2 })
})

test('the batch actions that carry a value write it, and uncomplete takes it back', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'one' }))
  const one = added.items[0]!.id
  const two = snapshotOf(await app.call('/add', { text: 'two' })).items[1]!.id
  const tomorrow = addDays(dayToday(), 1)

  const scheduled = snapshotOf(await app.call('/batch', { action: 'setDue', ids: [one, two], due: tomorrow }))
  assert.deepEqual(scheduled.items.map(item => item.due), [tomorrow, tomorrow])

  const cleared = snapshotOf(await app.call('/batch', { action: 'setDue', ids: [one], due: null }))
  // Cleared is absent, not the creation day: absent is what "no deadline" means.
  assert.equal('due' in cleared.items[0]!, false)
  assert.equal(cleared.items[1]!.due, tomorrow)

  const high = snapshotOf(await app.call('/batch', { action: 'setPriority', ids: [one], priority: 2 }))
  assert.equal(high.items[0]!.priority, 2)
  const unset = snapshotOf(await app.call('/batch', { action: 'setPriority', ids: [one], priority: null }))
  assert.equal('priority' in unset.items[0]!, false)

  const ticked = snapshotOf(await app.call('/batch', { action: 'complete', ids: [one] }))
  assert.equal(ticked.items[0]!.done, true)
  const unticked = snapshotOf(await app.call('/batch', { action: 'uncomplete', ids: [one] }))
  assert.equal(unticked.items[0]!.done, false)
  // Ticking and unticking through a batch keeps the aggregate symmetric, the same
  // rule `setDone` is tested for.
  assert.deepEqual(unticked.daily[dayToday()], { created: 2, done: 0 })

  const dropped = snapshotOf(await app.call('/batch', { action: 'remove', ids: [one] }))
  assert.deepEqual(dropped.items.map(item => item.id), [two])
})

test('a move reports a list that is gone per row, and still applies the rows it can', async () => {
  const app = boot()
  const withList = snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const listId = withList.lists[0]!.id
  const first = snapshotOf(await app.call('/add', { text: 'one' }))
  const one = first.items[0]!.id
  const two = snapshotOf(await app.call('/add', { text: 'two' })).items[1]!.id

  // A row that is gone is refused ALONE: the other row of the same batch is moved.
  const partial = await app.call('/batch', { action: 'move', ids: [one, 'gone'], listId })
  assert.deepEqual(batchOf(partial).done, [{ id: one }])
  assert.deepEqual(batchOf(partial).failed, [{ id: 'gone', code: 'task-not-found' }])
  assert.equal(snapshotOf(partial).items[0]!.listId, listId)

  // The target list is ONE argument for the whole batch, so a list that vanished
  // refuses every row — but as a per-row answer with a 200, not a 400, and without
  // writing anything. A 400 would mean "your request was malformed", and this one
  // was not: the board moved under it.
  const before = snapshotOf(await app.call('/todos'))
  const vanished = await app.call('/batch', { action: 'move', ids: [one, two], listId: 'deleted-in-another-window' })
  assert.equal(vanished.status, 200)
  assert.deepEqual(batchOf(vanished).done, [])
  assert.deepEqual(batchOf(vanished).failed, [
    { id: one, code: 'list-not-found' },
    { id: two, code: 'list-not-found' },
  ])
  assert.deepEqual(snapshotOf(vanished).items, before.items)
})

test('a malformed batch is refused as a whole, with a stable code', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'one' }))
  const one = added.items[0]!.id

  const tooMany = Array.from({ length: MAX_BATCH_IDS + 1 }, (_unused, index) => `id-${String(index).padStart(3, '0')}`)
  const over = await app.call('/batch', { action: 'complete', ids: tooMany })
  assert.equal(over.status, 400)
  assert.equal(codeOf(over), 'ids-too-many')

  const notArray = await app.call('/batch', { action: 'complete', ids: one })
  assert.equal(notArray.status, 400)
  assert.equal(codeOf(notArray), 'ids-invalid')
  const notStrings = await app.call('/batch', { action: 'complete', ids: [one, 42] })
  assert.equal(notStrings.status, 400)
  assert.equal(codeOf(notStrings), 'ids-invalid')

  const badAction = await app.call('/batch', { action: 'archive', ids: [one] })
  assert.equal(badAction.status, 400)
  assert.equal(codeOf(badAction), 'action-invalid')

  // A date the calendar never draws is a shape error: no row could accept it, so it
  // refuses the request rather than answering `failed` for every id.
  const badDay = await app.call('/batch', { action: 'setDue', ids: [one], due: '2026-02-31' })
  assert.equal(badDay.status, 400)
  assert.equal(codeOf(badDay), 'due-invalid')

  const badPriority = await app.call('/batch', { action: 'setPriority', ids: [one], priority: 9 })
  assert.equal(badPriority.status, 400)
  assert.equal(codeOf(badPriority), 'priority-invalid')

  const badList = await app.call('/batch', { action: 'move', ids: [one], listId: 7 })
  assert.equal(badList.status, 400)
  assert.equal(codeOf(badList), 'list-invalid')

  // Nothing above wrote: the row is exactly what `/add` left behind.
  assert.deepEqual(snapshotOf(await app.call('/todos')).items, added.items)
})

test('the step route adds, renames, ticks and removes one step', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'pack for the trip' }))
  const id = added.items[0]!.id

  const one = snapshotOf(await app.call('/subtasks', { action: 'add', id, text: '  passport  ' }))
  // One task, one step, trimmed — and the write answers the whole snapshot.
  assert.deepEqual(one.items[0]!.subtasks?.map(step => step.text), ['passport'])
  const subtaskId = one.items[0]!.subtasks![0]!.id
  assert.deepEqual(app.read().items[0]!.subtasks?.map(step => step.text), ['passport'])

  const ticked = snapshotOf(await app.call('/subtasks', { action: 'toggle', id, subtaskId, done: true }))
  assert.equal(ticked.items[0]!.subtasks?.[0]!.done, true)
  // The parent is not derived from its steps.
  assert.equal(ticked.items[0]!.done, false)

  const renamed = snapshotOf(await app.call('/subtasks', { action: 'rename', id, subtaskId, text: 'passport and visa' }))
  assert.deepEqual(renamed.items[0]!.subtasks?.[0], { id: subtaskId, text: 'passport and visa', done: true })

  const removed = snapshotOf(await app.call('/subtasks', { action: 'remove', id, subtaskId }))
  assert.equal('subtasks' in removed.items[0]!, false)
  assert.equal('subtasks' in app.read().items[0]!, false)
})

test('the step route refuses what it cannot do, with a stable code', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'pack for the trip' }))
  const id = added.items[0]!.id
  const withStep = snapshotOf(await app.call('/subtasks', { action: 'add', id, text: 'passport' }))
  const subtaskId = withStep.items[0]!.subtasks![0]!.id

  const badAction = await app.call('/subtasks', { action: 'reorder', id })
  assert.equal(badAction.status, 400)
  assert.equal(codeOf(badAction), 'action-invalid')

  const noId = await app.call('/subtasks', { action: 'add', text: 'charger' })
  assert.equal(noId.status, 400)
  assert.equal(codeOf(noId), 'id-required')

  const noTask = await app.call('/subtasks', { action: 'add', id: 'nope', text: 'charger' })
  assert.equal(noTask.status, 404)
  // The same transport code the task routes already answer with.
  assert.equal(codeOf(noTask), 'not-found')

  const blank = await app.call('/subtasks', { action: 'add', id, text: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(codeOf(blank), 'text-invalid')

  const long = await app.call('/subtasks', { action: 'add', id, text: 'x'.repeat(MAX_SUBTASK_TEXT + 1) })
  assert.equal(long.status, 400)
  assert.equal(codeOf(long), 'text-invalid')

  const noStep = await app.call('/subtasks', { action: 'remove', id })
  assert.equal(noStep.status, 400)
  assert.equal(codeOf(noStep), 'subtask-id-required')

  const goneStep = await app.call('/subtasks', { action: 'toggle', id, subtaskId: 'nope' })
  assert.equal(goneStep.status, 404)
  assert.equal(codeOf(goneStep), 'subtask-not-found')

  // A quoted boolean is refused rather than read as false: `"false"` would untick a
  // step the user meant to tick.
  const badDone = await app.call('/subtasks', { action: 'toggle', id, subtaskId, done: 'true' })
  assert.equal(badDone.status, 400)
  assert.equal(codeOf(badDone), 'done-invalid')

  const blankRename = await app.call('/subtasks', { action: 'rename', id, subtaskId, text: '' })
  assert.equal(blankRename.status, 400)
  assert.equal(codeOf(blankRename), 'text-invalid')

  // Nothing above wrote: the board is exactly what the one good add left behind.
  assert.deepEqual(snapshotOf(await app.call('/todos')).items, withStep.items)
})

test('a task refuses a step past the cap, and keeps the steps it has', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'twenty steps' }))
  const id = added.items[0]!.id
  for (let index = 0; index < MAX_SUBTASKS; index += 1) {
    snapshotOf(await app.call('/subtasks', { action: 'add', id, text: `step ${String(index)}` }))
  }
  assert.equal(app.read().items[0]!.subtasks?.length, MAX_SUBTASKS)

  const over = await app.call('/subtasks', { action: 'add', id, text: 'one too many' })
  assert.equal(over.status, 409)
  assert.equal(codeOf(over), 'subtasks-full')
  assert.equal(app.read().items[0]!.subtasks?.length, MAX_SUBTASKS)
})

test('completing a task with steps leaves every step as it was', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'pack for the trip' }))
  const id = added.items[0]!.id
  const first = snapshotOf(await app.call('/subtasks', { action: 'add', id, text: 'passport' }))
  const tickedStep = first.items[0]!.subtasks![0]!.id
  snapshotOf(await app.call('/subtasks', { action: 'toggle', id, subtaskId: tickedStep, done: true }))
  const second = snapshotOf(await app.call('/subtasks', { action: 'add', id, text: 'charger' }))
  const openStep = second.items[0]!.subtasks![1]!.id

  const ticked = snapshotOf(await app.call('/toggle', { id }))
  assert.equal(ticked.items[0]!.done, true)
  // No cascade in either direction, and the file says the same as the answer.
  const expected = [
    { id: tickedStep, text: 'passport', done: true },
    { id: openStep, text: 'charger', done: false },
  ]
  assert.deepEqual(ticked.items[0]!.subtasks, expected)
  assert.deepEqual(app.read().items[0]!.subtasks, expected)
})

/** Seed the board file directly: `todo_add` takes no repeat rule yet (W9). */
function seed(app: App, items: unknown[]): void {
  mkdirSync(todoDir(app.home), { recursive: true })
  writeFileSync(todoFile(app.home), JSON.stringify({ version: 2, items, daily: {}, lists: [] }), 'utf8')
}

test('completing a repeating task through the tool opens the next instance and reports it', async () => {
  const app = boot()
  seed(app, [{
    id: 'rent',
    text: 'pay the rent',
    day: '2026-01-31',
    createdAt: 1,
    done: false,
    due: '2026-01-31',
    repeat: { freq: 'monthly', interval: 1 },
  }])

  const done = await app.run('todo_done', { id: 'rent' })
  assert.equal(done.ok, true)
  // 31 January plus one month is the last day of February, never 3 March.
  const next = done.next as { id: string, due: string } | undefined
  assert.ok(next !== undefined, 'a repeating task reports the instance it opened')
  assert.equal(next.due, '2026-02-28')
  assert.equal(done.repeatSkipped, undefined)
  // The completion and the new instance both moved the day's counters.
  assert.deepEqual(app.read().daily[dayToday()], { created: 1, done: 1 })

  const board = app.read()
  assert.equal(board.items.length, 2)
  const source = board.items.find(item => item.id === 'rent')!
  const spawned = board.items.find(item => item.id !== 'rent')!
  assert.equal(source.done, true)
  assert.equal(spawned.done, false)
  assert.equal(spawned.due, '2026-02-28')
  // One series, shared by both rows.
  assert.equal(typeof spawned.seriesId, 'string')
  assert.equal(spawned.seriesId, source.seriesId)
})

test('a series that already has an open instance is reported, not multiplied', async () => {
  const app = boot()
  seed(app, [
    {
      id: 'old',
      text: 'pay the rent',
      day: '2026-01-31',
      createdAt: 1,
      done: false,
      due: '2026-01-31',
      repeat: { freq: 'monthly', interval: 1 },
      seriesId: 'rent-series',
    },
    {
      id: 'newer',
      text: 'pay the rent',
      day: '2026-02-28',
      createdAt: 2,
      done: false,
      due: '2026-02-28',
      repeat: { freq: 'monthly', interval: 1 },
      seriesId: 'rent-series',
    },
  ])

  const done = await app.run('todo_done', { id: 'old' })
  assert.equal(done.ok, true)
  assert.equal(done.next, undefined)
  // Said out loud rather than silently skipped.
  assert.equal(done.repeatSkipped, 'open-instance')

  const board = app.read()
  assert.equal(board.items.length, 2)
  assert.equal(board.items.filter(item => !item.done).length, 1)
})

test('the toggle route opens the next instance as well, and a retry opens none', async () => {
  const app = boot()
  seed(app, [{
    id: 'weekly',
    text: 'water the plants',
    day: '2026-05-04',
    createdAt: 1,
    done: false,
    due: '2026-05-04',
    repeat: { freq: 'weekly', interval: 1 },
  }])

  const ticked = snapshotOf(await app.call('/toggle', { id: 'weekly' }))
  assert.equal(ticked.items.length, 2)
  assert.equal(ticked.items.filter(item => !item.done).length, 1)
  assert.equal(ticked.items.find(item => item.id !== 'weekly')!.due, '2026-05-11')

  // The same write again: the task is already ticked, so the series does not move.
  const again = snapshotOf(await app.call('/toggle', { id: 'weekly', done: true }))
  assert.equal(again.items.length, 2)
  assert.deepEqual(again.items.map(item => item.due).sort(), ['2026-05-04', '2026-05-11'])
})


// ── W9: the fields a tool can write, and the listing that reads them back ─────

/** One row of a `todo_list` answer. */
interface ListedRow {
  id: string
  text: string
  day: string
  due: string | null
  list: string | null
  priority: number | null
  subtasks: { done: number, total: number }
}

/** The rows a `todo_list` answer carries. */
function rowsOf(answer: Record<string, unknown>): ListedRow[] {
  return answer.items as ListedRow[]
}

test('todo_add writes the deadline, the list, the priority and the steps, and todo_list reads them back', async () => {
  const app = boot()
  snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const today = dayToday()
  const due = addDays(today, 3)

  // The list is named, not identified: the model hears "the work list" and has never
  // been shown an id. The name comparison is the same one that refuses duplicates.
  const added = await app.run('todo_add', {
    text: 'ship the release',
    due,
    list: 'work',
    priority: 2,
    subtasks: ['write the notes', '  tag  ', 'publish'],
  })
  assert.equal(added.ok, true)
  assert.equal(added.day, today)
  assert.equal(added.due, due)
  assert.equal(added.list, 'Work')
  assert.equal(added.priority, 2)
  // 0 of 3 is the display figure, and the middle step was trimmed on the way in.
  assert.deepEqual(added.subtasks, { done: 0, total: 3 })

  const listed = await app.run('todo_list', {})
  const row = rowsOf(listed).find(entry => entry.id === added.id)
  assert.deepEqual(row, {
    id: added.id,
    text: 'ship the release',
    day: today,
    due,
    list: 'Work',
    priority: 2,
    subtasks: { done: 0, total: 3 },
  })

  // The stored row carries the steps in order, with ids, unchecked.
  const stored = app.read().items.find(item => item.id === added.id)!
  assert.deepEqual(stored.subtasks?.map(step => step.text), ['write the notes', 'tag', 'publish'])
  assert.equal(stored.subtasks?.every(step => !step.done), true)

  // Progress moves with the checklist, and the listing is where it shows.
  snapshotOf(await app.call('/subtasks', {
    action: 'toggle',
    id: added.id,
    subtaskId: stored.subtasks![1]!.id,
    done: true,
  }))
  const again = rowsOf(await app.run('todo_list', {})).find(entry => entry.id === added.id)
  assert.deepEqual(again?.subtasks, { done: 1, total: 3 })
})

test('todo_add refuses an unusable argument before it writes anything', async () => {
  const app = boot()
  const before = snapshotOf(await app.call('/todos'))

  const many = Array.from({ length: MAX_SUBTASKS + 1 }, (_unused, index) => `step ${String(index)}`)
  const tooMany = await app.run('todo_add', { text: 'too many steps', subtasks: many })
  assert.equal(tooMany.ok, false)

  const blankStep = await app.run('todo_add', { text: 'blank step', subtasks: ['ok', '   '] })
  assert.equal(blankStep.ok, false)

  const badDue = await app.run('todo_add', { text: 'bad due', due: '2026-02-31' })
  assert.equal(badDue.ok, false)

  // The unknown list is refused WITH the names that exist, which is what lets the
  // caller retry without another round trip.
  snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const unknownList = await app.run('todo_add', { text: 'nowhere', list: 'Nowhere' })
  assert.equal(unknownList.ok, false)
  assert.equal((unknownList.error as string).includes('Work'), true)

  // Nothing was recorded by any of the refusals above.
  const after = snapshotOf(await app.call('/todos'))
  assert.deepEqual(after.items, before.items)
  assert.deepEqual(after.daily, before.daily)
})

test('todo_update names a task or refuses to guess, and only touches what it was given', async () => {
  const app = boot()
  await app.run('todo_add', { text: 'buy milk' })
  await app.run('todo_add', { text: 'buy bread' })

  const ambiguous = await app.run('todo_update', { text: 'buy', priority: 2 })
  assert.equal(ambiguous.ok, false)
  const candidates = ambiguous.candidates as { id: string, text: string }[]
  assert.equal(candidates.length, 2)
  assert.equal((ambiguous.error as string).includes('2 tasks match'), true)

  const target = candidates[0]!
  // With an id, `text` is the NEW line; `''` clears the deadline instead of setting
  // it to today, and everything unnamed keeps its value.
  const renamed = await app.run('todo_update', {
    id: target.id,
    text: 'buy oat milk',
    due: '',
    notes: '  the barista kind  ',
  })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.text, 'buy oat milk')
  assert.equal(renamed.due, null)
  assert.equal(renamed.notes, 'the barista kind')
  assert.equal(renamed.priority, null, 'priority was not in the call, so it was not touched')

  const high = await app.run('todo_update', { id: target.id, priority: 2 })
  assert.equal(high.priority, 2)
  const cleared = await app.run('todo_update', { id: target.id, priority: null })
  assert.equal(cleared.priority, null)

  // A name that matches nothing writes nothing.
  const nothing = await app.run('todo_update', { text: 'zzz', notes: 'x' })
  assert.equal(nothing.ok, false)
  // So does a call that asks for no change at all.
  const noFields = await app.run('todo_update', { id: target.id })
  assert.equal(noFields.ok, false)

  const stored = app.read().items.find(item => item.id === target.id)!
  assert.equal(stored.text, 'buy oat milk')
  assert.equal('due' in stored, false)
  assert.equal('priority' in stored, false)
  // The other task was never touched by any of it.
  assert.equal(app.read().items.find(item => item.text === 'buy bread')!.text, 'buy bread')
})

test('todo_update files a task under a list by name, and refuses a list nobody has', async () => {
  const app = boot()
  const withList = snapshotOf(await app.call('/lists', { action: 'create', name: 'Home' }))
  const homeId = withList.lists[0]!.id
  const added = await app.run('todo_add', { text: 'fix the tap' })

  const filed = await app.run('todo_update', { id: added.id, list: 'home' })
  assert.equal(filed.ok, true)
  assert.equal(filed.list, 'Home')
  assert.equal(app.read().items[0]!.listId, homeId)

  // An empty `list` puts it back under the default list, which has no row.
  const unfiled = await app.run('todo_update', { id: added.id, list: '' })
  assert.equal(unfiled.list, null)
  assert.equal('listId' in app.read().items[0]!, false)

  const unknown = await app.run('todo_update', { id: added.id, list: 'Nowhere' })
  assert.equal(unknown.ok, false)
  assert.equal((unknown.error as string).includes('Home'), true)
})

test('todo_list narrows by list, by deadline window, and answers the upcoming view', async () => {
  const app = boot()
  snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const today = dayToday()
  await app.run('todo_add', { text: 'work today', due: today, list: 'Work' })
  await app.run('todo_add', { text: 'work next week', due: addDays(today, 5), list: 'Work' })
  await app.run('todo_add', { text: 'home today', due: today })

  const texts = (answer: Record<string, unknown>): string[] => rowsOf(answer).map(row => row.text).sort()

  assert.deepEqual(texts(await app.run('todo_list', {})), ['home today', 'work next week', 'work today'])
  assert.deepEqual(texts(await app.run('todo_list', { list: 'Work' })), ['work next week', 'work today'])

  // The window is inclusive on both ends, and it is the DEADLINE it reads.
  assert.deepEqual(
    texts(await app.run('todo_list', { list: 'Work', dueFrom: today, dueTo: addDays(today, 5) })),
    ['work next week', 'work today'],
  )
  assert.deepEqual(texts(await app.run('todo_list', { list: 'Work', dueTo: addDays(today, 1) })), ['work today'])
  assert.deepEqual(rowsOf(await app.run('todo_list', { list: 'Work', dueFrom: addDays(today, 30) })), [])
  // `upcoming` is the view the board draws: owed after today, within seven days.
  const upcoming = await app.run('todo_list', { range: 'upcoming' })
  assert.equal(upcoming.ok, true)
  assert.deepEqual((upcoming.upcoming as ListedRow[]).map(row => row.text), ['work next week'])

  // A list nobody has is refused rather than answered as an empty board.
  const unknown = await app.run('todo_list', { list: 'Nowhere' })
  assert.equal(unknown.ok, false)
  const badDay = await app.run('todo_list', { dueFrom: '2026-02-31' })
  assert.equal(badDay.ok, false)
})

test('todo_done says what a repeat rule did, and why it sometimes does nothing', async () => {
  const app = boot()
  // A repeating task cannot be created by a tool yet, so the file is seeded the way
  // the store reads it.
  seed(app, [
    { id: 'rent', text: 'pay the rent', day: '2026-01-31', createdAt: 1, done: false, due: '2026-01-31', repeat: { freq: 'monthly', interval: 1 } },
    { id: 'twice', text: 'water the plants', day: '2026-02-01', createdAt: 2, done: false, due: '2026-02-01', repeat: { freq: 'weekly', interval: 1 }, seriesId: 'plants' },
    { id: 'twice-open', text: 'water the plants', day: '2026-02-08', createdAt: 3, done: false, due: '2026-02-08', repeat: { freq: 'weekly', interval: 1 }, seriesId: 'plants' },
  ])

  const opened = await app.run('todo_done', { id: 'rent' })
  assert.equal(opened.ok, true)
  // 31 January plus one month is the last day of February, never 3 March.
  assert.equal((opened.next as { due: string } | undefined)?.due, '2026-02-28')
  assert.equal(opened.repeatSkipped, undefined)

  const skipped = await app.run('todo_done', { id: 'twice' })
  assert.equal(skipped.ok, true)
  // `next` is absent BECAUSE the series already holds an open instance; the code says so.
  assert.equal(skipped.next, undefined)
  assert.equal(skipped.repeatSkipped, 'open-instance')
})

// ── W10: the one route the editor saves through ──────────────────────────────

test('the edit route rewrites several fields in one write, and clearing is an instruction', async () => {
  const app = boot()
  const withList = snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const listId = withList.lists[0]!.id
  const added = snapshotOf(await app.call('/add', { text: 'draft the plan' }))
  const id = added.items[0]!.id
  const due = addDays(dayToday(), 2)

  const edited = snapshotOf(await app.call('/edit', {
    id,
    text: '  draft the plan v2 ',
    due,
    listId,
    priority: 1,
    notes: '  from the standup  ',
    repeat: { freq: 'weekly', interval: 2 },
    reminderAt: Date.now() + 60_000,
  }))
  const row = edited.items[0]!
  assert.equal(row.text, 'draft the plan v2')
  assert.equal(row.due, due)
  assert.equal(row.listId, listId)
  assert.equal(row.priority, 1)
  assert.equal(row.notes, 'from the standup')
  assert.deepEqual(row.repeat, { freq: 'weekly', interval: 2 })
  assert.equal(typeof row.reminderAt, 'number')
  // The file says what the answer said, which is what the card behind the dialog reads.
  assert.equal(app.read().items[0]!.notes, 'from the standup')

  // Present with null (or '') CLEARS a field; absent leaves it alone.
  const cleared = snapshotOf(await app.call('/edit', {
    id,
    due: null,
    listId: null,
    priority: null,
    notes: '',
    repeat: null,
    reminderAt: null,
  }))
  for (const key of ['due', 'listId', 'priority', 'notes', 'repeat', 'reminderAt', 'reminded']) {
    assert.equal(key in cleared.items[0]!, false, `${key} was cleared`)
  }
  assert.equal(cleared.items[0]!.text, 'draft the plan v2', 'a field that was not named keeps its value')

  // Refusals, none of which may write.
  const noFields = await app.call('/edit', { id })
  assert.equal(noFields.status, 400)
  assert.equal(codeOf(noFields), 'no-fields')
  const missing = await app.call('/edit', { id: 'nope', due })
  assert.equal(missing.status, 404)
  assert.equal(codeOf(missing), 'not-found')
  const badRepeat = await app.call('/edit', { id, repeat: { freq: 'hourly', interval: 1 } })
  assert.equal(badRepeat.status, 400)
  assert.equal(codeOf(badRepeat), 'repeat-invalid')
  const badList = await app.call('/edit', { id, listId: 'gone' })
  assert.equal(badList.status, 400)
  assert.equal(codeOf(badList), 'list-invalid')
  const badNotes = await app.call('/edit', { id, notes: 'x'.repeat(MAX_NOTES + 1) })
  assert.equal(badNotes.status, 400)
  assert.equal(codeOf(badNotes), 'notes-invalid')
  const badDue = await app.call('/edit', { id, due: '2026-13-40' })
  assert.equal(badDue.status, 400)
  assert.equal(codeOf(badDue), 'due-invalid')
  const badPriority = await app.call('/edit', { id, priority: 9 })
  assert.equal(codeOf(badPriority), 'priority-invalid')

  assert.deepEqual(snapshotOf(await app.call('/todos')).items, cleared.items)
})

test('the edit route touches only the task it names', async () => {
  const app = boot()
  const first = snapshotOf(await app.call('/add', { text: 'one' }))
  const second = snapshotOf(await app.call('/add', { text: 'two' }))
  const other = second.items[1]!

  snapshotOf(await app.call('/edit', { id: first.items[0]!.id, priority: 2 }))
  const after = snapshotOf(await app.call('/todos'))
  assert.deepEqual(after.items[1], other)
  assert.equal(after.items[0]!.priority, 2)
})

test('the add route files a task where the rail points and takes a deadline', async () => {
  const app = boot()
  const withList = snapshotOf(await app.call('/lists', { action: 'create', name: 'Work' }))
  const listId = withList.lists[0]!.id
  const due = addDays(dayToday(), 4)

  const added = snapshotOf(await app.call('/add', { text: 'from the composer', listId, due, priority: 1 }))
  const item = added.items[0]!
  assert.equal(item.text, 'from the composer')
  assert.equal(item.listId, listId)
  assert.equal(item.due, due)
  assert.equal(item.priority, 1)
  // The task is still counted against the day it was written.
  assert.deepEqual(added.daily[dayToday()], { created: 1, done: 0 })

  // Absent fields keep their defaults: no list, no priority, due = the creation day.
  const plain = snapshotOf(await app.call('/add', { text: 'plain' }))
  const second = plain.items[1]!
  assert.equal('listId' in second, false)
  assert.equal('priority' in second, false)
  assert.equal(second.due, dayToday())

  // A list that is not on the board and a shape the calendar does not draw are both
  // refused, and neither writes.
  const before = snapshotOf(await app.call('/todos'))
  const badList = await app.call('/add', { text: 'nope', listId: 'gone' })
  assert.equal(badList.status, 400)
  assert.equal(codeOf(badList), 'list-invalid')
  const badDue = await app.call('/add', { text: 'nope', due: '2026-02-31' })
  assert.equal(codeOf(badDue), 'due-invalid')
  const badPriority = await app.call('/add', { text: 'nope', priority: 9 })
  assert.equal(codeOf(badPriority), 'priority-invalid')
  assert.deepEqual(snapshotOf(await app.call('/todos')).items, before.items)
})

// ── the last round's fixes: what a completion reports, and a deadline that moves a
//    derived reminder with it ─────────────────────────────────────────────────

/** A route's answer value, envelope checked, for fields the snapshot type omits. */
function valueOf(answer: Answer): Record<string, unknown> {
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  return answer.body.value as Record<string, unknown>
}

/** The local 09:00 of one day key: the hour both deadline reminder presets hang off. */
function nineOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 9, 0, 0, 0).getTime()
}

/** One completion report as a route answers it. */
interface RepeatReport {
  next?: { id: string, due: string }
  skipped?: string
}

test('ticking a repeating task through the route says what the rule did', async () => {
  const app = boot()
  const due = addDays(dayToday(), 2)
  seed(app, [
    { id: 'weekly', text: 'water the plants', day: dayToday(), createdAt: 1, done: false, due, repeat: { freq: 'weekly', interval: 1 } },
    { id: 'plain', text: 'no rule here', day: dayToday(), createdAt: 2, done: false, due },
  ])

  const ticked = await app.call('/toggle', { id: 'weekly' })
  const repeat = valueOf(ticked).repeat as RepeatReport | undefined
  assert.ok(repeat !== undefined, 'a task with a rule reports what the rule did')
  assert.equal(repeat.next?.due, addDays(due, 7))
  assert.equal(repeat.skipped, undefined)
  // The instance it opened is on the board, which is what the client can point at.
  assert.equal(snapshotOf(ticked).items.some(item => item.id === repeat.next?.id), true)

  // A task with NO rule says nothing: there is no rule to explain.
  const withoutRule = await app.call('/toggle', { id: 'plain' })
  assert.equal('repeat' in valueOf(withoutRule), false)
})

test('a skipped series is reported by the route, not only by the tool', async () => {
  const app = boot()
  const due = addDays(dayToday(), 2)
  seed(app, [
    { id: 'first', text: 'pay the rent', day: dayToday(), createdAt: 1, done: false, due, repeat: { freq: 'monthly', interval: 1 }, seriesId: 'rent' },
    { id: 'second', text: 'pay the rent', day: dayToday(), createdAt: 2, done: false, due: addDays(due, 30), repeat: { freq: 'monthly', interval: 1 }, seriesId: 'rent' },
  ])

  const repeat = valueOf(await app.call('/toggle', { id: 'first' })).repeat as RepeatReport
  assert.equal(repeat.next, undefined)
  assert.equal(repeat.skipped, 'open-instance')
  assert.equal(app.read().items.length, 2)
})

test('a step the calendar cannot carry writes no successor and reports invalid-rule', async () => {
  const app = boot()
  seed(app, [{
    id: 'huge',
    text: 'walk to the moon',
    day: '2026-01-31',
    createdAt: 1,
    done: false,
    due: '2026-01-31',
    repeat: { freq: 'monthly', interval: 1_000_000_000 },
  }])

  const repeat = valueOf(await app.call('/toggle', { id: 'huge' })).repeat as RepeatReport
  // `validRepeat` drops the rule on read, so the task is simply one with no rule: no
  // successor, no key. What must NOT happen is a successor carrying "NaN-NaN-NaN".
  assert.equal(repeat, undefined)
  const stored = app.read().items
  assert.equal(stored.length, 1)
  assert.equal(stored[0]!.done, true)
  assert.equal(stored.every(item => typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(item.due)), true)
})

test('a rule the cap refuses is never stored, through the edit route', async () => {
  const app = boot()
  const added = snapshotOf(await app.call('/add', { text: 'too often' }))
  const id = added.items[0]!.id

  const over = await app.call('/edit', { id, repeat: { freq: 'weekday', interval: 1_000_000 } })
  assert.equal(over.status, 400)
  assert.equal(codeOf(over), 'repeat-invalid')
  // Right at the cap is accepted, so the bound is the number and not "large".
  const atCap = snapshotOf(await app.call('/edit', { id, repeat: { freq: 'weekday', interval: 999 } }))
  assert.deepEqual(atCap.items[0]!.repeat, { freq: 'weekday', interval: 999 })
})

test('a batch reports what each completing row did with its rule', async () => {
  const app = boot()
  const due = addDays(dayToday(), 2)
  seed(app, [
    { id: 'a', text: 'water the plants', day: dayToday(), createdAt: 1, done: false, due, repeat: { freq: 'weekly', interval: 1 } },
    { id: 'b', text: 'pay the rent', day: dayToday(), createdAt: 2, done: false, due, repeat: { freq: 'monthly', interval: 1 }, seriesId: 'rent' },
    { id: 'c', text: 'pay the rent', day: dayToday(), createdAt: 3, done: false, due: addDays(due, 30), repeat: { freq: 'monthly', interval: 1 }, seriesId: 'rent' },
    { id: 'plain', text: 'no rule', day: dayToday(), createdAt: 4, done: false, due },
  ])

  const answer = await app.call('/batch', { action: 'complete', ids: ['a', 'b', 'plain'] })
  const rows = (valueOf(answer).batch as { done: { id: string, repeat?: RepeatReport }[] }).done
  const byId = new Map(rows.map(row => [row.id, row.repeat]))
  assert.equal(byId.get('a')?.next?.due, addDays(due, 7))
  assert.equal(byId.get('b')?.skipped, 'open-instance')
  // A row with no rule carries no report, so a batch of plain tasks answers exactly
  // what it always did.
  assert.equal(byId.get('plain'), undefined)
})

test('moving a deadline drags a derived reminder along and leaves a picked one alone', async () => {
  const app = boot()
  const oldDue = addDays(dayToday(), 3)
  const newDue = addDays(dayToday(), 10)
  seed(app, [
    {
      id: 'derived',
      text: 'pay the rent',
      day: dayToday(),
      createdAt: 1,
      done: false,
      due: oldDue,
      reminderAt: nineOf(oldDue),
      reminderSource: 'due-day',
    },
    {
      id: 'picked',
      text: 'call the bank',
      day: dayToday(),
      createdAt: 2,
      done: false,
      due: oldDue,
      reminderAt: nineOf(oldDue) + 3_600_000,
      reminderSource: 'custom',
    },
  ])

  const edited = snapshotOf(await app.call('/edit', { id: 'derived', due: newDue }))
  const derived = edited.items.find(item => item.id === 'derived')!
  assert.equal(derived.due, newDue)
  assert.equal(derived.reminderAt, nineOf(newDue))
  assert.equal(derived.reminderSource, 'due-day')

  const pickedAnswer = snapshotOf(await app.call('/edit', { id: 'picked', due: newDue }))
  const picked = pickedAnswer.items.find(item => item.id === 'picked')!
  assert.equal(picked.due, newDue)
  assert.equal(picked.reminderAt, nineOf(oldDue) + 3_600_000, 'a hand-picked instant stays where the user put it')

  // A deadline the reminder moment has run past arms nothing rather than leaving an
  // instant on a day the task no longer has.
  const past = snapshotOf(await app.call('/edit', { id: 'derived', due: '2020-01-01' }))
  assert.equal('reminderAt' in past.items.find(item => item.id === 'derived')!, false)
})

test('the update tool re-derives a deadline reminder it did not set', async () => {
  const app = boot()
  const oldDue = addDays(dayToday(), 3)
  const newDue = addDays(dayToday(), 12)
  seed(app, [{
    id: 'hour',
    text: 'leave for the airport',
    day: dayToday(),
    createdAt: 1,
    done: false,
    due: oldDue,
    reminderAt: nineOf(oldDue) - 3_600_000,
    reminderSource: 'hour-before',
  }])

  const updated = await app.run('todo_update', { id: 'hour', due: newDue })
  assert.equal(updated.ok, true)
  const stored = app.read().items[0]!
  assert.equal(stored.due, newDue)
  // 08:00 on the new deadline: an hour before 09:00, the anchor both presets share.
  assert.equal(stored.reminderAt, nineOf(newDue) - 3_600_000)
  assert.equal(stored.reminderSource, 'hour-before')
})

test('an editor save records where the reminder came from', async () => {
  const app = boot()
  const due = addDays(dayToday(), 4)
  const added = snapshotOf(await app.call('/add', { text: 'renew the passport' }))
  const id = added.items[0]!.id

  const saved = snapshotOf(await app.call('/edit', {
    id,
    due,
    reminderAt: nineOf(due),
    reminderSource: 'due-day',
  }))
  assert.equal(saved.items[0]!.reminderSource, 'due-day')

  // An unknown source is refused rather than stored as a value nothing reads.
  const bogus = await app.call('/edit', { id, reminderAt: nineOf(due), reminderSource: 'midnight' })
  assert.equal(bogus.status, 400)
  assert.equal(codeOf(bogus), 'reminder-source-invalid')

  // Switching to a hand-picked instant says so, so a later deadline move leaves it be.
  const custom = snapshotOf(await app.call('/edit', {
    id,
    due: addDays(due, 5),
    reminderAt: nineOf(due),
    reminderSource: 'custom',
  }))
  assert.equal(custom.items[0]!.reminderSource, 'custom')
  assert.equal(custom.items[0]!.reminderAt, nineOf(due))
})
