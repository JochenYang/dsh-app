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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { todoFile, type TodoFile } from '../src/store.ts'
import { ROUTE_PREFIX } from '../src/wire.ts'

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
  items: { id: string, text: string, day: string, done: boolean }[]
  daily: Record<string, { created: number, done: number }>
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

test('apply registers one read route and three write routes', async () => {
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
