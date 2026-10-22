/**
 * The changeset gate's pure decisions: which paths ship, what a fragment must
 * look like, and what the fold produces. The failure class these encode is
 * silent: v0.12.5 shipped four changed plugins to nobody because no version
 * moved and every gate stayed green, so the check has to be about the
 * declaration, not about the build.
 *
 * @module dsh-app/tests/changeset-gate
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addedVersions,
  decide,
  decideCommits,
  insertSection,
  isChangesetFile,
  isReleasablePath,
  nulRecords,
  parseFragment,
  parseNameStatus,
  readFragments,
  renderSection,
  sectionBullets,
} from '../scripts/lib/changeset.mjs'

const FRAGMENT = `---
shell: patch
plugins: plugin-market
---

市场插件：SVG 忙碌圈改为主色脉冲。
Market plugin: the SVG busy ring now pulses.
`

test('releasable paths mirror the delivery paths', () => {
  assert.equal(isReleasablePath('src/main/window.ts'), true)
  assert.equal(isReleasablePath('plugins/plugin-market/src/client.ts'), true)
  assert.equal(isReleasablePath('plugins/plugin-market/package.json'), true)
  assert.equal(isReleasablePath('scripts/build-runtime.mjs'), true)
  assert.equal(isReleasablePath('scripts/kernel-line.mjs'), true)

  assert.equal(isReleasablePath('docs/x.md'), false)
  assert.equal(isReleasablePath('test/x.test.mjs'), false)
  assert.equal(isReleasablePath('scripts/copy-static.mjs'), false)
  assert.equal(isReleasablePath('plugins/plugin-market/README.md'), false)
  assert.equal(isReleasablePath('plugins/AGENTS.md'), false)
  assert.equal(isReleasablePath('changesets/x.md'), false)
})

test('a fragment file is one under changesets/, not the README', () => {
  assert.equal(isChangesetFile('changesets/team-panel.md'), true)
  assert.equal(isChangesetFile('changesets/README.md'), false)
  assert.equal(isChangesetFile('docs/changesets/x.md'), false)
})

test('a fragment parses, and malformed ones say why', () => {
  const parsed = parseFragment(FRAGMENT, 'x.md')
  assert.equal(parsed.shell, 'patch')
  assert.deepEqual(parsed.plugins, ['plugin-market'])
  assert.equal(parsed.zh, '市场插件：SVG 忙碌圈改为主色脉冲。')
  assert.equal(parsed.en, 'Market plugin: the SVG busy ring now pulses.')

  assert.throws(() => parseFragment('shell: patch\n\nzh\nen\n', 'x.md'), /opening ---/)
  assert.throws(() => parseFragment('---\nplugins: a\n---\n\nzh\nen\n', 'x.md'), /shell must be/)
  assert.throws(() => parseFragment('---\nshell: huge\n---\n\nzh\nen\n', 'x.md'), /shell must be/)
  assert.throws(() => parseFragment('---\nshell: patch\n---\n\nonly one line\n', 'x.md'), /two non-empty lines/)
  assert.throws(() => parseFragment('---\nshell: patch\n---\n\nzh\nen\nextra\n', 'x.md'), /two non-empty lines/)
})

test('the gate fires on releasable changes without a fragment', () => {
  const bare = decide(['src/main/window.ts'])
  assert.equal(bare.ok, false)
  assert.deepEqual(bare.releasable, ['src/main/window.ts'])

  const withFragment = decide(['src/main/window.ts', 'changesets/team-panel.md'])
  assert.equal(withFragment.ok, true)

  const docsOnly = decide(['docs/agents/release-checklist.md'])
  assert.equal(docsOnly.ok, true)
  assert.deepEqual(docsOnly.releasable, [])
})

test('the gate answers per commit, so a release push passes', () => {
  // The v0.14.1 push, exactly as it landed: the mechanism, the fix with its
  // fragments, then the release that consumes them. An endpoint diff of the
  // whole push sees the code change and no fragment and fails; per commit,
  // every commit carries its declaration.
  const commits = [
    { sha: 'aaaaaaa', paths: ['scripts/lib/changeset.mjs', '.github/workflows/ci.yml', 'docs/agents/release-checklist.md'] },
    { sha: 'bbbbbbb', paths: ['src/main/window.ts', 'scripts/probe-drag.cjs', 'changesets/team-panel-see-through.md', 'changesets/window-controls-strip.md'] },
    { sha: 'ccccccc', paths: ['package.json', 'CHANGELOG.md', 'changesets/team-panel-see-through.md', 'changesets/window-controls-strip.md'] },
  ]
  assert.deepEqual(decideCommits(commits), [])

  const withBare = decideCommits([...commits, { sha: 'ddddddd', paths: ['src/main/index.ts'] }])
  assert.equal(withBare.length, 1)
  assert.equal(withBare[0].sha, 'ddddddd')
})

// A RELEASE commit consumes the fragments it folds and writes their content into
// the changelog section. Folding and bumping in the same commit as a last `src/`
// fix is a legitimate shape, and used to be reported as undeclared — which is
// what this context exists to separate from a genuinely missing declaration.

test('a release commit declares through the section it writes', () => {
  const releaseContext = { releasedVersion: '0.17.2', deletedPaths: ['changesets/panel.md'] }
  const release = decide(
    ['package.json', 'CHANGELOG.md', 'src/main/platform-view.ts', 'changesets/panel.md'],
    releaseContext,
  )
  assert.equal(release.ok, true)
  assert.equal(release.released, '0.17.2')
  // A consumed fragment is not an ADDED one: the commit brought no declaration of
  // its own, its section is the declaration.
  assert.equal(release.hasFragment, false)
  // The paths are still REPORTED: the exemption is about the declaration, not
  // about hiding that user-facing code moved in this commit.
  assert.deepEqual(release.releasable, ['src/main/platform-view.ts'])

  // Per commit, the same shape passes without a fragment of its own.
  assert.deepEqual(decideCommits([
    { sha: 'eeeeeee', paths: ['src/main/a.ts', 'CHANGELOG.md', 'package.json', 'changesets/panel.md'], context: releaseContext },
  ]), [])
})

test('only a release that CONSUMED a fragment is a declaration', () => {
  // A section added while nothing was consumed means the fold never ran: the
  // fragment is still on disk and still the declaration for the next release, so
  // this commit declared nothing.
  const addedOnly = decide(['src/main/a.ts', 'CHANGELOG.md'], { releasedVersion: '0.17.2', deletedPaths: [] })
  assert.equal(addedOnly.ok, false)
  assert.equal(addedOnly.released, null)
  // Same when the context is absent entirely.
  assert.equal(decide(['src/main/a.ts', 'CHANGELOG.md']).ok, false)
})

test('a deleted fragment with no new section declares nothing either', () => {
  // Cleaning up an unused fragment is maintenance, not a release: without an
  // added section there is no version the change belongs to.
  const cleanup = decide(['src/main/a.ts', 'changesets/panel.md'], { deletedPaths: ['changesets/panel.md'] })
  assert.equal(cleanup.ok, false)
  assert.equal(cleanup.released, null)
  // And it must not read as "a fragment came with this commit" either.
  assert.equal(cleanup.hasFragment, false)
})

test('the release exemption never covers a commit that adds no section', () => {
  // The shape a reviewer must not let through: releasable code plus a consumed
  // fragment, with the changelog untouched — nothing tells a user what shipped.
  const smuggled = decide(
    ['src/main/a.ts', 'changesets/panel.md'],
    { deletedPaths: ['changesets/panel.md'] },
  )
  assert.equal(smuggled.ok, false)

  // A deletion set that names a NON-fragment proves nothing either: `deletedPaths`
  // is only trusted where a fragment is actually being consumed.
  const unrelatedDeletion = decide(
    ['src/main/a.ts', 'CHANGELOG.md'],
    { releasedVersion: '0.17.2', deletedPaths: ['src/main/old.ts'] },
  )
  assert.equal(unrelatedDeletion.ok, false)
  assert.equal(unrelatedDeletion.released, null)
})

test('an added fragment still declares, whatever else the commit deletes', () => {
  // A commit that adds one fragment and consumes another is doing both jobs; the
  // added one is a real declaration and the gate must accept it.
  const mixed = decide(
    ['src/main/a.ts', 'changesets/new.md', 'changesets/old.md'],
    { deletedPaths: ['changesets/old.md'] },
  )
  assert.equal(mixed.ok, true)
  assert.equal(mixed.hasFragment, true)
})

test('the fold renders a bilingual section and refuses a duplicate', () => {
  const fragments = [
    { name: 'a.md', fragment: parseFragment(FRAGMENT, 'a.md') },
    { name: 'b.md', fragment: parseFragment('---\nshell: minor\n---\n\n第二条。\nSecond.\n', 'b.md') },
  ]
  const section = renderSection('0.14.0', '2026-09-26', fragments)
  assert.match(section, /^## \[v0\.14\.0\] - 2026-09-26\n/)
  assert.match(section, /### 中文\n- 市场插件.*\n- 第二条。\n/)
  assert.match(section, /### English\n- Market plugin.*\n- Second\.\n/)

  const changelog = '# Changelog\n\nblurb\n\n## [v0.13.9] - 2026-09-25\n\n### 中文\n- old\n'
  const updated = insertSection(changelog, section, '0.14.0')
  assert.ok(updated.indexOf('## [v0.14.0]') < updated.indexOf('## [v0.13.9]'))
  assert.throws(() => insertSection(updated, section, '0.14.0'), /already has a section/)
})

test('section bullets are read back per language', () => {
  const changelog = '# Changelog\n\n## [v0.14.0] - 2026-09-26\n\n### 中文\n- 一\n- 二\n\n### English\n- one\n\n## [v0.13.9] - 2026-09-25\n\n### 中文\n- old\n'
  assert.deepEqual(sectionBullets(changelog, '0.14.0'), { zh: ['- 一', '- 二'], en: ['- one'] })
  assert.deepEqual(sectionBullets(changelog, '0.13.9'), { zh: ['- old'], en: [] })
  assert.deepEqual(sectionBullets(changelog, '0.12.0'), { zh: [], en: [] })
})

test('fragments are read from a directory in name order', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-changeset-'))
  try {
    writeFileSync(path.join(dir, 'b.md'), FRAGMENT)
    writeFileSync(path.join(dir, 'a.md'), '---\nshell: none\n---\n\n仅运行时。\nRuntime only.\n')
    writeFileSync(path.join(dir, 'README.md'), '# not a fragment\n')
    const fragments = readFragments(dir)
    assert.deepEqual(fragments.map((entry) => entry.name), ['a.md', 'b.md'])
    assert.equal(fragments[0].fragment.shell, 'none')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty directory reads as no fragments, not a throw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-changeset-'))
  try {
    assert.deepEqual(readFragments(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fragment whose plugin list is empty parses', () => {
  const parsed = parseFragment('---\nshell: none\n---\n\nzh\nen\n', 'x.md')
  assert.deepEqual(parsed.plugins, [])
})

// ------------------------------------------------------- git output parsing
//
// The gate reads git output, and git's default output format is not neutral: it
// quotes non-ASCII paths, and its rename handling depends on configuration. These
// are pinned against literal git output so the parsing layer cannot drift back to
// something that silently ignores a Chinese fragment name — which fails a
// legitimate release commit with a message about a missing fragment.

test('NUL-separated records survive spaces, newlines and non-ASCII names', () => {
  assert.deepEqual(nulRecords('a.md\0b c.md\0'), ['a.md', 'b c.md'])
  assert.deepEqual(nulRecords('changesets/中文说明.md\0'), ['changesets/中文说明.md'])
  // The trailing record is the terminator's own empty string, not a path.
  assert.deepEqual(nulRecords(''), [])
})

test('name-status parses modifications, additions and deletions', () => {
  const records = ['M', 'src/main/a.ts', 'A', 'changesets/new.md', 'D', 'changesets/old.md']
  assert.deepEqual(parseNameStatus(records), {
    paths: ['src/main/a.ts', 'changesets/new.md', 'changesets/old.md'],
    deleted: ['changesets/old.md'],
  })
})

test('a rename reports the new path and is not a deletion', () => {
  // `R100\0old\0new`: three fields. Counting the old path as deleted would hand
  // out a release exemption nobody earned.
  const records = ['R100', 'changesets/before.md', 'changesets/after.md']
  const parsed = parseNameStatus(records)
  assert.deepEqual(parsed.paths, ['changesets/after.md'])
  assert.deepEqual(parsed.deleted, [])
})

test('a copied file reports the new path too', () => {
  const parsed = parseNameStatus(['C075', 'changesets/a.md', 'changesets/b.md'])
  assert.deepEqual(parsed.paths, ['changesets/b.md'])
  assert.deepEqual(parsed.deleted, [])
})

test('only a heading the parent did not carry counts as released', () => {
  const diff = [
    '+++ b/CHANGELOG.md',
    '+## [v0.17.2] - 2026-10-22',
    '+### 中文',
    '-## [v0.17.1] - 2026-10-21',
  ].join('\n')
  // A genuinely new version.
  assert.deepEqual(addedVersions(diff, ['0.17.1']), ['0.17.2'])
  // The same heading when the parent already had it is a reorder or a reformat,
  // not a release.
  assert.deepEqual(addedVersions(diff, ['0.17.1', '0.17.2']), [])
})

test('a heading removed by the diff is never counted as added', () => {
  const diff = ['-## [v0.17.2] - 2026-10-22', '+## [v0.17.2] - 2026-10-23'].join('\n')
  // Whitespace-only moves still show a `+` line, so the parent check is what
  // makes this safe.
  assert.deepEqual(addedVersions(diff, ['0.17.1', '0.17.2']), [])
})

test('a malformed heading does not release anything', () => {
  // No brackets, no `v`, or a two-part version: none is a section this gate
  // recognises, and none may be accepted as a declaration.
  for (const line of ['+## v0.17.2 - 2026-10-22', '+## [0.17.2] - 2026-10-22', '+## [v0.17] - 2026-10-22']) {
    assert.deepEqual(addedVersions(line, []), [], line)
  }
})
