/**
 * The session trash: the holding area `/delete` moves a session's log directory
 * into, so a deletion can be undone.
 *
 * Layout, under the plugin's own storage directory in the harness home:
 *
 *     $DSH_HOME/storages/dsh-app-plugin-archives/trash/<trashId>/metadata.json
 *     $DSH_HOME/storages/dsh-app-plugin-archives/trash/<trashId>/payload/<n>/
 *
 * `<trashId>` is `<epochMillis>-<uuid first 8>`. `payload/<n>` holds ONE moved
 * member (a session's log directory, exactly as it sat under the sessions
 * root); `<n>` is its index in `metadata.members`, as a plain numeric string.
 *
 * ## The one rule: the disk is the only truth, the metadata only names things
 *
 * Every decision in this module is made from {@link probePath}, which answers
 * three things, never two:
 *
 *     'present'  the path is there (lstat succeeded)
 *     'absent'   the path is PROVEN not to be there (ENOENT / ENOTDIR)
 *     'unknown'  lstat failed for any other reason — EACCES, EPERM, EBUSY
 *
 * `unknown` is not `absent`. An antivirus or the indexer holding a directory is
 * the everyday cause of EPERM here, and code that reads "I could not look" as "it
 * is not there" deletes the only copy of a session: it rolls a member back, fails
 * to see it, and then removes the entry that still holds the payload.
 *
 * `metadata.json` therefore contributes IDENTITY and LABELS — the session id, the
 * title, the original path, the slot number, the size the list showed — and never
 * a verdict. How many members the metadata DECLARES says nothing about how many
 * are in the trash, so no decision below counts declared members:
 *
 *   - a move only starts from a source proven PRESENT;
 *   - a member counts as back at its original path only with positive proof
 *     (original PRESENT and its payload slot ABSENT);
 *   - a restore moves the members whose slot is PRESENT, reports an ABSENT slot
 *     for what it is (back home, or lost), and refuses the whole entry when any
 *     slot is UNKNOWN — the payload's completeness cannot be confirmed, and a
 *     half-restored batch is not a state this module produces;
 *   - an entry directory is only DISCARDED once no member's payload is in it any
 *     more: a failed move has to prove every member home first, and a restore only
 *     drops the entry after it has moved — or proven absent — every slot it found.
 *
 * `unknown` never authorizes releasing data, and never on its own stops a safe
 * action on a DIFFERENT member: one unreadable slot must not make the rest of the
 * batch unreachable, which is what the cross-member refusal above is careful to
 * limit to the one act (a restore) that has to be all-or-nothing anyway.
 *
 * Two supporting rules follow from the same idea:
 *
 *   - what an entry reports as its members is what is on disk, not what its
 *     metadata claims: a listing proves each slot and hides the members that are
 *     proven gone, so a stale metadata line can never make a purge delete the
 *     wrong session;
 *   - a restore requires a sessions root to fence against, right now. There is no
 *     flag in the metadata that can weaken that (see the next section), and the
 *     question "can this entry be restored" is therefore answered when a request
 *     is answered ({@link planRestore}) rather than stored in a listing.
 *
 * ## One address per row, and two ways to name it
 *
 * A trash id is a row's own identity — the directory name it lives under — and it
 * addresses the whole entry. A session id addresses one member, and does so only
 * while that member's payload is proven PRESENT: naming a member whose slot is
 * ABSENT names nothing (it is not here), and naming one whose slot is UNKNOWN is
 * refused with a retryable code, because an irreversible act cannot be authorized
 * by "I could not look".
 *
 * Every route accepts both, which is what makes the two halves agree: a row that
 * can be LISTED can always be cleared, including the ones whose members are all
 * gone and the ones whose metadata cannot be read at all — their directory name
 * is the handle.
 *
 * ## Two-phase metadata: an entry exists before anything moves
 *
 * A crash between "the last member moved" and "the metadata was written" would
 * leave a `payload/` full of session logs inside a directory nothing could name.
 * The metadata is therefore written TWICE: `state: 'moving'` (the full member
 * list) before the first rename, and `state: 'ready'` after every rename has been
 * verified. The state is DIAGNOSTIC: whether an entry can be restored is decided
 * by its payload alone, because a failed commit must not strand a session that is
 * sitting right there in the trash.
 *
 * ## Containment is a real-path question, and the fenced path is the moved path
 *
 * `path.relative` answers the cheap half: a sibling whose name merely starts with
 * the root's (`C:\sessions-evil` beside `C:\sessions`) is not inside, a different
 * drive is not inside, and a Windows drive-letter case or a mixed separator
 * spelling is not a mismatch. It cannot see a junction or symlink.
 *
 * `assertContained` resolves both sides (`realpath` for the existing prefix, the
 * missing tail re-joined) and compares there. The string it checked is the SAME
 * string the caller then renames: every move and every restore resolves its path
 * once, up front, and uses that resolved spelling for the check, the probe and the
 * rename. Checking `resolve(p)` while renaming `p` is how a `link/../name`
 * spelling can pass the fence on POSIX — where the kernel follows `link` before
 * applying `..` — and then move something outside the root.
 *
 * **Residual risk, stated rather than papered over:** Node has no
 * rename-by-handle, so a component can be re-pointed between the check and the
 * `rename`. The window is one directory-entry operation and needs an attacker who
 * can already write inside the sessions root, but it is not closed here.
 *
 * ## Deletion starts by taking the entry out of service
 *
 * A purge renames the entry to `<trashId>.purging` before it touches the payload,
 * so a delete that dies halfway leaves something no restore can ever offer as a
 * session whose log is only half there. The leftover is LISTED (see
 * {@link listEntries}) rather than hidden: its bytes are on disk, and "delete for
 * good" retries the removal.
 *
 * ## Removal is retried, within a bound
 *
 * Every directory this module removes goes through `./fs-util.ts`'s `rmWithRetry`:
 * on Windows an EPERM/EBUSY/EACCES is what an indexer holding a handle for a
 * moment, and a read-only attribute, both look like, and neither is a durable
 * answer. The retry clears read-only attributes and backs off exponentially inside
 * a bounded budget (five attempts, two seconds); what survives that budget is
 * reported, never looped on.
 *
 * ## One filesystem object
 *
 * The `fs/promises` surface is called through one namespace object rather than
 * through named imports. That is what lets the failure-path tests substitute a
 * single `rename` and reproduce states a healthy filesystem cannot be asked to
 * produce on demand — a rollback that fails, a rename that reports success
 * without moving anything, a slot that cannot be looked at. Production never
 * substitutes it.
 *
 * @module @dsh-app/plugin-archives/trash
 */

import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rmWithRetry } from './fs-util.ts'
import type { ArchiveTrashRestoreBlock } from './types.ts'

/** Metadata file name inside one entry directory. */
const METADATA_FILE = 'metadata.json'

/** Payload directory name inside one entry directory. */
const PAYLOAD_DIR = 'payload'

/** The metadata layout this module writes and reads. */
const METADATA_VERSION = 1

/** Suffix of a directory that is being purged: no longer an entry, not yet gone. */
const PURGING_SUFFIX = '.purging'

/**
 * The ids whose on-disk directory name is the id itself: upstream
 * `encodeSegment` leaves exactly this character set literal and escapes `~`
 * plus everything outside it. Anything else is refused, never guessed at —
 * the encoder exists precisely because a SessionId is unvalidated.
 *
 * Shared with the route layer, which uses it for its own directory-lookup
 * fallback.
 */
export const SESSION_ID_SEGMENT = /^[A-Za-z0-9._-]+$/

/** `<epochMillis>-<8 hex>`, the shape this module mints. */
const TRASH_ID = /^\d{1,16}-[0-9a-f]{8}$/

/** A payload slot is a plain numeric string, never a path. */
const PAYLOAD_SLOT = /^\d{1,9}$/

/** Whether an entry's move finished. Diagnostic only: restorability is the payload's. */
export type TrashEntryState = 'moving' | 'ready'

/** One member of a trash entry: the session whose directory was moved. */
export interface TrashMember {
  /** Session id (also the moved directory's own name under the sessions root). */
  readonly sessionId: string
  /** Projection-cached title at delete time; empty when none was generated. */
  readonly title: string
  /** Absolute directory the member came from — where a restore puts it back. */
  readonly originalPath: string
  /** Numeric slot inside `payload/`. */
  readonly payload: string
  /** Shallow byte size measured before the move (what the archive list showed). */
  readonly sizeBytes: number
  /**
   * `false` only for a session that was never in the archive set when it was
   * moved — a subagent child riding along with its root (see `./tree.ts`).
   *
   * A restore re-creates the archive record of every member it puts back, which is
   * right for a root and wrong for a child: archiving a child would HIDE it, when
   * what the tree needs is for it to come back exactly as it was found. `absent`
   * means archived (every entry written before this field existed held only
   * archived sessions, so the old default is the correct one and no metadata
   * version has to move).
   */
  readonly archived?: boolean
}

/** One trash entry: everything one `/delete` call moved. */
export interface TrashEntry {
  readonly version: typeof METADATA_VERSION
  /** `moving` until every member is moved and verified; `ready` after that.
   *  Diagnostic only — see the module header. */
  readonly state: TrashEntryState
  readonly trashId: string
  /** ISO-8601 instant the entry was created (the trash listing sorts on it). */
  readonly deletedAt: string
  /**
   * Diagnostic note: the backend exposed no sessions root, so `originalPath`
   * came from its own log resolver. It is NEVER a fence input — a restore is
   * fenced by the root the current call can see, and is refused when there is
   * none (see {@link restoreEntry}).
   */
  readonly rootUnknown?: true
  readonly members: readonly TrashMember[]
}

/** A member the caller wants moved into a new entry. */
export interface TrashMemberSource {
  readonly sessionId: string
  readonly title: string
  /** Absolute path of the session's own log directory. */
  readonly dirPath: string
  readonly sizeBytes: number
  /** Pass `false` for a session that is NOT in the archive set — a subagent child
   *  riding along with its root. Absent means archived (see {@link TrashMember}). */
  readonly archived?: boolean
}

/** A non-fatal problem a caller must report without calling the action failed. */
export interface TrashWarning {
  /** Stable code the client words in its own language. */
  readonly code: 'trash-cleanup-failed'
  /** English diagnostic for logs; never shown as a sentence. */
  readonly detail: string
}

/** Stable failure codes of this module. */
export type TrashErrorCode =
  /** The move crossed a filesystem boundary; refused, never copied. */
  | 'trash-cross-device'
  /** A restore found the original path already occupied. */
  | 'trash-target-exists'
  /** A path is not really inside the sessions root; nothing was moved. */
  | 'trash-path-outside-root'
  /** A session id or trash id does not have the accepted shape. */
  | 'trash-invalid-id'
  /** A member is not a plain directory that can be proven present. */
  | 'trash-invalid-member'
  /** The named entry directory is gone. */
  | 'trash-entry-missing'
  /** The filesystem would not say what a payload slot or a restore target holds,
   *  so nothing could be confirmed. Retry. */
  | 'trash-state-unconfirmed'
  /** A restore was asked for while no sessions root is available to fence it. */
  | 'trash-restore-needs-root'
  /** A member rename or a metadata write failed. */
  | 'trash-move-failed'
  /** A rename reported success while leaving the directory where it was. */
  | 'trash-concurrent-move'
  /** A rename's outcome could not be established (the filesystem would not say). */
  | 'trash-move-unconfirmed'
  /** A failed move could not be rolled back: the payload is still in the trash. */
  | 'trash-rollback-failed'
  /** The entry was taken out of service but not all of its bytes could be deleted. */
  | 'trash-purge-failed'

/** A trash operation failure carrying a stable code and, when relevant, the entry it left behind. */
export class TrashError extends Error {
  constructor(
    readonly code: TrashErrorCode,
    message: string,
    options?: {
      cause?: unknown
      /** The entry this failure left on disk, if it left one. */
      trashId?: string
      /** Session ids still parked in that entry. */
      stuckIds?: readonly string[]
    },
  ) {
    super(message, { cause: options?.cause })
    this.name = 'TrashError'
    this.trashId = options?.trashId
    this.stuckIds = options?.stuckIds
  }

  /** The entry this failure left on disk, if it left one. */
  readonly trashId: string | undefined

  /** Session ids still parked in that entry. */
  readonly stuckIds: readonly string[] | undefined
}

/** The `code` of a `TrashError`, or undefined for anything else. */
export function trashErrorCode(error: unknown): TrashErrorCode | undefined {
  return error instanceof TrashError ? error.code : undefined
}

/**
 * Whether `target` is strictly inside `root` (a pure string question).
 *
 * `path.relative` answers this for the platform's own path rules: on Windows a
 * different drive yields an absolute result, and a case or separator difference
 * in the drive letter and the shared prefix is normalized away instead of
 * becoming a false mismatch. The root itself is not "inside" itself, and an
 * absolute result (a different volume) is never inside.
 *
 * This is the FIRST fence only — it cannot see a junction or symlink. Use
 * {@link assertContained} for a decision that has to hold on disk.
 * @param root - absolute containment root.
 * @param target - absolute candidate path.
 * @returns true only for a strict descendant.
 */
export function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** `realpath`, or the resolved spelling when the path (or a parent) does not exist. */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await fsp.realpath(path)
  } catch {
    return resolve(path)
  }
}

/** The deepest ancestor of `path` that exists on disk (`path` itself when it does). */
async function deepestExistingAncestor(path: string): Promise<string> {
  let current = resolve(path)
  for (;;) {
    try {
      await fsp.lstat(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

/**
 * One canonical spelling of a path, whether or not it exists yet.
 *
 * The existing part is resolved through `realpath` (junctions, symlinks and the
 * 8.3 short form a Windows temp directory may spell itself in); the missing tail
 * is re-joined onto that resolved ancestor. Using this on BOTH sides is what
 * makes a comparison meaningful: `realpath` of the sessions root returns the long
 * form while a not-yet-existing sibling would otherwise still carry the short
 * form, and every check would report a false mismatch.
 * @param path - absolute path to canonicalize.
 * @returns the canonical spelling, with the missing suffix re-joined.
 */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path)
  try {
    return await fsp.realpath(resolved)
  } catch {
    // Expected for a restore target that does not exist yet.
  }
  const ancestor = await deepestExistingAncestor(resolved)
  const realAncestor = await realpathOrSelf(ancestor)
  const suffix = relative(ancestor, resolved)
  return suffix === '' ? realAncestor : join(realAncestor, suffix)
}

/**
 * Refuse a path that is not really inside `root`.
 *
 * Two fences: the lexical one, then the canonical one. The lexical check is
 * allowed to pass on EITHER spelling of the root, so a short/long form difference
 * is not reported as an escape; the canonical check is what a junction or symlink
 * cannot fool, because the whole existing prefix is resolved before comparing.
 *
 * The caller must pass the same string it is about to operate on (see the module
 * header): this function decides about the spelling it is given, so giving it a
 * different spelling than the `rename` uses is a bug in the caller.
 *
 * The check and the caller's `rename` are two operations: a component can be
 * re-pointed in between (see the module header).
 * @param root - absolute containment root.
 * @param target - absolute candidate path, existing or not.
 * @throws {TrashError} with `trash-path-outside-root`.
 */
export async function assertContained(root: string, target: string): Promise<void> {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const realRoot = await canonicalPath(rootPath)
  if (!isStrictlyInside(rootPath, targetPath) && !isStrictlyInside(realRoot, targetPath)) {
    throw new TrashError('trash-path-outside-root', `refusing ${targetPath}: not inside ${rootPath}`)
  }
  const realTarget = await canonicalPath(targetPath)
  if (!isStrictlyInside(realRoot, realTarget)) {
    throw new TrashError('trash-path-outside-root', `refusing ${targetPath}: resolves outside ${rootPath}`)
  }
}

/**
 * Reject an id whose directory name could escape a path join.
 * @param id - session id from a request or from metadata.
 * @returns the id, when it is acceptable.
 * @throws {TrashError} with `trash-invalid-id`.
 */
function assertSessionId(id: string): string {
  if (id === '.' || id === '..' || !SESSION_ID_SEGMENT.test(id)) {
    throw new TrashError('trash-invalid-id', `refusing session id ${JSON.stringify(id)}: not a literal path segment`)
  }
  return id
}

/**
 * Reject a trash id that is not one this module mints (it is a path segment).
 * @param id - trash id.
 * @returns the id, when it is acceptable.
 * @throws {TrashError} with `trash-invalid-id`.
 */
function assertTrashId(id: string): string {
  if (!TRASH_ID.test(id)) {
    throw new TrashError('trash-invalid-id', `refusing trash id ${JSON.stringify(id)}: not a minted entry name`)
  }
  return id
}

/**
 * What the filesystem says about one path — the three answers every destructive
 * decision in this module is built on.
 *
 * `'absent'` is only returned for ENOENT/ENOTDIR: the filesystem has positively
 * said the path is not there. Every other failure (EACCES, EPERM, EBUSY, EIO…) is
 * `'unknown'`, which callers must treat as "it may still be there".
 */
export type Probe = 'present' | 'absent' | 'unknown'

/** Whether a `lstat` failure is positive evidence of absence. */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Probe a path's presence.
 * @param path - absolute path.
 * @returns `present`, `absent` (proven), or `unknown` (the filesystem would not say).
 */
export async function probePath(path: string): Promise<Probe> {
  try {
    await fsp.lstat(path)
    return 'present'
  } catch (error) {
    return isAbsence(error) ? 'absent' : 'unknown'
  }
}

/**
 * Probe a path's presence AS A PLAIN DIRECTORY (a symlink or junction is not one:
 * moving it would move the pointer, not the session).
 * @param path - absolute path.
 * @returns `present` only for a directory, `absent` for "not there or not a
 *   directory", `unknown` when the filesystem would not say.
 */
export async function probeDirectory(path: string): Promise<Probe> {
  try {
    return (await fsp.lstat(path)).isDirectory() ? 'present' : 'absent'
  } catch (error) {
    return isAbsence(error) ? 'absent' : 'unknown'
  }
}

/**
 * Recursively sum the regular files under one directory.
 *
 * Symbolic links contribute nothing and are never followed: the number is used
 * to report what a purge freed, and following a link would measure (and later
 * delete through) something outside the tree.
 * @param dir - absolute directory.
 * @returns byte total; 0 for an unreadable directory.
 */
async function treeSize(dir: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await treeSize(path)
    } else if (entry.isFile()) {
      try {
        total += (await fsp.stat(path)).size
      } catch {
        // raced removal: contribute nothing
      }
    }
  }
  return total
}

/**
 * Write one entry's metadata atomically: a sibling temp file, then a rename.
 *
 * `rename` replaces an existing file on both platforms this app ships on, which
 * is what makes the second write (`moving` → `ready`) an atomic replace rather
 * than a delete-then-create window.
 * @param entryDir - absolute entry directory.
 * @param entry - metadata to persist.
 * @throws {TrashError} with `trash-move-failed` when the write or rename fails.
 */
async function writeMetadata(entryDir: string, entry: TrashEntry): Promise<void> {
  const target = join(entryDir, METADATA_FILE)
  const temp = join(entryDir, `${METADATA_FILE}.tmp-${randomUUID().slice(0, 8)}`)
  try {
    await fsp.writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await fsp.rename(temp, target)
  } catch (error) {
    try { await fsp.unlink(temp) } catch { /* the temp may never have been created */ }
    throw new TrashError('trash-move-failed', `could not write ${target}`, { cause: error })
  }
}

/** Parse one metadata object, returning undefined for anything malformed. */
function parseEntry(raw: unknown, dirName: string): TrashEntry | undefined {
  const value = raw as Partial<TrashEntry> | null
  if (value === null || typeof value !== 'object') return undefined
  if (value.version !== METADATA_VERSION) return undefined
  if (typeof value.trashId !== 'string' || value.trashId !== dirName) return undefined
  if (typeof value.deletedAt !== 'string' || Number.isNaN(Date.parse(value.deletedAt))) return undefined
  // A first-phase write says `moving`; anything else complete says `ready`.
  const state: TrashEntryState | undefined = value.state === 'moving'
    ? 'moving'
    : value.state === 'ready' || value.state === undefined ? 'ready' : undefined
  if (state === undefined) return undefined
  if (!Array.isArray(value.members) || value.members.length === 0) return undefined
  const members: TrashMember[] = []
  for (const candidate of value.members as unknown[]) {
    const member = candidate as Partial<TrashMember> | null
    if (member === null || typeof member !== 'object') return undefined
    if (typeof member.sessionId !== 'string' || member.sessionId === '.' || member.sessionId === '..') return undefined
    if (!SESSION_ID_SEGMENT.test(member.sessionId)) return undefined
    if (typeof member.title !== 'string') return undefined
    if (typeof member.originalPath !== 'string' || !isAbsolute(member.originalPath)) return undefined
    if (typeof member.payload !== 'string' || !PAYLOAD_SLOT.test(member.payload)) return undefined
    if (typeof member.sizeBytes !== 'number' || !Number.isFinite(member.sizeBytes) || member.sizeBytes < 0) return undefined
    members.push({
      sessionId: member.sessionId,
      title: member.title,
      originalPath: member.originalPath,
      payload: member.payload,
      sizeBytes: member.sizeBytes,
      // Absent means archived: every entry written before this field existed held
      // only archived sessions, so reading an old file has to answer "archived".
      ...(member.archived === false ? { archived: false } : {}),
    })
  }
  return {
    version: METADATA_VERSION,
    state,
    trashId: value.trashId,
    deletedAt: value.deletedAt,
    ...(value.rootUnknown === true ? { rootUnknown: true as const } : {}),
    members,
  }
}

/**
 * Read one entry's metadata.
 * @param entryDir - absolute entry directory.
 * @param trashId - the identity the metadata must carry; defaults to the
 *   directory's own name, and is passed explicitly for a `.purging` leftover,
 *   whose directory name carries the suffix but whose metadata does not.
 * @returns the entry, or undefined when the directory holds no readable, valid metadata.
 */
async function readEntryAt(entryDir: string, trashId: string = basename(entryDir)): Promise<TrashEntry | undefined> {
  let text: string
  try {
    text = await fsp.readFile(join(entryDir, METADATA_FILE), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return parseEntry(parsed, trashId)
}

/** One entry as a listing classifies it, judged by the payload on disk. */
export interface ListedEntry {
  readonly entry: TrashEntry
  /** Session ids whose payload slot is PROVEN present. */
  readonly present: readonly string[]
  /** Session ids whose slot the filesystem would not describe: neither present nor absent. */
  readonly unreadable: readonly string[]
  /**
   * Session ids this entry may still hold: `present` plus `unreadable`.
   *
   * This is the set a second MOVE is refused against, and the only thing it is
   * for. It never authorizes an irreversible act — that needs `present` (see
   * {@link lookupPurgeTarget}) — because "I could not look" is not "it is here".
   */
  readonly held: readonly string[]
  /**
   * At least one member's payload is proven present, so a restore has something
   * to put back.
   *
   * Deliberately NOT "the entry is restorable": whether a restore would actually
   * run depends on the sessions root the request can see, and that is answered
   * per request by {@link planRestore}. An entry whose metadata declares two
   * members while one is already home is restorable — it restores the one that is
   * still here and says so about the other.
   */
  readonly restorable: boolean
}

/** A trash directory that is not a restorable entry. */
export interface TrashLeftover {
  /** Entry identity, recovered from the directory name. */
  readonly trashId: string
  /** The directory name on disk (the trash id, with the purging suffix when there is one). */
  readonly dirName: string
  /**
   * What this directory is:
   *   - `purging` — a deletion that did not finish: `<trashId>.purging` is still on disk;
   *   - `unverified` — a directory named a minted trash id whose metadata cannot be
   *     read. Nothing can be restored from it (the metadata holds the original
   *     paths), and its name is the only handle it has left — which is exactly why
   *     it is listed and why `/purge` accepts its trash id.
   */
  readonly kind: 'purging' | 'unverified'
  /** Sort key: the metadata's instant when readable, else the id's own epoch prefix. */
  readonly deletedAt: string
  /** Bytes still occupied. */
  readonly bytes: number
  /** Sessions the metadata names, when it is still readable. */
  readonly members: readonly TrashMember[]
}

/** Everything the trash root holds. */
export interface TrashListing {
  /** Readable entries, newest first. */
  readonly entries: readonly ListedEntry[]
  /** Unfinished deletions, newest first. */
  readonly leftovers: readonly TrashLeftover[]
}

/** The epoch prefix every minted trash id starts with. */
function trashIdInstant(trashId: string): string {
  const epoch = Number(trashId.split('-')[0])
  return new Date(Number.isFinite(epoch) ? epoch : 0).toISOString()
}

/**
 * List everything the trash root holds, newest first.
 *
 * A malformed or unreadable entry is REPORTED as an `unverified` leftover rather
 * than skipped: its bytes are on disk, its directory name is a minted trash id,
 * and a directory nothing lists is a directory no request can clear. (Skipping it
 * was the silent residue this panel exists to avoid.) A `<trashId>.purging`
 * directory is reported as a `purging` leftover, so an unfinished deletion is
 * visible and retryable instead of becoming invisible bytes.
 *
 * Every entry is classified against the payload on disk rather than trusted: a
 * member whose slot is proven absent is dropped from what the entry reports, a
 * slot the filesystem will not describe is reported as `unreadable`, and the
 * entry is restorable as soon as ONE member's payload is proven present — the
 * count of members the metadata declares never enters the answer.
 * @param root - absolute trash root.
 * @returns the entries and leftovers, newest first.
 */
export async function listEntries(root: string): Promise<TrashListing> {
  let names: string[]
  try {
    names = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No trash root yet: an empty trash, not a failure.
    return { entries: [], leftovers: [] }
  }
  const entries: ListedEntry[] = []
  const leftovers: TrashLeftover[] = []
  for (const name of names) {
    if (name.endsWith(PURGING_SUFFIX)) {
      const trashId = name.slice(0, -PURGING_SUFFIX.length)
      if (!TRASH_ID.test(trashId)) continue
      const dir = join(root, name)
      const metadata = await readEntryAt(dir, trashId)
      leftovers.push({
        trashId,
        dirName: name,
        kind: 'purging',
        deletedAt: metadata?.deletedAt ?? trashIdInstant(trashId),
        bytes: await treeSize(dir),
        members: metadata?.members ?? [],
      })
      continue
    }
    if (!TRASH_ID.test(name)) continue
    const entryDir = join(root, name)
    const entry = await readEntryAt(entryDir)
    if (entry === undefined) {
      // A minted id whose metadata cannot be read. It is not an entry (nothing can
      // be restored from it) and it is certainly still on disk.
      leftovers.push({
        trashId: name,
        dirName: name,
        kind: 'unverified',
        deletedAt: trashIdInstant(name),
        bytes: await treeSize(entryDir),
        members: [],
      })
      continue
    }
    const present: string[] = []
    const unreadable: string[] = []
    for (const member of entry.members) {
      const slot = await probeDirectory(join(entryDir, PAYLOAD_DIR, member.payload))
      if (slot === 'present') present.push(member.sessionId)
      else if (slot === 'unknown') unreadable.push(member.sessionId)
    }
    entries.push({
      entry,
      present,
      unreadable,
      held: [...present, ...unreadable],
      restorable: present.length > 0,
    })
  }
  entries.sort((a, b) => {
    const delta = Date.parse(b.entry.deletedAt) - Date.parse(a.entry.deletedAt)
    return delta !== 0 ? delta : b.entry.trashId.localeCompare(a.entry.trashId)
  })
  leftovers.sort((a, b) => {
    const delta = Date.parse(b.deletedAt) - Date.parse(a.deletedAt)
    return delta !== 0 ? delta : b.dirName.localeCompare(a.dirName)
  })
  return { entries, leftovers }
}

/**
 * The entry one address names, if the trash holds it.
 *
 * Two addresses, one answer: a trash id names the row itself (whatever its
 * payload looks like, including an entry whose members are all gone), and a
 * session id names the member whose payload is proven PRESENT. A session id
 * whose slot is proven absent names nothing — the session is not here — and a
 * slot the filesystem would not describe is not a match either: a restore needs
 * to read that slot before it may move anything.
 * @param listing - a listing from {@link listEntries}.
 * @param id - a trash id, or a session id whose payload is present.
 * @returns the holding entry, or undefined.
 */
export function entryForAddress(listing: TrashListing, id: string): ListedEntry | undefined {
  const byTrashId = listing.entries.find((candidate) => candidate.entry.trashId === id)
  if (byTrashId !== undefined) return byTrashId
  return listing.entries.find((candidate) => candidate.present.includes(id))
}

/** Where a purge should delete: one entry, or one unfinished deletion. */
export interface PurgeTarget {
  /** Entry identity. */
  readonly trashId: string
  /** The directory to remove, already out of the restorable namespace. */
  readonly dirName: string
  /** ISO-8601 instant, for the response. */
  readonly deletedAt: string
  /** Session ids this deletion ends (informational: what the entry may hold). */
  readonly ids: readonly string[]
}

/**
 * What one purge address resolves to — three answers, because `unknown` is not
 * `not-in-trash`. Reporting a slot the filesystem would not describe as "no such
 * entry" told the caller its data was gone when nobody had established that.
 */
export type PurgeLookup =
  /** Something to delete. */
  | { readonly kind: 'target'; readonly target: PurgeTarget }
  /** The address names a member whose slot could not be inspected; retry. */
  | { readonly kind: 'refused'; readonly code: TrashErrorCode; readonly detail: string }
  /** The address names nothing in the trash. */
  | { readonly kind: 'none' }

/**
 * Resolve a purge request id to what it may delete.
 *
 * **A purge is the only irreversible act in this module, so it is authorized by
 * positive evidence and by nothing else.** Which evidence depends on what the
 * address asserts:
 *
 *   - a SESSION id asserts that this member's payload is still here. Only a slot
 *     proven PRESENT may answer it. A slot proven ABSENT does not match (the
 *     session is back home; its bytes are not the trash's to free), and a slot
 *     the filesystem would not describe is REFUSED, not matched — reading "I
 *     could not look" as "it may be there, delete it" is how a member that went
 *     home once became a handle for deleting a different member's payload.
 *   - a TRASH id asserts that this ROW is here, which is a fact the listing has
 *     already proven by reading the directory. What the purge then deletes is
 *     exactly that directory, so this is also the answer for a row whose members
 *     are all gone and for one whose metadata cannot be read at all: without it,
 *     a row that can be listed had no request that could clear it.
 *   - a `.purging` leftover is RESUMED, not authorized: its deletion already
 *     started, and its directory name is the only handle it may have left;
 *   - an `unverified` leftover — a minted trash id whose metadata cannot be read —
 *     is matched by its directory name for the same reason, and it is the ONLY
 *     handle it has: nothing in it says which sessions it holds.
 * @param listing - a listing from {@link listEntries}.
 * @param id - a trash id, or a session id whose payload is present.
 * @returns what to delete, why it was refused, or nothing.
 */
export function lookupPurgeTarget(listing: TrashListing, id: string): PurgeLookup {
  const byTrashId = listing.entries.find((candidate) => candidate.entry.trashId === id)
  if (byTrashId !== undefined) {
    return {
      kind: 'target',
      target: {
        trashId: byTrashId.entry.trashId,
        dirName: byTrashId.entry.trashId,
        deletedAt: byTrashId.entry.deletedAt,
        ids: byTrashId.held,
      },
    }
  }
  const byMember = listing.entries.find((candidate) => candidate.present.includes(id))
  if (byMember !== undefined) {
    return {
      kind: 'target',
      target: {
        trashId: byMember.entry.trashId,
        dirName: byMember.entry.trashId,
        deletedAt: byMember.entry.deletedAt,
        ids: byMember.held,
      },
    }
  }
  const leftover = listing.leftovers.find((candidate) => candidate.trashId === id
    || candidate.members.some((member) => member.sessionId === id))
  if (leftover !== undefined) {
    return {
      kind: 'target',
      target: {
        trashId: leftover.trashId,
        dirName: leftover.dirName,
        deletedAt: leftover.deletedAt,
        ids: leftover.members.map((member) => member.sessionId),
      },
    }
  }
  const unreadable = listing.entries.find((candidate) => candidate.unreadable.includes(id))
  if (unreadable !== undefined) {
    return {
      kind: 'refused',
      code: 'trash-state-unconfirmed',
      detail: `trash entry ${unreadable.entry.trashId} cannot be purged by session id ${id}: `
        + 'its payload slot could not be inspected, so nothing positive says what would be freed',
    }
  }
  return { kind: 'none' }
}

/** Remove an entry directory, best effort.
 *
 * Through {@link rmWithRetry} like every other removal here: an emptied entry
 * whose removal failed is a cleanup problem, never a failed caller, and on
 * Windows the first attempt is allowed to hit a handle the indexer holds.
 */
async function discardEntry(entryDir: string): Promise<void> {
  try { await rmWithRetry(entryDir) } catch { /* best effort */ }
}

/** The outcome of settling a move that failed partway. */
interface SettledFailure {
  /** Session ids still parked in the trash. */
  readonly stuckIds: string[]
  /** The entry kept on disk, when something is still parked. */
  readonly kept: TrashEntry | undefined
}

/**
 * Put back whatever can be put back after a failed move, and keep what cannot.
 *
 * A member counts as home only with POSITIVE proof: its original path is present
 * AND its payload slot is gone. Anything else — a failed rename, a slot the
 * filesystem will not let us look at — leaves the member "stuck", and a stuck
 * member means the entry directory is KEPT. Reading "I could not look" as "it is
 * not there" is the bug this function exists to not have.
 *
 * If anything is still parked, the entry is kept and its metadata is rewritten to
 * name exactly those members. The rewrite is best effort: what the entry reports
 * to a caller is computed from the payload on disk anyway ({@link listEntries}),
 * so a failed rewrite can never make a purge target the wrong session.
 * @param entryDir - absolute entry directory.
 * @param payloadDir - absolute payload directory inside it.
 * @param moved - members whose rename was issued.
 * @param entry - the phase-A metadata (the full member list).
 * @returns what is still parked, if anything.
 */
async function settleFailedMove(
  entryDir: string,
  payloadDir: string,
  moved: readonly TrashMember[],
  entry: TrashEntry,
): Promise<SettledFailure> {
  const isHome = async (member: TrashMember): Promise<boolean> => {
    const original = await probePath(member.originalPath)
    if (original !== 'present') return false
    return (await probeDirectory(join(payloadDir, member.payload))) === 'absent'
  }
  const stuck: TrashMember[] = []
  for (const member of [...moved].reverse()) {
    const slot = join(payloadDir, member.payload)
    // Only positive absence lets us skip the attempt: an unreadable slot may
    // still hold the session, so moving it back is worth trying anyway.
    if ((await probeDirectory(slot)) !== 'absent') {
      try {
        await fsp.mkdir(dirname(member.originalPath), { recursive: true })
        await fsp.rename(slot, member.originalPath)
      } catch {
        // Verified below either way: the proof decides, not the return value.
      }
    }
    if (!(await isHome(member))) stuck.push(member)
  }
  if (stuck.length === 0) {
    // Nothing of ours is parked here any more, so the entry directory holds only
    // metadata and empty slots: removing it loses no session.
    await discardEntry(entryDir)
    return { stuckIds: [], kept: undefined }
  }
  const kept: TrashEntry = {
    ...entry,
    state: 'moving',
    members: entry.members.filter((member) => stuck.some((candidate) => candidate.sessionId === member.sessionId)),
  }
  try { await writeMetadata(entryDir, kept) } catch { /* the listing reads the disk, not this file */ }
  return { stuckIds: kept.members.map((member) => member.sessionId), kept }
}

/**
 * Move one batch of session directories into a new trash entry.
 *
 * Every member is validated before anything moves: a refused member means the
 * whole call fails with nothing touched. The entry's metadata is written before
 * the first rename (so a crash cannot orphan the payload), every rename is
 * verified with the probes, and a failure anywhere settles through
 * {@link settleFailedMove}.
 *
 * Each member's path is resolved ONCE and that same spelling is validated and
 * renamed, so the fence can never describe a different path than the move touches.
 * @param input.root - absolute trash root.
 * @param input.sessionsRoot - absolute sessions root every member must sit under;
 *   omitted when the backend exposes none, in which case each member must at
 *   least be an absolute directory named after its session.
 * @param input.members - the directories to move; at least one.
 * @returns the persisted entry.
 * @throws {TrashError} with a stable code.
 */
export async function moveToTrash(input: {
  root: string
  sessionsRoot?: string
  members: readonly TrashMemberSource[]
}): Promise<TrashEntry> {
  if (input.members.length === 0) {
    throw new TrashError('trash-invalid-id', 'a trash entry needs at least one member')
  }
  const rootUnknown = input.sessionsRoot === undefined
  const sources = input.members.map((member) => ({ member, source: resolve(member.dirPath) }))
  for (const { member, source } of sources) {
    assertSessionId(member.sessionId)
    if (!isAbsolute(member.dirPath)) {
      throw new TrashError('trash-path-outside-root', `refusing to move ${member.dirPath}: not an absolute path`)
    }
    if (input.sessionsRoot === undefined) {
      // No root to fence against: the backend's own resolver named this path, so
      // the strongest check left is that it is the session's own directory.
      if (basename(source) !== member.sessionId) {
        throw new TrashError(
          'trash-path-outside-root',
          `refusing to move ${source}: its name is not the session id ${member.sessionId}`,
        )
      }
    } else {
      await assertContained(input.sessionsRoot, source)
    }
    // Only a directory proven present is a session artifact. A link would be
    // moved as a link, leaving the directory it points at behind.
    const state = await probeDirectory(source)
    if (state !== 'present') {
      throw new TrashError(
        'trash-invalid-member',
        state === 'absent'
          ? `refusing to move ${source}: not a plain directory`
          : `refusing to move ${source}: the filesystem would not say whether it is a directory`,
      )
    }
  }

  const now = Date.now()
  const trashId = `${now}-${randomUUID().slice(0, 8)}`
  const entryDir = join(input.root, trashId)
  const payloadDir = join(entryDir, PAYLOAD_DIR)
  await fsp.mkdir(payloadDir, { recursive: true })

  const entry: TrashEntry = {
    version: METADATA_VERSION,
    state: 'moving',
    trashId,
    deletedAt: new Date(now).toISOString(),
    ...(rootUnknown ? { rootUnknown: true as const } : {}),
    members: sources.map(({ member, source }, index) => ({
      sessionId: member.sessionId,
      title: member.title,
      originalPath: source,
      payload: String(index),
      sizeBytes: member.sizeBytes,
      // Only the "not archived" case is persisted: an absent field is the common
      // case and the meaning a reader of an older entry has to get right anyway.
      ...(member.archived === false ? { archived: false } : {}),
    })),
  }
  // Phase A: the entry is on disk — and listable — before anything moves.
  try {
    await writeMetadata(entryDir, entry)
  } catch (error) {
    await discardEntry(entryDir)
    throw error
  }

  // Phase B: move every member. Phase C: prove each one landed, and that its
  // original path is gone. `rename` reporting success is not proof — see the
  // module header on concurrent deletes and on unreadable slots.
  const moved: TrashMember[] = []
  let failure: TrashError | undefined
  for (const member of entry.members) {
    const slot = join(payloadDir, member.payload)
    try {
      await fsp.rename(member.originalPath, slot)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      failure = code === 'EXDEV'
        ? new TrashError('trash-cross-device', `the trash and ${member.originalPath} are on different filesystems; a cross-device move is not supported`, { cause: error })
        : new TrashError('trash-move-failed', `could not move ${member.originalPath} into the trash`, { cause: error })
      break
    }
    moved.push(member)
    const landed = await probeDirectory(slot)
    const source = await probePath(member.originalPath)
    if (landed === 'present' && source === 'absent') continue
    failure = landed === 'unknown' || source === 'unknown'
      ? new TrashError(
        'trash-move-unconfirmed',
        `could not confirm where ${member.sessionId} went: ${landed === 'unknown' ? 'its payload slot' : 'its original path'} could not be inspected`,
      )
      : new TrashError(
        'trash-concurrent-move',
        `moving ${member.sessionId} reported success but ${
          landed === 'present' ? 'its original directory is still there' : 'its payload slot is missing'
        }; another delete of the same session probably won`,
      )
    break
  }

  if (failure !== undefined) {
    const settled = await settleFailedMove(entryDir, payloadDir, moved, entry)
    if (settled.kept !== undefined) {
      throw new TrashError(
        'trash-rollback-failed',
        `the move failed and ${settled.stuckIds.length} session(s) could not be put back; they are still in trash entry ${
          join(input.root, trashId)
        } (${settled.stuckIds.join(', ')}). Cause: ${failure.message}`,
        { cause: failure, trashId, stuckIds: settled.stuckIds },
      )
    }
    throw new TrashError(
      failure.code,
      `${failure.message} (nothing was moved; trash entry ${trashId} was removed)`,
      { cause: failure, trashId },
    )
  }

  // Phase D: record that the move finished. The state is diagnostic — the entry is
  // restorable from its payload alone — so a failure here keeps the entry and
  // reports the sessions as parked rather than undoing a complete move.
  const ready: TrashEntry = { ...entry, state: 'ready' }
  try {
    await writeMetadata(entryDir, ready)
  } catch (error) {
    throw new TrashError(
      'trash-move-failed',
      `the sessions are in trash entry ${join(input.root, trashId)} but its state could not be recorded: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error, trashId, stuckIds: entry.members.map((member) => member.sessionId) },
    )
  }
  return ready
}

/** One member whose payload is proven present and whose original path is proven free. */
export interface PlannedMove {
  readonly member: TrashMember
  /** The absolute, resolved spelling that is fenced AND moved. */
  readonly target: string
}

/**
 * Why a restore cannot run at all, decided before anything is touched.
 *
 * `target-exists` is here because a restore refuses the whole entry over it, but
 * it is a SITUATION at the target rather than a missing capability: the occupant
 * can be deleted, so a listing does not hide the restore action over it.
 */
export interface RestoreBlock {
  /** The block, in the vocabulary the client words. */
  readonly code: ArchiveTrashRestoreBlock | 'target-exists'
  /** English diagnostic for logs. */
  readonly detail: string
}

/**
 * What a restore of one entry would do, decided from the disk and from the
 * sessions root THIS call can see.
 *
 * One function answers both questions on purpose: whether the row may offer a
 * restore (GET /trash) and what a restore request will do. Two implementations
 * of the same rules is how a row came to offer an action it could never
 * complete.
 */
export interface RestorePlan {
  /** Set when nothing may move; every list below is then what was gathered so far. */
  readonly blocked?: RestoreBlock
  /** Members to move back: payload proven PRESENT, target proven free. */
  readonly moving: readonly PlannedMove[]
  /** Members whose payload slot is ABSENT and whose original path is PRESENT. */
  readonly alreadyHome: readonly string[]
  /** Members whose payload slot is ABSENT and whose original path is not there either. */
  readonly lost: readonly string[]
}

/**
 * Plan a restore of one entry against the root this call can see.
 *
 * The members are classified one at a time from disk, and the metadata's declared
 * count never enters the answer:
 *
 *   - slot ABSENT — the member is not in the trash. Its original path decides
 *     between "already home" (report it, do not fail: nothing was lost) and
 *     "lost" (the payload is gone from both places, which the caller must say);
 *   - slot UNKNOWN — the whole restore is refused with a retryable code. "I could
 *     not look" cannot confirm the payload is complete, and a restore that moved
 *     the readable half of a batch would leave the entry unusable;
 *   - slot PRESENT — the target is fenced (`assertContained`), then probed: an
 *     occupied target refuses the entry, an unreadable one refuses it as
 *     unconfirmed, and a free one joins `moving`.
 *
 * `unknown` blocking here is the one place it blocks a multi-member act, and it
 * is deliberate: a restore IS an all-or-nothing move of the batch.
 * @param input.entry - the entry's metadata.
 * @param input.entryDir - that entry's absolute directory.
 * @param input.sessionsRoot - absolute sessions root to fence against, or
 *   undefined when the backend exposes none.
 * @returns the plan; nothing has been written or moved.
 */
export async function planRestore(input: {
  entry: TrashEntry
  entryDir: string
  sessionsRoot: string | undefined
}): Promise<RestorePlan> {
  /** Nothing planned, and nothing moved: fresh arrays, so no caller can share them. */
  const empty = (): { moving: PlannedMove[]; alreadyHome: string[]; lost: string[] } => ({
    moving: [],
    alreadyHome: [],
    lost: [],
  })
  if (input.sessionsRoot === undefined) {
    return {
      ...empty(),
      blocked: {
        code: 'needs-root',
        detail: 'a restore needs the sessions root it is fenced against, and this backend exposes none right now',
      },
    }
  }
  const payloadDir = join(input.entryDir, PAYLOAD_DIR)
  const states: Array<{ member: TrashMember; target: string; slot: Probe }> = []
  for (const member of input.entry.members) {
    // Resolve once, validate that spelling, then move exactly that spelling.
    states.push({
      member,
      target: resolve(member.originalPath),
      slot: await probeDirectory(join(payloadDir, member.payload)),
    })
  }
  const unconfirmed = states.find((state) => state.slot === 'unknown')
  if (unconfirmed !== undefined) {
    return {
      ...empty(),
      blocked: {
        code: 'unconfirmed',
        detail: `the payload slot of ${unconfirmed.member.sessionId} could not be inspected`,
      },
    }
  }
  const plan = empty()
  for (const { member, target, slot } of states) {
    if (slot === 'absent') {
      // Not in the trash: the original path is the only witness left.
      if ((await probePath(target)) === 'present') plan.alreadyHome.push(member.sessionId)
      else plan.lost.push(member.sessionId)
      continue
    }
    try {
      await assertContained(input.sessionsRoot, target)
    } catch (error) {
      if (trashErrorCode(error) !== 'trash-path-outside-root') throw error
      return {
        ...plan,
        blocked: {
          code: 'outside-root',
          detail: `refusing to restore ${target}: it does not resolve inside ${input.sessionsRoot}`,
        },
      }
    }
    const occupied = await probePath(target)
    if (occupied === 'present') {
      return { ...plan, blocked: { code: 'target-exists', detail: `refusing to restore ${target}: it already exists` } }
    }
    if (occupied === 'unknown') {
      return {
        ...plan,
        blocked: {
          code: 'unconfirmed',
          detail: `refusing to restore ${target}: the filesystem would not say whether it is free`,
        },
      }
    }
    plan.moving.push({ member, target })
  }
  return plan
}

/** The stable error one blocked restore raises. */
function restoreBlockError(block: RestoreBlock): TrashError {
  switch (block.code) {
    case 'needs-root':
      return new TrashError('trash-restore-needs-root', block.detail)
    case 'outside-root':
      return new TrashError('trash-path-outside-root', block.detail)
    case 'target-exists':
      return new TrashError('trash-target-exists', block.detail)
    case 'no-payload':
      return new TrashError('trash-entry-missing', block.detail)
    case 'unconfirmed':
    default:
      return new TrashError('trash-state-unconfirmed', block.detail)
  }
}

/** What a restore did, member by member. */
export interface RestoreOutcome {
  /** The entry as its metadata named it. */
  readonly entry: TrashEntry
  /** Session ids whose directory THIS call moved back. */
  readonly restored: readonly string[]
  /** Session ids already at their original path: nothing was moved for them, and
   *  nothing was lost. */
  readonly alreadyHome: readonly string[]
  /** Session ids whose payload is neither in the trash nor at its original path. */
  readonly lost: readonly string[]
  /** Non-fatal problems (the emptied entry directory could not be removed). */
  readonly warnings: TrashWarning[]
}

/**
 * Move the members of one entry that are still in it back to their original
 * paths, and drop the entry.
 *
 * A restore needs a sessions root RIGHT NOW: it is a move out of the trash into
 * whatever `metadata.json` says, and that file can be edited. There is no flag in
 * it that can weaken this — an entry recorded without a root is still fenced by
 * the root this call can see, and refused when there is none.
 *
 * What moves is what {@link planRestore} proves is here: a member whose slot is
 * ABSENT is reported (`alreadyHome`, or `lost` when its original path is gone
 * too) instead of being treated as a reason to refuse the batch. An occupied
 * target, a recorded path outside the root, or a slot the filesystem will not
 * describe still refuses the whole entry with nothing touched. A move that fails
 * partway puts the members already restored back into the payload, so an entry is
 * either fully restored or still intact.
 *
 * Removing the emptied entry directory is best-effort: whatever was in it is back
 * where it belongs by then (or was never there), and a leftover directory is a
 * cleanup problem, not a failed restore.
 * @param input.root - absolute trash root.
 * @param input.sessionsRoot - absolute sessions root every member must return under.
 * @param input.trashId - the entry to restore.
 * @returns what moved, what was already home, what is lost, and any warning.
 * @throws {TrashError} with a stable code.
 */
export async function restoreEntry(input: {
  root: string
  sessionsRoot: string | undefined
  trashId: string
}): Promise<RestoreOutcome> {
  assertTrashId(input.trashId)
  if (input.sessionsRoot === undefined) {
    throw new TrashError(
      'trash-restore-needs-root',
      'a restore needs the sessions root it is fenced against, and this backend exposes none right now',
    )
  }
  const entryDir = join(input.root, input.trashId)
  const entry = await readEntryAt(entryDir)
  if (entry === undefined) {
    throw new TrashError('trash-entry-missing', `no readable trash entry ${input.trashId}`)
  }
  const plan = await planRestore({ entry, entryDir, sessionsRoot: input.sessionsRoot })
  if (plan.blocked !== undefined) throw restoreBlockError(plan.blocked)

  const payloadDir = join(entryDir, PAYLOAD_DIR)
  const moved: PlannedMove[] = []
  const rollback = async (): Promise<void> => {
    for (const { member, target } of [...moved].reverse()) {
      try {
        await fsp.mkdir(payloadDir, { recursive: true })
        await fsp.rename(target, join(payloadDir, member.payload))
      } catch {
        // Same as a failed move rollback: report the original failure only.
      }
    }
  }
  for (const move of plan.moving) {
    try {
      // The project directory under the sessions root may itself be gone (a
      // project whose every session was deleted and whose directory was cleaned
      // up); a restore recreates it rather than failing on ENOENT.
      await fsp.mkdir(dirname(move.target), { recursive: true })
      await fsp.rename(join(payloadDir, move.member.payload), move.target)
    } catch (error) {
      await rollback()
      const code = (error as { code?: unknown }).code
      if (code === 'EXDEV') {
        throw new TrashError('trash-cross-device', `could not restore ${move.target} across filesystems`, { cause: error })
      }
      throw new TrashError('trash-move-failed', `could not restore ${move.target}`, { cause: error })
    }
    moved.push(move)
  }

  const warnings: TrashWarning[] = []
  try {
    await rmWithRetry(entryDir)
  } catch (error) {
    warnings.push({
      code: 'trash-cleanup-failed',
      detail: `the sessions are restored, but the emptied entry ${entry.trashId} could not be removed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }
  return {
    entry,
    restored: moved.map((move) => move.member.sessionId),
    alreadyHome: plan.alreadyHome,
    lost: plan.lost,
    warnings,
  }
}

/**
 * Delete a purge target for good and report what it freed.
 *
 * The target stops being an entry BEFORE its payload is touched: the directory is
 * renamed to `<trashId>.purging`, which no listing accepts as restorable. A delete
 * that fails halfway — Windows EBUSY from an indexer is the everyday cause —
 * therefore leaves a visible leftover (see {@link listEntries}) and never a
 * session whose log is only half there. The removal itself goes through
 * {@link rmWithRetry}, so the first attempt is allowed to hit a handle that is
 * about to be released.
 * @param input.root - absolute trash root.
 * @param input.target - what to delete, from {@link lookupPurgeTarget}.
 * @returns bytes the target occupied (recursive measure taken before removal).
 * @throws {TrashError} with a stable code.
 */
export async function purgeEntry(input: { root: string; target: PurgeTarget }): Promise<{ freedBytes: number }> {
  const { root, target } = input
  assertTrashId(target.trashId)
  const purgingName = `${target.trashId}${PURGING_SUFFIX}`
  if (target.dirName !== target.trashId && target.dirName !== purgingName) {
    throw new TrashError('trash-invalid-id', `refusing to purge ${JSON.stringify(target.dirName)}: not this entry's directory`)
  }
  const source = join(root, target.dirName)
  const purgingDir = join(root, purgingName)
  if ((await probePath(source)) === 'absent') {
    throw new TrashError('trash-entry-missing', `nothing left at ${source}`)
  }
  if (source !== purgingDir) {
    try {
      await fsp.rename(source, purgingDir)
    } catch (error) {
      // A leftover from an earlier failed purge of the same entry is the only
      // thing that can be in the way, and it is this entry's own garbage.
      if ((await probePath(purgingDir)) === 'absent') {
        throw new TrashError('trash-purge-failed', `could not take ${source} out of service`, { cause: error, trashId: target.trashId })
      }
      // This entry's OWN garbage is in the way. Clearing it is part of the same
      // deletion, so a failure here is the same stable code, not a raw errno.
      try {
        await rmWithRetry(purgingDir)
      } catch (staleError) {
        throw new TrashError(
          'trash-purge-failed',
          `could not clear the leftover ${purgingDir} that blocks ${source}`,
          { cause: staleError, trashId: target.trashId },
        )
      }
      await fsp.rename(source, purgingDir)
    }
  }
  const freedBytes = await treeSize(join(purgingDir, PAYLOAD_DIR))
  try {
    await rmWithRetry(purgingDir)
  } catch (error) {
    throw new TrashError(
      'trash-purge-failed',
      `could not delete all of ${purgingDir}; the rest stays there, out of service, and can be retried`,
      { cause: error, trashId: target.trashId },
    )
  }
  if ((await probePath(purgingDir)) !== 'absent') {
    throw new TrashError('trash-purge-failed', `${purgingDir} survived its own removal`, { trashId: target.trashId })
  }
  return { freedBytes }
}
