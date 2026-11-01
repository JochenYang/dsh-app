/**
 * A day's tasks as chips.
 *
 * A chip is the one shape a task takes on every calendar face: a state glyph and
 * its text. The glyph carries the state for sighted readers (a ring is open, a
 * filled dot is finished) and a visually hidden word carries it for everyone else,
 * so the state is never colour alone. Plain spans rather than list items, because
 * a month cell is itself a button and a button takes phrasing content only.
 *
 * @module @dsh-app/plugin-todo/client/dayrows
 */

import type { ReactNode } from 'react'
import type { TodoItem } from '../wire.ts'
import type { Translate } from './translate.ts'

/**
 * One task.
 * @param props.item - the task.
 * @param props.t - the dictionary seat.
 * @param props.compact - the small size a month cell uses.
 */
export function TaskChip({ item, t, compact = false }: {
  item: TodoItem
  t: Translate
  compact?: boolean
}): ReactNode {
  return (
    <span className="dshTodo-chip" data-done={item.done ? 'true' : undefined} data-compact={compact ? 'true' : undefined}>
      <span className="dshTodo-glyph" aria-hidden="true" />
      <span className="dshTodo-chipText">{item.text}</span>
      <span className="dshTodo-sr">{item.done ? t('todo.day.done') : t('todo.day.open')}</span>
    </span>
  )
}

/**
 * A stack of chips.
 * @param props.items - the tasks, in the order the face shows them.
 * @param props.t - the dictionary seat.
 * @param props.compact - the small size a month cell uses.
 */
export function TaskChips({ items, t, compact = false }: {
  items: readonly TodoItem[]
  t: Translate
  compact?: boolean
}): ReactNode {
  return (
    <span className="dshTodo-chips">
      {items.map(item => <TaskChip key={item.id} item={item} t={t} compact={compact} />)}
    </span>
  )
}
