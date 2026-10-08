/**
 * The file-change recorder: watches the two pre-write waterfalls and remembers
 * each file's before-image, keyed to the turn that changed it.
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
 * ## Why the capture is not awaited
 *
 * The waterfall is on the write's critical path — the `write` tool awaits it
 * before touching the file. Awaiting a full file read there would slow every
 * write in the session, so the read is started and the `next()` chain is returned
 * immediately. The ordering that matters is preserved: the read is STARTED
 * before the write happens, so it sees the pre-write bytes. A capture that is
 * still in flight when the turn is recalled is reported as unrestorable rather
 * than guessed at.
 *
 * @module @dsh-app/plugin-rewind/recorder
 */

import { captureBefore, type CaptureResult } from './snapshots.ts'

/** One file's before-image, as the recorder holds it. */
export interface RecordedChange {
  /** Absolute path of the changed file. */
  readonly path: string
  /** Content before the change, or null when the file did not exist. */
  readonly before: string | null
  /** Turn the change belongs to, or null when none was open. */
  readonly turn: number | null
}

/** A change that could not be captured, with the reason to report. */
export interface CaptureFailure {
  readonly path: string
  readonly turn: number | null
  readonly reason: string
}

/** What the recorder exposes to the recall path. */
export interface Recorder {
  /**
   * Every change recorded for one turn range, oldest first.
   *
   * Two writes to the same path both appear: the earliest one holds the
   * before-image to restore, and the later ones are what the restore is undoing.
   */
  changesForTurns(turns: readonly number[]): readonly RecordedChange[]
  /** Captures that failed for one turn range, to report rather than hide. */
  failuresForTurns(turns: readonly number[]): readonly CaptureFailure[]
  /** Drop everything for turns that are no longer on the surface. */
  forget(turns: readonly number[]): void
  /** Everything still held, for tests and diagnostics. */
  size(): number
}

/**
 * Create the recorder.
 *
 * @param capture - how to read a before-image; injected so tests can drive it.
 * @returns the recorder, plus the per-write entry point the hooks call.
 */
export function createRecorder(capture: (path: string) => Promise<CaptureResult> = captureBefore): {
  readonly recorder: Recorder
  record(path: string, turn: number | null, seq: number): void
} {
  const changes: RecordedChange[] = []
  const failures: CaptureFailure[] = []
  // Keyed by `path\u0000seq` so a re-entrant hook cannot double-record one write.
  const seen = new Set<string>()

  return {
    recorder: {
      changesForTurns(turns) {
        const wanted = new Set(turns)
        return changes.filter((c) => c.turn !== null && wanted.has(c.turn))
      },
      failuresForTurns(turns) {
        const wanted = new Set(turns)
        return failures.filter((f) => f.turn !== null && wanted.has(f.turn))
      },
      forget(turns) {
        const wanted = new Set(turns)
        for (let i = changes.length - 1; i >= 0; i -= 1) {
          const turn = changes[i].turn
          if (turn !== null && wanted.has(turn)) changes.splice(i, 1)
        }
        for (let i = failures.length - 1; i >= 0; i -= 1) {
          const turn = failures[i].turn
          if (turn !== null && wanted.has(turn)) failures.splice(i, 1)
        }
      },
      size() {
        return changes.length
      },
    },
    record(path, turn, seq) {
      // Keyed by path + the write's own sequence, so a re-entrant hook cannot
      // record the same write twice — a second capture would file a before-image
      // taken AFTER the first write. The sequence is used ONLY here; it is not
      // stored on the record, because nothing orders by it (the restore groups by
      // path and keeps the first before-image).
      const key = `${path}\u0000${String(seq)}`
      if (seen.has(key)) return
      seen.add(key)
      // Started here, resolved on its own: the write proceeds without waiting.
      void capture(path).then((result) => {
        if (result.kind === 'captured') {
          changes.push({ path, before: result.before, turn })
          return
        }
        failures.push({
          path,
          turn,
          reason: result.kind === 'too-large' ? 'the file is too large to snapshot' : result.reason,
        })
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
