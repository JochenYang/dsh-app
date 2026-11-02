/**
 * The retention sweep: the one place a trash entry expires.
 *
 * ## One implementation, two callers
 *
 * The startup sweep (when the settings say so) and the settings page's "sweep now"
 * button both reach {@link sweepExpired}, through `runRetentionSweep` in
 * `./routes.ts`. The reason is the failure it prevents: a sweep-on-startup that ages
 * entries from one rule and a manual button that ages them from another is how a
 * user sees an entry survive one path and vanish through the other.
 *
 * ## What expires, and what may never expire
 *
 * An entry expires when its own `deletedAt` instant is STRICTLY older than
 * `now - retentionDays`. `retentionDays: 0` means "keep for ever" and short-circuits
 * before anything is read — the zero tier is a real choice, not "0 days old".
 *
 * Every removal goes through the same two modules the /purge route uses:
 * `purgeEntry` (which takes the entry out of service, removes it through
 * `rmWithRetry`, and refuses to authorize anything from a slot the filesystem
 * would not describe) and `purgeSessionShards` (the projection cache document the
 * kernel never reclaims). A sweep that reimplemented either would be a second
 * answer to "what may be deleted", and the storage layer's whole design is that
 * there is one.
 *
 * A failure on ONE entry is reported and the sweep continues: an expired entry
 * that cannot be removed right now (an indexer holding a file, on Windows) must
 * not stop the other nine from being swept, and it will be picked up by the next
 * sweep because it is still older than the cutoff.
 *
 * ## An unreadable `deletedAt` is not "old"
 *
 * The listing falls back to the trash id's own epoch prefix when the metadata
 * cannot be read, so every row has a parseable instant. A value that still fails
 * to parse is treated as NOT expired and reported: deleting on a timestamp nobody
 * could read is the one thing a retention policy must never do.
 *
 * A readable instant is not enough on its own, either. `deletedAt` comes out of
 * `metadata.json`, and the invariant this module works under is that the metadata
 * provides identity and labels — never a verdict. The verdict here is "this row is
 * old enough to disappear", so it needs a second witness: the epoch prefix in the
 * directory NAME, which `moveToTrash` minted from the same clock. When the two
 * disagree by more than {@link MAX_STAMP_SKEW_MS} the row is left alone and
 * reported as `trash-time-mismatch` — an edited or copied entry cannot talk the
 * sweep into deleting a session that was trashed a minute ago.
 *
 * @module @dsh-app/plugin-archives/retention
 */

import { listEntries, lookupPurgeTarget, purgeEntry, type TrashListing } from './trash.ts'
import { purgeSessionShards } from './projcache.ts'
import type { ArchivePurgeWarningCode, ArchiveSkipReason, ArchiveSweepResult, ArchiveTrashEntryRef } from './types.ts'

/** Milliseconds in one day. */
const DAY_MS = 86_400_000

/**
 * How far a row's recorded `deletedAt` may sit from the epoch prefix in its own
 * directory name.
 *
 * Both are written from the same `Date.now()` inside `moveToTrash`, so a healthy
 * entry differs by 0 ms; the window exists only to absorb a clock step or a
 * rounding filesystem, not to make room for an edited file. See the module header
 * for why a disagreement is a warning rather than a purge.
 */
const MAX_STAMP_SKEW_MS = 5 * 60_000

/**
 * The instant before which an entry counts as expired, or undefined for "never".
 * @param retentionDays - the configured tier; `0` never expires anything.
 * @param now - the instant to age from.
 * @returns the ISO cutoff, or undefined when nothing may expire.
 */
export function retentionCutoff(retentionDays: number, now: number): string | undefined {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return undefined
  return new Date(now - retentionDays * DAY_MS).toISOString()
}

/** One row the sweep considered, as the listing named it. */
interface SweepCandidate {
  /** The address a purge lookup takes: an entry's trash id, a leftover's plain id. */
  readonly address: string
  /** The instant the row was created (or, unreadable, its id's epoch prefix). */
  readonly deletedAt: string
}

/**
 * Remove every trash entry older than the retention tier.
 *
 * Two passes, and the second one is why: a `<trashId>.purging` leftover shares its
 * plain id with an entry of the same name, and `lookupPurgeTarget` answers the ENTRY
 * (it is searched first). Sweeping the leftovers off the first listing would
 * therefore re-target the entry that was just removed and report `io` for a
 * directory nobody looked at. So the leftovers are aged against a listing taken
 * AFTER the entries are gone, where their own directory name is the only match.
 *
 * @param input.trashRoot - absolute trash root.
 * @param input.projCacheDir - the projection-cache shard directory, or undefined
 *   when the host exposes none (nothing is cleaned and nothing is claimed).
 * @param input.retentionDays - the configured tier; `0` is a no-op.
 * @param input.now - clock, injected so a test can age its own fixtures.
 * @returns what was removed, the bytes freed, and what could not be.
 */
export async function sweepExpired(input: {
  trashRoot: string
  projCacheDir: string | undefined
  retentionDays: number
  now?: () => number
}): Promise<ArchiveSweepResult> {
  const result: ArchiveSweepResult = {
    retentionDays: input.retentionDays,
    purged: [],
    freedBytes: 0,
    skipped: [],
    warnings: [],
  }
  const cutoff = retentionCutoff(input.retentionDays, (input.now ?? Date.now)())
  if (cutoff === undefined) return result
  const cutoffMs = Date.parse(cutoff)

  /**
   * Age one pass's rows against one listing.
   * @param listing - the listing the addresses are resolved in.
   * @param rows - the rows to consider, already carrying their address.
   */
  const sweepPass = async (listing: TrashListing, rows: readonly SweepCandidate[]): Promise<void> => {
    for (const row of rows) {
      const at = Date.parse(row.deletedAt)
      if (Number.isNaN(at)) {
        // Reported, never expired: see the module header.
        result.skipped.push({
          id: row.address,
          reason: 'io',
          detail: `trash row ${row.address} has an unreadable deletedAt`,
        })
        continue
      }
      // The row is aged by a number that came out of `metadata.json`, and the
      // metadata is a file on disk. The directory NAME holds the same instant — it
      // was minted from the same clock — so it is the second witness, and the two
      // must agree before anything expires. An edited or copied entry whose stamp
      // says "year 2000" would otherwise be swept on the next run.
      const minted = Number(row.address.split('-')[0])
      if (!Number.isFinite(minted) || Math.abs(at - minted) > MAX_STAMP_SKEW_MS) {
        result.warnings.push({ id: row.address, code: 'trash-time-mismatch' })
        continue
      }
      if (at >= cutoffMs) continue
      const lookup = lookupPurgeTarget(listing, row.address)
      if (lookup.kind !== 'target') {
        const reason: ArchiveSkipReason = lookup.kind === 'refused' ? 'trash-unconfirmed' : 'not-in-trash'
        result.skipped.push({ id: row.address, reason })
        continue
      }
      try {
        const { freedBytes } = await purgeEntry({ root: input.trashRoot, target: lookup.target })
        result.freedBytes += freedBytes
        const purged: ArchiveTrashEntryRef = {
          trashId: lookup.target.trashId,
          ids: [...lookup.target.ids],
          deletedAt: lookup.target.deletedAt,
        }
        result.purged.push(purged)
        const warnings = await purgeSessionShards({ dir: input.projCacheDir, ids: lookup.target.ids })
        for (const warning of warnings) {
          const code: ArchivePurgeWarningCode = warning.code
          result.warnings.push({ id: warning.id, code })
        }
      } catch {
        result.skipped.push({ id: row.address, reason: 'io' })
      }
    }
  }

  const entries = await listEntries(input.trashRoot)
  await sweepPass(entries, entries.entries.map((entry) => ({
    address: entry.entry.trashId,
    deletedAt: entry.entry.deletedAt,
  })))
  // An unfinished deletion or an unreadable entry has bytes on disk and a lifetime
  // like any other row; leaving the leftovers out would make "delete for good" the
  // only way to clear the residue the panel exists to expose.
  const leftovers = await listEntries(input.trashRoot)
  await sweepPass(leftovers, leftovers.leftovers.map((leftover) => ({
    address: leftover.trashId,
    deletedAt: leftover.deletedAt,
  })))
  return result
}
