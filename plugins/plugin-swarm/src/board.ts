/**
 * In-memory swarm board: the live status source behind the right-Sidebar tab
 * and the session header's batch pill.
 *
 * The batch tool already emits `SwarmProgressEvent` values for the job
 * progress line (`orchestrator.ts`). This registry subscribes to the same
 * stream, keeps a bounded record per calling session, and answers one JSON
 * snapshot. It owns no execution: every write comes from the tool or the job,
 * so a board read can never change what a batch does.
 *
 * Design choices worth keeping:
 *  - Batches are keyed by the CALLER's session (`Agent.id`), which is the
 *    session id the Sidebar tab receives, so a board opened in the parent
 *    conversation sees the batches that conversation started.
 *  - The event feed is append-only and bounded, because it is the board's
 *    "shared message board" half: a reader can reconstruct how the batch
 *    converged without reading every child's transcript.
 *  - Finished batches expire; running ones never do. A crashed session cannot
 *    leave the map growing without bound.
 *  - Output and errors are previews. The full text stays in the child session
 *    and the tool result, where the existing budget rules already apply.
 *
 * @module @dsh-app/plugin-swarm/board
 */

import type { SwarmBatchOutcome, SwarmItemOutcome, SwarmProgressEvent } from './orchestrator.ts'
import type {
  SwarmBoardBatch, SwarmBoardBatchMode, SwarmBoardBatchStatus, SwarmBoardEvent, SwarmBoardSnapshot,
  SwarmBoardWorker,
} from './board-types.ts'

/** How much of one worker's output or error the board keeps. */
const PREVIEW_CHARS = 240
/** Finished batches kept per session. Running batches are never dropped. */
const MAX_FINISHED_BATCHES = 8
/** Events kept per batch; the oldest fall out first. */
const MAX_EVENTS_PER_BATCH = 200
/** Sessions kept at once. Applied only when a session has no running batch. */
const MAX_SESSIONS = 24
/** A finished batch disappears after this long without new activity. */
const FINISHED_TTL_MS = 30 * 60_000

/** One batch start: everything the board needs before the first child runs. */
export interface SwarmBoardStart {
  readonly sessionId: string
  readonly label: string
  readonly mode: SwarmBoardBatchMode
  readonly concurrency: number
  readonly tasks: readonly { readonly index: number, readonly item: string }[]
}

/** Settlement facts the tool and the background lane can supply. */
export interface SwarmBoardSettlement {
  readonly cancelled?: boolean
  /** A broken call's diagnostic; item failures arrive inside `outcome`. */
  readonly error?: string
}

/** Internal batch record; cancelers never cross the route boundary. */
interface LiveBatch {
  batch: SwarmBoardBatch
  cancel?: (reason: string) => void
  cancelRequested: boolean
}

/** One session's batches and the time it was last touched. */
interface LiveSession {
  readonly batches: LiveBatch[]
  lastTouched: number
}

/** Keep a bounded, single-line preview of arbitrary worker text. */
function preview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`
}

/** Token total for one item, preferring the adapter's own total. */
function tokensOf(outcome: SwarmItemOutcome): number | undefined {
  if (outcome.usage === undefined) return undefined
  return outcome.usage.totalTokens ?? outcome.usage.inputTokens + outcome.usage.outputTokens
}

/**
 * The board registry. One instance per plugin activation; every method is
 * synchronous, and the only external effect is the cancel callback.
 */
export class SwarmBoard {
  private readonly sessions = new Map<string, LiveSession>()
  private seq = 0

  /**
   * Record a batch before its first child starts.
   * @param start - caller session, label, mode, concurrency and the expanded items.
   * @returns the batch id the progress observers address.
   */
  begin(start: SwarmBoardStart): string {
    this.pruneSessions(start.sessionId)
    const session = this.sessionFor(start.sessionId)
    this.pruneBatches(session)
    const at = Date.now()
    const id = `b${at.toString(36)}-${(this.seq + 1).toString(36)}`
    const workers: SwarmBoardWorker[] = start.tasks.map(task => ({
      index: task.index,
      item: task.item,
      status: 'waiting',
    }))
    const live: LiveBatch = {
      batch: {
        id,
        label: start.label,
        mode: start.mode,
        status: 'running',
        startedAt: at,
        concurrency: start.concurrency,
        total: workers.length,
        completed: 0,
        failed: 0,
        aborted: 0,
        workers,
        events: [],
      },
      cancelRequested: false,
    }
    this.pushEvent(live, { type: 'batch-started', status: 'running' })
    session.batches.unshift(live)
    session.lastTouched = at
    return id
  }

  /**
   * Attach the batch's cancellation path. A batch can start before its job
   * exists, so this is a second step; the board shows the stop control only
   * after it runs.
   * @param sessionId - caller session.
   * @param batchId - batch returned by {@link begin}.
   * @param cancel - aborts the batch's own controller.
   */
  attachCancel(sessionId: string, batchId: string, cancel: (reason: string) => void): void {
    const live = this.find(sessionId, batchId)
    if (live === undefined) return
    live.cancel = cancel
  }

  /**
   * Fold one orchestrator progress event into the batch.
   * @param sessionId - caller session.
   * @param batchId - batch returned by {@link begin}.
   * @param event - the same event the job progress line consumes.
   */
  observe(sessionId: string, batchId: string, event: SwarmProgressEvent): void {
    const live = this.find(sessionId, batchId)
    if (live === undefined) return
    const at = Date.now()
    const session = this.sessions.get(sessionId)
    if (session !== undefined) session.lastTouched = at
    if (event.type === 'item-started') {
      const worker = live.batch.workers.find(entry => entry.index === event.index)
      if (worker === undefined) return
      live.batch.workers = live.batch.workers.map(entry => entry.index === event.index
        ? { ...entry, status: 'working', startedAt: at }
        : entry)
      this.pushEvent(live, { type: 'worker-started', index: event.index, item: event.item })
      return
    }
    this.applyOutcome(live, event.outcome)
    const detail = event.outcome.error === undefined
      ? event.outcome.failureCode ?? event.outcome.failureKind
      : preview(event.outcome.error)
    this.pushEvent(live, {
      type: 'worker-settled',
      index: event.outcome.index,
      item: event.outcome.item,
      status: event.outcome.status,
      ...detail === undefined ? {} : { detail },
    })
  }

  /**
   * Settle the batch: counts, status, and the closing event.
   * @param sessionId - caller session.
   * @param batchId - batch returned by {@link begin}.
   * @param outcome - the aggregate, when the orchestrator produced one.
   * @param settlement - cancellation/error facts the aggregate cannot carry.
   */
  settle(sessionId: string, batchId: string, outcome: SwarmBatchOutcome | undefined, settlement: SwarmBoardSettlement = {}): void {
    const live = this.find(sessionId, batchId)
    if (live === undefined) return
    const at = Date.now()
    const cancelled = settlement.cancelled === true || live.cancelRequested
    if (outcome !== undefined) {
      // Progress normally delivered every terminal item, but a dropped observer
      // event must not leave a ghost: apply only the rows that have not settled.
      for (const item of outcome.items) {
        const worker = live.batch.workers.find(entry => entry.index === item.index)
        if (worker !== undefined && (worker.status === 'waiting' || worker.status === 'working')) {
          this.applyOutcome(live, item)
        }
      }
    }
    // Anything still waiting or working never settled: a cancelled batch or a
    // broken call. Record it as aborted so the roster has no ghost workers.
    live.batch.workers = live.batch.workers.map(entry => entry.status === 'waiting' || entry.status === 'working'
      ? { ...entry, status: 'aborted', settledAt: at }
      : entry)
    const status: SwarmBoardBatchStatus = cancelled
      ? 'cancelled'
      : outcome !== undefined && outcome.failed > 0
        ? 'failed'
        : outcome === undefined && settlement.error !== undefined
          ? 'failed'
          : 'completed'
    live.batch = {
      ...live.batch,
      status,
      finishedAt: at,
      ...outcome?.budgetExhausted === true ? { budgetExhausted: true } : {},
    }
    const detail = settlement.error === undefined ? undefined : preview(settlement.error)
    this.pushEvent(live, { type: 'batch-settled', status, ...detail === undefined ? {} : { detail } })
    live.cancel = undefined
    const session = this.sessions.get(sessionId)
    if (session !== undefined) session.lastTouched = at
  }

  /**
   * Request cancellation of a running batch.
   * @param sessionId - caller session.
   * @param batchId - batch returned by {@link begin}.
   * @returns whether a running batch was found and its canceler invoked.
   */
  cancel(sessionId: string, batchId: string): boolean {
    const live = this.find(sessionId, batchId)
    if (live === undefined || live.batch.status !== 'running' || live.cancelRequested) return false
    live.cancelRequested = true
    this.pushEvent(live, { type: 'batch-cancel-requested', status: 'cancelled' })
    const cancel = live.cancel
    live.cancel = undefined
    if (cancel !== undefined) {
      try {
        cancel('cancelled from the swarm board')
      } catch {
        // The batch settles through its own path; a throwing canceler cannot
        // be allowed to break the route.
      }
    }
    return true
  }

  /**
   * The JSON snapshot the board route returns.
   * @param sessionId - caller session.
   * @returns bounded batches, newest first, with counters derived from workers.
   */
  snapshot(sessionId: string): SwarmBoardSnapshot {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { sessionId, now: Date.now(), batches: [] }
    this.pruneBatches(session)
    const now = Date.now()
    return {
      sessionId,
      now,
      batches: session.batches.map(live => this.snapshotBatch(live)),
    }
  }

  /** Build one immutable batch view and derive its counts/tokens from workers. */
  private snapshotBatch(live: LiveBatch): SwarmBoardBatch {
    const workers = live.batch.workers
    const completed = workers.filter(worker => worker.status === 'completed').length
    const failed = workers.filter(worker => worker.status === 'failed').length
    const aborted = workers.filter(worker => worker.status === 'aborted').length
    const tokens = workers.reduce((sum, worker) => sum + (worker.tokens ?? 0), 0)
    return {
      ...live.batch,
      completed,
      failed,
      aborted,
      ...tokens > 0 ? { tokens } : {},
      ...live.cancelRequested ? { cancelRequested: true } : {},
      workers: workers.map(worker => ({ ...worker })),
      events: live.batch.events.map(event => ({ ...event })),
    }
  }

  /** Apply one terminal item outcome to its worker row. */
  private applyOutcome(live: LiveBatch, outcome: SwarmItemOutcome): void {
    const at = Date.now()
    const tokens = tokensOf(outcome)
    const outputPreview = preview(outcome.output)
    const error = preview(outcome.error)
    live.batch.workers = live.batch.workers.map(worker => worker.index !== outcome.index
      ? worker
      : {
          ...worker,
          status: outcome.status,
          settledAt: at,
          ...outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs },
          ...tokens === undefined ? {} : { tokens },
          ...outcome.retries === undefined ? {} : { retries: outcome.retries },
          ...outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind },
          ...outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode },
          ...outcome.name === undefined ? {} : { name: outcome.name },
          ...outcome.childId === undefined ? {} : { childId: outcome.childId },
          ...outputPreview === undefined ? {} : { outputPreview },
          ...error === undefined ? {} : { error },
        })
  }

  /** Append one event, dropping the oldest when the feed is full. */
  private pushEvent(live: LiveBatch, event: Omit<SwarmBoardEvent, 'seq' | 'at'>): void {
    this.seq += 1
    const events = [...live.batch.events, { seq: this.seq, at: Date.now(), ...event }]
    live.batch = {
      ...live.batch,
      events: events.length > MAX_EVENTS_PER_BATCH ? events.slice(events.length - MAX_EVENTS_PER_BATCH) : events,
    }
  }

  /** The session record, created on first use. */
  private sessionFor(sessionId: string): LiveSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: LiveSession = { batches: [], lastTouched: Date.now() }
    this.sessions.set(sessionId, created)
    return created
  }

  /** Locate one batch inside a session. */
  private find(sessionId: string, batchId: string): LiveBatch | undefined {
    return this.sessions.get(sessionId)?.batches.find(live => live.batch.id === batchId)
  }

  /** Drop expired finished batches; running batches stay. */
  private pruneBatches(session: LiveSession): void {
    const now = Date.now()
    const finished = session.batches.filter(live => live.batch.status !== 'running')
    const expired = new Set(finished
      .filter(live => live.batch.finishedAt !== undefined && now - live.batch.finishedAt > FINISHED_TTL_MS)
      .map(live => live.batch.id))
    const retained = session.batches.filter(live => !expired.has(live.batch.id))
    let finishedKept = 0
    session.batches.splice(0, session.batches.length, ...retained.filter((live) => {
      if (live.batch.status === 'running') return true
      finishedKept += 1
      return finishedKept <= MAX_FINISHED_BATCHES
    }))
  }

  /** Keep the session map bounded without forcing out a running batch. */
  private pruneSessions(incoming: string): void {
    if (this.sessions.has(incoming) || this.sessions.size < MAX_SESSIONS) return
    let victim: string | undefined
    let victimTouched = Number.POSITIVE_INFINITY
    for (const [sessionId, session] of this.sessions) {
      if (session.batches.some(live => live.batch.status === 'running')) continue
      if (session.lastTouched < victimTouched) {
        victim = sessionId
        victimTouched = session.lastTouched
      }
    }
    if (victim !== undefined) this.sessions.delete(victim)
  }
}
