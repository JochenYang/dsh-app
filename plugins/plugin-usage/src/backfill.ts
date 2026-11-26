/**
 * Historical backfill: fold already-persisted session logs into the store.
 *
 * Each pass is incremental through two witnesses. The SIZE witness skips a
 * session before it is opened: `list()` reports the physical log size, and the
 * event log is append-only (seq contiguous from 0 and never rewritten), so an
 * unchanged size proves there is nothing new to fold — those sessions cost one
 * `list()` entry and zero event reads. The witness is persisted with the
 * watermarks, so it survives a restart; a backend that omits `sizeBytes` falls
 * back to reading the log every pass. The WATERMARK is the second witness: it
 * cannot skip a read, but it stops an already-folded log from folding rows
 * again. Without the size witness every rescan read, decoded and validated
 * every log before the watermark could speak — measured in the installed
 * kernel on this machine's 256 sessions (146.6 MB compressed): about 220 MB
 * read and 17 s of CPU per pass, paid at every kernel start and at every
 * rescan interval. With it, a pass over an unchanged store reads under 2 MB
 * (same kernel, same logs, process I/O counters sampled around the rescan).
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

/**
 * The physical log byte size one `list()` entry declares, or undefined.
 *
 * `sizeBytes` is the snapshot's "when the backend can provide it cheaply"
 * field. It is a safe change token only because the event log is append-only:
 * the same size cannot hide an event added and one removed, so a size that did
 * not move means nothing new was appended. An unknown shape reads as "not
 * provided" — the pass then pays a full read rather than skipping a session on
 * a guess.
 */
export function listedSizeBytes(entry: unknown): number | undefined {
  const size = (entry as { sizeBytes?: unknown }).sizeBytes
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined
}

/** One backfill pass outcome, for logging. */
export interface BackfillReport {
  inspected: number
  /** Sessions skipped unopened: their log size matched the folded one. */
  skipped: number
  added: number
}

/**
 * Serialize a pass: at most one runs at a time, and a call made while one is in
 * flight is SKIPPED (it answers `undefined`), never queued.
 *
 * The start-up pass and the rescan timer can overlap — a pass over a large store
 * can outlast the interval, and the kernel start is the busiest moment. Two
 * overlapping passes are not merely wasted I/O: on a log format change only the
 * FIRST observes `formatChanged`, and the second would re-fold sessions whose
 * old rows the first has not dropped yet, so a crash in that window leaves the
 * same usage counted twice. The next interval retries whatever a skipped round
 * would have found.
 *
 * The guard is released on SETTLE, not on success: a throwing pass that kept it
 * set would stop every later rescan for the rest of the process's lifetime.
 *
 * @param run - one pass, exactly as the caller would run it unguarded.
 * @returns a caller that starts `run` or answers `undefined` when one is
 *   already in flight.
 */
export function singleFlightPass(
  run: () => Promise<BackfillReport>,
): () => Promise<BackfillReport | undefined> {
  let inFlight: Promise<BackfillReport> | undefined
  return () => {
    if (inFlight !== undefined) return Promise.resolve(undefined)
    // Registered before the caller can observe the pass; `finally` runs as a
    // microtask, so it never clears the guard inside this synchronous block.
    const pass = run().finally(() => { inFlight = undefined })
    inFlight = pass
    return pass
  }
}

/**
 * Scan every persisted session and fold the parts above their watermarks.
 * A session whose log size did not move since it was folded is skipped without
 * being opened. A failing session is skipped (logged); a failing listing aborts
 * the pass with the error rethrown to the caller's catch.
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
  const report: BackfillReport = { inspected: 0, skipped: 0, added: 0 }
  let headers: readonly unknown[]
  try {
    headers = await persistence.list()
  } catch (error) {
    log(`usage backfill: listing failed: ${(error as Error).message}`)
    return report
  }
  // The format witness is GLOBAL to the store, not per session: a migration
  // rewrites every log at once, and `observeLogFormat` answers "the stored
  // vocabulary differs from this one" only on its FIRST call. Asking inside the
  // loop made the first session re-fold correctly and every later one re-fold
  // WITHOUT dropping its old rows — the same message counted twice on disk. One
  // read before the loop puts every session on the same verdict.
  // The HIGHEST witness, not the first one found: during a migration the list holds
  // both vocabularies, and taking whichever session came first made the witness flip
  // with list order — every flip cleared the watermarks and re-folded every session.
  const formatVersion = headers
    .map(entry => listedHeaderVersion(entry))
    .reduce<number | undefined>((highest, value) => {
      if (value === undefined) return highest
      return highest === undefined || value > highest ? value : highest
    }, undefined)
  const formatChanged = formatVersion !== undefined && store.observeLogFormat(formatVersion)
  if (formatChanged) {
    log(`usage backfill: log format ${String(formatVersion)} differs from the folded one; re-folding every session's rows`)
  }
  for (const entry of headers) {
    const id = listedSessionId(entry)
    if (id === '') continue
    // The size comes from the SAME listing entry that decides the skip, and is
    // never re-stat'ed after the read: a log appended between `list()` and
    // `open()` would otherwise record a size that does not cover the events the
    // read returned, and the next pass would skip the appended tail for good.
    // A format change invalidates every size, because the migration rewrites the
    // logs themselves (see `observeLogFormat`).
    const size = listedSizeBytes(entry)
    if (!formatChanged && size !== undefined && store.foldedBytesOf(id) === size) {
      report.skipped += 1
      continue
    }
    let handle: {
      readonly inheritedEventCount?: number
      read(): Promise<{ events: readonly FoldEvent[] }>
      close(): Promise<void>
    } | undefined
    try {
      // Dropped BEFORE the read. A session whose read fails this pass still holds
      // rows keyed by the OLD seq, and the next pass finds `formatChanged` false —
      // re-folding on top of them would count that usage twice, for ever. The
      // watermarks were cleared globally already, so there is nothing to protect by
      // waiting for a successful read.
      if (formatChanged) {
        const dropped = store.dropRowsFor(id)
        if (dropped > 0) log(`usage backfill: ${String(dropped)} row(s) dropped for session ${id}`)
      }
      handle = await persistence.open(id, 'read')
      const { events } = await handle.read()
      report.inspected += 1
      const inherited = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      // Both bounds must be cleared: the stored watermark (what this plugin
      // already folded) and the inherited prefix (what the PARENT's fold
      // already counted).
      const fromSeq = Math.max(store.watermark(id), inherited)
      if (lastSeq <= fromSeq) {
        // Nothing above either bound, but the read DID succeed, so this size is
        // the whole log as this fold has seen it — witness it before leaving.
        if (size !== undefined) store.noteFoldedBytes(id, size)
        continue
      }
      report.added += foldEvents(store, id, [...events], fromSeq)
      // After the fold, never before: a throwing fold must leave no witness
      // behind, or the retry would be skipped and its rows lost for good.
      if (size !== undefined) store.noteFoldedBytes(id, size)
    } catch (error) {
      log(`usage backfill: session ${id} skipped: ${(error as Error).message}`)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  log(`usage backfill: inspected ${report.inspected} session(s), skipped ${report.skipped} unchanged, added ${report.added} row(s)`)
  return report
}
