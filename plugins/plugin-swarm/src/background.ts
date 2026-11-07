/**
 * Detached execution for one swarm batch: the same orchestration core, run
 * inside a host BACKGROUND JOB instead of the tool call that started it.
 *
 * Why this module exists. A batch started from a PTC program is nested inside
 * `run_code`, whose deployment deadline is a hard 120 s default / 600 s cap
 * (`@deepseek-ai/dsh-ptc-runtime-node` `timeoutMs` / `maxTimeoutMs`) covering
 * "nested tool and approval waits". When that deadline fires the runtime
 * discards the worker, the executor aborts every in-flight nested call, and a
 * synchronous batch dies with its children — the work is lost, not merely
 * uncollected. The deadline cannot promote work that is already dead, so the
 * only sound fix is on this side: the batch must not be inside the call.
 *
 * The detached lane is the kernel's own job registry (`ctx.jobs`, a
 * `dsh-jobs-local` row in the base bundle). A job is owned by the calling
 * Agent's session, not by the tool call, so it outlives the call, appears in
 * the session header job list, accepts `job_kill`, and delivers ONE settlement
 * notice — inlined when it fits the notice budget, otherwise pointing at
 * `job_output`, which is where the per-item report is read (each item's output
 * while the report budget allows, one status line per item beyond that).
 *
 * Consequences that shape this module:
 *  - The batch runs on its OWN AbortController, deliberately not `exec.signal`;
 *    that is the whole point. `job_kill` reaches the same sweep through
 *    `cancel`, so cancellation still interrupts children.
 *  - Children are started with `delivery: 'caller'` for the FRESH ones, so the
 *    `subagent/end` lifecycle edge the orchestrator watches (delivery-
 *    independent) still settles each item while the N per-child notices a
 *    synchronous batch tolerates are replaced by one aggregate notice. Resumed
 *    items are the exception the seam forces: `sendMessage` carries no delivery
 *    policy, so a resumed child keeps the one it was created with, and a cold
 *    resume materializes with the kernel default `parent`
 *    (`dsh-subagent` `delivery: inputs.delivery ?? "parent"`). A batch that
 *    resumes children may therefore still deliver those children's own notices;
 *    the aggregate report is the authoritative result either way.
 *  - Live per-item progress goes to the observer channel (`log`, never
 *    model-facing) and the progress line; the model-facing ring gets the whole
 *    report in one write at settlement, header first and byte-bounded so the
 *    job tooling's tail-keeping truncation can never reach it.
 *
 * The service is read structurally (`ctx.get('jobs')`) rather than declared as
 * a dependency: a composition without a job controller still mounts this
 * plugin, and `background` then fails with a message naming the alternative
 * instead of the whole tool failing to register. Same convention as
 * `routes.ts`'s `SwarmConfigEditor` face.
 *
 * @module @dsh-app/plugin-swarm/background
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { runSwarmBatch, type SwarmBatchOptions, type SwarmBatchOutcome, type SwarmItemOutcome } from './orchestrator.ts'

/** A pull source a job producer may name instead of pushing chunks itself. */
export interface SwarmJobSource {
  readonly channel: string
  read(offset: number): { readonly text: string, readonly nextOffset: number, readonly lossy: boolean }
}

/**
 * The producer face a job's `run` receives. `append` lands in the output ring
 * (`stdout`/`stderr` are model-facing, `log` reaches observers only);
 * `updateProgress` replaces the live progress line shown in the job list.
 */
export interface SwarmJobHandle {
  append(text: string, options?: { readonly channel?: string }): void
  updateProgress(line: string): void
}

/** The terminal record a job settles with. */
export interface SwarmJobOutcome {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly detail?: string
  readonly result?: string
}

/** What a producer's `run` must hand back: its settlement and its cancellation. */
export interface SwarmJobHooks {
  readonly done: Promise<SwarmJobOutcome>
  cancel(reason: string): void
}

/** One job registration. Only the fields this producer uses are declared. */
export interface SwarmJobSpec {
  readonly kind: string
  readonly label: string
  readonly owner?: string
  readonly outputLimitBytes?: number
  readonly toolCall?: { readonly toolName?: string, readonly callId?: string }
  readonly output?: readonly SwarmJobSource[]
  run(handle: SwarmJobHandle): SwarmJobHooks
}

/** The subset of the kernel's job registry this plugin uses. */
export interface SwarmJobs {
  start(spec: SwarmJobSpec): string
}

/** How one call's batch executes. */
export type SwarmExecutionMode = 'inline' | 'background'

/**
 * The tool-call id the PTC executor mints for a nested call:
 * `` `${parentCallId}:ptc:${n}` `` (`dsh-tool-executor-ptc`). A batch invoked
 * from inside a `run_code` program is therefore identifiable from the call id
 * alone — the only marker a tool has for "my caller has a deadline".
 *
 * @param callId - the executing call's id, when the framework supplies one.
 * @returns whether this call runs inside a PTC program.
 */
export function isPtcNestedCall(callId: string | undefined): boolean {
  return callId !== undefined && callId.includes(':ptc:')
}

/**
 * Decide how a batch executes.
 *
 * `auto` (the model's default) detaches only inside a `run_code` program, and
 * only while the `backgroundInPtc` setting is on — everywhere else the
 * synchronous path is untouched, which is what keeps this change invisible to
 * a composition where nothing nests the call under a deadline. An explicit
 * `inline` or `background` from the model always wins: the model knows things
 * the heuristic cannot (a batch it expects to be short, or one it wants to run
 * detached outside PTC).
 *
 * @param requested - the call's `mode` argument.
 * @param callId - the executing call's id.
 * @param enabled - the `backgroundInPtc` setting.
 * @returns the resolved execution mode.
 */
export function resolveExecutionMode(
  requested: 'auto' | 'inline' | 'background' | undefined,
  callId: string | undefined,
  enabled: boolean,
): SwarmExecutionMode {
  if (requested === 'inline' || requested === 'background') return requested
  return enabled && isPtcNestedCall(callId) ? 'background' : 'inline'
}

/**
 * Byte budget for one settled report, in UTF-8 bytes.
 *
 * Chosen against the kernel's own numbers rather than guessed: `dsh-jobs-local`
 * retains 256 KiB per live job ring and `dsh-tool-jobs` bounds a model-facing
 * read/notice by the producer's `outputLimitBytes`.
 * Both truncate the TAIL, so a report over the budget loses its header; 48 KiB
 * is large enough for a full eight-item batch at the default 4000-character
 * per-item limit (up to ~3 bytes per character) and small enough that one
 * `job_output` read is a reasonable context cost. `SWARM_REPORT_SLACK` keeps the
 * producer's own budget strictly inside the cap handed to the job tooling, so
 * the plugin's head-keeping cut always wins over the kernel's tail cut.
 */
export const SWARM_REPORT_BYTES = 48 * 1024

/** Room above {@link SWARM_REPORT_BYTES} for the job tooling's own notice envelope. */
const SWARM_REPORT_SLACK = 2 * 1024

/** The `outputLimitBytes` this producer reports for a batch of any size: the
 * report budget plus the job tooling's notice envelope. Exported because the
 * tests assert the invariant that it stays strictly above the report budget —
 * if it ever dropped below, the kernel's tail-keeping cut would start removing
 * the header this producer works to keep.
 */
export const SWARM_OUTPUT_LIMIT_BYTES = SWARM_REPORT_BYTES + SWARM_REPORT_SLACK

/** UTF-8 byte length: the unit every job-output budget in the kernel counts in. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Clamp text to a UTF-8 byte budget, keeping the HEAD.
 *
 * A byte cut can land inside a multi-byte character. Decoding that slice
 * leniently would append U+FFFD, so the decode is `fatal` and a rejected tail
 * is retried one byte shorter — at most three times, since UTF-8 sequences are
 * at most four bytes. That keeps a U+FFFD the text legitimately ENDS with: it
 * decodes cleanly, so it is never mistaken for a cut artifact.
 *
 * @param text - the text to clamp.
 * @param maxBytes - the budget in UTF-8 bytes; non-positive yields ''.
 * @returns at most `maxBytes` bytes of `text`, cut on a character boundary.
 */
export function clampUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let cut = maxBytes; cut > maxBytes - 4 && cut > 0; cut -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, cut))
    } catch {
      // The cut bisected a multi-byte sequence: one byte shorter.
    }
  }
  return ''
}

/** Everything a detached batch needs from the tool that started it. */
export interface SwarmBackgroundOptions {
  /** Host context the orchestrator dispatches through. */
  readonly ctx: Context
  /** The kernel job registry (`ctx.get('jobs')`). */
  readonly jobs: SwarmJobs
  /** The calling agent; it owns the job and each child's parent link. */
  readonly parent: Agent
  /** The batch, without a signal: this module supplies its own. */
  readonly batch: Omit<SwarmBatchOptions, 'signal' | 'delivery' | 'onProgress'>
  /** Non-blocking split hints carried into the settled report. */
  readonly warnings: readonly string[]
  /** The executing call's id, recorded with the job for correlation. */
  readonly callId?: string
  /**
   * Render a settled batch inside the byte budget.
   *
   * The renderer owns the budget rather than the caller: it is the only place
   * that can keep the counts and name as many items as fit, and a caller
   * passing an unbounded report would be silently truncated at the tail by the
   * job tooling — losing the header.
   */
  readonly render: (outcome: SwarmBatchOutcome, warnings: readonly string[], budgetBytes: number) => string
}

/** The handle a detached batch hands back to the tool result. */
export interface SwarmBackgroundStart {
  readonly jobId: string
}

/**
 * One progress line for the job list: how much of the batch has settled.
 *
 * Deliberately terse — the job list renders it beside an elapsed clock, and the
 * per-item detail is the observer stream below.
 */
function progressLine(total: number, settled: number, outcome: SwarmItemOutcome): string {
  const counts = `${settled}/${total} settled`
  return outcome.status === 'completed' ? counts : `${counts} · [${outcome.index}] ${outcome.status}`
}

/**
 * Start one batch as a background job.
 *
 * Returns as soon as the registry accepts the registration — the batch itself
 * keeps running on its own controller, so a caller that is killed (a PTC
 * program hitting its deadline) leaves the work intact.
 *
 * @param options - the batch, the registry, and the renderer its report uses.
 * @returns the job id the tool result carries.
 */
export function startSwarmBackground(options: SwarmBackgroundOptions): SwarmBackgroundStart {
  const { ctx, jobs, parent, batch, warnings } = options
  const total = batch.tasks.length
  const controller = new AbortController()
  let settled = 0

  const spec: SwarmJobSpec = {
    kind: 'swarm',
    // The notice's first line is the label and the job list renders it as the
    // row title, so it is clamped: a model-supplied description is unbounded,
    // and a giant one would bloat every notice and every list row even though
    // the report itself is budgeted.
    label: clampUtf8(batch.label, 160),
    owner: String(parent.id),
    // Fixed, not derived from the batch: the report is held strictly inside it
    // so this producer's head-keeping cut is the only truncation that runs.
    outputLimitBytes: SWARM_OUTPUT_LIMIT_BYTES,
    ...options.callId === undefined ? {} : { toolCall: { toolName: 'swarm', callId: options.callId } },
    run: (handle) => {
      handle.updateProgress(`0/${total} settled`)
      const done = (async (): Promise<SwarmJobOutcome> => {
        let outcome: SwarmBatchOutcome
        try {
          outcome = await runSwarmBatch(ctx, {
            ...batch,
            signal: controller.signal,
            // Fresh children report here instead of to the parent, so their
            // per-child notices are replaced by this job's one aggregate
            // report. Resumed items keep the delivery they were created with
            // (`sendMessage` carries no policy), so a resume batch may still
            // deliver those children's own notices. The `subagent/end`
            // observation the orchestrator settles on is delivery-independent.
            delivery: 'caller',
            onProgress: (event) => {
              if (event.type !== 'item-settled') return
              settled += 1
              handle.updateProgress(progressLine(total, settled, event.outcome))
              // Observer-only: the model reads the settled report below, not a
              // stream of lines it would have to reassemble.
              handle.append(`[${event.outcome.index}] ${event.outcome.status} · ${event.outcome.item}\n`, { channel: 'log' })
            },
          })
        } catch (error: unknown) {
          // The orchestrator reports item failures as outcomes; only a broken
          // call reaches here. The job still settles with something the model
          // can act on rather than a silent crash — inside the same byte budget,
          // because this path bypasses the renderer entirely.
          const text = clampUtf8(
            `swarm "${batch.label}" failed before settlement: ${error instanceof Error ? error.message : String(error)}`,
            SWARM_REPORT_BYTES,
          )
          handle.append(text)
          return { status: controller.signal.aborted ? 'killed' : 'failed', detail: text.slice(0, 300) }
        }
        const report = options.render(outcome, warnings, SWARM_REPORT_BYTES)
        // ONE model-facing write: the notice inlines it when it fits and
        // otherwise points at job_output, whose read then opens at the header.
        handle.append(report)
        // The first line is the batch header (counts, concurrency, wall time);
        // the job list shows it as the terminal detail.
        const detail = report.split('\n', 1)[0]?.slice(0, 300) ?? batch.label
        if (controller.signal.aborted) {
          return { status: 'killed', detail: `${detail} · cancelled` }
        }
        // Every child failed: the synchronous path raises a tool error, and
        // the job's `failed` status is that error's background counterpart.
        return { status: outcome.completed === 0 && outcome.failed > 0 ? 'failed' : 'completed', detail }
      })()
      return {
        done,
        cancel: (reason: string) => { controller.abort(new Error(reason)) },
      }
    },
  }

  try {
    return { jobId: jobs.start(spec) }
  } catch (error: unknown) {
    // Nothing started, so this is a plain tool error the model can act on
    // rather than a failed job nobody can read.
    throw new Error(
      'swarm: could not start a background batch '
      + `(${error instanceof Error ? error.message : String(error)}). `
      + 'Rerun with mode "inline", or check that the preset of this session provides the job tools.',
    )
  }
}
