/**
 * The tool-result trigger: turning "the agent just did something" into a change CHECK.
 *
 * WHY A TOOL-RESULT TRIGGER AND NOT A WATCHER. The graph used to be refreshed only
 * when its HEAD moved or when a tool call found the graph absent. Neither notices an
 * ordinary edit: `git rev-parse HEAD` is unchanged by an uncommitted write, and the
 * file-stat comparison inside `indexProject` only runs when a pass runs. Measured shape
 * of the failure — an agent edits `src/util.ts`, asks `codegraph_impact`, and the answer
 * describes the file from before the edit while reporting `current`, which is worse than
 * an empty answer because it looks authoritative.
 *
 * A filesystem watcher would catch an edit made in an external editor, and it is
 * deliberately not the mechanism here: it is a resident handle per project, it
 * multiplies across platforms, and the thing that actually needs to know is a SESSION,
 * whose writes always arrive through the tool pipeline. The kernel already emits one
 * `tools/result` per settled call — including a `write`/`edit`, a `shell` command that
 * ran a formatter, and a nested `run_code` dispatch — so observing that event covers
 * every way a session changes the tree without naming a single tool.
 *
 * **WHAT IT SCHEDULES IS A CHECK, NOT A VERDICT.** A tool result means a tool ran. It
 * does not mean a byte changed: `Read`, `Grep`, a passing test run and a build that
 * rewrote identical output all produce results. An earlier version marked the project
 * `stale` here, and that was wrong in a way the plugin's own rules forbid — a stream of
 * read-only calls kept the graph `stale` AND walking the tree every debounce window,
 * reporting work nobody did. So this module only decides WHEN to ask, and `queue.check`
 * answers with the same stat comparison the pass itself uses. The graph becomes `stale`
 * only once a check has PROVED it is behind, or after a pass that was interrupted by
 * further changes.
 *
 * TWO RULES, EACH WITH A REASON:
 *
 *   - **Debounce, do not queue.** A turn can settle tools in bursts, and each check
 *     costs a directory walk per project. One trailing check per debounce window, per
 *     project, coalesces the burst: the first result in a window arms the timer and the
 *     rest join it, so a burst costs one walk rather than one per result.
 *   - **A pending check is not rescheduled.** Extending the timer on every result
 *     would postpone the check for as long as tool calls keep arriving, which is
 *     exactly a long turn — the window in which the graph is most out of date. The
 *     first result in a window names the moment.
 *
 * `observe` is separate from `notify` for the same reason the check is separate from the
 * verdict: `observe` runs synchronously on the result, so the window between "a tool
 * settled" and "the check answered" is visible to a tool answer (which reports
 * `indexing` there rather than `current`). `notify` only arms the timer.
 *
 * The scheduler owns no queue and no database: `request` is supplied, so the timing
 * rules are testable without a Context, a clock or an open graph.
 *
 * @module @dsh-app/plugin-codegraph/refresh
 */

/** One project's pending check. Opaque: only the injected timer functions read it. */
type TimerHandle = unknown

/** How long after the first reported result a check runs. */
export const DEFAULT_DEBOUNCE_MS = 500

/** What the scheduler needs from its owner. */
export interface RefreshOptions {
  /**
   * Ask the queue to check this project.
   *
   * Must not mark the graph stale and must not throw: it is called from a settled-tool
   * observer, which has no way to act on a failure.
   */
  readonly request: (cwd: string) => void
  /**
   * Note that a check is owed for this project, before the debounce starts.
   *
   * Called synchronously from the observer, so the window between the result and the
   * check is observable by a tool answer. Optional: a caller that only wants the timer
   * gets the timer.
   */
  readonly observe?: (cwd: string) => void
  /** Debounce window in ms. */
  readonly debounceMs?: number
  /** Timer primitives, injectable so tests do not wait on a real clock. */
  readonly setTimer?: (callback: () => void, ms: number) => TimerHandle
  readonly clearTimer?: (handle: TimerHandle) => void
}

/** The scheduler's public face. */
export interface RefreshScheduler {
  /**
   * One tool result may have changed this project.
   *
   * Idempotent within the debounce window, and a no-op after `dispose`.
   */
  notify(cwd: string): void
  /**
   * Note that a result is pending for this project, WITHOUT arming a timer.
   *
   * The listener calls this the moment a result arrives, then `notify` arms the
   * debounce. The separation is what makes the window honest: from the first result
   * until the check answers, the graph may be behind, and a tool answer must not say
   * `current` in that window — which is exactly the "stale bytes reported as current"
   * defect when an edit is followed immediately by a query.
   */
  observe(cwd: string): void
  /** Cancel every pending check. Later `notify` calls do nothing. */
  dispose(): void
}

/**
 * The default timer, unref'd where the runtime supports it.
 *
 * An Electron main process keeps running while a timer is armed, and a plugin that
 * registered one during unload would be a leak the teardown cannot see. Node's
 * `Timeout` has `unref`; the web timer (a number) does not, and needs nothing.
 */
function defaultSetTimer(callback: () => void, ms: number): TimerHandle {
  const handle: unknown = setTimeout(callback, ms)
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref()
  }
  return handle
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Create one scheduler.
 *
 * @param options - what to ask for, and the timer primitives.
 * @returns a scheduler with no timers armed until the first `notify`.
 */
export function createRefreshScheduler(options: RefreshOptions): RefreshScheduler {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer
  const pending = new Map<string, TimerHandle>()
  let disposed = false

  return {
    notify(cwd: string): void {
      if (disposed || cwd === '') return
      // A check is already owed for this project: the window is open and its timer
      // fires at the first result's moment. Nothing else to do — the check that runs
      // reads the tree as it is then, including this result.
      if (pending.has(cwd)) return
      const handle = setTimer(() => {
        pending.delete(cwd)
        if (disposed) return
        options.request(cwd)
      }, debounceMs)
      pending.set(cwd, handle)
    },

    observe(cwd: string): void {
      if (disposed || cwd === '') return
      options.observe?.(cwd)
    },

    dispose(): void {
      disposed = true
      for (const handle of pending.values()) clearTimer(handle)
      pending.clear()
    },
  }
}
