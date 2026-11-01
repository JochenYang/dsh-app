/**
 * The month face: a card grid of days, the way a paper calendar is printed.
 *
 * Each cell is a card: the date set large and centred, the day's tasks pinned along the
 * bottom, and nothing else — the reading order a wall calendar uses. Today's card is
 * washed in the done colour and outlined in it, and the neighbours that complete the
 * grid are drawn in a muted date so the month still has edges.
 *
 * HOVER shows the day's summary through the primitive's Tooltip, pinned above the card:
 * a bubble over the row keeps the calendar underneath visible, and the tooltip flips only
 * when the top of the window is in the way.
 *
 * PRESS opens that day's dialog (`DayPanel`), where a task can be written for it. The two
 * affordances are deliberately different: hover glances, press works.
 *
 * @module @dsh-app/plugin-todo/client/month
 */

import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayGroup, DayIndex } from './daydata.ts'
import { dayView, statOf, totalsOf } from './daydata.ts'
import { TaskChips } from './dayrows.tsx'
import { monthGrid, partsOf, tipDivider } from './format.ts'
import type { Translate } from './translate.ts'
import { WEEKDAY_KEYS, dateLabel, weekdayCardName, weekdayName } from './translate.ts'
import type { TodoDayStat, TodoSnapshot } from '../wire.ts'

/** Chips a month cell shows before it says how many it left out. */
const CELL_ROWS = 2

/** Task names the hover label lists before it stops. */
const TIP_TASKS = 3

/**
 * Render the month calendar.
 * @param props.board - the board.
 * @param props.index - the board's rows grouped by day.
 * @param props.t - the dictionary seat.
 * @param props.selected - the day whose dialog is open.
 * @param props.onSelect - receives a pressed day.
 */
export function MonthFace({ board, index, t, selected, onSelect }: {
  board: TodoSnapshot
  index: DayIndex
  t: Translate
  selected: string | undefined
  onSelect: (day: string) => void
}): ReactNode {
  const rows = monthGrid(Date.now())
  const cells = rows.flat()
  const inside = cells.filter(cell => !cell.outside)
  const total = totalsOf(board.daily, inside.map(cell => cell.day))
  const anchor = partsOf(inside[0]?.day ?? board.today)

  return (
    <div className="dshTodo-month">
      <div className="dshTodo-faceHead">
        <p className="dshTodo-faceTitle">{t('todo.stats.monthLabel', { year: anchor.year, month: anchor.month })}</p>
        <p className="dshTodo-summary">{t('todo.stats.summary', { done: total.done, created: total.created })}</p>
      </div>
      <div className="dshTodo-cal">
        <div className="dshTodo-calHead" aria-hidden="true">
          {WEEKDAY_KEYS.map(key => <span key={key}>{t(key)}</span>)}
        </div>
        <div className="dshTodo-calGrid">
          {cells.map(cell => (
            <DayCell
              key={cell.day}
              day={cell.day}
              outside={cell.outside}
              stat={statOf(board.daily, cell.day)}
              group={index.get(cell.day)}
              today={board.today}
              selected={selected === cell.day}
              t={t}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One day of the grid.
 * @param props.day - the local day key.
 * @param props.outside - the day belongs to the month before or after this one.
 * @param props.stat - the day's counts.
 * @param props.group - the day's rows, when the detail still holds them.
 * @param props.today - the host's local day key.
 * @param props.selected - this day's dialog is open.
 * @param props.t - the dictionary seat.
 * @param props.onSelect - receives the pressed day.
 */
function DayCell({ day, outside, stat, group, today, selected, t, onSelect }: {
  day: string
  outside: boolean
  stat: TodoDayStat
  group: DayGroup | undefined
  today: string
  selected: boolean
  t: Translate
  onSelect: (day: string) => void
}): ReactNode {
  const view = dayView(stat, group, CELL_ROWS)
  const tasks = group === undefined ? [] : [...group.open, ...group.done]
  const label = () => {
    const dateStr = t('todo.view.date', { date: dateLabel(t, day), weekday: weekdayName(t, partsOf(day).weekday) })
    const summaryStr = t('todo.day.summary', { done: stat.done, created: stat.created })
    const header = `${dateStr} (${summaryStr})`
    if (tasks.length === 0) {
      return header
    }
    const taskLines: string[] = []
    for (const item of tasks.slice(0, TIP_TASKS)) {
      taskLines.push(`${item.done ? '✓' : '○'} ${item.text}`)
    }
    if (tasks.length > TIP_TASKS) {
      taskLines.push(`… ${t('todo.day.more', { count: tasks.length - TIP_TASKS })}`)
    }
    const divider = tipDivider([header, ...taskLines])
    return [header, divider, ...taskLines].join('\n')
  }

  const hasContent = stat.created > 0 || stat.done > 0 || tasks.length > 0
  const cell = (
    <button
      type="button"
      className="dshTodo-day"
      data-outside={outside ? 'true' : undefined}
      data-today={day === today ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      onClick={() => { onSelect(day) }}
    >
      {/* A number alone in a 92px card reads as a lonely digit; the weekday says what
          the number belongs to, the way a printed calendar pairs them. */}
      <span className="dshTodo-dayWeek">{weekdayCardName(t, partsOf(day).weekday)}</span>
      <span className="dshTodo-dayNum">{partsOf(day).day}</span>
      {view.kind === 'rows' ? (
        <span className="dshTodo-dayTasks">
          <TaskChips items={view.rows} t={t} compact />
          {view.hidden > 0
            ? <span className="dshTodo-dayMore">{t('todo.day.more', { count: view.hidden })}</span>
            : null}
          {/* A count, not a fraction: done and created are different sets (a task
              written last week can be finished today), so "9/8" reads as a broken
              ratio. The full pair is in the hover label. */}
          <span className="dshTodo-dayCount">{t('todo.day.doneCount', { done: stat.done })}</span>
        </span>
      ) : null}
      {view.kind === 'counts' && stat.done > 0
        ? <span className="dshTodo-dayCounts">{t('todo.day.countsChip', { done: stat.done })}</span>
        : null}
    </button>
  )

  if (!hasContent) {
    return cell
  }

  return (
    <Tooltip side="top" delayMs={150} maxWidth={320} portal label={label}>
      {cell}
    </Tooltip>
  )
}
