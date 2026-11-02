/**
 * The workbench card.
 *
 * ONE ROOT ELEMENT, and it is a `<button>`: the container's frame is a CSS rule on
 * the outlet anchor's child, so a fragment or several roots is drawn as several
 * boxes, and the container gives a card no per-entry wrapper, so its entry point has
 * to be a real button for the grid to be keyboard reachable.
 *
 * The frame belongs to the container (`plugin-workbench/src/client/styles.ts`). What
 * this card draws is what a glance asks: how much of today is left, whether something
 * from earlier is still open, and how this week has gone.
 *
 * It reads the shared board (`board.ts`), so the page it opens shows the same numbers
 * and nothing is loaded twice.
 *
 * @module @dsh-app/plugin-todo/client/card
 */

import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { refreshBoard, useBoard } from './board.ts'
import { statOf } from './daydata.ts'
import { keyOf, percent, weekKeys } from './format.ts'
import type { NS } from './locales.ts'
import { dateLabel, weekdayName } from './translate.ts'
import type { Translate } from './translate.ts'
import { countInView } from '../views.ts'
import type { TodoSnapshot } from '../wire.ts'

/**
 * The owner props the container hands every card.
 *
 * COPIED VERBATIM from `plugin-workbench/src/client/page.tsx` (the block marked
 * `BEGIN workbench-card-slot` there): the suite ships no shared package, so a card
 * has nothing to import and a misspelt field would leave both sides compiling while
 * the card disappears into the outlet's error boundary at run time.
 */
export interface WorkbenchCardOwnerProps {
  /** Show the view registered under `viewId`; no-op when nothing registered it. */
  readonly openView: (viewId: string) => void
  /** Register `path` as a workspace and open it, returning to the Conversation. */
  readonly enterWorkspace: (path: string) => Promise<`ok` | 'pending' | `error:${string}`>
  /** This container's copy for a problem token. */
  readonly entryMessage: (status: `error:${string}` | 'pending') => string
}

/** The view key this card opens. Must match the registration in `client.ts`. */
export const VIEW_ID = 'todo'

/** Props: the owner's three plus this plugin's `t` seat. */
export type TodoCardProps = WorkbenchCardOwnerProps & PropsLocale<typeof NS>

/** Ring geometry: a 44px box around a 16-unit radius. */
const RING_RADIUS = 16
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** What the card shows, worked out once per board. */
interface CardFigures {
  readonly open: number
  readonly total: number
  /** Open and owed today — the card's headline number. */
  readonly today: number
  /** Open and owed before today, by the same rule the page filters with. */
  readonly overdue: number
  readonly percent: number
}

/**
 * Today's figures from the board.
 *
 * `today` and `overdue` come from the shared predicate (`views.ts` `countInView`),
 * NOT from a comparison written here: the card used to count `day < today`, which
 * called a task written today and owed last week "not late" while the host tool
 * called it late. One definition, one answer.
 * @param board - the shared snapshot.
 */
function figuresOf(board: TodoSnapshot): CardFigures {
  const open = board.items.filter(item => !item.done).length
  const finished = board.items.filter(item => item.done && keyOf(item.doneAt ?? item.createdAt) === board.today).length
  const total = open + finished
  return {
    open,
    total,
    today: countInView(board.items, 'today', board.today),
    overdue: countInView(board.items, 'overdue', board.today),
    percent: percent(finished, total),
  }
}

/**
 * Render the card.
 * @param props - see {@link TodoCardProps}.
 */
export function TodoCard({ openView, t }: TodoCardProps): ReactNode {
  const state = useBoard()

  // The page warms the same cache; this covers the workbench being the first
  // surface opened in a session (`client.ts` also prefetches at apply).
  useEffect(() => { void refreshBoard() }, [])

  const board = state.snapshot
  const figures = useMemo(() => (board === undefined ? undefined : figuresOf(board)), [board])

  return (
    <button type="button" className="dshTodo-card" onClick={() => { openView(VIEW_ID) }}>
      <span className="dshTodo-cardDeco" aria-hidden="true">
        <span className="dshTodo-cardHalo" />
        <svg className="dshTodo-cardSun" viewBox="0 0 36 36" fill="none">
          <circle cx="18" cy="18" r="6" fill="#FFAE33" fillOpacity="0.25" stroke="#FFAE33" strokeWidth="2" />
          <path d="M18 3.5 L18 6.5" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M18 29.5 L18 32.5" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M3.5 18 L6.5 18" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M29.5 18 L32.5 18" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M7.7 7.7 L9.9 9.9" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M26.1 26.1 L28.3 28.3" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M7.7 28.3 L9.9 26.1" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M26.1 9.9 L28.3 7.7" stroke="#FFD05A" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <svg className="dshTodo-cardHill" viewBox="0 0 360 48" preserveAspectRatio="none">
          <path className="dshTodo-cardHillBack" d="M0 26 Q 90 10 200 24 T 360 16 L 360 48 L 0 48 Z" />
          <path className="dshTodo-cardHillFront" d="M0 32 Q 130 15 250 28 T 360 22 L 360 48 L 0 48 Z" />
        </svg>
      </span>

      <span className="dshTodo-cardHead">
        <span className="dshTodo-cardMark" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" />
            <path d="M4.2 7.2 6.1 9.1 9.9 5" />
          </svg>
        </span>
        <span className="dshTodo-cardTitle">{t('todo.card.title')}</span>
        {board === undefined ? null : <span className="dshTodo-cardDate">{dateLabel(t, board.today)}</span>}
      </span>

      <span className="dshTodo-cardMain">
        <span className="dshTodo-cardFigures">
          <CardFigure figures={figures} error={state.error} t={t} />
        </span>
        {figures === undefined ? null : <Ring percent={figures.percent} total={figures.total} />}
      </span>

      {figures === undefined ? null : (
        <span className="dshTodo-cardCounts">
          <span className="dshTodo-cardCount" data-tone={figures.overdue > 0 ? 'warn' : undefined}>
            <span className="dshTodo-cardCountNum">{figures.overdue}</span>
            <span className="dshTodo-cardCountLabel">{t('todo.card.overdueLabel')}</span>
          </span>
          <span className="dshTodo-cardCount">
            <span className="dshTodo-cardCountNum">{figures.open}</span>
            <span className="dshTodo-cardCountLabel">{t('todo.card.openLabel')}</span>
          </span>
        </span>
      )}

      {board === undefined ? null : <WeekStrip board={board} t={t} />}
    </button>
  )
}

/**
 * The card's main figure and its line, in every state the board can be in.
 * @param props.figures - today's figures, absent until the first read answers.
 * @param props.error - the last read's failure, when there was one.
 * @param props.t - the dictionary seat.
 */
function CardFigure({ figures, error, t }: {
  figures: CardFigures | undefined
  error: string | undefined
  t: Translate
}): ReactNode {
  if (figures === undefined) {
    if (error !== undefined) return <span className="dshTodo-cardError">{t('todo.card.failed')}</span>
    return (
      <span className="dshTodo-skeleton">
        <span className="dshTodo-sr">{t('todo.card.loading')}</span>
        <span className="dshTodo-skeletonBar dshTodo-skeletonFigure" aria-hidden="true" />
        <span className="dshTodo-skeletonBar dshTodo-skeletonShort" aria-hidden="true" />
      </span>
    )
  }
  if (figures.total === 0) {
    return (
      <>
        <span className="dshTodo-cardHeadline">{t('todo.card.emptyTitle')}</span>
        <span className="dshTodo-cardLabel">{t('todo.card.emptyHint')}</span>
      </>
    )
  }
  if (figures.open === 0) {
    return (
      <>
        <span className="dshTodo-cardFigure">0</span>
        <span className="dshTodo-cardLabel">{t('todo.card.allDone')}</span>
      </>
    )
  }
  return (
    <>
      <span className="dshTodo-cardFigure">{figures.today}</span>
      <span className="dshTodo-cardLabel">{t('todo.card.today', { count: figures.today })}</span>
    </>
  )
}

/**
 * The progress ring. Its percentage is also in the figure's line, so the ring is a
 * visual summary and is hidden from assistive technology.
 * @param props.percent - finished share of today, 0 to 100.
 * @param props.total - today's task count; the ring stays empty when there are none.
 */
function Ring({ percent, total }: { percent: number, total: number }): ReactNode {
  return (
    <span className="dshTodo-ring" aria-hidden="true">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle className="dshTodo-ringTrack" cx="22" cy="22" r={RING_RADIUS} />
        {total === 0 ? null : (
          <circle
            className="dshTodo-ringFill"
            cx="22"
            cy="22"
            r={RING_RADIUS}
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
          />
        )}
      </svg>
      <span className="dshTodo-ringText">{total === 0 ? '—' : `${String(percent)}%`}</span>
    </span>
  )
}

/**
 * This week's completions, one bar per day, Monday first. Bars are scaled to the
 * busiest day of the week, with a floor so a single completion is still visible.
 * @param props.board - the shared snapshot.
 * @param props.t - the dictionary seat.
 */
function WeekStrip({ board, t }: { board: TodoSnapshot, t: Translate }): ReactNode {
  const days = weekKeys(Date.now())
  const finished = days.map(day => statOf(board.daily, day).done)
  const peak = Math.max(1, ...finished)
  return (
    <span className="dshTodo-cardWeek" aria-hidden="true">
      {days.map((day, position) => {
        const count = finished[position] ?? 0
        const height = count <= 0 ? 0 : Math.max(16, Math.round((count / peak) * 100))
        return (
          <span key={day} className="dshTodo-cardWeekCol" data-today={day === board.today ? 'true' : undefined}>
            <span className="dshTodo-cardWeekTrack">
              <span className="dshTodo-cardWeekBar" style={{ height: `${String(height)}%` }} />
            </span>
            <span className="dshTodo-cardWeekLetter">{weekdayName(t, position)}</span>
          </span>
        )
      })}
    </span>
  )
}
