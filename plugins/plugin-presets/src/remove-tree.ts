/**
 * Recursive delete that never follows a directory junction.
 *
 * Why not `fs.rmSync(dir, { recursive: true })`: the SYNC recursive delete
 * descends THROUGH a junction, so cleaning up this plugin's own staging /
 * backup directories would empty whatever a linked preset root points at
 * instead of dropping the link — reproduced under the app's own Node
 * (Electron 44.4.1 / Node 24.21, Windows; test/recursive-delete-guard.test.mjs
 * holds the contrast). The async `fs.rm` does not descend, and this walker
 * does not either: a link is unlinked, never read through.
 *
 * The shape is the shell's own — `removeWithoutLinks` in
 * src/main/suite-profile.ts and `scripts/lib/remove-tree.mjs`. It is
 * duplicated here on purpose: this package ships inside the kernel runtime and
 * must not import build tooling. Change the three together.
 *
 * @module @dsh-app/plugin-presets/remove-tree
 */

import type { Stats } from 'node:fs'
import { lstat, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Remove `target` (file, link or directory tree) without following any link
 * inside it. An absent target is a no-op, matching `fs.rm({ force: true })`.
 *
 * @param target - path to remove.
 */
export async function removeTree(target: string): Promise<void> {
  const stats = await statOrUndefined(target)
  if (stats === undefined) return
  if (stats.isSymbolicLink()) {
    await unlink(target)
    return
  }
  if (!stats.isDirectory()) {
    await rm(target, { force: true })
    return
  }
  for (const entry of await readdir(target)) await removeTree(join(target, entry))
  await rmdir(target)
}

/** `lstat`, or undefined when the path is absent (every other failure is real). */
async function statOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
