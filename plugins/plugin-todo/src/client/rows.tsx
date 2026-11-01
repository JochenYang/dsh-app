/**
 * One task as a row: the checkbox, the text, the earlier-day tag, the remove control.
 *
 * Shared by the 今天 list and by a selected day's panel, because the two are the same
 * object seen from two places — a second copy would drift the moment one of them gains
 * a state the other lacks.
 *
 * @module @dsh-app/plugin-todo/client/rows
 */

import type { ReactNode } from 'react'
import {
  Checkbox,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatTime, ReminderPicker } from './reminder.tsx'
import type { Translate } from './translate.ts'
import type { TodoItem } from '../wire.ts'

/**
 * The remove control. Hidden until the row is hovered or focused, and always shown on
 * touch, where there is no hover to reveal it.
 * @param props.item - the task it removes.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onRemove - removes the task.
 */
function RemoveButton({ item, busy, t, onRemove }: {
  item: TodoItem
  busy: boolean
  t: Translate
  onRemove: (id: string) => void
}): ReactNode {
  return (
    <Tooltip label={t('todo.view.remove')} side="top">
      <button
        type="button"
        className="dshTodo-rowRemove"
        aria-label={`${t('todo.view.remove')}: ${item.text}`}
        disabled={busy}
        onClick={() => { onRemove(item.id) }}
      >
        <IconCloseOutlineRegular />
      </button>
    </Tooltip>
  )
}

/**
 * Render one task.
 * @param props.item - the task.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onToggle - finishes or reopens the task.
 * @param props.onRemove - removes the task.
 * @param props.today - the host's local day, used for the earlier-day tag.
 */
export function TaskRow({
  item,
  t,
  onToggle,
  onRemove,
  onUpdateReminder,
  today,
}: {
  item: TodoItem
  busy: boolean
  t: Translate
  onToggle: (id: string, done: boolean) => void
  onRemove: (id: string) => void
  onUpdateReminder?: (id: string, reminderAt?: number) => void
  today: string
}): ReactNode {
  return (
    <li className="dshTodo-row" data-done={item.done ? 'true' : undefined}>
      <Checkbox
        className="dshTodo-rowCheck"
        checked={item.done}
        label={item.text}
        onChange={(next) => { onToggle(item.id, next) }}
      />
      {!item.done && onUpdateReminder ? (
        <ReminderPicker
          value={item.reminderAt}
          onChange={(timeMs) => { onUpdateReminder(item.id, timeMs) }}
          t={t}
          compact
        />
      ) : item.reminderAt !== undefined ? (
        <Tooltip label={t('todo.reminder.rowTooltip', { time: formatTime(item.reminderAt) })} side="top">
          <span className="dshTodo-reminderTag">
            <IconClockOutlineRegular />
            <span>{formatTime(item.reminderAt)}</span>
          </span>
        </Tooltip>
      ) : null}
      {!item.done && item.day < today ? <span className="dshTodo-tag">{t('todo.view.earlier')}</span> : null}
      <RemoveButton item={item} busy={false} t={t} onRemove={onRemove} />
    </li>
  )
}
