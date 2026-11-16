/**
 * Wire shapes shared by the swarm host's board route and its client tab.
 *
 * This module is deliberately type-only: the host records the snapshot, the
 * browser renders it, and neither side may import the other's runtime module.
 * Every field is JSON-shaped and bounded — a board is a status view, not a
 * transcript, so item output and errors travel as short previews.
 *
 * @module @dsh-app/plugin-swarm/board-types
 */

/** One worker's state in the board's vocabulary. */
export type SwarmBoardWorkerStatus = 'waiting' | 'working' | 'completed' | 'failed' | 'aborted'

/** One batch's overall state. */
export type SwarmBoardBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Where the batch runs: the tool call itself, or a detached host job. */
export type SwarmBoardBatchMode = 'inline' | 'background'

/** One observable step in a batch's append-only event feed. */
export type SwarmBoardEventType =
  | 'batch-started'
  | 'worker-started'
  | 'worker-settled'
  | 'batch-cancel-requested'
  | 'batch-settled'

/** One event row. */
export interface SwarmBoardEvent {
  /** Monotonic sequence across every batch this plugin instance has seen. */
  readonly seq: number
  readonly at: number
  readonly type: SwarmBoardEventType
  /** Worker index, for worker events. */
  readonly index?: number
  /** Worker display item, for worker events. */
  readonly item?: string
  /** Terminal status, for `worker-settled` and `batch-settled`. */
  readonly status?: string
  /** Short failure detail (never the full output). */
  readonly detail?: string
}

/** One worker as the board shows it. */
export interface SwarmBoardWorker {
  readonly index: number
  readonly item: string
  readonly status: SwarmBoardWorkerStatus
  readonly startedAt?: number
  readonly settledAt?: number
  readonly durationMs?: number
  readonly tokens?: number
  readonly retries?: number
  readonly failureKind?: string
  readonly failureCode?: string
  readonly name?: string
  readonly childId?: string
  /** Bounded head of the worker's final output. */
  readonly outputPreview?: string
  /** Bounded failure text. */
  readonly error?: string
}

/** One batch as the board shows it. */
export interface SwarmBoardBatch {
  readonly id: string
  readonly label: string
  readonly mode: SwarmBoardBatchMode
  readonly status: SwarmBoardBatchStatus
  /** Set while a stop request is in flight. */
  readonly cancelRequested?: boolean
  readonly startedAt: number
  readonly finishedAt?: number
  readonly concurrency: number
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly aborted: number
  readonly budgetExhausted?: boolean
  /** Summed token usage recovered from settled workers. */
  readonly tokens?: number
  workers: readonly SwarmBoardWorker[]
  events: readonly SwarmBoardEvent[]
}

/** One session's board. Batches are newest first; events inside a batch are oldest first. */
export interface SwarmBoardSnapshot {
  readonly sessionId: string
  /** Host clock at serialization, so the client can align elapsed times. */
  readonly now: number
  readonly batches: readonly SwarmBoardBatch[]
}
