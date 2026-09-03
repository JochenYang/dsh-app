/**
 * Core unit tests for the memory plugin: pure functions and store behavior.
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-memory/tests/core
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryRoot,
  MemoryStore,
  normalizeForMatch,
  parseEntries,
  projectSlug,
  todayStamp,
} from '../src/memory-store.ts'
import { selectBalanced } from '../src/prompt.ts'
import { MemoryCurator } from '../src/curator.ts'
import { existingNeedles } from '../src/distiller.ts'

const tmpStore = (): MemoryStore => new MemoryStore(mkdtempSync(join(tmpdir(), 'dshm-test-')))

const curatorApply = (store: MemoryStore, structured: unknown): { merged: number, deleted: number } => {
  const curator = new MemoryCurator(null as never, new MemoryRoot(store.dir), console)
  return (curator as unknown as { applyEdits(s: MemoryStore, u: unknown): { merged: number, deleted: number } }).applyEdits(store, structured)
}

// --- normalizeForMatch -------------------------------------------------------

test('normalizeForMatch: lowercase, keeps letters/digits/CJK, drops the rest', () => {
  assert.equal(normalizeForMatch('Hello  World!'), 'helloworld')
  assert.equal(normalizeForMatch('用 pnpm 跑 typecheck'), '用pnpm跑typecheck')
  assert.equal(normalizeForMatch('a-b_c.d'), 'abcd')
  assert.equal(normalizeForMatch(''), '')
})

// --- parseEntries ------------------------------------------------------------

test('parseEntries: standard lines split into category/date/content; hand notes kept verbatim', () => {
  const entries = parseEntries('- [lesson] 2026-09-01 alpha\n手写注释行\n- [fact] 2026-09-02 beta\n')
  assert.equal(entries.length, 3)
  assert.deepEqual(entries[0], { raw: '- [lesson] 2026-09-01 alpha', category: 'lesson', date: '2026-09-01', content: 'alpha' })
  assert.equal(entries[1].category, undefined)
  assert.equal(entries[1].content, '手写注释行')
  assert.equal(parseEntries('').length, 0)
})

// --- selectBalanced ----------------------------------------------------------

test('selectBalanced: per-category quota keeps the newest; budget is not the ceiling', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `- [lesson] 2026-09-0${String((i % 9) + 1)} lesson-${String(i + 1).padStart(2, '0')}`)
  const text = lines.join('\n')

  const small = selectBalanced(text, 120, new Set())
  assert.equal(small.selected.length, 2, 'lesson quota is 2')
  assert.ok(small.selected[1].includes('lesson-20'), 'newest kept')
  assert.equal(small.truncated, true)

  const big = selectBalanced(text, 10_000, new Set())
  assert.equal(big.selected.length, 2, 'quota caps injection regardless of budget')
})

test('selectBalanced: multiple categories each keep their own quota', () => {
  const text = ['preference', 'convention', 'decision', 'fact']
    .map(cat => Array.from({ length: 4 }, (_, i) => `- [${cat}] 2026-09-0${String(i + 1)} ${cat}-${String(i + 1)}`).join('\n'))
    .join('\n')
  const sel = selectBalanced(text, 10_000, new Set())
  assert.equal(sel.selected.length, 10, '3+3+2+2')
  assert.ok(sel.selected.some(line => line.includes('preference-2')))
  assert.ok(!sel.selected.some(line => line.includes('preference-1')))
})

test('selectBalanced: pin ranks first and survives a budget-hogging hand note', () => {
  const longNote = '手写行'.repeat(200)
  const text = [longNote, '- [preference] 2026-09-01 pinned-fact', '- [lesson] 2026-09-02 other'].join('\n')
  const sel = selectBalanced(text, 60, new Set([normalizeForMatch('pinned-fact')]))
  assert.ok(sel.selected.some(line => line.includes('pinned-fact')), 'pin injected')
})

test('selectBalanced: a single over-budget line still injects the first pinned entry whole', () => {
  const text = '- [preference] 2026-09-01 pinned-fact'
  const sel = selectBalanced(text, 10, new Set([normalizeForMatch('pinned-fact')]))
  assert.deepEqual(sel.selected, ['- [preference] 2026-09-01 pinned-fact'], 'first pin beats the budget')
  assert.equal(sel.truncated, true)
})

test('selectBalanced: an unpinned over-budget file returns empty (recall hint applies)', () => {
  const sel = selectBalanced('- [preference] 2026-09-01 plain-fact', 10, new Set())
  assert.deepEqual(sel.selected, [])
  assert.equal(sel.truncated, true)
})

// --- MemoryStore: append/hasContent/forget/removeContent ---------------------

test('append + hasContent: exact-content dedupe, never substring', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm 跑 typecheck')
  assert.equal(store.hasContent('用 pnpm 跑 typecheck'), true)
  assert.equal(store.hasContent('用 pnpm'), false, 'shorter wording is NOT a duplicate')
  assert.equal(store.hasContent('用 pnpm 跑 typecheck 和 build'), false)
})

test('forget: substring sweep over content (LLM tool semantics)', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm 跑 typecheck')
  store.append('lesson', '服务器在东京')
  const { removed, remaining } = store.forget('pnpm')
  assert.equal(removed.length, 1)
  assert.equal(remaining, 1)
  assert.ok(store.read().includes('服务器在东京'))
})

test('removeContent: exact row delete (settings-page semantics)', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm')
  store.append('lesson', '用 pnpm 跑 typecheck')
  const { removed, remaining } = store.removeContent('用 pnpm')
  assert.equal(removed.length, 1)
  assert.equal(remaining, 1)
  assert.ok(store.read().includes('用 pnpm 跑 typecheck'), 'the longer row survives')
})

// --- pin persistence + clear -------------------------------------------------

test('pin: persists in config.json, deduped, removable', () => {
  const store = tmpStore()
  assert.equal(store.addPin('Hello  World!'), true)
  assert.equal(store.addPin('Hello  World!'), false)
  assert.equal(store.pinnedSet().has(normalizeForMatch('Hello  World!')), true)
  assert.equal(store.removePin('hello world!'), true)
  assert.equal(store.pinnedSet().size, 0)
})

test('clear: drops entries AND pins (full reset)', () => {
  const store = tmpStore()
  store.append('lesson', 'one')
  store.addPin('one')
  store.clear()
  assert.equal(store.read(), '')
  assert.equal(store.pinnedSet().size, 0)
})

// --- replace -----------------------------------------------------------------

test('replace: crash-safe whole-file rewrite with trailing newline', () => {
  const store = tmpStore()
  store.replace('a\nb')
  assert.equal(store.read(), 'a\nb\n')
  store.replace('')
  assert.equal(store.read(), '')
  assert.equal(existsSync(store.filePath), true)
})

// --- projectSlug / projectBySlug ---------------------------------------------

test('projectSlug: deterministic, same basename in two parents never collides', () => {
  const a = projectSlug('D:/codes/DSH-APP')
  assert.equal(projectSlug('D:/codes/DSH-APP'), a)
  assert.notEqual(a, projectSlug('C:/elsewhere/DSH-APP'))
  assert.match(a, /^dsh-app-[a-f0-9]{8}$/)
})

test('projectBySlug: resolves a project store via project.json; unknown slug → undefined', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-root-')))
  assert.equal(root.projectBySlug('nope-nope'), undefined)
  const store = root.projectFor('D:/codes/DSH-APP')
  store.append('lesson', '项目条目')
  const slug = projectSlug('D:/codes/DSH-APP')
  const resolved = root.projectBySlug(slug)
  assert.ok(resolved !== undefined)
  assert.ok(resolved.read().includes('项目条目'))
  assert.equal(root.projectBySlug('../etc'), undefined, 'traversal fenced')
})

// --- distiller existingNeedles -----------------------------------------------

test('existingNeedles: exact-content set; short new wording is not eaten', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm 跑 typecheck')
  const needles = existingNeedles(store)
  assert.equal(needles.has(normalizeForMatch('用 pnpm 跑 typecheck')), true)
  assert.equal(needles.has(normalizeForMatch('用 pnpm')), false, 'substring is not a duplicate anymore')
  store.append('lesson', '手写行')
  assert.equal(existingNeedles(store).size, 2)
})

// --- curator applyEdits -------------------------------------------------------

test('curator: merge + delete land atomically', () => {
  const store = tmpStore()
  store.replace([
    '- [lesson] 2026-09-01 pnpm 很好',
    '- [lesson] 2026-09-02 继续用 pnpm',
    '- [fact] 2026-09-01 服务器在东京',
  ].join('\n'))
  const out = curatorApply(store, {
    edits: [
      { op: 'merge', lines: ['- [lesson] 2026-09-01 pnpm 很好', '- [lesson] 2026-09-02 继续用 pnpm'], category: 'lesson', content: '用户喜欢用 pnpm' },
      { op: 'delete', lines: ['- [fact] 2026-09-01 服务器在东京'] },
    ],
  })
  assert.deepEqual(out, { merged: 1, deleted: 1 })
  assert.equal(readFileSync(store.filePath, 'utf8'), `- [lesson] ${todayStamp()} 用户喜欢用 pnpm\n`)
})

test('curator: merge to own wording accepted (dedupe exempts replaced lines)', () => {
  const store = tmpStore()
  store.replace([
    '- [lesson] 2026-09-01 用户喜欢用 pnpm 管理依赖',
    '- [lesson] 2026-09-02 一直用 pnpm，别用 npm',
    '- [fact] 2026-09-01 无关的条目',
  ].join('\n'))
  const out = curatorApply(store, {
    edits: [{ op: 'merge', lines: ['- [lesson] 2026-09-01 用户喜欢用 pnpm 管理依赖', '- [lesson] 2026-09-02 一直用 pnpm，别用 npm'], category: 'lesson', content: '用户喜欢用 pnpm 管理依赖' }],
  })
  assert.deepEqual(out, { merged: 1, deleted: 0 })
  assert.equal(readFileSync(store.filePath, 'utf8'), `- [fact] 2026-09-01 无关的条目\n- [lesson] ${todayStamp()} 用户喜欢用 pnpm 管理依赖\n`)
})

test('curator: merge duplicating a SURVIVING line is rejected, file untouched', () => {
  const store = tmpStore()
  store.replace('- [lesson] 2026-09-01 keep me\n- [lesson] 2026-09-01 another\n')
  const out = curatorApply(store, { edits: [{ op: 'merge', lines: ['- [lesson] 2026-09-01 another'], category: 'lesson', content: 'keep me' }] })
  assert.deepEqual(out, { merged: 0, deleted: 0 })
  assert.equal(readFileSync(store.filePath, 'utf8'), '- [lesson] 2026-09-01 keep me\n- [lesson] 2026-09-01 another\n')
})

test('curator: ghost citation / double citation / malformed payload rejected', () => {
  const store = tmpStore()
  store.replace('- [lesson] 2026-09-01 one\n- [lesson] 2026-09-02 two\n')
  assert.deepEqual(curatorApply(store, { edits: [{ op: 'delete', lines: ['- [lesson] 1999-01-01 nowhere'] }] }), { merged: 0, deleted: 0 })
  assert.deepEqual(curatorApply(store, {
    edits: [
      { op: 'delete', lines: ['- [lesson] 2026-09-01 one'] },
      { op: 'delete', lines: ['- [lesson] 2026-09-01 one'] },
    ],
  }), { merged: 0, deleted: 1 })
  assert.deepEqual(curatorApply(store, { edits: [] }), { merged: 0, deleted: 0 })
  assert.deepEqual(curatorApply(store, null), { merged: 0, deleted: 0 })
  assert.deepEqual(curatorApply(store, { edits: [{ op: 'rewrite', lines: ['- [lesson] 2026-09-02 two'] }] }), { merged: 0, deleted: 0 })
})

test('curator: MAX_CURATE_EDITS caps a run of 30 valid merges at 20', () => {
  const store = tmpStore()
  const lines = Array.from({ length: 30 }, (_, i) => `- [lesson] 2026-09-01 条目${String(i)}`)
  store.replace(lines.join('\n'))
  const out = curatorApply(store, {
    edits: lines.map(line => ({ op: 'merge', lines: [line], category: 'lesson', content: `新${line.slice(23)}` })),
  })
  assert.equal(out.merged, 20, 'cap applies in the merge stage too')
  const remaining = parseEntries(store.read())
  assert.equal(remaining.length, 30, '30 originals replaced by 20 merges + 10 untouched')
})

// --- fixture helper used by the MAX test -------------------------------------

test('curator: oversized merge content rejected', () => {
  const store = tmpStore()
  store.replace('- [lesson] 2026-09-02 two\n')
  const out = curatorApply(store, { edits: [{ op: 'merge', lines: ['- [lesson] 2026-09-02 two'], category: 'fact', content: 'x'.repeat(501) }] })
  assert.deepEqual(out, { merged: 0, deleted: 0 })
  assert.equal(store.read(), '- [lesson] 2026-09-02 two\n')
})
