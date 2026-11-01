/**
 * The year face: the contribution map, with its figures set above it.
 *
 * Kept as a map on purpose. A year is 365 cells, and what a reader asks of it is
 * rhythm — which stretches were busy — which a tinted square answers at a glance and
 * a printed date cannot. The figures above answer the questions a map cannot: how
 * many, on how many days, and for how long in a row.
 *
 * The tint is the status colour of a finished task, in four steps. "Did something"
 * and "did more" are the two things a year is read for, and a continuous scale makes
 * them look alike.
 *
 * HOVER names a cell through the primitive's Tooltip, pinned above it and portaled out
 * of the map's scroll container — the same bubble the month's cards speak, so both
 * faces answer a hover with one voice.
 *
 * @module @dsh-app/plugin-todo/client/year
 */

import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { runSummary, statOf, tierOf } from './daydata.ts'
import { partsOf, yearGrid, yearMonthLabels } from './format.ts'
import type { Translate } from './translate.ts'
import { dateLabel, weekdayName } from './translate.ts'
import type { TodoSnapshot } from '../wire.ts'

/** The four tints a legend and the map both draw from. */
const TIERS = [0, 1, 2, 3, 4] as const

/**
 * Render the year map.
 * @param props.board - the board.
 * @param props.t - the dictionary seat.
 */
export function YearFace({ board, t }: {
  board: TodoSnapshot
  t: Translate
}): ReactNode {
  const columns = yearGrid(Date.now())
  const labels = yearMonthLabels(columns)
  const days = columns.flat().filter((day): day is string => day !== null)
  const run = runSummary(board.daily, days)
  const year = partsOf(days[0] ?? board.today).year

  return (
    <div className="dshTodo-year">
      <dl className="dshTodo-metrics">
        <div>
          <dt>{t('todo.stats.metricDone')}</dt>
          {/* A bare number beside two figures that carry their unit read as a count
              without a thing counted, so this one carries its unit too. */}
          <dd>{t('todo.stats.items', { count: run.done })}</dd>
        </div>
        <div>
          <dt>{t('todo.stats.metricActive')}</dt>
          <dd>{t('todo.stats.days', { count: run.active })}</dd>
        </div>
        <div>
          <dt>{t('todo.stats.metricStreak')}</dt>
          <dd>{t('todo.stats.days', { count: run.longest })}</dd>
        </div>
      </dl>

      <div className="dshTodo-yearBody">
        <div className="dshTodo-yearMonths" aria-hidden="true">
          {labels.map((month, column) => (
            <span key={`month-${String(column)}`} className="dshTodo-yearMonth">
              {month === null ? '' : String(month)}
            </span>
          ))}
        </div>
        <div className="dshTodo-yearGrid" role="img" aria-label={t('todo.stats.yearLabel', { year })}>
          {columns.map((column, columnIndex) => column.map((day, rowIndex) => {
            const key = `cell-${String(columnIndex)}-${String(rowIndex)}`
            if (day === null) return <span key={key} className="dshTodo-yBlank" aria-hidden="true" />
            const stat = statOf(board.daily, day)
            // The same primitive Tooltip the month's cards use, portaled because the
            // map's own scroll container clips a bubble that stays in the flow: a
            // native title would be a second, unstyled voice on the same surface.
            return (
              <Tooltip
                key={key}
                side="top"
                delayMs={150}
                maxWidth={320}
                portal
                label={() => `${t('todo.view.date', { date: dateLabel(t, day), weekday: weekdayName(t, partsOf(day).weekday) })} · ${t('todo.day.summary', { done: stat.done, created: stat.created })}`}
              >
                <span
                  className="dshTodo-yCell"
                  data-tier={tierOf(stat)}
                  data-today={day === board.today ? 'true' : undefined}
                />
              </Tooltip>
            )
          }))}
        </div>
      </div>

      <div className="dshTodo-legend" aria-hidden="true">
        <span>{t('todo.stats.legendLess')}</span>
        {TIERS.map(tier => <span key={tier} className="dshTodo-yCell" data-tier={tier} />)}
        <span>{t('todo.stats.legendMore')}</span>
      </div>
    </div>
  )
}
