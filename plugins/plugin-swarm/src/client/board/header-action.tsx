/**
 * The session header's swarm pill: a compact live status that opens the board.
 *
 * It renders nothing in a child session (the board belongs to the session that
 * STARTED the batch), and nothing when no batch is running or recently
 * finished — a status control with no status is noise. The pill polls the same
 * route as the board, at a slower cadence.
 *
 * @module @dsh-app/plugin-swarm/client/board/header-action
 */

import type { ReactNode } from 'react'
import { StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import { useBoardSnapshot } from './use-board.ts'

/** Recent finished batches stay visible this long after settlement. */
const RECENT_MS = 5 * 60_000

/** The header action's own injected face. */
export interface SwarmHeaderInjected {
  /** Open (or reveal) this session's board tab. */
  openBoard: () => void
}

/** Props delivered by `conversation.session.header.actions`. */
export type SwarmHeaderActionProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<SwarmHeaderInjected>

/** Render the live parallel-batch pill. */
export function SwarmHeaderAction({ sessionId, t, openBoard, useSession }: SwarmHeaderActionProps): ReactNode {
  // A child session has no batches of its own: the batch belongs to the
  // conversation that invoked the tool.
  const child = useSession(snapshot => snapshot.subagent !== null)
  const { snapshot, error } = useBoardSnapshot(String(sessionId), 3000)
  if (child || snapshot === null || error) return null
  const batches = snapshot.batches
  const running = batches.filter(batch => batch.status === 'running')
  const recent = batches.some(batch => batch.status === 'running'
    || (batch.finishedAt !== undefined && Date.now() - batch.finishedAt <= RECENT_MS))
  if (!recent) return null
  const total = batches.reduce((sum, batch) => sum + batch.total, 0)
  const working = batches.reduce((sum, batch) => sum + batch.workers.filter(worker => worker.status === 'working').length, 0)
  const anyFailed = batches.some(batch => batch.status === 'failed')
  const label = t('swarm.board.headerAria', { working, total, running: running.length })
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className="dshs_headerAction"
        aria-label={label}
        onClick={openBoard}
      >
        <StateDot state={running.length > 0 ? 'ongoing' : anyFailed ? 'warning' : 'done'} size={8} />
        <span>{running.length > 0
          ? t('swarm.board.headerRunning', { working, total })
          : t('swarm.board.headerDone', { total })}</span>
      </button>
    </Tooltip>
  )
}
