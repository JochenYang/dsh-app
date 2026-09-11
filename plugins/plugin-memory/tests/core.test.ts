/**
 * Core unit tests for the memory plugin: pure functions and store behavior.
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-memory/tests/core
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryRoot,
  MemoryStore,
  contentHash,
  normalizeForMatch,
  parseEntries,
  projectSlug,
  todayStamp,
} from '../src/memory-store.ts'
import { selectBalanced } from '../src/prompt.ts'
import { MemoryCurator } from '../src/curator.ts'
import { ROUTE_PREFIX, registerMemoryRoutes } from '../src/routes.ts'
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

test('normalizeForMatch: kana, Cyrillic and accented Latin survive too (no script is erased)', () => {
  assert.equal(normalizeForMatch('Резервное копирование'), 'резервноекопирование')
  assert.equal(normalizeForMatch('ありがとう ございます'), 'ありがとうございます')
  assert.equal(normalizeForMatch('café  ÀÉÎ'), 'caféàéî')
  assert.equal(normalizeForMatch('한국어 메모'), '한국어메모')
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

test('selectBalanced: an over-budget pin is clipped into the budget, never dropped or injected whole', () => {
  const text = '- [preference] 2026-09-01 pinned-fact'
  const budget = 10
  const sel = selectBalanced(text, budget, new Set([normalizeForMatch('pinned-fact')]))
  // A pin MUST reach the prompt — that is the contract — but "whole" used to
  // mean an over-long hand-written line could grow every new session's system
  // prompt without bound. It is clipped to the budget with a marked cut.
  assert.equal(sel.selected.length, 1, 'the pin still reaches the prompt')
  assert.ok(sel.selected[0]!.length <= budget, 'the injected line fits the budget')
  assert.match(sel.selected[0]!, /…$/, 'the cut is visible')
  assert.equal(sel.truncated, true)
})

test('selectBalanced: a pin that does not fit must not evict the pins behind it', () => {
  // The priority list runs oldest-first, so a plain `break` dropped the NEWEST
  // pins first — exactly backwards for the entries a user explicitly pinned.
  const big = `- [preference] 2026-09-01 ${'x'.repeat(200)}`
  const newest = '- [preference] 2026-09-02 newest-pin'
  const text = [big, newest].join('\n')
  const budget = 200
  const sel = selectBalanced(text, budget, new Set([
    normalizeForMatch('x'.repeat(200)),
    normalizeForMatch('newest-pin'),
  ]))
  assert.ok(sel.selected.some(line => line.includes('newest-pin')), 'the newest pin survives the older over-long one')
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

test('forget: a pure-Cyrillic match sweeps the entry (no empty needle)', () => {
  const store = tmpStore()
  store.append('fact', 'Резервное копирование идёт в 3 часа ночи')
  const { removed, remaining } = store.forget('резервное копирование')
  assert.equal(removed.length, 1)
  assert.equal(remaining, 0)
  assert.equal(store.read(), '')
})

test('hasContent/addPin: pure-kana text is real content, not an empty needle', () => {
  const store = tmpStore()
  store.append('fact', 'ありがとう ございます')
  assert.equal(store.hasContent('ありがとう ございます'), true)
  assert.equal(store.hasContent('ありがとう'), false, 'shorter wording is not a duplicate')
  assert.equal(store.addPin('ありがとう ございます'), true)
  assert.equal(store.pinnedSet().has(normalizeForMatch('ありがとう ございます')), true)
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

test('removeContent: the deleted row takes its pin with it, survivors keep theirs', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm')
  store.append('lesson', '服务器在东京')
  store.addPin('用 pnpm')
  store.addPin('服务器在东京')
  const { removed } = store.removeContent('用 pnpm')
  assert.equal(removed.length, 1)
  assert.equal(store.pinnedSet().has(normalizeForMatch('用 pnpm')), false, 'no dangling pin for the deleted row')
  assert.equal(store.pinnedSet().has(normalizeForMatch('服务器在东京')), true, 'the surviving row stays pinned')
})

test('forget: pins follow the swept rows only (substring match, per-row cleanup)', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm 跑 typecheck')
  store.append('lesson', '用 pnpm 跑 build')
  store.addPin('用 pnpm 跑 typecheck')
  store.addPin('用 pnpm 跑 build')
  const { removed } = store.forget('typecheck')
  assert.equal(removed.length, 1)
  assert.equal(store.pinnedSet().has(normalizeForMatch('用 pnpm 跑 typecheck')), false)
  assert.equal(store.pinnedSet().has(normalizeForMatch('用 pnpm 跑 build')), true, 'the untouched row stays pinned')
})

test('a row re-saved after deletion is not auto-pinned by a leftover pin', () => {
  const store = tmpStore()
  store.append('lesson', '用 pnpm')
  store.addPin('用 pnpm')
  assert.equal(store.removeContent('用 pnpm').removed.length, 1)
  assert.equal(store.pinnedSet().size, 0, 'the pin went with the row')
  assert.equal(store.hasContent('用 pnpm'), false, 'nothing left to dedupe against')
  store.append('lesson', '用 pnpm')
  // The settings row flag is pinnedSet().has(normalizeForMatch(content)).
  assert.equal(store.pinnedSet().has(normalizeForMatch('用 pnpm')), false, 'the rewritten row is NOT pinned')
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

test('curator: an edit citing a pinned line is skipped, the pin stays matched', () => {
  const store = tmpStore()
  store.replace([
    '- [lesson] 2026-09-01 用户喜欢 pnpm',
    '- [lesson] 2026-09-02 继续用 pnpm',
    '- [fact] 2026-09-01 服务器在东京',
  ].join('\n'))
  store.addPin('用户喜欢 pnpm')
  const out = curatorApply(store, {
    edits: [
      { op: 'merge', lines: ['- [lesson] 2026-09-01 用户喜欢 pnpm', '- [lesson] 2026-09-02 继续用 pnpm'], category: 'lesson', content: '用户坚持用 pnpm' },
      { op: 'delete', lines: ['- [fact] 2026-09-01 服务器在东京'] },
    ],
  })
  assert.deepEqual(out, { merged: 0, deleted: 1 }, 'the pinned merge is skipped, the unpinned delete lands')
  assert.equal(store.read(), '- [lesson] 2026-09-01 用户喜欢 pnpm\n- [lesson] 2026-09-02 继续用 pnpm\n')
  assert.equal(store.pinnedSet().size, 1)
  const survivors = new Set(parseEntries(store.read()).map(entry => normalizeForMatch(entry.content)))
  for (const pin of store.pinnedSet()) {
    assert.ok(survivors.has(pin), 'no pin is left without a matching line')
  }
})

test('curator: a delete citing only a pinned line leaves file and pin untouched', () => {
  const store = tmpStore()
  store.replace('- [fact] 2026-09-01 服务器在东京\n')
  store.addPin('服务器在东京')
  const out = curatorApply(store, { edits: [{ op: 'delete', lines: ['- [fact] 2026-09-01 服务器在东京'] }] })
  assert.deepEqual(out, { merged: 0, deleted: 0 })
  assert.equal(store.read(), '- [fact] 2026-09-01 服务器在东京\n')
  assert.equal(store.pinnedSet().has(normalizeForMatch('服务器在东京')), true)
})

// --- curator sweep gating: change detection + cooldown -------------------------

/** A file just above CURATE_MIN_ENTRIES (8 lines). */
const eightEntries = (): string =>
  Array.from({ length: 8 }, (_, i) => `- [lesson] 2026-09-0${String((i % 8) + 1)} 条目-${String(i + 1)}`).join('\n')

const selectTargetsOf = (curator: MemoryCurator): { label: string }[] =>
  (curator as unknown as { selectTargets(): { label: string }[] }).selectTargets()

test('curator: selectTargets skips files unchanged since their last pass', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-cd-')))
  root.global.replace(eightEntries())
  const curator = new MemoryCurator(null as never, root, console)

  assert.deepEqual(selectTargetsOf(curator).map(t => t.label), ['global'], 'no hash recorded yet → due')

  root.recordCurated('global', contentHash(root.global.read()))
  assert.deepEqual(selectTargetsOf(curator), [], 'unchanged file is skipped')

  root.global.append('lesson', '新写的一条')
  assert.deepEqual(selectTargetsOf(curator).map(t => t.label), ['global'], 'any writer touching the file re-arms it')

  // A project store is gated the same way, keyed by its slug (append, since
  // it is the write path that creates a fresh project directory).
  const demo = root.projectFor('D:/codes/Demo')
  for (let i = 1; i <= 8; i++) demo.append('lesson', `条目-${String(i)}`)
  const slug = projectSlug('D:/codes/Demo')
  assert.ok(selectTargetsOf(curator).some(t => t.label === slug), 'changed project store is due')
  root.recordCurated(slug, contentHash(demo.read()))
  assert.equal(selectTargetsOf(curator).some(t => t.label === slug), false, 'recorded project store is skipped')
})

test('curator: saves inside the cooldown coalesce into one trailing sweep', async () => {
  const { setTimeout: sleep } = await import('node:timers/promises')
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-cool-')))
  root.global.replace(eightEntries())
  // One entry per direct model call, holding the reviewed file text: that is
  // what proves WHICH target the sweep curated (the subagent channel used to
  // carry the target in its label).
  const reviewed: string[] = []
  const session = {
    id: 'session-a',
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const parent = { session } as never
  const ctx = {
    llm: {
      stream: async function* (options: { messages: { content?: { text?: string }[] }[] }) {
        reviewed.push(options.messages.map(m => (m.content ?? []).map(c => c.text ?? '').join('\n')).join('\n'))
        yield { type: 'text-delta', index: 0, text: '{"edits": []}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agents: { get: () => parent },
  }
  const curator = new MemoryCurator(ctx as never, root, console, 60)

  // 1st save: sweeps immediately and records the file hash.
  await curator.runAfterDistill(parent, 'session-a' as never)
  assert.equal(reviewed.length, 1, 'first save sweeps right away')
  assert.match(reviewed[0]!, /条目-1/, 'the sweep curated the global file')
  assert.equal(root.curatedHashOf('global'), contentHash(root.global.read()), 'completed pass records the hash')

  // 2nd/3rd saves inside the cooldown: no immediate work. The appended
  // entry stands in for what the distill just wrote — it makes the file
  // due again for the trailing sweep.
  root.global.append('lesson', '冷却期内新增的一条')
  await curator.runAfterDistill(parent, 'session-b' as never)
  await curator.runAfterDistill(parent, 'session-c' as never)
  assert.equal(reviewed.length, 1, 'no sweep while inside the cooldown')

  await sleep(200)
  assert.equal(reviewed.length, 2, 'exactly one trailing sweep at the original deadline')
  assert.match(reviewed[1]!, /冷却期内新增的一条/, 'the trailing sweep curated the global file')

  // After the cooldown elapses a save sweeps immediately — and since the
  // trailing pass just consolidated the file, it calls the model not at all.
  await curator.runAfterDistill(parent, 'session-d' as never)
  assert.equal(reviewed.length, 2, 'unchanged file: sweep runs, calls nothing')
})

test('curator: a direct call feeds its JSON through the host validation', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-direct-curate-')))
  root.global.replace(`${eightEntries()}\n- [lesson] 2026-09-01 用户用 pnpm\n- [fact] 2026-09-02 用户偏好 pnpm`)
  const session = {
    id: 'session-49ce2455-aaaa-bbbb-cccc-ddddeeeeffff',
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const parent = { session } as never
  const ctx = {
    llm: {
      // A fenced answer like a real model's: the contract is prompt-only now,
      // so the host's tolerant extraction has to do the parsing.
      stream: async function* () {
        yield {
          type: 'text-delta',
          index: 0,
          text: '```json\n{"edits": [{"op": "merge", "lines": ["- [lesson] 2026-09-01 用户用 pnpm", "- [fact] 2026-09-02 用户偏好 pnpm"], "category": "preference", "content": "用户用 pnpm"}]}\n```',
        }
        yield { type: 'usage', usage: { inputTokens: 700, outputTokens: 40 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agents: { get: () => parent },
  }
  const curator = new MemoryCurator(ctx as never, root, console, 60)

  await curator.runAfterDistill(parent, session.id as never)

  const text = root.global.read()
  assert.equal(text.includes('用户偏好 pnpm'), false, 'the merged pair is replaced')
  assert.ok(text.includes(`- [preference] ${todayStamp()} 用户用 pnpm`), 'the surviving merge is stamped by the host')
  assert.equal(root.curatedHashOf('global'), contentHash(text), 'the pass recorded the post-edit hash')
  const [run] = root.llmAudit()
  assert.equal(run?.source, 'curate', 'the pass is audited as a curate run')
  assert.equal(run?.status, 'ok')
  assert.equal(run?.inputTokens, 700)
  assert.equal(run?.outputTokens, 40)
  assert.equal(run?.session, '49ce2455')
})

// --- curator sweep: pinned lines are named to the model and survive ----------

test('curator sweep: a pinned line is listed in the prompt and survives the pass', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-curate-pin-')))
  root.global.replace(`${eightEntries()}\n- [lesson] 2026-09-01 用户用 pnpm\n- [fact] 2026-09-02 用户偏好 pnpm`)
  root.global.addPin('用户用 pnpm')
  const prompts: string[] = []
  const session = { id: 'session-pin', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
  const parent = { session } as never
  const ctx = {
    llm: {
      stream: async function* (options: unknown) {
        prompts.push(JSON.stringify(options))
        yield {
          type: 'text-delta',
          index: 0,
          text: '{"edits": [{"op": "merge", "lines": ["- [lesson] 2026-09-01 用户用 pnpm", "- [fact] 2026-09-02 用户偏好 pnpm"], "category": "preference", "content": "用户用 pnpm"}]}',
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agents: { get: () => parent },
  }
  const curator = new MemoryCurator(ctx as never, root, console, 60)

  await curator.runAfterDistill(parent, session.id as never)

  assert.match(prompts[0] ?? '', /--- Pinned entries \(user-fixed, never edited\) ---/, 'the model is told which line is pinned')
  const text = root.global.read()
  assert.ok(text.includes('- [lesson] 2026-09-01 用户用 pnpm'), 'the pinned line survives the pass')
  assert.ok(text.includes('- [fact] 2026-09-02 用户偏好 pnpm'), 'the rejected edit is not half-applied')
  assert.equal(root.global.pinnedSet().has(normalizeForMatch('用户用 pnpm')), true)
  const survivors = new Set(parseEntries(text).map(entry => normalizeForMatch(entry.content)))
  for (const pin of root.global.pinnedSet()) {
    assert.ok(survivors.has(pin), 'no pin is left without a matching line')
  }
})

// --- settings route: the pin fence still holds -------------------------------

test('pin route: an invalid or unknown project slug is rejected before any write', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-pin-route-')))
  const handlers = new Map<string, (req: unknown, res: unknown) => void>()
  const dispose = registerMemoryRoutes({
    register: (route: { path: string, handler: (req: never, res: never) => void }) => {
      handlers.set(route.path, route.handler as unknown as (req: unknown, res: unknown) => void)
      return () => undefined
    },
  }, root)
  const pin = handlers.get(`${ROUTE_PREFIX}/pin`)
  assert.ok(pin !== undefined, 'the pin route is registered')

  const call = async (body: Record<string, unknown>): Promise<{ status: number, body: Record<string, unknown> }> => {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      headers: { host: '127.0.0.1:3080' },
    })
    let status = 0
    let payload: Record<string, unknown> = {}
    const res = {
      setHeader: (): void => undefined,
      writeHead: (code: number): void => { status = code },
      end: (text: string): void => { payload = JSON.parse(text) as Record<string, unknown> },
    }
    pin(req as never, res as never)
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    await new Promise(resolve => setImmediate(resolve))
    return { status, body: payload }
  }

  const invalid = await call({ content: 'x', pinned: true, scope: 'project', slug: '../etc' })
  assert.equal(invalid.status, 400, 'traversal slug rejected')
  const unknown = await call({ content: 'x', pinned: true, scope: 'project', slug: 'nope-nope' })
  assert.equal(unknown.status, 400, 'unknown slug rejected')
  assert.equal(root.global.read(), '', 'no entry was written')
  assert.equal(existsSync(join(root.dir, 'config.json')), false, 'no pin was written')
  dispose()
})

test('savedSinceDistill: a session that curated its own memory stands the background pass down', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-save-')))
  const id = 'session-abc'
  // Never saved, never distilled: nothing to stand down from.
  assert.equal(root.savedSinceDistill(id), false)

  root.recordDirectSave(id)
  // The session judged its own material worth keeping → skip the second pass.
  assert.equal(root.savedSinceDistill(id), true)

  // A background pass AFTER the save clears the flag...
  root.advanceDistill(id, 42)
  assert.equal(root.savedSinceDistill(id), false)
  // ...and the cursor survives, so the next save does not rewind progress.
  assert.equal(root.distillSeqOf(id), 42)

  // A later save re-arms it.
  root.recordDirectSave(id)
  assert.equal(root.savedSinceDistill(id), true)
  assert.equal(root.distillSeqOf(id), 42, 'a direct save must not rewind the distill cursor')
})

test('recordDirectSave: creates the session record before any distill ever ran', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-save-new-')))
  // A session that saves first must still register: otherwise the background
  // pass would see no record at all and infer over material already curated.
  root.recordDirectSave('session-fresh')
  assert.equal(root.savedSinceDistill('session-fresh'), true)
  assert.equal(root.distillSeqOf('session-fresh'), 0)
})
