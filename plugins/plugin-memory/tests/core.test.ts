/**
 * Core unit tests for the memory plugin: pure functions, the card store,
 * migration, injection selection, and the light sweep.
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-memory/tests/core
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  MemoryRoot,
  MemoryStore,
  contentSimilarity,
  isValidTopic,
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
import type { MemoryCategory } from '../src/types.ts'

const tmpStore = (): MemoryStore => new MemoryStore(mkdtempSync(join(tmpdir(), 'dshm-test-')))
const tmpRoot = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-root-')))

/** Save one well-formed card in one call. */
const save = (store: MemoryStore, name: string, body: string, category: MemoryCategory = 'lesson', summary = ''): void => {
  store.upsert({ name, category, summary: summary === '' ? `${name} hook` : summary, body })
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

test('upsert: create → update → unchanged, and the index follows', () => {
  const store = tmpStore()
  const created = store.upsert({ name: 'release-flow', category: 'convention', summary: '发版流程', body: '先发 draft 再发布' })
  assert.equal(created.op, 'created')
  assert.equal(created.card.created, created.card.updated)

  const updated = store.upsert({ name: 'release-flow', category: 'convention', body: '先发 draft，验证后再发布' })
  assert.equal(updated.op, 'updated')
  assert.equal(updated.card.summary, '发版流程', 'omitted summary is inherited')
  assert.equal(updated.card.created, created.card.created, 'created survives updates')

  const noop = store.upsert({ name: 'release-flow', category: 'convention', body: '先发 draft，验证后再发布', summary: '发版流程' })
  assert.equal(noop.op, 'unchanged', 'a byte-identical save is a no-op')

  const index = store.indexText()
  assert.ok(index.includes('release-flow'), 'index lists the card')
  assert.ok(index.includes('发版流程'), 'index carries the summary hook')
  assert.ok(index.includes('[convention]'), 'index carries the category')
})

test('upsert: invalid input throws (callers pre-validate for friendly errors)', () => {
  const store = tmpStore()
  assert.throws(() => store.upsert({ name: '中文键', category: 'lesson', summary: 'x', body: 'y' }), /invalid topic key/)
})

test('a pin keyed by topic survives content rewrites; remove drops it', () => {
  const store = tmpStore()
  save(store, 'release-flow', '先发 draft')
  assert.equal(store.addPin('release-flow'), true)
  store.upsert({ name: 'release-flow', category: 'lesson', body: '改写后的正文，完全换了一批字' })
  assert.equal(store.pinnedSet().has('release-flow'), true, 'pin keyed by topic, not content')
  assert.ok(store.indexText().includes('📌'), 'the index marks the pin')
  assert.equal(store.remove('release-flow'), true)
  assert.equal(store.pinnedSet().size, 0, 'the pin goes with the card')
  assert.equal(store.indexText(), '', 'the index of an empty scope is empty')
})

test('addPin: refuses absent cards and double pins', () => {
  const store = tmpStore()
  assert.equal(store.addPin('not-there'), false)
  save(store, 'there', '正文')
  assert.equal(store.addPin('there'), true)
  assert.equal(store.addPin('there'), false)
})

test('forget: exact topic key wins; otherwise a content substring sweeps cards', () => {
  const store = tmpStore()
  save(store, 'pnpm-typecheck', '用 pnpm 跑 typecheck')
  save(store, 'pnpm-build', '用 pnpm 跑 build')
  save(store, 'tokyo-servers', '服务器在东京')
  const byKey = store.forget('pnpm-typecheck')
  assert.deepEqual(byKey.removed, ['pnpm-typecheck'])
  const byContent = store.forget('pnpm')
  assert.deepEqual(byContent.removed, ['pnpm-build'], 'substring sweeps summary+body, not the removed key')
  assert.equal(byContent.remaining, 1)
})

test('clear: drops cards, index, legacy archive and pins', () => {
  const store = tmpStore()
  save(store, 'one', '第一条')
  store.addPin('one')
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-01-01 旧条目\n', 'utf8')
  store.migrateLegacy()
  store.clear()
  assert.equal(store.list().length, 0)
  assert.equal(store.indexText(), '')
  assert.equal(store.pinnedSet().size, 0)
  assert.equal(existsSync(join(store.dir, 'memory.legacy.md')), false)
})

test('hasContent: exact body match, never substring', () => {
  const store = tmpStore()
  save(store, 'pnpm-typecheck', '用 pnpm 跑 typecheck')
  assert.equal(store.hasContent('用 pnpm 跑 typecheck'), true)
  assert.equal(store.hasContent('用 pnpm'), false)
})

test('findSimilar: near-duplicate ranks first, disjoint text stays under the floor', () => {
  const store = tmpStore()
  save(store, 'pnpm11-allowscripts', 'pnpm 11 白名单必须写进 pnpm-workspace.yaml', 'lesson', 'pnpm 11 白名单')
  save(store, 'tokyo-servers', '服务器在东京', 'fact', '东京服务器')
  const hits = store.findSimilar('pnpm 11 的白名单要写进 pnpm-workspace.yaml 文件')
  assert.equal(hits[0]?.name, 'pnpm11-allowscripts')
  assert.ok((hits[0]?.score ?? 0) > 0.5)
  assert.ok(!hits.some(hit => hit.name === 'tokyo-servers'), 'disjoint card stays under the floor')
})

// --- migration -------------------------------------------------------------------

test('migrateLegacy: entries become cards losslessly; pins remap; the archive is kept', () => {
  const store = tmpStore()
  const legacy = [
    '- [lesson] 2026-09-01 用户在方案征询时期望一次性给出综合方案确认',
    '- [fact] 2026-09-02 服务器在东京',
    '- [lesson] 2026-09-03 pnpm 11 不再从 package.json 读配置',
    '- [lesson] 2026-09-03 pnpm 11 不再从 package.json 读配置',
    '手写的一行没有前缀',
  ].join('\n')
  writeFileSync(join(store.dir, 'memory.md'), `${legacy}\n`, 'utf8')
  const { migrated, pinsRemapped } = store.migrateLegacy()

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
  assert.deepEqual(store.migrateLegacy(), { migrated: 0, pinsRemapped: 0, pinsDropped: [] })
})

test('migrateLegacy: a legacy content-keyed pin lands on the migrated card', () => {
  const store = tmpStore()
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-09-01 固定我\n- [fact] 2026-09-02 不固定\n', 'utf8')
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: [normalizeForMatch('固定我')] })}\n`, 'utf8')
  const { migrated, pinsRemapped } = store.migrateLegacy()
  assert.equal(migrated, 2)
  assert.equal(pinsRemapped, 1)
  const pinnedCard = store.list().find(card => card.body === '固定我')
  assert.ok(pinnedCard !== undefined)
  assert.ok(store.pinnedSet().has(pinnedCard.name), 'the pin follows the content onto its card')
})

test('migrateLegacy: a crash-resume re-run keeps pins already remapped to topic keys', () => {
  const store = tmpStore()
  // Simulate the crash window: a prior run wrote the card AND the topic-keyed
  // pin, but died before renaming memory.md — so this run re-migrates with
  // config.pinned already holding a topic key, not normalized content.
  save(store, 'legacy-ab12cd34', '已迁移的卡')
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-09-01 已迁移的卡\n', 'utf8')
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: ['legacy-ab12cd34'] })}\n`, 'utf8')
  const { pinsRemapped, pinsDropped } = store.migrateLegacy()
  assert.equal(pinsRemapped, 1, 'the already-keyed pin is carried over, not dropped')
  assert.deepEqual(pinsDropped, [])
  assert.ok(store.pinnedSet().has('legacy-ab12cd34'))
})

test('migrateLegacy: a genuinely unmatched legacy pin is reported, not silently lost', () => {
  const store = tmpStore()
  writeFileSync(join(store.dir, 'memory.md'), '- [lesson] 2026-09-01 留存条目\n', 'utf8')
  writeFileSync(join(store.dir, 'config.json'), `${JSON.stringify({ pinned: ['早已不存在的条目内容'] })}\n`, 'utf8')
  const { pinsRemapped, pinsDropped } = store.migrateLegacy()
  assert.equal(pinsRemapped, 0)
  assert.deepEqual(pinsDropped, ['早已不存在的条目内容'])
})

test('migrateLegacy: credential-looking entries are not carried over', () => {
  const store = tmpStore()
  writeFileSync(join(store.dir, 'memory.md'), '- [fact] 2026-09-01 正常条目\n- [fact] 2026-09-02 api_key: sk-abc123def456ghi7\n', 'utf8')
  const { migrated } = store.migrateLegacy()
  assert.equal(migrated, 1, 'the credential-looking line is dropped at the gate')
})

test('migrateAll: covers global and projects, skips clean stores', () => {
  const root = tmpRoot()
  writeFileSync(join(root.dir, 'memory.md'), '- [lesson] 2026-09-01 全局旧条目\n', 'utf8')
  const project = root.projectFor('D:/codes/Demo')
  mkdirSync(project.dir, { recursive: true })
  writeFileSync(join(project.dir, 'memory.md'), '- [lesson] 2026-09-01 项目旧条目\n', 'utf8')
  writeFileSync(join(project.dir, 'project.json'), `${JSON.stringify({ cwd: 'D:/codes/Demo' })}\n`, 'utf8')
  root.migrateAll()
  assert.equal(root.global.list().length, 1)
  assert.equal(root.projectFor('D:/codes/Demo').list().length, 1)
})

// --- injection selection ----------------------------------------------------------

test('selectCards: per-category quota keeps the most recently updated cards', () => {
  const store = tmpStore()
  for (let i = 1; i <= 5; i += 1) {
    store.upsert({ name: `lesson-${String(i)}`, category: 'lesson', summary: `s${String(i)}`, body: `第 ${String(i)} 条` })
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

test('selectCards: pinned cards always win, an oversized pin is clipped not dropped', () => {
  const store = tmpStore()
  store.upsert({ name: 'big-pin', category: 'preference', summary: '大固定卡', body: 'x'.repeat(MAX_TOPIC_BODY_CHARS) })
  store.upsert({ name: 'small-pin', category: 'preference', summary: '小固定卡', body: 'short' })
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

test('renderMemoryText: index + cards per scope; project isolation holds', () => {
  const root = tmpRoot()
  save(root.global, 'user-lang', '用户偏好中文回复', 'preference', '中文回复')
  save(root.projectFor('D:/codes/Demo'), 'demo-flow', 'Demo 项目的约定', 'convention', 'Demo 约定')
  save(root.projectFor('D:/codes/Other'), 'other-secret', '其它项目的卡片', 'fact', '其它')
  const text = renderMemoryText(root, 'D:/codes/Demo')
  assert.ok(text.includes('user-lang'), 'global index line injected')
  assert.ok(text.includes('用户偏好中文回复'), 'global body injected')
  assert.ok(text.includes('demo-flow'), 'project index line injected')
  assert.ok(!text.includes('other-secret'), 'another project is structurally absent')
  const noCwd = renderMemoryText(root, undefined)
  assert.ok(noCwd.includes('user-lang'))
  assert.ok(!noCwd.includes('demo-flow'), 'no cwd → no project scope')
})

// --- light sweep -------------------------------------------------------------------

test('lightSweep: exact-duplicate cards merge to the pinned/newest survivor; suspects logged', () => {
  const root = tmpRoot()
  const store = root.global
  // Two keys, identical bodies (a hand-edit accident).
  save(store, 'dup-a', '完全相同的内容')
  save(store, 'dup-b', '完全相同的内容')
  store.addPin('dup-b')
  // A near-duplicate pair under different keys (similarity suspect).
  save(store, 'sim-a', 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效')
  save(store, 'sim-b', 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才可生效')
  const out = lightSweep(root, 'global', store, console)
  assert.equal(out.merged, 1)
  assert.equal(store.get('dup-a'), undefined, 'unpinned duplicate removed')
  assert.ok(store.get('dup-b') !== undefined, 'the pinned card survives')
  assert.ok(out.suspects >= 1, 'the near-dup pair is logged as a suspect')
  assert.ok(root.simSuspects().some(s => s.scope === 'global'))
})

test('lightSweep: never throws on an empty store', () => {
  const root = tmpRoot()
  assert.deepEqual(lightSweep(root, 'global', root.global, console), { merged: 0, suspects: 0 })
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

// --- distill progress markers (unchanged machinery) --------------------------------

test('ownSaveSeq: a direct save marks its event seq, a completed pass consumes it', () => {
  const root = tmpRoot()
  const id = 'session-abc'
  assert.equal(root.ownSaveSeqOf(id), 0)
  root.recordDirectSave(id, 41)
  assert.equal(root.ownSaveSeqOf(id), 41)
  root.recordDirectSave(id, 30)
  assert.equal(root.ownSaveSeqOf(id), 41, 'a lower save never rewinds the marker')
  root.advanceDistill(id, 42)
  assert.equal(root.ownSaveSeqOf(id), 0, 'a completed pass consumes the marker')
  assert.equal(root.distillSeqOf(id), 42)
  root.recordDirectSave(id, 50)
  assert.equal(root.ownSaveSeqOf(id), 50)
  assert.equal(root.distillSeqOf(id), 42, 'a direct save must not rewind the distill cursor')
})

test('recordDirectSave: creates the session record before any distill ever ran', () => {
  const root = tmpRoot()
  root.recordDirectSave('session-fresh', 9)
  assert.equal(root.ownSaveSeqOf('session-fresh'), 9)
  assert.equal(root.distillSeqOf('session-fresh'), 0)
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

test('projectBySlug: resolves a project store via project.json; unknown slug → undefined', () => {
  const root = tmpRoot()
  assert.equal(root.projectBySlug('nope-nope'), undefined)
  save(root.projectFor('D:/codes/DSH-APP'), 'demo-card', '项目卡片')
  const slug = projectSlug('D:/codes/DSH-APP')
  const resolved = root.projectBySlug(slug)
  assert.ok(resolved !== undefined)
  assert.ok(resolved.get('demo-card') !== undefined)
  assert.equal(root.projectBySlug('../etc'), undefined, 'traversal fenced')
})
