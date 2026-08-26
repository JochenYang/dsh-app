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
  /** Directory for usage.jsonl + watermarks.json. */
  dir: string
  /** Diagnostic logger (warns on skipped lines / failed writes). */
  log: (message: string) => void
}

export class UsageStore {
  private rows = new Map<string, UsageRow>()
  private watermarks = new Map<string, number>()
  private readonly filePath: string
  private readonly watermarkPath: string
  private readonly log: (message: string) => void
  private pendingLines: string[] = []
  private flushTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(options: UsageStoreOptions) {
    this.log = options.log
    mkdirSync(options.dir, { recursive: true })
    this.filePath = join(options.dir, 'usage.jsonl')
    this.watermarkPath = join(options.dir, 'watermarks.json')
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
      this.scheduleFlush()
    }
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

  private flush(): void {
    if (this.pendingLines.length === 0 && this.watermarks.size === 0) return
    const lines = this.pendingLines
    this.pendingLines = []
    try {
      if (lines.length > 0) appendFileSync(this.filePath, `${lines.join('\n')}\n`, 'utf8')
      writeFileSync(this.watermarkPath, `${JSON.stringify(Object.fromEntries(this.watermarks), null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`usage store: persist failed: ${(error as Error).message}`)
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
