/**
 * End-to-end walk of the plugin's real modules — no mocks, no stubs.
 *
 * Where the unit suites pin one function each, these drive the actual chain a
 * running plugin walks: write cards → migrate a legacy store → pick what
 * reaches the prompt. Every assertion here would fail if the corresponding
 * wiring were broken between two modules, which per-function tests cannot see.
 *
 * @module @dsh-app/plugin-memory/tests/e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot, normalizeForMatch, projectSlug } from '../src/memory-store.ts'
import { renderMemoryText, selectCards } from '../src/prompt.ts'

const fresh = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-e2e-')))

test('e2e: a workspace write lands in the project scope and never in the root one', async () => {
  const root = fresh()
  const cwd = 'D:/codes/some-project'
  await root.projectFor(cwd).upsert({ name: 'project-knowledge', category: 'lesson', summary: '项目知识', body: 'project-scoped knowledge' })

  const projectTopics = join(root.dir, 'projects', projectSlug(cwd), 'topics')
  assert.ok(existsSync(join(projectTopics, 'project-knowledge.md')), 'the workspace write created its card file')
  assert.ok(readFileSync(join(projectTopics, 'project-knowledge.md'), 'utf8').includes('project-scoped knowledge'))
  assert.equal(existsSync(join(root.dir, 'topics', 'project-knowledge.md')), false, 'the project write must not leak into the retired root scope')
  assert.ok(existsSync(join(root.dir, 'projects', projectSlug(cwd), 'index.md')), 'the project index was rebuilt')

  // The workspace is the only address there is: the memory of one project is
  // present in its own session's injection and structurally absent elsewhere.
  const here = renderMemoryText(root, cwd)
  assert.ok(here.includes('project-scoped knowledge'))
  const elsewhere = renderMemoryText(root, 'D:/codes/other-project')
  assert.ok(!elsewhere.includes('project-scoped knowledge'), 'another project never sees it')
  assert.ok(!renderMemoryText(root, undefined).includes('project-scoped knowledge'), 'nor does a session without a workspace')
})

test('e2e: legacy store migrates at boot; the retired global cards survive as a project', async () => {
  const root = fresh()
  writeFileSync(join(root.dir, 'memory.md'), '- [preference] 2026-09-01 用户偏好中文回复\n- [lesson] 2026-09-02 pnpm 11 白名单写进 workspace yaml\n', 'utf8')
  writeFileSync(join(root.dir, 'config.json'), `${JSON.stringify({ pinned: [normalizeForMatch('用户偏好中文回复')] })}\n`, 'utf8')

  await root.migrateAll()
  assert.equal(existsSync(join(root.dir, 'memory.md')), false, 'the timeline file is gone')
  assert.equal(existsSync(join(root.dir, 'memory.legacy.md')), true, 'the archive survives')
  assert.equal(root.global.list().length, 0, 'the retired global scope is emptied')

  // Nothing is lost: both cards (and the remapped pin) are in the project
  // directory the settings page lists, and nothing injects them any more.
  const legacy = root.projectBySlug('legacy-global')
  assert.ok(legacy !== undefined)
  assert.equal(legacy.list().length, 2)
  assert.equal(legacy.pinnedSet().size, 1, 'the legacy pin was remapped')
  assert.ok(existsSync(join(root.dir, 'projects', 'legacy-global', 'topics')), 'the cards are on disk under their new home')
  const text = renderMemoryText(root, undefined)
  assert.ok(!text.includes('用户偏好中文回复'), 'the retired scope is never injected')
  assert.ok(!text.includes('legacy-'), 'not even as index lines')
})

test('e2e: an over-long pinned card cannot evict the pins behind it, and nothing unbounded is injected', async () => {
  const root = fresh()
  const store = root.projectFor('D:/codes/big-pins')
  await store.upsert({ name: 'big-pin', category: 'preference', summary: '大固定卡', body: 'x'.repeat(380) })
  await store.upsert({ name: 'newer-pin', category: 'preference', summary: '新固定卡', body: '短小正文' })
  const cards = store.list()
  const sel = selectCards(cards, 260, new Set(['big-pin', 'newer-pin']))
  assert.ok(sel.selected.some(card => card.name === 'newer-pin'), 'the newer pin survives')
  const injected = sel.selected.map(card => card.body).join('\n')
  assert.ok(injected.length <= 300, 'the injected bodies stay bounded around the budget')
})

test('e2e: cyrillic and kana content stays matchable end to end', async () => {
  const cyrillic = 'резервное копирование'
  const kana = 'ありがとう ございます'
  assert.equal(normalizeForMatch(cyrillic), 'резервноекопирование')
  assert.equal(normalizeForMatch(kana), 'ありがとうございます')

  const root = fresh()
  const store = root.projectFor('D:/codes/scripts')
  await store.upsert({ name: 'backup-window', category: 'lesson', summary: '备份窗口', body: cyrillic })
  assert.equal(store.hasContent(cyrillic), true)
  assert.equal(store.hasContent(kana), false, 'different content is still different')
  assert.equal(store.search('копирование').length, 1, 'search matches normalized content')
})
