/**
 * The week face: one row per day, Monday first, each carrying its tasks in full.
 *
 * Monday first because that is the order the calendar above it draws and the order a
 * week is read in everywhere else in this product; a reversed list put Monday at the
 * bottom, which reads as the week running backwards. Today is found by its marker
 * (the row carries `data-today`), not by its position, so the list does not have to
 * move for it.
 *
 * Seven narrow columns cannot hold a task's words, so each day is a row: the date on
 * the left, the day's tasks in the middle with their full text, and the day's completion
 * on the right. Today's row is marked, and a day the detail no longer holds says so in
 * place of an empty list.
 *
 * The completion figure is the store's count, which is history: a finished task that was
 * later deleted still counts. When the figure is larger than the finished rows on screen,
 * the row says how many are not listed, so the two never look like a disagreement.
 *
 * @module @dsh-app/plugin-todo/client/week
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DayIndex } from './daydata.ts'
import { statOf, totalsOf } from './daydata.ts'
import { TaskChips } from './dayrows.tsx'
import { percent, weekKeys } from './format.ts'
import type { Translate } from './translate.ts'
import { dateLabel, weekdayName } from './translate.ts'
import type { TodoSnapshot } from '../wire.ts'

/** Rows a day shows when collapsed. */
const WEEK_COLLAPSED_ROWS = 5

/**
 * Render the week agenda.
 * @param props.board - the board.
 * @param props.index - the board's rows grouped by day.
 * @param props.t - the dictionary seat.
 */
export function WeekFace({ board, index, t }: {
  board: TodoSnapshot
  index: DayIndex
  t: Translate
}): ReactNode {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const days = weekKeys(Date.now())
  const total = totalsOf(board.daily, days)
  // Monday first, the way the calendar above it is laid out. A reversed list put
  // Monday at the bottom, which reads as the week running backwards; today is found
  // by its marker rather than by its position, so no ordering is needed for that.
  const rows = days.map((day, position) => ({ day, position }))

  const toggleExpand = (day: string): void => {
    setExpanded(cur => ({ ...cur, [day]: !cur[day] }))
  }

  return (
    <div className="dshTodo-week">
      <div className="dshTodo-faceHead">
        <p className="dshTodo-summary">{t('todo.stats.summary', { done: total.done, created: total.created })}</p>
      </div>
      <div className="dshTodo-agenda">
        {rows.map(({ day, position }) => {
          const stat = statOf(board.daily, day)
          const group = index.get(day)
          const allTasks = group === undefined ? [] : [...group.open, ...group.done]
          const isExpanded = Boolean(expanded[day])
          const hasOverflow = allTasks.length > WEEK_COLLAPSED_ROWS
          const displayedRows = hasOverflow && !isExpanded
            ? allTasks.slice(0, WEEK_COLLAPSED_ROWS)
            : allTasks
          const listedDone = group?.done.length ?? 0
          const hasDetail = allTasks.length > 0

          return (
            <div key={day} className="dshTodo-agendaRow" data-today={day === board.today ? 'true' : undefined}>
              <div className="dshTodo-agendaDay">
                <span className="dshTodo-agendaWeekday">{weekdayName(t, position)}</span>
                <span className="dshTodo-agendaDate">{dateLabel(t, day)}</span>
              </div>
              <div className="dshTodo-agendaBody">
                {hasDetail ? <TaskChips items={displayedRows} t={t} /> : null}
                {hasOverflow ? (
                  <button
                    type="button"
                    className="dshTodo-agendaExpandBtn"
                    aria-expanded={isExpanded}
                    onClick={() => { toggleExpand(day) }}
                  >
                    <span>
                      {isExpanded
                        ? t('todo.day.collapse')
                        : t('todo.day.expandMore', { count: allTasks.length - WEEK_COLLAPSED_ROWS })}
                    </span>
                    <span className="dshTodo-agendaExpandIcon" data-expanded={isExpanded ? 'true' : undefined} aria-hidden="true">
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3 4.5 3 3 3-3" />
                      </svg>
                    </span>
                  </button>
                ) : null}
                {hasDetail && stat.done > listedDone ? (
                  <span className="dshTodo-agendaNote">{t('todo.day.unlisted', { count: stat.done - listedDone })}</span>
                ) : null}
                {!hasDetail && (stat.created > 0 || stat.done > 0) ? (
                  <span className="dshTodo-agendaNote">{t(stat.done > 0 ? 'todo.day.countsChip' : 'todo.day.counts', { done: stat.done })}</span>
                ) : null}
                {!hasDetail && stat.created === 0 && stat.done === 0 ? (
                  <span className="dshTodo-agendaNote">{t('todo.day.empty')}</span>
                ) : null}
              </div>
              <div
                className="dshTodo-agendaCount"
                data-completed={stat.created > 0 && stat.done >= stat.created ? 'true' : undefined}
              >
                <div className="dshTodo-agendaCountHead">
                  <span className="dshTodo-agendaFigure">
                    {stat.done}
                    <span aria-hidden="true"> / {stat.created}</span>
                    <span className="dshTodo-sr">{t('todo.stats.summary', { done: stat.done, created: stat.created })}</span>
                  </span>
                  <span className="dshTodo-agendaPercent">
                    {percent(stat.done, stat.created)}%
                  </span>
                </div>
                <div className="dshTodo-tally" aria-hidden="true">
                  <span className="dshTodo-tallyFill" style={{ width: `${String(percent(stat.done, stat.created))}%` }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
