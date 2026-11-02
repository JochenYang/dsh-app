/**
 * The archive manager's own settings file: how long a trashed session is kept.
 *
 *     $DSH_HOME/storages/dsh-app-plugin-archives/settings.json
 *
 *     { "version": 1, "retentionDays": 30, "sweepOnStartup": true }
 *
 * ## The two default sets, and why they are not the same one
 *
 * {@link DEFAULT_SETTINGS} (30 days, sweep at startup) applies to exactly ONE
 * situation: there is no file, which is the first run and means "the product
 * default". Everything else — a file that cannot be read, one that does not parse,
 * one a newer version wrote, one whose fields hold the wrong types — is read as
 * {@link SAFE_SETTINGS}: `retentionDays: 0` (keep for ever), `sweepOnStartup:
 * false`.
 *
 * The reason is the asymmetry of the two mistakes. Reading an unreadable file as
 * "30 days" turns a file that says `retentionDays: 0` into an authorization to
 * delete everything older than 30 days — the trash is the user's ONLY undo buffer
 * for a deletion, so a policy nobody could read must never expire anything. The
 * cost of the safe reading is that a broken file stops automatic cleanup until it
 * is written again, which the settings page reports as `malformed`.
 *
 * ## `0` is a VALID tier, so a field is judged by type AND value
 *
 * `retentionDays` is one of {@link RETENTION_DAYS}, and `0` means "keep for ever".
 * A coercion that went through `Number()` would turn `null`, `''` and `[]` into
 * `0`, and a coercion that went the other way would turn `'0'` into the 30-day
 * default; both are wrong. A field is therefore accepted only when it is already a
 * number, an integer, and one of the five tiers. Anything else — including
 * `'false'` for the switch, which must never read as `true` — falls back to the
 * SAFE value for that field, not to the product default.
 *
 * ## A malformed file is never written back
 *
 * {@link readSettings} answers the safe values and reports `malformed`; it does not
 * repair the file. A read is not a write: rewriting on read would (a) turn a
 * hand-edited file into a different one on every start, and (b) race two kernels
 * that share one `$DSH_HOME`. Only {@link writeSettings} writes, and it writes the
 * NORMALIZED value, so what it persists is always a shape this module can read
 * back identically.
 *
 * A `version` other than {@link SETTINGS_VERSION} is treated as a whole-file
 * unknown: a newer kernel's file may mean something else by the same field names,
 * and reinterpreting it is how a plugin deletes data it did not understand.
 *
 * @module @dsh-app/plugin-archives/settings
 */

import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The settings layout this module writes and reads. */
export const SETTINGS_VERSION = 1

/**
 * The retention tiers, in days. `0` means "never expire".
 *
 * A closed set, not a free number: the retention sweep is the plugin's only
 * automatic deletion, and "delete after an arbitrary number of days" is a value
 * nobody can reason about. Five tiers is what the settings page offers.
 */
export const RETENTION_DAYS = [0, 7, 15, 30, 90] as const

/** One retention tier. */
export type RetentionDays = (typeof RETENTION_DAYS)[number]

/** What the settings file holds. */
export interface ArchiveSettings {
  /** Layout version; `1` is the only one this module understands. */
  readonly version: typeof SETTINGS_VERSION
  /** How long a trash entry is kept before the sweep removes it. `0` = for ever. */
  readonly retentionDays: RetentionDays
  /** Whether the host sweeps expired entries when the plugin mounts. */
  readonly sweepOnStartup: boolean
}

/**
 * What NO FILE means: the first run, and the product default.
 *
 * Used for exactly one case. A file that exists but cannot be trusted reads as
 * {@link SAFE_SETTINGS} instead — see the module header.
 */
export const DEFAULT_SETTINGS: ArchiveSettings = {
  version: SETTINGS_VERSION,
  retentionDays: 30,
  sweepOnStartup: true,
}

/**
 * What an UNTRUSTED file means: nothing expires, nothing sweeps.
 *
 * Also the per-field fallback inside a readable file, so one wrong field can never
 * push a value toward deletion (`'false'` is not `true`, `'0'` is not 30 days).
 */
export const SAFE_SETTINGS: ArchiveSettings = {
  version: SETTINGS_VERSION,
  retentionDays: 0,
  sweepOnStartup: false,
}

/** The plugin's own storage directory inside `<DSH_HOME>/storages`. */
const STORAGE_DIR = 'dsh-app-plugin-archives'

/** The settings file's name inside that directory. */
const SETTINGS_FILE = 'settings.json'

/**
 * The settings file's absolute path for one harness home.
 * @param dshHome - absolute `$DSH_HOME`.
 * @returns `<dshHome>/storages/dsh-app-plugin-archives/settings.json`.
 */
export function settingsPathIn(dshHome: string): string {
  return join(dshHome, 'storages', STORAGE_DIR, SETTINGS_FILE)
}

/** Whether a value is one of the retention tiers, without coercing anything. */
export function isRetentionDays(value: unknown): value is RetentionDays {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (RETENTION_DAYS as readonly number[]).includes(value)
}

/**
 * The settings this module can read out of a parsed file.
 *
 * Field by field, because a file that is wrong in one place is still right in the
 * other — but every fallback is the SAFE value, never the product default: a value
 * this build cannot read must never push the policy toward deleting.
 * @param raw - the parsed JSON value, of any shape.
 * @returns the normalized settings and whether anything had to be replaced.
 */
export function normalizeSettings(raw: unknown): { settings: ArchiveSettings; malformed: boolean } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: SAFE_SETTINGS, malformed: true }
  }
  const value = raw as Record<string, unknown>
  if (value.version !== SETTINGS_VERSION) {
    // A file from a version this module does not know: reinterpreting its fields
    // is guessing at what a newer kernel meant by them, and the file may well say
    // `retentionDays: 0` in a shape this build would read as "30 days".
    return { settings: SAFE_SETTINGS, malformed: true }
  }
  const retentionDays = isRetentionDays(value.retentionDays) ? value.retentionDays : SAFE_SETTINGS.retentionDays
  const sweepOnStartup = typeof value.sweepOnStartup === 'boolean' ? value.sweepOnStartup : SAFE_SETTINGS.sweepOnStartup
  return {
    settings: { version: SETTINGS_VERSION, retentionDays, sweepOnStartup },
    malformed: retentionDays !== value.retentionDays || sweepOnStartup !== value.sweepOnStartup,
  }
}

/** One settings read: the effective value, and whether the file had to be distrusted. */
export interface SettingsRead {
  /** What the caller should act on. */
  readonly settings: ArchiveSettings
  /**
   * Whether the file exists but could not be trusted (unreadable, unparseable, a
   * version this build does not know, or fields of the wrong type). Absent is NOT
   * malformed: it is the first run.
   */
  readonly malformed: boolean
  /** English diagnostic for logs; never a sentence a user reads. */
  readonly detail?: string
}

/**
 * Read the settings, answering {@link DEFAULT_SETTINGS} only when there is no file.
 *
 * Never writes: see the module header. Every other outcome — unreadable, not
 * JSON, an unknown version, a wrong-typed field — answers {@link SAFE_SETTINGS}
 * (`0` days, no startup sweep) and reports `malformed`, because an unreadable
 * policy must not be able to expire the one undo buffer a user has.
 * @param path - absolute settings file path.
 * @returns the effective settings.
 */
export async function readSettings(path: string): Promise<SettingsRead> {
  let text: string
  try {
    text = await fsp.readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown }).code
    // No file at all is the first run: the product default is what it means.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { settings: DEFAULT_SETTINGS, malformed: false }
    return {
      settings: SAFE_SETTINGS,
      malformed: true,
      detail: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}; `
        + 'expiry and the startup sweep stay off until it can be read',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      settings: SAFE_SETTINGS,
      malformed: true,
      detail: `${path} is not valid JSON; expiry and the startup sweep stay off until it is written`,
    }
  }
  const normalized = normalizeSettings(parsed)
  return {
    settings: normalized.settings,
    malformed: normalized.malformed,
    ...(normalized.malformed
      ? { detail: `${path} held values this build cannot use; the safe policy (no expiry, no sweep) applies until it is written` }
      : {}),
  }
}

/**
 * Persist settings, normalized first.
 *
 * The file is written through a sibling temp file and a rename, so a reader never
 * sees a half-written document: the sweep and the settings page can run in two
 * processes of the same `$DSH_HOME`.
 * @param path - absolute settings file path.
 * @param settings - the values to persist; anything invalid is normalized away.
 * @returns the value that was written (what a caller may echo back to the UI).
 * @throws when the write fails: a settings change the user asked for must not be
 *   reported as saved when it is not.
 */
export async function writeSettings(path: string, settings: ArchiveSettings): Promise<ArchiveSettings> {
  const normalized = normalizeSettings({ ...settings, version: SETTINGS_VERSION }).settings
  await fsp.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await fsp.writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await fsp.rename(temp, path)
  } catch (error) {
    try { await fsp.unlink(temp) } catch { /* the temp may never have been created */ }
    throw error
  }
  return normalized
}
