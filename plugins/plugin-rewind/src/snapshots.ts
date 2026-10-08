/**
 * File snapshots for a recall: the before-image of every file a turn changed.
 *
 * ## What this can and cannot see
 *
 * The host gives a plugin two pre-write waterfalls — `fs/write-intent` and
 * `fs/edit-intent` — and exactly two packages dispatch them:
 * `dsh-tool-fs` (`write`, `edit`) and `dsh-tool-str-replace-editor`. Measured on
 * this machine's own session logs, those are 3481 of 15196 tool calls (22.9%).
 *
 * A shell command that creates, moves, rewrites or deletes a file (`pwsh`,
 * `run_code`) never passes through here — 4772 calls (31.4%) — and neither does
 * any tool that writes through its own fs handle. Those changes are invisible to
 * this module by construction, and the restore step must say so rather than
 * pretend the tree was put back.
 *
 * ## Why a quarantine instead of undo
 *
 * Nothing is ever deleted. A restored file's CURRENT bytes are moved into the
 * quarantine directory before the before-image is written back, and a file the
 * recalled turn CREATED is moved there too instead of being unlinked. That keeps
 * the recall itself reversible: a wrong recall is recoverable by hand, and a file
 * the user changed during the turn is not lost. Deleting would make an
 * already-destructive action irreversible, which is the one thing a feature like
 * this must not do.
 *
 * @module @dsh-app/plugin-rewind/snapshots
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One file's state before a change, keyed to the turn that changed it. */
export interface Snapshot {
  /** Absolute path of the changed file. */
  readonly path: string
  /**
   * The file's content before the change, or `null` when it did not exist.
   *
   * `null` is how a CREATED file is recorded: restoring it means moving it out of
   * the way, not writing anything back.
   */
  readonly before: string | null
}

/**
 * A cap on one captured before-image.
 *
 * A write tool can be pointed at a large file, and a snapshot is held in memory
 * until the turn ends. Past this size the change is recorded as UNRESTORABLE
 * rather than silently truncated — a half-image written back would corrupt the
 * file it was meant to restore.
 */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

/** The outcome of looking at one file before a change. */
export type CaptureResult =
  | { readonly kind: 'captured', readonly before: string | null }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreadable', readonly reason: string }

/**
 * Read a file's content for a snapshot.
 *
 * An absent file is `captured` with `before: null` — that is the "this turn
 * created it" case, not an error. Any other read failure is reported rather than
 * guessed at, because a snapshot that is silently wrong is worse than none.
 *
 * @param path - absolute path of the file the write is about to change.
 * @returns what was captured, or why nothing was.
 */
export async function captureBefore(path: string): Promise<CaptureResult> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { kind: 'unreadable', reason: 'not a regular file' }
    if (info.size > MAX_SNAPSHOT_BYTES) return { kind: 'too-large' }
    return { kind: 'captured', before: await readFile(path, 'utf8') }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return { kind: 'captured', before: null }
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** One change the restore could not put back, with the reason. */
export interface Unrestorable {
  readonly path: string
  readonly reason: string
}

/**
 * The quarantine root for one session.
 *
 * Under `$DSH_HOME/storages/` with the rest of this suite's state
 * (`plugin-hooks/src/index.ts` is the pattern), so it is profile-independent and
 * survives a reinstall. It is NOT inside the workspace on purpose: a quarantine
 * the user's own tooling might delete is not a safety net.
 *
 * @param dshHome - the resolved `$DSH_HOME`.
 * @param sessionId - the session whose recall is being quarantined.
 * @returns the directory to place quarantined files under.
 */
export function quarantineRoot(dshHome: string, sessionId: string): string {
  return join(dshHome, 'storages', 'dsh-app-plugin-rewind', 'quarantine', sessionId)
}

/** A timestamp that sorts and reads as a wall clock, for one quarantine slot. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/**
 * One quarantined slot's manifest.
 *
 * Written beside the displaced bytes because the slot's NAME cannot carry the
 * facts a manager needs: it holds a timestamp and a hash, which is enough to keep
 * two same-second slots apart and nothing else. Without this file a user looking
 * at the quarantine sees `replaced` and cannot tell which project, let alone which
 * file, it came from.
 */
export interface QuarantineManifest {
  /** Absolute path the content was displaced from. */
  readonly originalPath: string
  /** What the slot holds: the file a recall REPLACED, or the one it CREATED. */
  readonly kind: 'replaced' | 'created'
  /** When the recall ran (epoch ms). */
  readonly at: number
}

/** The manifest's file name inside one slot. */
export const MANIFEST_NAME = 'manifest.json'

/**
 * Restore one file to a snapshot, quarantining what is there now.
 *
 * The order is deliberate: the CURRENT bytes move into the quarantine FIRST, so a
 * failure between the two steps leaves the original safe rather than lost. The
 * before-image is then written back as a direct write (not a rename) so a
 * cross-device quarantine root cannot fail the restore.
 *
 * ## Why nothing here renames
 *
 * The quarantine lives under `$DSH_HOME`, which is on a different volume from the
 * workspace on a very ordinary setup (this machine: `$DSH_HOME` on `C:`, the
 * project on `D:`). `rename` across volumes fails with `EXDEV`, so a "move it into
 * the quarantine" written as a rename works only when both happen to share a
 * drive — and fails silently for a created file, which is exactly the case that
 * has no other path. Everything here is therefore read + write + unlink, which
 * behaves the same on one volume and on two.
 *
 * The unlink is the ONE delete this plugin performs, and it runs only after the
 * content is safely written to the quarantine: a crash between the two leaves a
 * duplicate, never a loss.
 *
 * @param snapshot - the captured before-image.
 * @param quarantineDir - where displaced content is kept.
 * @param now - clock for the quarantine slot name.
 * @returns a description of what happened, for the report.
 */
export async function restoreOne(
  snapshot: Snapshot,
  quarantineDir: string,
  now: number,
): Promise<{ readonly kind: 'restored' | 'removed' | 'failed', readonly reason?: string, readonly slot?: string }> {
  const slot = join(quarantineDir, `${stamp(now)}-${Math.abs(hash(snapshot.path))}`)
  try {
    const current = await captureBefore(snapshot.path)
    if (current.kind === 'unreadable') return { kind: 'failed', reason: current.reason }
    if (current.kind === 'too-large') {
      return { kind: 'failed', reason: 'the current file is too large to quarantine safely' }
    }
    const present = current.before
    await mkdir(slot, { recursive: true })

    const writeManifest = (kind: QuarantineManifest['kind']): Promise<void> =>
      writeFile(
        join(slot, MANIFEST_NAME),
        JSON.stringify({ originalPath: snapshot.path, kind, at: now } satisfies QuarantineManifest),
        'utf8',
      )

    if (snapshot.before === null) {
      // The turn created it. Its content is copied OUT and only then unlinked:
      // nothing is destroyed before a copy exists, and no rename is involved (see
      // the module note on `EXDEV`).
      if (present === null) return { kind: 'removed' }
      await writeFile(join(slot, 'created'), present, 'utf8')
      await writeManifest('created')
      await rm(snapshot.path, { force: true })
      return { kind: 'removed', slot }
    }

    if (present !== null) {
      await writeFile(join(slot, 'replaced'), present, 'utf8')
      await writeManifest('replaced')
    }
    await mkdir(dirname(snapshot.path), { recursive: true })
    await writeFile(snapshot.path, snapshot.before, 'utf8')
    return { kind: 'restored', slot }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** A small stable hash, only used to keep two same-second slots apart. */
function hash(value: string): number {
  let out = 0
  for (let i = 0; i < value.length; i += 1) {
    out = (out * 31 + value.charCodeAt(i)) | 0
  }
  return out
}
