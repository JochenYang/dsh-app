/**
 * The task editor: the fields one task carries, in one card.
 *
 * It exists because a board that can only add and tick is a list of sentences. The
 * editor is where a task gets a deadline, a list, an urgency, a repeat rule and a
 * reminder — the fields `wire.ts` stores and `views.ts` decides about.
 *
 * FOUR THINGS IT DELIBERATELY DOES NOT DO.
 * - It does not build a date picker: `<Input type="date">` is a real form control
 *   with the platform's own calendar, keyboard support and locale, and a hand-built
 *   one would be worse at all three.
 * - It does not pick a reminder instant by hand for the two deadline presets. Those
 *   come from `views.ts` `presetReminderAt`, which is the one place that decides what
 *   "09:00 on the due day" means and what to do when that moment has already passed
 *   (arm nothing, rather than ring the instant the task is saved).
 * - It does not send the whole task back. Only the fields whose value changed travel,
 *   so two windows editing different fields do not undo each other, and the host's
 *   route refuses a request that changes nothing instead of silently writing.
 * - It does not re-derive a reminder when the DEADLINE moves. It sends a reminder only
 *   when a reminder control changed; a due change is the host's to act on, because only
 *   the host knows whether the armed instant came from the deadline or from the user's
 *   own choice (`wire.ts` `ReminderSource`, `store.ts` `retimeDueReminder`).
 *
 * @module @dsh-app/plugin-todo/client/editor
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskPatch } from './api.ts'
import { formatTime, ReminderPicker } from './reminder.tsx'
import { repeatLabel } from './rows.tsx'
import type { Translate } from './translate.ts'
import { presetReminderAt } from '../views.ts'
import { MAX_REPEAT_INTERVAL, type RepeatRule, type TodoItem, type TodoList } from '../wire.ts'

/** The placeholder a list choice uses for "no list", which is a real selection. */
const DEFAULT_LIST = ''

/** One option in a dropdown field. */
interface Choice<Value extends string> {
  readonly key: Value
  readonly label: string
}

/**
 * One labelled dropdown, built from the menu primitive.
 *
 * A dropdown rather than a segmented control: the list rail is unbounded and a
 * cadence has six values, and a control that turns into a wall of tabs once a user
 * creates a fourth list is a control they stop opening.
 * @param props.label - the field's label.
 * @param props.value - the selected key.
 * @param props.options - the choices, in display order.
 * @param props.disabled - a write is in flight.
 * @param props.onChange - receives the chosen key.
 */
function ChoiceField<Value extends string>({ label, value, options, disabled, onChange }: {
  label: string
  value: Value
  options: readonly Choice<Value>[]
  disabled: boolean
  onChange: (next: Value) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.key === value)
  return (
    <div className="dshTodo-editorField">
      <span className="dshTodo-editorLabel">{label}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        align="start"
        portal
        selectedId={value}
        items={options.map(option => ({ id: option.key, label: option.label }))}
        onSelect={(key) => {
          setOpen(false)
          if (key !== value) onChange(key as Value)
        }}
        anchor={(
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="dshTodo-editorChoice"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={label}
            onClick={() => { setOpen(!open) }}
          >
            {current?.label ?? ''}
          </Button>
        )}
      />
    </div>
  )
}

/** The repeat choices, in the order the stored cadences are written. */
const REPEAT_OPTIONS = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'weekday'] as const

/** A cadence key, or `none` for "no rule". */
type RepeatKey = typeof REPEAT_OPTIONS[number]

/** The three priorities, with `none` for "never set one" (`wire.ts` `TodoItem.priority`). */
const PRIORITY_OPTIONS = ['none', '0', '1', '2'] as const

/** A priority key. */
type PriorityKey = typeof PRIORITY_OPTIONS[number]

/** The reminder choices. */
const REMINDER_OPTIONS = ['none', 'due-day', 'hour-before', 'custom'] as const

/** One reminder choice. */
type ReminderKey = typeof REMINDER_OPTIONS[number]

/**
 * The editor.
 * @param props.item - the task being edited; the parent mounts a fresh editor per task.
 * @param props.lists - the board's lists.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onSave - receives only the fields that changed.
 * @param props.onClose - closes the dialog without writing.
 */
export function TaskEditor({ item, lists, busy, t, onSave, onClose }: {
  item: TodoItem
  lists: readonly TodoList[]
  busy: boolean
  t: Translate
  /** Applies the patch; resolves to the message to keep showing, or `undefined` on success. */
  onSave: (patch: TaskPatch) => Promise<string | undefined>
  onClose: () => void
}): ReactNode {
  const [text, setText] = useState(item.text)
  const [due, setDue] = useState(item.due ?? '')
  const [listKey, setListKey] = useState(item.listId ?? DEFAULT_LIST)
  const [priority, setPriority] = useState<PriorityKey>(item.priority === undefined ? 'none' : String(item.priority) as PriorityKey)
  const [repeat, setRepeat] = useState<RepeatKey>(item.repeat?.freq ?? 'none')
  const [period, setPeriod] = useState(String(item.repeat?.interval ?? 1))
  const [notes, setNotes] = useState(item.notes ?? '')
  // Where the armed reminder came from, when the task knows: a deadline-derived
  // instant comes back as the preset that produced it, so the deadline field and the
  // reminder field re-derive together as the user edits. An instant with no recorded
  // source (every reminder written before the field existed) is `custom`, and a
  // hand-picked time is never silently turned back into a derived one.
  const initialPreset: ReminderKey = item.reminderAt === undefined ? 'none' : item.reminderSource ?? 'custom'
  const [preset, setPreset] = useState<ReminderKey>(initialPreset)
  const [customAt, setCustomAt] = useState<number | undefined>(item.reminderAt)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const trimmedText = text.trim()
  const trimmedNotes = notes.trim()
  const dueValue = due.trim() === '' ? undefined : due.trim()
  const periodValue = Number(period.trim())

  // The one rule for a deadline-derived reminder, asked of the module that owns it.
  const armedAt = preset === 'custom'
    ? customAt
    : presetReminderAt(dueValue, preset, Date.now(), customAt)
  // Only the reminder controls' OWN changes decide whether saving touches the reminder.
  // A deadline change does not: the host re-derives a deadline-derived instant itself
  // (`store.ts` `retimeDueReminder`), which is also what keeps an untouched reminder
  // from being cleared by saving an unrelated field after its moment passed.
  const reminderDirty = preset !== initialPreset || customAt !== item.reminderAt
  const needsDue = reminderDirty && (preset === 'due-day' || preset === 'hour-before') && dueValue === undefined
  const passed = reminderDirty && preset !== 'none' && preset !== 'custom' && !needsDue && armedAt === undefined

  const listOptions: Choice<string>[] = [
    { key: DEFAULT_LIST, label: t('todo.rail.default') },
    ...lists.map(list => ({ key: list.id, label: list.name })),
  ]
  const priorityOptions: Choice<PriorityKey>[] = [
    { key: 'none', label: t('todo.priority.none') },
    { key: '0', label: t('todo.priority.low') },
    { key: '1', label: t('todo.priority.normal') },
    { key: '2', label: t('todo.priority.high') },
  ]
  const repeatOptions: Choice<RepeatKey>[] = [
    { key: 'none', label: t('todo.repeat.none') },
    { key: 'daily', label: repeatLabel('daily', t) },
    { key: 'weekly', label: repeatLabel('weekly', t) },
    { key: 'monthly', label: repeatLabel('monthly', t) },
    { key: 'yearly', label: repeatLabel('yearly', t) },
    { key: 'weekday', label: repeatLabel('weekday', t) },
  ]
  const reminderOptions: Choice<ReminderKey>[] = [
    { key: 'none', label: t('todo.reminder.presetNone') },
    { key: 'due-day', label: t('todo.reminder.presetDueDay') },
    { key: 'hour-before', label: t('todo.reminder.presetHourBefore') },
    { key: 'custom', label: t('todo.reminder.custom') },
  ]

  const save = async (): Promise<void> => {
    if (trimmedText === '') {
      setFailure(t('todo.error.textRequired'))
      return
    }
    if (repeat !== 'none' && (!Number.isInteger(periodValue) || periodValue < 1)) {
      setFailure(t('todo.error.repeatInvalid', { limit: MAX_REPEAT_INTERVAL }))
      return
    }
    if (repeat !== 'none' && periodValue > MAX_REPEAT_INTERVAL) {
      setFailure(t('todo.edit.intervalMax', { limit: MAX_REPEAT_INTERVAL }))
      return
    }
    const patch: { -readonly [K in keyof TaskPatch]: TaskPatch[K] } = {}
    if (trimmedText !== item.text) patch.text = trimmedText
    const currentDue = item.due ?? undefined
    if (dueValue !== currentDue) patch.due = dueValue ?? null
    const currentList = item.listId ?? DEFAULT_LIST
    if (listKey !== currentList) patch.listId = listKey === DEFAULT_LIST ? null : listKey
    const currentPriority = item.priority === undefined ? 'none' : String(item.priority)
    if (priority !== currentPriority) {
      patch.priority = priority === 'none' ? null : (Number(priority) as 0 | 1 | 2)
    }
    const currentRepeat = item.repeat?.freq ?? 'none'
    const currentInterval = item.repeat?.interval ?? 1
    if (repeat !== currentRepeat || (repeat !== 'none' && periodValue !== currentInterval)) {
      const rule: RepeatRule | null = repeat === 'none' ? null : { freq: repeat, interval: periodValue }
      patch.repeat = rule
    }
    const currentNotes = item.notes ?? ''
    if (trimmedNotes !== currentNotes) patch.notes = trimmedNotes === '' ? null : trimmedNotes
    // The reminder travels only when the user changed a reminder control. A deadline
    // change is handled by the host, which re-derives a derived instant and leaves a
    // hand-picked one alone (`store.ts` `retimeDueReminder`) — sending an instant here
    // would take that decision away from the place that knows the source. The SOURCE
    // rides along whenever an instant is set, so a later deadline move can tell the
    // two apart.
    if (reminderDirty) {
      const nextReminderAt = armedAt ?? null
      patch.reminderAt = nextReminderAt
      if (nextReminderAt !== null && preset !== 'none') patch.reminderSource = preset
    }

    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    // A refused write keeps the dialog open with the reason inside it: the page's own
    // notice sits behind the modal, where the user cannot see it.
    const message = await onSave(patch)
    if (message !== undefined) setFailure(message)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('todo.edit.title')}
      closeLabel={t('todo.view.close')}
      footer={(
        <div className="dshTodo-editorFooter">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('todo.edit.cancel')}</Button>
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => { void save() }}>{t('todo.edit.save')}</Button>
        </div>
      )}
      className="dshTodo-editorModal"
    >
      <div className="dshTodo-editor">
        <div className="dshTodo-editorField">
          <label className="dshTodo-editorLabel" htmlFor="dshTodo-editText">{t('todo.edit.text')}</label>
          <Input
            id="dshTodo-editText"
            type="text"
            className="dshTodo-editorInput"
            value={text}
            disabled={busy}
            data-modal-autofocus
            onChange={(event) => { setText(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              }
            }}
          />
        </div>

        <div className="dshTodo-editorField">
          <label className="dshTodo-editorLabel" htmlFor="dshTodo-editDue">{t('todo.edit.due')}</label>
          <div className="dshTodo-editorRow">
            <Input
              id="dshTodo-editDue"
              type="date"
              className="dshTodo-editorInput"
              value={due}
              disabled={busy}
              onChange={(event) => { setDue(event.target.value) }}
            />
            {dueValue === undefined ? null : (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setDue('') }}>
                {t('todo.edit.dueClear')}
              </Button>
            )}
          </div>
        </div>

        <ChoiceField label={t('todo.edit.list')} value={listKey} options={listOptions} disabled={busy} onChange={setListKey} />
        <ChoiceField label={t('todo.edit.priority')} value={priority} options={priorityOptions} disabled={busy} onChange={setPriority} />
        <ChoiceField label={t('todo.edit.repeat')} value={repeat} options={repeatOptions} disabled={busy} onChange={setRepeat} />
        {repeat === 'none' ? null : (
          <div className="dshTodo-editorField">
            <label className="dshTodo-editorLabel" htmlFor="dshTodo-editInterval">{t('todo.edit.interval')}</label>
            <Input
              id="dshTodo-editInterval"
              type="number"
              min={1}
              max={MAX_REPEAT_INTERVAL}
              step={1}
              className="dshTodo-editorInterval"
              value={period}
              disabled={busy}
              onChange={(event) => { setPeriod(event.target.value) }}
            />
          </div>
        )}

        <ChoiceField label={t('todo.edit.reminder')} value={preset} options={reminderOptions} disabled={busy} onChange={setPreset} />
        {preset === 'custom' ? (
          <div className="dshTodo-editorRow">
            <ReminderPicker value={customAt} onChange={setCustomAt} t={t} disabled={busy} compact />
          </div>
        ) : null}
        {needsDue ? <p className="dshTodo-editorHint">{t('todo.edit.reminderNeedsDue')}</p> : null}
        {passed ? <p className="dshTodo-editorHint">{t('todo.edit.reminderPassed')}</p> : null}
        {reminderDirty && preset !== 'none' && armedAt !== undefined ? (
          <p className="dshTodo-editorHint">{t('todo.reminder.rowTooltip', { time: formatTime(armedAt) })}</p>
        ) : null}

        <div className="dshTodo-editorField">
          <label className="dshTodo-editorLabel" htmlFor="dshTodo-editNotes">{t('todo.edit.notes')}</label>
          <textarea
            id="dshTodo-editNotes"
            className="dshTodo-editorNotes"
            value={notes}
            rows={3}
            placeholder={t('todo.edit.notesPlaceholder')}
            disabled={busy}
            onChange={(event) => { setNotes(event.target.value) }}
          />
        </div>

        {failure === undefined ? null : <p className="dshTodo-editorError" role="alert">{failure}</p>}
      </div>
    </Modal>
  )
}
