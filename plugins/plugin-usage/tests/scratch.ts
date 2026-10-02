/**
 * Scratch directories for this plugin's suites, removed when the run finishes.
 *
 * Why: the suites build fixtures with `mkdtempSync(tmpdir(), …)` and the ones
 * that never removed them accumulated thousands of directories in the system
 * temp (measured 2026-10-02 on this project's machine: 41,570 of our own
 * entries). Accumulating scratch is not a test failure, so nothing caught it.
 *
 * How it works: importing this module registers ONE module-level `after` hook
 * that empties the registry, so a suite only has to call `scratchDir()` instead
 * of `mkdtempSync(...)` — there is no per-test plumbing to forget.
 *
 * Convention (matches `plugins/plugin-memory/tests/scratch.ts`): pass the
 * prefix the fixture used before, so a directory in the temp is still
 * identifiable by name.
 *
 * The removal is a plain recursive delete on purpose: these fixtures are plain
 * directories this process created and never linked into. A suite that plants a
 * junction must use the walker its own plugin ships instead — see the note in
 * `plugins/plugin-memory/tests/scratch.ts`.
 *
 * @module @dsh-app/plugin-usage/tests/scratch
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
// without adding anything of its own. Best effort: a locked file in one fixture
// must not fail an otherwise green run.
after(async () => {
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
