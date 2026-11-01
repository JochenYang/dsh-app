/**
 * DSH APP todo board — host half.
 *
 * One JSON file under `$DSH_HOME/storages/dsh-app-plugin-todo/`, four routes the
 * workbench card reads and writes, and three tools so a task can be recorded or
 * ticked from a conversation. Both faces read the same file, which is the point:
 * the model writes what the card then shows, and the statistics the page renders
 * are the aggregate the tools also move.
 *
 * The routes answer the WHOLE snapshot (items + daily) after every write rather
 * than a patch. The file is bounded by construction — open tasks plus ninety days
 * of finished ones, and one number pair per day — so one shape is cheaper to trust
 * than a diff protocol that has to be kept in step on both sides.
 *
 * @module @dsh-app/plugin-todo
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the connection Context merge (ctx.connection) into scope. The
// web server is deliberately NOT injected — the desktop host disables its
// `webserver` row, so a plugin that waits for it never activates at all.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the tools Context merge (ctx.tools).
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  addTodo,
  dayKey,
  loadTodos,
  pruneDetail,
  removeTodo,
  saveTodos,
  setDone,
  statsFor,
  updateReminder,
  validDay,
  validText,
  type TodoDayStat,
  type TodoFile,
  type TodoItem,
} from './store.ts'

/** Log scope name. */
const NAME = 'todo'

/** The services this host half needs: routes and tools. */
export const inject = ['connection', 'tools']

import { ROUTE_PREFIX, type TodoSnapshot } from './wire.ts'

/** Request body cap. The largest body here is one task line. */
const MAX_BODY_BYTES = 8_192

/** The coded message shape every host half speaks. */
interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly text?: string
}

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * Failure answer. `code` is the transport-ish category; `host` is the coded
 * message the UI renders in its own language; `message` stays an English
 * diagnostic for logs.
 */
function fail(status: number, code: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code, message: host.text ?? host.code, host } })
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

function snapshotOf(file: TodoFile, now: number): TodoSnapshot {
  return { today: dayKey(now), items: file.items, daily: file.daily }
}

/**
 * Register the five routes: the board, add, toggle, remove, and the reminder.
 * @param ctx - the host context.
 * @param home - the `$DSH_HOME` the file lives under.
 * @param log - diagnostic sink.
 * @returns the disposer.
 */
function registerRoutes(ctx: Context, home: string, log: { info(message: string): void, warn(message: string): void }): () => void {
  const read = (): TodoFile => loadTodos(home, message => log.warn(message))

  const list = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/todos`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const now = Date.now()
      const file = pruneDetail(read(), now)
      return ok(snapshotOf(file, now))
    },
  })

  const add = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/add`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const text = validText(body.text)
      if (text === null) {
        return fail(400, 'text-required', { code: 'route.textRequired', text: 'text must be a non-empty string of at most 500 characters' })
      }
      // An absent `day` means today, which is what the composer under 今天 sends;
      // a day the calendar selected travels explicitly.
      const day = body.day === undefined ? null : validDay(body.day)
      if (body.day !== undefined && day === null) {
        return fail(400, 'day-invalid', { code: 'route.dayInvalid', text: 'day must be a real local date, YYYY-MM-DD' })
      }
      const reminderAt = typeof body.reminderAt === 'number' && Number.isFinite(body.reminderAt) ? Math.floor(body.reminderAt) : undefined
      const now = Date.now()
      const current = pruneDetail(read(), now)
      const { file } = addTodo(current, text, now, randomUUID(), day ?? undefined, reminderAt)
      saveTodos(home, file)
      return ok(snapshotOf(file, now))
    },
  })

  const toggle = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/toggle`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const id = body.id
      if (typeof id !== 'string' || id === '') {
        return fail(400, 'id-required', { code: 'route.idRequired', text: 'id is required' })
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      const next = setDone(current, id, body.done !== false, now)
      if (next === undefined) {
        return fail(404, 'not-found', { code: 'route.taskNotFound', params: { id }, text: `no task with id "${id}"` })
      }
      saveTodos(home, next.file)
      return ok(snapshotOf(next.file, now))
    },
  })

  const remove = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/remove`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const id = body.id
      if (typeof id !== 'string' || id === '') {
        return fail(400, 'id-required', { code: 'route.idRequired', text: 'id is required' })
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      const file = removeTodo(current, id)
      if (file !== current) saveTodos(home, file)
      return ok(snapshotOf(file, now))
    },
  })

  const remind = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/remind`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const id = body.id
      if (typeof id !== 'string' || id === '') {
        return fail(400, 'id-required', { code: 'route.idRequired', text: 'id is required' })
      }
      const reminderAt = typeof body.reminderAt === 'number' && Number.isFinite(body.reminderAt) ? Math.floor(body.reminderAt) : undefined
      // Absent flag means "clear", the same answer the picker's 清除 gets. A bare
      // { id } must not silently mean "mark as seen" — that default used to be the
      // other way round and it is what turned the toast's close into a deletion.
      const reminded = body.reminded === true
      const now = Date.now()
      const current = pruneDetail(read(), now)
      if (!current.items.some(item => item.id === id)) {
        return fail(404, 'not-found', { code: 'route.taskNotFound', params: { id }, text: `no task with id "${id}"` })
      }
      const file = updateReminder(current, id, reminderAt, reminded)
      saveTodos(home, file)
      return ok(snapshotOf(file, now))
    },
  })

  return () => {
    list()
    add()
    toggle()
    remove()
    remind()
  }
}

/** The last `count` day keys ending today, oldest first. */
function recentDays(now: number, count: number): string[] {
  const out: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    out.push(dayKey(now - offset * 24 * 60 * 60 * 1000))
  }
  return out
}

/**
 * Register the three tools.
 * @param ctx - the host context.
 * @param home - the `$DSH_HOME` the file lives under.
 * @param log - diagnostic sink.
 * @returns the disposer.
 */
function registerTools(ctx: Context, home: string, log: { info(message: string): void, warn(message: string): void }): () => void {
  const read = (): TodoFile => loadTodos(home, message => log.warn(message))

  const add = ctx.tools.register(defineTool({
    name: 'todo_add',
    description:
      'Record one task on the user\'s todo board (the workbench card). Use it when the user asks you to note '
      + 'something down for later ("remind me", "note this down", "add it to my list"), not for steps of the '
      + 'current task, which belong in your own plan. The board is shared with the card the user sees, so the '
      + 'text should read as a task they will recognise tomorrow. Pass `day` when the task belongs to another '
      + 'day — "tomorrow", "next Monday" — resolved against today\'s date.',
    parameters: {
      text: { type: 'string', required: true, description: 'One task line, at most 500 characters.' },
      day: { type: 'string', description: 'Local day the task belongs to, YYYY-MM-DD. Defaults to today.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args): Promise<JsonValue> {
      const text = validText(args.text)
      if (text === null) {
        return { ok: false, error: 'text must be a non-empty string of at most 500 characters' }
      }
      const day = args.day === undefined ? null : validDay(args.day)
      if (args.day !== undefined && day === null) {
        return { ok: false, error: 'day must be a real local date, YYYY-MM-DD' }
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      const { file, item } = addTodo(current, text, now, randomUUID(), day ?? undefined)
      saveTodos(home, file)
      return { ok: true, id: item.id, text: item.text, day: item.day }
    },
  }))

  const done = ctx.tools.register(defineTool({
    name: 'todo_done',
    description:
      'Tick (or untick) one task on the todo board. Pass `id` when you have it, otherwise `text` is matched as a '
      + 'case-insensitive substring over the OPEN tasks — several matches are reported back for you to name, '
      + 'never guessed. Ticking moves the day\'s completed count; unticking takes it back off the same day.',
    parameters: {
      id: { type: 'string', description: 'The task id, when a previous todo_add or todo_list returned it.' },
      text: { type: 'string', description: 'Substring of the task line, used when the id is unknown.' },
      done: { type: 'boolean', description: 'Defaults to true (tick). Pass false to untick.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args): Promise<JsonValue> {
      const wantDone = args.done !== false
      const now = Date.now()
      const current = pruneDetail(read(), now)
      let target: TodoItem | undefined
      if (typeof args.id === 'string' && args.id !== '') {
        target = current.items.find(item => item.id === args.id)
        if (target === undefined) return { ok: false, error: `no task with id "${args.id}"` }
      } else if (typeof args.text === 'string' && args.text.trim() !== '') {
        const needle = args.text.trim().toLowerCase()
        const hits = current.items.filter(item => item.done !== wantDone && item.text.toLowerCase().includes(needle))
        if (hits.length === 0) {
          return { ok: false, error: `no ${wantDone ? 'open' : 'finished'} task contains "${args.text.trim()}"` }
        }
        if (hits.length > 1) {
          return {
            ok: false,
            error: `${String(hits.length)} tasks match; pass one of these ids`,
            candidates: hits.map(item => ({ id: item.id, text: item.text })),
          }
        }
        target = hits[0]
      } else {
        return { ok: false, error: 'pass either id or text' }
      }
      const next = setDone(current, target.id, wantDone, now)
      if (next === undefined) return { ok: false, error: 'the task disappeared' }
      saveTodos(home, next.file)
      return { ok: true, id: next.item.id, text: next.item.text, done: next.item.done }
    },
  }))

  const list = ctx.tools.register(defineTool({
    name: 'todo_list',
    description:
      'Read the todo board. The default range is today: the open tasks plus the ones completed today, with the '
      + 'day\'s counts. `week` adds the last seven days\' created/completed numbers, and `overdue` returns only '
      + 'tasks created before today that are still open.',
    parameters: {
      range: {
        type: 'string',
        enum: ['today', 'week', 'overdue'],
        description: 'What to answer: today (default), week, or overdue.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args): Promise<JsonValue> {
      const now = Date.now()
      const file = pruneDetail(read(), now)
      const today = dayKey(now)
      const open = file.items.filter(item => !item.done)
      const doneToday = file.items.filter(item => item.done && dayKey(item.doneAt ?? item.createdAt) === today)
      const range = typeof args.range === 'string' ? args.range : 'today'
      if (range === 'overdue') {
        const overdue = open.filter(item => item.day < today)
        return { ok: true, overdue: overdue.map(item => ({ id: item.id, text: item.text, day: item.day })) }
      }
      const todayCount = statsFor(file, [today])[0] ?? { created: 0, done: 0 }
      if (range === 'week') {
        const days = recentDays(now, 7)
        const stats = statsFor(file, days)
        return {
          ok: true,
          today: { date: today, open: open.length, completed: doneToday.length, created: todayCount.created },
          items: open.map(item => ({ id: item.id, text: item.text, day: item.day })),
          week: days.map((day, index) => ({ day, ...stats[index]! })),
        }
      }
      return {
        ok: true,
        today: { date: today, open: open.length, completed: doneToday.length, created: todayCount.created },
        items: open.map(item => ({ id: item.id, text: item.text, day: item.day })),
        completedToday: doneToday.map(item => ({ id: item.id, text: item.text })),
      }
    },
  }))

  return () => {
    add()
    done()
    list()
  }
}

/**
 * Host apply: the routes and the tools, both rebuilt on every activation.
 * @param ctx - the host context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(NAME)
  const home = resolveDshHome()
  ctx.effect(() => registerRoutes(ctx, home, log), `${NAME}: routes`)
  ctx.effect(() => registerTools(ctx, home, log), `${NAME}: tools`)
}
