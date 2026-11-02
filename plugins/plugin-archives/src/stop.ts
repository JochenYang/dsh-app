/**
 * "Stop this session's work, then wait until it is really idle" — through the
 * kernel's PUBLIC seam, with a bounded wait.
 *
 * ## The two public surfaces
 *
 *   - `workspace/session-stop` — a PARALLEL event (`@deepseek-ai/dsh-workspace/lib/types/index.d.ts:110`,
 *     dispatched with `ctx.parallel(...)`; the registry's own archive path does
 *     exactly that at `@deepseek-ai/dsh-workspace/lib/index.js:623`). Each
 *     provider cancels ITS family — a turn, its subagent descendants, owned jobs,
 *     an active schedule — through the same cancel paths the user's own stop
 *     buttons use. A listener that raises rejects the whole dispatch with an
 *     `AggregateError` (`@deepseek-ai/cordis/lib/index.js:273`), which is what
 *     {@link stopAndWait} reports as `stop-failed`.
 *   - `workspace/session-activity` — the waterfall that answers "is anything still
 *     running for this session" (`@deepseek-ai/dsh-workspace/lib/types/index.d.ts:95`),
 *     the same one the delete fence already asks once.
 *
 * `session-stop` is deliberately fire-and-return: its own documentation says a
 * listener "issues its stop requests without waiting for running work to settle".
 * So issuing the stop is not proof the session is idle, and a delete that moved a
 * log on that proof alone would cut a turn in half — the exact loss the `live`
 * fence exists to prevent. Hence the poll: the stop is requested, then the
 * activity question is asked again until it comes back empty.
 *
 * ## The wait is bounded twice over, and it never guesses
 *
 * {@link STOP_TIMEOUT_MS} of wall clock, sampled every {@link STOP_POLL_MS}. When
 * the budget runs out the answer is `still-running` with the ids that were still
 * active, and the caller moves NOTHING. An activity read that THROWS is counted as
 * "still active" for that id for the rest of the window: "I could not tell"
 * cannot be read as "it stopped", and the poll will time out rather than proceed.
 *
 * ## What this module cannot do
 *
 * It cannot take a live session out of the kernel's in-memory session store. The
 * only two handles for that in `@deepseek-ai/dsh-session` are `detachEntered` and
 * `liveEntryFor`, both declared `private` (`lib/types/index.d.ts:459` and `:485`),
 * and using them would need an `as unknown as` cast that the type gate cannot see
 * and a kernel-line bump would break in silence — the drift AGENTS.md rules out.
 * A session that was live when its log directory moved is therefore still resident
 * until the next kernel restart; this module neither hides that nor pretends
 * otherwise.
 *
 * @module @dsh-app/plugin-archives/stop
 */

/** How long a stop request may take to be reflected in the activity answer. */
export const STOP_TIMEOUT_MS = 5_000

/** How often the activity question is asked while waiting. */
export const STOP_POLL_MS = 100

/** One bounded wait's knobs; the host uses the constants above. */
export interface StopWaitOptions {
  /** Wall-clock budget for the whole wait. */
  readonly timeoutMs: number
  /** Delay between two activity reads. */
  readonly pollMs: number
  /** Clock, injectable so a test does not have to wait real time. */
  readonly now?: () => number
  /** Sleeper, injectable for the same reason. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** The wait that runs after the stop requests were issued. */
export type StopOutcome =
  /** Nothing is running for any of the ids any more: the caller may proceed. */
  | { readonly kind: 'settled' }
  /** The budget ran out with work still reported: nothing may move. */
  | { readonly kind: 'still-running'; readonly ids: readonly string[] }
  /** The stop dispatch itself failed: nothing may move, and the cause is kept. */
  | { readonly kind: 'stop-failed'; readonly detail: string }

/** Default sleeper: one timer, never a busy loop. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Unwrap a rejection from a parallel event dispatch.
 *
 * `ctx.parallel` rejects with an `AggregateError` carrying every listener
 * failure; a single listener's failure reaches the caller wrapped, and reporting
 * "stopping failed" without the listeners' own messages is what makes a stop
 * failure impossible to diagnose.
 * @param error - whatever the stop dispatch rejected with.
 * @returns an English diagnostic naming each failure's message.
 */
function stopFailureDetail(error: unknown): string {
  const errors = error instanceof AggregateError ? error.errors : [error]
  const messages = errors.map((failure) => (failure instanceof Error ? failure.message : String(failure)))
  return messages.length === 0 ? String(error) : messages.join('; ')
}

/**
 * Request a stop for every id, then wait until the activity seam answers empty.
 *
 * The stops are issued CONCURRENTLY — they are independent cancellations, and
 * awaiting them one at a time would multiply the caller's wait by the tree size —
 * and every failure is collected before deciding, so a partial stop is reported as
 * a stop failure rather than as a partly-stopped session.
 * @param input.ids - ids a caller already found active (never the whole tree: an
 *   idle member has nothing to stop).
 * @param input.activity - the `workspace/session-activity` answer for one id.
 * @param input.stop - the `workspace/session-stop` dispatch for one id; undefined
 *   when the host exposes no such seam, which is a stop failure and not a pass.
 * @param input.wait - the bound and its clock.
 * @returns settled, still running (with the ids), or the stop failure.
 */
export async function stopAndWait(input: {
  ids: readonly string[]
  activity: (id: string) => Promise<readonly unknown[]>
  stop: ((id: string) => Promise<void>) | undefined
  wait: StopWaitOptions
}): Promise<StopOutcome> {
  if (input.ids.length === 0) return { kind: 'settled' }
  if (input.stop === undefined) {
    return { kind: 'stop-failed', detail: 'this host exposes no workspace/session-stop seam, so no session could be stopped' }
  }
  const stop = input.stop
  const settled = await Promise.allSettled(input.ids.map(async (id) => stop(id)))
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) {
    const errors = failures.map((failure) => failure.reason)
    return {
      kind: 'stop-failed',
      detail: failures.length === 1
        ? stopFailureDetail(errors[0])
        : errors.map((error) => stopFailureDetail(error)).join('; '),
    }
  }

  const now = input.wait.now ?? Date.now
  const sleep = input.wait.sleep ?? defaultSleep
  const pollMs = Math.max(1, Math.floor(input.wait.pollMs))
  const deadline = now() + Math.max(0, input.wait.timeoutMs)
  for (;;) {
    const active: string[] = []
    for (const id of input.ids) {
      try {
        if ((await input.activity(id)).length > 0) active.push(id)
      } catch {
        // A seam that throws is not "idle": it is "cannot tell". Such an id stays
        // in the active set, so the loop times out instead of proceeding.
        active.push(id)
      }
    }
    if (active.length === 0) return { kind: 'settled' }
    const remaining = deadline - now()
    if (remaining <= 0) return { kind: 'still-running', ids: active }
    await sleep(Math.min(pollMs, remaining))
  }
}
