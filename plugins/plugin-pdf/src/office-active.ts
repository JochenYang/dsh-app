/**
 * Shared office-suite active-format state, arbitrated through one
 * cross-plugin file (`<DSH_HOME>/storages/dsh-app-office/active.json`).
 *
 * The office capabilities are mutually exclusive: one format holds the active
 * claim at a time, and every format plugin converges on that claim instead of
 * trusting only its own per-session mode. The file is the arbitration point
 * and `updatedAt` is the tie-break — only a claim written later than a
 * plugin's own local entry supersedes it, so exactly one side stands down and
 * two plugins can never close each other in a loop.
 *
 * DOM-, Node- and React-free on purpose: the host half (file I/O lives in
 * office-active-store) and the browser half (which reads the claim back
 * through this plugin's own route) share this exact decision table.
 *
 * @module @dsh-app/plugin-pdf/office-active
 */

/** The format ids that can hold the single active claim. */
export const OFFICE_ACTIVE_FORMATS = ['ppt', 'word', 'sheet', 'pdf'] as const

/** One office format id. */
export type OfficeActiveFormat = (typeof OFFICE_ACTIVE_FORMATS)[number]

/** The single active claim: one format on, or none (`format: null`). */
export interface OfficeActive {
  readonly format: OfficeActiveFormat | null
  readonly sessionId: string
  readonly updatedAt: number
}

/** Validate one parsed active.json value; anything malformed reads as "none". */
export function parseOfficeActive(value: unknown): OfficeActive | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const format = record.format
  const sessionId = record.sessionId
  const updatedAt = record.updatedAt
  const known = typeof format === 'string' && (OFFICE_ACTIVE_FORMATS as readonly string[]).includes(format)
  if (format !== null && !known) return null
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  return { format: format as OfficeActiveFormat | null, sessionId, updatedAt }
}

/**
 * Whether a plugin still holding an older local mode must stand down.
 *
 * Only a *later* foreign claim wins: an absent or older claim, the plugin's
 * own format, or an unknown local timestamp leaves the local mode alone.
 * Because a later claim is later than every plugin's local entry, at most one
 * side can read this as true, so the stand-down cannot ping back and forth.
 */
export function shouldSelfDisable(
  active: OfficeActive | null,
  ownFormat: OfficeActiveFormat,
  ownUpdatedAt: number | null,
): boolean {
  if (active === null || active.format === null || active.format === ownFormat) return false
  return ownUpdatedAt !== null && active.updatedAt > ownUpdatedAt
}
