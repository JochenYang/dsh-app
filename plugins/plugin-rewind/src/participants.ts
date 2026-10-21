/**
 * The seam other suite plugins use to undo their own state after a recall.
 *
 * A recall rewrites the transcript and the working tree. Anything ELSE that
 * mirrored a turn — a board, an archive, a task list — has no way to learn that
 * the turn is gone unless it is told, and this plugin cannot know what those
 * consumers are. So it publishes one service, `dsh-app-rewind-participants`, and
 * each consumer registers itself; a profile with no consumers behaves exactly as
 * it did before this module existed.
 *
 * ## The order of the three acts
 *
 *   1. the surface replacement is APPENDED (the recall's authoritative act);
 *   2. every participant reconciles, in registration order;
 *   3. the recorder's before-images and the range's workspace snapshots are
 *      dropped.
 *
 * Reconciliation runs after the write on purpose: each participant restores
 * state to match a cut that has already landed, and a participant that fails
 * cannot leave the transcript half-cut. It runs before the cleanup on purpose
 * too — this plugin's own file revert IS a participant, and it reads both the
 * recorder and the snapshot the cleanup then removes.
 *
 * ## A participant never costs the recall
 *
 * A throwing or rejecting participant is contained here: its message becomes a
 * warning in the plugin log, the next participant still runs, and the recall
 * still succeeds. That is the same rule the file revert already followed as a
 * downgraded report rather than a refusal, applied to the whole seam.
 *
 * @module @dsh-app/plugin-rewind/participants
 */

import type { PlannedCut, SessionLike } from './cut.ts'

/**
 * What one participant is told about the recall that just happened.
 *
 * Structural and small on purpose: `plan` is the exact cut that was written, and
 * `session` is a read-only view of the log the participant can consult (this
 * plugin's own file revert reads the range's tool calls from it).
 */
export interface RewindRecallContext {
  /** Id of the session the recall happened in. */
  readonly sessionId: string
  /** The replacement range that was written. */
  readonly plan: PlannedCut
  /**
   * Participants whose state this recall deliberately leaves alone.
   *
   * A conversation-only recall cuts the transcript and keeps the working tree,
   * so the file revert must not run — but every OTHER participant still must,
   * because a board or an archive that mirrored the turn is gone from the
   * surface either way. Skipping by id rather than unregistering keeps the seam
   * intact: the participant stays available for the next recall.
   */
  readonly skip?: ReadonlySet<string>
  /**
   * The session, for a participant that needs the log rather than the plan.
   *
   * Typed as the read-only slice this plugin itself uses (`SessionLike`), but at
   * runtime it is the live `Session`: a participant could call `append`. Nothing
   * enforces that, so treat this as "read, do not write" by contract.
   */
  readonly session: SessionLike
}

/** One consumer that restores its own state after a recall. */
export interface RewindParticipant {
  /** Stable identity; a duplicate registration throws. */
  readonly id: string
  /**
   * Bring this participant's state back in line with the cut.
   *
   * The return value is the participant's own report and is handed back to
   * whoever ran the recall, keyed by `id`.
   */
  reconcileAfterRewind(context: RewindRecallContext): Promise<unknown> | unknown
}

/** The service published as `dsh-app-rewind-participants`. */
export interface RewindParticipantRegistry {
  /**
   * Add one participant.
   *
   * @param participant - the consumer to add.
   * @returns a disposer that removes it again.
   * @throws when `participant.id` is already registered.
   */
  register(participant: RewindParticipant): () => void
  /** Registered participants, in registration order. */
  list(): readonly RewindParticipant[]
  /**
   * Run every participant once, in registration order.
   *
   * Never rejects: a failed participant is logged and omitted from the map.
   *
   * @param context - the recall to reconcile against.
   * @returns each participant's report by id, in registration order.
   */
  reconcileAll(context: RewindRecallContext): Promise<Map<string, unknown>>
}

/** The logger slice the registry writes warnings through. */
export interface ParticipantLog {
  warn(message: string): void
}

/** One error's message, for a log line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build a registry.
 *
 * @param log - the plugin's logger; a failed participant is reported here.
 * @returns the registry, ready to `ctx.provide`.
 */
export function createParticipantRegistry(
  log: ParticipantLog,
  deadlineMs: number = PARTICIPANT_DEADLINE_MS,
): RewindParticipantRegistry {
  const ordered: RewindParticipant[] = []
  const ids = new Set<string>()

  return {
    register(participant: RewindParticipant): () => void {
      if (ids.has(participant.id)) {
        // Loud, not a silent replace: two consumers sharing an id would make the
        // recall's report name one of them and lose the other's.
        throw new Error(`rewind: a participant with id "${participant.id}" is already registered`)
      }
      ids.add(participant.id)
      ordered.push(participant)
      return () => {
        if (!ids.delete(participant.id)) return
        const at = ordered.indexOf(participant)
        if (at !== -1) ordered.splice(at, 1)
      }
    },

    list(): readonly RewindParticipant[] {
      return [...ordered]
    },

    async reconcileAll(context: RewindRecallContext): Promise<Map<string, unknown>> {
      const reports = new Map<string, unknown>()
      // A copy, so a participant that unregisters itself (or another) cannot
      // shift the list under the loop and skip someone; one registered DURING a
      // reconcile then runs from the next recall, which is the only order that
      // keeps this pass's membership fixed.
      const skip = context.skip
      for (const participant of [...ordered]) {
        if (skip !== undefined && skip.has(participant.id)) continue
        try {
          reports.set(participant.id, await withDeadline(
            participant.reconcileAfterRewind(context),
            deadlineMs,
            participant.id,
          ))
        } catch (error) {
          // Contained: the recall already landed, and one consumer's failure is
          // its own. The log line is the only place the reason survives.
          log.warn(`rewind: participant "${participant.id}" failed: ${messageOf(error)}`)
        }
      }
      return reports
    },
  }
}

/**
 * How long one participant may take before the recall stops waiting for it.
 *
 * The command handler awaits this loop before it forgets the recorder's
 * before-images and drops the range's snapshots, so a participant that never
 * settles would freeze the recall command and leak both. A deadline turns that
 * into the failure the seam already handles (a warning, the id missing from the
 * report) instead of an unanswerable command.
 */
const PARTICIPANT_DEADLINE_MS = 30_000

/**
 * Resolve with the participant's own result, or reject once the deadline passes.
 *
 * `Promise.race` rather than an abort signal: a participant's contract takes no
 * signal, and cancelling one mid-restore would be worse than reporting it late.
 *
 * @param value - the participant's return value or promise.
 * @param ms - the deadline.
 * @param id - the participant's id, for the refusal message.
 * @returns the participant's result.
 * @throws when the deadline passes first.
 */
function withDeadline(value: unknown, ms: number, id: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`did not settle within ${String(ms)}ms`)) }, ms)
  })
  return Promise.race([Promise.resolve(value), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

// Cordis answers a service property read only for a name the type surface
// declares, so the published name carries its type here. A consumer declares
// `dsh-app-rewind-participants` in its own `inject` and reads it typed.
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Participants that reconcile their own state after a recall. */
    'dsh-app-rewind-participants': RewindParticipantRegistry
  }
}
