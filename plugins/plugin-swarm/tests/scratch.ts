/**
 * Scratch directories for this plugin's suite, removed when the run finishes.
 *
 * Why: the suite's two config-import tests built fixtures with
 * `mkdtempSync(tmpdir(), …)` and never removed them, so repeated runs
 * accumulated thousands of `dshs-*` directories in the system temp (measured
 * 2026-10-02 on this project's machine: 41,570 of our own entries).
 * Accumulating scratch is not a test failure, so nothing caught it.
 *
 * Importing this module registers ONE module-level `after` hook that empties
 * the registry, so a test only has to call `scratchDir()` instead of
 * `mkdtempSync(...)`.
 *
 * Convention (matches `plugins/plugin-memory/tests/scratch.ts`): pass the
 * prefix the fixture used before, so a directory in the temp is still
 * identifiable by name.
 *
 * @module @dsh-app/plugin-swarm/tests/scratch
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { after } from 'node:test'

/** Every directory this run created, in creation order. */
const created: string[] = []

/**
 * A scratch directory under the system temp, removed at the end of the run.
 *
 * @param prefix - the `mkdtemp` prefix naming the fixture.
 * @returns the created directory path.
 */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

// Registered at import time, so a suite that uses `scratchDir` is cleaned up
// without adding anything of its own. Best effort: a locked file must not fail
// an otherwise green run.
after(async () => {
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
