/**
 * Core unit tests for the memory plugin: pure functions, the card store,
 * migration, injection selection, and the light sweep.
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-memory/tests/core
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARCHIVE_MAX_FILES,
  ARCHIVE_RETENTION_DAYS,
  MAX_LEDGER_ENTRIES,
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  MemoryRoot,
  MemoryStore,
  contentSimilarity,
  isValidTopic,
  listProjects,
  normalizeForMatch,
  parseCard,
  projectSlug,
  renderCard,
  slugifyTopic,
  stripCommitIds,
  validateCardInput,
} from '../src/memory-store.ts'
import { renderCardBlock, renderMemoryText, selectCards } from '../src/prompt.ts'
import { lightSweep } from '../src/light-sweep.ts'
import { ROUTE_PREFIX, registerMemoryRoutes } from '../src/routes.ts'
import { CARD_TEXT_DISCIPLINE, CARD_TEXT_SURFACES, type CardTextSurface } from '../src/card-discipline.ts'
import { SAVE_TOOL_DESCRIPTION } from '../src/tools.ts'
import { buildCuratePrompt } from '../src/curator.ts'
import type { MemoryCategory } from '../src/types.ts'

const tmpStore = (): MemoryStore => new MemoryStore(mkdtempSync(join(tmpdir(), 'dshm-test-')))
const tmpRoot = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-root-')))

/** Save one well-formed card in one call. */
const save = async (store: MemoryStore, name: string, body: string, category: MemoryCategory = 'lesson', summary = ''): Promise<void> => {
  await store.upsert({ name, category, summary: summary === '' ? `${name} hook` : summary, body })
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

// --- topic keys ----------------------------------------------------------------

test('slugifyTopic: kebab-cases, translates nothing, drops CJK', () => {
  assert.equal(slugifyTopic('Pnpm 11 AllowScripts'), 'pnpm-11-allowscripts')
  assert.equal(slugifyTopic('release/010 state!'), 'release-010-state')
  assert.equal(slugifyTopic('中文主题'), '', 'pure-CJK proposals have no ASCII key')
  assert.equal(slugifyTopic('a'.repeat(80)).length <= 48, true, 'capped at 48 chars')
  assert.ok(isValidTopic(slugifyTopic('Pnpm 11 AllowScripts')))
  assert.equal(isValidTopic('../etc'), false)
  assert.equal(isValidTopic('-lead'), false)
})

// --- contentSimilarity ----------------------------------------------------------

test('contentSimilarity: identical is 1, disjoint is 0, reworded lands between', () => {
  assert.equal(contentSimilarity('用 pnpm 跑 typecheck', '用 pnpm 跑 typecheck'), 1)
  assert.equal(contentSimilarity('服务器在东京', '用户喜欢用浅色调色板'), 0)
  const score = contentSimilarity('pnpm 11 白名单必须写进 pnpm-workspace.yaml', 'pnpm 11 的白名单要写进 pnpm-workspace.yaml 文件')
  assert.ok(score > 0.5 && score < 1, `reworded Chinese scores mid-range, got ${String(score)}`)
  assert.equal(contentSimilarity('', 'anything'), 0)
})

// --- card (de)serialization -------------------------------------------------------

test('renderCard/parseCard: round-trip preserves every field', () => {
  const card = {
    name: 'pnpm11-allowscripts', category: 'lesson' as const,
    summary: 'pnpm 11 白名单写进 workspace yaml', created: '2026-09-01', updated: '2026-09-12',
    body: '正文：allowScripts 数组静默失效。', malformed: false,
  }
  const parsed = parseCard(card.name, renderCard(card))
  assert.deepEqual(parsed, card)
})

test('parseCard: a hand-edited file without frontmatter degrades to a verbatim malformed card', () => {
  const parsed = parseCard('hand-note', '随手记的一行，没有 frontmatter')
  assert.equal(parsed.malformed, true)
  assert.equal(parsed.body, '随手记的一行，没有 frontmatter')
  assert.equal(parsed.category, 'fact')
})

test('parseCard: CRLF line endings (Windows hand edit) still parse as a clean card', () => {
  const card = {
    name: 'crlf-card', category: 'lesson' as const, summary: '换行符兼容',
    created: '2026-09-01', updated: '2026-09-02', body: '正文内容', malformed: false,
  }
  const crlf = renderCard(card).replace(/\n/gu, '\r\n')
  const parsed = parseCard('crlf-card', crlf)
  assert.equal(parsed.malformed, false)
  assert.equal(parsed.body, '正文内容')
  assert.equal(parsed.summary, '换行符兼容')
})

test('validateCardInput: a credential in the SUMMARY is fenced too (it rides the index)', () => {
  const base = { name: 'ok-key', category: 'lesson', summary: 'hook', body: 'body' }
  assert.match(validateCardInput({ ...base, summary: 'api_key: sk-abc123def456' }) ?? '', /credential/)
  assert.match(validateCardInput({ ...base, body: 'bearer abcdef123' }) ?? '', /credential/)
})

test('validateCardInput: names, categories, lengths are fenced', () => {
  const base = { name: 'ok-key', category: 'lesson', summary: 'hook', body: 'body' }
  assert.equal(validateCardInput(base), undefined)
  assert.match(validateCardInput({ ...base, name: '中文键' }) ?? '', /invalid topic key/)
  assert.match(validateCardInput({ ...base, category: 'nope' }) ?? '', /unknown category/)
  assert.match(validateCardInput({ ...base, summary: '' }) ?? '', /summary is required/)
  assert.match(validateCardInput({ ...base, summary: 'x'.repeat(MAX_SUMMARY_CHARS + 1) }) ?? '', /summary too long/)
  assert.match(validateCardInput({ ...base, body: '' }) ?? '', /empty content/)
  assert.match(validateCardInput({ ...base, body: 'x'.repeat(MAX_TOPIC_BODY_CHARS + 1) }) ?? '', /content too long/)
})

// --- store: upsert / remove / pins ---------------------------------------------

test('upsert: create → update → unchanged, and the index follows', async () => {
  const store = tmpStore()
  const created = await store.upsert({ name: 'release-flow', category: 'convention', summary: '发版流程', body: '先发 draft 再发布' })
  assert.equal(created.op, 'created')
  assert.equal(created.card.created, created.card.updated)

  const updated = await store.upsert({ name: 'release-flow', category: 'convention', body: '先发 draft，验证后再发布' })
  assert.equal(updated.op, 'updated')
  assert.equal(updated.card.summary, '发版流程', 'omitted summary is inherited')
  assert.equal(updated.card.created, created.card.created, 'created survives updates')

  const noop = await store.upsert({ name: 'release-flow', category: 'convention', body: '先发 draft，验证后再发布', summary: '发版流程' })
  assert.equal(noop.op, 'unchanged', 'a byte-identical save is a no-op')

  const index = store.indexText()
  assert.ok(index.includes('release-flow'), 'index lists the card')
  assert.ok(index.includes('发版流程'), 'index carries the summary hook')
  assert.ok(index.includes('[convention]'), 'index carries the category')
})

test('upsert: invalid input throws (callers pre-validate for friendly errors)', async () => {
  const store = tmpStore()
  await assert.rejects(async () => store.upsert({ name: '中文键', category: 'lesson', summary: 'x', body: 'y' }), /invalid topic key/)
})

test('a pin keyed by topic survives content rewrites; remove drops it', async () => {
  const store = tmpStore()
  await save(store, 'release-flow', '先发 draft')
  assert.equal(await store.addPin('release-flow'), true)
  await store.upsert({ name: 'release-flow', category: 'lesson', body: '改写后的正文，完全换了一批字' })
  assert.equal(store.pinnedSet().has('release-flow'), true, 'pin keyed by topic, not content')
  assert.ok(store.indexText().includes('📌'), 'the index marks the pin')
  assert.equal(await store.remove('release-flow'), true)
  assert.equal(store.pinnedSet().size, 0, 'the pin goes with the card')
  assert.equal(store.indexText(), '', 'the index of an empty scope is empty')
})

test('addPin: refuses absent cards and double pins', async () => {
  const store = tmpStore()
  assert.equal(await store.addPin('not-there'), false)
  await save(store, 'there', '正文')
  assert.equal(await store.addPin('there'), true)
  assert.equal(await store.addPin('there'), false)
})

test('forget: exact topic key wins; otherwise a content substring sweeps cards', async () => {
  const store = tmpStore()
  await save(store, 'pnpm-typecheck', '用 pnpm 跑 typecheck')
  await save(store, 'pnpm-build', '用 pnpm 跑 build')
  await save(store, 'tokyo-servers', '服务器在东京')
  const byKey = await store.forget('pnpm-typecheck')
  assert.deepEqual(byKey.removed, ['pnpm-typecheck'])
  const byContent = await store.forget('pnpm')
  assert.deepEqual(byContent.removed, ['pnpm-build'], 'substring sweeps summary+body, not the removed key')
  assert.equal(byContent.remaining, 1)
})

test('clear: drops cards, index, legacy archive and pins', async () => {
  const store = tmpStore()
  await save(store, 'one', '第一条')
  await store.addPin('one')
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-01-01 旧条目\n', 'utf8')
  await store.migrateLegacy()
  await store.clear()
  assert.equal(store.list().length, 0)
  assert.equal(store.indexText(), '')
  assert.equal(store.pinnedSet().size, 0)
  assert.equal(existsSync(join(store.dir, 'memory.legacy.md')), false)
})

test('hasContent: exact body match, never substring', async () => {
  const store = tmpStore()
  await save(store, 'pnpm-typecheck', '用 pnpm 跑 typecheck')
  assert.equal(store.hasContent('用 pnpm 跑 typecheck'), true)
  assert.equal(store.hasContent('用 pnpm'), false)
})

test('findSimilar: near-duplicate ranks first, disjoint text stays under the floor', async () => {
  const store = tmpStore()
  await save(store, 'pnpm11-allowscripts', 'pnpm 11 白名单必须写进 pnpm-workspace.yaml', 'lesson', 'pnpm 11 白名单')
  await save(store, 'tokyo-servers', '服务器在东京', 'fact', '东京服务器')
  const hits = store.findSimilar('pnpm 11 的白名单要写进 pnpm-workspace.yaml 文件')
  assert.equal(hits[0]?.name, 'pnpm11-allowscripts')
  assert.ok((hits[0]?.score ?? 0) > 0.5)
  assert.ok(!hits.some(hit => hit.name === 'tokyo-servers'), 'disjoint card stays under the floor')
})

// --- migration -------------------------------------------------------------------

test('migrateLegacy: entries become cards losslessly; pins remap; the archive is kept', async () => {
  const store = tmpStore()
  const legacy = [
    '- [lesson] 2026-09-01 用户在方案征询时期望一次性给出综合方案确认',
    '- [fact] 2026-09-02 服务器在东京',
    '- [lesson] 2026-09-03 pnpm 11 不再从 package.json 读配置',
    '- [lesson] 2026-09-03 pnpm 11 不再从 package.json 读配置',
    '手写的一行没有前缀',
  ].join('\n')
  writeFileSync(join(store.dir, 'memory.md'), `${legacy}\n`, 'utf8')
  const { migrated, pinsRemapped } = await store.migrateLegacy()

  assert.equal(migrated, 5, 'every parseable line becomes a card (identical lines converge on one key)')
  const cards = store.list()
  assert.equal(cards.length, 4, 'identical content converges on one legacy key')
  assert.ok(cards.every(card => card.name.startsWith('legacy-')), 'migrated keys are marked')
  assert.ok(cards.some(card => card.created === '2026-09-01'), 'legacy date lands in created')
  assert.ok(cards.some(card => card.category === 'lesson'))
  assert.ok(!existsSync(join(store.dir, 'memory.md')), 'the timeline file is gone')
  assert.ok(existsSync(join(store.dir, 'memory.legacy.md')), 'the archive is kept')
  assert.equal(store.needsMigration(), false)
  assert.equal(pinsRemapped, 0, 'no legacy pins existed')

  // Re-run is a no-op.
  assert.deepEqual(await store.migrateLegacy(), { migrated: 0, pinsRemapped: 0, pinsDropped: [] })
})

test('migrateLegacy: a legacy content-keyed pin lands on the migrated card', async () => {
  const store = tmpStore()
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-09-01 固定我\n- [fact] 2026-09-02 不固定\n', 'utf8')
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: [normalizeForMatch('固定我')] })}\n`, 'utf8')
  const { migrated, pinsRemapped } = await store.migrateLegacy()
  assert.equal(migrated, 2)
  assert.equal(pinsRemapped, 1)
  const pinnedCard = store.list().find(card => card.body === '固定我')
  assert.ok(pinnedCard !== undefined)
  assert.ok(store.pinnedSet().has(pinnedCard.name), 'the pin follows the content onto its card')
})

test('migrateLegacy: a crash-resume re-run keeps pins already remapped to topic keys', async () => {
  const store = tmpStore()
  // Simulate the crash window: a prior run wrote the card AND the topic-keyed
  // pin, but died before renaming memory.md — so this run re-migrates with
  // config.pinned already holding a topic key, not normalized content.
  await save(store, 'legacy-ab12cd34', '已迁移的卡')
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-09-01 已迁移的卡\n', 'utf8')
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: ['legacy-ab12cd34'] })}\n`, 'utf8')
  const { pinsRemapped, pinsDropped } = await store.migrateLegacy()
  assert.equal(pinsRemapped, 1, 'the already-keyed pin is carried over, not dropped')
  assert.deepEqual(pinsDropped, [])
  assert.ok(store.pinnedSet().has('legacy-ab12cd34'))
})

test('migrateLegacy: a genuinely unmatched legacy pin is reported, not silently lost', async () => {
  const store = tmpStore()
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-09-01 留存条目\n', 'utf8')
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: ['早已不存在的条目内容'] })}\n`, 'utf8')
  const { pinsRemapped, pinsDropped } = await store.migrateLegacy()
  assert.equal(pinsRemapped, 0)
  assert.deepEqual(pinsDropped, ['早已不存在的条目内容'])
})

test('migrateLegacy: credential-looking entries are not carried over', async () => {
  const store = tmpStore()
  writeFileSync(join(store.dir, 'memory.md'), '- [fact] 2026-09-01 正常条目\n- [fact] 2026-09-02 api_key: sk-abc123def456ghi7\n', 'utf8')
  const { migrated } = await store.migrateLegacy()
  assert.equal(migrated, 1, 'the credential-looking line is dropped at the gate')
})

test('migrateAll: migrates every store timeline, then retires the root scope', async () => {
  const root = tmpRoot()
  writeFileSync(join(root.dir, 'memory.md'), '- [lesson] 2026-09-01 全局旧条目\n', 'utf8')
  const project = root.projectFor('D:/codes/Demo')
  mkdirSync(project.dir, { recursive: true })
  writeFileSync(join(project.dir, 'memory.md'), '- [lesson] 2026-09-01 项目旧条目\n', 'utf8')
  writeFileSync(join(project.dir, 'project.json'), `${JSON.stringify({ cwd: 'D:/codes/Demo' })}\n`, 'utf8')
  await root.migrateAll()
  assert.equal(root.projectFor('D:/codes/Demo').list().length, 1, 'the project timeline stays in its own store')
  // The root timeline converted first and was then carried out with the rest
  // of the retired scope: running these passes the other way round would
  // orphan the freshly migrated cards in a directory nothing reads.
  assert.equal(root.global.list().length, 0)
  const legacy = root.projectBySlug('legacy-global')
  assert.ok(legacy !== undefined)
  assert.equal(legacy.list().length, 1)
  assert.equal(legacy.list()[0]?.body, '全局旧条目')
})

// --- retiring the global scope (boot migration, no data loss) -----------------

test('migrateLegacyGlobalScope: root cards move into projects/legacy-global, once', async () => {
  const root = tmpRoot()
  await save(root.global, 'old-global-a', '旧的全局卡甲', 'preference', '旧全局甲')
  await save(root.global, 'old-global-b', '旧的全局卡乙')
  await root.global.addPin('old-global-a')

  const moved = await root.migrateLegacyGlobalScope()
  assert.equal(moved, 2)
  assert.equal(root.global.list().length, 0, 'the retired scope is empty')
  const legacyDir = join(root.dir, 'projects', 'legacy-global')
  assert.ok(existsSync(join(legacyDir, 'topics', 'old-global-a.md')), 'the card file moved, not copied')
  assert.ok(existsSync(join(legacyDir, 'topics', 'old-global-b.md')))
  assert.equal(existsSync(join(root.dir, 'topics', 'old-global-a.md')), false, 'nothing is left behind')
  assert.equal(existsSync(join(root.dir, 'index.md')), false, 'the retired scope index goes with its cards')
  // The stamp is what makes the settings page list it as a project the user
  // can open and delete, with a placeholder cwd no session ever has.
  const meta: unknown = JSON.parse(readFileSync(join(legacyDir, 'project.json'), 'utf8'))
  assert.deepEqual(meta, { cwd: 'legacy-global' })

  const listed = listProjects(root.dir)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.slug, 'legacy-global')
  assert.equal(listed[0]!.cwd, 'legacy-global')
  assert.equal(listed[0]!.cards, 2)
  const store = root.projectBySlug('legacy-global')
  assert.ok(store !== undefined)
  assert.equal(store.get('old-global-a')?.body, '旧的全局卡甲', 'the content is intact')
  assert.equal(store.get('old-global-a')?.category, 'preference', 'and so is its category')
  assert.ok(store.pinnedSet().has('old-global-a'), 'a pin is the user\'s intent — it follows the card')

  // IDEMPOTENT: a second construction (a later boot) must move nothing again
  // and must not duplicate or overwrite what is already there.
  const nextBoot = new MemoryRoot(root.dir)
  assert.equal(await nextBoot.migrateLegacyGlobalScope(), 0, 'a second run finds nothing to move')
  assert.equal(listProjects(root.dir)[0]!.cards, 2, 'still exactly two cards')
  assert.equal(nextBoot.projectBySlug('legacy-global')?.list().length, 2)
})

test('migrateLegacyGlobalScope: an empty or absent root topics/ is a no-op', async () => {
  const root = tmpRoot()
  assert.equal(await root.migrateLegacyGlobalScope(), 0, 'no topics/ directory at all')
  await save(root.projectFor('D:/codes/Demo'), 'project-card', '项目卡片')
  assert.equal(await root.migrateLegacyGlobalScope(), 0)
  assert.equal(existsSync(join(root.dir, 'projects', 'legacy-global')), false, 'and no empty project directory is invented')
})

test('migrateLegacyGlobalScope: the retired scope archive moves with its cards', async () => {
  const root = tmpRoot()
  await save(root.global, 'retired-card', '会被删除的旧全局卡')
  await root.global.forget('retired-card')
  // The archive is the undo surface of THAT scope, and a restore writes back
  // into the store it belongs to: left at the root, "restore" would put a card
  // into a scope nothing injects and nothing lists.
  assert.equal(root.global.archiveCount(), 1)

  assert.equal(await root.migrateLegacyGlobalScope(), 0, 'there is no live card left to move')

  const moved = join(root.dir, 'projects', 'legacy-global', 'archive')
  assert.equal(existsSync(moved), true, 'the archived copy followed the scope')
  const store = root.projectBySlug('legacy-global')
  assert.ok(store !== undefined)
  const [row] = store.archivedCards()
  assert.ok(row !== undefined, 'and it is restorable from where it now lives')
  assert.equal(await store.restoreArchived(row.day, row.file, row.topic), 'restored')
  assert.equal(store.get('retired-card')?.body, '会被删除的旧全局卡')
})

test('migrateLegacyGlobalScope: a destination already holding the topic is not overwritten', async () => {
  const root = tmpRoot()
  await save(root.global, 'shared-key', '根目录里的版本')
  const legacyDir = join(root.dir, 'projects', 'legacy-global')
  mkdirSync(join(legacyDir, 'topics'), { recursive: true })
  writeFileSync(join(legacyDir, 'topics', 'shared-key.md'), renderCard({
    name: 'shared-key', category: 'lesson', summary: '已经在那里', created: '2026-01-01', updated: '2026-01-01', body: '已经搬到过目的地的版本', malformed: false,
  }), 'utf8')
  // A previous run's result (or a real card) wins; the source copy is left
  // where a human can see it rather than being silently overwritten.
  assert.equal(await root.migrateLegacyGlobalScope(), 0)
  const store = root.projectBySlug('legacy-global')
  assert.equal(store?.get('shared-key')?.body, '已经搬到过目的地的版本')
  assert.equal(root.global.get('shared-key')?.body, '根目录里的版本', 'the source is left in place for review')
})

// --- injection selection ----------------------------------------------------------

test('selectCards: per-category quota keeps the most recently updated cards', async () => {
  const store = tmpStore()
  for (let i = 1; i <= 5; i += 1) {
    await store.upsert({ name: `lesson-${String(i)}`, category: 'lesson', summary: `s${String(i)}`, body: `第 ${String(i)} 条` })
    // Force distinct updated stamps so the quota order is deterministic.
    const card = store.get(`lesson-${String(i)}`)!
    writeFileSync(join(store.dir, 'topics', `lesson-${String(i)}.md`), renderCard({ ...card, updated: `2026-09-0${String(i)}` }), 'utf8')
  }
  const sel = selectCards(store.list(), 10_000, new Set())
  assert.equal(sel.selected.length, 2, 'lesson quota is 2')
  assert.ok(sel.selected.some(card => card.name === 'lesson-5'), 'newest kept')
  assert.ok(sel.selected.some(card => card.name === 'lesson-4'))
  assert.equal(sel.truncated, true)
})

test('selectCards: pinned cards always win, an oversized pin is clipped not dropped', async () => {
  const store = tmpStore()
  await store.upsert({ name: 'big-pin', category: 'preference', summary: '大固定卡', body: 'x'.repeat(MAX_TOPIC_BODY_CHARS) })
  await store.upsert({ name: 'small-pin', category: 'preference', summary: '小固定卡', body: 'short' })
  const sel = selectCards(store.list(), 120, new Set(['big-pin', 'small-pin']))
  assert.ok(sel.selected.some(card => card.name === 'small-pin'), 'the small pin reaches the prompt')
  assert.equal(sel.truncated, true)
})

test('renderCardBlock: malformed cards render verbatim, normal cards get a heading', () => {
  const normal = parseCard('k', renderCard({ name: 'k', category: 'fact', summary: 's', created: '2026-01-01', updated: '2026-01-02', body: '正文', malformed: false }))
  assert.ok(renderCardBlock(normal).startsWith('### k [fact]'))
  const malformed = parseCard('hand', '手改内容')
  assert.equal(renderCardBlock(malformed), '手改内容')
})

test('renderMemoryText: the project index and cards inject; the retired root scope never does', async () => {
  const root = tmpRoot()
  // A card still sitting in the retired root scope (a store whose boot
  // migration has not run): it must not reach any session.
  await save(root.global, 'retired-global-card', '旧全局卡的内容不该再被注入', 'preference', '旧全局')
  await save(root.projectFor('D:/codes/Demo'), 'demo-flow', 'Demo 项目的约定', 'convention', 'Demo 约定')
  await save(root.projectFor('D:/codes/Other'), 'other-secret', '其它项目的卡片', 'fact', '其它')
  const text = renderMemoryText(root, 'D:/codes/Demo')
  assert.ok(text.includes('demo-flow'), 'project index line injected')
  assert.ok(text.includes('Demo 项目的约定'), 'project body injected')
  assert.ok(!text.includes('other-secret'), 'another project is structurally absent')
  assert.ok(!text.includes('retired-global-card'), 'the retired root scope is not injected')
  assert.ok(!text.includes('旧全局卡的内容不该再被注入'), 'nor is its content')
  const noCwd = renderMemoryText(root, undefined)
  assert.ok(!noCwd.includes('retired-global-card'), 'a session without a workspace gets no scope at all')
  assert.ok(!noCwd.includes('demo-flow'), 'no cwd → no project scope')
  // The guidelines ride every assembly, cwd or not: they are what asks the
  // model to save at all now that no background pass does it.
  assert.ok(text.includes('memory_save'))
  assert.ok(noCwd.includes('memory_save'))
})

test('renderMemoryText: the guidelines ask for the save themselves, at the end of the task', async () => {
  const root = tmpRoot()
  const text = renderMemoryText(root, 'D:/codes/Demo')
  // The extractor is retired, so this block is the ONLY thing that asks for a
  // save: it must name the tool, the moment, and what not to save.
  assert.match(text, /SAVE what is durable yourself, with memory_save, BEFORE the task ends/)
  assert.match(text, /no background\s+pass writes memory for you/)
  assert.match(text, /NEVER save/)
  assert.match(text, /work logs/)
  assert.match(text, /how far the\s+current task has got/)
  assert.match(text, /from the repo in one tool call/)
  // One scope, named: no global scope is offered anywhere in the block.
  assert.doesNotMatch(text, /\bGLOBAL\b/)
  assert.doesNotMatch(text, /scope "global"/)
})

// --- light sweep -------------------------------------------------------------------

test('lightSweep: exact-duplicate cards merge to the pinned/newest survivor; suspects logged', async () => {
  const root = tmpRoot()
  const store = root.global
  // Two keys, identical bodies (a hand-edit accident).
  await save(store, 'dup-a', '完全相同的内容')
  await save(store, 'dup-b', '完全相同的内容')
  await store.addPin('dup-b')
  // A near-duplicate pair under different keys (similarity suspect).
  await save(store, 'sim-a', 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效')
  await save(store, 'sim-b', 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才可生效')
  const out = await lightSweep(root, 'global', store, console)
  assert.equal(out.merged, 1)
  assert.equal(store.get('dup-a'), undefined, 'unpinned duplicate removed')
  assert.ok(store.get('dup-b') !== undefined, 'the pinned card survives')
  assert.ok(out.suspects >= 1, 'the near-dup pair is logged as a suspect')
  assert.ok(root.simSuspects().some(s => s.scope === 'global'))
})

test('lightSweep: never throws on an empty store', async () => {
  const root = tmpRoot()
  assert.deepEqual(await lightSweep(root, 'global', root.global, console), { merged: 0, suspects: 0 })
})

// --- settings routes: the exact-Fetch registration ----------------------------

/** One registered route as the test registry holds it. */
interface RegisteredRoute {
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Register the settings routes over one root: the exact-Fetch registry, a
 *  caller that reports the JSON answer, and the disposer. */
function settingsRoutes(root: MemoryRoot) {
  const routes = new Map<string, RegisteredRoute>()
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      assert.equal(routes.has(route.path), false, `${route.path} is registered once`)
      routes.set(route.path, route)
      return () => Promise.resolve()
    },
  } as never, root)
  const call = async (
    path: string,
    body: Record<string, unknown> | undefined,
    method = 'POST',
  ): Promise<{ status: number, body: Record<string, unknown> }> => {
    const route = routes.get(`${ROUTE_PREFIX}/${path}`)
    assert.ok(route !== undefined, `the ${path} route is registered`)
    assert.ok(route.methods.includes(method), `the ${path} route owns ${method}`)
    const response = await route.fetch(new Request(`https://localhost${ROUTE_PREFIX}/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }))
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { routes, call, dispose }
}

/** The coded message of a refusal: what the client maps to its own copy (and
 *  the English diagnostic it falls back to for a code it does not know). */
function hostMessage(body: Record<string, unknown>): { code: string, params?: Record<string, unknown>, text?: string } {
  return (body as { error: { host: { code: string } } }).error.host
}

test('pin route: an invalid or unknown project slug is rejected before any write', async () => {
  const root = tmpRoot()
  const routes = settingsRoutes(root)

  const invalid = await routes.call('pin', { topic: 'x', pinned: true, scope: 'project', slug: '../etc' })
  assert.equal(invalid.status, 400, 'traversal slug rejected')
  assert.equal(hostMessage(invalid.body).code, 'route.slugRequired', 'the refusal is a stable code, not a sentence')
  const unknown = await routes.call('pin', { topic: 'x', pinned: true, scope: 'project', slug: 'nope-nope' })
  assert.equal(unknown.status, 400, 'unknown slug rejected')
  assert.equal(hostMessage(unknown.body).code, 'route.projectUnknown')
  assert.equal(root.global.list().length, 0, 'no card was written')
  assert.equal(existsSync(join(root.dir, 'config.json')), false, 'no pin was written')
  void routes.dispose()
})

test('settings routes: every refusal carries a code plus the values the client interpolates', async () => {
  const root = tmpRoot()
  const routes = settingsRoutes(root)

  const badSlug = await routes.call('clear', { scope: 'project', slug: '../etc' })
  assert.equal(badSlug.status, 400)
  assert.equal(hostMessage(badSlug.body).code, 'route.slugInvalid')

  const badScope = await routes.call('clear', { scope: 'somewhere' })
  assert.equal(badScope.status, 400)
  assert.equal(hostMessage(badScope.body).code, 'route.scopeRequired')

  const badTopic = await routes.call('pin', { topic: 'not a topic key', pinned: true })
  assert.equal(badTopic.status, 400)
  assert.equal(hostMessage(badTopic.body).code, 'route.topicInvalid')

  const badToggle = await routes.call('config', { enabled: 'yes' })
  assert.equal(badToggle.status, 400)
  assert.equal(hostMessage(badToggle.body).code, 'route.enabledNotBoolean')

  // A route claims the methods it owns and nothing else: the registry never
  // hands a route a method it did not claim, so a GET can never reach the
  // mutating handlers (it falls through to the shared channel's own 404).
  assert.deepEqual(routes.routes.get(`${ROUTE_PREFIX}/config`)?.methods, ['POST'])
  assert.deepEqual(routes.routes.get(`${ROUTE_PREFIX}/status`)?.methods, ['GET'])
  assert.deepEqual(routes.routes.get(`${ROUTE_PREFIX}/entries`)?.methods, ['GET'])

  // Every path stays inside the registry's segment grammar. An `@` (the npm
  // scope) is refused at registration and would take the whole route set down
  // with it, so the shape is asserted here instead of discovered on a boot.
  for (const path of routes.routes.keys()) {
    assert.ok(path.startsWith('/api/plugins/dsh-app/plugin-memory/'), `${path} stays below the /api channel`)
    for (const segment of path.split('/').filter(part => part !== '')) {
      assert.match(segment, /^[A-Za-z0-9_$.-]+$/u, `${path} has no segment outside the allowed alphabet`)
    }
  }

  assert.equal(root.global.list().length, 0, 'no refusal wrote anything')
  void routes.dispose()
})

test('settings routes: an unparseable or oversized body is refused before it reaches the store', async () => {
  const root = tmpRoot()
  const routes = settingsRoutes(root)

  // Over the 8 KiB cap: refused on the declared length, before parsing — and
  // the toggle inside it never lands.
  const oversized = await routes.call('config', { enabled: false, pad: 'x'.repeat(9_000) })
  assert.equal(oversized.status, 413)
  assert.equal(hostMessage(oversized.body).code, 'route.bodyTooLarge')
  assert.equal(root.global.isEnabled(), true, 'the oversized body was not applied')
  assert.equal(existsSync(join(root.dir, 'config.json')), false, 'nothing was written')

  // Not JSON at all: the parse fault is a technical detail the client wraps in
  // its own sentence, so it travels as a param.
  const config = routes.routes.get(`${ROUTE_PREFIX}/config`)
  assert.ok(config !== undefined)
  const malformed = await config.fetch(new Request(`https://localhost${ROUTE_PREFIX}/config`, {
    method: 'POST',
    body: 'not json',
  }))
  assert.equal(malformed.status, 400)
  const malformedBody = await malformed.json() as Record<string, unknown>
  assert.equal(hostMessage(malformedBody).code, 'route.invalidBody')
  assert.equal(typeof hostMessage(malformedBody).params?.detail, 'string')

  void routes.dispose()
})

// --- stripCommitIds ----------------------------------------------------------------

test('stripCommitIds: removes mixed hex commit ids; keeps counts, slugs and words', () => {
  assert.equal(stripCommitIds('修复 fb8b001 已验证'), '修复 已验证')
  assert.equal(stripCommitIds('commit 37db725 lands'), 'commit lands')
  assert.equal(stripCommitIds('上限 1048576 tokens'), '上限 1048576 tokens', 'pure digits are counts/timestamps, not ids')
  assert.equal(stripCommitIds('时间戳 1789031659 丢弃'), '时间戳 1789031659 丢弃', 'a 10-digit unix seconds value is not an id')
  assert.equal(stripCommitIds('项目 agent-comm-hub-cf86ffc4 的坑'), '项目 agent-comm-hub-cf86ffc4 的坑', 'slug hex is part of a name, not an id')
  assert.equal(stripCommitIds('deadbeef 值'), 'deadbeef 值', 'a pure-hex-letters word is not an id')
  assert.equal(stripCommitIds('fb8b001'), '', 'an id-only proposal becomes empty (rejected upstream)')
  assert.equal(stripCommitIds('无 id 的普通条目'), '无 id 的普通条目', 'clean content passes through untouched')
})

// --- projectSlug / projectBySlug ---------------------------------------------------

test('projectSlug: deterministic, same basename in two parents never collides', () => {
  const a = projectSlug('D:/codes/DSH-APP')
  assert.equal(projectSlug('D:/codes/DSH-APP'), a)
  assert.notEqual(a, projectSlug('C:/elsewhere/DSH-APP'))
  assert.match(a, /^dsh-app-[a-f0-9]{8}$/)
})

test('projectBySlug: resolves a project store via project.json; unknown slug → undefined', async () => {
  const root = tmpRoot()
  assert.equal(root.projectBySlug('nope-nope'), undefined)
  await save(root.projectFor('D:/codes/DSH-APP'), 'demo-card', '项目卡片')
  const slug = projectSlug('D:/codes/DSH-APP')
  const resolved = root.projectBySlug(slug)
  assert.ok(resolved !== undefined)
  assert.ok(resolved.get('demo-card') !== undefined)
  assert.equal(root.projectBySlug('../etc'), undefined, 'traversal fenced')
})

// --- archive (undo for automated deletions) ----------------------------------

test('archive: forget keeps a byte-identical copy of the removed card', async () => {
  const store = tmpStore()
  await save(store, 'archived-card', '这张卡的内容必须能从归档里原样取回', 'lesson', '归档验证')
  const before = renderCard(store.get('archived-card')!)
  const { removed } = await store.forget('archived-card')
  assert.deepEqual(removed, ['archived-card'])
  assert.equal(store.get('archived-card'), undefined, 'the card is gone from topics/')
  const archived = store.archivedCards()
  assert.equal(archived.length, 1)
  assert.equal(archived[0]!.topic, 'archived-card')
  // Byte-identical: the archived file can be copied straight back into topics/.
  const text = readFileSync(join(store.dir, 'archive', archived[0]!.day, 'archived-card.md'), 'utf8')
  assert.equal(text, before)
})

test('archive: restore puts the card back and rebuilds the index', async () => {
  const store = tmpStore()
  await save(store, 'restore-me', '恢复后必须重新出现在列表与索引里')
  await store.forget('restore-me')
  const [entry] = store.archivedCards()
  const outcome = await store.restoreArchived(entry!.day, entry!.file, entry!.topic)
  assert.equal(outcome, 'restored')
  assert.equal(store.get('restore-me')?.body, '恢复后必须重新出现在列表与索引里')
  assert.match(store.indexText(), /restore-me/, 'the host-owned index reflects the restore')
})

test('archive: restore refuses an occupied key rather than overwriting it', async () => {
  const store = tmpStore()
  await save(store, 'reused-key', '旧内容')
  await store.forget('reused-key')
  const [entry] = store.archivedCards()
  // A new card takes the same key before the restore is attempted.
  await save(store, 'reused-key', '新内容')
  assert.equal(await store.restoreArchived(entry!.day, entry!.file, 'reused-key'), 'occupied')
  assert.equal(store.get('reused-key')?.body, '新内容', 'the live card is untouched')
})

test('archive: restore rejects a malformed day, file or topic and a missing copy', async () => {
  const store = tmpStore()
  await save(store, 'safe-card', '内容')
  await store.forget('safe-card')
  const [entry] = store.archivedCards()
  assert.equal(await store.restoreArchived('../etc', entry!.file, 'safe-card'), 'invalid', 'traversal fenced')
  assert.equal(await store.restoreArchived(entry!.day, 'no-such-card', 'no-such-card'), 'missing')
  assert.equal(await store.restoreArchived(entry!.day, entry!.file, 'Not_A_Topic'), 'invalid')
  // The file stem is fenced on its own: a path separator or a dot never
  // reaches the filesystem even when day and topic are well formed.
  assert.equal(await store.restoreArchived(entry!.day, '../safe-card', 'safe-card'), 'invalid')
  assert.equal(await store.restoreArchived(entry!.day, 'safe-card.md', 'safe-card'), 'invalid')
})

test('archive: the light sweep archives the duplicate it merges away', async () => {
  const root = tmpRoot()
  await save(root.global, 'dup-keep', '完全一样的内容')
  await save(root.global, 'dup-drop', '完全一样的内容')
  const log = { info: (): void => undefined, warn: (): void => undefined }
  const { merged } = await lightSweep(root, 'global', root.global, log)
  assert.equal(merged, 1)
  assert.equal(root.global.list().length, 1, 'one of the two duplicates survives')
  // Whichever one the survivor rule dropped must be recoverable from the archive.
  const survivor = root.global.list()[0]!.name
  const dropped = survivor === 'dup-keep' ? 'dup-drop' : 'dup-keep'
  assert.ok(root.global.archivedCards().some(card => card.topic === dropped), `the merged-away "${dropped}" is recoverable`)
})

test('archive: clear() removes the archive too (the reset means a clean slate)', async () => {
  const store = tmpStore()
  await save(store, 'gone-card', '内容')
  await store.forget('gone-card')
  assert.equal(store.archiveCount(), 1)
  await store.clear()
  assert.equal(store.archiveCount(), 0)
})

test('archive: the archived copy never enters the live list, index or similarity gate', async () => {
  const store = tmpStore()
  await save(store, 'hidden-card', '这段文字在归档后不应再被召回')
  await store.forget('hidden-card')
  assert.equal(store.list().length, 0, 'topics/ is empty')
  assert.equal(store.indexText(), '', 'the index does not mention it')
  assert.equal(store.hasContent('这段文字在归档后不应再被召回'), false, 'the dedupe gate does not see it')
  assert.equal(store.findSimilar('这段文字在归档后不应再被召回', 0.3, 5).length, 0, 'the similarity gate does not see it')
})

test('archive: re-deleting the same key on the same day keeps BOTH versions', async () => {
  const store = tmpStore()
  await save(store, 'same-day', '第一版内容')
  await store.forget('same-day')
  await save(store, 'same-day', '第二版内容')
  await store.forget('same-day')
  const entries = store.archivedCards()
  assert.equal(entries.length, 2, 'the second deletion does not overwrite the first copy')
  assert.deepEqual(entries.map(e => e.topic), ['same-day', 'same-day'])
  const bodies = entries.map(e => readFileSync(join(store.dir, 'archive', e.day, `${e.file}.md`), 'utf8'))
  assert.ok(bodies.some(text => text.includes('第一版内容')), 'the earlier version is still there')
  // The whole point: the version deleted LAST must be recoverable too.
  assert.ok(bodies.some(text => text.includes('第二版内容')), 'the version deleted most recently survives')
  assert.notEqual(entries[0]!.file, entries[1]!.file, 'the two copies are distinct files')
})

// --- archive pruning (age + count bounds) ------------------------------------

test('archive prune: a copy older than the retention window is dropped on the next write', async () => {
  const store = tmpStore()
  await save(store, 'old-card', '过期内容')
  await store.forget('old-card')
  const [old] = store.archivedCards()
  // Backdate the copy past the retention window.
  const oldPath = join(store.dir, 'archive', old!.day, `${old!.file}.md`)
  const stale = (Date.now() - (ARCHIVE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000) / 1000
  utimesSync(oldPath, stale, stale)
  // The next archive write runs the prune.
  await save(store, 'fresh-card', '新内容')
  await store.forget('fresh-card')
  const remaining = store.archivedCards()
  assert.deepEqual(remaining.map(entry => entry.topic), ['fresh-card'], 'the expired copy is gone, the fresh one stays')
  // The emptied day directory is removed too.
  const days = readdirSync(join(store.dir, 'archive'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  assert.equal(days.length, 1, 'only the day that still holds a copy remains')
})

test('archive prune: the count cap drops the OLDEST copies, keeping the newest', async () => {
  const store = tmpStore()
  // Fill the archive past the cap without paying for one delete each: write
  // the files directly, then let one real deletion trigger the prune.
  const dayDir = join(store.dir, 'archive', '2026-01-01')
  mkdirSync(dayDir, { recursive: true })
  const total = ARCHIVE_MAX_FILES + 5
  for (let i = 0; i < total; i += 1) {
    const path = join(dayDir, `bulk-${String(i).padStart(4, '0')}.md`)
    writeFileSync(path, `---\nname: bulk-${String(i).padStart(4, '0')}\ncategory: fact\nsummary: s\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n内容 ${String(i)}\n`)
    // Ascending mtimes: bulk-0000 is the oldest.
    const at = (Date.now() - (total - i) * 1000) / 1000
    utimesSync(path, at, at)
  }
  await save(store, 'trigger-card', '触发清理')
  await store.forget('trigger-card')
  const all = store.archivedCards()
  assert.equal(all.length, ARCHIVE_MAX_FILES, `the archive is capped at ${String(ARCHIVE_MAX_FILES)}`)
  const remaining = all.filter(entry => entry.topic.startsWith('bulk-'))
  // The trigger card is the newest, so the cap is paid entirely by the oldest
  // bulk copies (205 bulk + 1 trigger = 206 → 6 dropped, all bulk).
  assert.equal(remaining.length, ARCHIVE_MAX_FILES - 1)
  assert.ok(!remaining.some(entry => entry.topic === 'bulk-0000'), 'the oldest copy is the one dropped')
  assert.ok(remaining.some(entry => entry.topic === `bulk-${String(total - 1).padStart(4, '0')}`), 'the newest copy survives')
  assert.ok(all.some(entry => entry.topic === 'trigger-card'), 'the newest entry of all is never the one dropped')
})

test('archive prune: a junction inside archive/ is never walked into', async () => {
  const store = tmpStore()
  await save(store, 'seed-card', '种子')
  await store.forget('seed-card')
  // A directory the prune must NOT touch, reached only through a junction.
  const outside = join(store.dir, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'precious.md'), '不能被删掉的内容')
  const linked = join(store.dir, 'archive', '1999-01-01')
  try {
    symlinkSync(outside, linked, 'junction')
  } catch {
    return // junctions need Developer Mode / elevation on Windows; skip when refused
  }
  // Trigger a prune: an entry under the junction is old, but the walker must
  // not read through it (isDirectory() is false for a reparse point).
  const stale = (Date.now() - (ARCHIVE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000) / 1000
  utimesSync(join(outside, 'precious.md'), stale, stale)
  await save(store, 'trigger-card', '触发清理')
  await store.forget('trigger-card')
  assert.ok(existsSync(join(outside, 'precious.md')), 'the linked target is untouched')
  assert.equal(readFileSync(join(outside, 'precious.md'), 'utf8'), '不能被删掉的内容')
})

test('archive prune: the retention boundary is the configured window, not looser', async () => {
  const store = tmpStore()
  const dayDir = join(store.dir, 'archive', '2026-01-01')
  mkdirSync(dayDir, { recursive: true })
  const write = (name: string, ageDays: number): string => {
    const path = join(dayDir, `${name}.md`)
    writeFileSync(path, `---\nname: ${name}\ncategory: fact\nsummary: s\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n内容\n`)
    const at = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000
    utimesSync(path, at, at)
    return path
  }
  // One minute past the window (dropped) and one minute inside it (kept):
  // a cutoff off by even a day fails one of the two.
  const justExpired = write('just-expired', ARCHIVE_RETENTION_DAYS + 1 / 1440)
  const justInside = write('just-inside', ARCHIVE_RETENTION_DAYS - 1 / 1440)
  await save(store, 'trigger-card', '触发清理')
  await store.forget('trigger-card')
  const topics = store.archivedCards().map(entry => entry.topic)
  assert.ok(!topics.includes('just-expired'), 'one minute past the window is dropped')
  assert.ok(topics.includes('just-inside'), 'one minute inside the window is kept')
  assert.equal(existsSync(justInside), true)
  assert.equal(existsSync(justExpired), false)
})

test('archive: an unarchivable target still lets the deletion through, and says so', async () => {
  const store = tmpStore()
  await save(store, 'blocked-card', '内容')
  // Make the archive path unusable: a FILE where the directory must go.
  writeFileSync(join(store.dir, 'archive'), 'not a directory')
  assert.equal(await store.remove('blocked-card', 'forget'), true, 'the removal the caller asked for still happens')
  assert.equal(store.get('blocked-card'), undefined)
  assert.equal(store.lastArchiveError() !== undefined, true, 'the failure is recorded, not swallowed silently')
})

// --- ledger (why is this card gone) -------------------------------------------

test('ledger: a forget records the keys it removed, newest first', async () => {
  const root = tmpRoot()
  await save(root.global, 'ledger-card', '会被删除的内容')
  await root.global.forget('ledger-card')
  const entries = root.ledgerEntries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.scope, 'global')
  assert.equal(entries[0]!.pass, 'forget')
  assert.equal(entries[0]!.op, 'delete')
  assert.deepEqual(entries[0]!.keys, ['ledger-card'])
  assert.ok(entries[0]!.at > 0, 'stamped with a time')
})

test('ledger: an absent ledger field parses as empty, never throws', () => {
  const root = tmpRoot()
  // State written before the ledger existed has no `ledger` key at all.
  writeFileSync(join(root.dir, 'distill-state.json'), JSON.stringify({ version: 1, sessions: {}, activity: [] }))
  assert.deepEqual(root.ledgerEntries(), [])
  // And recording into it still works.
  root.recordLedger({ scope: 'global', pass: 'forget', op: 'delete', keys: ['x'] })
  assert.equal(root.ledgerEntries().length, 1)
})

test('ledger: entries are bounded, oldest dropped first', () => {
  const root = tmpRoot()
  for (let i = 0; i < MAX_LEDGER_ENTRIES + 10; i += 1) {
    root.recordLedger({ scope: 'global', pass: 'curate', op: 'delete', keys: [`card-${String(i)}`] })
  }
  const entries = root.ledgerEntries()
  assert.equal(entries.length, MAX_LEDGER_ENTRIES, 'the ledger is capped')
  assert.equal(entries[0]!.keys[0], `card-${String(MAX_LEDGER_ENTRIES + 9)}`, 'newest first')
  assert.ok(!entries.some(entry => entry.keys[0] === 'card-0'), 'the oldest entry was dropped')
})

test('ledger: clear() records what it wiped, before the archive goes with it', async () => {
  const root = tmpRoot()
  await save(root.global, 'clear-a', '会被清空的甲')
  await save(root.global, 'clear-b', '会被清空的乙')
  await root.global.clear()
  assert.equal(root.global.list().length, 0)
  assert.equal(root.global.archiveCount(), 0, 'the archive goes with the reset')
  const entries = root.ledgerEntries()
  assert.equal(entries.length, 1, 'the most destructive action is the one that most needs a record')
  assert.equal(entries[0]!.scope, 'global')
  assert.equal(entries[0]!.op, 'delete')
  assert.deepEqual([...entries[0]!.keys].sort(), ['clear-a', 'clear-b'])
})

test('ledger: clearing an empty store records nothing', async () => {
  const root = tmpRoot()
  await root.global.clear()
  assert.deepEqual(root.ledgerEntries(), [], 'no cards, no event')
})

test('ledger: a project store records under its own slug, not the global scope', async () => {
  const root = tmpRoot()
  const project = root.projectFor('D:/codes/DSH-APP')
  const slug = projectSlug('D:/codes/DSH-APP')
  await save(project, 'project-card', '项目里的卡片')
  await project.forget('project-card')
  const entries = root.ledgerEntries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.scope, slug, 'the scope names the project store that changed')
  assert.deepEqual(entries[0]!.keys, ['project-card'])
})

test('ledger: a corrupted entry is dropped rather than crashing the panel', () => {
  const root = tmpRoot()
  writeFileSync(join(root.dir, 'distill-state.json'), JSON.stringify({
    version: 1,
    sessions: {},
    activity: [],
    ledger: [
      { at: Date.now(), scope: 'global', pass: 'forget', op: 'delete', keys: ['good'] },
      { at: Date.now(), scope: 'global', pass: 'forget', op: 'delete' }, // no keys
      { at: Date.now(), scope: 'global', pass: 'nonsense', op: 'delete', keys: [] },
      { scope: 'global', pass: 'forget', op: 'delete', keys: [] }, // no at
      'not an object',
      { at: Date.now(), scope: 'global', pass: 'forget', op: 'delete', keys: [1, 2] },
      { at: Number.NaN, scope: 'global', pass: 'forget', op: 'delete', keys: ['nan-time'] },
    ],
  }))
  const entries = root.ledgerEntries()
  assert.equal(entries.length, 1, 'only the usable entry survives')
  assert.deepEqual(entries[0]!.keys, ['good'])
})

test('ledger: events sharing a millisecond still come back newest-first', () => {
  const root = tmpRoot()
  const at = Date.now()
  root.recordLedgerBatch([
    { at, scope: 'global', pass: 'curate', op: 'delete', keys: ['first'] },
    { at, scope: 'global', pass: 'curate', op: 'delete', keys: ['second'] },
    { at, scope: 'global', pass: 'curate', op: 'delete', keys: ['third'] },
  ])
  const entries = root.ledgerEntries()
  // A batch shares one timestamp; a stable sort alone would return the
  // insertion order (oldest first), contradicting "newest first".
  assert.deepEqual(entries.map(entry => entry.keys[0]), ['third', 'second', 'first'])
})

// --- distill-state.json: the reader tolerates what it no longer defines -------

test('distill-state: a file still carrying the retired extractor keys reads and rewrites clean', () => {
  const root = tmpRoot()
  // `sessions` (per-session progress) and `activity` (run traces) were written
  // by the retired extractor and are not part of the state shape any more. An
  // old file must neither throw nor keep them alive forever.
  writeFileSync(join(root.dir, 'distill-state.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-old': { seq: 42, at: 1, savedAtSeq: 7 } },
    activity: [{ at: 1, session: 'abc12345', saved: 2, backend: 'direct', tokens: 30 }],
    curated: { demo: 'hash' },
  }))
  assert.equal(root.curatedHashOf('demo'), 'hash', 'the live bookkeeping still reads')
  root.recordCurated('demo-two', 'hash-two')
  const after = JSON.parse(readFileSync(join(root.dir, 'distill-state.json'), 'utf8')) as Record<string, unknown>
  assert.equal((after.curated as Record<string, string>)['demo-two'], 'hash-two')
  assert.equal('sessions' in after, false, 'the retired per-session progress is dropped on the next write')
  assert.equal('activity' in after, false, 'and so are the retired run traces')
})

// --- prompt discipline (the injected body must not narrate its own storage) ---

test('card-text discipline forbids narrating the saving, not the vocabulary', () => {
  // The discipline is ONE exported constant shared by every surface that asks
  // a model for card text. Asserting its CONTENT here (rather than a phrase in
  // each prompt) is what makes rewording safe and omission visible: the
  // per-surface tests below only check that each one carries it.
  assert.match(CARD_TEXT_DISCIPLINE, /FACT ITSELF/, 'states the positive form to write')
  assert.match(CARD_TEXT_DISCIPLINE, /never as a note about the act of/i, 'and the form to avoid')
  assert.match(CARD_TEXT_DISCIPLINE, /BOTH the body\/content AND the one-line summary/,
    'the summary is the field that is injected in full and never budget-trimmed')
  assert.match(CARD_TEXT_DISCIPLINE, /Leave out what rots/, 'dates and ids are named too')
  // The exception is load-bearing: this plugin's own memory IS about the memory
  // system (topic keys, the index, the size caps), so a bare word ban would
  // forbid exactly the facts a card about this codebase must state.
  assert.match(CARD_TEXT_DISCIPLINE, /MAY be about this memory system itself/, 'the domain exception survives')
  assert.match(CARD_TEXT_DISCIPLINE, /narrating the SAVING, not on these words/, 'and says which is banned')
})

test('every card-text surface carries the discipline', () => {
  const root = tmpRoot()
  const surfaces: Record<CardTextSurface, string> = {
    // The always-on guidelines ride every assembly in every session.
    guidelines: renderMemoryText(root, undefined),
    curator: buildCuratePrompt('store text').system,
    memory_save: SAVE_TOOL_DESCRIPTION,
  }
  // Walked from the shared roster: a NEW surface added to the plugin without
  // the rule fails this test rather than shipping silently.
  for (const name of CARD_TEXT_SURFACES) {
    assert.ok(
      surfaces[name].includes(CARD_TEXT_DISCIPLINE),
      `the ${name} surface must carry the shared card-text discipline verbatim`,
    )
  }
})

// --- injection growth policy & the read side of a card -----------------------

test('renderMemoryText: a capped index announces the cut and the consolidation that ends it', async () => {
  const root = tmpRoot()
  const store = root.projectFor('D:/codes/Demo')
  const keys = Array.from({ length: 51 }, (_, index) => `topic-${String(index).padStart(2, '0')}`)
  for (const [index, key] of keys.entries()) {
    await save(store, key, `第 ${String(index)} 张卡的正文`, 'fact', `卡 ${String(index)}`)
  }
  const text = renderMemoryText(root, 'D:/codes/Demo')
  // Index lines, not every "- " line: the guidelines above also carry bullets.
  const indexLines = text.split('\n')
    .filter(line => /^- (📌 )?\[(preference|convention|decision|lesson|fact)\] /u.test(line))
  assert.equal(indexLines.length, 50, 'the index is cut at its ceiling, not injected whole')
  // A cut with no growth policy leaks every topic past it: the note has to name
  // the ceiling, the recall path AND what the model can do about the overflow.
  assert.match(text, /1 more topic is NOT listed above/)
  assert.match(text, /50-line ceiling/)
  assert.match(text, /memory_recall reaches any card/)
  assert.match(text, /consolidate rather than add/)
  assert.match(text, /within 40 characters/)
  // Exactly the over-ceiling topic is unlisted, and the store still holds it —
  // which is the only thing that makes a recall pointer honest.
  const listed = indexLines.join('\n')
  const unlisted = keys.filter(key => !listed.includes(key))
  assert.equal(unlisted.length, 1, 'one topic past the ceiling is unlisted')
  assert.ok(store.get(unlisted[0]!) !== undefined, 'and memory_recall can still reach it')
})

test('renderMemoryText: the guidelines carry the read side — a card is a snapshot', async () => {
  const root = tmpRoot()
  const text = renderMemoryText(root, undefined)
  // Saving discipline alone lets a stale card be acted on as current: what is
  // injected is a snapshot, so the prompt must say how to use it.
  assert.match(text, /SNAPSHOT of the moment it was written/)
  assert.match(text, /check the file still exists/)
  assert.match(text, /outweighs any card/)
  assert.match(text, /trust the observation/)
  assert.match(text, /memory_forget when the fact is retracted/)
})

test('card-text discipline: guidance cards carry the reason and the boundary', () => {
  // A rule without its reason cannot be judged against a case it never
  // anticipated — and the reason must stay a fact, never the story of the
  // discussion that produced it.
  assert.match(CARD_TEXT_DISCIPLINE, /GUIDANCE cards \(convention, lesson, decision\)/)
  assert.match(CARD_TEXT_DISCIPLINE, /the reason it holds and the case it does NOT cover/)
  assert.match(CARD_TEXT_DISCIPLINE, /not as the story of how it was agreed/)
})
