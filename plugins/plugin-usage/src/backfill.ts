/**
 * Historical backfill: fold already-persisted session logs into the store.
 *
 * The watermark table makes each pass incremental — sessions whose stored
 * last `seq` is at or below the watermark cost one `list()` entry and zero
 * event reads, so the rescan timer stays cheap between restarts.
 *
 * @module @dsh-app/plugin-usage/backfill
 */

import { foldEvents } from './fold.ts'
import type { FoldEvent } from './fold.ts'
import type { UsageStore } from './store.ts'

/**
 * Structural slice of `ctx.sessionPersistence` the backfill consumes. Kept
 * local so the plugin compiles against any kernel providing these calls.
 * The rc-line kernel reads logs through `open(id, 'read')` handles (the old
 * single-call `inspect(id)` is gone with the lifecycle-owned persistence).
 *
 * `list()` returns SNAPSHOT WRAPPERS, not bare headers: the id lives on
 * `entry.header.id`. Reading `entry.id` yields `undefined` for every entry,
 * which silently turned this whole pass into a no-op (every session skipped,
 * `inspected 0`) — the one shape mistake here is invisible by construction.
 * `listedSessionId` below accepts both shapes so a future kernel that flattens
 * the wrapper keeps working.
 */
export interface BackfillPersistence {
  list(): Promise<readonly unknown[]>
  open(id: string, access: 'read'): Promise<{
    /**
     * Fork-inherited prefix length: the leading events this log copied from
     * its parent. `0` for an ordinary session. Rows above it are this
     * session's own; the prefix was already folded under the PARENT's id.
     */
    readonly inheritedEventCount?: number
    read(): Promise<{ events: readonly FoldEvent[] }>
    close(): Promise<void>
  }>
}

/** The session id of one `list()` entry, wrapper or bare-header shape. */
export function listedSessionId(entry: unknown): string {
  const wrapped = (entry as { header?: { id?: unknown } }).header
  if (typeof wrapped?.id === 'string' && wrapped.id !== '') return wrapped.id
  const bare = (entry as { id?: unknown }).id
  return typeof bare === 'string' ? bare : ''
}

/**
 * The LOG FORMAT version one `list()` entry declares, or undefined.
 *
 * The header carries it (`SessionHeader.version`, "the current logical format
 * version"), and the header is deliberately NOT a session event — it never
 * reaches {@link foldEvents}, so this is the only place a fold can learn which
 * seq space it is reading. Same wrapper-or-bare tolerance as
 * {@link listedSessionId}: the listing's shape is the backend's business.
 */
export function listedHeaderVersion(entry: unknown): number | undefined {
  const wrapped = (entry as { header?: { version?: unknown } }).header
  if (typeof wrapped?.version === 'number') return wrapped.version
  const bare = (entry as { version?: unknown }).version
  return typeof bare === 'number' ? bare : undefined
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
 *
 * A FORK's log physically contains its parent's leading events, with the same
 * seq values but a different session id — so folding the whole log would count
 * the parent's usage a second time under the child. The inherited prefix is
 * skipped by seeding the fold with the handle's `inheritedEventCount` as the
 * starting watermark; the parent owns those rows.
 */
export async function runBackfill(
  store: UsageStore,
  persistence: BackfillPersistence,
  log: (message: string) => void,
): Promise<BackfillReport> {
  const report: BackfillReport = { inspected: 0, added: 0 }
  let headers: readonly unknown[]
  try {
    headers = await persistence.list()
  } catch (error) {
    log(`usage backfill: listing failed: ${(error as Error).message}`)
    return report
  }
  for (const entry of headers) {
    const id = listedSessionId(entry)
    if (id === '') continue
    let handle: {
      readonly inheritedEventCount?: number
      read(): Promise<{ events: readonly FoldEvent[] }>
      close(): Promise<void>
    } | undefined
    try {
      handle = await persistence.open(id, 'read')
      const { events } = await handle.read()
      report.inspected += 1
      const inherited = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      // The log format is the witness for every watermark below: a migration
      // renumbers the tail, so a watermark advanced under the previous format can
      // skip events that moved below it — read here, before the watermark is
      // consulted, so the re-fold happens in THIS pass rather than the next.
      // Rows are deduplicated by key, so re-reading a log cannot double-count.
      const version = listedHeaderVersion(entry)
      if (version !== undefined && store.observeLogFormat(version)) {
        // The witness moved, so this session's stored rows may hold the same
        // message under its OLD seq — re-folding without dropping them would
        // count that usage twice. See `UsageStore.dropRowsFor`.
        const dropped = store.dropRowsFor(id)
        log(`usage backfill: log format ${String(version)} differs from the folded one; re-folding sessions${dropped > 0 ? ` (${String(dropped)} row(s) dropped for this one)` : ''}`)
      }
      // Both bounds must be cleared: the stored watermark (what this plugin
      // already folded) and the inherited prefix (what the PARENT's fold
      // already counted).
      const fromSeq = Math.max(store.watermark(id), inherited)
      if (lastSeq <= fromSeq) continue
      report.added += foldEvents(store, id, [...events], fromSeq)
    } catch (error) {
      log(`usage backfill: session ${id} skipped: ${(error as Error).message}`)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  log(`usage backfill: inspected ${report.inspected} session(s), added ${report.added} row(s)`)
  return report
}
