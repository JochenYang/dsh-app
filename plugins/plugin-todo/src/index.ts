/**
 * DSH APP todo board — host half.
 *
 * One JSON file under `$DSH_HOME/storages/dsh-app-plugin-todo/`, nine routes the
 * workbench card reads and writes, and four tools so a task can be recorded, edited
 * or ticked from a conversation. Both faces read the same file, which is the point:
 * the model writes what the card then shows, and the statistics the page renders
 * are the aggregate the tools also move.
 *
 * The routes answer the WHOLE snapshot (items, daily, lists) after every write
 * rather than a patch, so a step added to a task (`POST /subtasks`) and the open
 * instance a repeat rule just opened (`POST /toggle`, `POST /batch`) both arrive
 * without a diff protocol to keep in step; `POST /batch` adds one result per row on
 * top of the snapshot.
 * The file is bounded by construction — open tasks plus ninety days of finished
 * ones, one number pair per day, and the user's own lists — so one shape is cheaper
 * to trust than a diff protocol that has to be kept in step on both sides.
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
  MAX_LIST_NAME,
  MAX_NOTES,
  MAX_SUBTASKS,
  MAX_SUBTASK_TEXT,
  addList,
  addSubtask,
  addTodo,
  applyEdit,
  completeTodo,
  dayKey,
  findList,
  listNameTaken,
  loadTodos,
  moveTodo,
  pruneDetail,
  removeList,
  removeSubtask,
  removeTodo,
  renameList,
  renameSubtask,
  reorderLists,
  retimeDueReminder,
  saveTodos,
  setDone,
  setDue,
  setPriority,
  setSubtaskDone,
  statsFor,
  updateReminder,
  validDay,
  validListName,
  validPriority,
  validReminderSource,
  validRepeat,
  validSubtaskText,
  validText,
  type Completion,
  type ReminderSource,
  type TodoDayStat,
  type TodoEdit,
  type TodoFile,
  type TodoItem,
} from './store.ts'

/** Log scope name. */
const NAME = 'todo'

/** The services this host half needs: routes and tools. */
export const inject = ['connection', 'tools']

import { MAX_REPEAT_INTERVAL, ROUTE_PREFIX, type BatchOutcome, type CompletionReport, type TodoSnapshot } from './wire.ts'
import { addDays, dueDay, inView, subtaskProgress } from './views.ts'

/** Request body cap. The largest body here is one task line, or one batch of ids. */
const MAX_BODY_BYTES = 8_192

/** The batch actions, by the name a request carries. */
const BATCH_ACTIONS = ['complete', 'uncomplete', 'move', 'setPriority', 'setDue', 'remove'] as const

/** One batch action. */
type BatchAction = typeof BATCH_ACTIONS[number]

/**
 * The step actions, by the name a request carries.
 *
 * `toggle` takes an explicit `done` rather than flipping whatever the file holds:
 * a flip cannot be retried safely, and a dropped response would leave the user
 * unable to tell which way the step ended up.
 */
const SUBTASK_ACTIONS = ['add', 'remove', 'rename', 'toggle'] as const

/**
 * Most ids one batch takes.
 *
 * Bounded on purpose: a batch is a selection the user made on one screen, not a bulk
 * import, and an unbounded id list is a walk over the whole store per request. 100
 * ids are about 3.8 KB on the wire, which leaves room for the action and its
 * argument inside {@link MAX_BODY_BYTES}. Exported so the suite can ask for one more
 * instead of restating the number.
 */
export const MAX_BATCH_IDS = 100

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
  return { today: dayKey(now), items: file.items, daily: file.daily, lists: file.lists }
}

/**
 * What one completion did with a repeat rule, in the shape the routes and the client
 * share ({@link CompletionReport}).
 *
 * `undefined` when the task had no rule: the answer then carries no `repeat` key at
 * all, which is the ordinary case and means there is nothing to explain. A task WITH a
 * rule always answers something — the instance it opened, or why it opened none — so a
 * user who ticks a routine and sees no successor is told which of the two happened
 * instead of guessing.
 *
 * @param completion - what `store.ts` `completeTodo` reported.
 */
function completionReport(completion: Completion): CompletionReport | undefined {
  if (completion.next === undefined && completion.skipped === undefined) return undefined
  return {
    ...(completion.next === undefined ? {} : { next: { id: completion.next.id, due: dueDay(completion.next) } }),
    ...(completion.skipped === undefined ? {} : { skipped: completion.skipped }),
  }
}

/** A batch row's shared argument, already validated by the route. */
interface BatchEdit {
  readonly listId?: string
  readonly priority?: 0 | 1 | 2
  readonly due?: string
}

/** One batch row's result: the file after it, or the code that refused that id. */
type BatchStep =
  | { readonly file: TodoFile, readonly repeat?: CompletionReport }
  | { readonly code: string }

/**
 * The ids of a batch, once each, in the order the request sent them.
 *
 * Repeated ids are dropped rather than applied twice: "tick these" is idempotent,
 * but a doubled id in a batch that also counts rows (the `done` list) would report
 * one task twice. An empty list is accepted and answers an empty outcome — a client
 * that filtered its selection down to nothing asked for nothing.
 *
 * @returns the ids, or `null` when `value` is not an array of non-empty strings.
 */
function dedupeIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') return null
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

/**
 * The refusal a list id that is not on the board gets.
 *
 * One function because rename and remove answer it identically, and a 404 with a
 * code the client maps is the whole message.
 */
function listNotFound(id: string): Response {
  return fail(404, 'list-not-found', {
    code: 'route.listNotFound',
    params: { id },
    text: `no list with id "${id}"`,
  })
}

/**
 * The refusal a list name the rail cannot draw gets.
 *
 * Its own function because create and rename answer it identically, and the two
 * places that ask must not drift in their code or their limit.
 */
function listNameInvalid(): Response {
  return fail(400, 'name-invalid', {
    code: 'route.listNameInvalid',
    params: { limit: MAX_LIST_NAME },
    text: `name must be 1-${String(MAX_LIST_NAME)} characters`,
  })
}

/**
 * The refusal a task id that is not on the board gets.
 *
 * One function because the toggle, the reminder and the step routes answer it
 * identically, and three copies of the body drift in their code or their params.
 */
function taskNotFound(id: string): Response {
  return fail(404, 'not-found', { code: 'route.taskNotFound', params: { id }, text: `no task with id "${id}"` })
}

/** The refusal a step id that is not on its task gets. */
function subtaskNotFound(taskId: string, subtaskId: string): Response {
  return fail(404, 'subtask-not-found', {
    code: 'route.subtaskNotFound',
    params: { id: subtaskId, taskId },
    text: `no step with id "${subtaskId}" on task "${taskId}"`,
  })
}

/**
 * The refusal a step text the checklist cannot draw gets.
 *
 * One function because add and rename answer it identically, and the two places that
 * ask must not drift in their code or their limit.
 */
function subtaskTextInvalid(): Response {
  return fail(400, 'text-invalid', {
    code: 'route.subtaskTextInvalid',
    params: { limit: MAX_SUBTASK_TEXT },
    text: `a step is 1-${String(MAX_SUBTASK_TEXT)} characters`,
  })
}

/**
 * Apply one row of a batch.
 *
 * Only STATE failures are per-row — an id that is not on the board, a list that is
 * gone — and each leaves the rows before it applied. A malformed shared argument
 * (a date, a priority, an action) refuses the whole REQUEST in the route instead,
 * because a format cannot become valid halfway down a loop while a task id can be
 * deleted in another window between two rows.
 */
function batchRow(file: TodoFile, action: BatchAction, id: string, edit: BatchEdit, now: number): BatchStep {
  if (action === 'complete') {
    // One store function decides "tick, and open the next instance", so a batch and
    // `/toggle` cannot disagree about a series (`store.ts` `completeTodo`).
    const done = completeTodo(file, id, now, { task: randomUUID(), series: randomUUID() })
    if (done === undefined) return { code: 'task-not-found' }
    const repeat = completionReport(done)
    return repeat === undefined ? { file: done.file } : { file: done.file, repeat }
  }
  if (action === 'uncomplete') {
    const step = setDone(file, id, false, now)
    return step === undefined ? { code: 'task-not-found' } : { file: step.file }
  }
  if (!file.items.some(item => item.id === id)) return { code: 'task-not-found' }
  if (action === 'remove') return { file: removeTodo(file, id) }
  if (action === 'move') {
    if (edit.listId !== undefined && !file.lists.some(list => list.id === edit.listId)) {
      return { code: 'list-not-found' }
    }
    return { file: moveTodo(file, id, edit.listId) }
  }
  if (action === 'setPriority') return { file: setPriority(file, id, edit.priority) }
  return { file: setDue(file, id, edit.due) }
}

/**
 * Register the routes: the board, add, edit, toggle, remove, the reminder, the
 * steps, the lists and the batch.
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
      // The composer files the task where the rail is pointing and can name a
      // deadline, so the creation route takes the same three optional fields the
      // editor later changes. Each is optional; absent means the default the field
      // documents (`wire.ts` `TodoItem`).
      const due = body.due === undefined ? undefined : validDay(body.due)
      if (body.due !== undefined && due === null) {
        return fail(400, 'due-invalid', { code: 'route.dueInvalid', text: 'due must be a real local date, YYYY-MM-DD' })
      }
      const priority = body.priority === undefined ? undefined : validPriority(body.priority)
      if (body.priority !== undefined && priority === null) {
        return fail(400, 'priority-invalid', { code: 'route.priorityInvalid', text: 'priority must be 0, 1 or 2' })
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      if (body.listId !== undefined && body.listId !== null && body.listId !== '') {
        const known = typeof body.listId === 'string' && current.lists.some(list => list.id === body.listId)
        if (!known) {
          return fail(400, 'list-invalid', { code: 'route.listInvalid', text: 'listId must be a list id, or absent for the default list' })
        }
      }
      const listId = typeof body.listId === 'string' && body.listId !== '' ? body.listId : undefined
      const reminderAt = typeof body.reminderAt === 'number' && Number.isFinite(body.reminderAt) ? Math.floor(body.reminderAt) : undefined
      const { file } = addTodo(current, text, now, randomUUID(), day ?? undefined, reminderAt, {
        ...(due === null || due === undefined ? {} : { due }),
        ...(listId === undefined ? {} : { listId }),
        ...(priority === null || priority === undefined ? {} : { priority }),
      })
      saveTodos(home, file)
      return ok(snapshotOf(file, now))
    },
  })

  /**
   * Rewrite one task's fields.
   *
   * The one write path for everything the editor changes except the steps and the
   * reminder's own three transitions, and it exists because a half-applied edit is
   * a state nobody asked for: due, list, priority, notes, repeat and the reminder
   * land in ONE file write, and the answer is the board they produced.
   *
   * A key that is PRESENT is an instruction, a key that is absent is not, and
   * `null` (or `''`) on a clearable field clears it — the same distinction the file
   * itself keeps (`wire.ts` `TodoItem.due`: absent is a value, not a gap). A request
   * with no recognised key at all is refused rather than answered with a silent
   * 200, which would read to a caller as "the edit landed".
   */
  const edit = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/edit`,
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
      const task = current.items.find(item => item.id === id)
      if (task === undefined) return taskNotFound(id)

      const patch: { -readonly [K in keyof TodoEdit]: TodoEdit[K] } = {}
      if ('text' in body) {
        const text = validText(body.text)
        if (text === null) {
          return fail(400, 'text-required', { code: 'route.textRequired', text: 'text must be a non-empty string of at most 500 characters' })
        }
        patch.text = text
      }
      if ('due' in body) {
        if (body.due === null || body.due === '') patch.due = undefined
        else {
          const due = validDay(body.due)
          if (due === null) {
            return fail(400, 'due-invalid', { code: 'route.dueInvalid', text: 'due must be a real local date, YYYY-MM-DD, or null to clear it' })
          }
          patch.due = due
        }
      }
      if ('listId' in body) {
        if (body.listId === null || body.listId === '') patch.listId = undefined
        else if (typeof body.listId !== 'string' || !current.lists.some(list => list.id === body.listId)) {
          return fail(400, 'list-invalid', { code: 'route.listInvalid', text: 'listId must be a list id, or null for the default list' })
        } else patch.listId = body.listId
      }
      if ('priority' in body) {
        if (body.priority === null || body.priority === '') patch.priority = undefined
        else {
          const priority = validPriority(body.priority)
          if (priority === null) {
            return fail(400, 'priority-invalid', { code: 'route.priorityInvalid', text: 'priority must be 0, 1 or 2, or null to clear it' })
          }
          patch.priority = priority
        }
      }
      if ('notes' in body) {
        if (body.notes === null) patch.notes = undefined
        else {
          const notes = typeof body.notes === 'string' ? body.notes.trim() : null
          if (notes === null || notes.length > MAX_NOTES) {
            return fail(400, 'notes-invalid', {
              code: 'route.notesInvalid',
              params: { limit: MAX_NOTES },
              text: `notes must be a string of at most ${String(MAX_NOTES)} characters, or null to clear them`,
            })
          }
          patch.notes = notes === '' ? undefined : notes
        }
      }
      if ('repeat' in body) {
        if (body.repeat === null) patch.repeat = undefined
        else {
          const repeat = validRepeat(body.repeat)
          if (repeat === null) {
            return fail(400, 'repeat-invalid', {
              code: 'route.repeatInvalid',
              params: { limit: MAX_REPEAT_INTERVAL },
              text: `repeat must be { freq: daily|weekly|monthly|yearly|weekday, interval?: 1-${String(MAX_REPEAT_INTERVAL)} }, or null to stop repeating`,
            })
          }
          patch.repeat = repeat
        }
      }
      // The reminder's timestamp is set or cleared HERE as well, so the editor is one
      // round trip; the three-way transitions the notice needs stay in `/remind`
      // (`store.ts` `updateReminder`), which is what a snooze or a dismissal asks for.
      let reminderAt: number | undefined
      let touchReminder = false
      if ('reminderAt' in body) {
        touchReminder = true
        if (typeof body.reminderAt === 'number' && Number.isFinite(body.reminderAt)) reminderAt = Math.floor(body.reminderAt)
        else if (body.reminderAt !== null && body.reminderAt !== '') {
          return fail(400, 'reminder-invalid', { code: 'route.reminderInvalid', text: 'reminderAt must be epoch ms, or null to clear it' })
        }
      }
      // WHERE the instant came from, when the caller knows: a time the editor derived
      // from the deadline must stay derived, or a later `due` change would leave it
      // behind (`store.ts` `retimeDueReminder`). Absent means a hand-picked instant.
      let reminderSource: ReminderSource = 'custom'
      if ('reminderSource' in body) {
        const source = validReminderSource(body.reminderSource)
        if (source === null) {
          return fail(400, 'reminder-source-invalid', {
            code: 'route.reminderSourceInvalid',
            text: 'reminderSource must be due-day, hour-before or custom',
          })
        }
        reminderSource = source
      }
      if (Object.keys(patch).length === 0 && !touchReminder) {
        return fail(400, 'no-fields', {
          code: 'route.noEditFields',
          text: 'pass at least one of text, due, listId, priority, notes, repeat or reminderAt',
        })
      }
      const edited = applyEdit(current, id, patch)
      const withReminder = touchReminder ? updateReminder(edited, id, reminderAt, false, reminderSource) : edited
      // A deadline move drags a deadline-derived reminder with it — unless this very
      // request set the reminder, in which case the caller already chose the instant.
      const file = !touchReminder && 'due' in patch ? retimeDueReminder(withReminder, id, now) : withReminder
      if (file !== current) saveTodos(home, file)
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
      // Unticking is a plain state change; ticking a repeating task also opens its
      // next instance, and `completeTodo` is the one place that rule lives
      // (`store.ts`), so the tool and `/batch` cannot drift from this route.
      if (body.done === false) {
        const next = setDone(current, id, false, now)
        if (next === undefined) return taskNotFound(id)
        saveTodos(home, next.file)
        return ok(snapshotOf(next.file, now))
      }
      const done = completeTodo(current, id, now, { task: randomUUID(), series: randomUUID() })
      if (done === undefined) return taskNotFound(id)
      saveTodos(home, done.file)
      // A repeating task says what its completion did: the instance it opened, or why
      // it opened none (`wire.ts` `CompletionReport`). Silence here is what made a
      // routine look like it had forgotten its own rule.
      const repeat = completionReport(done)
      return ok({ ...snapshotOf(done.file, now), ...(repeat === undefined ? {} : { repeat }) })
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

  const subtasks = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/subtasks`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const action = SUBTASK_ACTIONS.find(candidate => candidate === body.action)
      if (action === undefined) {
        return fail(400, 'action-invalid', {
          code: 'route.actionInvalid',
          params: { actions: SUBTASK_ACTIONS.join(', ') },
          text: `action must be one of ${SUBTASK_ACTIONS.join(', ')}`,
        })
      }
      const id = body.id
      if (typeof id !== 'string' || id === '') {
        return fail(400, 'id-required', { code: 'route.idRequired', text: 'id is required' })
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      // The TASK is answered first: a step of a task that is gone should say the task
      // is gone, not argue about a step id nothing could carry.
      const task = current.items.find(item => item.id === id)
      if (task === undefined) return taskNotFound(id)

      if (action === 'add') {
        const text = validSubtaskText(body.text)
        if (text === null) return subtaskTextInvalid()
        const added = addSubtask(current, id, text, randomUUID())
        // The task exists and the id is fresh, so the one refusal left inside the
        // store is the cap (`store.ts` `addSubtask` also refuses a repeated id,
        // which a UUID cannot produce).
        if (added === undefined) {
          return fail(409, 'subtasks-full', {
            code: 'route.subtasksFull',
            params: { limit: MAX_SUBTASKS },
            text: `a task holds at most ${String(MAX_SUBTASKS)} steps`,
          })
        }
        saveTodos(home, added.file)
        return ok(snapshotOf(added.file, now))
      }

      const subtaskId = body.subtaskId
      if (typeof subtaskId !== 'string' || subtaskId === '') {
        return fail(400, 'subtask-id-required', { code: 'route.subtaskIdRequired', text: 'subtaskId is required' })
      }
      if (!(task.subtasks ?? []).some(step => step.id === subtaskId)) return subtaskNotFound(id, subtaskId)

      if (action === 'remove') {
        const file = removeSubtask(current, id, subtaskId)
        saveTodos(home, file)
        return ok(snapshotOf(file, now))
      }
      if (action === 'rename') {
        const text = validSubtaskText(body.text)
        if (text === null) return subtaskTextInvalid()
        const file = renameSubtask(current, id, subtaskId, text)
        saveTodos(home, file)
        return ok(snapshotOf(file, now))
      }
      // `toggle` takes an explicit `done`, defaulting to "tick" the way `/toggle`
      // does. A wrong type is refused rather than read as false: `"false"` would
      // untick a step the user meant to tick.
      if (body.done !== undefined && typeof body.done !== 'boolean') {
        return fail(400, 'done-invalid', { code: 'route.doneInvalid', text: 'done must be true or false' })
      }
      const file = setSubtaskDone(current, id, subtaskId, body.done !== false)
      saveTodos(home, file)
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
      if (!current.items.some(item => item.id === id)) return taskNotFound(id)
      const file = updateReminder(current, id, reminderAt, reminded)
      saveTodos(home, file)
      return ok(snapshotOf(file, now))
    },
  })

  const lists = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/lists`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      if (body.action === 'create') {
        const name = validListName(body.name)
        if (name === null) return listNameInvalid()
        if (listNameTaken(current, name)) {
          return fail(409, 'name-taken', { code: 'route.listNameTaken', params: { name }, text: `a list named "${name}" is already there` })
        }
        const { file } = addList(current, name, randomUUID())
        saveTodos(home, file)
        return ok(snapshotOf(file, now))
      }
      if (body.action === 'rename') {
        const id = body.id
        if (typeof id !== 'string' || id === '') {
          return fail(400, 'id-required', { code: 'route.idRequired', text: 'id is required' })
        }
        // The id is answered FIRST: renaming a list that is gone should say so, not
        // argue about a name nothing will carry.
        if (!current.lists.some(list => list.id === id)) return listNotFound(id)
        const name = validListName(body.name)
        if (name === null) return listNameInvalid()
        if (listNameTaken(current, name, id)) {
          return fail(409, 'name-taken', { code: 'route.listNameTaken', params: { name }, text: `a list named "${name}" is already there` })
        }
        const file = renameList(current, id, name)
        saveTodos(home, file)
        return ok(snapshotOf(file, now))
      }
      if (body.action === 'remove') {
        const id = body.id
        if (typeof id !== 'string' || id === '') {
          return fail(400, 'id-required', { code: 'route.idRequired', text: 'id is required' })
        }
        if (!current.lists.some(list => list.id === id)) return listNotFound(id)
        // The tasks the list held are NOT deleted; they fall back to the default
        // list (`store.ts` `removeList`).
        const file = removeList(current, id)
        saveTodos(home, file)
        return ok(snapshotOf(file, now))
      }
      if (body.action === 'reorder') {
        const raw = body.ids
        const ids: string[] = []
        if (Array.isArray(raw)) for (const entry of raw) if (typeof entry === 'string') ids.push(entry)
        if (!Array.isArray(raw) || ids.length !== raw.length) {
          return fail(400, 'order-invalid', { code: 'route.orderInvalid', text: 'ids must be an array of list ids' })
        }
        const file = reorderLists(current, ids)
        if (file === undefined) {
          return fail(400, 'order-invalid', { code: 'route.orderInvalid', text: 'ids must name every list exactly once' })
        }
        saveTodos(home, file)
        return ok(snapshotOf(file, now))
      }
      return fail(400, 'action-invalid', { code: 'route.actionInvalid', text: 'action must be create, rename, remove or reorder' })
    },
  })

  const batch = ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/batch`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: String(error) }, text: 'invalid request body' })
      }
      const action = BATCH_ACTIONS.find(candidate => candidate === body.action)
      if (action === undefined) {
        return fail(400, 'action-invalid', {
          code: 'route.actionInvalid',
          params: { actions: BATCH_ACTIONS.join(', ') },
          text: `action must be one of ${BATCH_ACTIONS.join(', ')}`,
        })
      }
      const ids = dedupeIds(body.ids)
      if (ids === null) {
        return fail(400, 'ids-invalid', { code: 'route.idsInvalid', text: 'ids must be an array of non-empty strings' })
      }
      if (ids.length > MAX_BATCH_IDS) {
        return fail(400, 'ids-too-many', {
          code: 'route.tooManyIds',
          params: { limit: MAX_BATCH_IDS },
          text: `at most ${String(MAX_BATCH_IDS)} ids per batch`,
        })
      }
      // The shared argument is validated ONCE, here: a bad shape refuses the
      // request (400); a bad state (a task or a list that is not there) refuses that
      // row and leaves the rest applied, per `batchRow`.
      let shared: BatchEdit = {}
      if (action === 'move') {
        // Absent, null or empty means the default list — the same "unfiled" the
        // store keeps (`wire.ts` `TodoItem.listId`).
        const listId = body.listId
        if (typeof listId === 'string' && listId !== '') shared = { listId }
        else if (listId !== undefined && listId !== null && listId !== '') {
          return fail(400, 'list-invalid', { code: 'route.listInvalid', text: 'listId must be a list id, or absent for the default list' })
        }
      } else if (action === 'setPriority') {
        const priority = validPriority(body.priority)
        const given = body.priority !== undefined && body.priority !== null
        if (given && priority === null) {
          return fail(400, 'priority-invalid', { code: 'route.priorityInvalid', text: 'priority must be 0, 1 or 2, or null to clear it' })
        }
        if (priority !== null) shared = { priority }
      } else if (action === 'setDue') {
        const due = validDay(body.due)
        const given = body.due !== undefined && body.due !== null && body.due !== ''
        if (given && due === null) {
          return fail(400, 'due-invalid', { code: 'route.dueInvalid', text: 'due must be a real local date, YYYY-MM-DD, or null to clear it' })
        }
        if (due !== null) shared = { due }
      }
      const now = Date.now()
      const current = pruneDetail(read(), now)
      const outcome: { done: { id: string, repeat?: CompletionReport }[], failed: { id: string, code: string }[] } = { done: [], failed: [] }
      let file = current
      for (const id of ids) {
        const step = batchRow(file, action, id, shared, now)
        if ('code' in step) {
          outcome.failed.push({ id, code: step.code })
          continue
        }
        file = step.file
        // A completed REPEATING row carries what its rule did, so a selection of forty
        // can say which ones opened a successor and which were skipped — a single
        // summary on the answer could not.
        outcome.done.push(step.repeat === undefined ? { id } : { id, repeat: step.repeat })
      }
      // A batch that changed nothing (every id already in the asked-for state) does
      // not rewrite the file, so a retry of a completed batch is cheap.
      if (file !== current) saveTodos(home, file)
      const answer: TodoSnapshot & { batch: BatchOutcome } = { ...snapshotOf(file, now), batch: outcome }
      return ok(answer)
    },
  })

  return () => {
    list()
    add()
    edit()
    toggle()
    remove()
    subtasks()
    remind()
    lists()
    batch()
  }
}

/**
 * The last `count` day keys ending today, oldest first.
 *
 * CALENDAR steps, not `now - 24h * n`. A day is not always 86 400 000 ms: on the day
 * a zone springs forward it is 23 hours, so subtracting fixed days from the current
 * instant can land twice on the same calendar day and once on none — a week strip
 * that draws six columns and repeats today. `views.ts` `addDays` is the one place that
 * arithmetic is written, and the client's own week grid already goes through it
 * (`client/format.ts` `weekKeys`), so this reads the same calendar the board draws.
 * @param now - the current instant.
 * @param count - how many days, including today.
 */
function recentDays(now: number, count: number): string[] {
  const today = dayKey(now)
  const out: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) out.push(addDays(today, -offset))
  return out
}

/** A JSON object, the shape every tool answer is. */
type JsonRow = { [key: string]: JsonValue }

/**
 * One task as a tool answer: every field a caller can act on.
 *
 * Flat and explicit rather than the stored row, because the model reads this as
 * prose: `due: null` says "no deadline" (which is a different state from "due
 * today", `wire.ts` `TodoItem.due`), `list` is the NAME the user knows, and the step
 * counts are the display figure the board draws. Absent fields are spelled `null`
 * rather than omitted so a caller never has to tell "missing" from "empty".
 *
 * @param file - the store, for the list names.
 * @param item - one task.
 */
function taskDetails(file: TodoFile, item: TodoItem): JsonRow {
  const list = item.listId === undefined ? undefined : file.lists.find(row => row.id === item.listId)
  const progress = subtaskProgress(item)
  return {
    id: item.id,
    text: item.text,
    day: item.day,
    due: item.due ?? null,
    list: list?.name ?? null,
    priority: item.priority ?? null,
    notes: item.notes ?? null,
    done: item.done,
    subtasks: { done: progress.done, total: progress.total },
    repeat: item.repeat === undefined ? null : { freq: item.repeat.freq, interval: item.repeat.interval },
  }
}

/**
 * One row of a listing: enough to name a task again, and not the whole record.
 *
 * A listing is where a caller looks for an id to pass back, so it carries the id,
 * the line, both date axes and the step progress — and leaves out `notes`, which
 * can be a paragraph and would bury every other row.
 *
 * @param file - the store, for the list names.
 * @param item - one task.
 */
function listRow(file: TodoFile, item: TodoItem): JsonRow {
  const list = item.listId === undefined ? undefined : file.lists.find(row => row.id === item.listId)
  const progress = subtaskProgress(item)
  return {
    id: item.id,
    text: item.text,
    day: item.day,
    due: item.due ?? null,
    list: list?.name ?? null,
    priority: item.priority ?? null,
    subtasks: { done: progress.done, total: progress.total },
  }
}

/** What a `list` argument resolved to: one list, the default list, or a refusal. */
type ListRef =
  | { readonly ok: true, readonly listId: string | undefined }
  | { readonly ok: false, readonly error: string }

/**
 * A tool's `list` argument, resolved against the board.
 *
 * The argument is a NAME or an id, because the model hears "the work list" and has
 * no reason to know an id it was never shown; the empty string is the default list,
 * which has no row (`wire.ts` `TodoItem.listId`). An unknown name is refused with
 * the names that DO exist, which is the one thing that lets the caller retry
 * without another round trip.
 *
 * @param file - the store.
 * @param value - the caller's argument.
 * @returns the list id, the default list, or an actionable refusal.
 */
function resolveListRef(file: TodoFile, value: string): ListRef {
  if (value.trim() === '') return { ok: true, listId: undefined }
  const list = findList(file, value)
  if (list !== undefined) return { ok: true, listId: list.id }
  const names = file.lists.map(entry => `"${entry.name}"`).join(', ')
  return {
    ok: false,
    error: names === ''
      ? `no list named "${value.trim()}", and the board has no lists yet`
      : `no list named "${value.trim()}"; the board has ${names} (or pass an empty list to use the default one)`,
  }
}

/**
 * Register the tools.
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
      + 'text should read as a task they will recognise tomorrow.\n'
      + 'Dates are local and resolved against today: `day` is the day the task is filed under (which is what '
      + 'the calendar and the "written today" counters read) and `due` is when it is owed. They are different '
      + 'questions — "written today, due Friday" is the ordinary case — so pass `day` only when the task '
      + 'belongs to another day, and `due` whenever the user named a deadline. Omitting `due` makes the task '
      + 'owed on its `day`, and omitting both makes it today\'s work.',
    parameters: {
      text: { type: 'string', required: true, description: 'One task line, at most 500 characters.' },
      day: { type: 'string', description: 'Local day the task is filed under, YYYY-MM-DD. Defaults to today.' },
      due: { type: 'string', description: 'Local deadline, YYYY-MM-DD. Defaults to `day`, i.e. no separate deadline.' },
      list: { type: 'string', description: 'A list name or id (see todo_list). Pass an empty string for the default list.' },
      priority: { type: 'integer', enum: [0, 1, 2], description: '0 low, 1 normal, 2 high. Omit when the user said nothing about urgency.' },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'The steps this task is made of, in order, one line each. Omit for a task with no steps.',
      },
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
      const dueArg = args.due === undefined ? undefined : validDay(args.due)
      if (args.due !== undefined && dueArg === null) {
        return { ok: false, error: 'due must be a real local date, YYYY-MM-DD' }
      }
      const due = dueArg ?? undefined
      const now = Date.now()
      const current = pruneDetail(read(), now)
      // Everything is validated BEFORE the write: a refused step or list must not
      // leave the task half recorded, because the caller would have no id to fix.
      let listId: string | undefined
      if (args.list !== undefined) {
        const resolved = resolveListRef(current, args.list)
        if (!resolved.ok) return { ok: false, error: resolved.error }
        listId = resolved.listId
      }
      const subtasks: { id: string, text: string, done: boolean }[] = []
      for (const line of args.subtasks ?? []) {
        const stepText = validSubtaskText(line)
        if (stepText === null) {
          return { ok: false, error: `every step must be 1-${String(MAX_SUBTASK_TEXT)} characters, got "${line}"` }
        }
        subtasks.push({ id: randomUUID(), text: stepText, done: false })
      }
      if (subtasks.length > MAX_SUBTASKS) {
        return { ok: false, error: `a task holds at most ${String(MAX_SUBTASKS)} steps` }
      }
      const { file, item } = addTodo(current, text, now, randomUUID(), day ?? undefined, undefined, {
        ...(due === undefined ? {} : { due }),
        ...(listId === undefined ? {} : { listId }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(subtasks.length === 0 ? {} : { subtasks }),
      })
      saveTodos(home, file)
      return { ok: true, ...taskDetails(file, item) }
    },
  }))

  const update = ctx.tools.register(defineTool({
    name: 'todo_update',
    description:
      'Change one task that is already on the todo board: its line, its deadline, its list, its priority or its '
      + 'notes. Use it when the user corrects something ("actually it is due Friday", "move it to the work '
      + 'list") instead of recording a second task.\n'
      + 'Locating follows todo_done: pass `id` when you have it. Without an id, `text` is matched as a '
      + 'case-insensitive substring over the OPEN tasks and several matches are reported back for you to name — '
      + 'never guessed. Because that means `text` NAMES a task when there is no id and REPLACES its line when '
      + 'there is one, renaming always needs the id.\n'
      + 'Only the arguments you pass are changed. Pass an empty string (or `null`, for `priority`) to CLEAR a '
      + 'field: an empty `due` removes the deadline rather than setting it to today.',
    parameters: {
      id: { type: 'string', description: 'The task id, when a previous todo_add or todo_list returned it.' },
      text: {
        type: 'string',
        description: 'With `id`: the new task line (at most 500 characters). Without `id`: the substring that finds the task.',
      },
      due: { type: 'string', description: 'New local deadline YYYY-MM-DD, or an empty string to remove the deadline.' },
      list: { type: 'string', description: 'A list name or id to file the task under, or an empty string for the default list.' },
      priority: {
        oneOf: [{ type: 'integer', enum: [0, 1, 2] }, { type: 'null' }],
        description: '0 low, 1 normal, 2 high; null clears the priority.',
      },
      notes: { type: 'string', description: 'Free-form detail, at most 2000 characters, or an empty string to clear it.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args): Promise<JsonValue> {
      const now = Date.now()
      const current = pruneDetail(read(), now)
      const rename = typeof args.text === 'string' && args.text.trim() !== '' && typeof args.id === 'string' && args.id !== ''
        ? validText(args.text)
        : undefined
      if (rename === null) return { ok: false, error: 'text must be a non-empty string of at most 500 characters' }

      let target: TodoItem | undefined
      if (typeof args.id === 'string' && args.id !== '') {
        target = current.items.find(item => item.id === args.id)
        if (target === undefined) return { ok: false, error: `no task with id "${args.id}"` }
      } else if (typeof args.text === 'string' && args.text.trim() !== '') {
        const needle = args.text.trim().toLowerCase()
        const hits = current.items.filter(item => !item.done && item.text.toLowerCase().includes(needle))
        if (hits.length === 0) {
          return { ok: false, error: `no open task contains "${args.text.trim()}"; pass its id to edit a finished one` }
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

      const patch: { -readonly [K in keyof TodoEdit]: TodoEdit[K] } = {}
      if (rename !== undefined) patch.text = rename
      if (args.due !== undefined) {
        if (args.due === '') patch.due = undefined
        else {
          const due = validDay(args.due)
          if (due === null) return { ok: false, error: 'due must be a real local date YYYY-MM-DD, or an empty string to clear it' }
          patch.due = due
        }
      }
      if (args.list !== undefined) {
        const resolved = resolveListRef(current, args.list)
        if (!resolved.ok) return { ok: false, error: resolved.error }
        patch.listId = resolved.listId
      }
      if (args.priority !== undefined) {
        patch.priority = args.priority === null ? undefined : args.priority
      }
      if (args.notes !== undefined) {
        const notes = args.notes.trim()
        if (notes.length > MAX_NOTES) return { ok: false, error: `notes are at most ${String(MAX_NOTES)} characters` }
        patch.notes = notes === '' ? undefined : notes
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: 'pass at least one of text (with an id), due, list, priority or notes' }
      }
      const changed = applyEdit(current, target.id, patch)
      // The tool never sets a reminder of its own, so a moved deadline always drags a
      // deadline-derived one along (`store.ts` `retimeDueReminder`); a hand-picked
      // instant is left where the user put it.
      const file = 'due' in patch ? retimeDueReminder(changed, target.id, now) : changed
      if (file !== current) saveTodos(home, file)
      const edited = file.items.find(item => item.id === target.id) ?? target
      return { ok: true, ...taskDetails(file, edited) }
    },
  }))

  const done = ctx.tools.register(defineTool({
    name: 'todo_done',
    description:
      'Tick (or untick) one task on the todo board. Pass `id` when you have it, otherwise `text` is matched as a '
      + 'case-insensitive substring over the OPEN tasks — several matches are reported back for you to name, '
      + 'never guessed. Ticking moves the day\'s completed count; unticking takes it back off the same day.\n'
      + 'A task that carries a repeat rule also opens its NEXT instance when it is ticked, because the completion '
      + 'is the only trigger the board has (there is no scheduler to miss a run while the app is closed). The '
      + 'answer says what happened: `next` is the instance that was opened, with its id and deadline, and its '
      + 'absence means none was opened. `repeatSkipped` says why, when it was not opened for a reason: '
      + '"open-instance" — the series already has an unfinished instance, and one series never holds two, so '
      + 'finish or remove that one first; "invalid-rule" — the stored rule cannot advance this deadline.',
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
      if (wantDone) {
        // A repeating task opens its next instance as it does through the routes
        // (`store.ts` `completeTodo`), and this answer says what happened: the
        // instance it opened, or why it opened none. Staying silent would read as
        // "the rule was lost".
        const outcome = completeTodo(current, target.id, now, { task: randomUUID(), series: randomUUID() })
        if (outcome === undefined) return { ok: false, error: 'the task disappeared' }
        saveTodos(home, outcome.file)
        return {
          ok: true,
          id: outcome.item.id,
          text: outcome.item.text,
          done: outcome.item.done,
          ...(outcome.next === undefined ? {} : { next: { id: outcome.next.id, due: outcome.next.due ?? null } }),
          ...(outcome.skipped === undefined ? {} : { repeatSkipped: outcome.skipped }),
        }
      }
      const next = setDone(current, target.id, false, now)
      if (next === undefined) return { ok: false, error: 'the task disappeared' }
      saveTodos(home, next.file)
      return { ok: true, id: next.item.id, text: next.item.text, done: next.item.done }
    },
  }))

  const list = ctx.tools.register(defineTool({
    name: 'todo_list',
    description:
      'Read the todo board. The default range is today: the open tasks in scope plus the ones completed today, '
      + 'with the day\'s counts. `week` adds the last seven days\' created/completed numbers. `overdue` returns '
      + 'the open tasks whose DEADLINE is before today — a task with no deadline is due on the day it was '
      + 'written, so "noted last week, still not done" is overdue. `upcoming` is the opposite edge: open tasks '
      + 'owed after today and within seven days.\n'
      + '`list` narrows everything to one list (by name or id), and `dueFrom`/`dueTo` narrow it to a deadline '
      + 'window, inclusive — together they answer "what is due this week on the work list". A task with no '
      + 'deadline is read as due on the day it was written, the same rule every view uses. Each row carries the '
      + 'list name, the priority and its step progress as `subtasks: { done, total }` (0 of 0 means the task has '
      + 'no steps).',
    parameters: {
      range: {
        type: 'string',
        enum: ['today', 'week', 'overdue', 'upcoming'],
        description: 'What to answer: today (default), week, overdue, or upcoming.',
      },
      list: { type: 'string', description: 'A list name or id to narrow the answer to. Omit for every list.' },
      dueFrom: { type: 'string', description: 'Earliest deadline to include, YYYY-MM-DD, inclusive. Omit for no lower bound.' },
      dueTo: { type: 'string', description: 'Latest deadline to include, YYYY-MM-DD, inclusive. Omit for no upper bound.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args): Promise<JsonValue> {
      const now = Date.now()
      const file = pruneDetail(read(), now)
      const today = dayKey(now)
      const range = typeof args.range === 'string' ? args.range : 'today'
      let listId: string | undefined
      if (args.list !== undefined && args.list.trim() !== '') {
        const resolved = resolveListRef(file, args.list)
        if (!resolved.ok) return { ok: false, error: resolved.error }
        listId = resolved.listId
      }
      const from = args.dueFrom === undefined ? undefined : validDay(args.dueFrom)
      if (args.dueFrom !== undefined && from === null) return { ok: false, error: 'dueFrom must be a real local date, YYYY-MM-DD' }
      const to = args.dueTo === undefined ? undefined : validDay(args.dueTo)
      if (args.dueTo !== undefined && to === null) return { ok: false, error: 'dueTo must be a real local date, YYYY-MM-DD' }

      // One scope, asked for by both filters, and one deadline axis (`views.ts`
      // `dueDay`): a task with no deadline is owed on the day it was written, which
      // is the same rule `inView` and the card read.
      const inScope = (item: TodoItem): boolean => {
        if (listId !== undefined && item.listId !== listId) return false
        const due = dueDay(item)
        if (from !== null && from !== undefined && due < from) return false
        if (to !== null && to !== undefined && due > to) return false
        return true
      }
      const open = file.items.filter(item => !item.done)
      const scoped = open.filter(inScope)
      const doneToday = file.items.filter(item => item.done
        && (listId === undefined || item.listId === listId)
        && dayKey(item.doneAt ?? item.createdAt) === today)
      if (range === 'overdue') {
        // The same predicate the client draws with: one definition of "overdue"
        // for the tool, the card and the page (see `views.ts`).
        return { ok: true, overdue: scoped.filter(item => inView(item, 'overdue', today)).map(item => listRow(file, item)) }
      }
      if (range === 'upcoming') {
        return { ok: true, upcoming: scoped.filter(item => inView(item, 'upcoming', today)).map(item => listRow(file, item)) }
      }
      const todayCount = statsFor(file, [today])[0] ?? { created: 0, done: 0 }
      if (range === 'week') {
        const days = recentDays(now, 7)
        const stats = statsFor(file, days)
        return {
          ok: true,
          today: { date: today, open: scoped.length, completed: doneToday.length, created: todayCount.created },
          items: scoped.map(item => listRow(file, item)),
          week: days.map((day, index) => ({ day, ...stats[index]! })),
        }
      }
      return {
        ok: true,
        today: { date: today, open: scoped.length, completed: doneToday.length, created: todayCount.created },
        items: scoped.map(item => listRow(file, item)),
        completedToday: doneToday.map(item => ({ id: item.id, text: item.text })),
      }
    },
  }))

  return () => {
    add()
    update()
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
