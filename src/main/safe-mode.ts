import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFileAtomic } from './json-file'

/**
 * Safe-mode marker. When set, the shell boots the dsh kernel without the
 * brand-suite overlay: only the official bundle plus the user's own profile
 * layers load. This is the escape hatch for a broken suite (e.g. a patch
 * conflict that fails the whole plugin tree) — both the startup-failure
 * dialog and the tray menu write/clear this flag and relaunch, since the flag
 * is only consumed at the next boot's server start.
 */

/** Marker file name under userData. */
const SAFE_MODE_FILE = 'dsh-app-safe-mode.json'

interface SafeModeFlag {
  enabled: boolean
  /** ISO timestamp of when safe mode was entered. */
  since: string
}

function safeModeFile(): string {
  return path.join(app.getPath('userData'), SAFE_MODE_FILE)
}

/** True when the marker exists and is enabled; a corrupt file reads as off. */
export async function isSafeModeEnabled(): Promise<boolean> {
  const flag = await readJsonFile<SafeModeFlag>(safeModeFile())
  return flag?.enabled === true
}

/**
 * Write or clear the marker. Clearing removes the file outright — absence is
 * the single source of "off", with no enabled:false state to drift out of sync.
 */
export async function setSafeMode(enabled: boolean): Promise<void> {
  const file = safeModeFile()
  if (!enabled) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return
  }
  try {
    await writeJsonFileAtomic(file, { enabled: true, since: new Date().toISOString() } satisfies SafeModeFlag)
  } catch (err) {
    console.error('[safe-mode] failed to write marker:', (err as Error).message)
  }
}
