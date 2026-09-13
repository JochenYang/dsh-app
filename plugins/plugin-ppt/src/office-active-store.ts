/**
 * File I/O for the shared office active-format claim.
 *
 * One file, one namespace: `<DSH_HOME>/storages/dsh-app-office/active.json`
 * holds `{ format, sessionId, updatedAt }` for every installed office format
 * plugin. Writes are monotonic — a claim is stamped later than whatever it
 * replaces, even within the same millisecond — so the ordering the stand-down
 * rule relies on is never ambiguous. Atomic writes keep a concurrent reader
 * from seeing a half file; a missing or corrupt file reads as "none active".
 *
 * @module @dsh-app/plugin-ppt/office-active-store
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseOfficeActive } from './office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from './office-format.ts'
import type { OfficeActive } from './office-active.ts'

/** The suite-wide active-format file, shared by every office format plugin. */
export function officeActiveFilePath(dshHome: string): string {
  return join(dshHome, 'storages', 'dsh-app-office', 'active.json')
}

/** Read the current claim; missing, unreadable or malformed reads as none. */
export function readOfficeActive(file: string): OfficeActive | null {
  try {
    return parseOfficeActive(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/**
 * The stamp for the next write. A later write always carries a later stamp,
 * so `shouldSelfDisable` sees a strict order even for same-millisecond toggles.
 */
function nextUpdatedAt(previous: OfficeActive | null, now: number): number {
  return previous === null || now > previous.updatedAt ? now : previous.updatedAt + 1
}

/** Claim the single active slot for this format; returns the written state. */
export async function claimOfficeActive(
  file: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<OfficeActive> {
  const active: OfficeActive = {
    format: OFFICE_ACTIVE_FORMAT,
    sessionId,
    updatedAt: nextUpdatedAt(readOfficeActive(file), now),
  }
  await writeFileAtomic(file, JSON.stringify(active, null, 2) + '\n', { mode: 0o644, dirMode: 0o700 })
  return active
}

/**
 * Release the claim if (and only if) this format still holds it. Turning off a
 * format a different format has already superseded must not clear the winner's
 * claim.
 */
export async function releaseOfficeActive(
  file: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<void> {
  const current = readOfficeActive(file)
  if (current === null || current.format !== OFFICE_ACTIVE_FORMAT) return
  const released: OfficeActive = { format: null, sessionId, updatedAt: nextUpdatedAt(current, now) }
  await writeFileAtomic(file, JSON.stringify(released, null, 2) + '\n', { mode: 0o644, dirMode: 0o700 })
}
