/**
 * The swarm board: the right-Sidebar tab that renders one session's live batch
 * state. Three views, adapted from Antigravity's Swarm pane but kept honest
 * about what a one-shot batch actually has:
 *
 *   - Overview — batches, counts, concurrency, elapsed time and token spend.
 *     Antigravity's Graph is omitted: our batches have no @-mention edges, so
 *     a relationship graph would be decorative. The per-batch progress bar
 *     carries the convergence read instead.
 *   - Board — the append-only event feed (batch start, worker start/settle,
 *     stop request, batch settle), newest last and auto-following.
 *   - Members — the worker roster ordered by urgency, with each worker's
 *     preview and failure detail behind a disclosure row.
 *
 * The tab only reads the host route; the stop control is the one write, and it
 * goes through the same batch controller the job registry uses.
 *
 * @module @dsh-app/plugin-swarm/client/board/tab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, DisclosureRow, IconRefreshOutlineRegular, Pill, SegmentedTabs, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmBoardBatch, SwarmBoardEvent } from '../../board-types.ts'
import type { NS } from '../locales.ts'
import type { SwarmKey } from '../locales.ts'
import {
  batchDot, batchStatusKey, clockText, durationText, elapsedSeconds, memberKey, memberRows, mergedEvents,
  settledShare, tokenText, workerDot, workerStatusKey, workingCount,
} from './format.ts'
import type { MemberRow } from './format.ts'
import { useBoardSnapshot } from './use-board.ts'

/** The board's route base; the cancel write appends `/cancel`. */
const ROUTE = '/api/plugins/dsh-app/plugin-swarm/board'

/** Props delivered by the keyed `sidebar.right.pane.tab` seat. */
export type SwarmBoardTabProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>

type BoardView = 'overview' | 'board' | 'members'

/** One stat card. */
function Stat({ label, value, tone }: { readonly label: string, readonly value: string, readonly tone?: 'bad' }): ReactNode {
  return (
    <div className="dshs_stat">
      <span className="dshs_statValue" data-tone={tone ?? ''}>{value}</span>
      <span className="dshs_statLabel">{label}</span>
    </div>
  )
}

/** A two-step stop control: the second press is the one that cancels. */
function StopControl({
  batch, armed, busy, t, onArm, onCancel,
}: {
  readonly batch: SwarmBoardBatch
  readonly armed: boolean
  readonly busy: boolean
  readonly t: (key: SwarmKey, params?: Record<string, unknown>) => string
  readonly onArm: () => void
  readonly onCancel: () => void
}): ReactNode {
  const stopping = batch.cancelRequested === true
  return (
    <button
      type="button"
      className={armed ? 'dshs_stop dshs_stopArmed' : 'dshs_stop'}
      disabled={busy || stopping}
      onClick={armed ? onCancel : onArm}
    >
      {stopping ? t('swarm.board.stopping') : armed ? t('swarm.board.stopConfirm') : t('swarm.board.stop')}
    </button>
  )
}

/** One batch card in the overview. */
function BatchCard({
  batch, now, armed, busy, t, onArm, onCancel,
}: {
  readonly batch: SwarmBoardBatch
  readonly now: number
  readonly armed: boolean
  readonly busy: boolean
  readonly t: (key: SwarmKey, params?: Record<string, unknown>) => string
  readonly onArm: () => void
  readonly onCancel: () => void
}): ReactNode {
  const tokens = tokenText(batch.tokens)
  const elapsed = durationText(elapsedSeconds(batch, now))
  const working = workingCount(batch)
  const share = settledShare(batch)
  return (
    <article className="dshs_batchCard">
      <div className="dshs_batchHead">
        <StateDot state={batchDot(batch)} size={9} />
        <span className="dshs_batchLabel" title={batch.label}>{batch.label}</span>
        <span className="dshs_batchStatus">{t(batchStatusKey(batch.status))}</span>
      </div>
      <div className="dshs_batchMeta">
        <span>{t(batch.mode === 'background' ? 'swarm.board.mode.background' : 'swarm.board.mode.inline')}</span>
        <span>{t('swarm.board.concurrency', { count: batch.concurrency })}</span>
        <span>{elapsed}</span>
        {tokens === undefined ? null : <span>{t('swarm.board.tokens', { count: tokens })}</span>}
        {batch.budgetExhausted === true ? <span className="dshs_bad">{t('swarm.board.budget')}</span> : null}
      </div>
      <div className="dshs_batchBar" aria-hidden="true">
        <span className="dshs_batchBarFill" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <div className="dshs_batchFoot">
        <span>{t('swarm.board.workers', { working, total: batch.total })}</span>
        <span>{t('swarm.board.completedCount', { count: batch.completed })}</span>
        {batch.failed > 0 ? <span className="dshs_bad">{t('swarm.board.failedCount', { count: batch.failed })}</span> : null}
        {batch.aborted > 0 ? <span className="dshs_warn">{t('swarm.board.abortedCount', { count: batch.aborted })}</span> : null}
        {batch.status === 'running' ? (
          <StopControl
            batch={batch}
            armed={armed}
            busy={busy}
            t={t}
            onArm={onArm}
            onCancel={onCancel}
          />
        ) : null}
      </div>
    </article>
  )
}

/** One member row with its disclosure. */
function Member({
  row, open, t, onToggle,
}: {
  readonly row: MemberRow
  readonly open: boolean
  readonly t: (key: SwarmKey, params?: Record<string, unknown>) => string
  readonly onToggle: () => void
}): ReactNode {
  const { worker, batch } = row
  const detail = worker.error ?? worker.outputPreview
  const meta = [
    t(workerStatusKey(worker.status)),
    worker.durationMs === undefined ? undefined : durationText(Math.round(worker.durationMs / 1000)),
    tokenText(worker.tokens) === undefined ? undefined : t('swarm.board.tokens', { count: tokenText(worker.tokens) as string }),
    worker.retries === undefined || worker.retries === 0 ? undefined : t('swarm.board.retries', { count: worker.retries }),
    batch.label,
  ].filter((part): part is string => part !== undefined)
  return (
    <DisclosureRow
      icon={<StateDot state={workerDot(worker.status)} size={10} />}
      title={`[${worker.index}] ${worker.item}`}
      open={open}
      expandable={detail !== undefined}
      onToggle={onToggle}
      expandOnRowClick
      collapsedContent={<span className="dshs_workerMeta">{meta.join(' · ')}</span>}
      className="dshs_memberRow"
    >
      {worker.name === undefined && worker.childId === undefined ? null : (
        <div className="dshs_workerIds">
          {worker.name === undefined ? null : <span>{worker.name}</span>}
          {worker.childId === undefined ? null : <span className="dshs_mono">{worker.childId}</span>}
        </div>
      )}
      {worker.error === undefined ? null : (
        <div className="dshs_workerDetailBlock">
          <span className="dshs_workerDetailLabel">{t('swarm.board.worker.error')}</span>
          <pre className="dshs_workerDetail dshs_bad">{worker.error}</pre>
        </div>
      )}
      {worker.outputPreview === undefined ? null : (
        <div className="dshs_workerDetailBlock">
          <span className="dshs_workerDetailLabel">{t('swarm.board.worker.output')}</span>
          <pre className="dshs_workerDetail">{worker.outputPreview}</pre>
        </div>
      )}
    </DisclosureRow>
  )
}

/** Event dot by event type. */
function eventDot(event: SwarmBoardEvent): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  if (event.type === 'batch-started' || event.type === 'worker-started') return 'ongoing'
  if (event.type === 'batch-cancel-requested') return 'warning'
  if (event.type === 'batch-settled') {
    if (event.status === 'completed') return 'done'
    if (event.status === 'cancelled') return 'warning'
    return 'error'
  }
  if (event.status === 'completed') return 'done'
  if (event.status === 'failed') return 'error'
  return 'warning'
}

/** Localized sentence for one feed row. */
function eventText(
  event: SwarmBoardEvent & { readonly batchLabel: string },
  t: (key: SwarmKey, params?: Record<string, unknown>) => string,
): string {
  if (event.type === 'batch-started') return t('swarm.board.event.batchStarted', { label: event.batchLabel })
  if (event.type === 'worker-started') return t('swarm.board.event.workerStarted', { index: event.index ?? 0, item: event.item ?? '' })
  if (event.type === 'worker-settled') {
    const key = event.status === 'completed'
      ? 'swarm.board.worker.completed'
      : event.status === 'failed'
        ? 'swarm.board.worker.failed'
        : 'swarm.board.worker.aborted'
    return t('swarm.board.event.workerSettled', { index: event.index ?? 0, status: t(key) })
  }
  if (event.type === 'batch-cancel-requested') return t('swarm.board.event.cancelRequested')
  if (event.status === 'completed') return t('swarm.board.event.batchCompleted')
  if (event.status === 'cancelled') return t('swarm.board.event.batchCancelled')
  return t('swarm.board.event.batchFailed')
}

/** The tab body. */
export function SwarmBoardTab({ sessionId, t, useTabInfo }: SwarmBoardTabProps): ReactNode {
  const { tab } = useTabInfo()
  const { snapshot, error, refresh } = useBoardSnapshot(String(sessionId))
  const [view, setView] = useState<BoardView>('overview')
  const [follow, setFollow] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const armTimer = useRef(0)

  useEffect(() => tab.actions.bindCommands({ refresh }), [tab.actions, refresh])
  useEffect(() => () => window.clearTimeout(armTimer.current), [])

  const batches = snapshot?.batches ?? []
  const running = batches.filter(batch => batch.status === 'running')
  const working = batches.reduce((sum, batch) => sum + workingCount(batch), 0)
  const totalWorkers = batches.reduce((sum, batch) => sum + batch.total, 0)
  const failed = batches.reduce((sum, batch) => sum + batch.failed, 0)
  const events = useMemo(() => mergedEvents(batches), [batches])
  const rows = useMemo(() => memberRows(batches), [batches])
  const now = Date.now()

  useEffect(() => {
    if (!follow) return
    const feed = feedRef.current
    if (feed !== null) feed.scrollTop = feed.scrollHeight
  }, [follow, events.length, view])

  const armStop = useCallback((batchId: string): void => {
    window.clearTimeout(armTimer.current)
    setArmed(batchId)
    armTimer.current = window.setTimeout(() => {
      setArmed(current => current === batchId ? undefined : current)
    }, 4000)
  }, [])

  const cancel = useCallback(async (batchId: string): Promise<void> => {
    window.clearTimeout(armTimer.current)
    setBusy(batchId)
    setActionError(false)
    try {
      const response = await fetch(`${ROUTE}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ sessionId: String(sessionId), batchId }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      refresh()
    } catch {
      setActionError(true)
    } finally {
      setBusy(undefined)
      setArmed(undefined)
    }
  }, [refresh, sessionId])

  const toggleMember = useCallback((key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const tabs = [
    { value: 'overview', label: t('swarm.board.tabs.overview'), id: 'dshs-board-tab-overview', panelId: 'dshs-board-panel-overview' },
    { value: 'board', label: t('swarm.board.tabs.board'), id: 'dshs-board-tab-board', panelId: 'dshs-board-panel-board' },
    { value: 'members', label: t('swarm.board.tabs.members'), id: 'dshs-board-tab-members', panelId: 'dshs-board-panel-members' },
  ] as const

  return (
    <div className="dshs_boardRoot">
      <header className="dshs_boardHeader">
        <div className="dshs_boardTitleRow">
          <span className="dshs_boardTitle">{t('swarm.board.title')}</span>
          <span className="dshs_boardLive">
            <StateDot state={running.length > 0 ? 'ongoing' : 'idle'} size={8} />
            {running.length > 0 ? t('swarm.board.activeBatches', { count: running.length }) : t('swarm.board.idle')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutlineRegular />}
            aria-label={t('swarm.board.refresh')}
            title={t('swarm.board.refresh')}
            onClick={refresh}
          />
        </div>
        <SegmentedTabs
          items={tabs}
          value={view}
          onChange={setView}
          label={t('swarm.board.tabList')}
          size="sm"
        />
      </header>

      {error && snapshot !== null ? <div className="dshs_boardStale">{t('swarm.board.stale')}</div> : null}
      {actionError ? <div className="dshs_boardError" role="alert">{t('swarm.board.stopFailed')}</div> : null}

      {snapshot === null ? (
        <p className="dshs_boardEmpty">{t('swarm.board.loading')}</p>
      ) : batches.length === 0 ? (
        <div className="dshs_boardEmpty">
          <p>{t('swarm.board.empty')}</p>
          <p className="dshs_boardHint">{t('swarm.board.emptyHint')}</p>
        </div>
      ) : view === 'overview' ? (
        <div className="dshs_boardBody" id="dshs-board-panel-overview" role="tabpanel" aria-labelledby="dshs-board-tab-overview">
          <div className="dshs_boardStats">
            <Stat label={t('swarm.board.statBatches')} value={String(batches.length)} />
            <Stat label={t('swarm.board.statWorking')} value={`${working}/${totalWorkers}`} />
            <Stat label={t('swarm.board.statFailed')} value={String(failed)} tone={failed > 0 ? 'bad' : undefined} />
          </div>
          <div className="dshs_batchList">
            {batches.map(batch => (
              <BatchCard
                key={batch.id}
                batch={batch}
                now={now}
                armed={armed === batch.id}
                busy={busy === batch.id}
                t={t}
                onArm={() => { armStop(batch.id) }}
                onCancel={() => { void cancel(batch.id) }}
              />
            ))}
          </div>
        </div>
      ) : view === 'board' ? (
        <div className="dshs_boardBody dshs_boardBodyFeed" id="dshs-board-panel-board" role="tabpanel" aria-labelledby="dshs-board-tab-board">
          <div className="dshs_feedTools">
            <Pill active={follow} onClick={() => { setFollow(value => !value) }}>{t('swarm.board.follow')}</Pill>
          </div>
          <div className="dshs_feed" ref={feedRef} role="log" aria-label={t('swarm.board.feedLabel')}>
            {events.map(event => (
              <div key={event.seq} className="dshs_event">
                <span className="dshs_eventTime">{clockText(event.at)}</span>
                <StateDot state={eventDot(event)} size={8} />
                <div className="dshs_eventBody">
                  <span className="dshs_eventBatch">{event.batchLabel}</span>
                  <span>{eventText(event, t)}</span>
                  {event.detail === undefined ? null : <span className="dshs_eventDetail" title={event.detail}>{event.detail}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="dshs_boardBody" id="dshs-board-panel-members" role="tabpanel" aria-labelledby="dshs-board-tab-members">
          <div className="dshs_memberList">
            {rows.map(row => (
              <Member
                key={memberKey(row)}
                row={row}
                open={expanded.has(memberKey(row))}
                t={t}
                onToggle={() => { toggleMember(memberKey(row)) }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
