/**
 * The statistics block: three faces over the same day index.
 *
 * The tabs are the primitive's segmented control rather than a row of styled buttons:
 * the kernel's own control carries the roles, the arrow-key walk and the panel wiring,
 * and a hand-rolled twin of it is the exact mistake this suite has made before.
 *
 * The index (rows grouped by the day they belong to) is built ONCE by the page and
 * handed in, because the month, the week and the day dialog all ask the same question of
 * the same rows, and three separate groupings would drift.
 *
 * @module @dsh-app/plugin-todo/client/stats
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayIndex } from './daydata.ts'
import { MonthFace } from './month.tsx'
import type { Translate } from './translate.ts'
import { WeekFace } from './week.tsx'
import { YearFace } from './year.tsx'
import type { TodoSnapshot } from '../wire.ts'

/** Which face is showing. */
type Range = 'week' | 'month' | 'year'

/**
 * Render the statistics block: a heading, the range tabs and the chosen face.
 * @param props.board - the board.
 * @param props.t - the dictionary seat.
 * @param props.index - the board's rows grouped by day.
 * @param props.selected - the day whose dialog is open.
 * @param props.onSelect - receives a pressed day.
 */
export function TodoStats({ board, t, index, selected, onSelect }: {
  board: TodoSnapshot
  t: Translate
  index: DayIndex
  selected: string | undefined
  onSelect: (day: string) => void
}): ReactNode {
  // The month opens first: it answers "what did I do lately" without a click.
  const [range, setRange] = useState<Range>('month')

  return (
    <section className="dshTodo-stats" aria-labelledby="dshTodo-stats-title">
      <div className="dshTodo-statsHead">
        <h3 id="dshTodo-stats-title" className="dshTodo-sectionTitle">{t('todo.stats.title')}</h3>
        <SegmentedControl
          id="dshTodo-range"
          value={range}
          options={[
            { value: 'week', label: t('todo.stats.week') },
            { value: 'month', label: t('todo.stats.month') },
            { value: 'year', label: t('todo.stats.year') },
          ]}
          onChange={setRange}
          label={t('todo.stats.tabs')}
        />
      </div>

      {range === 'week' ? <WeekFace board={board} index={index} t={t} /> : null}
      {range === 'month' ? <MonthFace board={board} index={index} t={t} selected={selected} onSelect={onSelect} /> : null}
      {range === 'year' ? <YearFace board={board} t={t} /> : null}
    </section>
  )
}
