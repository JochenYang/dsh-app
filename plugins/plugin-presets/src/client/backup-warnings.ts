/**
 * Client-half decoding of the config-backup export's warning header.
 *
 * The host answers a config-backup download with the archive plus — when any
 * collected file matched a secret-shaped content rule — an
 * `x-dsh-backup-warnings` header: base64 JSON of `{ rel, rule }` entries. The
 * archive carries the credential store by design, so this list is the user's
 * per-export signal that the zip holds plaintext key material.
 *
 * Kept out of the section component so it is testable without React and
 * without a browser: the notice it feeds is the only per-export channel that
 * says the archive carries keys, so its decode path is pinned rather than
 * assumed.
 *
 * @module @dsh-app/plugin-presets/client/backup-warnings
 */

/** One content-scan hit: the archive path and the rule that matched. */
export interface BackupWarning {
  readonly rel: string
  readonly rule: string
}

/** The response header the host sets on a warned config-backup export. */
export const BACKUP_WARNINGS_HEADER = 'x-dsh-backup-warnings'

/**
 * Decode the export answer's warning header. A malformed header must never
 * fail a successful export — the standing warning in the section intro still
 * covers the risk — so every malformed shape answers `[]`.
 *
 * @param header - the raw header value, or null when the host set none.
 * @returns the decoded warnings, in the order the host reported them.
 */
export function decodeBackupWarnings(header: string | null): BackupWarning[] {
  if (header === null || header === '') return []
  try {
    const parsed: unknown = JSON.parse(atob(header))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is BackupWarning =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as { rel?: unknown }).rel === 'string'
      && typeof (entry as { rule?: unknown }).rule === 'string')
  } catch {
    return []
  }
}
