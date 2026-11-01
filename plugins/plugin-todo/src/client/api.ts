/**
 * Client-side access to the todo routes.
 *
 * One request helper, because every route answers the same envelope and the same
 * snapshot: the panel never merges a diff, so a failed write simply leaves the last
 * good board on screen and reports why.
 *
 * @module @dsh-app/plugin-todo/client/api
 */

import { ROUTE_PREFIX, type TodoSnapshot } from '../wire.ts'

/** A host failure carrying the coded message the client renders. */
export interface TodoError extends Error {
  readonly code: string
  readonly detail: string
}

function hostTextOf(value: unknown): { code: string, detail: string } {
  if (typeof value !== 'object' || value === null) return { code: 'unknown', detail: 'the host answered without an error' }
  const error = value as { code?: unknown, message?: unknown, host?: { code?: unknown, text?: unknown } }
  const code = typeof error.host?.code === 'string' ? error.host.code : typeof error.code === 'string' ? error.code : 'unknown'
  const detail = typeof error.message === 'string' ? error.message : typeof error.host?.text === 'string' ? error.host.text : code
  return { code, detail }
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
    throw Object.assign(new Error(`HTTP ${String(response.status)}`), { code: 'io', detail: `HTTP ${String(response.status)}` })
  }
  const envelope = body as { ok?: unknown, value?: unknown, error?: unknown }
  if (envelope.ok !== true) {
    const { code, detail } = hostTextOf(envelope.error)
    throw Object.assign(new Error(detail), { code, detail })
  }
  return envelope.value as T
}

/** Read the whole board. */
export function loadBoard(): Promise<TodoSnapshot> {
  return request<TodoSnapshot>('/todos', { method: 'GET' })
}

/**
 * Append one task and return the new board.
 * @param text - the task line.
 * @param day - the local day it belongs to; omitted means today.
 * @param reminderAt - optional epoch ms when the reminder rings.
 */
export function addTask(text: string, day?: string, reminderAt?: number): Promise<TodoSnapshot> {
  const payload: Record<string, unknown> = { text }
  if (day !== undefined) payload.day = day
  if (typeof reminderAt === 'number') payload.reminderAt = reminderAt
  return request<TodoSnapshot>('/add', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** Update or snooze a task's reminder state. */
export function updateTaskReminder(id: string, reminderAt?: number, reminded = false): Promise<TodoSnapshot> {
  return request<TodoSnapshot>('/remind', {
    method: 'POST',
    body: JSON.stringify({ id, reminderAt, reminded }),
  })
}

/** Tick or untick one task and return the new board. */
export function toggleTask(id: string, done: boolean): Promise<TodoSnapshot> {
  return request<TodoSnapshot>('/toggle', { method: 'POST', body: JSON.stringify({ id, done }) })
}

/** Drop one task's detail row and return the new board. */
export function removeTask(id: string): Promise<TodoSnapshot> {
  return request<TodoSnapshot>('/remove', { method: 'POST', body: JSON.stringify({ id }) })
}
