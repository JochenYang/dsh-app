/**
 * The shell's data directory, in ONE spelling.
 *
 * Why this is its own module: on Windows and on default macOS volumes the
 * filesystem matches names case-insensitively, so `existsSync` cannot tell
 * `DSH App` from `DSH APP` — they are the same directory. The brand rename
 * ("DSH App" → "DSH APP") was written as `existsSync(legacy) && !existsSync(new)`,
 * which on exactly those platforms is `true && false` and never fires.
 *
 * Two spellings of one directory are two identities to Node's ESM cache, which
 * keys modules by URL string: measured in an installed build, the kernel child
 * instantiated `@deepseek-ai/dsh-app-boot` TWICE (once under `…/DSH%20APP/kernel/…`
 * from the path this shell passed, once under `…/DSH%20App/kernel/…` as the
 * resolver canonicalized it). That package keeps a module-level WeakMap of the
 * booted root Include, so the instance that mounted the tree and the instance the
 * config editor asked were different — and every settings write inside the app
 * was refused with `profile reload requires the root Include entry`, which is how
 * the first-run notice became impossible to acknowledge and the model list lost
 * its providers.
 *
 * So the directory is renamed to the brand spelling when it is not already
 * exactly that, and when the rename cannot be made the ON-DISK spelling is
 * adopted instead. Either way the shell passes one string everywhere.
 *
 * @module dsh-app/main/user-data
 */
import { readdirSync, renameSync } from 'node:fs'
import path from 'node:path'

/** The brand name the data directory must have. */
export const USER_DATA_DIR_NAME = 'DSH APP'

/**
 * Align the data directory's name with {@link USER_DATA_DIR_NAME}.
 *
 * A case-only rename needs two steps: Windows reports the target name as already
 * existing (it is the same file), so the directory is first moved aside and then
 * into place. A failure at either step is non-fatal — the caller gets a usable
 * path either way, because an oddly-cased directory is only a problem when a
 * SECOND spelling of it is also in use.
 *
 * @param appDataDir - the platform's application-data root (Electron's `appData`).
 * @returns the absolute data directory to use, in the spelling that exists on disk.
 */
export function alignUserDataDir(appDataDir: string): string {
  const target = path.join(appDataDir, USER_DATA_DIR_NAME)
  let entries: string[]
  try {
    entries = readdirSync(appDataDir)
  } catch {
    // No data root yet (first run): the target spelling is what will be created.
    return target
  }
  const actual = entries.find((name) => name.toLowerCase() === USER_DATA_DIR_NAME.toLowerCase())
  if (actual === undefined || actual === USER_DATA_DIR_NAME) return target
  const from = path.join(appDataDir, actual)
  const staged = path.join(appDataDir, `${USER_DATA_DIR_NAME}.renaming`)
  try {
    renameSync(from, staged)
  } catch {
    return from
  }
  try {
    renameSync(staged, target)
    return target
  } catch {
    // Put it back rather than leave the data under a temporary name.
    try {
      renameSync(staged, from)
    } catch {
      // Nothing left to try; the caller keeps the path that still exists.
    }
    return from
  }
}
