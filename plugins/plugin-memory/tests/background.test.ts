/**
 * Unit tests for the background maintenance passes (distiller + curator) on
 * the topic-card model: proposal validation, the write-time similarity gate,
 * the by-key edit protocol, and the due-store selection. Everything is
 * driven through private-method probes on temp-dir stores — no model calls.
 *
 * @module @dsh-app/plugin-memory/tests/background
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TOPIC_BODY_CHARS, MemoryRoot, MemoryStore } from '../src/memory-store.ts'
import { MemoryDistiller, buildDistillPrompt } from '../src/distiller.ts'
import { CURATE_BUDGET, MemoryCurator, buildCuratePrompt } from '../src/curator.ts'

const tmpRoot = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
const tmpStore = (): MemoryStore => new MemoryStore(mkdtempSync(join(tmpdir(), 'dshm-bg-')))

/** Probe the distiller's private proposal-validation/apply path. */
const distillApply = async (root: MemoryRoot, structured: unknown, cwd?: string): Promise<number> => {
  const distiller = new MemoryDistiller(null as never, root, console as never)
  return (distiller as unknown as { applyEntries(u: unknown, c: string | undefined): Promise<number> }).applyEntries(structured, cwd)
}

/** Probe the curator's private edit-validation/apply path. */
const curatorApply = async (store: MemoryStore, structured: unknown): Promise<{ merged: number, deleted: number, rewritten: number }> => {
  const curator = new MemoryCurator(null as never, new MemoryRoot(store.dir), console as never)
  return (curator as unknown as { applyEdits(s: MemoryStore, u: unknown): Promise<{ merged: number, deleted: number, rewritten: number }> }).applyEdits(store, structured)
}

/** Probe the curator's private due-store selection. */
const selectTargets = (root: MemoryRoot): string[] => {
  const curator = new MemoryCurator(null as never, root, console as never)
  return (curator as unknown as { selectTargets(): Array<{ label: string }> }).selectTargets().map(t => t.label)
}

const entry = (topic: string, content: string, summary = ' routing hook', category = 'fact'): Record<string, string> =>
  ({ topic, summary, category, content })

// --- distiller applyEntries ---------------------------------------------------

test('distill applyEntries: a valid proposal creates a global card', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, { entries: [entry('user-consult-style', '用户在方案征询时期望一次性给出综合方案确认', '方案征询期望综合方案', 'preference')] })
  assert.equal(applied, 1)
  const card = root.global.get('user-consult-style')
  assert.equal(card?.category, 'preference')
  assert.equal(card?.body, '用户在方案征询时期望一次性给出综合方案确认')
  assert.equal(card?.summary, '方案征询期望综合方案')
})

test('distill applyEntries: a session with a workspace writes to the project store', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, { entries: [entry('pnpm-registry-retry', '镜像源失败时先切换 registry 再重试安装')] }, 'D:/proj')
  assert.equal(applied, 1)
  assert.equal(root.projectFor('D:/proj').get('pnpm-registry-retry')?.body, '镜像源失败时先切换 registry 再重试安装')
  assert.equal(root.global.get('pnpm-registry-retry'), undefined)
})

test('distill applyEntries: a topic key that slugifies to nothing is rejected', async () => {
  const root = tmpRoot()
  // Pure-Chinese topic words carry no ASCII letters — the model must translate.
  const applied = await distillApply(root, { entries: [entry('中文主题', '某些内容'), entry('', '更多内容')] })
  assert.equal(applied, 0)
  assert.equal(root.global.list().length, 0)
})

test('distill applyEntries: same key with near-identical content is already covered', async () => {
  const root = tmpRoot()
  await distillApply(root, { entries: [entry('pnpm-registry-retry', '镜像源失败时先切换 registry 再重试安装')] })
  // Differing only by punctuation, the normalized content is identical (sim 1).
  const applied = await distillApply(root, { entries: [entry('pnpm-registry-retry', '镜像源失败时，先切换 registry，再重试安装。')] })
  assert.equal(applied, 0)
  assert.equal(root.global.get('pnpm-registry-retry')?.body, '镜像源失败时先切换 registry 再重试安装')
})

test('distill applyEntries: same key with evolved content rewrites the card in place', async () => {
  const root = tmpRoot()
  await distillApply(root, { entries: [entry('build-pipeline', '构建脚本必须先跑类型检查再打包产物', '构建顺序约束', 'convention')] })
  const applied = await distillApply(root, { entries: [entry('build-pipeline', '评审意见按严重度分级列出并附文件行号', '评审输出格式约定', 'convention')] })
  assert.equal(applied, 1)
  const card = root.global.get('build-pipeline')
  assert.equal(card?.body, '评审意见按严重度分级列出并附文件行号')
  assert.equal(card?.summary, '评审输出格式约定')
  // Upsert, not append: the topic still has exactly one card.
  assert.equal(root.global.list().length, 1)
})

test('distill applyEntries: a new key duplicating an existing card is rejected', async () => {
  const root = tmpRoot()
  // The summary is a substring of the body so findSimilar's summary+body
  // comparison stays dominated by the body the proposal rewords.
  await distillApply(root, { entries: [entry('pnpm-registry-retry', '镜像源失败时先切换 registry 再重试安装并记录结果', '镜像源失败时先切换')] })
  const applied = await distillApply(root, { entries: [entry('registry-failover', '镜像源失败时先切换到 registry 再重试安装并记录结果')] })
  assert.equal(applied, 0)
  assert.equal(root.global.get('registry-failover'), undefined)
})

test('distill applyEntries: a new key without a summary is rejected', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, { entries: [{ topic: 'no-hook', category: 'fact', content: '没有索引钩子的卡片' }] })
  assert.equal(applied, 0)
})

test('distill applyEntries: credentials never reach the store', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, { entries: [entry('leaked-key', '调试要用 api_key: sk-abcdef1234567890 这个令牌')] })
  assert.equal(applied, 0)
  assert.equal(root.global.list().length, 0)
})

test('distill applyEntries: at most five writes per run', async () => {
  const root = tmpRoot()
  const proposals = [
    entry('dep-manager', '用户使用 pnpm 管理全部工作区依赖'),
    entry('registry-retry', '镜像源失败时先切换 registry 再重试安装'),
    entry('build-order', '构建脚本必须先跑类型检查再打包产物'),
    entry('quiet-window', '会话静默六十秒后触发后台蒸馏'),
    entry('review-style', '代码评审按严重度分级列出发现'),
    entry('settings-toggle', '设置页开关写入配置文件即生效'),
    entry('topic-identity', '主题卡以固定键标识便于收敛'),
  ]
  assert.equal(await distillApply(root, { entries: proposals }), 5)
  assert.equal(root.global.list().length, 5)
})

// --- buildDistillPrompt --------------------------------------------------------

test('buildDistillPrompt: card contract, no scope field, work-log ban, live index in the user half', async () => {
  const root = tmpRoot()
  await root.global.upsert({ name: 'user-consult-style', category: 'preference', summary: '方案征询期望综合方案', body: '用户在方案征询时期望一次性给出综合方案确认' })
  const { system, user } = buildDistillPrompt('[user] hello', 'D:/proj', root)
  assert.doesNotMatch(system, /"scope"/)
  assert.ok(system.includes('"topic"'))
  assert.ok(system.includes('"summary"'))
  assert.match(system, /work log/i)
  assert.match(system, /reuse that exact key/i)
  // The live store is what the model dedupes and routes against.
  assert.match(user, /### user-consult-style \[preference\]/)
  assert.match(user, /用户在方案征询时期望一次性给出综合方案确认/)
})

// --- curator applyEdits --------------------------------------------------------

const seed = async (store: MemoryStore, name: string, body: string, category = 'lesson'): Promise<void> => {
  await store.upsert({ name, category: category as never, summary: `${name} hook`, body })
}

test('curator applyEdits: merge by keys rewrites the target and removes the rest', async () => {
  const store = tmpStore()
  await seed(store, 'pnpm-registry-retry', '镜像源失败时先切换 registry 再重试')
  await seed(store, 'pnpm-mirror-fail', 'pnpm 镜像挂了要换源重新安装依赖')
  const result = await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['pnpm-registry-retry', 'pnpm-mirror-fail'],
      target: { topic: 'pnpm-registry-retry', summary: 'pnpm 镜像失败处理', category: 'lesson', content: '镜像源失败时切换 registry 后重试安装即可恢复' },
    }],
  })
  assert.deepEqual(result, { merged: 1, deleted: 0, rewritten: 0 })
  assert.equal(store.get('pnpm-mirror-fail'), undefined)
  assert.equal(store.get('pnpm-registry-retry')?.body, '镜像源失败时切换 registry 后重试安装即可恢复')
  assert.equal(store.get('pnpm-registry-retry')?.summary, 'pnpm 镜像失败处理')
  // The host-owned index reflects the merge.
  assert.match(store.indexText(), /pnpm-registry-retry/)
  assert.doesNotMatch(store.indexText(), /pnpm-mirror-fail/)
})

test('curator applyEdits: a merge may converge onto a fresh target key', async () => {
  const store = tmpStore()
  await seed(store, 'legacy-a1b2c3d4', '镜像源失败时先切换 registry 再重试')
  await seed(store, 'legacy-e5f60708', 'pnpm 镜像挂了要换源重新安装依赖')
  const result = await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['legacy-a1b2c3d4', 'legacy-e5f60708'],
      target: { topic: 'pnpm-registry-retry', summary: 'pnpm 镜像失败处理', category: 'lesson', content: '镜像源失败时切换 registry 后重试安装即可恢复' },
    }],
  })
  assert.deepEqual(result, { merged: 1, deleted: 0, rewritten: 0 })
  assert.equal(store.get('legacy-a1b2c3d4'), undefined)
  assert.equal(store.get('legacy-e5f60708'), undefined)
  assert.equal(store.get('pnpm-registry-retry')?.category, 'lesson')
})

test('curator applyEdits: delete removes the cited card', async () => {
  const store = tmpStore()
  await seed(store, 'stale-note', '某个已经被取代的旧结论')
  const result = await curatorApply(store, { edits: [{ op: 'delete', topics: ['stale-note'] }] })
  assert.deepEqual(result, { merged: 0, deleted: 1, rewritten: 0 })
  assert.equal(store.get('stale-note'), undefined)
})

test('curator applyEdits: rewrite replaces the body and only a given summary', async () => {
  const store = tmpStore()
  await seed(store, 'build-order', '构建脚本必须先跑类型检查再打包产物', 'convention')
  const result = await curatorApply(store, { edits: [{ op: 'rewrite', topic: 'build-order', content: '构建顺序：先类型检查再打包，最后才允许发布', summary: '构建发布顺序' }] })
  assert.deepEqual(result, { merged: 0, deleted: 0, rewritten: 1 })
  assert.equal(store.get('build-order')?.body, '构建顺序：先类型检查再打包，最后才允许发布')
  assert.equal(store.get('build-order')?.summary, '构建发布顺序')
  // Without a summary the existing hook carries over.
  const again = await curatorApply(store, { edits: [{ op: 'rewrite', topic: 'build-order', content: '构建顺序：先类型检查再打包' }] })
  assert.equal(again.rewritten, 1)
  assert.equal(store.get('build-order')?.summary, '构建发布顺序')
})

test('curator applyEdits: pinned cards are untouchable', async () => {
  const store = tmpStore()
  await seed(store, 'kept-forever', '用户明确钉住的事实')
  await store.addPin('kept-forever')
  const result = await curatorApply(store, { edits: [{ op: 'delete', topics: ['kept-forever'] }] })
  assert.deepEqual(result, { merged: 0, deleted: 0, rewritten: 0 })
  assert.notEqual(store.get('kept-forever'), undefined)
})

test('curator applyEdits: ghost keys and double citations reject the whole edit', async () => {
  const store = tmpStore()
  await seed(store, 'card-a', '第一条内容完全不同的卡')
  await seed(store, 'card-b', '第二条内容完全不同的卡')
  const ghost = await curatorApply(store, { edits: [{ op: 'delete', topics: ['no-such-card'] }] })
  assert.deepEqual(ghost, { merged: 0, deleted: 0, rewritten: 0 })
  // card-a is claimed by the delete; the merge citing it again is rejected whole.
  const result = await curatorApply(store, {
    edits: [
      { op: 'delete', topics: ['card-a'] },
      { op: 'merge', topics: ['card-a', 'card-b'], target: { topic: 'card-b', summary: 's', category: 'fact', content: '合并产物' } },
    ],
  })
  assert.deepEqual(result, { merged: 0, deleted: 1, rewritten: 0 })
  assert.equal(store.get('card-a'), undefined)
  assert.notEqual(store.get('card-b'), undefined)
})

test('curator applyEdits: a merge duplicating a surviving card is rejected', async () => {
  const store = tmpStore()
  await seed(store, 'survivor', '镜像源失败时切换 registry 后重试安装即可恢复')
  await seed(store, 'dup-a', '第一条待合并的卡')
  await seed(store, 'dup-b', '第二条待合并的卡')
  const result = await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['dup-a', 'dup-b'],
      target: { topic: 'dup-a', summary: 's', category: 'lesson', content: '镜像源失败时，切换 registry 后，重试安装即可恢复。' },
    }],
  })
  // The merged wording normalizes to the survivor's body — keeping it would
  // store the same fact twice.
  assert.deepEqual(result, { merged: 0, deleted: 0, rewritten: 0 })
  assert.notEqual(store.get('dup-a'), undefined)
  assert.notEqual(store.get('dup-b'), undefined)
})

test('curator applyEdits: at most twenty edits per pass', async () => {
  const store = tmpStore()
  for (let i = 0; i < 21; i += 1) await seed(store, `card-${String(i).padStart(2, '0')}`, `第${String(i)}条互不相同的内容`)
  const edits = Array.from({ length: 21 }, (_, i) => ({ op: 'delete', topics: [`card-${String(i).padStart(2, '0')}`] }))
  const result = await curatorApply(store, { edits })
  assert.equal(result.deleted, 20)
  assert.equal(store.list().length, 1)
})

// --- buildCuratePrompt ---------------------------------------------------------

test('buildCuratePrompt: over-budget directive carries the concrete numbers', () => {
  const { system } = buildCuratePrompt('input', [], { cards: 35, chars: 7000 })
  assert.match(system, /OVER BUDGET/)
  assert.ok(system.includes('35'))
  assert.ok(system.includes('7000'))
  assert.ok(system.includes(String(CURATE_BUDGET.cards)))
  assert.ok(system.includes(String(CURATE_BUDGET.chars)))
})

test('buildCuratePrompt: restructure mode names the legacy-key directive', () => {
  const { system } = buildCuratePrompt('input', [], undefined, { restructure: true })
  assert.match(system, /legacy-\*/)
  assert.match(system, /should not survive this pass/)
  // Off by default.
  assert.doesNotMatch(buildCuratePrompt('input').system, /legacy-\*/)
})

test('buildCuratePrompt: pinned keys are named as never edited', () => {
  const { system, user } = buildCuratePrompt('input', ['my-pinned-topic'])
  assert.match(system, /never edited/i)
  assert.match(user, /Pinned cards/)
  assert.match(user, /my-pinned-topic/)
})

// --- curator selectTargets ------------------------------------------------------

test('curator selectTargets: below the card threshold nothing is due', async () => {
  const root = tmpRoot()
  for (let i = 0; i < 7; i += 1) await seed(root.global, `card-${String(i)}`, `第${String(i)}条互不相同的内容`)
  assert.deepEqual(selectTargets(root), [])
})

test('curator selectTargets: an unchanged fingerprint skips the store, a new write re-arms it', async () => {
  const root = tmpRoot()
  for (let i = 0; i < 8; i += 1) await seed(root.global, `card-${String(i)}`, `第${String(i)}条互不相同的内容`)
  assert.deepEqual(selectTargets(root), ['global'])
  // A completed pass records the fingerprint: same content → not due.
  root.recordCurated('global', root.global.fingerprint())
  assert.deepEqual(selectTargets(root), [])
  // Any later write changes the fingerprint: the store is due again.
  await seed(root.global, 'card-8', '第九条互不相同的内容')
  assert.deepEqual(selectTargets(root), ['global'])
})

// --- review-driven regression tests (P1/P2 fixes) ----------------------------

test('curator applyEdits: a merge target naming an UNCITED existing card is rejected whole', async () => {
  const store = tmpStore()
  await seed(store, 'victim-card', '无辜的现存卡内容')
  await seed(store, 'merge-a', '待合并甲')
  await seed(store, 'merge-b', '待合并乙')
  const out = await curatorApply(store, {
    edits: [{ op: 'merge', topics: ['merge-a', 'merge-b'], target: { topic: 'victim-card', summary: '劫持', category: 'lesson', content: '被合并的内容' } }],
  })
  assert.deepEqual(out, { merged: 0, deleted: 0, rewritten: 0 }, 'the collision rejects the edit')
  assert.equal(store.get('victim-card')?.body, '无辜的现存卡内容', 'the uncited card is not overwritten')
  assert.ok(store.get('merge-a') !== undefined && store.get('merge-b') !== undefined, 'the cited cards survive the rejected edit too')
})

test('curator applyEdits: a merge target naming an uncited PINNED card cannot bypass the pin fence', async () => {
  const store = tmpStore()
  await seed(store, 'pinned-card', '用户固定的内容')
  await store.addPin('pinned-card')
  await seed(store, 'merge-a', '待合并甲')
  await seed(store, 'merge-b', '待合并乙')
  const out = await curatorApply(store, {
    edits: [{ op: 'merge', topics: ['merge-a', 'merge-b'], target: { topic: 'pinned-card', summary: '劫持', category: 'lesson', content: '合并产物落进固定卡' } }],
  })
  assert.deepEqual(out, { merged: 0, deleted: 0, rewritten: 0 })
  assert.equal(store.get('pinned-card')?.body, '用户固定的内容', 'the pinned card body is untouched')
})

test('curator applyEdits: a single delete citing more than 30 keys is capped out', async () => {
  const store = tmpStore()
  for (let i = 0; i < 35; i += 1) await seed(store, `bulk-${String(i)}`, `内容 ${String(i)}`)
  const out = await curatorApply(store, {
    edits: [{ op: 'delete', topics: Array.from({ length: 35 }, (_, i) => `bulk-${String(i)}`) }],
  })
  assert.deepEqual(out, { merged: 0, deleted: 0, rewritten: 0 }, 'a store-gutting mega edit is rejected by the cited-keys cap')
  assert.equal(store.list().length, 35, 'nothing was deleted')
})

test('curator applyEdits: a rewrite duplicating another surviving card is rejected', async () => {
  const store = tmpStore()
  await seed(store, 'card-a', '甲卡内容')
  await seed(store, 'card-b', '乙卡内容')
  const out = await curatorApply(store, { edits: [{ op: 'rewrite', topic: 'card-a', content: '乙卡内容' }] })
  assert.deepEqual(out, { merged: 0, deleted: 0, rewritten: 0 })
  assert.equal(store.get('card-a')?.body, '甲卡内容', 'no exact-duplicate pair is manufactured')
})

test('curate budget: 30 full cards fit the char target (no permanent over-budget)', async () => {
  const store = tmpStore()
  for (let i = 0; i < 30; i += 1) await seed(store, `full-${String(i)}`, 'x'.repeat(MAX_TOPIC_BODY_CHARS))
  // The serialized store (index + headings + bodies) must stay under the
  // char target when the card count is exactly at target — otherwise every
  // healthy full store would be permanently "over budget".
  const text = store.indexText() + store.list().map(card => `### ${card.name} [lesson] (updated ${card.updated})\n${card.body}`).join('\n\n')
  assert.ok(text.length <= CURATE_BUDGET.chars, `30 full cards = ${String(text.length)} chars must fit the ${String(CURATE_BUDGET.chars)}-char target`)
})
