/**
 * The archive manager's audit log: one JSON line per action that touched a
 * session.
 *
 *     $DSH_HOME/logs/dsh-app-plugin-archives.log
 *     {"at":"2026-11-02T10:00:00.000Z","operation":"delete","result":"ok",
 *      "sessionId":"session-a","entryId":"1762082400000-1a2b3c4d","bytes":512}
 *
 * Why a file beside the kernel's own logs: a deletion is the one thing this
 * plugin does that a user may later have to reconstruct ("what happened to that
 * session?"). The trash answers it while the entry is still there; a purge and a
 * retention sweep do not, and both are the plugin's own doing rather than the
 * user's click. One line per action, append-only, and nothing is ever rewritten.
 *
 * ## Rolling: delete the old file BEFORE the rename
 *
 * The log rolls to `<path>.1` once it reaches {@link AUDIT_MAX_BYTES}. On POSIX a
 * `rename` replaces the destination; on Windows it fails with EEXIST when one is
 * already there, so a rolling scheme that assumes `rename` overwrites stops
 * rotating after the first roll — silently, on the platform this app ships to
 * first. The old `.1` is therefore removed first, and its removal is allowed to
 * fail (there may be nothing there).
 *
 * ## A failure here never fails the action it records
 *
 * The bytes are already moved or gone by the time a line is appended. An audit
 * write that throws would report a completed deletion as failed, and the retry it
 * invites would find nothing left to delete. Every fault is therefore contained:
 * {@link appendAudit} answers whether the line landed, and its callers turn a
 * `false` into a warning. The line's own `result` field is what tells a reader
 * that the range of the log is incomplete, not a missing file.
 *
 * @module @dsh-app/plugin-archives/audit
 */

import fsp from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Size at which the log rolls. 1 MiB is roughly ten thousand actions at the shape
 * above — far more than a desktop user produces before the file is worth keeping
 * whole, and small enough that nobody's `$DSH_HOME` grows without a bound.
 */
export const AUDIT_MAX_BYTES = 1_048_576

/** The suffix a rolled log takes. */
const ROLLED_SUFFIX = '.1'

/** What one action was. */
export type AuditOperation =
  /** A session's log directory moved into the trash. */
  | 'delete'
  /** A trashed session's directory moved back. */
  | 'restore'
  /** A trash entry was deleted for good (one entry, the whole trash, or expiry). */
  | 'purge'
  /** The retention settings were written. */
  | 'settings'

/** How one action ended for the subject of the line. */
export type AuditResult =
  /** It happened. */
  | 'ok'
  /** The action left this subject untouched; `reason` says why. */
  | 'skipped'
  /** The action was attempted and failed for this subject; `reason` says why. */
  | 'failed'

/** One line of the log. */
export interface AuditRecord {
  /** What was attempted. */
  readonly operation: AuditOperation
  /** How it ended. */
  readonly result: AuditResult
  /** The session this line is about, when the action named one. */
  readonly sessionId?: string
  /** The trash entry this line is about, when the action named one. */
  readonly entryId?: string
  /** Bytes the action moved or freed, when it measured any. */
  readonly bytes?: number
  /** A stable reason code (never prose) for a `skipped` or `failed` line. */
  readonly reason?: string
}

/** Where one append went. */
export interface AuditAppend {
  /** Whether the line reached the file. */
  readonly written: boolean
  /** Whether the append rolled the previous log to `.1` first. */
  readonly rolled: boolean
  /** English diagnostic for the caller's log; present only when `written` is false. */
  readonly detail?: string
}

/**
 * Append one action to the audit log.
 *
 * Never throws: see the module header. The caller decides what a missing line
 * means, and every caller here treats it as a warning.
 * @param input.logPath - absolute log path, or undefined when the host exposes no
 *   log directory (nothing is written and nothing is claimed).
 * @param input.record - the action.
 * @param input.now - clock, injected so a test can pin the timestamp.
 * @param input.maxBytes - roll threshold; defaults to {@link AUDIT_MAX_BYTES}.
 * @returns whether the line landed and whether the log rolled.
 */
export async function appendAudit(input: {
  logPath: string | undefined
  record: AuditRecord
  now?: () => number
  maxBytes?: number
}): Promise<AuditAppend> {
  if (input.logPath === undefined) return { written: false, rolled: false, detail: 'no audit log path was configured' }
  const at = new Date((input.now ?? Date.now)()).toISOString()
  const line = `${JSON.stringify({ at, ...input.record })}\n`
  const rolled = await rollIfNeeded(input.logPath, Buffer.byteLength(line, 'utf8'), input.maxBytes ?? AUDIT_MAX_BYTES)
  try {
    await fsp.mkdir(dirname(input.logPath), { recursive: true })
    await fsp.appendFile(input.logPath, line, { encoding: 'utf8' })
    return { written: true, rolled }
  } catch (error) {
    return {
      written: false,
      rolled,
      detail: `could not append to ${input.logPath}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Roll the log to `<path>.1` when the next line would take it over the bound.
 *
 * A rolling failure is NOT an append failure: an oversized log still records the
 * action, and one un-rollable log is a smaller problem than a deletion reported as
 * failed. The old `.1` goes first — `rename` cannot replace it on Windows (see the
 * module header).
 * @param logPath - absolute log path.
 * @param incoming - bytes the next line needs.
 * @param maxBytes - the bound.
 * @returns whether the log was rolled.
 */
async function rollIfNeeded(logPath: string, incoming: number, maxBytes: number): Promise<boolean> {
  if (maxBytes <= 0) return false
  let size: number
  try {
    const info = await fsp.stat(logPath)
    if (!info.isFile()) return false
    size = info.size
  } catch {
    // No log yet: nothing to roll, and the append creates it.
    return false
  }
  if (size + incoming <= maxBytes) return false
  const rolled = `${logPath}${ROLLED_SUFFIX}`
  // Windows refuses a rename onto an existing file (EEXIST), so the previous
  // generation goes first. Absence is the normal first roll and is not a problem.
  try { await fsp.rm(rolled, { force: true }) } catch { /* an undeletable old roll must not block the new one */ }
  try {
    await fsp.rename(logPath, rolled)
    return true
  } catch {
    // Keep appending to the un-rolled file rather than losing the line.
    return false
  }
}
