/**
 * Pure formatting and state-mapping helpers for the swarm board. Kept out of
 * the components so the same vocabulary is used by the overview, the member
 * roster and the event feed.
 *
 * @module @dsh-app/plugin-swarm/client/board/format
 */

import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SwarmBoardBatch, SwarmBoardBatchStatus, SwarmBoardEvent, SwarmBoardWorker, SwarmBoardWorkerStatus,
} from '../../board-types.ts'
import type { SwarmKey } from '../locales.ts'

/** Status dot for one worker. */
export function workerDot(status: SwarmBoardWorkerStatus): StateDotState {
  if (status === 'working') return 'ongoing'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'aborted') return 'warning'
  return 'idle'
}

/** Status dot for one batch. */
export function batchDot(batch: SwarmBoardBatch): StateDotState {
  if (batch.status === 'running') return batch.cancelRequested === true ? 'warning' : 'ongoing'
  if (batch.status === 'completed') return 'done'
  if (batch.status === 'failed') return 'error'
  return 'warning'
}

/** Dictionary key for a worker state. */
export function workerStatusKey(status: SwarmBoardWorkerStatus): SwarmKey {
  if (status === 'working') return 'swarm.board.worker.working'
  if (status === 'completed') return 'swarm.board.worker.completed'
  if (status === 'failed') return 'swarm.board.worker.failed'
  if (status === 'aborted') return 'swarm.board.worker.aborted'
  return 'swarm.board.worker.waiting'
}

/** Dictionary key for a batch state. */
export function batchStatusKey(status: SwarmBoardBatchStatus): SwarmKey {
  if (status === 'running') return 'swarm.board.status.running'
  if (status === 'completed') return 'swarm.board.status.completed'
  if (status === 'failed') return 'swarm.board.status.failed'
  return 'swarm.board.status.cancelled'
}

/** Whole seconds between a batch's start and its finish (or now). */
export function elapsedSeconds(batch: SwarmBoardBatch, now: number): number {
  const end = batch.finishedAt ?? now
  return Math.max(0, Math.round((end - batch.startedAt) / 1000))
}

/** A compact duration: `42s`, `3m 07s`. */
export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${String(rest).padStart(2, '0')}s`
}

/** A compact token count. */
export function tokenText(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens <= 0) return undefined
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
  return `${(tokens / 1_000_000).toFixed(1)}m`
}

/** `HH:MM:SS` in the user's locale, with a stable 24-hour shape. */
export function clockText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false })
}

/** Settled share of a batch's workers, 0..1. */
export function settledShare(batch: SwarmBoardBatch): number {
  if (batch.total === 0) return 0
  return Math.min(1, (batch.completed + batch.failed + batch.aborted) / batch.total)
}

/** Workers still working in a batch. */
export function workingCount(batch: SwarmBoardBatch): number {
  return batch.workers.filter(worker => worker.status === 'working').length
}

/** One event plus the batch it belongs to, for status-aware rendering. */
export type MergedBoardEvent = SwarmBoardEvent & {
  readonly batchId: string
  readonly batchLabel: string
  readonly batch: SwarmBoardBatch
}

/** Events across all batches, oldest first. */
export function mergedEvents(batches: readonly SwarmBoardBatch[]): readonly MergedBoardEvent[] {
  return batches
    .flatMap(batch => batch.events.map(event => ({ ...event, batchId: batch.id, batchLabel: batch.label, batch })))
    .sort((left, right) => left.seq - right.seq)
}

/** One member row: its batch and the worker. */
export interface MemberRow {
  readonly batch: SwarmBoardBatch
  readonly worker: SwarmBoardWorker
}

/** Workers ordered by urgency, then by batch recency and item index. */
export function memberRows(batches: readonly SwarmBoardBatch[]): readonly MemberRow[] {
  const order: Readonly<Record<SwarmBoardWorkerStatus, number>> = {
    working: 0,
    waiting: 1,
    failed: 2,
    aborted: 3,
    completed: 4,
  }
  return batches
    .flatMap(batch => batch.workers.map(worker => ({ batch, worker })))
    .sort((left, right) => order[left.worker.status] - order[right.worker.status]
      || right.batch.startedAt - left.batch.startedAt
      || left.worker.index - right.worker.index)
}

/** A worker row's stable key. */
export function memberKey(row: MemberRow): string {
  return `${row.batch.id}:${row.worker.index}`
}
