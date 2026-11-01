/**
 * The dialog a calendar day opens: that day's tasks, and a box to write one for it.
 *
 * The dialog is the primitive's, chrome and all: its header, its close button, its body
 * padding and its Escape handling. Only the body class is ours, because the Modal
 * portals its content to document.body — the plugin's tokens are declared on that class,
 * and without it every rule inside the dialog falls back to a browser default.
 *
 * It exists because a calendar is a place to PLAN, not only a place to look back: the
 * composer under 今天 can only ever write today, so "put this on Friday" had nowhere to
 * go.
 *
 * It never opens for today: today already has its own list above, and a second copy of
 * the same rows would be two places to keep in step.
 *
 * @module @dsh-app/plugin-todo/client/daypanel
 */

import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayGroup } from './daydata.ts'
import { partsOf } from './format.ts'
import { ReminderPicker } from './reminder.tsx'
import { TaskRow } from './rows.tsx'
import type { Translate } from './translate.ts'
import { dateLabel, weekdayName } from './translate.ts'

function DayEmptyCard({ text }: { text: string }): ReactNode {
  return (
    <div className="dshTodo-dayPanelEmptyCard">
      <svg
        className="dshTodo-dayPanelEmptyIcon"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="18" rx="4" />
        <path d="M16 2v4M8 2v4M3 10h18" />
        <path d="m9 16 2 2 4-4" />
      </svg>
      <p className="dshTodo-dayPanelEmpty">{text}</p>
    </div>
  )
}

/**
 * Render one day's dialog.
 * @param props.open - whether it is showing.
 * @param props.day - the local day key; absent while closed.
 * @param props.group - the day's rows, when the detail still holds them.
 * @param props.today - the host's local day, for the earlier-day tag.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onAdd - writes a task for this day.
 * @param props.onToggle - finishes or reopens a task.
 * @param props.onRemove - removes a task.
 * @param props.onClose - closes the dialog.
 */
export function DayPanel({
  open,
  day,
  group,
  today,
  busy,
  t,
  onAdd,
  onToggle,
  onRemove,
  onUpdateReminder,
  onClose,
}: {
  open: boolean
  day: string | undefined
  group: DayGroup | undefined
  today: string
  busy: boolean
  t: Translate
  onAdd: (text: string, reminderAt?: number) => void
  onToggle: (id: string, done: boolean) => void
  onRemove: (id: string) => void
  onUpdateReminder?: (id: string, reminderAt?: number) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [reminderAt, setReminderAt] = useState<number | undefined>(undefined)
  const openRows = group?.open ?? []
  const doneRows = group?.done ?? []
  const date = day === undefined ? '' : dateLabel(t, day)
  const heading = day === undefined
    ? ''
    : t('todo.view.date', { date, weekday: weekdayName(t, partsOf(day).weekday) })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    const targetReminder = reminderAt
    setReminderAt(undefined)
    onAdd(text, targetReminder)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={heading}
      closeLabel={t('todo.view.close')}
      className="dshTodo-dayPanelModal"
    >
      <div className="dshTodo-dayPanelBody">
        <form className="dshTodo-add" onSubmit={submit}>
          <Input
            className="dshTodo-addInput"
            type="text"
            value={draft}
            placeholder={t('todo.day.addPlaceholder', { date })}
            aria-label={t('todo.day.addPlaceholder', { date })}
            disabled={busy}
            data-modal-autofocus
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <ReminderPicker value={reminderAt} onChange={setReminderAt} t={t} disabled={busy} />
          <Button type="submit" variant="primary" size="sm" disabled={busy || draft.trim() === ''}>
            {t('todo.view.addLabel')}
          </Button>
        </form>

        {openRows.length === 0 && doneRows.length === 0
          ? <DayEmptyCard text={t('todo.day.emptyHint')} />
          : (
            <ul className="dshTodo-list dshTodo-dayPanelList">
              {[...openRows, ...doneRows].map(item => (
                <TaskRow
                  key={item.id}
                  item={item}
                  busy={busy}
                  t={t}
                  today={today}
                  onToggle={onToggle}
                  onRemove={onRemove}
                  onUpdateReminder={onUpdateReminder}
                />
              ))}
            </ul>
          )}
      </div>
    </Modal>
  )
}
