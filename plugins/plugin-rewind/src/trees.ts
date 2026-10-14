/**
 * The workspace snapshot store: a bounded, content-addressed copy of the
 * workspace as it stood at the START of a turn.
 *
 * ## Why this exists
 *
 * The two write waterfalls (`fs/write-intent` / `fs/edit-intent`) only see the
 * packages that dispatch them. Measured on this machine's own session logs,
 * those are 22.9% of tool calls; a shell command (`pwsh`, `run_code`), a shell
 * script the model ran, or an office renderer writes through its own handle and
 * passes through neither. A recall that ignored them put back the files it could
 * see and left the rest, reporting a clean success — on a real session, a recall
 * reported `restored: 6, removed: 8, unrestorable: []` while 27 shell calls in the
 * same range had just rewritten a sprite sheet and a `dist/` tree.
 *
 * Nothing can observe a shell command's writes as they happen, so the only sound
 * source for their before-image is a copy taken BEFORE the command ran. This
 * module takes one snapshot per turn, lazily, at the first tool call that could
 * write — a turn of pure chat or reads costs nothing.
 *
 * ## Shape
 *
 *   $DSH_HOME/storages/dsh-app-plugin-rewind/
 *     blobs/<sha256[0:2]>/<sha256>       content-addressed file bytes
 *     trees/<sessionId>/<turn>.json      one manifest per captured turn
 *
 * Content addressing is what keeps the cost sane: an unchanged file is one hash
 * per turn and no new bytes, so a snapshot of a settled tree is a small manifest
 * and nothing else. A manifest records `[hash, size, mtimeMs]` per file so a
 * capture and a diff can skip re-reading a file whose size and mtime are
 * untouched — the same bargain every sync tool makes, and its known blind spot
 * (a writer that restores an old mtime at an unchanged size) is the price.
 *
 * ## Bounds, and why they are reported rather than hidden
 *
 * A workspace can be arbitrarily large. The walk is bounded by file count, total
 * bytes, per-file bytes, a deadline AND the caller's abort signal, and a skipped
 * directory list (dependency/VCS/cache directories — never build output, which a
 * recall must be able to put back). When a bound is hit the snapshot is marked
 * INCOMPLETE and the recall says so.
 *
 * Incompleteness has one hard consequence, enforced here rather than left to a
 * caller: **an incomplete snapshot is never used to decide that a file was
 * created by the range.** A file the walk never reached is indistinguishable
 * from a file that did not exist, and treating the two alike would move the
 * user's file out of the workspace.
 *
 * For the same reason a file the walk SAW but could not copy (too large, an I/O
 * error, a symlink) goes into {@link TreeSnapshot.uncaptured}: it is known to
 * have existed, so it can never be mistaken for created, and a change to it is
 * reported as unrestorable instead of silently dropped.
 *
 * @module @dsh-app/plugin-rewind/trees
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** The bounds one workspace snapshot runs under. */
export interface TreeLimits {
  /** Stop the walk after this many files. */
  readonly maxFiles: number
  /** Stop the walk after this many bytes of file content. */
  readonly maxTotalBytes: number
  /** A file larger than this is recorded as uncovered, never copied. */
  readonly maxFileBytes: number
  /** Stop the walk after this long, whatever it has covered. */
  readonly maxWalkMs: number
  /** Directory names never descended into. */
  readonly skipDirs: readonly string[]
  /** How many per-turn manifests to keep for one session. */
  readonly maxSnapshotsPerSession: number
  /** Total bytes the blob store may hold before the oldest snapshots are dropped. */
  readonly maxBlobBytes: number
  /** How long a manifest is kept at all, whatever the caps say. */
  readonly maxManifestAgeMs: number
}

/**
 * Shipped bounds.
 *
 * The skip list holds dependency, VCS and cache directories only: everything
 * else is inside the promise, and `dist/`-style build output is deliberately
 * INCLUDED because a shell command regenerating it is exactly the case this
 * module exists for. A workspace over the caps degrades to a reported partial
 * snapshot instead of an unbounded copy.
 */
export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxWalkMs: 1500,
  skipDirs: [
    '.git', '.hg', '.svn',
    'node_modules', '.venv', 'venv', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.cache', '.turbo', '.parcel-cache', 'coverage',
  ],
  maxSnapshotsPerSession: 200,
  maxBlobBytes: 1024 * 1024 * 1024,
  maxManifestAgeMs: 30 * 24 * 60 * 60 * 1000,
}

/** One captured file: content hash, byte size, and mtime at capture time. */
type Entry = readonly [hash: string, size: number, mtimeMs: number]

/** Why a file the walk saw was not copied. */
export type UncapturedReason = 'too-large' | 'unreadable' | 'symlink'

/** A file the walk saw but could not copy, with the size and mtime it had. */
export interface Uncaptured {
  readonly size: number
  readonly mtimeMs: number
  readonly reason: UncapturedReason
}

/** One turn's workspace state. */
export interface TreeSnapshot {
  /** Manifest format version. */
  readonly v: 1
  /** Session this snapshot belongs to. */
  readonly sessionId: string
  /** The turn whose START this snapshot describes. */
  readonly turn: number
  /** When it was taken (epoch ms). */
  readonly at: number
  /** Absolute, canonical workspace root the relative paths are against. */
  readonly root: string
  /** Whether the walk covered the whole workspace within {@link TreeLimits}. */
  readonly complete: boolean
  /** Why it did not, when `complete` is false. */
  readonly reason?: string
  /** Relative (POSIX-separated) path → `[hash, size, mtimeMs]`. */
  readonly entries: Record<string, Entry>
  /**
   * Files known to have existed that could not be copied.
   *
   * Kept apart from `entries` because they can never be restored — only reported
   * when they change, and never mistaken for a file the range created.
   */
  readonly uncaptured: Record<string, Uncaptured>
}

/** A file the diff found changed, with the bytes to put back (null = created). */
export interface RestoreTarget {
  /** Absolute path. */
  readonly path: string
  /** Content to write back, or null when the range created the file. */
  readonly before: Buffer | null
}

/** What a diff of the current workspace against one snapshot found. */
export interface WorkspaceDiff {
  /** Files to put back. `before: null` means the range created it. */
  readonly restore: readonly RestoreTarget[]
  /**
   * Paths whose before-image is gone from the blob store, or whose stored bytes
   * do not hash to what the manifest names.
   *
   * Reported, never turned into a removal: a missing before-image says nothing
   * about whether the file was created by the range, and guessing "created"
   * there would move a file the user still has.
   */
  readonly missing: readonly string[]
  /**
   * Whether the removal set was suppressed.
   *
   * True when EITHER walk was incomplete: the snapshot's (a file it never
   * reached looks created) or this diff's own (a file the current walk never
   * reached looks deleted). Both are the same mistake in opposite directions, and
   * both would move a file the user has.
   */
  readonly removalsSuppressed: boolean
  /** Files that could not be copied whose size or mtime moved. */
  readonly uncapturedChanged: readonly string[]
  /**
   * Whether this snapshot decided one absolute path's state at the range start.
   *
   * False for a path outside the snapshot's root, under a skipped directory, or
   * too large to copy — exactly the paths a caller must fall back to the
   * write-waterfall recorder for.
   */
  coveredOf(path: string): boolean
}

/** The manifest root for one session's turns. */
export function treesRoot(dshHome: string, sessionId: string): string {
  return join(dshHome, 'storages', 'dsh-app-plugin-rewind', 'trees', sessionId)
}

/** The content-addressed blob root. */
export function blobsRoot(dshHome: string): string {
  return join(dshHome, 'storages', 'dsh-app-plugin-rewind', 'blobs')
}

/**
 * Hashes a capture is holding in memory right now.
 *
 * A capture stores its bytes BEFORE the manifest that references them, so a
 * collection running in that window would see them as orphans and delete them —
 * and the manifest written a moment later would name bytes that no longer exist.
 * An in-process set is exact; a time-based grace period is not (a blob that
 * already existed because another turn stored the same content keeps its OLD
 * mtime, so "recently written" says nothing about it).
 */
const inFlight = new Set<string>()

/** The manifest path for one turn. */
function manifestPath(dshHome: string, sessionId: string, turn: number): string {
  return join(treesRoot(dshHome, sessionId), `${String(turn)}.json`)
}

/** Content hash of one buffer, in hex. */
function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The key two spellings of one file share.
 *
 * A path reaches this plugin from two places that do not spell it the same way:
 * the write waterfall hands over the filesystem provider's canonical realpath,
 * while the snapshot builds its paths from the session's cwd. On Windows a
 * junction, a short (8.3) cwd or a differently cased drive letter makes those two
 * strings differ for ONE file — and a target list keyed by the raw string then
 * holds it twice, so a recall restores it twice and quarantines it twice.
 * Measured: one `write` to a temp workspace appeared as both
 * `…\ADMINI~1\…\app.ts` and `…\Administrator\…\app.ts`.
 *
 * This resolves `.`/`..` and folds case on Windows. It does NOT expand an 8.3
 * short name — that is what the `realpath` in {@link captureWorkspace} is for, and
 * it is why the stored root is canonical.
 *
 * @param path - any absolute or relative path.
 * @returns the comparison key for that path.
 */
export function pathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Absolute path of one blob. */
function blobPath(dshHome: string, hash: string): string {
  return join(blobsRoot(dshHome), hash.slice(0, 2), hash)
}

/** Store one buffer if it is not already stored, holding it against collection. */
async function putBlob(dshHome: string, bytes: Buffer): Promise<string> {
  const hash = hashOf(bytes)
  inFlight.add(hash)
  const path = blobPath(dshHome, hash)
  await mkdir(join(blobsRoot(dshHome), hash.slice(0, 2)), { recursive: true })
  try {
    // `wx` makes this a no-op when the content is already stored, which is the
    // common case: an unchanged file is never written twice.
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error
  }
  return hash
}

/**
 * Read one blob, verifying it against the hash the manifest names.
 *
 * The bytes on disk could have been written by a capture whose `stat` saw one
 * state and whose `read` saw another; a blob that does not hash to its own name
 * is not the before-image, and writing it back would be a wrong restore dressed
 * up as a right one.
 */
async function getBlob(dshHome: string, hash: string): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(blobPath(dshHome, hash))
    return hashOf(bytes) === hash ? bytes : undefined
  } catch {
    return undefined
  }
}

/** One file the walk found. */
interface Walked {
  readonly abs: string
  readonly size: number
  readonly mtimeMs: number
}

/** The outcome of walking a workspace. */
interface Walk {
  readonly files: Map<string, Walked>
  /** Files that were seen but cannot be copied, keyed by relative path. */
  readonly uncaptured: Map<string, Uncaptured>
  readonly complete: boolean
  readonly reason?: string
}

/**
 * Walk a workspace, bounded and pruned.
 *
 * Iterative rather than recursive so the deadline and the abort signal can be
 * honoured mid-walk, and so a deep tree cannot overflow the stack. Symlinks are
 * never followed: a link cycle would otherwise walk forever, and a link's target
 * is outside the workspace the snapshot promises to describe. A symlinked
 * directory marks the snapshot INCOMPLETE (its subtree was never looked at) and a
 * symlinked file goes into `uncaptured` (it existed, so it is never "created").
 *
 * @param root - absolute workspace root.
 * @param limits - the bounds to honour.
 * @param signal - the tool call's abort signal, when there is one.
 * @returns the files found, the files seen but not copied, and whether the walk
 *   was cut short and why.
 */
async function walkWorkspace(root: string, limits: TreeLimits, signal?: AbortSignal): Promise<Walk> {
  const files = new Map<string, Walked>()
  const uncaptured = new Map<string, Uncaptured>()
  const skip = new Set(limits.skipDirs)
  const deadline = Date.now() + limits.maxWalkMs
  let bytes = 0
  let reason: string | undefined
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (signal?.aborted === true) {
      reason = 'cancelled'
      break
    }
    if (Date.now() > deadline) {
      reason = 'timeout'
      break
    }
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // An unreadable directory is a hole in the snapshot, not a failure of it.
      reason ??= 'unreadable-directory'
      continue
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        // `readdir` never reports a link as a directory (a Windows junction is
        // `isSymbolicLink` and NOT `isDirectory`), so the target's kind has to come
        // from `stat`. Getting this wrong is how a linked subtree ends up neither
        // covered nor reported: the walk reports a clean tree it never entered.
        let info
        try {
          info = await stat(abs)
        } catch {
          uncaptured.set(rel, { size: 0, mtimeMs: 0, reason: 'symlink' })
          continue
        }
        if (info.isDirectory()) {
          reason ??= 'symlink'
          continue
        }
        uncaptured.set(rel, {
          size: info.size,
          mtimeMs: Math.trunc(info.mtimeMs),
          reason: 'symlink',
        })
        continue
      }
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (files.size >= limits.maxFiles) {
        reason = 'file-count'
        break
      }
      let info
      try {
        info = await stat(abs)
      } catch {
        uncaptured.set(rel, { size: 0, mtimeMs: 0, reason: 'unreadable' })
        continue
      }
      bytes += info.size
      if (bytes > limits.maxTotalBytes) {
        reason = 'total-bytes'
        break
      }
      files.set(rel, { abs, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
    }
    if (reason === 'file-count' || reason === 'total-bytes') break
  }
  return { files, uncaptured, complete: reason === undefined, ...(reason === undefined ? {} : { reason }) }
}

/**
 * Capture the workspace as it is now, for one turn.
 *
 * `previous` is the session's previous manifest, used only to skip re-reading a
 * file whose size and mtime are unchanged — the hash is carried forward, so a
 * settled tree costs one walk and no I/O per file.
 *
 * @param dshHome - resolved `$DSH_HOME`.
 * @param sessionId - the session the turn belongs to.
 * @param turn - the turn being opened.
 * @param root - absolute workspace root.
 * @param limits - the bounds to honour.
 * @param previous - the previous snapshot of this session, when there is one.
 * @param signal - the tool call's abort signal, when there is one.
 * @returns the manifest that was written.
 */
export async function captureWorkspace(
  dshHome: string,
  sessionId: string,
  turn: number,
  root: string,
  limits: TreeLimits,
  previous?: TreeSnapshot,
  signal?: AbortSignal,
): Promise<TreeSnapshot> {
  // The root is stored CANONICALIZED (realpath), because every path in the
  // manifest is built from it and they are compared against the write
  // waterfall's own canonical paths. See `pathKey` for the measured case.
  const canonical = await realpath(root).catch(() => root)
  const walk = await walkWorkspace(canonical, limits, signal)
  const entries: Record<string, Entry> = Object.create(null) as Record<string, Entry>
  const uncaptured: Record<string, Uncaptured> = Object.create(null) as Record<string, Uncaptured>
  for (const [rel, found] of walk.uncaptured) uncaptured[rel] = found
  const deadline = Date.now() + limits.maxWalkMs
  let reason = walk.reason
  try {
    for (const [rel, found] of walk.files) {
      if (reason === undefined && (signal?.aborted === true || Date.now() > deadline)) {
        // Hashing and storing is the other half of the walk's cost, and it needs
        // the same bounds: without this the "1500 ms" cap covered only the
        // directory scan.
        reason = signal?.aborted === true ? 'cancelled' : 'timeout'
      }
      if (found.size > limits.maxFileBytes) {
        uncaptured[rel] = { size: found.size, mtimeMs: found.mtimeMs, reason: 'too-large' }
        continue
      }
      const before = previous?.entries[rel]
      if (before !== undefined && before[1] === found.size && before[2] === found.mtimeMs) {
        entries[rel] = before
        continue
      }
      let bytes: Buffer
      try {
        bytes = await readFile(found.abs)
      } catch {
        // Seen, but not copyable: recorded as uncaptured rather than dropped. A
        // dropped entry is indistinguishable from "did not exist", and that
        // judgement moves the file out of the workspace.
        uncaptured[rel] = { size: found.size, mtimeMs: found.mtimeMs, reason: 'unreadable' }
        continue
      }
      entries[rel] = [await putBlob(dshHome, bytes), found.size, found.mtimeMs]
    }
  } finally {
    // Release the collection hold whatever happened; the manifest is written
    // below, and a capture that failed leaves real orphans for the next pass.
    inFlight.clear()
  }
  const snapshot: TreeSnapshot = {
    v: 1,
    sessionId,
    turn,
    at: Date.now(),
    root: canonical,
    complete: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    entries,
    uncaptured,
  }
  await writeManifest(dshHome, snapshot)
  return snapshot
}

/** Write one manifest, atomically, so a crash cannot leave a half file. */
async function writeManifest(dshHome: string, snapshot: TreeSnapshot): Promise<void> {
  const dir = treesRoot(dshHome, snapshot.sessionId)
  await mkdir(dir, { recursive: true })
  const path = manifestPath(dshHome, snapshot.sessionId, snapshot.turn)
  const temp = `${path}.tmp`
  await writeFile(temp, JSON.stringify(snapshot), 'utf8')
  await rename(temp, path)
}

/** Read one turn's manifest, or undefined when this turn was never captured. */
export async function readSnapshot(
  dshHome: string,
  sessionId: string,
  turn: number,
): Promise<TreeSnapshot | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(manifestPath(dshHome, sessionId, turn), 'utf8'),
    ) as TreeSnapshot
    if (parsed?.v !== 1 || typeof parsed.entries !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * The newest manifest strictly before one turn, when there is one.
 *
 * Used only to carry hashes forward: a file whose size and mtime are unchanged
 * since that manifest keeps its stored hash, so a capture re-reads only what
 * actually moved. Correctness never depends on finding one.
 *
 * @param dshHome - resolved `$DSH_HOME`.
 * @param sessionId - the session to look in.
 * @param turn - the turn being captured.
 * @returns the nearest earlier snapshot, or undefined.
 */
export async function latestSnapshotBefore(
  dshHome: string,
  sessionId: string,
  turn: number,
): Promise<TreeSnapshot | undefined> {
  let names: string[]
  try {
    names = await readdir(treesRoot(dshHome, sessionId))
  } catch {
    return undefined
  }
  const earlier = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => Number(name.slice(0, -'.json'.length)))
    .filter((candidate) => Number.isSafeInteger(candidate) && candidate < turn)
    .sort((a, b) => b - a)
  const nearest = earlier[0]
  return nearest === undefined ? undefined : readSnapshot(dshHome, sessionId, nearest)
}

/**
 * Diff the current workspace against one snapshot.
 *
 * A file whose size AND mtime are unchanged is assumed unchanged (the same
 * bargain every sync tool makes); anything else is hashed, so a rewrite that
 * happens to keep the size is still caught.
 *
 * @param snapshot - the state at the start of the range.
 * @param dshHome - resolved `$DSH_HOME`, for the blob store.
 * @param limits - the bounds the diff walk honours.
 * @param signal - the tool call's abort signal, when there is one.
 * @returns the files to put back, and what the diff could not decide.
 */
export async function diffWorkspace(
  snapshot: TreeSnapshot,
  dshHome: string,
  limits: TreeLimits,
  signal?: AbortSignal,
): Promise<WorkspaceDiff> {
  const walk = await walkWorkspace(snapshot.root, limits, signal)
  const restore: RestoreTarget[] = []
  const missing: string[] = []
  const uncapturedChanged: string[] = []
  const currentComplete = walk.complete

  for (const [rel, [hash, size, mtimeMs]] of Object.entries(snapshot.entries ?? {})) {
    const abs = join(snapshot.root, rel)
    const found = walk.files.get(rel)
    if (found === undefined) {
      // Not found. That means "deleted" only when the CURRENT walk was whole;
      // otherwise it may simply never have been reached, and rewriting it would
      // be a write nobody asked for.
      if (!currentComplete) continue
      const bytes = await getBlob(dshHome, hash)
      if (bytes === undefined) {
        missing.push(abs)
        continue
      }
      restore.push({ path: abs, before: bytes })
      continue
    }
    if (found.size !== size || found.mtimeMs !== mtimeMs) {
      let bytes: Buffer
      try {
        bytes = await readFile(found.abs)
      } catch {
        missing.push(abs)
        continue
      }
      if (hashOf(bytes) !== hash) {
        const before = await getBlob(dshHome, hash)
        if (before === undefined) {
          missing.push(abs)
          continue
        }
        restore.push({ path: abs, before })
      }
    }
  }

  for (const [rel, known] of Object.entries(snapshot.uncaptured ?? {})) {
    const found = walk.files.get(rel)
    // Gone as well as changed counts: the range deleted it, and its content was
    // never kept, so the recall cannot put it back.
    if (found === undefined || found.size !== known.size || found.mtimeMs !== known.mtimeMs) {
      uncapturedChanged.push(join(snapshot.root, rel))
    }
  }

  // A file the walk found that the snapshot does not know about was created
  // inside the range — but ONLY when BOTH walks were whole. See the module
  // header: an incomplete walk cannot tell "new" from "never looked at", and
  // guessing there moves a user's file.
  const removalsSuppressed = !snapshot.complete || !currentComplete
  if (!removalsSuppressed) {
    for (const rel of walk.files.keys()) {
      if (Object.hasOwn(snapshot.entries ?? {}, rel) || Object.hasOwn(snapshot.uncaptured ?? {}, rel)) continue
      restore.push({ path: join(snapshot.root, rel), before: null })
    }
  }

  return {
    restore,
    missing,
    removalsSuppressed,
    uncapturedChanged,
    coveredOf(path: string): boolean {
      const rel = relative(snapshot.root, path).split(sep).join('/')
      if (rel === '' || rel.startsWith('..') || rel.includes(':')) return false
      if (Object.hasOwn(snapshot.uncaptured ?? {}, rel)) return false
      if (Object.hasOwn(snapshot.entries ?? {}, rel)) return true
      // Present now and unknown to the snapshot: created inside the range. That
      // is a decision about this path only when both walks were complete.
      return !removalsSuppressed && walk.files.has(rel)
    },
  }
}

/**
 * Drop the manifests for turns that are no longer on the surface, then collect
 * the blobs nothing references any more.
 *
 * Called after a recall: those turns are gone from the model's view, so their
 * snapshots can never be a restore target again. Content addressing means a blob
 * shared with a live turn survives.
 *
 * @param dshHome - resolved `$DSH_HOME`.
 * @param sessionId - the session whose turns were recalled.
 * @param turns - the turns to drop.
 */
export async function dropSnapshots(dshHome: string, sessionId: string, turns: readonly number[]): Promise<void> {
  for (const turn of turns) {
    try {
      await rm(manifestPath(dshHome, sessionId, turn), { force: true })
    } catch {
      /* nothing to drop */
    }
  }
  await collectGarbage(dshHome)
}

/**
 * Enforce the per-session retention cap, then collect what that orphaned.
 *
 * A long session captures one manifest per mutating turn, so without this the
 * store grows without bound. The newest manifests win; the oldest are dropped,
 * and a recall reaching further back than the cap then reports a partial snapshot
 * rather than pretending.
 *
 * @param dshHome - resolved `$DSH_HOME`.
 * @param sessionId - the session to prune.
 * @param limits - the retention bounds.
 */
export async function pruneSnapshots(
  dshHome: string,
  sessionId: string,
  limits: TreeLimits,
): Promise<void> {
  const turns = await manifestTurns(dshHome, sessionId)
  const excess = turns.slice(0, Math.max(0, turns.length - limits.maxSnapshotsPerSession))
  for (const turn of excess) {
    await rm(manifestPath(dshHome, sessionId, turn), { force: true })
  }
  await collectGarbage(dshHome)
}

/** The turns this session has a manifest for, ascending. */
async function manifestTurns(dshHome: string, sessionId: string): Promise<number[]> {
  try {
    return (await readdir(treesRoot(dshHome, sessionId)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.slice(0, -'.json'.length)))
      .filter((turn) => Number.isSafeInteger(turn))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

/** One manifest, as the collector reads it. */
interface ManifestRef {
  readonly path: string
  readonly at: number
  readonly hashes: readonly string[]
}

/**
 * Delete what nothing needs any more: manifests past their age, manifests the
 * blob budget forces out, and every blob no surviving manifest references.
 *
 * This is the ONE place the store is trimmed, and it is deliberately
 * conservative in one direction only: dropping a manifest costs a recall the
 * ability to put that turn back (which the recall then REPORTS), while deleting a
 * live blob would cost a file its content.
 *
 * @param dshHome - resolved `$DSH_HOME`.
 * @param limits - the retention bounds.
 */
export async function collectGarbage(dshHome: string, limits: TreeLimits = DEFAULT_TREE_LIMITS): Promise<void> {
  const treesDir = join(dshHome, 'storages', 'dsh-app-plugin-rewind', 'trees')
  const manifests: ManifestRef[] = []
  let sessions: string[]
  try {
    sessions = await readdir(treesDir)
  } catch {
    return
  }
  for (const session of sessions) {
    let names: string[]
    try {
      names = await readdir(join(treesDir, session))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(treesDir, session, name)
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as TreeSnapshot
        manifests.push({
          path,
          at: typeof parsed.at === 'number' ? parsed.at : 0,
          hashes: Object.values(parsed.entries ?? {}).map((entry) => entry[0]),
        })
      } catch {
        /* an unreadable manifest references nothing we can trust */
      }
    }
  }

  // Age first: a session nobody opens again must not pin its blobs forever.
  const cutoff = Date.now() - limits.maxManifestAgeMs
  const live: ManifestRef[] = []
  for (const manifest of manifests) {
    if (manifest.at < cutoff) {
      try {
        await rm(manifest.path, { force: true })
      } catch {
        live.push(manifest)
      }
      continue
    }
    live.push(manifest)
  }

  // Then the budget: measure the store, and drop the oldest snapshots until it
  // fits. Manifests are dropped whole, so this never leaves a half-described turn.
  const root = blobsRoot(dshHome)
  let prefixes: string[]
  try {
    prefixes = await readdir(root)
  } catch {
    return
  }
  const blobs = new Map<string, { path: string; size: number }>()
  let total = 0
  for (const prefix of prefixes) {
    let hashes: string[]
    try {
      hashes = await readdir(join(root, prefix))
    } catch {
      continue
    }
    for (const hash of hashes) {
      const path = join(root, prefix, hash)
      try {
        const info = await stat(path)
        blobs.set(hash, { path, size: info.size })
        total += info.size
      } catch {
        /* vanished under us; the next pass decides */
      }
    }
  }
  const referenced = new Map<string, number>()
  for (const manifest of live) {
    for (const hash of manifest.hashes) referenced.set(hash, (referenced.get(hash) ?? 0) + 1)
  }
  if (total > limits.maxBlobBytes) {
    for (const manifest of [...live].sort((a, b) => a.at - b.at)) {
      if (total <= limits.maxBlobBytes) break
      try {
        await rm(manifest.path, { force: true })
      } catch {
        continue
      }
      live.splice(live.indexOf(manifest), 1)
      for (const hash of manifest.hashes) {
        const count = (referenced.get(hash) ?? 0) - 1
        if (count <= 0) {
          referenced.delete(hash)
          total -= blobs.get(hash)?.size ?? 0
        } else {
          referenced.set(hash, count)
        }
      }
    }
  }

  for (const [hash, blob] of blobs) {
    if (referenced.has(hash) || inFlight.has(hash)) continue
    try {
      await rm(blob.path, { force: true })
    } catch {
      /* try again on the next collection */
    }
  }
}
