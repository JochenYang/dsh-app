/**
 * A plugin whose code changed but whose package version did not ships NOTHING.
 *
 * `computeSuiteVersion` (scripts/kernel-line.mjs) hashes the seventeen suite
 * plugins' versions; that hash names the kernel directory
 * (`dsh-<dshVersion>+suite-<hash>`), and the shell installs a kernel by that
 * directory name — so a rebuild whose hash is unchanged is never picked up by
 * an existing installation, and a plugin change can sit in the repository while
 * every local gate stays green. Measured before v0.12.5: the market's SVG busy
 * ring, plugin-memory's and plugin-presets' link-safe deletes, plugin-pdf's
 * office_to_pdf and plugin-fff's build script were all unshipped behind
 * unchanged versions, and a user's test of the new tool silently exercised the
 * old plugin.
 *
 * This compares every suite plugin against the newest release tag. A checkout
 * that cannot see the tag (a shallow CI clone) skips with a message: the
 * question is unanswerable there, and failing would block unrelated work.
 *
 * @module dsh-app/tests/plugin-version-bump
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUITE_PLUGINS } from '../scripts/kernel-line.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Run git in the repository, returning trimmed stdout ('' when it fails). */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** The newest release tag, or '' when this checkout does not carry one. */
function newestReleaseTag() {
  return git(['tag', '--list', 'v*', '--sort=-v:refname']).split(/\r?\n/u)[0] ?? ''
}

/** `version` of one plugin's manifest at `rev`, or '' when unreadable. */
function versionAt(rev, dir) {
  try {
    return JSON.parse(git(['show', `${rev}:plugins/${dir}/package.json`]))?.version ?? ''
  } catch {
    return ''
  }
}

test('every suite plugin whose code changed since the last release bumped its version', () => {
  const tag = newestReleaseTag()
  if (tag === '') {
    console.log('plugin-version-bump: no release tag in this checkout (shallow clone?); skipping')
    return
  }
  const head = git(['rev-parse', 'HEAD'])
  if (head === '' || head === git(['rev-parse', `${tag}^{commit}`])) {
    console.log(`plugin-version-bump: HEAD is ${tag}; nothing to compare`)
    return
  }
  const stale = []
  for (const name of [...SUITE_PLUGINS]) {
    const dir = name.replace('@dsh-app/', '')
    // Everything that ends up in the shipped plugin package, not just src: a
    // build-script change alters the artifact the kernel loads.
    const changed = git(['diff', '--name-only', `${tag}..HEAD`, '--', `plugins/${dir}/src`, `plugins/${dir}/assets`, `plugins/${dir}/build.mjs`, `plugins/${dir}/cordis.patch.yml`])
    if (changed === '') continue
    const atTag = versionAt(tag, dir)
    const now = JSON.parse(readFileSync(join(ROOT, 'plugins', dir, 'package.json'), 'utf8')).version
    if (atTag === '' || atTag === now) stale.push(`${dir} (${changed.split(/\r?\n/u).length} file(s), version ${now})`)
  }
  assert.deepEqual(stale, [], `since ${tag} these plugins changed code without a version bump, so the suite hash is unchanged and NO installation will ever receive them: ${stale.join(', ')}. Bump the plugin's version in the same commit as its code.`)
})
