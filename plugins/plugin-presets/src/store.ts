/**
 * The preset-package store: filesystem operations over the user preset root.
 *
 * Root contract: the plugin manages exactly one root — the kernel's default
 * user preset root (`<dshHome>/.agent-presets`). Shipped/built-in presets and
 * deployment-configured roots live elsewhere and are never read or written by
 * this plugin, so a package can only ever produce or carry a locally authored
 * preset, never a deployment-shipped one.
 *
 * Import discipline: the validated payload is staged into a dot-prefixed
 * directory inside the root (the roster's scanner skips names that cannot be
 * preset ids, so staging never surfaces as a roster row), then swapped into
 * place by rename. An existing target is moved aside first (Windows rename
 * cannot replace in place) and restored if the swap fails, so a failed import
 * never leaves the user half a preset or without the old one.
 *
 * @module @dsh-app/plugin-presets/store
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isPresetDirectory, packPresetDir, unpackPresetZip, walkPresetFiles } from './pack.ts'
import { COMPOSITION_FILE, PresetPackageError, entryNameProblem, fsErrorCode } from './wire.ts'

export { PresetPackageError } from './wire.ts'

/** What the list route reports about one exportable preset. */
export interface PresetSummary {
  readonly entry: string
  readonly files: number
  readonly bytes: number
}

/** A random suffix so concurrent imports stage into disjoint directories. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

/**
 * The user-preset-root store for `.dshpreset` packages.
 */
export class PresetStore {
  constructor(readonly rootDir: string) {}

  /**
   * List exportable presets in the managed root: directories whose names pass
   * the entry whitelist and which carry the composition file (i.e. entries the
   * roster would actually mount). A missing root is the common first-run case.
   * @returns summaries sorted by entry name.
   */
  async list(): Promise<PresetSummary[]> {
    let children
    try {
      children = await readdir(this.rootDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new PresetPackageError('io', {
        code: 'preset.readRootFailed',
        params: { code: fsErrorCode(error) },
        text: `cannot read the preset root directory (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      })
    }
    const out: PresetSummary[] = []
    for (const child of [...children].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || entryNameProblem(child.name) !== undefined) continue
      const dir = join(this.rootDir, child.name)
      if (!isPresetDirectory(dir)) continue
      const walked = await walkPresetFiles(dir)
      out.push({
        entry: child.name,
        files: walked.length,
        bytes: walked.reduce((sum, file) => sum + file.size, 0),
      })
    }
    return out
  }

  /**
   * Export one preset from the managed root as archive bytes.
   * @param entry - the preset's directory name.
   * @returns the archive bytes.
   * @throws PresetPackageError with codes `entry-invalid`, `unknown-entry`,
   * or whatever {@link packPresetDir} raises.
   */
  async exportZip(entry: string): Promise<Uint8Array> {
    const problem = entryNameProblem(entry)
    if (problem !== undefined) {
      throw new PresetPackageError('entry-invalid', {
        code: 'preset.entryInvalid',
        params: { reason: problem.code },
        text: `invalid preset name: ${problem.text ?? problem.code}`,
      })
    }
    const target = join(this.rootDir, entry)
    // The whitelist already forbids separators; isPresetDirectory doubles as
    // the existence check and keeps shipped presets (outside this root)
    // permanently out of reach.
    if (!isPresetDirectory(target)) {
      throw new PresetPackageError('unknown-entry', {
        code: 'preset.unknownEntry',
        params: { entry },
        text: `preset "${entry}" does not exist, or is not an exportable custom preset (built-in presets cannot be exported)`,
      })
    }
    return packPresetDir(target, entry)
  }

  /**
   * Import a validated archive into the managed root under its manifest's
   * entry name. Refuses an existing target unless `overwrite` is explicit.
   * @param data - the archive bytes (caller already capped at MAX_ZIP_BYTES).
   * @param overwrite - replace an existing entry of the same name.
   * @returns the imported entry name and its file count.
   * @throws PresetPackageError with codes `conflict`, `io`, or whatever
   * {@link unpackPresetZip} raises.
   */
  async importZip(data: Uint8Array, overwrite: boolean): Promise<{ entry: string, files: number }> {
    const { entry, files } = unpackPresetZip(data)
    // The kernel roster only mounts preset directories that carry the
    // composition file. Importing a payload without one would report success
    // yet never appear in any list — reject it as a malformed package instead.
    if (!files.some((file) => file.rel === COMPOSITION_FILE)) {
      throw new PresetPackageError('bad-package', {
        code: 'preset.compositionMissing',
        params: { file: COMPOSITION_FILE },
        text: `the preset package has no ${COMPOSITION_FILE}, so the kernel would not recognize it after import; refused`,
      })
    }
    const target = join(this.rootDir, entry)
    if (existsSync(target) && !overwrite) {
      // Never rendered: the client turns any 409 into its own overwrite dialog
      // and reads `details.entry` for the name, so this stays a diagnostic.
      throw new PresetPackageError('conflict', {
        code: 'preset.conflict',
        params: { entry },
        text: `a preset named "${entry}" already exists; confirm the overwrite to replace it`,
      }, { entry })
    }
    mkdirSync(this.rootDir, { recursive: true })
    const stage = join(this.rootDir, `.dshpreset-stage-${process.pid}-${randomSuffix()}`)
    const backup = join(this.rootDir, `.dshpreset-old-${process.pid}-${randomSuffix()}`)
    let movedOld = false
    let swapped = false
    try {
      mkdirSync(stage, { recursive: true })
      for (const file of files) {
        const dest = join(stage, file.rel)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, file.data)
      }
      if (existsSync(target)) {
        renameSync(target, backup)
        movedOld = true
      }
      renameSync(stage, target)
      swapped = true
    } catch (error) {
      throw new PresetPackageError('io', {
        code: 'preset.writeFailed',
        params: { code: fsErrorCode(error) },
        text: `cannot write into the preset directory (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      })
    } finally {
      if (swapped) {
        // Best-effort cleanup: on Windows a search indexer or antivirus can
        // hold the old directory busy (EBUSY/EPERM). The stale backup is a
        // dot-prefixed name invisible to the roster, so leaving it beats
        // throwing away an already-successful import.
        if (movedOld) {
          try {
            rmSync(backup, { recursive: true, force: true })
          } catch { /* keep the backup for manual recovery */ }
        }
      } else {
        // Same best-effort contract; never let cleanup mask the precise
        // PresetPackageError the caller is about to receive.
        try {
          rmSync(stage, { recursive: true, force: true })
        } catch { /* keep the stage for manual recovery */ }
        // Restore the old preset so a failed swap loses nothing; if the
        // restore itself fails, keep the backup dot-directory (invisible to
        // the roster) instead of deleting the user's data.
        if (movedOld && !existsSync(target)) {
          try {
            renameSync(backup, target)
          } catch {
            /* keep the backup for manual recovery */
          }
        }
      }
    }
    return { entry, files: files.length }
  }
}
