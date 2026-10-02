// Scratch directories for the root suites, removed when the run finishes.
//
// Why: most of these suites build fixtures with `mkdtempSync(tmpdir(), …)` and
// several never removed them, so repeated runs accumulated tens of thousands of
// directories in the system temp (measured 2026-10-02 on this project's machine:
// 41,570 of our own entries). Accumulating scratch is not a test failure, so
// nothing ever caught it — this module is where the lifecycle lives now.
//
// How it works: importing this file registers ONE module-level `after` hook that
// empties the registry. A suite therefore only has to call `scratchDir()` instead
// of `mkdtempSync(...)`: there is no per-test plumbing to forget.
//
// The removal goes through `scripts/lib/remove-tree.mjs`, the walker this repo
// requires for any tree that can hold a link pointing outside itself — several
// of these fixtures build exactly that (a scratch DSH_HOME whose profile
// node_modules holds junctions into a runtime tree), and a plain recursive
// delete descends THROUGH a junction instead of unlinking it. That file records
// the measurement; test/recursive-delete-guard.test.mjs holds the shipped
// contrast. `removeTree` calls are deliberately NOT counted by that guard's
// audit of `rmSync` sites.
//
// Convention (matches `plugins/plugin-memory/tests/scratch.ts`): take the
// prefix the fixture used to pass, so a directory in the temp is still
// identifiable by name.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { removeTree } from '../scripts/lib/remove-tree.mjs'

/** Every directory this run created, in creation order. */
const created = []

/**
 * A scratch directory under the system temp, removed at the end of the run.
 *
 * @param {string} prefix the `mkdtemp` prefix naming the fixture.
 * @returns {string} the created directory path.
 */
export function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

// Registered at import time, so a suite that uses `scratchDir` is cleaned up
// without adding anything of its own. Best effort: a locked file in one fixture
// must not fail an otherwise green run.
after(async () => {
  for (const dir of created.splice(0)) {
    try { await removeTree(dir) } catch { /* best effort */ }
  }
})
