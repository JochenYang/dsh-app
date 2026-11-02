/**
 * The steps under one task: tick them, rename them, remove them, add one.
 *
 * A DISPLAY figure plus a small editor, never a second source of truth: the parent's
 * `done` is the user's own statement and is not derived from these (`wire.ts`
 * `TodoItem.subtasks`), so ticking every step leaves the task open and ticking the
 * task leaves its steps alone.
 *
 * Every write goes through the host's step route and answers the whole board, so a
 * dropped response leaves the checklist showing what the file still says rather than
 * a locally guessed state.
 *
 * @module @dsh-app/plugin-todo/client/steps
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  Checkbox,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  Input,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubtaskAction } from './api.ts'
import type { Translate } from './translate.ts'
import type { Subtask, TodoItem } from '../wire.ts'

/** What one step write asks the host for. */
export type StepWrite = (action: SubtaskAction, body: Record<string, unknown>) => void

/**
 * One step: its checkbox, its line, and the two controls that change it.
 * @param props.step - the step.
 * @param props.taskId - the task it belongs to.
 * @param props.t - the dictionary seat.
 * @param props.onWrite - applies one step action.
 */
function StepRow({ step, taskId, t, onWrite }: {
  step: Subtask
  taskId: string
  t: Translate
  onWrite: StepWrite
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(step.text)

  const commit = (): void => {
    const text = draft.trim()
    if (text === '' || text === step.text) {
      setEditing(false)
      setDraft(step.text)
      return
    }
    onWrite('rename', { id: taskId, subtaskId: step.id, text })
    setEditing(false)
  }

  return (
    <li className="dshTodo-step" data-done={step.done ? 'true' : undefined}>
      {editing ? (
        <Input
          className="dshTodo-stepInput"
          type="text"
          value={draft}
          aria-label={t('todo.edit.text')}
          data-modal-autofocus
          onChange={(event) => { setDraft(event.target.value) }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
              setDraft(step.text)
            }
          }}
        />
      ) : (
        <Checkbox
          className="dshTodo-stepCheck"
          checked={step.done}
          label={step.text}
          onChange={(next) => { onWrite('toggle', { id: taskId, subtaskId: step.id, done: next }) }}
        />
      )}
      <Tooltip label={t('todo.step.rename')} side="top">
        <button
          type="button"
          className="dshTodo-stepEdit"
          aria-label={`${t('todo.step.rename')}: ${step.text}`}
          onClick={() => { setDraft(step.text); setEditing(true) }}
        >
          <IconEditOutlineRegular />
        </button>
      </Tooltip>
      <Tooltip label={t('todo.step.remove')} side="top">
        <button
          type="button"
          className="dshTodo-stepRemove"
          aria-label={`${t('todo.step.remove')}: ${step.text}`}
          onClick={() => { onWrite('remove', { id: taskId, subtaskId: step.id }) }}
        >
          <IconCloseOutlineRegular />
        </button>
      </Tooltip>
    </li>
  )
}

/**
 * One task's checklist, with the box that appends a step.
 * @param props.item - the task whose steps these are.
 * @param props.t - the dictionary seat.
 * @param props.onWrite - applies one step action.
 */export function StepsPanel({ item, t, onWrite }: {
  item: TodoItem
  t: Translate
  onWrite: StepWrite
}): ReactNode {
  const [draft, setDraft] = useState('')
  const steps = item.subtasks ?? []

  const add = (): void => {
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    onWrite('add', { id: item.id, text })
  }

  return (
    <div className="dshTodo-steps">
      {steps.length === 0 ? <p className="dshTodo-stepEmpty">{t('todo.step.empty')}</p> : (
        <ul className="dshTodo-stepList">
          {steps.map(step => (
            <StepRow key={step.id} step={step} taskId={item.id} t={t} onWrite={onWrite} />
          ))}
        </ul>
      )}
      <div className="dshTodo-stepAdd">
        <Input
          className="dshTodo-stepAddInput"
          type="text"
          value={draft}
          placeholder={t('todo.step.placeholder')}
          aria-label={t('todo.step.add')}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={draft.trim() === ''} onClick={add}>
          {t('todo.step.add')}
        </Button>
      </div>
    </div>
  )
}

