/**
 * Usage store: append-only JSONL persistence for usage rows plus per-session
 * fold watermarks. Rows are keyed `sessionId:seq` so live capture and
 * backfill fold the same event at most once; watermarks keep a session with
 * zero usage rows from being re-inspected forever.
 *
 * @module @dsh-app/plugin-usage/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageRow } from './types.ts'

/** Debounce window batching row/watermark writes to disk. */
const FLUSH_DELAY_MS = 200

function keyOf(row: UsageRow): string {
  return `${row.sessionId}:${row.seq}`
}

/** Constructor options. */
export interface UsageStoreOptions {
  /** Directory for usage.jsonl + watermarks.json + fold-state.json. */
  dir: string
  /** Diagnostic logger (warns on skipped lines / failed writes). */
  log: (message: string) => void
}

export class UsageStore {
  private rows = new Map<string, UsageRow>()
  private watermarks = new Map<string, number>()
  /**
   * The log format this store's watermarks mean anything under (0 = nothing
   * folded yet). See {@link observeLogFormat}: a format change renumbers the tail
   * of every log, which is exactly what a seq-based watermark cannot survive.
   */
  private logFormatVersion = 0
  private readonly filePath: string
  private readonly watermarkPath: string
  private readonly foldStatePath: string
  private readonly log: (message: string) => void
  private pendingLines: string[] = []
  /** Set when rows were REMOVED: the log file is rewritten instead of appended. */
  private rewrite = false
  /** Set when a watermark advanced (or was dropped) since the last flush; the
   * watermark and fold-state files are rewritten only then, so row-only flushes
   * never pay for them. */
  private watermarksDirty = false
  private flushTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(options: UsageStoreOptions) {
    this.log = options.log
    mkdirSync(options.dir, { recursive: true })
    this.filePath = join(options.dir, 'usage.jsonl')
    this.watermarkPath = join(options.dir, 'watermarks.json')
    this.foldStatePath = join(options.dir, 'fold-state.json')
  }

  /** Load persisted rows and watermarks. Malformed lines are skipped and counted. */
  load(): void {
    if (existsSync(this.filePath)) {
      let dropped = 0
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const row = JSON.parse(trimmed) as UsageRow
          if (typeof row.seq !== 'number' || typeof row.sessionId !== 'string') {
            dropped += 1
            continue
          }
          this.rows.set(keyOf(row), row)
        } catch {
          dropped += 1
        }
      }
      if (dropped > 0) this.log(`usage store: skipped ${dropped} malformed line(s)`)
    }
    if (existsSync(this.watermarkPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.watermarkPath, 'utf8')) as Record<string, unknown>
        for (const [id, seq] of Object.entries(parsed)) {
          if (typeof seq === 'number') this.watermarks.set(id, seq)
        }
      } catch (error) {
        this.log(`usage store: watermarks unreadable, starting fresh: ${(error as Error).message}`)
      }
    }
    if (existsSync(this.foldStatePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.foldStatePath, 'utf8')) as { logFormatVersion?: unknown }
        if (typeof parsed.logFormatVersion === 'number') this.logFormatVersion = parsed.logFormatVersion
      } catch (error) {
        // A witness we cannot read is one we do not have: the watermarks stay as
        // they are rather than being dropped on a guess, and the next format
        // change folds everything again anyway.
        this.log(`usage store: fold state unreadable, keeping watermarks: ${(error as Error).message}`)
      }
    }
  }

  /** All rows, in insertion order. */
  all(): UsageRow[] {
    return [...this.rows.values()]
  }

  /** Highest folded seq for one session (0 before anything was seen). */
  watermark(sessionId: string): number {
    return this.watermarks.get(sessionId) ?? 0
  }

  /**
   * Advance the session watermark to `seq` (monotonic; never rewinds).
   * Called for every event seen, so a session with no usage rows still stops
   * being re-inspected.
   */
  advanceWatermark(sessionId: string, seq: number): void {
    const current = this.watermarks.get(sessionId) ?? 0
    if (seq > current) {
      this.watermarks.set(sessionId, seq)
      this.watermarksDirty = true
      this.scheduleFlush()
    }
  }

  /**
   * Note the log format the caller is folding, and drop every watermark when it
   * is not the one they were advanced under.
   *
   * The watermark is `sessionId:seq`, and seq order is NOT stable across a log
   * migration: the V3→V4 step appends synthetic events and renumbers the tail, so
   * an event that used to sit above a watermark can end up below it — skipped by
   * this fold and by every later one, which the user sees as usage numbers that
   * are quietly too low and nothing else.
   *
   * The format is a witness for the whole store rather than per session: every
   * log a kernel line writes carries the same version, and one number is the whole
   * bookkeeping. Re-folding is SAFE because rows are deduplicated by key on the
   * way in (`addRows`), so a second pass over a log adds nothing twice.
   *
   * @param version - the format version the caller's logs declare.
   * @returns true when this is a change (the watermarks were dropped, so the
   *   caller will re-read logs it had already folded).
   */
  observeLogFormat(version: number): boolean {
    if (this.logFormatVersion === version) return false
    const replaced = this.logFormatVersion !== 0
    this.logFormatVersion = version
    if (replaced) {
      this.watermarks.clear()
      this.watermarksDirty = true
      this.scheduleFlush()
    }
    return replaced
  }

  /**
   * Drop every row of one session, in memory and on disk.
   *
   * This is the other half of a format change, and it is not optional: rows are
   * keyed `sessionId:seq`, and a migration that RENUMBERS the tail gives an
   * already-folded message a new seq — so re-folding it would add a second row
   * beside the first and count that usage twice. Dropping the session's rows
   * first turns "fold it again" into "fold it once, at its current address".
   *
   * The file is rewritten rather than appended to (the append-only shape cannot
   * un-say a line). Losing the rewrite to a crash is recoverable: the watermark
   * was dropped with it, so the next pass re-folds the session from the start.
   *
   * @param sessionId - the session whose stored rows are no longer trustworthy.
   * @returns the number of rows dropped.
   */
  dropRowsFor(sessionId: string): number {
    let dropped = 0
    for (const [key, row] of this.rows) {
      if (row.sessionId !== sessionId) continue
      this.rows.delete(key)
      dropped += 1
    }
    if (dropped > 0) {
      this.rewrite = true
      this.scheduleFlush()
    }
    return dropped
  }

  /** Deduplicate and enqueue one batch of rows; returns the number actually added. */
  addRows(rows: UsageRow[]): number {
    let added = 0
    for (const row of rows) {
      const key = keyOf(row)
      if (this.rows.has(key)) continue
      this.rows.set(key, row)
      this.pendingLines.push(JSON.stringify(row))
      added += 1
    }
    if (added > 0) this.scheduleFlush()
    return added
  }

  /** Number of in-memory rows. */
  get size(): number {
    return this.rows.size
  }

  private scheduleFlush(): void {
    if (this.disposed || this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, FLUSH_DELAY_MS)
  }

  /**
   * Write the pending rows and watermarks. FAILURE KEEPS THE DATA: the batch
   * is only dropped from the buffer after the append succeeded, and the
   * watermark file is only written once its rows are on disk. Clearing first
   * (the earlier shape) lost rows for good on a full disk or a locked file —
   * the watermark had already advanced past them, so neither the live path nor
   * the backfill would ever produce them again.
   */
  private flush(): void {
    if (this.pendingLines.length === 0 && !this.watermarksDirty && !this.rewrite) return
    if (this.rewrite) {
      // A removal cannot be appended away: the whole file is written from memory,
      // which already holds every surviving row. Pending appends ride along —
      // they are in the map too — so nothing is lost by skipping the append path.
      try {
        writeFileSync(this.filePath, this.rows.size === 0
          ? ''
          : `${[...this.rows.values()].map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
        this.pendingLines = []
        this.rewrite = false
      } catch (error) {
        // Keep everything for the next flush: the rows are still in memory, so a
        // retry writes the same file. The old lines stay on disk until it lands,
        // which is what a later load() would read — the pre-migration picture.
        this.log(`usage store: rewrite failed, ${String(this.rows.size)} row(s) kept in memory: ${(error as Error).message}`)
        return
      }
    }
    if (this.pendingLines.length > 0) {
      try {
        appendFileSync(this.filePath, `${this.pendingLines.join('\n')}\n`, 'utf8')
        this.pendingLines = []
      } catch (error) {
        // Keep the buffer for the next flush (a new save schedules one) and
        // report it: a silent drop here under-reports the user's usage forever.
        this.log(`usage store: persist failed, ${String(this.pendingLines.length)} row(s) kept for retry: ${(error as Error).message}`)
        return
      }
    }
    if (!this.watermarksDirty) return
    try {
      writeFileSync(this.watermarkPath, `${JSON.stringify(Object.fromEntries(this.watermarks), null, 2)}\n`, 'utf8')
      // The witness rides the same flush: dropping the watermarks without
      // recording WHY would make the next start read an empty map as "nothing was
      // ever folded", which is the same outcome here but hides the reason. Both
      // files are tiny and are two halves of one fact — how far this session was
      // folded, and under which log format.
      writeFileSync(this.foldStatePath, `${JSON.stringify({ logFormatVersion: this.logFormatVersion }, null, 2)}\n`, 'utf8')
      this.watermarksDirty = false
    } catch (error) {
      this.log(`usage store: watermark persist failed (rows are safe; watermarks retry): ${(error as Error).message}`)
    }
  }

  /** Synchronously drain pending writes (plugin dispose). */
  dispose(): void {
    this.disposed = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.flush()
  }
}
