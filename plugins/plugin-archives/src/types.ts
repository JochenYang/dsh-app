/**
 * Wire shapes shared by the archive manager's host routes and client section.
 *
 * @module @dsh-app/plugin-archives/types
 */

import type { ArchiveSettings } from './settings.ts'

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
  /** Total bytes of the session's on-disk directory (what the trash will hold
   *  while the session is deleted, and what a purge finally frees). */
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

/**
 * Why one requested id was skipped.
 *
 * The reasons are shared by every action that moves a session between the
 * archive, the trash and the disk, because the client words them the same way
 * wherever they appear.
 */
export type ArchiveSkipReason =
  /** The session is running (or the activity seam could not say it is not). */
  | 'live'
  /** The id is not in the registry's archive set. */
  | 'not-archived'
  /** No persisted log for the id (a stale record: /prune's business). */
  | 'missing'
  /** Read/write failed. */
  | 'io'
  /** The backend exposes no log artifact (or no sessions root) to work with. */
  | 'unsupported'
  /** The id already sits in the trash: /delete is a no-op, never a second copy. */
  | 'already-in-trash'
  /** No trash entry holds this id (already restored or purged elsewhere). */
  | 'not-in-trash'
  /** A restore found the session's original directory occupied again. */
  | 'target-exists'
  /** A recorded path is not really inside the current sessions root; nothing was moved. */
  | 'path-outside-root'
  /** The trash and the sessions root are on different filesystems (not supported). */
  | 'cross-device'
  /** Another delete of the same session won the move; nothing was moved by this call. */
  | 'concurrent'
  /** The filesystem would not say what one member's payload slot holds, so the
   *  irreversible action it would authorize is refused. Retry: the everyday cause
   *  is a handle an indexer or an antivirus is holding for a moment. */
  | 'trash-unconfirmed'
  /** The move failed AND could not be rolled back: the session is parked in an
   *  interrupted trash entry (see GET /trash). */
  | 'trash-interrupted'
  /** A restore was asked for while no sessions root is available to fence it.
   *  Retry once the backend can name its root again. */
  | 'needs-root'
  /** The subagent tree under a requested session is bigger than this surface will
   *  move (too many members, or a delegation chain deeper than the walk's bound —
   *  see `./tree.ts`). The bounds REFUSE instead of truncating, because a
   *  truncated set would leave a grandchild behind. Nothing was moved. */
  | 'tree-too-large'
  /** A subagent catalog answered in a shape its published type does not describe,
   *  so the tree could not be established. Upstream API drift; nothing was moved. */
  | 'tree-unavailable'
  /** A "stop first" delete reached its bounded wait with work still running.
   *  `sessions` names what was still active; nothing was moved. */
  | 'still-running'
  /** The `workspace/session-stop` dispatch failed, so the session could not be
   *  stopped; `detail` carries the listeners' own messages. Nothing was moved. */
  | 'stop-failed'

/**
 * One id a request left untouched, and why.
 *
 * `sessions` is filled in two situations: a reason about a whole subagent tree
 * names the members it is about (but only when the tree held more than the
 * requested id, so a single-session answer stays as small as it was), and the two
 * stop reasons always name what was still active / what was asked to stop.
 * `detail` is an ENGLISH diagnostic for logs — never a sentence, because the client
 * words the `reason` itself.
 */
export interface ArchiveSkipped {
  /** The requested id this answer is about. */
  readonly id: string
  /** Why it was left untouched. */
  readonly reason: ArchiveSkipReason
  /** The session ids this reason is about, where that is not just {@link id}. */
  readonly sessions?: readonly string[]
  /** English diagnostic for logs; present on `stop-failed` and the tree refusals. */
  readonly detail?: string
}

/** One trash entry as a mutation response names it. */
export interface ArchiveTrashEntryRef {
  /** Entry identity (`<epochMillis>-<uuid first 8>`). */
  trashId: string
  /** Every session id the entry holds. */
  ids: string[]
  /** ISO-8601 instant the entry was created. */
  deletedAt: string
}

/**
 * POST /delete response value: the sessions were moved into the TRASH, not
 * deleted — nothing is freed until /purge removes the entry.
 *
 * One call produces at most one trash entry, holding every session the call
 * moved (a batch travels together so a restore puts the batch back together).
 * A subagent tree travels with the root that owns it, so `deleted` can be longer
 * than the requested list: it names every session that moved.
 *
 * The archive-set records are KEPT: they are the client's visibility fence over a
 * list snapshot it already holds (dropping one un-hides a session whose log is in
 * the trash), and with the log gone an untouched record is exactly the stale record
 * `/list` counts and `/prune` reclaims.
 */
export interface ArchiveDeleteResult {
  /** Ids moved into the trash, roots and their subagent descendants together. A
   *  child was never in the archive set, and `/restore-deleted` does not add it
   *  (see `TrashMember.archived`). */
  deleted: string[]
  /** Bytes the trash now holds on behalf of these ids; 0 actually freed. */
  freedBytes: number
  /** Ids left untouched, each with a reason. */
  skipped: ArchiveSkipped[]
  /** The entry this call created, absent when nothing moved. */
  trashId?: string
}

/** One session inside a trash entry, as GET /trash lists it. */
export interface ArchiveTrashMember {
  /** Session id. */
  sessionId: string
  /** Title captured at delete time; empty when none was generated. */
  title: string
  /** Byte size measured before the move. */
  sizeBytes: number
  /** Whether this session's payload is really on disk inside the entry. */
  present: boolean
}

/**
 * Why a trash row cannot be restored right now.
 *
 * These are CAPABILITY facts, not situations: each one makes the request fail
 * the same way every time it is tried from here, which is why the row hides its
 * restore action rather than offering one that cannot work. A restore asked for
 * anyway answers the matching skip reason.
 *
 * An occupied original path is deliberately NOT one of them: the occupant can
 * be deleted, so the row keeps its restore action and the request reports
 * `target-exists` when it runs.
 */
export type ArchiveTrashRestoreBlock =
  /** No member's payload is on disk: there is nothing to put back. */
  | 'no-payload'
  /** A slot or a target could not be inspected; retry when the filesystem answers. */
  | 'unconfirmed'
  /** No sessions root is available to fence the restore against. */
  | 'needs-root'
  /** A recorded path is not really inside the current sessions root. */
  | 'outside-root'

/**
 * One trash entry, as GET /trash lists it.
 *
 * What `members` names is what is on disk, not what the entry's metadata claims:
 * a member proven gone is not listed (it is back at its original path), and a
 * member whose slot could not be read is listed with `present: false` — the
 * filesystem would not say, and "I could not look" is never reported as "it is
 * not there". Acting on a row therefore never reaches a different session than
 * the row describes.
 *
 * `state` says what the row is:
 *   - `ready` — at least one member's payload is proven present, and every
 *     member's slot could be inspected;
 *   - `interrupted` — the payload is incomplete or could not be read, so it
 *     cannot be restored as the batch it was;
 *   - `purging` — an earlier deletion did not finish; its bytes are still on
 *     disk and "delete for good" retries the removal;
 *   - `unverified` — the directory name is a minted trash id but its metadata
 *     cannot be read, so nothing in it names a session or an original path. Its
 *     bytes are on disk and its name is the handle that frees them.
 *
 * `restorable` is the question the row's own buttons ask, and it is answered at
 * request time rather than stored: whether a restore would do anything depends
 * on the sessions root the backend can see RIGHT NOW, and a metadata file on
 * disk is not allowed to answer it (see `./trash.ts`).
 */
export interface ArchiveTrashEntry {
  /** Entry identity — also the handle every request may address this row by. */
  trashId: string
  /** ISO-8601 instant the entry was created. */
  deletedAt: string
  /** What the payload on disk makes this row. */
  state: 'ready' | 'interrupted' | 'purging' | 'unverified'
  /** Whether a restore request would actually put members back right now. */
  restorable: boolean
  /** Why `restorable` is false; absent when it is true. */
  restorableBlock?: ArchiveTrashRestoreBlock
  /** Sessions still associated with the entry (a restore or purge acts on the whole entry). */
  members: ArchiveTrashMember[]
  /** Sum of the members' recorded sizes (a purging leftover reports the bytes on disk). */
  totalBytes: number
}

/** GET /trash response value. */
export interface ArchiveTrashList {
  /** Entries newest-first. */
  entries: ArchiveTrashEntry[]
  /** Sessions across all entries. */
  sessionCount: number
  /** Sum of every entry's `totalBytes`. */
  totalBytes: number
  /** Oldest row's deletion instant (usage: how far back the trash reaches). */
  oldestDeletedAt?: string
  /** Newest row's deletion instant. */
  newestDeletedAt?: string
}

/** POST /purge response value. */
export interface ArchivePurgeResult {
  /** Entries removed for good. */
  purged: ArchiveTrashEntryRef[]
  /** Bytes the removals freed (measured recursively before removal). */
  freedBytes: number
  /** Ids that named no trash entry, each with a reason. */
  skipped: ArchiveSkipped[]
  /** Non-fatal problems: the bytes are gone, something beside them is not. */
  warnings: Array<{ id: string; code: ArchivePurgeWarningCode }>
}

/** A non-fatal outcome of a purge: the entry is gone, or was left alone, for a reason beside the request. */
export type ArchivePurgeWarningCode =
  /** The projection-cache shard of a purged session could not be removed. */
  | 'projcache-cleanup-failed'
  /** A shard name holds something that is not a plain file; it was left alone. */
  | 'projcache-shard-not-a-file'
  /** A retention sweep skipped this row: the deletion instant in its metadata
   *  disagrees with the one in its own directory name, so nothing expired it. */
  | 'trash-time-mismatch'

/** A non-fatal outcome of /restore-deleted: the action worked, something beside it did not. */
export type ArchiveRestoreWarningCode =
  /** The sessions are back, but the emptied trash directory could not be removed. */
  | 'trash-cleanup-failed'
  /** The directory is back, but the archive record could not be re-created. */
  | 'archive-record-failed'
  /** This member was already at its original path: nothing was moved for it. */
  | 'trash-member-already-home'
  /** This member's payload is neither in the trash nor at its original path. */
  | 'trash-member-lost'

/** POST /restore-deleted response value. */
export interface ArchiveRestoreDeletedResult {
  /** Ids whose directory was moved back by THIS call AND whose archive record is
   *  restored. A restored entry returns every member it could move, so this can
   *  be longer than the requested list. */
  restored: string[]
  /** Ids left untouched, each with a reason. */
  skipped: ArchiveSkipped[]
  /** Non-fatal problems, each with a code the client words. */
  warnings: Array<{ id: string; code: ArchiveRestoreWarningCode }>
}

/** POST /prune response value. */
export interface ArchivePruneResult {
  /** Stale records removed from the registry's archive set. */
  pruned: number
  /** Archive-set size after the prune. */
  remaining: number
}

/** POST /restore response value. */
export interface ArchiveRestoreResult {
  /** Ids dropped from the archive set (the session is visible again). */
  restored: string[]
  /** Ids left untouched, each with a reason. `not-archived` is the normal one:
   *  a second click, or a session another window already restored. */
  skipped: ArchiveSkipped[]
}

/** GET /settings response value. */
export interface ArchiveSettingsView {
  /** What the retention sweep would use right now. */
  settings: ArchiveSettings
  /**
   * Whether the file on disk could not be used as it stands (absent is NOT
   * malformed: it is the first run, and the defaults are what it means). The page
   * says so, because a default the user did not choose must not look like one they
   * did — and nothing is written back over it.
   */
  malformed: boolean
  /** English diagnostic for logs; absent when the file was usable or absent. */
  detail?: string
}

/**
 * POST /sweep response value — the retention sweep's answer.
 *
 * Shape-compatible with `ArchivePurgeResult` where it matters (entries, bytes,
 * skips, warnings) because it IS the purge path, applied by age instead of by id.
 */
export interface ArchiveSweepResult {
  /** The tier the sweep applied; `0` means it did nothing by design. */
  retentionDays: number
  /** Entries removed for good. */
  purged: ArchiveTrashEntryRef[]
  /** Bytes the removals freed. */
  freedBytes: number
  /** Rows that could not be removed, each with a reason. */
  skipped: ArchiveSkipped[]
  /** Non-fatal problems beside the removal (a cache shard that would not go). */
  warnings: Array<{ id: string; code: ArchivePurgeWarningCode }>
}
