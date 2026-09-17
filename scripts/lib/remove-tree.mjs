// Recursive delete that never follows a directory junction.
//
// Why not `fs.rmSync(dir, { recursive: true })`: the SYNC recursive delete
// descends THROUGH a junction, so removing a throwaway DSH_HOME whose
// profiles/*/node_modules/@dsh-app held junctions into a runtime tree emptied
// that runtime's own package directories — reproduced twice before the shell
// changed shape (Electron 44.4.1 / Node 24.21, Windows; the measurement script
// is scratch/rm-junction-semantics.mjs, and test/recursive-delete-guard.test.mjs
// keeps the contrast). The async `fs.rm` does not descend, and this walker does
// not either: a link is unlinked, never read through.
//
// Use it for any tree that can hold a link pointing OUTSIDE itself: a scratch
// DSH_HOME, a profile, a runtime tree, anything a package manager or an earlier
// run may have planted a junction in. A directory this process created and
// never linked into may use the plain call — test/recursive-delete-guard.test.mjs
// holds the audited list of which calls are.
//
// The shell's copy of this walker is `removeWithoutLinks` in
// src/main/suite-profile.ts. It cannot be imported from here without requiring a
// built dist/, so the shape lives in two places: change them together.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Remove `target` (file, link or directory tree) without following any link
 * inside it. Absent targets are a no-op, matching `fs.rm({ force: true })`.
 *
 * @param {string} target path to remove.
 * @returns {Promise<void>} resolves once the tree is gone.
 */
export async function removeTree(target) {
  const stats = await statOrUndefined(target)
  if (stats === undefined) return
  if (stats.isSymbolicLink()) {
    await fs.unlink(target)
    return
  }
  if (!stats.isDirectory()) {
    await fs.rm(target, { force: true })
    return
  }
  for (const entry of await fs.readdir(target)) await removeTree(path.join(target, entry))
  await fs.rmdir(target)
}

/** `lstat`, or undefined when the path is absent (every other failure is real). */
async function statOrUndefined(target) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
