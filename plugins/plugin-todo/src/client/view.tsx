/**
 * The todo page: today first, the statistics below it.
 *
 * The container owns the back link and Escape (see `plugin-workbench/src/client/page.tsx`),
 * so this file renders the content of the page and nothing else. The page prints its own
 * title, and every number comes from the shared board (`board.ts`): opening the page never
 * shows a spinner over data the card already loaded.
 *
 * A write answers the whole board and lands in the same cache, so the card behind the panel
 * updates with the page. A failed write leaves the last good board on screen and says why.
 * Its retry re-reads the board rather than repeating the write, because the write may
 * already have landed.
 *
 * The page owns WHICH day the calendar has selected, because the dialog that day opens is
 * portaled from here and the rows it lists are the same rows this file already groups: one
 * index, built here, shared by the month, the week and the dialog.
 *
 * @module @dsh-app/plugin-todo/client/view
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { addTask, removeTask, toggleTask, updateTaskReminder, type TodoError } from './api.ts'
import { applyBoard, refreshBoard, useBoard } from './board.ts'
import { itemsByDay } from './daydata.ts'
import { DayPanel } from './daypanel.tsx'
import { keyOf, partsOf, percent } from './format.ts'
import { ReminderPicker } from './reminder.tsx'
import { TaskRow } from './rows.tsx'
import { TodoStats } from './stats.tsx'
import type { Translate } from './translate.ts'
import { dateLabel, weekdayName } from './translate.ts'
import type { TodoItem, TodoSnapshot } from '../wire.ts'
// The masthead illustration ships inside the client bundle (esbuild inlines it as a
// data URL), so the plugin needs no runtime asset directory.
import calendarArt from '../assets/todo-calendar.svg'

/**
 * A message with the one action that can recover from it.
 * @param props.text - what went wrong, already localised.
 * @param props.action - the recovery label.
 * @param props.onAction - runs the recovery.
 */
function Notice({ text, action, onAction }: {
  text: string
  action: string
  onAction: () => void
}): ReactNode {
  return (
    <div className="dshTodo-notice" role="alert">
      <span>{text}</span>
      <Button type="button" variant="outline" size="sm" onClick={onAction}>{action}</Button>
    </div>
  )
}

/**
 * The page body before the first board answers: a quiet placeholder while the read is in
 * flight, or the failure with its retry.
 * @param props.error - the first read's failure, when it failed.
 * @param props.t - the dictionary seat.
 * @param props.onRetry - re-reads the board.
 */
function BoardPlaceholder({ error, t, onRetry }: {
  error: string | undefined
  t: Translate
  onRetry: () => void
}): ReactNode {
  if (error !== undefined) {
    return <Notice text={t('todo.error.load', { detail: error })} action={t('todo.view.retry')} onAction={onRetry} />
  }
  return (
    <div className="dshTodo-skeleton" role="status">
      <span className="dshTodo-sr">{t('todo.card.loading')}</span>
      <span className="dshTodo-skeletonBar dshTodo-skeletonFigure" aria-hidden="true" />
      <span className="dshTodo-skeletonBar dshTodo-skeletonShort" aria-hidden="true" />
    </div>
  )
}

/** The page's mark: a checklist, drawn once and reused by the card and the empty state. */
function ChecklistMark({ size }: { size: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" />
      <path d="M4.2 7.2 6.1 9.1 9.9 5" />
    </svg>
  )
}

/**
 * Cheerful meadow hills and sparkles at the base of the page.
 * Pure vector SVG decoration; pointer-events: none keeps every click intact.
 */
function BottomDecoration(): ReactNode {
  return (
    <div className="dshTodo-bottomDeco" aria-hidden="true">
      <svg
        className="dshTodo-bottomSvg"
        viewBox="0 0 1200 120"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          className="dshTodo-hillBack"
          d="M0 70 Q 280 20 600 65 T 1200 50 L 1200 120 L 0 120 Z"
        />
        <path
          className="dshTodo-hillFront"
          d="M0 50 Q 220 15 450 60 T 950 35 Q 1100 45 1200 70 L 1200 120 L 0 120 Z"
        />
      </svg>
      <svg
        className="dshTodo-bottomSparkles"
        viewBox="0 0 80 80"
        fill="none"
        stroke="#FFD05A"
        strokeWidth="3.5"
        strokeLinecap="round"
      >
        <path d="M34 42 L18 40" />
        <path d="M32 34 L18 20" />
        <path d="M38 28 L32 12" />
      </svg>
    </div>
  )
}

/** Maximum finished rows shown before collapsing. */
const FINISHED_COLLAPSED_LIMIT = 5

/**
 * Render the todo page content.
 * @param props.t - the dictionary seat.
 */
export function TodoView({ t }: { t: Translate }): ReactNode {
  const state = useBoard()
  const [draft, setDraft] = useState('')
  const [reminderAt, setReminderAt] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [doneSectionOpen, setDoneSectionOpen] = useState(true)
  const [doneExpanded, setDoneExpanded] = useState(false)

  useEffect(() => { void refreshBoard() }, [])

  // The reminder notice is NOT this page's: it is mounted at plugin level
  // (`reminders.ts` + `reminder-toast-host.tsx`) so it can interrupt a conversation.
  const board = state.snapshot

  const run = useCallback(async (op: () => Promise<TodoSnapshot>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      applyBoard(await op())
    } catch (error) {
      setFailure((error as TodoError).detail)
    } finally {
      setBusy(false)
    }
  }, [])

  const retry = useCallback((): void => {
    setFailure(undefined)
    void refreshBoard()
  }, [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    const targetReminder = reminderAt
    setReminderAt(undefined)
    void run(() => addTask(text, undefined, targetReminder))
  }

  // The notice takes itself down: the watcher drops it as soon as the task it shows
  // is done or gone, so these handlers only have to change the board.
  const onToggle = useCallback((id: string, done: boolean): void => {
    void run(() => toggleTask(id, done))
  }, [run])

  const onRemove = useCallback((id: string): void => {
    void run(() => removeTask(id))
  }, [run])

  const onUpdateReminder = useCallback((id: string, targetReminder?: number): void => {
    void run(() => updateTaskReminder(id, targetReminder, false))
  }, [run])

  const index = useMemo(() => itemsByDay(board?.items ?? []), [board])

  // Pressing the selected day again closes the dialog.
  const onSelect = useCallback((day: string): void => {
    setSelected(current => (current === day ? undefined : day))
  }, [])

  if (board === undefined) {
    return (
      <div className="dshTodo-view">
        <BoardPlaceholder error={state.error} t={t} onRetry={retry} />
      </div>
    )
  }

  const open = board.items.filter(item => !item.done)
  const finished = board.items.filter(item => item.done && keyOf(item.doneAt ?? item.createdAt) === board.today)
  const total = open.length + finished.length
  const problem = failure ?? state.error
  const today = partsOf(board.today)
  const panelDay = selected

  return (
    <div className="dshTodo-view">
      <div className="dshTodo-masthead">
        <img className="dshTodo-mastArt" src={calendarArt} alt="" aria-hidden="true" />
        <header className="dshTodo-head">
          <div className="dshTodo-headText">
            <h2 className="dshTodo-title">
              <span className="dshTodo-titleMark" aria-hidden="true"><ChecklistMark size={14} /></span>
              {t('todo.view.title')}
            </h2>
            <p className="dshTodo-sub">
              {t('todo.view.date', { date: dateLabel(t, board.today, 'ymd'), weekday: weekdayName(t, today.weekday) })}
            </p>
          </div>
          <div
            className="dshTodo-headBadge"
            data-completed={total > 0 && finished.length === total ? 'true' : undefined}
            aria-label={t('todo.view.progress', { done: finished.length, total })}
          >
            <span className="dshTodo-headBadgeIcon" aria-hidden="true">
              {total > 0 && finished.length === total ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.5 L4.8 8.8 L9.5 3.5" />
                </svg>
              ) : (
                <span className="dshTodo-headBadgeDot" />
              )}
            </span>
            <span className="dshTodo-headBadgeText">
              {t('todo.view.progress', { done: finished.length, total })}
            </span>
          </div>
        </header>
        <div
          className="dshTodo-meter"
          data-completed={total > 0 && finished.length === total ? 'true' : undefined}
          aria-hidden="true"
        >
          <span className="dshTodo-meterFill" style={{ width: `${String(percent(finished.length, total))}%` }} />
        </div>
      </div>

      <section className="dshTodo-today" aria-labelledby="dshTodo-today-title">
        <h3 id="dshTodo-today-title" className="dshTodo-sectionTitle">{t('todo.view.today')}</h3>

        <form className="dshTodo-add" onSubmit={submit}>
          <Input
            className="dshTodo-addInput"
            type="text"
            value={draft}
            placeholder={t('todo.view.addPlaceholder')}
            aria-label={t('todo.view.addPlaceholder')}
            disabled={busy}
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <ReminderPicker value={reminderAt} onChange={setReminderAt} t={t} disabled={busy} />
          <Button type="submit" variant="primary" size="sm" disabled={busy || draft.trim() === ''}>
            {t('todo.view.addLabel')}
          </Button>
        </form>

        {problem === undefined ? null : (
          <Notice
            text={t(failure === undefined ? 'todo.error.load' : 'todo.error.save', { detail: problem })}
            action={t('todo.view.retry')}
            onAction={retry}
          />
        )}

        {total === 0 ? (
          <div className="dshTodo-empty">
            <span className="dshTodo-emptyMark" aria-hidden="true"><ChecklistMark size={22} /></span>
            <p className="dshTodo-emptyText">{t('todo.view.empty')}</p>
          </div>
        ) : (
          <div className="dshTodo-group">
            {open.length === 0 ? null : (
              <>
                <p className="dshTodo-groupHead">{t('todo.view.openHeading', { count: open.length })}</p>
                <ul className="dshTodo-list">
                  {open.map(item => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      busy={busy}
                      t={t}
                      today={board.today}
                      onToggle={onToggle}
                      onRemove={onRemove}
                      onUpdateReminder={onUpdateReminder}
                    />
                  ))}
                </ul>
              </>
            )}
            {finished.length === 0 ? null : (
              <>
                <button
                  type="button"
                  className="dshTodo-groupHeadBtn"
                  aria-expanded={doneSectionOpen}
                  onClick={() => { setDoneSectionOpen(open => !open) }}
                >
                  <span>{t('todo.view.doneHeading', { count: finished.length })}</span>
                  <span className="dshTodo-groupHeadIcon" data-expanded={doneSectionOpen ? 'true' : undefined} aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m3 4.5 3 3 3-3" />
                    </svg>
                  </span>
                </button>
                {doneSectionOpen ? (
                  <>
                    <ul className="dshTodo-list">
                      {(finished.length > FINISHED_COLLAPSED_LIMIT && !doneExpanded
                        ? finished.slice(0, FINISHED_COLLAPSED_LIMIT)
                        : finished
                      ).map(item => (
                        <TaskRow
                          key={item.id}
                          item={item}
                          busy={busy}
                          t={t}
                          today={board.today}
                          onToggle={onToggle}
                          onRemove={onRemove}
                        />
                      ))}
                    </ul>
                    {finished.length > FINISHED_COLLAPSED_LIMIT ? (
                      <div className="dshTodo-groupMoreWrap">
                        <button
                          type="button"
                          className="dshTodo-agendaExpandBtn"
                          aria-expanded={doneExpanded}
                          onClick={() => { setDoneExpanded(exp => !exp) }}
                        >
                          <span>
                            {doneExpanded
                              ? t('todo.day.collapse')
                              : t('todo.day.expandMore', { count: finished.length - FINISHED_COLLAPSED_LIMIT })}
                          </span>
                          <span className="dshTodo-agendaExpandIcon" data-expanded={doneExpanded ? 'true' : undefined} aria-hidden="true">
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m3 4.5 3 3 3-3" />
                            </svg>
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        )}
      </section>

      <TodoStats
        board={board}
        t={t}
        index={index}
        selected={selected}
        onSelect={onSelect}
      />

      <DayPanel
        open={panelDay !== undefined}
        day={panelDay}
        group={panelDay === undefined ? undefined : index.get(panelDay)}
        today={board.today}
        busy={busy}
        t={t}
        onAdd={(text, targetReminder) => {
          if (panelDay === undefined) return
          void run(() => addTask(text, panelDay, targetReminder))
        }}
        onToggle={onToggle}
        onRemove={onRemove}
        onUpdateReminder={onUpdateReminder}
        onClose={() => { setSelected(undefined) }}
      />

      <BottomDecoration />
    </div>
  )
}
