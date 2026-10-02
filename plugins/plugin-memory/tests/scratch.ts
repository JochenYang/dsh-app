/**
 * Scratch directories for this plugin's suites, removed when the run finishes.
 *
 * Why: every suite here builds fixtures with `mkdtempSync(tmpdir(), …)` and most
 * never removed them, so a run left thousands of `dshm-*` directories in the
 * system temp — accumulating scratch is not a test failure, so nothing caught
 * it (measured 2026-10-02 on this project's machine: 41,570 of our own entries
 * and ~640 MB in %TEMP%).
 *
 * How it works: importing this module registers ONE module-level `after` hook
 * that empties the registry, so a test file only has to import the two factory
 * functions below and call them instead of `mkdtempSync`. No per-test plumbing,
 * and a file cannot forget to clean up by forgetting a `t.after`.
 *
 *   const tmpStore = (): MemoryStore => scratchStore('dshm-bg-')
 *
 * The removal goes through the walker this plugin already ships and tests
 * (`src/remove-tree.ts`): a fixture root is exactly where a test may have
 * planted a junction, and a plain recursive delete would descend through it.
 *
 * @module @dsh-app/plugin-memory/tests/scratch
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { MemoryRoot, MemoryStore } from '../src/memory-store.ts'
import { removeTree } from '../src/remove-tree.ts'

/** Every directory this run created, in creation order. */
const created: string[] = []

/**
 * A scratch directory under the system temp, removed at the end of the run.
 *
 * @param prefix - the `mkdtemp` prefix that names the fixture.
 * @returns the created directory path.
 */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/**
 * A `MemoryStore` on a scratch directory removed at the end of the run.
 *
 * @param prefix - the `mkdtemp` prefix naming the fixture.
 * @returns the store.
 */
export function scratchStore(prefix = 'dshm-store-'): MemoryStore {
  return new MemoryStore(scratchDir(prefix))
}

/**
 * A `MemoryRoot` on a scratch directory removed at the end of the run.
 *
 * @param prefix - the `mkdtemp` prefix naming the fixture.
 * @returns the root.
 */
export function scratchRoot(prefix = 'dshm-root-'): MemoryRoot {
  return new MemoryRoot(scratchDir(prefix))
}

// Registered at import time, so a suite that uses the factories above is
// cleaned up without adding anything of its own. Best effort: a locked file in
// one fixture must not fail an otherwise green run.
after(async () => {
  for (const dir of created.splice(0)) {
    try { await removeTree(dir) } catch { /* best effort */ }
  }
})
