/**
 * One task as a row: the checkbox, the line, its deadline, and the controls that
 * change it.
 *
 * Shared by the board and by a selected day's dialog, because the two are the same
 * object seen from two places — a second copy would drift the moment one of them
 * gains a state the other lacks.
 *
 * THE DEADLINE IS THE AXIS. The card, the page and the host tool all decide what is
 * late through `views.ts` `inView`, so this row asks the same question instead of
 * comparing `day < today` by hand: a task written today and owed last week is late,
 * and a task written last week and owed next month is not.
 *
 * The steps live UNDER the line rather than in the row's own flex line, because a
 * checklist is prose: it wraps, it gets long, and a horizontal row cannot hold it.
 *
 * @module @dsh-app/plugin-todo/client/rows
 */

import type { ReactNode } from 'react'
import {
  Button,
  Checkbox,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatTime, ReminderPicker } from './reminder.tsx'
import { StepsPanel, type StepWrite } from './steps.tsx'
import type { Translate } from './translate.ts'
import { dateLabel } from './translate.ts'
import { dueDay, inView, subtaskProgress } from '../views.ts'
import type { TodoItem, TodoList } from '../wire.ts'

/**
 * The remove control. Hidden until the row is hovered or focused, and always shown on
 * touch, where there is no hover to reveal it.
 * @param props.item - the task it removes.
 * @param props.t - the dictionary seat.
 * @param props.onRemove - removes the task.
 */
function RemoveButton({ item, t, onRemove }: {
  item: TodoItem
  t: Translate
  onRemove: (id: string) => void
}): ReactNode {
  return (
    <Tooltip label={t('todo.view.remove')} side="top">
      <button
        type="button"
        className="dshTodo-rowRemove"
        aria-label={`${t('todo.view.remove')}: ${item.text}`}
        onClick={() => { onRemove(item.id) }}
      >
        <IconCloseOutlineRegular />
      </button>
    </Tooltip>
  )
}

/**
 * When the task is owed, as a tag.
 *
 * Three states and one axis, decided by the same predicate the card counts with:
 * late, due today, or due later. A finished task gets none — its deadline stopped
 * mattering the moment it was ticked, and a strikethrough row full of red tags reads
 * as unfinished work.
 * @param props.item - the task.
 * @param props.today - the host's local day.
 * @param props.t - the dictionary seat.
 */
function DueTag({ item, today, t }: { item: TodoItem; today: string; t: Translate }): ReactNode {
  if (item.done) return null
  const due = dueDay(item)
  // A task with no deadline of its own is owed on the day it was written, which is
  // what `dueDay` answers — so "no deadline" is never a fourth state here.
  if (due === today) return <span className="dshTodo-tag dshTodo-tagDue">{t('todo.row.dueToday')}</span>
  if (inView(item, 'overdue', today)) {
    return <span className="dshTodo-tag dshTodo-tagLate">{t('todo.row.overdue', { date: dateLabel(t, due) })}</span>
  }
  return <span className="dshTodo-tag dshTodo-tagDue">{t('todo.row.due', { date: dateLabel(t, due) })}</span>
}

/** The frequency labels, in the order the repeat control offers them. */
const REPEAT_LABEL_KEYS = {
  daily: 'todo.repeat.daily',
  weekly: 'todo.repeat.weekly',
  monthly: 'todo.repeat.monthly',
  yearly: 'todo.repeat.yearly',
  weekday: 'todo.repeat.weekday',
} as const

/**
 * One frequency's label.
 * @param freq - the stored cadence.
 * @param t - the dictionary seat.
 */
export function repeatLabel(freq: keyof typeof REPEAT_LABEL_KEYS, t: Translate): string {
  return t(REPEAT_LABEL_KEYS[freq])
}

/**
 * Render one task.
 * @param props.item - the task.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.today - the host's local day, used for the deadline tag.
 * @param props.onToggle - finishes or reopens the task.
 * @param props.onRemove - removes the task.
 * @param props.onUpdateReminder - sets or clears its reminder clock.
 * @param props.onEdit - opens the task's editor; absent on a face that does not edit.
 * @param props.onWriteStep - applies one step action; absent hides the checklist.
 * @param props.stepsOpen - whether the checklist is showing.
 * @param props.onToggleSteps - folds or unfolds the checklist.
 * @param props.selectable - whether the row offers a selection box.
 * @param props.selected - whether it is in the current selection.
 * @param props.onSelect - adds or drops it from the selection.
 * @param props.lists - the board's lists, for the row's list name in a mixed view.
 * @param props.showList - whether to name the owning list (only when no list is filtered).
 */
export function TaskRow({
  item,
  t,
  onToggle,
  onRemove,
  onUpdateReminder,
  onEdit,
  onWriteStep,
  stepsOpen = false,
  onToggleSteps,
  selectable = false,
  selected = false,
  onSelect,
  lists,
  showList = false,
  today,
}: {
  item: TodoItem
  busy: boolean
  t: Translate
  today: string
  onToggle: (id: string, done: boolean) => void
  onRemove: (id: string) => void
  onUpdateReminder?: (id: string, reminderAt?: number) => void
  onEdit?: (item: TodoItem) => void
  onWriteStep?: StepWrite
  stepsOpen?: boolean
  onToggleSteps?: (id: string) => void
  selectable?: boolean
  selected?: boolean
  onSelect?: (id: string) => void
  lists?: readonly TodoList[]
  showList?: boolean
}): ReactNode {
  const progress = subtaskProgress(item)
  const list = showList && item.listId !== undefined ? lists?.find(entry => entry.id === item.listId) : undefined

  return (
    <li
      className="dshTodo-row"
      data-done={item.done ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-priority={item.priority === undefined ? undefined : String(item.priority)}
    >
      {selectable ? (
        <Checkbox
          className="dshTodo-rowPick"
          checked={selected}
          label={`${t('todo.row.select')}: ${item.text}`}
          onChange={() => { onSelect?.(item.id) }}
        />
      ) : null}
      <Checkbox
        className="dshTodo-rowCheck"
        checked={item.done}
        label={item.text}
        onChange={(next) => { onToggle(item.id, next) }}
      />
      {item.priority === undefined ? null : (
        <span
          className="dshTodo-priorityDot"
          data-priority={String(item.priority)}
          role="img"
          aria-label={t(item.priority === 2 ? 'todo.row.priorityHigh' : item.priority === 1 ? 'todo.row.priorityNormal' : 'todo.row.priorityLow')}
        />
      )}
      {list === undefined ? null : <span className="dshTodo-rowList">{list.name}</span>}
      {progress.total === 0 ? null : onToggleSteps === undefined ? (
        <span className="dshTodo-rowSteps" data-complete={progress.done === progress.total ? 'true' : undefined}>
          {t('todo.row.progress', { done: progress.done, total: progress.total })}
        </span>
      ) : (
        <Tooltip label={t('todo.row.progress', { done: progress.done, total: progress.total })} side="top">
          <button
            type="button"
            className="dshTodo-rowSteps"
            data-complete={progress.done === progress.total ? 'true' : undefined}
            aria-expanded={stepsOpen}
            aria-label={`${t(stepsOpen ? 'todo.row.collapse' : 'todo.row.expand')} (${t('todo.row.progress', { done: progress.done, total: progress.total })})`}
            onClick={() => { onToggleSteps(item.id) }}
          >
            {t('todo.row.progress', { done: progress.done, total: progress.total })}
          </button>
        </Tooltip>
      )}
      <DueTag item={item} today={today} t={t} />
      {item.repeat === undefined ? null : (
        <Tooltip label={t('todo.row.repeat', { label: repeatLabel(item.repeat.freq, t) })} side="top">
          <span className="dshTodo-tag dshTodo-tagRepeat">{t('todo.reminder.repeatShort')}</span>
        </Tooltip>
      )}
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
      {onEdit === undefined ? null : (
        <Tooltip label={t('todo.row.edit')} side="top">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="dshTodo-rowEdit"
            icon={<IconEditOutlineRegular />}
            aria-label={`${t('todo.row.edit')}: ${item.text}`}
            onClick={() => { onEdit(item) }}
          />
        </Tooltip>
      )}
      <RemoveButton item={item} t={t} onRemove={onRemove} />
      {stepsOpen && onWriteStep !== undefined ? (
        <StepsPanel item={item} t={t} onWrite={onWriteStep} />
      ) : null}
    </li>
  )
}
