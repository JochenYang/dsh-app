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
 * **A tool result buys a CHECK, not a verdict.** "A tool ran" is not "a file
 * changed": `Read`, `Grep`, a passing test run and a build that rewrote identical
 * bytes are all tool results. {@link IndexQueue.check} therefore asks the injected
 * `changed` predicate — the same stat comparison the pass itself uses, reading only —
 * and only schedules a pass when it answers yes. Marking the graph `stale` on the
 * weaker evidence was a real defect: a stream of read-only calls kept a project
 * permanently `stale` AND permanently walking, which is the re-index spin this module
 * exists to prevent, reached through the front door.
 *
 * **Deleting a project cancels its work.** {@link IndexQueue.forget} aborts the pass in
 * flight, fails every waiting job for that cwd, waits for the aborted pass to settle,
 * and only then drops the record. Without that, closing the graph handle and deleting
 * the directory left a running pass (or an owed compensating pass) holding the old
 * handle — which re-created the graph directory the user had just deleted.
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
  /**
   * True while a read-only change CHECK is running for this project.
   *
   * Not an `IndexState` on purpose: a check has not proved anything, so it must not
   * reach the settings page or a tool answer as though the graph were behind. It is
   * here so a test (and a diagnostic surface) can observe that the work happened.
   */
  readonly checking: boolean
  /**
   * True when a check is owed and has not answered yet.
   *
   * The window between a tool result and the check's verdict. A tool answer in that
   * window must not claim `current`: an uncommitted edit plus an immediate query is
   * exactly the case that reported stale bytes as current before this round.
   */
  readonly pendingCheck: boolean
  /**
   * True when the project is `stale` because the compensation ceiling was reached.
   *
   * A pass cannot converge while changes keep arriving during it, so the ceiling stops
   * the chain. The state then is `stale` and only an EXPLICIT re-index clears it — and
   * the freshness note for it must say exactly that, because "a rebuild is running"
   * would be a lie about a pass nothing started.
   */
  readonly awaitingRetry: boolean
}

/** What one job does: the pass itself, supplied by the plugin. */
export type IndexRunner = (cwd: string, signal: AbortSignal) => Promise<IndexOutcome>

/**
 * Whether the project's sources moved since its last pass.
 *
 * Injected rather than computed here for the same reason the runner is: it needs the
 * graph and the disk, and this module is the state machine. It must be READ-ONLY — the
 * queue calls it on every check, and a check that wrote would be a pass wearing another
 * name.
 */
export type ChangeCheck = (cwd: string) => boolean

/** What the queue needs to run. */
export interface IndexQueueOptions {
  /** The read-only "did anything change" check. Absent means "assume yes". */
  readonly changed?: ChangeCheck
}

/**
 * How many compensating passes one burst of changes may buy.
 *
 * A pass that is asked for while another is RUNNING may have already read the
 * files that changed, so it owes a follow-up — and that follow-up can be
 * invalidated the same way. Without a ceiling, a tool-heavy session that keeps
 * writing during every pass would chain passes forever. Four is enough for the
 * real shape (one edit during a pass, one pass after it); past that the project
 * is honestly reported `stale` and stays there until an explicit request, so the
 * graph never claims `current` over a change it did not scan.
 */
const MAX_COMPENSATION_PASSES = 4

/**
 * How many times one check wake may re-run because a further result arrived during it.
 *
 * The check itself is read-only and cheap, but "re-run whenever another result
 * arrived" is a loop whose bound is the caller's behaviour. Three is enough to cover a
 * burst that lands across one walk; past that the next debounce window owns it.
 */
const MAX_CHECK_RERUNS = 3

/** The queue's public face. */
export interface IndexQueue {
  /**
   * Ask for a pass on one project.
   *
   * Idempotent while queued or running: a second request for the same project
   * returns the same promise rather than stacking a second pass.
   */
  request(cwd: string): Promise<IndexOutcome>
  /**
   * Ask whether this project needs a pass, and run one if it does.
   *
   * The call a tool result makes. It does NOT mark the graph `stale` — nothing has
   * been proved yet — and it does not throw or reject: the caller is an observer of a
   * settled tool call, which has no way to act on a failed index. A check that cannot
   * read the tree falls through to a pass, so the real error reaches the project's
   * recorded status rather than being swallowed here.
   *
   * Never schedules a pass for a `failed` project (that is the retry spin) or for one
   * whose compensation ceiling was reached (that is what the ceiling means).
   */
  check(cwd: string): void
  /**
   * Note that a result is pending for this project: a check is owed.
   *
   * Distinct from {@link check}, which RUNS one. This is what the `tools/result`
   * observer calls synchronously, so the window between a settled tool and the check's
   * verdict is visible to a tool answer — `freshnessOf` reports `indexing` there rather
   * than `current`, which is the difference between "we looked" and "we have not looked
   * yet" on exactly the input that used to be wrong.
   */
  observe(cwd: string): void
  /**
   * Record that a check's question was answered outside the queue.
   *
   * `freshnessOf` runs the same read-only comparison when a query lands inside the
   * debounce window, so the answer is proved rather than guessed. When that comparison
   * finds nothing, the pending check has nothing left to decide, and clearing it is what
   * keeps a burst of queries from walking the tree once per query.
   */
  settleCheck(cwd: string): void
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
   * Cancel one project's work and drop its bookkeeping.
   *
   * Resolves only once the pass in flight has SETTLED — that is the whole contract,
   * and the reason it returns a promise. The caller (a project delete) closes the
   * graph handle next, then removes the directory; doing either before this resolves
   * is what let a running pass write into a closed handle and re-create the directory.
   *
   * Every waiting job for this cwd is failed with a cancellation error, so a caller
   * awaiting `request` sees a rejection it must catch — the plugin's two call sites
   * already do, and the pass that was aborted does not record a structural failure.
   */
  forget(cwd: string): Promise<void>
  /** Stop accepting work, cancel every pass in flight, and resolve once they settled. */
  dispose(): Promise<void>
}

/** One project's bookkeeping inside the queue. */
interface Entry {
  state: IndexState
  indexedAt: number
  lastOutcome: IndexOutcome | undefined
  failure: string | undefined
  queued: boolean
  /** The pass this project owes or is running, so a second request joins it. */
  pending: Promise<IndexOutcome> | undefined
  /**
   * A change was reported for this project and no pass has STARTED since.
   *
   * Cleared when a pass starts (that pass will read the new bytes) and set again
   * by a change that arrives while one is running — which is the case the queue
   * exists to not drop: the running pass may already have read the file.
   */
  dirty: boolean
  /** Compensating passes run since the last pass that ended with nothing pending. */
  compensations: number
  /**
   * The compensation ceiling was reached: the project is `stale` and stays there
   * until an EXPLICIT request.
   *
   * Without this, a check would schedule a pass on the very next tool result, so "the
   * ceiling holds" would only mean "the chain restarts after any tool call" — the
   * unbounded work the ceiling exists to bound.
   */
  exhausted: boolean
  /** A read-only change check is in flight for this project. */
  checking: boolean
  /**
   * A check is OWED but has not started (the debounce window is open).
   *
   * The window between "a tool settled" and "the check answered" is one in which the
   * plugin knows a tool ran and nothing more. Reporting `current` there is a claim it
   * cannot back up — an uncommitted edit plus an immediate query would answer from the
   * previous bytes and say they are current, which is the defect this whole round is
   * about. Reporting `stale` is the opposite error: nothing has been proved. So the
   * honest state for that window is `indexing` with a note saying a check is running,
   * and the check resolves it to `current` (nothing moved) or to a pass.
   */
  pendingCheck: boolean
  /** A further result arrived while that check ran. */
  checkAgain: boolean
  /** Re-runs used by the current check wake, against {@link MAX_CHECK_RERUNS}. */
  checkReruns: number
  /** The controller for this project's running pass, so `forget` can abort it. */
  controller: AbortController | undefined
  /** The running pass's promise, so `forget` can wait for it to settle. */
  running: Promise<void> | undefined
  /** This project is being deleted; a settling pass must not record anything. */
  removing: boolean
}

/** A job waiting for its turn. */
interface Job {
  readonly cwd: string
  /** The promise `request` handed out, so `pending` is cleared only when THIS job ends. */
  readonly promise: Promise<IndexOutcome>
  readonly settle: (outcome: IndexOutcome) => void
  readonly fail: (error: Error) => void
}

/** A queue with a concurrency of one. */
export function createIndexQueue(run: IndexRunner, options: IndexQueueOptions = {}): IndexQueue {
  const records = new Map<string, Entry>()
  const waiting: Job[] = []
  let running = false
  let disposed = false
  /**
   * Projects being deleted, kept AFTER their record is dropped.
   *
   * The record has to go (the settings list must stop showing the project), but a job
   * that was already scheduled for it would then find a NEW record — with `removing`
   * false — and run, re-creating the directory the user just deleted. This set is what
   * survives that, and it is cleared by `request` (an explicit re-index of a path the
   * user chose is a new decision) or by `dispose`.
   */
  const removed = new Set<string>()

  const record = (cwd: string): Entry => {
    let entry = records.get(cwd)
    if (entry === undefined) {
      entry = {
        state: 'unindexed', indexedAt: 0, lastOutcome: undefined, failure: undefined,
        queued: false, pending: undefined, dirty: false, compensations: 0, exhausted: false,
        checking: false, pendingCheck: false, checkAgain: false, checkReruns: 0, controller: undefined,
        running: undefined, removing: false,
      }
      records.set(cwd, entry)
    }
    return entry
  }

  const nameOf = (cwd: string): string => cwd.split(/[\\/]/u).filter(part => part !== '').pop() ?? cwd

  /** The error a cancelled job fails with. Exported nowhere: callers only catch. */
  const cancelled = (): Error => new Error('the code graph pass was cancelled')

  /**
   * Place one job for a project on the waiting list and return its promise.
   *
   * The promise is created and ASSIGNED before `pump()` can start the job.
   * Assigning after would leave a window in which a runner that synchronously
   * calls `request()` (or throws) sees no pending promise: the first case queues a
   * second job on a concurrency-1 queue (deadlock), the second leaves a
   * permanently rejected promise in `entry.pending`, so that project could never
   * be indexed again.
   */
  const schedule = (cwd: string): Promise<IndexOutcome> => {
    const entry = record(cwd)
    let settleJob: (outcome: IndexOutcome) => void = () => {}
    let failJob: (error: Error) => void = () => {}
    const promise = new Promise<IndexOutcome>((resolve, reject) => {
      settleJob = resolve
      failJob = reject
    })
    entry.pending = promise
    waiting.push({ cwd, promise, settle: settleJob, fail: failJob })
    entry.queued = true
    // Deferred to a microtask so the executor above finishes and `entry.pending`
    // is observable before any runner code runs.
    queueMicrotask(() => { void pump() })
    return promise
  }

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
        // A job whose project was deleted while it waited: the record was dropped, so
        // this is a NEW entry — and the tombstone is what remembers the delete. Running
        // it would re-create the graph directory the user just removed, which is the
        // failure `forget` exists to prevent.
        if (removed.has(job.cwd) || entry.removing) {
          job.fail(cancelled())
          continue
        }
        entry.state = 'indexing'
        entry.queued = false
        // This pass reads the tree as it is when it starts scanning, so whatever
        // was reported before this point is about to be seen. A change reported
        // AFTER this line sets `dirty` again and buys a compensating pass.
        entry.dirty = false
        // One controller per project, retained so a project delete can actually cancel
        // its own pass — the runner's signature promises cancellability. The previous
        // single shared controller meant `dispose` could cancel, but a per-project
        // delete could not.
        const controller = new AbortController()
        entry.controller = controller
        const pass = (async (): Promise<void> => {
          try {
            const outcome = await run(job.cwd, controller.signal)
            // A pass that finished after disposal must not resurrect the record.
            if (!disposed && !entry.removing) {
              entry.state = 'current'
              entry.indexedAt = Date.now()
              entry.lastOutcome = outcome
              entry.failure = undefined
              // THE COMPENSATION. A change that arrived while this pass ran may have
              // landed after the files it touched were read, so this pass can be
              // `current` and still behind — the exact hole that let an edit made
              // during an index disappear until the next unrelated tool call. One
              // more pass settles it, and a burst coalesces into that one because
              // `dirty` is a flag rather than a count.
              if (entry.dirty) {
                entry.dirty = false
                if (entry.compensations < MAX_COMPENSATION_PASSES) {
                  entry.compensations += 1
                  void schedule(job.cwd).catch(() => { /* recorded on the status */ })
                } else {
                  // The ceiling exists so a session that writes during every pass
                  // cannot chain passes forever. Say so instead of claiming currency:
                  // `stale` is the honest answer and the next explicit request retries.
                  // `exhausted` is what keeps a CHECK from re-arming it.
                  entry.state = 'stale'
                  entry.exhausted = true
                }
              } else {
                entry.compensations = 0
              }
            }
            job.settle(outcome)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const aborted = controller.signal.aborted || entry.removing
            if (!disposed && !entry.removing && !aborted) {
              // Recorded, not retried: a structural failure would spin forever, and
              // the caller that asked is the one that knows whether to try again.
              entry.state = 'failed'
              entry.failure = message
              // An owed pass after a failure would be an automatic retry, which is
              // the spin this queue's header forbids.
              entry.dirty = false
            }
            job.fail(aborted ? cancelled() : new Error(message))
          } finally {
            entry.controller = undefined
            // CLEARED ONLY IF IT IS STILL THIS JOB'S PROMISE. A compensating pass is
            // scheduled from inside the `try` above, so `entry.pending` already holds
            // the FOLLOW-UP's promise by the time this runs; an unconditional clear
            // would drop it, and the next request would queue a second job on a
            // concurrency-1 queue while the compensation waits — a deadlock.
            if (entry.pending === job.promise) entry.pending = undefined
          }
        })()
        entry.running = pass
        await pass
        entry.running = undefined
      }
    } finally {
      running = false
    }
  }

  /** One read-only check: ask whether anything changed, and index only if it did. */
  const runCheck = (cwd: string): void => {
    if (disposed) return
    const entry = records.get(cwd)
    if (entry === undefined) return
    // Every exit below clears `pendingCheck`: it is the "a check has not answered"
    // marker, and leaving it set would keep a healthy project reporting `indexing`.
    if (entry.state === 'failed' || entry.exhausted || entry.removing) {
      entry.checking = false
      entry.pendingCheck = false
      return
    }
    // A pass is queued or running — it will read the tree as it is when it starts, so
    // this check has nothing to decide. A RUNNING pass may already have read what the
    // caller saw, so it owes a compensation.
    if (entry.pending !== undefined || entry.running !== undefined) {
      entry.checking = false
      entry.pendingCheck = false
      if (entry.state === 'indexing') entry.dirty = true
      return
    }
    let changed = true
    try {
      changed = options.changed === undefined ? true : options.changed(cwd)
    } catch {
      // A check that cannot read the tree must not answer "unchanged": that would
      // report a broken project as up to date. Fall through to the pass, which records
      // the failure where every surface can see it.
      changed = true
    }
    if (changed) {
      entry.checking = false
      entry.pendingCheck = false
      entry.checkAgain = false
      entry.checkReruns = 0
      // Reset the compensation budget: this is a NEW change, not a continuation of the
      // burst the ceiling stopped. A project that was `stale` (proven behind) also
      // becomes `indexing` here, which is the honest answer.
      entry.compensations = 0
      void schedule(cwd).catch(() => { /* recorded on this project's status */ })
      return
    }
    // Unchanged. The state the entry already had is the truthful one: a `current`
    // graph stays current, and this is the case that used to be reported as `stale`.
    //
    // A result that arrived DURING this check re-runs it, because it may describe a
    // write this walk had already passed. The re-run is bounded: past
    // {@link MAX_CHECK_RERUNS} the next debounce window owns the question, which is
    // what keeps a long read-only stream from re-walking the tree per tool call.
    if (entry.checkAgain && entry.checkReruns < MAX_CHECK_RERUNS) {
      entry.checkAgain = false
      entry.checkReruns += 1
      queueMicrotask(() => { runCheck(cwd) })
      return
    }
    entry.checkAgain = false
    entry.checkReruns = 0
    entry.checking = false
    entry.pendingCheck = false
  }

  return {
    request(cwd: string): Promise<IndexOutcome> {
      if (disposed) return Promise.reject(new Error('the code graph queue was disposed'))
      // An EXPLICIT re-index of a path the user chose is a new decision, and it is what
      // lifts the delete tombstone — a project deleted and then opened again must be
      // indexable.
      removed.delete(cwd)
      const entry = record(cwd)
      entry.removing = false
      // One pass per project at a time: a duplicate request joins the pending
      // one instead of stacking a second pass on the same database.
      if (entry.pending !== undefined) return entry.pending
      // An EXPLICIT request is the one thing that clears the compensation ceiling: a
      // human asked, and the pass may converge now (the burst that kept invalidating it
      // has stopped).
      entry.exhausted = false
      entry.compensations = 0
      return schedule(cwd)
    },

    check(cwd: string): void {
      if (disposed) return
      // A deleted project is not checked: `record` would create a fresh entry and the
      // pass it schedules would re-create the directory.
      if (removed.has(cwd)) return
      const entry = record(cwd)
      if (entry.state === 'failed' || entry.exhausted || entry.removing) return
      if (entry.checking) {
        // Coalesced: this wake re-runs once at the end rather than stacking walks.
        entry.checkAgain = true
        return
      }
      entry.checking = true
      // The question is open from this moment: a query that arrives before the answer
      // must not claim the graph is current.
      entry.pendingCheck = true
      entry.checkReruns = 0
      entry.checkAgain = false
      // Deferred so the `tools/result` observer returns immediately: the walk is real
      // disk I/O and an observer holding the kernel's loop is the freeze this plugin
      // already paid for once.
      queueMicrotask(() => { runCheck(cwd) })
    },

    observe(cwd: string): void {
      if (disposed) return
      if (removed.has(cwd)) return
      const entry = record(cwd)
      if (entry.state === 'failed' || entry.exhausted || entry.removing) return
      // A check is owed from this moment: a tool answer that lands in the debounce
      // window must not report the graph as current.
      entry.pendingCheck = true
    },

    settleCheck(cwd: string): void {
      const entry = records.get(cwd)
      if (entry === undefined) return
      // Only the OWED marker is cleared. A check that is already RUNNING keeps its own
      // state: its answer is still the authority for that wake.
      if (entry.checking) return
      entry.pendingCheck = false
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
        checking: entry.checking,
        pendingCheck: entry.pendingCheck,
        awaitingRetry: entry.exhausted,
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

    async forget(cwd: string): Promise<void> {
      const entry = records.get(cwd)
      if (entry === undefined) return
      // 1. Stop accepting new work for this project, and make sure a pass that settles
      //    from here on records nothing: the caller is about to close the handle.
      entry.removing = true
      entry.dirty = false
      entry.exhausted = false
      entry.checking = false
      // 2. Cancel every job waiting for this project. Their promises settle with a
      //    rejection the caller catches, rather than hanging for a pass that will never
      //    run — and rather than running against a database that is about to go away.
      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        const job = waiting[index]
        if (job === undefined || job.cwd !== cwd) continue
        waiting.splice(index, 1)
        job.fail(cancelled())
      }
      // 3. Abort the pass in flight (if any) and WAIT for it. The wait is the point:
      //    returning earlier is what let a pass write into the closed handle and
      //    re-create the directory.
      entry.controller?.abort()
      if (entry.running !== undefined) {
        try { await entry.running } catch { /* the aborted pass rejects; that is expected */ }
      }
      // 4. Drop the bookkeeping only now, so nothing above can resolve to a record that
      //    no longer exists. The tombstone stays: a job already scheduled for this cwd
      //    would otherwise create a fresh record and run against a deleted directory.
      if (records.get(cwd) === entry) records.delete(cwd)
      removed.add(cwd)
    },

    async dispose(): Promise<void> {
      disposed = true
      // Cancel every project's pass and WAIT for them. `dispose` used to abort and
      // return synchronously, so the caller closed the graph handles while a phase 2 or
      // phase 3 was still running — and a batch commit, or the recovery path's
      // `forgetStatCache`, then wrote through a closed handle. The wait is the contract:
      // an async disposer is supported by the kernel's effect, and the plugin's teardown
      // awaits it before closing anything.
      // COLLECT FIRST, THEN ABORT. Aborting synchronously runs the runner's own abort
      // listener, which can settle the pass before the loop below reaches that entry —
      // and a promise that already settled is still awaited here, but only if it was
      // captured BEFORE the abort. Collecting after was the bug the test caught: dispose
      // resolved while the runner was still on the stack.
      const running: Promise<void>[] = []
      for (const entry of records.values()) {
        if (entry.running !== undefined) running.push(entry.running)
      }
      for (const entry of records.values()) {
        entry.removing = true
        entry.controller?.abort()
      }
      // Every waiter is failed rather than left hanging: a caller awaiting a pass
      // that will never run would hold its own resources forever. Each rejection is
      // already caught at the plugin's call sites.
      for (const job of waiting.splice(0)) job.fail(new Error('the code graph queue was disposed'))
      for (const entry of records.values()) {
        entry.queued = false
        entry.pending = undefined
        // A pass that would have been owed after unload must not start one: the
        // graph handles are closed by the same teardown.
        entry.dirty = false
        entry.compensations = 0
        entry.exhausted = false
        entry.checking = false
        if (entry.state === 'indexing') entry.state = 'unindexed'
      }
      // A cancelled pass REJECTS (it throws `IndexAbortedError` out of the runner), and
      // that rejection is expected here — the caller only needs it to be finished.
      await Promise.allSettled(running)
    },
  }
}
