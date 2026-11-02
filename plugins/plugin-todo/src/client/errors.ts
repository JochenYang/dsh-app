/**
 * The host's coded failures, in the user's own language.
 *
 * Every route answers a stable `host.code` (`route.listNameInvalid`, `route.listNameTaken`,
 * …) and the client's request helper carries it through. Without this table the page
 * could only print the host's English sentence, which is written for the log: half of
 * it is a bare code when a route forgot a `text`, and all of it is the wrong language
 * for a user mid-sentence. So the code is the key, the dictionary owns the wording,
 * and `host.params` supplies the values a sentence interpolates.
 *
 * A code nobody mapped is NOT swallowed: it falls back to the host's own diagnostic,
 * which is what makes a newly added route legible in the UI before it has copy.
 *
 * @module @dsh-app/plugin-todo/client/errors
 */

import type { TodoError } from './api.ts'
import type { TodoKey } from './locales.ts'
import type { Translate } from './translate.ts'

/** One code per key the dictionaries carry. */
const KEYS: Readonly<Record<string, TodoKey>> = {
  'route.invalidBody': 'todo.error.invalidBody',
  'route.textRequired': 'todo.error.textRequired',
  'route.dayInvalid': 'todo.error.dayInvalid',
  'route.dueInvalid': 'todo.error.dueInvalid',
  'route.priorityInvalid': 'todo.error.priorityInvalid',
  'route.idRequired': 'todo.error.idRequired',
  'route.taskNotFound': 'todo.error.taskNotFound',
  'route.subtaskNotFound': 'todo.error.subtaskNotFound',
  'route.subtaskTextInvalid': 'todo.error.subtaskTextInvalid',
  'route.subtasksFull': 'todo.error.subtasksFull',
  'route.subtaskIdRequired': 'todo.error.subtaskIdRequired',
  'route.doneInvalid': 'todo.error.doneInvalid',
  'route.actionInvalid': 'todo.error.actionInvalid',
  'route.listNotFound': 'todo.error.listNotFound',
  'route.listNameInvalid': 'todo.error.listNameInvalid',
  'route.listNameTaken': 'todo.error.listNameTaken',
  'route.listInvalid': 'todo.error.listInvalid',
  'route.orderInvalid': 'todo.error.orderInvalid',
  'route.idsInvalid': 'todo.error.idsInvalid',
  'route.tooManyIds': 'todo.error.tooManyIds',
  'route.notesInvalid': 'todo.error.notesInvalid',
  'route.repeatInvalid': 'todo.error.repeatInvalid',
  'route.reminderInvalid': 'todo.error.reminderInvalid',
  'route.reminderSourceInvalid': 'todo.error.reminderSourceInvalid',
  'route.noEditFields': 'todo.error.noEditFields',
  // The two the client itself can produce: a request that never reached the host
  // (`io`) and a failure with no envelope at all.
  io: 'todo.error.offline',
  unknown: 'todo.error.unknown',
}

/** What a caller has to hand: a thrown {@link TodoError}, or anything else. */
export type Failure = Pick<TodoError, 'code' | 'detail' | 'params'> & { readonly message?: string }

/**
 * One failure as the sentence the page shows.
 * @param t - the dictionary seat.
 * @param error - the thrown error, or a bare detail string.
 * @returns the localized sentence.
 */
export function errorText(t: Translate, error: Failure | string): string {
  if (typeof error === 'string') return t('todo.error.unknown', { detail: error })
  const key = KEYS[error.code]
  if (key !== undefined) return t(key, error.params)
  return t('todo.error.unknown', { detail: error.detail })
}

/**
 * The same sentence, from a value that may not be an error at all.
 *
 * `catch` binds `unknown`, and a thrown string or a rejected non-Error object must
 * still reach the user as a sentence rather than as a renderer crash.
 * @param t - the dictionary seat.
 * @param thrown - whatever `catch` caught.
 */
export function errorFrom(t: Translate, thrown: unknown): string {
  if (typeof thrown === 'object' && thrown !== null && typeof (thrown as Failure).code === 'string') {
    return errorText(t, thrown as Failure)
  }
  if (thrown instanceof Error) return t('todo.error.unknown', { detail: thrown.message })
  return t('todo.error.unknown', { detail: String(thrown) })
}
