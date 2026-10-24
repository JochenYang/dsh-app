/**
 * The background index queue: one project at a time, with a state every surface
 * can read.
 *
 * Why a queue and not "index when asked". A pass reads and parses thousands of
 * files; running it inside a tool call makes the model wait for work it did not
 * ask for, and running two at once on one machine multiplies the memory a pass
 * already holds. Serialising to one project keeps the cost bounded and makes the
 * state machine meaningful — "indexing" always means "one thing is happening".
 *
 * Why the state is exposed. The failure this plugin is most likely to have is
 * the one nobody can see: the graph quietly answering from a snapshot that is
 * hours old. Every consumer therefore reads {@link IndexState}, and `stale` is a
 * first-class answer rather than a silent fallback.
 *
 * Why `failed` is terminal until retried. An automatic retry loop around a pass
 * that fails for a structural reason (an unreadable root, a corrupt database)
 * would spin forever. The failure is recorded with its message and the next
 * explicit request retries.
 *
 * @module @dsh-app/plugin-codegraph/host/queue
 */

import type { IndexOutcome } from './indexer.ts'
import type { IndexState, ProjectMeta } from './store.ts'

/** One project's live status. */
export interface ProjectStatus {
  readonly cwd: string
  readonly name: string
  readonly state: IndexState
  /** Epoch ms of the last completed pass, or 0. */
  readonly indexedAt: number
  /** What the last pass did, when it finished. */
  readonly lastOutcome: IndexOutcome | undefined
  /** Why the last pass failed, when it did. */
  readonly failure: string | undefined
  /** True when the queue has this project waiting. */
  readonly queued: boolean
}

/** What one job does: the pass itself, supplied by the plugin. */
export type IndexRunner = (cwd: string, signal: AbortSignal) => Promise<IndexOutcome>

/** The queue's public face. */
export interface IndexQueue {
  /**
   * Ask for a pass on one project.
   *
   * Idempotent while queued or running: a second request for the same project
   * returns the same promise rather than stacking a second pass.
   */
  request(cwd: string): Promise<IndexOutcome>
  /** Current status of every project the queue has seen. */
  statuses(): ProjectStatus[]
  /** One project's status, or undefined. */
  status(cwd: string): ProjectStatus | undefined
  /** Adopt metadata a previous run left in a graph (called when a graph opens). */
  adopt(cwd: string, meta: ProjectMeta | undefined): void
  /**
   * Mark one project's graph as out of date.
   *
   * The queue never decides staleness itself — that needs the working tree's
   * HEAD, which only the caller has. Without this entry the `stale` state existed
   * in the type and was unreachable at runtime, so a surface could never show
   * "this graph is behind".
   */
  markStale(cwd: string): void
  /**
   * Drop one project from the queue's bookkeeping.
   *
   * Called when the user deletes a project's graph: the entry would otherwise
   * keep reporting a graph that no longer exists, and the settings list would
   * show the deleted project until the next restart.
   */
  forget(cwd: string): void
  /** Stop accepting work and fail every waiter. */
  dispose(): void
}

/** One project's bookkeeping inside the queue. */
interface Entry {
  state: IndexState
  indexedAt: number
  lastOutcome: IndexOutcome | undefined
  failure: string | undefined
  queued: boolean
  pending: Promise<IndexOutcome> | undefined
}

/** A job waiting for its turn. */
interface Job {
  readonly cwd: string
  readonly settle: (outcome: IndexOutcome) => void
  readonly fail: (error: Error) => void
}

/** A queue with a concurrency of one. */
export function createIndexQueue(run: IndexRunner): IndexQueue {
  const records = new Map<string, Entry>()
  const waiting: Job[] = []
  let running = false
  let disposed = false
  /** The controller for the job currently running, so `dispose` can abort it. */
  let activeController: AbortController | undefined

  const record = (cwd: string): Entry => {
    let entry = records.get(cwd)
    if (entry === undefined) {
      entry = { state: 'unindexed', indexedAt: 0, lastOutcome: undefined, failure: undefined, queued: false, pending: undefined }
      records.set(cwd, entry)
    }
    return entry
  }

  const nameOf = (cwd: string): string => cwd.split(/[\\/]/u).filter(part => part !== '').pop() ?? cwd

  /**
   * Run the waiting list until it is empty.
   *
   * A plain `while` rather than recursion: a job queued DURING a pass is picked
   * up by the same loop, and there is no stack to grow.
   */
  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (let job = waiting.shift(); job !== undefined; job = waiting.shift()) {
        if (disposed) {
          job.fail(new Error('the code graph queue was disposed'))
          continue
        }
        const entry = record(job.cwd)
        entry.state = 'indexing'
        entry.queued = false
        // One controller per job, retained so `dispose` can actually cancel it —
        // the runner's signature promises cancellability.
        const controller = new AbortController()
        activeController = controller
        try {
          const outcome = await run(job.cwd, controller.signal)
          // A pass that finished after disposal must not resurrect the record.
          if (!disposed) {
            entry.state = 'current'
            entry.indexedAt = Date.now()
            entry.lastOutcome = outcome
            entry.failure = undefined
          }
          job.settle(outcome)
        } catch (error) {
          // Recorded, not retried: a structural failure would spin forever, and
          // the caller that asked is the one that knows whether to try again.
          const message = error instanceof Error ? error.message : String(error)
          if (!disposed) {
            entry.state = 'failed'
            entry.failure = message
          }
          job.fail(new Error(message))
        } finally {
          activeController = undefined
          entry.pending = undefined
        }
      }
    } finally {
      running = false
    }
  }

  return {
    request(cwd: string): Promise<IndexOutcome> {
      if (disposed) return Promise.reject(new Error('the code graph queue was disposed'))
      const entry = record(cwd)
      // One pass per project at a time: a duplicate request joins the pending
      // one instead of stacking a second pass on the same database.
      if (entry.pending !== undefined) return entry.pending
      // The promise is created and ASSIGNED before `pump()` can start the job.
      // Assigning after would leave a window in which a runner that synchronously
      // calls `request()` (or throws) sees no pending promise: the first case
      // queues a second job on a concurrency-1 queue (deadlock), the second
      // leaves a permanently rejected promise in `entry.pending`, so that
      // project could never be indexed again.
      let settleJob: (outcome: IndexOutcome) => void = () => {}
      let failJob: (error: Error) => void = () => {}
      const promise = new Promise<IndexOutcome>((resolve, reject) => {
        settleJob = resolve
        failJob = reject
      })
      entry.pending = promise
      waiting.push({ cwd, settle: settleJob, fail: failJob })
      entry.queued = true
      // Deferred to a microtask so the executor above finishes and `entry.pending`
      // is observable before any runner code runs.
      queueMicrotask(() => { void pump() })
      return promise
    },

    statuses(): ProjectStatus[] {
      return [...records.entries()].map(([cwd, entry]) => ({
        cwd,
        name: nameOf(cwd),
        state: entry.state,
        indexedAt: entry.indexedAt,
        lastOutcome: entry.lastOutcome,
        failure: entry.failure,
        queued: entry.queued,
      }))
    },

    status(cwd: string): ProjectStatus | undefined {
      return this.statuses().find(status => status.cwd === cwd)
    },

    adopt(cwd: string, meta: ProjectMeta | undefined): void {
      if (meta === undefined) return
      const entry = record(cwd)
      // A graph that already carries metadata was indexed in an earlier run of
      // this process (or a previous one): it starts as `current`, and the stale
      // check decides whether it stays that way.
      if (entry.state === 'unindexed') {
        entry.state = 'current'
        entry.indexedAt = meta.indexedAt
      }
    },

    markStale(cwd: string): void {
      const entry = record(cwd)
      // Only a settled graph becomes stale: one that is indexing or already
      // failed has a more specific state, and overwriting it would hide why.
      if (entry.state === 'current') entry.state = 'stale'
    },

    forget(cwd: string): void {
      const entry = records.get(cwd)
      if (entry === undefined) return
      // A pass still in flight would write into a database the caller just
      // deleted, so the delete waits for it: the caller cancels by awaiting the
      // running pass's own promise, and this only drops the bookkeeping.
      records.delete(cwd)
    },

    dispose(): void {
      disposed = true
      // Cancel the pass in flight: the runner was given this signal and is
      // expected to stop at its next checkpoint.
      activeController?.abort()
      // Every waiter is failed rather than left hanging: a caller awaiting a pass
      // that will never run would hold its own resources forever.
      for (const job of waiting.splice(0)) job.fail(new Error('the code graph queue was disposed'))
      for (const entry of records.values()) {
        entry.queued = false
        entry.pending = undefined
        if (entry.state === 'indexing') entry.state = 'unindexed'
      }
    },
  }
}
