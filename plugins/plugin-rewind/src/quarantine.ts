/**
 * Reading and pruning the quarantine.
 *
 * The quarantine is the feature's safety net: every file a recall displaced is
 * kept there so the recall stays reversible. That safety is only real if a user
 * can SEE what is in it and clear it out — an append-only directory under
 * `$DSH_HOME` with no face is just a slow leak, and one nobody can audit.
 *
 * ## Why the manifest, not the directory name
 *
 * A slot's directory is named from a timestamp and a path hash. That is enough to
 * keep two same-second slots apart and nothing else: it does not say which file
 * the content came from, so a listing built from names alone could only ever show
 * `replaced`. Every slot therefore carries a `manifest.json` written at the same
 * moment as the content, and this module reads it.
 *
 * A slot whose manifest is missing or unreadable is still listed — marked
 * unknown — rather than hidden. An entry a user cannot see is an entry they
 * cannot reclaim, which defeats the point of keeping it.
 *
 * @module @dsh-app/plugin-rewind/quarantine
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_NAME, quarantineRoot, type QuarantineManifest } from './snapshots.ts'

/** One quarantined slot, as the management page lists it. */
export interface QuarantineEntry {
  /** The session whose recall displaced this content. */
  readonly sessionId: string
  /** The slot directory's name (its id within the session). */
  readonly slot: string
  /** What the slot holds, or `unknown` when its manifest is unreadable. */
  readonly kind: 'replaced' | 'created' | 'unknown'
  /** Path the content came from, or undefined when unknown. */
  readonly originalPath?: string
  /** When the recall ran (epoch ms), or undefined when unknown. */
  readonly at?: number
  /** Bytes held, so the page can show a total worth reclaiming. */
  readonly bytes: number
}

/** One session's worth of quarantined content. */
export interface QuarantineGroup {
  readonly sessionId: string
  readonly entries: readonly QuarantineEntry[]
  /** Sum of `entries[].bytes`. */
  readonly bytes: number
}

/** The whole quarantine, grouped by session, newest slot first. */
export interface QuarantineListing {
  readonly groups: readonly QuarantineGroup[]
  readonly entries: number
  readonly bytes: number
}

/**
 * Read one slot's manifest.
 *
 * @param slotDir - the slot directory.
 * @returns the manifest, or undefined when it is missing or unreadable.
 */
async function readManifest(slotDir: string): Promise<QuarantineManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(slotDir, MANIFEST_NAME), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { originalPath?: unknown, kind?: unknown, at?: unknown }
    if (typeof record.originalPath !== 'string') return undefined
    if (record.kind !== 'replaced' && record.kind !== 'created') return undefined
    return {
      originalPath: record.originalPath,
      kind: record.kind,
      at: typeof record.at === 'number' && Number.isSafeInteger(record.at) ? record.at : 0,
    }
  } catch {
    return undefined
  }
}

/** The bytes one slot holds, across every file in it. */
async function slotBytes(slotDir: string): Promise<number> {
  let total = 0
  try {
    for (const name of await readdir(slotDir)) {
      try {
        const info = await stat(join(slotDir, name))
        if (info.isFile()) total += info.size
      } catch { /* a file that vanished mid-scan contributes nothing */ }
    }
  } catch { /* an unreadable slot contributes nothing */ }
  return total
}

/**
 * List the whole quarantine, grouped by session and newest slot first.
 *
 * @param dshHome - the resolved `$DSH_HOME`.
 * @returns the listing; empty when nothing has ever been quarantined.
 */
export async function listQuarantine(dshHome: string): Promise<QuarantineListing> {
  const root = join(dshHome, 'storages', 'dsh-app-plugin-rewind', 'quarantine')
  let sessions: string[]
  try {
    sessions = await readdir(root)
  } catch {
    return { groups: [], entries: 0, bytes: 0 }
  }

  const groups: QuarantineGroup[] = []
  let entries = 0
  let bytes = 0
  for (const sessionId of sessions) {
    const sessionDir = join(root, sessionId)
    let slots: string[]
    try {
      slots = await readdir(sessionDir)
    } catch {
      continue
    }
    const rows: QuarantineEntry[] = []
    for (const slot of slots) {
      const slotDir = join(sessionDir, slot)
      const manifest = await readManifest(slotDir)
      const size = await slotBytes(slotDir)
      rows.push({
        sessionId,
        slot,
        kind: manifest?.kind ?? 'unknown',
        ...(manifest === undefined ? {} : { originalPath: manifest.originalPath }),
        ...(manifest === undefined || manifest.at === 0 ? {} : { at: manifest.at }),
        bytes: size,
      })
      entries += 1
      bytes += size
    }
    // Newest slot first: the timestamp leads the slot name, so a reverse sort
    // reads as "most recent recall first".
    rows.sort((left, right) => right.slot.localeCompare(left.slot))
    // A session whose slots have all been purged is not a group. Its directory
    // outlives the purge (only leaf slots are removed), and listing it as an empty
    // header would make a cleared page look like it still holds something.
    if (rows.length === 0) continue
    groups.push({
      sessionId,
      entries: rows,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    })
  }
  groups.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  return { groups, entries, bytes }
}

/**
 * Delete quarantined content.
 *
 * Deleting is the ONLY destructive operation this plugin performs, and it is
 * deliberately narrow: it removes slot directories inside the quarantine root and
 * nothing else. The root is computed here from `$DSH_HOME` rather than taken from
 * the caller, so a request cannot aim it at an arbitrary path — the page sends
 * session and slot names, never paths.
 *
 * A slot name is validated as a single path segment before it is joined, so a
 * crafted name cannot walk out of the quarantine with `..`.
 *
 * @param dshHome - the resolved `$DSH_HOME`.
 * @param targets - the slots to remove, each a session id and a slot name.
 * @returns how many slots were removed, and what could not be.
 */
export async function purgeQuarantine(
  dshHome: string,
  targets: readonly { readonly sessionId: string, readonly slot: string }[],
): Promise<{ readonly removed: number, readonly failed: readonly string[] }> {
  const failed: string[] = []
  let removed = 0
  for (const target of targets) {
    if (!isSafeSegment(target.sessionId) || !isSafeSegment(target.slot)) {
      failed.push(`${target.sessionId}/${target.slot}`)
      continue
    }
    const dir = join(quarantineRoot(dshHome, target.sessionId), target.slot)
    try {
      // `force` keeps an already-gone slot from being reported as a failure: the
      // user asked for it to be absent, and it is.
      await rm(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      failed.push(`${target.sessionId}/${target.slot}`)
    }
  }
  return { removed, failed }
}

/**
 * Whether one name is a single, ordinary path segment.
 *
 * This is the guard that keeps a purge inside the quarantine: `.`, `..`, an
 * absolute path, or any embedded separator is refused rather than normalised,
 * because normalising is how a traversal is smuggled through.
 *
 * @param value - the candidate segment.
 * @returns whether it is safe to join onto the quarantine root.
 */
export function isSafeSegment(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\')) return false
  // Windows drive-relative and UNC forms.
  if (/^[a-zA-Z]:/.test(value)) return false
  return !value.includes('\0')
}
