/**
 * Historical backfill: fold already-persisted session logs into the store.
 *
 * The watermark table makes each pass incremental — sessions whose stored
 * last `seq` is at or below the watermark cost one `list()` entry and zero
 * `inspect()` calls, so the rescan timer stays cheap between restarts.
 *
 * @module @dsh-app/plugin-usage/backfill
 */

import { foldEvents } from './fold.ts'
import type { FoldEvent } from './fold.ts'
import type { UsageStore } from './store.ts'

/**
 * Structural slice of `ctx.sessionPersistence` the backfill consumes. Kept
 * local so the plugin compiles against any kernel providing these calls.
 */
export interface BackfillPersistence {
  list(): Promise<Array<{ id: unknown }>>
  inspect(id: unknown): Promise<{ events: readonly FoldEvent[] }>
}

/** One backfill pass outcome, for logging. */
export interface BackfillReport {
  inspected: number
  added: number
}

/**
 * Scan every persisted session and fold the parts above their watermarks.
 * A failing session is skipped (logged); a failing listing aborts the pass
 * with the error rethrown to the caller's catch.
 */
export async function runBackfill(
  store: UsageStore,
  persistence: BackfillPersistence,
  log: (message: string) => void,
): Promise<BackfillReport> {
  const report: BackfillReport = { inspected: 0, added: 0 }
  let headers: Array<{ id: unknown }>
  try {
    headers = await persistence.list()
  } catch (error) {
    log(`usage backfill: listing failed: ${(error as Error).message}`)
    return report
  }
  for (const header of headers) {
    const id = String(header.id)
    try {
      const { events } = await persistence.inspect(header.id)
      report.inspected += 1
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      if (lastSeq <= store.watermark(id)) continue
      report.added += foldEvents(store, id, [...events])
    } catch (error) {
      log(`usage backfill: session ${id} skipped: ${(error as Error).message}`)
    }
  }
  log(`usage backfill: inspected ${report.inspected} session(s), added ${report.added} row(s)`)
  return report
}
