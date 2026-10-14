/**
 * The file-change recorder: watches the two pre-write waterfalls and remembers
 * each file's before-image, keyed to the SESSION, the turn and the WRITE that
 * changed it.
 *
 * ## Why the session is part of the key
 *
 * Turn numbers are per session, and a kernel process runs every session the user
 * opens — plus every subagent session a batch spawns. An earlier version keyed
 * changes by turn number alone, so a recall in one session could match another
 * session's turn 2: measured on a real harness, a recall in session B restored the
 * file to session A's before-image, which is worse than restoring nothing.
 *
 * ## Why the write's sequence is part of the key, and of the record
 *
 * Two writes to one path inside one turn are the normal shape (`edit` then
 * `edit`). The restore target is the state before the FIRST of them, and that was
 * previously decided by the order the captures RESOLVED in — which the thread
 * pool does not guarantee. A capture that finished second then won, and the recall
 * put back the file as the first write had left it: the range's first change was
 * never undone, and the report said `coverage: full`. The sequence is therefore
 * stored on the record and the list is ordered by it, so "first" means the first
 * WRITE.
 *
 * ## Why `prepend`
 *
 * `ctx.on` runs listeners in registration order and a waterfall listener that
 * does not call `next()` ENDS the chain. The kernel's own
 * `dsh-fs-observation-policy` installs a `fs/write-intent` listener that returns
 * the CAS guard and never forwards (`dsh-fs-observation-policy/lib/index.js`).
 *
 * A listener registered normally therefore never runs at all when that policy is
 * mounted — and it fails SILENTLY: writes keep working, no error is raised, and
 * the recorder simply captures nothing. `{ prepend: true }` puts this listener
 * first, and returning `next()`'s value hands the policy its own guard so the
 * write behaves exactly as it would have.
 *
 * Measured against the real `LocalFileSystem` in
 * `scratch/probe-fs-write-intent-real.mjs`: 7/7 checks, including that the write
 * still lands its exact bytes with the recorder installed.
 *
 * ## Why the capture IS awaited
 *
 * The read has to finish before the write it guards is allowed to proceed, or it
 * is not a before-image. Started and not awaited (the earlier design) the read is
 * issued one I/O hop after `next()` releases the write, so it can observe the
 * post-write bytes; measured 320/320 correct on an idle and a saturated thread
 * pool, which is exactly the kind of "usually right" this feature must not rest
 * on — a wrong before-image un-does nothing while reporting success. The cost is
 * one bounded read (≤4 MB, refused past that) on the write path.
 *
 * @module @dsh-app/plugin-rewind/recorder
 */

import { captureBefore, type CaptureResult } from './snapshots.ts'

/** One file's before-image, as the recorder holds it. */
export interface RecordedChange {
  /** Session whose turn changed the file. */
  readonly sessionId: string
  /** Absolute path of the changed file. */
  readonly path: string
  /** Bytes before the change, or null when the file did not exist. */
  readonly before: Buffer | null
  /** Turn the change belongs to, or null when none was open. */
  readonly turn: number | null
  /** Log sequence of the write, so two writes to one path stay in WRITE order. */
  readonly seq: number
}

/** A change that could not be captured, with the reason to report. */
export interface CaptureFailure {
  readonly sessionId: string
  readonly path: string
  readonly turn: number | null
  readonly reason: string
}

/** What the recorder exposes to the recall path. */
export interface Recorder {
  /**
   * Every change recorded for one session's turn range, EARLIEST WRITE FIRST.
   *
   * Two writes to the same path both appear: the earliest one holds the
   * before-image to restore, and the later ones are what the restore is undoing.
   */
  changesForTurns(sessionId: string, turns: readonly number[]): readonly RecordedChange[]
  /** Captures that failed for one session's turn range, to report rather than hide. */
  failuresForTurns(sessionId: string, turns: readonly number[]): readonly CaptureFailure[]
  /** Drop everything for turns that are no longer on the surface. */
  forget(sessionId: string, turns: readonly number[]): void
  /** Everything still held, for tests and diagnostics. */
  size(): number
}

/**
 * Create the recorder.
 *
 * @param capture - how to read a before-image; injected so tests can drive it.
 * @returns the recorder, plus the per-write entry point the hooks await.
 */
export function createRecorder(capture: (path: string) => Promise<CaptureResult> = captureBefore): {
  readonly recorder: Recorder
  record(sessionId: string, path: string, turn: number | null, seq: number): Promise<void>
} {
  const changes: RecordedChange[] = []
  const failures: CaptureFailure[] = []
  // Keyed by `session\u0000path\u0000seq` so a re-entrant hook cannot double-record
  // one write — a second capture would file a before-image taken AFTER the first
  // write.
  const seen = new Set<string>()

  return {
    recorder: {
      changesForTurns(sessionId, turns) {
        const wanted = new Set(turns)
        return changes
          .filter((c) => c.sessionId === sessionId && c.turn !== null && wanted.has(c.turn))
          .sort((a, b) => a.seq - b.seq)
      },
      failuresForTurns(sessionId, turns) {
        const wanted = new Set(turns)
        return failures.filter((f) => f.sessionId === sessionId && f.turn !== null && wanted.has(f.turn))
      },
      forget(sessionId, turns) {
        const wanted = new Set(turns)
        for (let i = changes.length - 1; i >= 0; i -= 1) {
          const change = changes[i]
          if (change.sessionId !== sessionId) continue
          if (change.turn !== null && wanted.has(change.turn)) changes.splice(i, 1)
        }
        for (let i = failures.length - 1; i >= 0; i -= 1) {
          const failure = failures[i]
          if (failure.sessionId !== sessionId) continue
          if (failure.turn !== null && wanted.has(failure.turn)) failures.splice(i, 1)
        }
      },
      size() {
        return changes.length
      },
    },
    async record(sessionId, path, turn, seq) {
      const key = `${sessionId}\u0000${path}\u0000${String(seq)}`
      if (seen.has(key)) return
      seen.add(key)
      const result = await capture(path)
      if (result.kind === 'captured') {
        changes.push({ sessionId, path, before: result.before, turn, seq })
        return
      }
      failures.push({
        sessionId,
        path,
        turn,
        reason: result.kind === 'too-large' ? 'the file is too large to snapshot' : result.reason,
      })
    },
  }
}

/**
 * The turn one point in a session log belongs to.
 *
 * Message events carry no `turn` of their own — only `turn/start` does — so this
 * walks the log and carries the counter forward, exactly as the projection and
 * the client's assembler do.
 *
 * `turn/end` deliberately does NOT reset it. That is the rule the projection
 * already uses (`projection.ts` only advances on `turn/start`), and the two MUST
 * agree: the projection's turn numbers are what the recall asks the recorder to
 * restore, so a recorder that reset on `turn/end` would file a write under `null`
 * while the recall asked for the turn by number — found nothing, restored
 * nothing, and reported success.
 *
 * @param events - the session's events, in sequence order.
 * @param seq - the sequence to report the turn for.
 * @returns the last opened turn at or before `seq`, or null before the first one.
 */
export function turnAt(events: readonly { readonly type?: unknown, readonly seq?: unknown, readonly data?: unknown }[], seq: number): number | null {
  let open: number | null = null
  for (const event of events) {
    const at = typeof event.seq === 'number' ? event.seq : -1
    if (at > seq) break
    if (event.type !== 'turn/start') continue
    const turn = (event.data as { turn?: unknown } | null)?.turn
    if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) open = turn
  }
  return open
}
