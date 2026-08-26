/**
 * Wire shapes shared by the archive manager's host routes and client section.
 *
 * @module @dsh-app/plugin-archives/types
 */

/** One archived session row (a persisted session hidden from every grouping surface). */
export interface ArchivedSession {
  /** Full session id (`session-…`). */
  id: string
  /** Header creation instant (ms since epoch). */
  createdAt: number
  /** Total bytes of the session's on-disk directory (what deletion frees). */
  sizeBytes: number
  /** Projection-cached title; empty when none was generated yet. */
  title: string
}

/** One project group of archived sessions. */
export interface ArchiveGroup {
  /** Canonical project directory; empty when the header carries no cwd. */
  cwd: string
  /** Display name: basename of cwd, or a placeholder for cwd-less sessions. */
  title: string
  /** Sessions newest-first. */
  sessions: ArchivedSession[]
  /** Sum of the group's session sizes. */
  totalBytes: number
}

/** GET /list response value. */
export interface ArchiveList {
  /** Groups ordered by their newest session, newest first. */
  groups: ArchiveGroup[]
  /** Sessions listed (archived ids that still have a persisted header). */
  archivedCount: number
  /** Archived ids whose log is already gone from disk (no action possible). */
  staleCount: number
  /** Sum of all listed session sizes. */
  totalBytes: number
}

/** Why one requested deletion was skipped. */
export type ArchiveSkipReason = 'live' | 'not-archived' | 'missing' | 'io'

/** POST /delete response value. */
export interface ArchiveDeleteResult {
  /** Ids whose on-disk directories were removed. */
  deleted: string[]
  /** Bytes freed by the deletions (sizes measured before removal). */
  freedBytes: number
  /** Ids left untouched, each with a reason. */
  skipped: Array<{ id: string; reason: ArchiveSkipReason }>
}
