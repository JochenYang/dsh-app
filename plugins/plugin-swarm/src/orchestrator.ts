/**
 * Batch orchestration for the swarm tool: expands one prompt template over an
 * item list, runs the resulting child-agent tasks through a bounded worker
 * pool with launch pacing, and aggregates per-item terminal outcomes into a
 * single result.
 *
 * Two execution backends behind one scheduling and aggregation core:
 *
 *  - Continuable children (preferred, when the configured provider declares
 *    `prepareContinuable`): each task starts a durable continuable child via
 *    `ctx.subagents.startContinuable()` — or resumes a prior child through
 *    `followup()`, which cold-loads its persisted session so a failed item
 *    continues with its prior context instead of restarting from scratch.
 *    Continuable children expose no awaitable result, so settlement is
 *    observed through the runtime's `subagent/end` lifecycle event, which
 *    carries the terminal stop reason and the epoch's final assistant output.
 *  - One-shot runs (fallback for providers without continuable support):
 *    `ctx.subagents.start()` + `run.result`, the classic delegation path.
 *    One-shot children are not resumable.
 *
 * Children run through the host's `ctx.subagents` seam either way, so
 * workspace, permissions, and session lineage all follow the platform's own
 * delegation semantics. This module owns only scheduling and aggregation:
 * a per-item failure never cancels its siblings, while the caller's abort
 * signal cancels everything still in flight.
 *
 * @module @dsh-app/plugin-swarm/orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/** Terminal state of one swarm item, mirroring the batch-level vocabulary. */
export type SwarmItemStatus = 'completed' | 'failed' | 'aborted'

/**
 * Why a failed item failed. Only `transport` feeds adaptive scheduling and
 * automatic retry: it names provider/network conditions the batch can outlast.
 * `content` names the task itself (refusal, token ceiling, model-side error) —
 * throttling the pool for it would punish healthy children. `structural` names
 * an unsound call (launch rejection, capability violation) — retrying the same
 * call fails identically.
 */
export type SwarmFailureKind = 'transport' | 'content' | 'structural'

/**
 * Provider-neutral failure codes that name transient transport conditions
 * (from dsh-llm's canonical taxonomy; `EMPTY_RESPONSE` is included because the
 * kernel's own retry policy treats a degenerate completion as safe to repeat).
 * QUOTA throttles like transport (the account is the bottleneck, not any
 * single child) but is excluded from auto-retry: the kernel's own retry
 * policy treats it as terminal, so a follow-up would fail identically.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'TRANSPORT',
  'TIMEOUT',
  'SERVER',
  'EMPTY_RESPONSE',
  'QUOTA',
])

/** Transport codes whose failure is worth an automatic retry; QUOTA is terminal. */
const RETRYABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'TRANSPORT',
  'TIMEOUT',
  'SERVER',
  'EMPTY_RESPONSE',
])

/** One item's aggregated outcome. */
export interface SwarmItemOutcome {
  readonly index: number
  readonly item: string
  readonly status: SwarmItemStatus
  /** Final child text (already truncated to the configured limit). */
  readonly output?: string
  /** Failure detail for a non-completed, non-aborted item. */
  readonly error?: string
  /** Failure class for a failed item; decides throttle and retry handling. */
  readonly failureKind?: SwarmFailureKind
  /**
   * The child turn's provider-neutral failure code (dsh-llm taxonomy, e.g.
   * RATE_LIMIT), when recoverable from the child session's `turn/end` event.
   */
  readonly failureCode?: string
  /** Wall time of the item's final attempt in ms, launch pacing included. */
  readonly durationMs?: number
  /**
   * Token accounting summed from the child session's `assistant/message`
   * usage records for this batch's epoch(s); absent when the child's session
   * was not readable or the adapter reported none.
   */
  readonly usage?: TokenUsage
  /**
   * Durable child session id. Present on the continuable backend: pass it
   * back through a later batch's resume entry to continue that child with
   * its full prior context.
   */
  readonly childId?: string
  /** Automatic retries the item consumed before settling (absent when 0). */
  readonly retries?: number
}

/** The whole batch's aggregated outcome. */
export interface SwarmBatchOutcome {
  readonly label: string
  readonly concurrency: number
  /**
   * Highest simultaneous live children actually observed. Present only on
   * adaptive batches, where the live pool may differ from the requested
   * steady-state size.
   */
  readonly peakConcurrency?: number
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly aborted: number
  /** Whole-batch wall time in ms. */
  readonly durationMs: number
  /**
   * True when the batch stopped launching work because the token budget ran
   * out; unstarted items and pending retries are reported aborted.
   */
  readonly budgetExhausted?: boolean
  /** Batch-wide token accounting summed over item-level usage. */
  readonly usage?: TokenUsage
  readonly items: readonly SwarmItemOutcome[]
}

/** One expanded task: the display item and the child prompt to run it. */
export interface SwarmTask {
  readonly index: number
  /** Display text for the outcome row (fresh: the item; resume: prompt preview). */
  readonly item: string
  /** Child prompt (fresh: expanded template; resume: the follow-up message). */
  readonly prompt: string
  /** Present when this task continues a prior child instead of starting a fresh one. */
  readonly resumeChildId?: string
}

/** Scheduling and delegation parameters for one batch. */
export interface SwarmBatchOptions {
  /** `ctx.subagents` provider name (e.g. `spawn`). */
  readonly provider: string
  /** The delegating parent agent. */
  readonly parent: Agent
  /** Cancellation signal owned by the tool execution. */
  readonly signal: AbortSignal
  /** Short batch label reused as each child's display label prefix. */
  readonly label: string
  /** Expanded tasks, ordered by their original item index. */
  readonly tasks: readonly SwarmTask[]
  /** Requested steady-state worker-pool size (already clamped by the caller). */
  readonly concurrency: number
  /**
   * Adaptive-scheduling ceiling: when `adaptive` is on and the model did not
   * pin a pool size, the live pool may grow back toward this limit after
   * failures. Defaults to `concurrency` (no growth room).
   */
  readonly maxConcurrency?: number
  /** Whether the live pool adapts to observed item failures/completions. */
  readonly adaptive?: boolean
  /** Per-item output truncation limit in UTF-16 code units. */
  readonly outputLimit: number
  /** Minimum delay between consecutive child STARTS in ms (0 disables pacing). */
  readonly startStaggerMs: number
  /**
   * Automatic per-item retries after an error settle (continuable backend
   * only: the child is followed up with a recovery instruction, so the retry
   * continues from its preserved context). 0 disables; default 0.
   */
  readonly itemMaxRetries?: number
  /** Base backoff before the first item retry, doubling per attempt (ms). */
  readonly itemRetryDelayMs?: number
  /** Optional child model routing. */
  readonly agentOptions?: AgentOptions
  /**
   * Optional per-child tool scoping (the seam's ToolRestriction, applied at
   * child creation on BOTH backends). Read-only batches (analysis, review,
   * lookups) should pass an allow-list — a batch of full-tool children can
   * otherwise write files the parent never audits.
   */
  readonly toolFilter?: ToolRestriction
  /** Optional delegation-depth cap for each child. */
  readonly maxDepth?: number
  /**
   * Batch token budget: once the summed usage of settled children reaches
   * this, no further work is launched (in-flight children settle normally;
   * unstarted items and pending retries report aborted). Undefined or 0
   * disables. Usage is absent when a child's session is unreadable, so the
   * budget is best-effort, never an exact accounting.
   */
  readonly tokenBudget?: number
}

/** Join a child result's text blocks into one string. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** The structured failure record recovered from a child session's `turn/end`. */
interface ChildTurnFailure {
  readonly message: string
  readonly code?: string
}

/**
 * Minimal structural slice of a child session's event log. `Session.events`
 * is not part of the public type surface in rc.1 — read it through the same
 * structural cast the memory plugin uses for its SessionLike slice (the
 * runtime object does carry the event log).
 */
interface ChildSessionSlice {
  readonly events: ReadonlyArray<{ type: string, data: unknown }>
}

/**
 * Recover the child's own failure record from its session log. A child whose
 * turn ended in `error` carries the full provider failure in its `turn/end`
 * event, while the seam's result surface only says `stopReason: 'error'`
 * with no diagnostic — surfacing the real message is what makes a failed
 * batch actionable instead of a bare "run failed".
 */
function childTurnFailure(session: ChildSessionSlice | undefined): ChildTurnFailure | undefined {
  const events = session?.events
  if (events === undefined) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: string; error?: { message?: string; code?: string } } }).reason
    if (reason?.kind === 'error' && reason.error !== undefined) {
      return { message: reason.error.message ?? 'unknown error', ...(reason.error.code === undefined ? {} : { code: reason.error.code }) }
    }
    return undefined
  }
  return undefined
}

/**
 * Sum the token accounting of a child session's `assistant/message` events.
 * `watermark` excludes epochs a previous batch already accounted (a resumed
 * child's log accumulates across batches); pass 0 when the session was not
 * readable at launch.
 */
function childUsage(session: ChildSessionSlice | undefined, watermark: number): TokenUsage | undefined {
  const events = session?.events
  if (events === undefined) return undefined
  let input = 0
  let output = 0
  let total = 0
  let seen = false
  for (let i = watermark; i < events.length; i++) {
    const event = events[i]
    if (event.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: TokenUsage }).usage
    if (usage === undefined) continue
    seen = true
    input += usage.inputTokens
    output += usage.outputTokens
    total += usage.totalTokens ?? usage.inputTokens + usage.outputTokens
  }
  return seen ? { inputTokens: input, outputTokens: output, totalTokens: total } : undefined
}

/** Total token count of one usage record (provider total preferred). */
function usageTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens
}

/**
 * Resolve a live child agent's session slice. Returns undefined when the
 * child already cold-unloaded (a settled continuable child may leave the
 * in-process registry); callers degrade to "no detail, no accounting".
 */
function liveChildSession(ctx: Context, childId: string): ChildSessionSlice | undefined {
  const agent = ctx.agents.get(SessionId(childId))
  if (agent === undefined) return undefined
  return agent.session as unknown as ChildSessionSlice | undefined
}

/** Classify a settled failure: only transport feeds throttling and retry. */
function classifySettle(stopReason: SubagentResult['stopReason'], code: string | undefined): SwarmFailureKind {
  if (code !== undefined) {
    return TRANSPORT_FAILURE_CODES.has(code) ? 'transport' : 'content'
  }
  // No code recoverable: `max-tokens`/`refusal` are content by definition; a
  // bare `error` keeps the legacy assumption (treat as transient transport)
  // so a session we cannot read degrades to the pre-classification behavior.
  return stopReason === 'error' ? 'transport' : 'content'
}

/** Classify a launch-phase rejection (start/sendMessage threw). */
function classifyLaunchError(error: unknown): SwarmFailureKind {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && TRANSPORT_FAILURE_CODES.has(code)) return 'transport'
  return 'structural'
}

/** Whether a failed outcome qualifies for the automatic retry lane. */
function isRetryable(outcome: SwarmItemOutcome): boolean {
  return outcome.failureKind === 'transport'
    && (outcome.failureCode === undefined || RETRYABLE_FAILURE_CODES.has(outcome.failureCode))
}

/** Render a non-completed one-shot stop reason with every failure detail available. */
function failureDetail(result: SubagentResult, session: ChildSessionSlice | undefined): string {
  const parts = [`stop reason: ${String(result.stopReason)}`]
  if (result.diagnostic !== undefined) parts.push(`diagnostic: ${result.diagnostic}`)
  const failure = childTurnFailure(session)
  if (failure !== undefined) {
    parts.push(`error: ${failure.message}${failure.code === undefined ? '' : ` [${failure.code}]`}`)
  }
  const partial = textOf(result.output)
  if (partial.length > 0) parts.push(`partial output: ${partial.slice(0, 400)}`)
  return parts.join('; ')
}

/** Render a non-completed continuable terminal with every failure detail available. */
function continuableFailure(stopReason: SubagentResult['stopReason'], output: readonly ContentBlock[] | undefined, failure: ChildTurnFailure | undefined): string {
  const parts = [`stop reason: ${String(stopReason)}`]
  if (failure !== undefined) {
    parts.push(`error: ${failure.message}${failure.code === undefined ? '' : ` [${failure.code}]`}`)
  }
  const partial = output === undefined ? '' : textOf(output)
  if (partial.length > 0) parts.push(`partial output: ${partial.slice(0, 400)}`)
  return parts.join('; ')
}

/**
 * Truncate one item's output to the configured limit, marking the cut so the
 * model knows the text was shortened rather than silently losing the tail.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} characters]`
}

/** A child label: batch label plus a bounded item preview, for display surfaces. */
function childLabel(label: string, item: string): string {
  const preview = item.length > 60 ? `${item.slice(0, 57)}...` : item
  return `${label}: ${preview}`
}

/** Sleep that an aborted signal cuts short. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Launch pacing: consecutive child starts are spaced at least `staggerMs`
 * apart no matter which worker starts them. Unlike an absolute index-based
 * offset, a worker that becomes free early waits only for the next open
 * slot — a late task is never penalized by its position in the batch.
 *
 * The interval is adjustable at runtime: adaptive scheduling stretches it
 * after item failures and eases it back as the pool recovers.
 */
class LaunchClock {
  private nextAt = 0
  private staggerMs: number

  constructor(readonly baseStaggerMs: number) {
    this.staggerMs = baseStaggerMs
  }

  get stagger(): number {
    return this.staggerMs
  }

  setStagger(ms: number): void {
    this.staggerMs = ms
  }

  /**
   * Reserve the next launch slot and wait until it opens. The slot is
   * claimed synchronously, so concurrent workers always get distinct slots.
   * @returns whether the launch may proceed (false when the batch aborted).
   */
  async waitTurn(signal: AbortSignal): Promise<boolean> {
    if (this.staggerMs <= 0) return !signal.aborted
    const now = Date.now()
    const at = Math.max(now, this.nextAt)
    this.nextAt = at + this.staggerMs
    if (at > now) await delay(at - now, signal)
    return !signal.aborted
  }
}

/** Completed items between adaptive pool growth steps. */
const ADAPTIVE_GROW_STREAK = 4

/** Ceiling for the adaptive launch-stretch backoff. */
const ADAPTIVE_STAGGER_CAP_MS = 30_000

/**
 * Follow-up message that revives an error-settled child for an automatic
 * retry. The child's session is intact, so this tells it to resume from the
 * interruption point instead of redoing finished work.
 */
const RETRY_PROMPT
  = 'Your previous turn ended with a transient error (most likely a network or provider interruption). '
  + 'Continue the task from where you left off and complete it. Do not restart from scratch.'

/** How often an idle worker re-checks for due retries or batch drain. */
const WORKER_IDLE_POLL_MS = 250

/**
 * Live-concurrency throttle for adaptive batches. Workers block in
 * `acquire()` while the number of in-flight children is at the current
 * limit; every item settlement feeds back:
 *
 *   - failed  → the limit halves (floor 1) immediately, so one gateway
 *     meltdown does not take down the whole pool;
 *   - completed → after a streak of clean completions the limit grows by
 *     one toward the ceiling, so a healthy batch recovers lost throughput.
 *
 * Disabled (static batches) the limit is pinned to the requested size and
 * feedback is a no-op, which is exactly the legacy behavior.
 */
export class AdaptiveGate {
  private active = 0
  private streak = 0
  private limit: number
  private peakActive = 0
  private readonly waiters = new Set<() => void>()

  constructor(
    requestedLimit: number,
    private readonly ceiling: number,
    private readonly enabled: boolean,
  ) {
    this.limit = Math.max(1, Math.min(requestedLimit, ceiling))
  }

  /** Highest simultaneous in-flight children observed so far. */
  get peak(): number {
    return this.peakActive
  }

  /** Children currently in flight (claimed but not yet settled). */
  get activeCount(): number {
    return this.active
  }

  /**
   * Wait for a launch slot under the current limit.
   * @returns whether the launch may proceed (false when the batch aborted).
   */
  async acquire(signal: AbortSignal): Promise<boolean> {
    while (this.active >= this.limit) {
      if (signal.aborted) return false
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.waiters.delete(done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        this.waiters.add(done)
        signal.addEventListener('abort', done, { once: true })
      })
      if (signal.aborted) return false
    }
    this.active += 1
    this.peakActive = Math.max(this.peakActive, this.active)
    return true
  }

  /** Free one launch slot and wake a waiting worker, if any. */
  release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.values().next()
    if (!next.done) next.value()
  }

  /**
   * Feed one item settlement back into the limit.
   * @returns the adjustment made (`shrunk`/`grew`) so the caller can steer
   *   launch pacing in step, or undefined when nothing changed.
   */
  noteSettled(status: SwarmItemStatus): 'shrunk' | 'grew' | undefined {
    if (!this.enabled) return undefined
    if (status === 'failed') {
      this.streak = 0
      const shrunken = Math.max(1, Math.floor(this.limit / 2))
      if (shrunken < this.limit) {
        this.limit = shrunken
        return 'shrunk'
      }
      return undefined
    }
    if (status === 'completed') {
      this.streak += 1
      if (this.streak >= ADAPTIVE_GROW_STREAK && this.limit < this.ceiling) {
        this.limit += 1
        this.streak = 0
        return 'grew'
      }
    }
    return undefined
  }
}

/** Terminal record reconstructed from one `subagent/end` lifecycle event. */
interface ContinuableTerminal {
  readonly stopReason: SubagentResult['stopReason']
  readonly output?: readonly ContentBlock[]
}

/** Batch-scoped settlement observation over the `subagent/end` lifecycle event. */
interface SettlementWatch {
  /** Await one child's next settlement (resolves immediately if already settled). */
  wait(childId: string): Promise<ContinuableTerminal>
  /** Release the listener and the abort hook once the batch drained. */
  dispose(): void
}

/**
 * Observe continuable children settling through `subagent/end`. One listener
 * feeds the whole batch: a settle with no registered waiter is recorded
 * (keyed by child id) so a child that settles in the gap between its launch
 * resolving and the caller registering the wait is still found; a settle with
 * a waiter resolves it directly. Each terminal is consumed exactly once —
 * a retried child's second epoch waits for its own `subagent/end`, never
 * observes the first epoch's terminal.
 *
 * On batch abort every tracked child is interrupted (best-effort stop) and
 * every pending waiter is released immediately — the batch terminates on its
 * own signal, never on interrupt timing.
 */
function watchSettlements(ctx: Context, parent: Agent, signal: AbortSignal): SettlementWatch {
  const terminals = new Map<string, ContinuableTerminal>()
  const waiters = new Map<string, ((terminal: ContinuableTerminal) => void)>()
  const tracked = new Set<string>()
  const offListener = ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    const terminal: ContinuableTerminal = {
      stopReason: info.stopReason,
      ...info.lastAssistantMessage === undefined ? {} : { output: info.lastAssistantMessage },
    }
    const resolve = waiters.get(String(info.id))
    if (resolve !== undefined) {
      // A waiter takes the terminal directly; storing it too would hand this
      // epoch's settle to the NEXT wait on the same child (a retry epoch must
      // never observe its predecessor's terminal).
      waiters.delete(String(info.id))
      resolve(terminal)
    } else {
      // No waiter yet (the settle raced ahead of the launch resolution):
      // record it so the first wait on this child finds it.
      terminals.set(String(info.id), terminal)
    }
  })
  const onAbort = (): void => {
    for (const childId of tracked) {
      // Best-effort stop of the child's current turn; settled or absent
      // targets are an accepted no-op.
      ctx.subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: parent })
    }
    const aborted: ContinuableTerminal = { stopReason: 'aborted' }
    for (const resolve of waiters.values()) resolve(aborted)
    waiters.clear()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    wait(childId: string): Promise<ContinuableTerminal> {
      tracked.add(childId)
      const prior = terminals.get(childId)
      if (prior !== undefined) {
        // Consume-on-read: each terminal belongs to exactly one epoch's wait,
        // so a retry epoch on the same child never sees its predecessor's.
        terminals.delete(childId)
        return Promise.resolve(prior)
      }
      return new Promise((resolve) => { waiters.set(childId, resolve) })
    },
    dispose(): void {
      offListener()
      signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Run one task as a continuable child and settle it into an outcome. Fresh
 * tasks start a new durable child; resume tasks deliver a follow-up to an
 * existing one (cold-resuming its persisted session). Never throws: every
 * failure path lands in the item's status.
 *
 * Metrics: the attempt's wall time always lands on the outcome; failure
 * records and token usage are recovered from the child session's event log
 * when it is still live (a settled child may cold-unload — the outcome then
 * carries neither).
 */
async function runContinuableTask(
  ctx: Context,
  options: SwarmBatchOptions,
  watch: SettlementWatch,
  clock: LaunchClock,
  task: SwarmTask,
): Promise<SwarmItemOutcome> {
  const startedAt = Date.now()
  try {
    // Pace child starts so a batch does not hit a rate-limited account as
    // one instantaneous burst.
    if (!(await clock.waitTurn(options.signal))) {
      return { index: task.index, item: task.item, status: 'aborted' }
    }
    let childId: string
    // Resume watermark: events before this batch's follow-up belong to epochs
    // a previous batch already accounted. Read it AFTER sendMessage resolves —
    // cold-resuming loads the persisted session, so the log is live by then
    // (the accepted follow-up appends no usage events yet). A still-unreadable
    // session falls back to 0, overcounting prior epochs — documented
    // best-effort. Fresh children always start from 0.
    let watermark = 0
    if (task.resumeChildId !== undefined) {
      // rc.1 renamed followup → sendMessage (and dropped the explicit source
      // option: the coordinator-relay provenance is now implicit to the seam).
      await ctx.subagents.sendMessage(
        options.parent,
        SessionId(task.resumeChildId),
        [{ type: 'text', text: task.prompt }],
        { signal: options.signal },
      )
      childId = task.resumeChildId
      watermark = liveChildSession(ctx, childId)?.events.length ?? 0
    } else {
      const started = await ctx.subagents.startContinuable({
        provider: options.provider,
        label: childLabel(options.label, task.item),
        request: {
          prompt: [{ type: 'text', text: task.prompt }],
          parent: options.parent,
          ...options.agentOptions !== undefined ? { agentOptions: options.agentOptions } : {},
          ...options.toolFilter !== undefined ? { toolFilter: options.toolFilter } : {},
          ...options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {},
        },
        signal: options.signal,
      })
      childId = String(started.childId)
    }
    if (options.signal.aborted) {
      // The launch raced the batch abort and won: the abort sweep only knows
      // children it had already tracked, so stop this one directly.
      ctx.subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: options.parent })
      return { index: task.index, item: task.item, status: 'aborted', childId, durationMs: Date.now() - startedAt }
    }
    const terminal = await watch.wait(childId)
    const session = liveChildSession(ctx, childId)
    const usage = childUsage(session, watermark)
    const durationMs = Date.now() - startedAt
    const metrics = { childId, durationMs, ...usage === undefined ? {} : { usage } }
    if (terminal.stopReason === 'completed') {
      return {
        index: task.index,
        item: task.item,
        status: 'completed',
        ...metrics,
        output: truncate(textOf(terminal.output ?? []), options.outputLimit),
      }
    }
    if (terminal.stopReason === 'aborted') {
      return { index: task.index, item: task.item, status: 'aborted', ...metrics }
    }
    const failure = childTurnFailure(session)
    return {
      index: task.index,
      item: task.item,
      status: 'failed',
      ...metrics,
      failureKind: classifySettle(terminal.stopReason, failure?.code),
      ...failure?.code === undefined ? {} : { failureCode: failure.code },
      error: continuableFailure(terminal.stopReason, terminal.output, failure),
    }
  } catch (error: unknown) {
    // A launch rejection under an aborted signal is batch cancellation, not an
    // item failure; everything else is attributed to this item alone.
    const aborted = options.signal.aborted
    const code = (error as { code?: unknown }).code
    return {
      index: task.index,
      item: task.item,
      status: aborted ? 'aborted' : 'failed',
      durationMs: Date.now() - startedAt,
      ...aborted ? {} : {
        error: error instanceof Error ? error.message : String(error),
        failureKind: classifyLaunchError(error),
        ...typeof code === 'string' ? { failureCode: code } : {},
      },
      ...task.resumeChildId !== undefined ? { childId: task.resumeChildId } : {},
    }
  }
}

/**
 * Run one expanded task as a one-shot child and settle it into an outcome.
 * Never throws: every failure path — start rejection, infrastructure fault,
 * non-completed stop reason, disposal failure — lands in the item's status.
 */
async function runOneShotTask(
  ctx: Context,
  options: SwarmBatchOptions,
  clock: LaunchClock,
  task: SwarmTask,
): Promise<SwarmItemOutcome> {
  const startedAt = Date.now()
  let run: SubagentRun | undefined
  try {
    if (task.resumeChildId !== undefined) {
      // Only reachable when the provider lost continuable support between the
      // tool's preflight and the batch: refuse rather than silently restart.
      return {
        index: task.index,
        item: task.item,
        status: 'failed',
        failureKind: 'structural',
        error: 'resume entry cannot run: the provider no longer supports continuable children',
      }
    }
    if (!(await clock.waitTurn(options.signal))) {
      return { index: task.index, item: task.item, status: 'aborted' }
    }
    run = await ctx.subagents.start(options.provider, {
      label: childLabel(options.label, task.item),
      prompt: [{ type: 'text', text: task.prompt }],
      parent: options.parent,
      signal: options.signal,
      ...options.agentOptions !== undefined ? { agentOptions: options.agentOptions } : {},
      ...options.toolFilter !== undefined ? { toolFilter: options.toolFilter } : {},
      ...options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {},
    })
    const result = await run.result
    const session = run.localAgent?.session as unknown as ChildSessionSlice | undefined
    const usage = childUsage(session, 0)
    const durationMs = Date.now() - startedAt
    const metrics = { durationMs, ...usage === undefined ? {} : { usage } }
    if (result.stopReason === 'completed') {
      return { index: task.index, item: task.item, status: 'completed', ...metrics, output: truncate(textOf(result.output), options.outputLimit) }
    }
    if (result.stopReason === 'aborted') {
      return { index: task.index, item: task.item, status: 'aborted', ...metrics }
    }
    const failure = childTurnFailure(session)
    return {
      index: task.index,
      item: task.item,
      status: 'failed',
      ...metrics,
      failureKind: classifySettle(result.stopReason, failure?.code),
      ...failure?.code === undefined ? {} : { failureCode: failure.code },
      error: failureDetail(result, session),
    }
  } catch (error: unknown) {
    // A start rejection under an aborted signal is batch cancellation, not an
    // item failure; everything else is attributed to this item alone.
    const aborted = options.signal.aborted
    const code = (error as { code?: unknown }).code
    return {
      index: task.index,
      item: task.item,
      status: aborted ? 'aborted' : 'failed',
      durationMs: Date.now() - startedAt,
      ...aborted ? {} : {
        error: error instanceof Error ? error.message : String(error),
        failureKind: classifyLaunchError(error),
        ...typeof code === 'string' ? { failureCode: code } : {},
      },
    }
  } finally {
    if (run !== undefined) {
      try {
        await run.dispose()
      } catch (error: unknown) {
        // Disposal failure must not flip an already-settled item outcome; the
        // child's terminal result stays authoritative for the batch report.
        ctx.logger.warn(`swarm item ${task.index} (${task.item}): dispose failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * Execute the whole batch through a bounded worker pool. Workers pull task
 * indices from a shared cursor, so a slow child delays only its own worker;
 * the pool drains without head-of-line blocking. Items never started before
 * an abort are reported as `aborted` so the result array is always complete.
 *
 * Adaptive batches run `maxConcurrency` workers behind the gate (the gate,
 * not the worker count, bounds live children), so pool growth after failures
 * needs no new workers — a waiting one is woken immediately. Static batches
 * keep the legacy shape: worker count equals the requested pool size and the
 * gate never blocks.
 *
 * On the continuable backend, error-settled items enter a retry queue
 * instead of failing the batch outright: after an exponential backoff the
 * child is followed up with a recovery instruction, continuing from its
 * preserved session context. Provider-level request retries absorb sub-minute
 * gateway hiccups; this turn-level lane absorbs the longer outages that
 * exhaust them, so a flaky provider degrades throughput instead of eating
 * items. A worker only exits when fresh tasks, due retries, and in-flight
 * children are all exhausted.
 */
export async function runSwarmBatch(ctx: Context, options: SwarmBatchOptions): Promise<SwarmBatchOutcome> {
  const batchStartedAt = Date.now()
  const provider = ctx.subagents.getProvider(options.provider)
  const continuable = provider?.prepareContinuable !== undefined
  const watch = continuable ? watchSettlements(ctx, options.parent, options.signal) : undefined
  const outcomes: (SwarmItemOutcome | undefined)[] = new Array(options.tasks.length)
  const clock = new LaunchClock(options.startStaggerMs)
  const adaptive = options.adaptive === true
  const ceiling = adaptive
    ? Math.max(options.concurrency, options.maxConcurrency ?? options.concurrency)
    : options.concurrency
  const gate = new AdaptiveGate(options.concurrency, ceiling, adaptive)
  const maxRetries = Math.max(0, options.itemMaxRetries ?? 0)
  const retryDelayMs = Math.max(0, options.itemRetryDelayMs ?? 15_000)
  const tokenBudget = Math.max(0, options.tokenBudget ?? 0)
  let budgetStop = false
  let usageSeen = false
  let batchInput = 0
  let batchOutput = 0
  let batchTotal = 0
  let cursor = 0
  interface RetryEntry {
    readonly task: SwarmTask
    readonly retries: number
    readonly notBefore: number
  }
  const retryQueue: RetryEntry[] = []

  /**
   * Fold one settled item's accounting into the batch totals and trip the
   * budget stop when the configured token budget is exhausted.
   */
  const accountUsage = (outcome: SwarmItemOutcome): void => {
    if (outcome.usage === undefined) return
    usageSeen = true
    batchInput += outcome.usage.inputTokens
    batchOutput += outcome.usage.outputTokens
    batchTotal += usageTotal(outcome.usage)
    if (tokenBudget > 0 && batchTotal >= tokenBudget && !budgetStop) {
      budgetStop = true
      // Pending retries would spend further tokens on items the budget can no
      // longer finish; their items report aborted with the budget note.
      for (const entry of retryQueue.splice(0)) {
        outcomes[entry.task.index] = {
          index: entry.task.index,
          item: entry.task.item,
          status: 'aborted',
          error: 'batch token budget exhausted during retry backoff',
          // Keep the resume handle: the child session survives, so a later
          // resume_entries call can finish the item once budget allows.
          ...entry.task.resumeChildId === undefined ? {} : { childId: entry.task.resumeChildId },
        }
      }
    }
  }

  /**
   * Claim the next runnable unit. Due retries outrank fresh tasks (they hold
   * batch slots open); a fresh task is taken only when no retry is due, so a
   * long backoff never blocks new work. A tripped token budget stops both
   * lanes: launching more work would spend tokens the budget no longer has.
   */
  const claim = (): { task: SwarmTask, retries: number } | 'wait' | 'done' => {
    if (!budgetStop) {
      const now = Date.now()
      const dueIndex = retryQueue.findIndex(entry => entry.notBefore <= now)
      if (dueIndex >= 0) {
        const [entry] = retryQueue.splice(dueIndex, 1)
        return { task: entry.task, retries: entry.retries }
      }
      if (cursor < options.tasks.length) {
        const task = options.tasks[cursor]
        cursor += 1
        return { task, retries: 0 }
      }
    }
    // No fresh work and nothing due: drain only when nothing can produce more.
    if (retryQueue.length === 0 && gate.activeCount === 0) return 'done'
    return 'wait'
  }

  const worker = async (): Promise<void> => {
    while (!options.signal.aborted) {
      const claimed = claim()
      if (claimed === 'done') return
      if (claimed === 'wait') {
        await delay(WORKER_IDLE_POLL_MS, options.signal)
        continue
      }
      const { task, retries } = claimed
      if (!(await gate.acquire(options.signal))) {
        // Aborted while queued for a slot: the task never started.
        outcomes[task.index] = { index: task.index, item: task.item, status: 'aborted' }
        return
      }
      if (budgetStop) {
        // The budget tripped while this task waited for a gate slot: it was
        // claimed before the trip but must not launch. Covers fresh claims
        // AND retries already dequeued before accountUsage reaped the queue.
        gate.release()
        outcomes[task.index] = {
          index: task.index,
          item: task.item,
          status: 'aborted',
          error: 'batch token budget exhausted before this item started',
          ...task.resumeChildId === undefined ? {} : { childId: task.resumeChildId },
        }
        continue
      }
      let outcome: SwarmItemOutcome
      try {
        outcome = watch !== undefined
          ? await runContinuableTask(ctx, options, watch, clock, task)
          : await runOneShotTask(ctx, options, clock, task)
      } finally {
        gate.release()
      }
      accountUsage(outcome)
      // An error-settled continuable child is a retry candidate: its session
      // survives the error, so a follow-up continues from where it stopped.
      // Only retryable transport failures qualify — retrying a content
      // failure (refusal, token ceiling, model-side error) or a terminal
      // QUOTA failure replays the same deterministic loss, and retrying into
      // an exhausted budget just burns the retry lane.
      const retryable = outcome.status === 'failed'
        && isRetryable(outcome)
        && watch !== undefined
        && outcome.childId !== undefined
        && retries < maxRetries
        && !budgetStop
      if (retryable) {
        retryQueue.push({
          task: { ...task, resumeChildId: outcome.childId!, prompt: RETRY_PROMPT },
          retries: retries + 1,
          notBefore: Date.now() + retryDelayMs * 2 ** retries,
        })
        // The transport failure still throttles the batch even though the item
        // will be retried: whatever killed the turn was real load feedback.
        const adjustment = gate.noteSettled('failed')
        if (adjustment === 'shrunk') {
          clock.setStagger(Math.min(clock.stagger * 2, ADAPTIVE_STAGGER_CAP_MS))
        }
        continue
      }
      outcomes[task.index] = retries > 0 ? { ...outcome, retries } : outcome
      // Steer launch pacing in step with any pool adjustment: TRANSPORT
      // failures stretch the start interval (eased back on growth), so a
      // struggling gateway gets proportionally gentler traffic, not just fewer
      // streams. Content and structural failures say nothing about gateway
      // health and feed back as plain settlements.
      const adjustment = outcome.status === 'failed' && outcome.failureKind !== 'transport'
        ? undefined
        : gate.noteSettled(outcome.status)
      if (adjustment === 'shrunk') {
        clock.setStagger(Math.min(clock.stagger * 2, ADAPTIVE_STAGGER_CAP_MS))
      } else if (adjustment === 'grew') {
        clock.setStagger(Math.max(clock.baseStaggerMs, Math.floor(clock.stagger / 2)))
      }
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(ceiling, options.tasks.length)) },
    () => worker(),
  )
  try {
    await Promise.all(workers)
  } finally {
    watch?.dispose()
  }

  const items: SwarmItemOutcome[] = options.tasks.map((task) => {
    const outcome = outcomes[task.index]
    // An absent entry means the pool exited (abort or budget stop) before this
    // task started or while a retry was still pending.
    if (outcome !== undefined) return outcome
    return budgetStop && !options.signal.aborted
      ? { index: task.index, item: task.item, status: 'aborted', error: 'batch token budget exhausted before this item started' }
      : { index: task.index, item: task.item, status: 'aborted' }
  })
  return {
    label: options.label,
    concurrency: options.concurrency,
    ...adaptive ? { peakConcurrency: gate.peak } : {},
    total: items.length,
    completed: items.filter(item => item.status === 'completed').length,
    failed: items.filter(item => item.status === 'failed').length,
    aborted: items.filter(item => item.status === 'aborted').length,
    durationMs: Date.now() - batchStartedAt,
    ...budgetStop ? { budgetExhausted: true } : {},
    ...usageSeen ? { usage: { inputTokens: batchInput, outputTokens: batchOutput, totalTokens: batchTotal } } : {},
    items,
  }
}
