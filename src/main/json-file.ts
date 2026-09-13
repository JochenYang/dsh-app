import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * JSON persistence for small shell state files under userData (safe-mode
 * marker, skipped version, version history). Every write is atomic so a crash
 * mid-write can never leave a half-written record: these files gate boot-time
 * behavior and must parse cleanly or be absent.
 */

/** Read a JSON file; null when missing or corrupt (never throws). */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Atomically replace a JSON file: write a sibling tmp file, then rename it
 * over the target. Windows refuses a rename onto an existing target, so the
 * old file is removed first — worst case (crash between rm and rename) the
 * record is absent, which every reader already treats as "not set".
 */
export async function writeJsonFileAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rm(file, { force: true })
  await fs.rename(tmp, file)
}
