/**
 * Wire shapes shared by the archive manager's host routes and client section.
 *
 * @module @dsh-app/plugin-archives/types
 */

/**
 * A user-visible message the host cannot localize — and deliberately does not
 * try to.
 *
 * The host is a long-lived child process: its language would be decided at
 * boot, so switching the UI language would require restarting the kernel. It
 * therefore never sends prose. It sends a stable code plus the values the
 * sentence interpolates, and the client — which owns the locale namespace —
 * renders it. `text` is an ENGLISH diagnostic used only for a code this client
 * does not know (an older UI beside a newer kernel); it is never a localized
 * sentence, because matching on one across a boundary is how the kernel-side
 * failure classifier once misread "tampered" as "network error".
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

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
  /**
   * Display name: basename of cwd, and EMPTY for a cwd-less group — that
   * heading is copy, so the client renders its own line rather than receiving
   * a sentence from here.
   */
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
  /** Archived ids whose log is already gone from disk (prunable records,
   *  including every id /delete just removed). */
  staleCount: number
  /** Sum of all listed session sizes. */
  totalBytes: number
}

/** Why one requested deletion was skipped. */
export type ArchiveSkipReason = 'live' | 'not-archived' | 'missing' | 'io' | 'unsupported'

/** POST /delete response value. */
export interface ArchiveDeleteResult {
  /** Ids whose log artifact was deleted. Archive-set records are kept (they
   *  are the client's visibility fence; /prune reclaims them as stale). */
  deleted: string[]
  /** Bytes freed by the deletions (sizes measured before removal). */
  freedBytes: number
  /** Ids left untouched, each with a reason. */
  skipped: Array<{ id: string; reason: ArchiveSkipReason }>
}

/** POST /prune response value. */
export interface ArchivePruneResult {
  /** Stale records removed from the registry's archive set. */
  pruned: number
  /** Archive-set size after the prune. */
  remaining: number
}
