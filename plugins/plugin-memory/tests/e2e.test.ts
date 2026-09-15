/**
 * End-to-end walk of the plugin's real modules — no mocks, no stubs.
 *
 * Where the unit suites pin one function each, these drive the actual chain a
 * running plugin walks: write cards → migrate a legacy store → decide whether
 * the background pass stands down → pick what reaches the prompt. Every
 * assertion here would fail if the corresponding wiring were broken between
 * two modules, which per-function tests cannot see.
 *
 * @module @dsh-app/plugin-memory/tests/e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot, normalizeForMatch, projectSlug } from '../src/memory-store.ts'
import { buildDistillPrompt, resolveScope } from '../src/distiller.ts'
import { renderMemoryText, selectCards } from '../src/prompt.ts'

const fresh = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-e2e-')))

test('e2e: a workspace write lands in the project scope and never in the global one', () => {
  const root = fresh()
  const cwd = 'D:/codes/some-project'
  root.projectFor(cwd).upsert({ name: 'project-knowledge', category: 'lesson', summary: '项目知识', body: 'project-scoped knowledge' })
  root.global.upsert({ name: 'user-pref', category: 'preference', summary: '偏好', body: 'cross-workspace preference' })

  const projectTopics = join(root.dir, 'projects', projectSlug(cwd), 'topics')
  assert.ok(existsSync(join(projectTopics, 'project-knowledge.md')), 'the workspace write created its card file')
  assert.ok(readFileSync(join(projectTopics, 'project-knowledge.md'), 'utf8').includes('project-scoped knowledge'))
  assert.ok(root.global.get('project-knowledge') === undefined, 'the project write must not leak')
  assert.ok(existsSync(join(root.dir, 'topics', 'user-pref.md')))
  assert.ok(existsSync(join(root.dir, 'index.md')), 'the global index was rebuilt')
  assert.ok(existsSync(join(root.dir, 'projects', projectSlug(cwd), 'index.md')), 'the project index was rebuilt')

  // Scope comes from the session, never from the model's own tagging.
  assert.equal(resolveScope(cwd), 'project')
  assert.equal(resolveScope(undefined), 'global')
})

test('e2e: legacy store migrates at boot and keeps working as cards', () => {
  const root = fresh()
  writeFileSync(join(root.dir, 'memory.md'), '- [preference] 2026-09-01 用户偏好中文回复\n- [lesson] 2026-09-02 pnpm 11 白名单写进 workspace yaml\n', 'utf8')
  writeFileSync(join(root.dir, 'config.json'), `${JSON.stringify({ pinned: [normalizeForMatch('用户偏好中文回复')] })}\n`, 'utf8')

  root.migrateAll()
  assert.equal(existsSync(join(root.dir, 'memory.md')), false, 'the timeline file is gone')
  assert.equal(existsSync(join(root.dir, 'memory.legacy.md')), true, 'the archive survives')
  const cards = root.global.list()
  assert.equal(cards.length, 2)
  assert.equal(root.global.pinnedSet().size, 1, 'the legacy pin was remapped')

  // The migrated scope injects like any card scope.
  const text = renderMemoryText(root, undefined)
  assert.ok(text.includes('legacy-'), 'migrated cards appear in the index')
  assert.ok(text.includes('用户偏好中文回复'), 'migrated bodies inject')
})

test('e2e: own-write marks its seq → the background pass covers only what comes after', () => {
  const root = fresh()
  const id = 'session-e2e'
  assert.equal(root.ownSaveSeqOf(id), 0, 'nothing saved yet')

  root.recordDirectSave(id, 5)
  assert.equal(root.ownSaveSeqOf(id), 5, 'the session curated its own memory up to seq 5')
  root.recordDirectSave(id, 9)
  assert.equal(root.ownSaveSeqOf(id), 9, 'the highest save seq wins')

  root.advanceDistill(id, 12)
  assert.equal(root.ownSaveSeqOf(id), 0, 'a completed pass consumes the marker')
  assert.equal(root.distillSeqOf(id), 12)

  root.recordDirectSave(id, 20)
  assert.equal(root.ownSaveSeqOf(id), 20, 'the next save re-arms the marker')
  assert.equal(root.distillSeqOf(id), 12, 'and an own-write never rewinds the cursor')

  assert.equal(Math.max(root.distillSeqOf(id), root.ownSaveSeqOf(id)), 20)
})

test('e2e: an over-long pinned card cannot evict the pins behind it, and nothing unbounded is injected', () => {
  const root = fresh()
  root.global.upsert({ name: 'big-pin', category: 'preference', summary: '大固定卡', body: 'x'.repeat(380) })
  root.global.upsert({ name: 'newer-pin', category: 'preference', summary: '新固定卡', body: '短小正文' })
  const cards = root.global.list()
  const sel = selectCards(cards, 260, new Set(['big-pin', 'newer-pin']))
  assert.ok(sel.selected.some(card => card.name === 'newer-pin'), 'the newer pin survives')
  const injected = sel.selected.map(card => card.body).join('\n')
  assert.ok(injected.length <= 300, 'the injected bodies stay bounded around the budget')
})

test('e2e: cyrillic and kana content stays matchable end to end', () => {
  const cyrillic = 'резервное копирование'
  const kana = 'ありがとう ございます'
  assert.equal(normalizeForMatch(cyrillic), 'резервноекопирование')
  assert.equal(normalizeForMatch(kana), 'ありがとうございます')

  const root = fresh()
  root.global.upsert({ name: 'backup-window', category: 'lesson', summary: '备份窗口', body: cyrillic })
  assert.equal(root.global.hasContent(cyrillic), true)
  assert.equal(root.global.hasContent(kana), false, 'different content is still different')
  assert.equal(root.global.search('копирование').length, 1, 'search matches normalized content')
})

test('e2e: the distill prompt carries no scope field and shows the index', () => {
  const root = fresh()
  root.global.upsert({ name: 'user-pref', category: 'preference', summary: '全局偏好', body: 'a global preference' })
  const { system, user } = buildDistillPrompt('[user] hello', 'D:/proj', root)
  assert.ok(!system.includes('"scope"'), 'no scope field for the model to fill in')
  assert.ok(/host decides/i.test(system), 'the prompt says who decides')
  assert.ok(user.includes('user-pref'), 'the index is shown as context')
  assert.ok(user.includes('a global preference'), 'the card body is shown as context')

  const none = buildDistillPrompt('[user] hello', undefined, root)
  assert.ok(!/propose scope/i.test(none.user), 'a no-workspace session is told, not asked')
})
