/**
 * Path containment for PPTD project files.
 *
 * The case this file exists for: a directory symlink INSIDE the project that points
 * outside it, with a not-yet-existing directory underneath the link. The containment
 * walk starts at the write target's parent, and the first ancestor that does not
 * exist yet must not end the walk — the ancestor ABOVE it is the link, and that is
 * the one whose realpath decides whether creating the missing directory would write
 * outside the project.
 *
 * The shape the check is compared against is `plugin-pdf/src/pdf-paths.ts`, which
 * walks up until an ancestor exists and only then judges it.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writableProjectFile } from '../src/pptd-paths.ts'

test('a write under a symlinked directory is refused, not redirected outside', async () => {
  const base = mkdtempSync(join(os.tmpdir(), 'dsh-pptd-paths-'))
  try {
    const project = join(base, 'project')
    const outside = join(base, 'outside')
    mkdirSync(project, { recursive: true })
    mkdirSync(outside, { recursive: true })
    // A junction on Windows (creation does not need elevation) and a directory
    // link elsewhere; both are what a workspace can plausibly contain.
    symlinkSync(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const canonical = await realpath(project)
    // `link/not-yet-created/x.page`: the missing middle directory must not stop
    // the walk before it reaches `link` itself.
    await assert.rejects(
      writableProjectFile(canonical, 'link/not-yet-created/x.page', 'file_path'),
      /父目录越出 project_path/u,
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a plain nested write inside the project is accepted', async () => {
  const base = mkdtempSync(join(os.tmpdir(), 'dsh-pptd-paths-'))
  try {
    const project = join(base, 'project')
    mkdirSync(project, { recursive: true })
    const canonical = await realpath(project)
    assert.equal(
      await writableProjectFile(canonical, 'a/b/x.page', 'file_path'),
      join(canonical, 'a', 'b', 'x.page'),
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a workspace opened through a symlink still accepts writes inside it', async () => {
  // A real workspace can be opened through a link: macOS resolves `/tmp` and
  // `/var/folders` through `/private`, Windows hands out junctions and 8.3 short
  // names. The caller's root and the ancestor's realpath then carry different
  // prefixes, and comparing them made every write fail as "outside" — fail-closed,
  // but the feature is dead.
  const base = mkdtempSync(join(os.tmpdir(), 'dsh-pptd-paths-'))
  try {
    const real = join(base, 'real')
    const alias = join(base, 'alias')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    // `alias` is deliberately NOT realpath'd: this is what a session cwd can be.
    assert.equal(
      await writableProjectFile(alias, 'a/b/x.page', 'file_path'),
      join(await realpath(real), 'a', 'b', 'x.page'),
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
