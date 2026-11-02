/**
 * The todo page: the board first, the statistics below it.
 *
 * The container owns the back link and Escape (see `plugin-workbench/src/client/page.tsx`),
 * so this file renders the content of the page and nothing else. The page prints its own
 * title, and every number comes from the shared board (`board.ts`): opening the page never
 * shows a spinner over data the card already loaded.
 *
 * A write answers the whole board and lands in the same cache, so the card behind the panel
 * updates with the page. A failed write leaves the last good board on screen and says why,
 * in the user's language: the host's coded failures go through `client/errors.ts`, so a
 * `route.listNameInvalid` never reaches a sentence as a raw code.
 *
 * THE BOARD IS TWO AXES, and both are visible here. The rail picks a list (or everything,
 * or the unfiled tasks) and the tabs pick a view (today / overdue / upcoming / done / all);
 * the rows obey the same one-predicate rule the card and the host tool use (`views.ts`
 * `inView`), which is why a task cannot be late on one surface and not on another.
 *
 * The page owns WHICH day the calendar has selected, because the dialog that day opens is
 * portaled from here and the rows it lists are the same rows this file already groups: one
 * index, built here, shared by the month, the week and the dialog.
 *
 * @module @dsh-app/plugin-todo/client/view
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, Menu, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  addTask,
  batchTasks,
  editTask,
  listAction,
  removeTask,
  subtaskAction,
  toggleTask,
  updateTaskReminder,
  type BatchAction,
  type TaskPatch,
} from './api.ts'
import { applyBoard, refreshBoard, useBoard } from './board.ts'
import { itemsByDay } from './daydata.ts'
import { DayPanel } from './daypanel.tsx'
import { TaskEditor } from './editor.tsx'
import { errorFrom } from './errors.ts'
import { keyOf, partsOf, percent } from './format.ts'
import { ListRail, type ListFilter } from './listrail.tsx'
import { ReminderPicker } from './reminder.tsx'
import { TaskRow } from './rows.tsx'
import { TodoStats } from './stats.tsx'
import type { TodoKey } from './locales.ts'
import type { Translate } from './translate.ts'
import { dateLabel, weekdayName } from './translate.ts'
import { countInView, dueDay, inView, type TodoView } from '../views.ts'
import type { CompletionReport, TodoItem, TodoSnapshot } from '../wire.ts'
// The masthead illustration ships inside the client bundle (esbuild inlines it as a
// data URL), so the plugin needs no runtime asset directory.
import calendarArt from '../assets/todo-calendar.svg'

/** Maximum finished rows shown before collapsing. */
const FINISHED_COLLAPSED_LIMIT = 5

/** The tabs, in the order the board offers them. */
const VIEWS = ['today', 'overdue', 'upcoming', 'done', 'all'] as const

/** The dictionary key one tab's label comes from. */
const VIEW_LABEL_KEYS: Readonly<Record<TodoView, TodoKey>> = {
  today: 'todo.view.today',
  overdue: 'todo.tab.overdue',
  upcoming: 'todo.tab.upcoming',
  done: 'todo.tab.done',
  all: 'todo.tab.all',
}

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

/**
 * One view's rows in the order a reader expects.
 *
 * The deadline sorts the open views (soonest first, which is the order a day's work is
 * worked through), an unset priority goes after the numbered ones rather than being
 * called low (`wire.ts` `TodoItem.priority`), and a finished row sorts by when it was
 * finished, newest first.
 * @param items - the rows already filtered to one view.
 * @param view - which view they are in.
 */
function sortForView(items: readonly TodoItem[], view: TodoView): TodoItem[] {
  const rank = (item: TodoItem): number => (item.priority === undefined ? 3 : 2 - item.priority)
  const open = items.filter(item => !item.done)
  const done = items.filter(item => item.done)
  open.sort((left, right) => {
    const byDue = dueDay(left).localeCompare(dueDay(right))
    if (byDue !== 0) return byDue
    const byRank = rank(left) - rank(right)
    if (byRank !== 0) return byRank
    return left.createdAt - right.createdAt
  })
  done.sort((left, right) => (right.doneAt ?? right.createdAt) - (left.doneAt ?? left.createdAt))
  if (view === 'done') return done
  return [...open, ...done]
}

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
  const [view, setView] = useState<TodoView>('today')
  const [listFilter, setListFilter] = useState<ListFilter>('all')
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<readonly string[]>([])
  const [stepsOpen, setStepsOpen] = useState<readonly string[]>([])
  const [editing, setEditing] = useState<TodoItem | undefined>(undefined)
  const [moveMenu, setMoveMenu] = useState(false)
  const [priorityMenu, setPriorityMenu] = useState(false)
  const [batchDue, setBatchDue] = useState('')
  /** What the last action reported that is not a failure: a routine's successor. */
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => { void refreshBoard() }, [])

  // The reminder notice is NOT this page's: it is mounted at plugin level
  // (`reminders.ts` + `reminder-toast-host.tsx`) so it can interrupt a conversation.
  const board = state.snapshot

  /**
   * Run one write and report its failure as a sentence.
   *
   * The message is RETURNED as well as shown, because a dialog that stays open on a
   * refusal has to print the reason inside itself: the page's own notice sits behind
   * the modal, where the user cannot see it.
   */
  const runMessage = useCallback(async (op: () => Promise<TodoSnapshot>): Promise<string | undefined> => {
    setBusy(true)
    setFailure(undefined)
    try {
      applyBoard(await op())
      return undefined
    } catch (error) {
      const message = errorFrom(t, error)
      setFailure(message)
      return message
    } finally {
      setBusy(false)
    }
  }, [t])

  const run = useCallback(
    async (op: () => Promise<TodoSnapshot>): Promise<boolean> => (await runMessage(op)) === undefined,
    [runMessage],
  )

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
    // The composer files the task under whatever the rail is showing, so a task typed
    // while a list is selected lands there instead of in the default list.
    const listId = listFilter !== 'all' && listFilter !== 'default' ? listFilter : undefined
    void run(() => addTask(text, undefined, targetReminder, listId === undefined ? {} : { listId }))
  }

  /**
   * Say what completing a repeating task did.
   *
   * Ticking a routine is the one write whose consequence is INVISIBLE: a successor is
   * filed under a later day, so it does not appear in the row the user just ticked.
   * The route reports it (`wire.ts` `CompletionReport`); this turns that into the one
   * sentence the board shows.
   */
  const reportCompletion = useCallback((report: CompletionReport | undefined): void => {
    if (report === undefined) return
    if (report.next !== undefined) {
      setNotice(t('todo.repeat.opened', { date: dateLabel(t, report.next.due) }))
      return
    }
    if (report.skipped === 'open-instance') setNotice(t('todo.repeat.skippedOpen'))
    else if (report.skipped === 'invalid-rule') setNotice(t('todo.repeat.skippedInvalid'))
  }, [t])

  // The notice takes itself down: the watcher drops it as soon as the task it shows
  // is done or gone, so these handlers only have to change the board.
  const onToggle = useCallback((id: string, done: boolean): void => {
    void (async () => {
      setBusy(true)
      setFailure(undefined)
      setNotice(undefined)
      try {
        const answer = await toggleTask(id, done)
        applyBoard(answer)
        reportCompletion(answer.repeat)
      } catch (error) {
        setFailure(errorFrom(t, error))
      } finally {
        setBusy(false)
      }
    })()
  }, [reportCompletion, t])

  const onRemove = useCallback((id: string): void => {
    void run(() => removeTask(id))
  }, [run])

  const onUpdateReminder = useCallback((id: string, targetReminder?: number): void => {
    void run(() => updateTaskReminder(id, targetReminder, false))
  }, [run])

  const onWriteStep = useCallback((action: 'add' | 'remove' | 'rename' | 'toggle', body: Record<string, unknown>): void => {
    void run(() => subtaskAction(action, body))
  }, [run])

  const onToggleSteps = useCallback((id: string): void => {
    setStepsOpen(current => (current.includes(id) ? current.filter(entry => entry !== id) : [...current, id]))
  }, [])

  const onSelectTask = useCallback((id: string): void => {
    setSelection(current => (current.includes(id) ? current.filter(entry => entry !== id) : [...current, id]))
  }, [])

  const onEdit = useCallback((item: TodoItem): void => { setEditing(item) }, [])

  const onSaveEdit = useCallback(async (patch: TaskPatch): Promise<string | undefined> => {
    const item = editing
    if (item === undefined) return undefined
    const message = await runMessage(() => editTask(item.id, patch))
    if (message === undefined) setEditing(undefined)
    return message
  }, [editing, runMessage])

  const runBatch = useCallback(async (
    action: BatchAction,
    extra?: { listId?: string | null, priority?: 0 | 1 | 2 | null, due?: string | null },
  ): Promise<void> => {
    if (selection.length === 0) return
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const answer = await batchTasks(action, selection, extra ?? {})
      applyBoard(answer)
      if (answer.batch.failed.length > 0) {
        setFailure(t('todo.batch.failed', { count: answer.batch.failed.length }))
      }
      // A selection of forty completions can open forty successors and skip some, so
      // the answer carries one report per COMPLETED row and this says the two counts
      // apart: "some were skipped" is the line a user needs, because a skipped series
      // has no successor to notice.
      const reports = answer.batch.done.flatMap(row => (row.repeat === undefined ? [] : [row.repeat]))
      const opened = reports.filter(report => report.next !== undefined).length
      const skipped = reports.filter(report => report.skipped !== undefined).length
      if (skipped > 0) setNotice(t('todo.repeat.batchSkipped', { count: skipped }))
      else if (opened > 0) setNotice(t('todo.repeat.batchOpened', { count: opened }))
      setSelection([])
      setSelecting(false)
    } catch (error) {
      setFailure(errorFrom(t, error))
    } finally {
      setBusy(false)
    }
  }, [selection, t])

  const moveList = useCallback((id: string, offset: -1 | 1): void => {
    if (board === undefined) return
    const ids = board.lists.map(list => list.id)
    const at = ids.indexOf(id)
    const to = at + offset
    if (at < 0 || to < 0 || to >= ids.length) return
    const next = [...ids]
    const moved = next[at]!
    next[at] = next[to]!
    next[to] = moved
    void run(() => listAction('reorder', { ids: next }))
  }, [board, run])

  const index = useMemo(() => itemsByDay(board?.items ?? []), [board])

  // Pressing the selected day again closes the dialog.
  const onSelect = useCallback((day: string): void => {
    setSelected(current => (current === day ? undefined : day))
  }, [])

  const lists = board?.lists ?? []
  const items = board?.items ?? []

  // The rail's own counts ignore the tab: it is a map of the board, not of the view.
  const railCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0, default: 0 }
    for (const list of lists) counts[list.id] = 0
    for (const item of items) {
      if (item.done) continue
      counts.all = (counts.all ?? 0) + 1
      const key = item.listId ?? 'default'
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }, [items, lists])

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
  // A failure from a write wins over a stale read error, and the batch's partial
  // failure is already a sentence by the time it lands here.
  const problem = failure ?? state.error
  const today = partsOf(board.today)
  const panelDay = selected

  const scoped = board.items.filter((item) => {
    if (listFilter === 'all') return true
    if (listFilter === 'default') return item.listId === undefined
    return item.listId === listFilter
  })
  const visible = sortForView(scoped.filter(item => inView(item, view, board.today)), view)
  // The today tab keeps the collapsible "done today" group it always had; the other
  // tabs show their own view, and the done tab is the whole finished history.
  const finishedToday = view === 'today'
    ? sortForView(scoped.filter(item => item.done && keyOf(item.doneAt ?? item.createdAt) === board.today), 'done')
    : []
  const tabs = VIEWS.map(entry => ({
    value: entry,
    label: `${t(VIEW_LABEL_KEYS[entry])} ${String(countInView(scoped, entry, board.today))}`,
  }))
  const listOptions = [
    { id: 'default', label: t('todo.rail.default') },
    ...lists.map(list => ({ id: list.id, label: list.name })),
  ]

  const row = (item: TodoItem): ReactNode => (
    <TaskRow
      key={item.id}
      item={item}
      busy={busy}
      t={t}
      today={board.today}
      lists={lists}
      showList={listFilter === 'all'}
      onToggle={onToggle}
      onRemove={onRemove}
      onUpdateReminder={onUpdateReminder}
      onEdit={onEdit}
      onWriteStep={onWriteStep}
      stepsOpen={stepsOpen.includes(item.id)}
      onToggleSteps={onToggleSteps}
      selectable={selecting}
      selected={selection.includes(item.id)}
      onSelect={onSelectTask}
    />
  )

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

      <div className="dshTodo-workspace">
        <ListRail
          lists={lists}
          counts={railCounts}
          selected={listFilter}
          busy={busy}
          t={t}
          onSelect={setListFilter}
          onCreate={(name) => runMessage(() => listAction('create', { name }))}
          onRename={(id, name) => runMessage(() => listAction('rename', { id, name }))}
          onRemove={async (id) => {
            const message = await runMessage(() => listAction('remove', { id }))
            if (message === undefined && listFilter === id) setListFilter('all')
            return message
          }}
          onMove={moveList}
        />

        <section className="dshTodo-board" aria-labelledby="dshTodo-board-title">
          <h3 id="dshTodo-board-title" className="dshTodo-sectionTitle dshTodo-sr">{t('todo.rail.title')}</h3>

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

          <div className="dshTodo-boardHead">
            <SegmentedControl
              id="dshTodo-view"
              className="dshTodo-viewTabs"
              value={view}
              options={tabs}
              label={t('todo.board.views')}
              disabled={busy}
              onChange={(next) => { setView(next) }}
            />
            <Button
              type="button"
              variant={selecting ? 'primary' : 'outline'}
              size="sm"
              className="dshTodo-selectBtn"
              aria-pressed={selecting}
              disabled={busy}
              onClick={() => {
                setSelecting(current => !current)
                setSelection([])
              }}
            >
              {t(selecting ? 'todo.board.exitSelect' : 'todo.board.selectMode')}
            </Button>
          </div>

          {problem === undefined ? null : (
            <Notice
              text={t(failure === undefined ? 'todo.error.load' : 'todo.error.save', { detail: problem })}
              action={t('todo.view.retry')}
              onAction={retry}
            />
          )}

          {selecting ? (
            <div className="dshTodo-batch" role="toolbar" aria-label={t('todo.batch.selected', { count: selection.length })}>
              <span className="dshTodo-batchCount">{t('todo.batch.selected', { count: selection.length })}</span>
              <Button type="button" variant="outline" size="sm" disabled={busy || selection.length === 0} onClick={() => { void runBatch('complete') }}>
                {t('todo.batch.complete')}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy || selection.length === 0} onClick={() => { void runBatch('uncomplete') }}>
                {t('todo.batch.uncomplete')}
              </Button>
              <Menu
                open={moveMenu}
                onClose={() => { setMoveMenu(false) }}
                align="start"
                items={listOptions}
                onSelect={(id) => {
                  setMoveMenu(false)
                  void runBatch('move', { listId: id === 'default' ? null : id })
                }}
                anchor={(
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || selection.length === 0}
                    aria-label={t('todo.batch.listLabel')}
                    aria-expanded={moveMenu}
                    onClick={() => { setMoveMenu(!moveMenu) }}
                  >
                    {t('todo.batch.move')}
                  </Button>
                )}
              />
              <Menu
                open={priorityMenu}
                onClose={() => { setPriorityMenu(false) }}
                align="start"
                items={[
                  { id: 'none', label: t('todo.priority.none') },
                  { id: '0', label: t('todo.priority.low') },
                  { id: '1', label: t('todo.priority.normal') },
                  { id: '2', label: t('todo.priority.high') },
                ]}
                onSelect={(id) => {
                  setPriorityMenu(false)
                  void runBatch('setPriority', { priority: id === 'none' ? null : Number(id) as 0 | 1 | 2 })
                }}
                anchor={(
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || selection.length === 0}
                    aria-label={t('todo.batch.priority')}
                    aria-expanded={priorityMenu}
                    onClick={() => { setPriorityMenu(!priorityMenu) }}
                  >
                    {t('todo.batch.priority')}
                  </Button>
                )}
              />
              <Input
                className="dshTodo-batchDate"
                type="date"
                value={batchDue}
                aria-label={t('todo.batch.dueLabel')}
                disabled={busy || selection.length === 0}
                onChange={(event) => { setBatchDue(event.target.value) }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || selection.length === 0 || batchDue === ''}
                onClick={() => { void runBatch('setDue', { due: batchDue }) }}
              >
                {t('todo.batch.setDue')}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy || selection.length === 0} onClick={() => { void runBatch('remove') }}>
                {t('todo.batch.remove')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setSelection([]); setSelecting(false) }}>
                {t('todo.batch.clear')}
              </Button>
            </div>
          ) : null}

          {notice === undefined ? null : <p className="dshTodo-batchNote" role="status">{notice}</p>}

          {board.items.length === 0 ? (
            <div className="dshTodo-empty">
              <span className="dshTodo-emptyMark" aria-hidden="true"><ChecklistMark size={22} /></span>
              <p className="dshTodo-emptyText">{t('todo.view.empty')}</p>
            </div>
          ) : visible.length === 0 && finishedToday.length === 0 ? (
            <div className="dshTodo-empty">
              <span className="dshTodo-emptyMark" aria-hidden="true"><ChecklistMark size={22} /></span>
              <p className="dshTodo-emptyText">{t('todo.board.emptyView')}</p>
            </div>
          ) : (
            <div className="dshTodo-group">
              {visible.length === 0 ? null : (
                <>
                  <p className="dshTodo-groupHead">
                    {view === 'done' || view === 'all'
                      ? t('todo.board.allHeading', { count: visible.length })
                      : t('todo.board.openHeading', { count: visible.filter(item => !item.done).length })}
                  </p>
                  <ul className="dshTodo-list">{visible.map(row)}</ul>
                </>
              )}
              {finishedToday.length === 0 ? null : (
                <>
                  <button
                    type="button"
                    className="dshTodo-groupHeadBtn"
                    aria-expanded={doneSectionOpen}
                    onClick={() => { setDoneSectionOpen(current => !current) }}
                  >
                    <span>{t('todo.view.doneHeading', { count: finishedToday.length })}</span>
                    <span className="dshTodo-groupHeadIcon" data-expanded={doneSectionOpen ? 'true' : undefined} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3 4.5 3 3 3-3" />
                      </svg>
                    </span>
                  </button>
                  {doneSectionOpen ? (
                    <>
                      <ul className="dshTodo-list">
                        {(finishedToday.length > FINISHED_COLLAPSED_LIMIT && !doneExpanded
                          ? finishedToday.slice(0, FINISHED_COLLAPSED_LIMIT)
                          : finishedToday
                        ).map(row)}
                      </ul>
                      {finishedToday.length > FINISHED_COLLAPSED_LIMIT ? (
                        <div className="dshTodo-groupMoreWrap">
                          <button
                            type="button"
                            className="dshTodo-agendaExpandBtn"
                            aria-expanded={doneExpanded}
                            onClick={() => { setDoneExpanded(expanded => !expanded) }}
                          >
                            <span>
                              {doneExpanded
                                ? t('todo.day.collapse')
                                : t('todo.day.expandMore', { count: finishedToday.length - FINISHED_COLLAPSED_LIMIT })}
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
      </div>

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
        onEdit={onEdit}
        onClose={() => { setSelected(undefined) }}
      />

      {editing === undefined ? null : (
        <TaskEditor
          key={editing.id}
          item={editing}
          lists={lists}
          busy={busy}
          t={t}
          onSave={onSaveEdit}
          onClose={() => { setEditing(undefined) }}
        />
      )}

      <BottomDecoration />
    </div>
  )
}
