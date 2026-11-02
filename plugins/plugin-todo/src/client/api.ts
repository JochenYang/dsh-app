/**
 * Client-side access to the todo routes.
 *
 * One request helper, because every route answers the same envelope and the same
 * snapshot: the panel never merges a diff, so a failed write simply leaves the last
 * good board on screen and reports why.
 *
 * Each function here names ONE route and one shape, so a caller in the panel reads
 * as the operation it performs rather than as a fetch. The failure a route answers
 * carries both halves a message needs: a stable code the dictionary is keyed by
 * (`client/errors.ts`) and the host's English diagnostic, which is what the log
 * gets.
 *
 * @module @dsh-app/plugin-todo/client/api
 */

import {
  ROUTE_PREFIX,
  type BatchOutcome,
  type CompletionReport,
  type ReminderSource,
  type RepeatRule,
  type TodoSnapshot,
} from '../wire.ts'

/** A host failure carrying the coded message the client renders. */
export interface TodoError extends Error {
  /** The dictionary key the host named, e.g. `route.listNameInvalid`. */
  readonly code: string
  /** The host's own English sentence, for the log and as the last fallback. */
  readonly detail: string
  /** The values the code's copy interpolates (`{ limit }`, `{ id }`, …). */
  readonly params: Readonly<Record<string, string | number>>
}

function hostTextOf(value: unknown): { code: string, detail: string, params: Record<string, string | number> } {
  if (typeof value !== 'object' || value === null) {
    return { code: 'unknown', detail: 'the host answered without an error', params: {} }
  }
  const error = value as {
    code?: unknown
    message?: unknown
    host?: { code?: unknown, text?: unknown, params?: unknown }
  }
  const code = typeof error.host?.code === 'string' ? error.host.code : typeof error.code === 'string' ? error.code : 'unknown'
  const detail = typeof error.message === 'string' ? error.message : typeof error.host?.text === 'string' ? error.host.text : code
  const params: Record<string, string | number> = {}
  const raw = error.host?.params
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      // Only the two shapes the dictionaries interpolate; anything else would print
      // as `[object Object]` in the middle of a sentence.
      if (typeof entry === 'string' || typeof entry === 'number') params[key] = entry
    }
  }
  return { code, detail, params }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    // `no-store` on the read too: a cached board would show yesterday's list
    // after the model ticked something from a conversation.
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw Object.assign(new Error(`HTTP ${String(response.status)}`), {
      code: 'io',
      detail: `HTTP ${String(response.status)}`,
      params: {},
    })
  }
  const envelope = body as { ok?: unknown, value?: unknown, error?: unknown }
  if (envelope.ok !== true) {
    const { code, detail, params } = hostTextOf(envelope.error)
    throw Object.assign(new Error(detail), { code, detail, params })
  }
  return envelope.value as T
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload) })
}

/** Read the whole board. */
export function loadBoard(): Promise<TodoSnapshot> {
  return request<TodoSnapshot>('/todos', { method: 'GET' })
}

/** The fields a task can be CREATED with, beyond its line. */
export interface NewTaskFields {
  /** Deadline, local `YYYY-MM-DD`; omitted means the day the task is written. */
  readonly due?: string
  /** Owning list id; omitted means the default list. */
  readonly listId?: string
  readonly priority?: 0 | 1 | 2
}

/**
 * Append one task and return the new board.
 * @param text - the task line.
 * @param day - the local day it belongs to; omitted means today.
 * @param reminderAt - optional epoch ms when the reminder rings.
 * @param fields - the deadline, list and priority the composer already knows.
 */
export function addTask(
  text: string,
  day?: string,
  reminderAt?: number,
  fields: NewTaskFields = {},
): Promise<TodoSnapshot> {
  const payload: Record<string, unknown> = { text, ...fields }
  if (day !== undefined) payload.day = day
  if (typeof reminderAt === 'number') payload.reminderAt = reminderAt
  return post<TodoSnapshot>('/add', payload)
}

/** One task's fields as an edit asks for them: `null` clears, absent leaves alone. */
export interface TaskPatch {
  readonly text?: string
  readonly due?: string | null
  readonly listId?: string | null
  readonly priority?: 0 | 1 | 2 | null
  readonly notes?: string | null
  readonly repeat?: RepeatRule | null
  readonly reminderAt?: number | null
  /** Which preset produced `reminderAt`; absent is a hand-picked instant. */
  readonly reminderSource?: ReminderSource
}

/** Rewrite several of one task's fields in one write. */
export function editTask(id: string, patch: TaskPatch): Promise<TodoSnapshot> {
  return post<TodoSnapshot>('/edit', { id, ...patch })
}

/** Update or snooze a task's reminder state. */
export function updateTaskReminder(id: string, reminderAt?: number, reminded = false): Promise<TodoSnapshot> {
  return post<TodoSnapshot>('/remind', { id, reminderAt, reminded })
}

/** What ticking one task answered: the board, plus what its repeat rule did. */
export type ToggleAnswer = TodoSnapshot & { readonly repeat?: CompletionReport }

/**
 * Tick or untick one task and return the new board.
 *
 * The answer carries `repeat` when the task carries a rule — the instance that was
 * opened, or why none was — so the board can tell the user what its own click did
 * instead of leaving a routine's successor to appear unannounced.
 */
export function toggleTask(id: string, done: boolean): Promise<ToggleAnswer> {
  return post<ToggleAnswer>('/toggle', { id, done })
}

/** Drop one task's detail row and return the new board. */
export function removeTask(id: string): Promise<TodoSnapshot> {
  return post<TodoSnapshot>('/remove', { id })
}

/** The batch actions the route names, in the order the page offers them. */
export type BatchAction = 'complete' | 'uncomplete' | 'move' | 'setPriority' | 'setDue' | 'remove'

/** What a batch answered: the board, plus one result per row it was given. */
export type BatchAnswer = TodoSnapshot & { readonly batch: BatchOutcome }

/**
 * Apply one action to a selection and answer the board with a per-row outcome.
 * @param action - which action every row gets.
 * @param ids - the selected tasks.
 * @param extra - the action's shared argument (`listId`, `priority` or `due`).
 */
export function batchTasks(
  action: BatchAction,
  ids: readonly string[],
  extra: { readonly listId?: string | null, readonly priority?: 0 | 1 | 2 | null, readonly due?: string | null } = {},
): Promise<BatchAnswer> {
  return post<BatchAnswer>('/batch', { action, ids, ...extra })
}
/** The list actions the route names. */
export type ListAction = 'create' | 'rename' | 'remove' | 'reorder'

/**
 * Apply one list action.
 * @param action - create, rename, remove or reorder.
 * @param body - the action's own fields (`name`, `id`, `ids`).
 */
export function listAction(action: ListAction, body: Record<string, unknown> = {}): Promise<TodoSnapshot> {
  return post<TodoSnapshot>('/lists', { action, ...body })
}

/** The step actions the route names. */
export type SubtaskAction = 'add' | 'remove' | 'rename' | 'toggle'

/**
 * Apply one step action.
 * @param action - add, remove, rename or toggle.
 * @param body - the task id plus the step id / text / flag the action needs.
 */
export function subtaskAction(action: SubtaskAction, body: Record<string, unknown>): Promise<TodoSnapshot> {
  return post<TodoSnapshot>('/subtasks', { action, ...body })
}
