/**
 * Same-window announcement of the shared office active-format claim.
 *
 * Each format plugin writes the claim through its own host route, and the
 * browser shares no memory between the separately bundled halves, so a capsule
 * only learns that another format took the slot through this event. The claim
 * write is followed by the announcement in client/api, and the other capsules
 * re-read the claim immediately instead of waiting for their poll. The
 * periodic check and the visibility check stay as the fallback that covers a
 * write this window never announced (another window or process).
 *
 * Wire convention shared by all four suite plugins:
 *   event name: `dsh-office-active-changed`
 *   detail:     `{ format: OfficeActiveFormat, updatedAt: number }`
 * A claim and a release carry the same shape, so a listener treats every
 * change uniformly. Apart from the two guarded window access points this
 * module is environment-free, which keeps it importable from the host half.
 *
 * @module @dsh-app/plugin-ppt/client/office-active-event
 */

import { OFFICE_ACTIVE_FORMATS } from '../office-active.ts'
import type { OfficeActiveFormat } from '../office-active.ts'

/** The window event every office capsule in the suite announces and listens for. */
export const OFFICE_ACTIVE_CHANGED_EVENT = 'dsh-office-active-changed'

/** One announced change: which format holds the claim and when it was written. */
export interface OfficeActiveChangedDetail {
  readonly format: OfficeActiveFormat
  readonly updatedAt: number
}

/** Validate one event detail; anything malformed is ignored by the listener. */
export function parseOfficeActiveChangedDetail(value: unknown): OfficeActiveChangedDetail | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const format = record.format
  const updatedAt = record.updatedAt
  const known = typeof format === 'string' && (OFFICE_ACTIVE_FORMATS as readonly string[]).includes(format)
  if (!known) return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  return { format: format as OfficeActiveFormat, updatedAt }
}

/**
 * Whether an announcement concerns another format and so warrants a fresh
 * stand-down check. This capsule's own write cannot have superseded it.
 */
export function isForeignOfficeActiveChange(detail: OfficeActiveChangedDetail, own: OfficeActiveFormat): boolean {
  return detail.format !== own
}

/**
 * Announce a claim change to this window. A missing browser API (the host
 * half) or a refused dispatch must never fail the write that caused it.
 */
export function notifyOfficeActiveChanged(format: OfficeActiveFormat, updatedAt: number): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent<OfficeActiveChangedDetail>(OFFICE_ACTIVE_CHANGED_EVENT, {
      detail: { format, updatedAt },
    }))
  } catch {
    // The poll still converges the capsules; the announcement only accelerates it.
  }
}

/**
 * Listen for claim changes in this window.
 * @param listener - called with the parsed detail of every valid change.
 * @returns the unsubscriber.
 */
export function subscribeOfficeActiveChanged(listener: (detail: OfficeActiveChangedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (event: Event): void => {
    const detail = parseOfficeActiveChangedDetail((event as CustomEvent<unknown>).detail)
    if (detail !== null) listener(detail)
  }
  try {
    window.addEventListener(OFFICE_ACTIVE_CHANGED_EVENT, handler)
  } catch {
    return () => undefined
  }
  return () => {
    try {
      window.removeEventListener(OFFICE_ACTIVE_CHANGED_EVENT, handler)
    } catch {
      // Nothing was bound, so there is nothing to unbind.
    }
  }
}
