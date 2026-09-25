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
  decide,
  insertSection,
  isChangesetFile,
  isReleasablePath,
  parseFragment,
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
