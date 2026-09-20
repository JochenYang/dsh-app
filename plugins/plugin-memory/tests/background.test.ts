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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TOPIC_BODY_CHARS, MemoryRoot, MemoryStore, cardFingerprint, contentHash, type LedgerEntry } from '../src/memory-store.ts'
import { CARD_TEXT_DISCIPLINE } from '../src/card-discipline.ts'
import { MemoryDistiller, buildDistillPrompt, type SessionLike } from '../src/distiller.ts'
import { CURATE_BUDGET, MemoryCurator, buildCuratePrompt, serializeStore } from '../src/curator.ts'

const tmpRoot = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
const tmpStore = (): MemoryStore => new MemoryStore(mkdtempSync(join(tmpdir(), 'dshm-bg-')))

/** Probe the distiller's private proposal-validation/apply path. */
const distillApply = async (root: MemoryRoot, structured: unknown, cwd?: string): Promise<number> => {
  const distiller = new MemoryDistiller(null as never, root, console as never)
  return (distiller as unknown as { applyEntries(u: unknown, c: string | undefined): Promise<number> }).applyEntries(structured, cwd)
}

/** Probe the curator's private edit-validation/apply path.
 *
 *  `seen` is what the pass was SHOWN: the existing tests all model a pass that
 *  read the whole store, so the default derives it from the store as it stands
 *  at call time. Pass an explicit map to model a truncated pass (a key missing
 *  from it was never read) or a stale one (a hash that no longer matches). */
const curatorApply = async (
  store: MemoryStore,
  structured: unknown,
  seen?: ReadonlyMap<string, string>,
): Promise<{
  merged: number
  deleted: number
  rewritten: number
  skippedUnseen: number
  skippedStale: number
  events: Array<Omit<LedgerEntry, 'at' | 'scope' | 'pass' | 'session'>>
}> => {
  const curator = new MemoryCurator(null as never, new MemoryRoot(store.dir), console as never)
  const full = seen ?? new Map(store.list().map(card => [card.name, contentHash(cardFingerprint(card))]))
  type Result = {
    merged: number
    deleted: number
    rewritten: number
    skippedUnseen: number
    skippedStale: number
    events: Array<Omit<LedgerEntry, 'at' | 'scope' | 'pass' | 'session'>>
  }
  return (curator as unknown as {
    applyEdits(s: MemoryStore, u: unknown, seen: ReadonlyMap<string, string>): Promise<Result>
  }).applyEdits(store, structured, full)
}

/** The three applied-edit counters, for assertions that predate the skip
 *  counters (keeps the existing expectations readable). */
const appliedOnly = (result: { merged: number, deleted: number, rewritten: number }): { merged: number, deleted: number, rewritten: number } =>
  ({ merged: result.merged, deleted: result.deleted, rewritten: result.rewritten })

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

// --- the mechanical half of the card-text discipline --------------------------
// The guidelines ban these shapes in prose; the store filled up with them anyway
// (41 background writes against ONE curation edit, measured). These pin the code
// rule that now refuses them, so reverting it turns them red.

test('distill applyEntries: a narrated session summary never becomes a card', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, {
    entries: [entry('injection-order-note', '我们讨论了注入排序，最后决定按 updated 倒序取卡，本次已完成', '本次讨论后按更新时间排序')],
  })
  assert.equal(applied, 0)
  assert.equal(root.global.get('injection-order-note'), undefined)
})

test('distill applyEntries: a bilingual narration marker is refused too', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, {
    entries: [entry('wrapup-note', 'This session changed how the index is ordered, and it has been fixed.')],
  })
  assert.equal(applied, 0)
})

test('distill applyEntries: a one-line filler proposal never becomes a card', async () => {
  const root = tmpRoot()
  const applied = await distillApply(root, { entries: [entry('write-tests', '注意边界情况')] })
  assert.equal(applied, 0)
  assert.equal(root.global.get('write-tests'), undefined)
})

test('distill applyEntries: a terse but factual card still lands', async () => {
  const root = tmpRoot()
  // The floor sits far below the shortest card in the real store (48 chars) and
  // below the tersest fixture in this suite: a fact is not rejected for brevity.
  const applied = await distillApply(root, { entries: [entry('pnpm-registry-retry', '镜像源失败时先切换 registry 再重试安装')] })
  assert.equal(applied, 1)
})

test('distill applyEntries: at most three writes per run', async () => {
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
  assert.equal(await distillApply(root, { entries: proposals }), 3)
  assert.equal(root.global.list().length, 3)
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
  assert.deepEqual(appliedOnly(result), { merged: 1, deleted: 0, rewritten: 0 })
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
  assert.deepEqual(appliedOnly(result), { merged: 1, deleted: 0, rewritten: 0 })
  assert.equal(store.get('legacy-a1b2c3d4'), undefined)
  assert.equal(store.get('legacy-e5f60708'), undefined)
  assert.equal(store.get('pnpm-registry-retry')?.category, 'lesson')
})

test('curator applyEdits: delete removes the cited card', async () => {
  const store = tmpStore()
  await seed(store, 'stale-note', '某个已经被取代的旧结论')
  const result = await curatorApply(store, { edits: [{ op: 'delete', topics: ['stale-note'] }] })
  assert.deepEqual(appliedOnly(result), { merged: 0, deleted: 1, rewritten: 0 })
  assert.equal(store.get('stale-note'), undefined)
})

test('curator applyEdits: rewrite replaces the body and only a given summary', async () => {
  const store = tmpStore()
  await seed(store, 'build-order', '构建脚本必须先跑类型检查再打包产物', 'convention')
  const result = await curatorApply(store, { edits: [{ op: 'rewrite', topic: 'build-order', content: '构建顺序：先类型检查再打包，最后才允许发布', summary: '构建发布顺序' }] })
  assert.deepEqual(appliedOnly(result), { merged: 0, deleted: 0, rewritten: 1 })
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
  assert.deepEqual(appliedOnly(result), { merged: 0, deleted: 0, rewritten: 0 })
  assert.notEqual(store.get('kept-forever'), undefined)
})

test('curator applyEdits: ghost keys and double citations reject the whole edit', async () => {
  const store = tmpStore()
  await seed(store, 'card-a', '第一条内容完全不同的卡')
  await seed(store, 'card-b', '第二条内容完全不同的卡')
  const ghost = await curatorApply(store, { edits: [{ op: 'delete', topics: ['no-such-card'] }] })
  assert.deepEqual(appliedOnly(ghost), { merged: 0, deleted: 0, rewritten: 0 })
  // card-a is claimed by the delete; the merge citing it again is rejected whole.
  const result = await curatorApply(store, {
    edits: [
      { op: 'delete', topics: ['card-a'] },
      { op: 'merge', topics: ['card-a', 'card-b'], target: { topic: 'card-b', summary: 's', category: 'fact', content: '合并产物' } },
    ],
  })
  assert.deepEqual(appliedOnly(result), { merged: 0, deleted: 1, rewritten: 0 })
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
  assert.deepEqual(appliedOnly(result), { merged: 0, deleted: 0, rewritten: 0 })
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

test('buildCuratePrompt: restructure mode says HOW to give a legacy key a real name', () => {
  const { system } = buildCuratePrompt('input', [], undefined, { restructure: true })
  assert.match(system, /legacy-\*/)
  assert.match(system, /should not survive this pass/)
  // The directive must name the op that can actually do it for a LONE card:
  // `rewrite` keeps the key and there is no create op, so without `rename`
  // spelled out the instruction was unsatisfiable.
  assert.match(system, /RENAME it/, 'names the op')
  assert.match(system, /when it stands alone/, 'and when it applies')
  assert.match(system, /or MERGE it into a well-named target/, 'while keeping merge for the multi-card case')
  // Off by default: the always-on rules mention `legacy-*` only as an example
  // of a bad key, so the gate is asserted on the DIRECTIVE's own phrasing.
  assert.doesNotMatch(buildCuratePrompt('input').system, /auto-migrated from the old timeline/)
})

test('buildCuratePrompt: the rename op is documented in the rules and the contract', () => {
  const { system } = buildCuratePrompt('input')
  assert.match(system, /rename: ONE card whose topic KEY is wrong/, 'the rule states when to use it')
  assert.match(system, /the ONLY way a lone card can/, 'and why no other op covers it')
  assert.match(system, /"op": "rename"/, 'the output contract shows the shape')
  assert.match(system, /a merge with exactly ONE cited key and a NEW target topic/, 'and ties it to the shape already shown')
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
  // The floor is 4: a store that has not yet outgrown a single sitting's
  // distill writes is left alone.
  for (let i = 0; i < 3; i += 1) await seed(root.global, `card-${String(i)}`, `第${String(i)}条互不相同的内容`)
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
  assert.deepEqual(appliedOnly(out), { merged: 0, deleted: 0, rewritten: 0 }, 'the collision rejects the edit')
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
  assert.deepEqual(appliedOnly(out), { merged: 0, deleted: 0, rewritten: 0 })
  assert.equal(store.get('pinned-card')?.body, '用户固定的内容', 'the pinned card body is untouched')
})

test('curator applyEdits: a single delete citing more than 30 keys is capped out', async () => {
  const store = tmpStore()
  for (let i = 0; i < 35; i += 1) await seed(store, `bulk-${String(i)}`, `内容 ${String(i)}`)
  const out = await curatorApply(store, {
    edits: [{ op: 'delete', topics: Array.from({ length: 35 }, (_, i) => `bulk-${String(i)}`) }],
  })
  assert.deepEqual(appliedOnly(out), { merged: 0, deleted: 0, rewritten: 0 }, 'a store-gutting mega edit is rejected by the cited-keys cap')
  assert.equal(store.list().length, 35, 'nothing was deleted')
})

test('curator applyEdits: a rewrite duplicating another surviving card is rejected', async () => {
  const store = tmpStore()
  await seed(store, 'card-a', '甲卡内容')
  await seed(store, 'card-b', '乙卡内容')
  const out = await curatorApply(store, { edits: [{ op: 'rewrite', topic: 'card-a', content: '乙卡内容' }] })
  assert.deepEqual(appliedOnly(out), { merged: 0, deleted: 0, rewritten: 0 })
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

// --- read-before-edit (input cap) ---------------------------------------------

/** A `seen` map that deliberately omits `missing` — models a pass whose input
 *  cap dropped that card's BODY while the whole index still named it. */
const seenWithout = (store: MemoryStore, missing: readonly string[]): Map<string, string> => {
  const skip = new Set(missing)
  return new Map(store.list().filter(card => !skip.has(card.name)).map(card => [card.name, contentHash(cardFingerprint(card))]))
}

test('curator applyEdits: an edit citing a card whose body was NOT shown is rejected', async () => {
  const store = tmpStore()
  await seed(store, 'shown-card', '这一张的正文下发给模型了')
  await seed(store, 'unshown-card', '这一张只在索引里出现过，正文被输入上限截掉')
  const out = await curatorApply(
    store,
    { edits: [{ op: 'delete', topics: ['unshown-card'] }] },
    seenWithout(store, ['unshown-card']),
  )
  assert.equal(out.skippedUnseen, 1, 'the unseen citation is counted, not applied')
  assert.equal(out.deleted, 0)
  assert.notEqual(store.get('unshown-card'), undefined, 'a card the pass never read survives the pass')
})

test('curator applyEdits: a merge citing one shown and one unshown card is rejected whole', async () => {
  const store = tmpStore()
  await seed(store, 'merge-shown', '镜像源失败时先切换 registry 再重试')
  await seed(store, 'merge-unshown', 'pnpm 镜像挂了要换源重新安装依赖')
  const out = await curatorApply(
    store,
    {
      edits: [{
        op: 'merge',
        topics: ['merge-shown', 'merge-unshown'],
        target: { topic: 'merge-shown', summary: 's', category: 'lesson', content: '合并产物' },
      }],
    },
    seenWithout(store, ['merge-unshown']),
  )
  assert.equal(out.skippedUnseen, 1)
  assert.equal(out.merged, 0)
  // Rejected WHOLE: the shown half must not be silently absorbed either.
  assert.equal(store.get('merge-unshown')?.body, 'pnpm 镜像挂了要换源重新安装依赖')
  assert.equal(store.get('merge-shown')?.body, '镜像源失败时先切换 registry 再重试')
})

test('curator applyEdits: an unseen rejection does not block other edits in the same pass', async () => {
  const store = tmpStore()
  await seed(store, 'ok-card', '可以安全删除的卡')
  await seed(store, 'unshown-card', '正文被截掉的卡')
  const out = await curatorApply(
    store,
    { edits: [{ op: 'delete', topics: ['unshown-card'] }, { op: 'delete', topics: ['ok-card'] }] },
    seenWithout(store, ['unshown-card']),
  )
  assert.equal(out.skippedUnseen, 1, 'the unseen edit is skipped')
  assert.equal(out.deleted, 1, 'the readable edit still lands')
  assert.equal(store.get('ok-card'), undefined)
  assert.notEqual(store.get('unshown-card'), undefined)
})

test('curator applyEdits: a card that CHANGED during the pass rejects its edit as stale', async () => {
  const store = tmpStore()
  await seed(store, 'edited-card', '模型看到的是这一版内容')
  // Snapshot what the pass was shown, THEN let a concurrent writer land.
  const seen = seenWithout(store, [])
  await store.upsert({ name: 'edited-card', category: 'fact', summary: ' routing hook', body: '模型调用期间被改写的新内容' })
  const out = await curatorApply(store, { edits: [{ op: 'delete', topics: ['edited-card'] }] }, seen)
  assert.equal(out.skippedStale, 1, 'the stale citation is counted separately from unseen')
  assert.equal(out.skippedUnseen, 0)
  assert.equal(out.deleted, 0)
  assert.equal(store.get('edited-card')?.body, '模型调用期间被改写的新内容', 'the newer content wins')
})

test('curator applyEdits: an unchanged card is not misreported as stale', async () => {
  const store = tmpStore()
  await seed(store, 'stable-card', '这一张整轮都没有被动过')
  const seen = seenWithout(store, [])
  const out = await curatorApply(store, { edits: [{ op: 'delete', topics: ['stable-card'] }] }, seen)
  assert.equal(out.skippedStale, 0, 'a matching hash is not stale')
  assert.equal(out.deleted, 1)
})

test('buildCuratePrompt: omitted keys are fenced in both halves of the prompt', () => {
  const withOmitted = buildCuratePrompt('store text', [], undefined, { omitted: ['big-card', 'other-card'] })
  assert.match(withOmitted.system, /may NOT cite those keys/, 'the rule reaches the system half')
  assert.match(withOmitted.user, /Cards omitted from this pass/, 'the key list reaches the user half')
  assert.match(withOmitted.user, /- big-card/)
  assert.match(withOmitted.user, /- other-card/)
  // Default: no fence, no list — the common untruncated pass is unchanged.
  const withoutOmitted = buildCuratePrompt('store text')
  assert.doesNotMatch(withoutOmitted.system, /may NOT cite those keys/)
  assert.doesNotMatch(withoutOmitted.user, /Cards omitted from this pass/)
})

test('buildCuratePrompt: the omitted list also appears when the store is over budget', () => {
  // The two directives coexist: the shrink order must not invite edits that
  // the omitted fence will reject.
  const { system } = buildCuratePrompt('store text', [], { cards: 99, chars: 50_000 }, { omitted: ['blocked-card'] })
  assert.match(system, /OVER BUDGET/)
  assert.match(system, /may NOT cite those keys/)
})

test('curator applyEdits: the rotation anchor cannot be taken by any edit this pass', async () => {
  const store = tmpStore()
  for (let i = 0; i < 120; i += 1) await seed(store, `anc-${String(i).padStart(3, '0')}`, 'w'.repeat(MAX_TOPIC_BODY_CHARS))
  const pass = serializeStore(store, 0)
  assert.equal(pass.truncated, true)
  const anchor = pass.nextAnchor!
  assert.ok(!pass.seen.has(anchor), 'the anchor was never shown')
  // The model tries to delete the anchor plus a card it legitimately read.
  const read = [...pass.seen.keys()][0]!
  const out = await curatorApply(
    store,
    { edits: [{ op: 'delete', topics: [anchor] }, { op: 'delete', topics: [read] }] },
    pass.seen,
  )
  assert.equal(out.skippedUnseen, 1, 'the anchor edit is rejected as unseen')
  assert.equal(out.deleted, 1, 'the readable edit still lands')
  assert.notEqual(store.get(anchor), undefined, 'the anchor survives the pass — the next rotation can find it')
  assert.equal(store.get(read), undefined)
})

test('curator applyEdits: a merge cannot use an omitted card as its target', async () => {
  const store = tmpStore()
  for (let i = 0; i < 120; i += 1) await seed(store, `tgt-${String(i).padStart(3, '0')}`, 'v'.repeat(MAX_TOPIC_BODY_CHARS))
  const pass = serializeStore(store, 0)
  const anchor = pass.nextAnchor!
  const read = [...pass.seen.keys()].slice(0, 2)
  // Target an existing but omitted card: upserting there would overwrite a
  // card nobody read, and its pin (pins key by topic) would carry over. This
  // is rejected by the merge-target COLLISION guard (an existing uncited key
  // is never a valid target), not by the unseen check — the cited keys were
  // both read. Either way the omitted card must come out untouched.
  const out = await curatorApply(
    store,
    { edits: [{ op: 'merge', topics: read, target: { topic: anchor, summary: 's', category: 'lesson', content: '合并产物' } }] },
    pass.seen,
  )
  assert.equal(out.merged, 0, 'the merge is rejected whole')
  assert.equal(store.get(anchor)?.body, 'v'.repeat(MAX_TOPIC_BODY_CHARS), 'the omitted card is untouched')
  // And the two cards it cited as merge sources survive too (rejected whole).
  assert.notEqual(store.get(read[0]!), undefined)
  assert.notEqual(store.get(read[1]!), undefined)
})

test('serializeStore: a card too big to ever fit is reported as blocking, not as an anchor', async () => {
  const store = tmpStore()
  // Seed one normal card first: the topics/ directory is created on first write.
  await seed(store, 'normal-card', '正常大小的卡')
  // A hand-edited file is never length-checked on READ, only on write, so an
  // oversized body is reachable — and alone it exceeds the whole budget.
  // category 'preference' sorts before 'lesson', so it is the list head.
  const huge = 'h'.repeat(45_000)
  writeFileSync(join(store.storePath, 'huge-card.md'), `---\nname: huge-card\ncategory: preference\nsummary: huge\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${huge}\n`)
  const out = serializeStore(store, 0)
  assert.equal(out.truncated, true)
  assert.equal(out.seen.size, 0, 'the oversized head card leaves no room for anything')
  assert.equal(out.nextAnchor, undefined, 'there is no anchor to rotate to')
  assert.equal(out.blockedBy, 'huge-card', 'the blocking card is named so the caller can stop retrying')
})

test('serializeStore: a blocking card reached BY ROTATION is also reported, not anchored to', async () => {
  const store = tmpStore()
  await seed(store, 'aaa-normal', '先被读到的小卡')
  const huge = 'h'.repeat(45_000)
  // 'zzz-huge' sorts last within the same category, so the first pass carries
  // the normal card and anchors to it; the SECOND pass starts there and blocks.
  writeFileSync(join(store.storePath, 'zzz-huge.md'), `---\nname: zzz-huge\ncategory: lesson\nsummary: huge\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${huge}\n`)
  const first = serializeStore(store, 0)
  assert.equal(first.truncated, true)
  assert.equal(first.nextAnchor, 'zzz-huge', 'pass 1 carries the normal card and points at the huge one')
  const start = Math.max(0, store.list().findIndex(card => card.name === first.nextAnchor))
  const second = serializeStore(store, start)
  assert.equal(second.seen.size, 0, 'pass 2 starts at the oversized card and carries nothing')
  assert.equal(second.nextAnchor, undefined, 'anchoring to it would repeat pass 2 forever')
  assert.equal(second.blockedBy, 'zzz-huge', 'the block is reported so the caller stops retrying')
})

test('curate stall: the counter accumulates, clears, and is per-scope', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
  assert.equal(root.recordCurateStall('global'), 1)
  assert.equal(root.recordCurateStall('global'), 2, 'consecutive no-progress passes accumulate')
  assert.equal(root.recordCurateStall('other-scope'), 1, 'scopes count independently')
  root.clearCurateStall('global')
  assert.equal(root.recordCurateStall('global'), 1, 'clearing starts the count over')
  assert.equal(root.recordCurateStall('other-scope'), 2, 'clearing one scope leaves the other alone')
  // Clearing an absent entry is a no-op, not an error.
  root.clearCurateStall('never-seen')
})

// --- curate cursor (truncation rotation) --------------------------------------

test('curate cursor: absent state reads as no anchor and a whole-store pass clears it', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
  assert.equal(root.curateCursorOf('global'), undefined, 'no state → start at the top')
  root.recordCurateCursor('global', 'card-42')
  assert.equal(root.curateCursorOf('global'), 'card-42')
  root.recordCurateCursor('global', undefined)
  assert.equal(root.curateCursorOf('global'), undefined, 'a whole-store pass clears the anchor')
})

test('curate cursor: an empty anchor clears rather than storing a blank key', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
  root.recordCurateCursor('global', 'card-42')
  root.recordCurateCursor('global', '')
  assert.equal(root.curateCursorOf('global'), undefined)
})

test('curate cursor: per-scope anchors do not bleed into each other', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
  root.recordCurateCursor('global', 'g-card')
  root.recordCurateCursor('skills-6ebc1ea8', 's-card')
  assert.equal(root.curateCursorOf('global'), 'g-card')
  assert.equal(root.curateCursorOf('skills-6ebc1ea8'), 's-card')
  assert.equal(root.curateCursorOf('never-seen'), undefined)
})

test('curate cursor: an old numeric cursor (pre-anchor state) degrades to no anchor', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-bg-')))
  // State written by the first cut of this feature stored an offset.
  root.recordCurateCursor('global', 'placeholder')
  assert.equal(root.curateCursorOf('global'), 'placeholder')
  root.recordCurateCursor('global', undefined)
  assert.equal(root.curateCursorOf('global'), undefined)
})

// --- serializeStore: the truncation contract itself ---------------------------

test('serializeStore: a store that fits is not truncated and reports every card as seen', async () => {
  const store = tmpStore()
  await seed(store, 'small-a', '第一张卡的正文')
  await seed(store, 'small-b', '第二张卡的正文')
  const out = serializeStore(store)
  assert.equal(out.truncated, false)
  assert.deepEqual([...out.seen.keys()].sort(), ['small-a', 'small-b'])
  assert.deepEqual(out.omitted, [], 'nothing omitted when everything fits')
  assert.equal(out.nextAnchor, undefined)
})

test('serializeStore: a rotated start still reports every card when the whole list fits', async () => {
  const store = tmpStore()
  await seed(store, 'rot-a', '甲')
  await seed(store, 'rot-b', '乙')
  await seed(store, 'rot-c', '丙')
  const out = serializeStore(store, 2)
  assert.equal(out.truncated, false)
  assert.equal(out.seen.size, 3, 'rotation changes order, not coverage')
  assert.equal(out.omitted.length, 0)
})

test('serializeStore: the anchor names the first card the cap dropped, and it is never in seen', async () => {
  const store = tmpStore()
  // Full-size bodies (the card cap is 400 chars): 120 cards ≈ 48k of body text,
  // comfortably past the 40k input cap while staying a legal store.
  for (let i = 0; i < 120; i += 1) await seed(store, `big-${String(i).padStart(3, '0')}`, 'x'.repeat(MAX_TOPIC_BODY_CHARS))
  const out = serializeStore(store)
  assert.equal(out.truncated, true, '120 full-size bodies cannot fit the 40k input cap')
  assert.ok(out.omitted.length > 0, 'the tail is reported as omitted')
  assert.equal(out.nextAnchor, out.omitted[0], 'the anchor is the first omitted card')
  assert.ok(!out.seen.has(out.nextAnchor!), 'an omitted card is by definition not seen')
  // seen ∪ omitted partitions the whole store — nothing silently vanishes.
  assert.equal(out.seen.size + out.omitted.length, store.list().length)
})

test('serializeStore: the anchor lets a later pass reach cards the cap kept dropping', async () => {
  const store = tmpStore()
  for (let i = 0; i < 120; i += 1) await seed(store, `cyc-${String(i).padStart(3, '0')}`, 'y'.repeat(MAX_TOPIC_BODY_CHARS))
  // Walk the rotation the way the curator does, WITHOUT any edits, and check
  // that every card is eventually carried — the property the cursor exists for.
  const everSeen = new Set<string>()
  let anchor: string | undefined
  for (let pass = 0; pass < 40 && everSeen.size < store.list().length; pass += 1) {
    const start = anchor === undefined ? 0 : Math.max(0, store.list().findIndex(card => card.name === anchor))
    const out = serializeStore(store, start)
    for (const key of out.seen.keys()) everSeen.add(key)
    anchor = out.truncated ? out.nextAnchor : undefined
    if (!out.truncated) break
  }
  assert.equal(everSeen.size, store.list().length, 'rotation must eventually carry every card')
})

test('serializeStore: deleting reviewed cards does not make the anchor skip the next ones', async () => {
  const store = tmpStore()
  for (let i = 0; i < 120; i += 1) await seed(store, `del-${String(i).padStart(3, '0')}`, 'z'.repeat(MAX_TOPIC_BODY_CHARS))
  // Pass 1 carries a prefix and is told the rest is omitted.
  const first = serializeStore(store, 0)
  assert.equal(first.truncated, true)
  const anchor = first.nextAnchor!
  const reviewed = [...first.seen.keys()]
  const offsetThatWouldBeRecorded = reviewed.length
  // The pass deletes a few of the cards it reviewed — the over-budget diet.
  // An OFFSET cursor taken before these deletions would now start that many
  // cards further along, skipping unreviewed ones; a KEY anchor must not.
  for (const key of reviewed.slice(0, 5)) await store.remove(key)
  assert.equal(store.list().length, 115, 'the store is still large enough to truncate')
  assert.equal(serializeStore(store, 0).truncated, true, 'still truncated after the deletions')

  const anchorStart = Math.max(0, store.list().findIndex(card => card.name === anchor))
  const second = serializeStore(store, anchorStart)
  assert.ok(second.seen.has(anchor), 'the next pass starts AT the card that was omitted, not past it')

  // CONTRAST: the offset cursor starts elsewhere and misses the anchor.
  assert.notEqual(offsetThatWouldBeRecorded % store.list().length, anchorStart, 'the two cursors disagree')
  assert.equal(
    serializeStore(store, offsetThatWouldBeRecorded).seen.has(anchor),
    false,
    'an offset cursor skips the anchor — which is exactly the defect the key anchor removes',
  )
})

// --- ledger events emitted by applyEdits --------------------------------------

test('ledger: a refused edit is recorded with its reason, not silently dropped', async () => {
  const store = tmpStore()
  await seed(store, 'shown-card', '这一张的正文下发了')
  await seed(store, 'unshown-card', '这一张的正文没下发')
  const seen = seenWithout(store, ['unshown-card'])
  const out = await curatorApply(store, { edits: [{ op: 'delete', topics: ['unshown-card'] }] }, seen)
  assert.equal(out.skippedUnseen, 1)
  assert.equal(out.events.length, 1, 'the refusal produces a ledger event')
  assert.equal(out.events[0]!.rejected, 'unseen')
  assert.deepEqual(out.events[0]!.keys, ['unshown-card'])
})

test('ledger: an applied merge records the sources and the target', async () => {
  const store = tmpStore()
  await seed(store, 'merge-src-a', '镜像源失败时先切换 registry 再重试')
  await seed(store, 'merge-src-b', 'pnpm 镜像挂了要换源重新安装依赖')
  const out = await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['merge-src-a', 'merge-src-b'],
      target: { topic: 'merge-src-a', summary: 's', category: 'lesson', content: '镜像源失败时切换 registry 后重试安装即可恢复' },
    }],
  })
  assert.equal(out.merged, 1)
  assert.equal(out.events.length, 1)
  assert.equal(out.events[0]!.op, 'merge')
  assert.equal(out.events[0]!.target, 'merge-src-a')
  assert.deepEqual([...out.events[0]!.keys].sort(), ['merge-src-a', 'merge-src-b'])
})

test('ledger: a rejected edit names only well-formed keys', async () => {
  const store = tmpStore()
  await seed(store, 'real-card', '内容')
  const seen = seenWithout(store, ['real-card'])
  // A model answer mixing a real key with junk: the ledger must not carry the
  // junk forward as if it were a topic.
  const out = await curatorApply(store, { edits: [{ op: 'delete', topics: ['real-card', '../etc', 'Not_A_Key'] }] }, seen)
  assert.equal(out.skippedUnseen, 1)
  assert.deepEqual(out.events[0]!.keys, ['real-card'])
})

test('ledger: an applied delete and rewrite each record their own event', async () => {
  const store = tmpStore()
  await seed(store, 'del-me', '要被删掉的卡')
  await seed(store, 'rewrite-me', '要被重写的卡')
  const out = await curatorApply(store, {
    edits: [
      { op: 'delete', topics: ['del-me'] },
      { op: 'rewrite', topic: 'rewrite-me', content: '重写后的内容' },
    ],
  })
  assert.equal(out.deleted, 1)
  assert.equal(out.rewritten, 1)
  assert.equal(out.events.length, 2)
  const ops = out.events.map(event => event.op).sort()
  assert.deepEqual(ops, ['delete', 'rewrite'])
  assert.deepEqual(out.events.find(event => event.op === 'delete')!.keys, ['del-me'])
  assert.deepEqual(out.events.find(event => event.op === 'rewrite')!.keys, ['rewrite-me'])
})

test('ledger: an edit over the cited-keys ceiling is recorded as over-limit', async () => {
  const store = tmpStore()
  // CURATE_MIN_ENTRIES cards is not needed here; the ceiling counts CITATIONS
  // against keys already claimed this pass, so one edit citing 31 keys trips it.
  const keys: string[] = []
  for (let i = 0; i < 31; i += 1) {
    const key = `bulk-${String(i).padStart(2, '0')}`
    await seed(store, key, `内容 ${String(i)}`)
    keys.push(key)
  }
  const out = await curatorApply(store, { edits: [{ op: 'delete', topics: keys }] })
  assert.equal(out.skippedOverLimit, 1, 'counted separately from malformed input')
  assert.equal(out.deleted, 0, 'nothing was deleted')
  assert.equal(store.list().length, 31, 'the store is intact')
  assert.equal(out.events.length, 1, 'and it is visible in the ledger, not dropped silently')
  assert.equal(out.events[0]!.rejected, 'over-limit')
})

test('ledger: a pass writes the ledger ONCE, not once per event', async () => {
  const store = tmpStore()
  const keys: string[] = []
  for (let i = 0; i < 12; i += 1) {
    const key = `batch-${String(i).padStart(2, '0')}`
    await seed(store, key, `内容 ${String(i)}`)
    keys.push(key)
  }
  // Six deletes in one pass: with the per-entry form this read and rewrote the
  // whole state file six times; the batch form must produce the same result
  // with one write. The observable contract is the resulting ledger contents.
  const out = await curatorApply(store, { edits: keys.slice(0, 6).map(key => ({ op: 'delete', topics: [key] })) })
  assert.equal(out.deleted, 6)
  assert.equal(out.events.length, 6, 'every applied edit produces an event')
})

test('ledger: every refusal is reported so the caller can decide what to keep', async () => {
  const store = tmpStore()
  const keys: string[] = []
  for (let i = 0; i < 40; i += 1) {
    const key = `unread-${String(i).padStart(2, '0')}`
    await seed(store, key, `内容 ${String(i)}`)
    keys.push(key)
  }
  // Every card exists but NONE was shown to the model: all 40 cites are
  // refusals. applyEdits reports them all — the cap that keeps a refusal
  // flood from evicting the applied records lives in curate(), so this
  // collector stays complete and the caller decides what to persist.
  const out = await curatorApply(store, { edits: keys.map(key => ({ op: 'delete', topics: [key] })) }, new Map())
  assert.equal(out.skippedUnseen, 40, 'the pass counts every refusal')
  assert.equal(out.events.length, 40, 'and reports every one')
  assert.ok(out.events.every(event => event.rejected === 'unseen'))
  assert.equal(store.list().length, 40, 'nothing was deleted')
})

// --- prompt discipline on the two background passes ---------------------------
// The RULE itself is asserted once, against its single home, in
// `core.test.ts` ("card-text discipline forbids narrating the saving…") and
// the per-surface coverage is walked there too. What belongs HERE is the part
// specific to these two prompts: that the discipline lands in the SYSTEM half
// (the user half carries the store, which the model must not rewrite).

test('buildDistillPrompt carries the discipline in its system half', () => {
  const root = tmpRoot()
  const { system, user } = buildDistillPrompt('[user] 说了点什么', 'D:/codes/demo', root)
  assert.ok(system.includes(CARD_TEXT_DISCIPLINE), 'the rule rides the instructions, not the transcript')
  assert.ok(!user.includes(CARD_TEXT_DISCIPLINE), 'the user half is material to review, not a rulebook')
})

test('buildCuratePrompt carries the discipline in its system half', () => {
  // The curator REWRITES existing bodies: a merge that says "I merged two
  // notes about X" would replace two real facts with a note about the merge.
  const { system, user } = buildCuratePrompt('store text')
  assert.ok(system.includes(CARD_TEXT_DISCIPLINE))
  assert.ok(!user.includes(CARD_TEXT_DISCIPLINE))
})

// --- progress invariant (the cursor moves only after the writes land) ---------
//
// `advanceDistill` records "everything up to here has been judged". Moving it
// before the writes would make a failed write PERMANENTLY invisible: the delta
// is never re-read, so the material is lost instead of retried. These tests
// drive the real `runDirect` with a stubbed model so the ordering is pinned,
// not merely documented.

/** A session slice `runDirect` can read: an id plus a model route. */
const stubSession = (id: string, route: { provider: string, model: string } | undefined): SessionLike => ({
  id: id as never,
  snapshotEvents: () => [],
  header: {},
  requestHeader: () => (route === undefined ? undefined : { config: route }),
})

/** A curator/distiller ctx whose `llm.stream` yields the given chunks. */
const stubCtxWithLlm = (chunks: Array<Record<string, unknown>>): never => ({
  llm: {
    stream: async function* () {
      for (const chunk of chunks) yield chunk
    },
  },
} as never)

const runDirectProbe = async (
  ctx: unknown,
  root: MemoryRoot,
  sessionId: string,
  session: SessionLike,
  cwd: string | undefined,
  lastEventSeq: number,
): Promise<void> => {
  const distiller = new MemoryDistiller(ctx as never, root, console as never)
  type RunDirect = (
    id: never, s: SessionLike, c: string | undefined, seq: number, sys: string, usr: string, parent: never,
  ) => Promise<void>
  return (distiller as unknown as { runDirect: RunDirect })
    .runDirect(sessionId as never, session, cwd, lastEventSeq, 'sys', 'usr', null as never)
}

test('progress: a FAILED model call does not advance the cursor', async () => {
  const root = tmpRoot()
  const session = stubSession('session-progress-fail', { provider: 'p', model: 'm' })
  const ctx = stubCtxWithLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }])
  await runDirectProbe(ctx, root, 'session-progress-fail', session, undefined, 42)
  assert.equal(root.distillSeqOf('session-progress-fail'), 0, 'the delta must be retried, not skipped')
})

test('progress: a failed WRITE does not advance the cursor either', async () => {
  const root = tmpRoot()
  const session = stubSession('session-progress-write', { provider: 'p', model: 'm' })
  // The model answers fine; the store write is what fails.
  root.global.upsert = () => Promise.reject(new Error('disk full'))
  const ctx = stubCtxWithLlm([
    { type: 'text-delta', index: 0, text: '{"entries":[{"topic":"x","summary":"后台提炼进度语义","category":"fact","content":"正文写入失败时进度游标必须留在原处"}]}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await assert.rejects(
    runDirectProbe(ctx, root, 'session-progress-write', session, undefined, 42),
    /disk full/, 'the write failure surfaces rather than being swallowed',
  )
  assert.equal(root.distillSeqOf('session-progress-write'), 0, 'the un-written delta stays pending for the next window')
})

test('progress: a SUCCESSFUL run advances the cursor and records the trace', async () => {
  const root = tmpRoot()
  const session = stubSession('session-progress-ok', { provider: 'p', model: 'm' })
  const ctx = stubCtxWithLlm([
    { type: 'text-delta', index: 0, text: '{"entries":[{"topic":"progress-ok","summary":"后台提炼进度语义","category":"lesson","content":"落盘的正文必须能独立成立并被下次会话复用"}]}' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await runDirectProbe(ctx, root, 'session-progress-ok', session, undefined, 42)
  assert.equal(root.distillSeqOf('session-progress-ok'), 42, 'progress moves only on success')
  assert.equal(root.global.get('progress-ok')?.body, '落盘的正文必须能独立成立并被下次会话复用', 'and the card really landed')
  assert.equal(root.distillActivity()[0]?.saved, 1, 'the trace records the write')
})

test('progress: a missing route KEEPS the delta rather than retiring it', async () => {
  const root = tmpRoot()
  const session = stubSession('session-progress-noroute', undefined)
  await runDirectProbe(stubCtxWithLlm([]), root, 'session-progress-noroute', session, undefined, 42)
  // `runDirect` is reached only when the gates found enough NEW material, and
  // a route can still appear later (`request/header` is appended inside a
  // step, and a turn may close with no step at all). Advancing here would
  // retire that material for good; retrying costs one log line.
  assert.equal(root.distillSeqOf('session-progress-noroute'), 0, 'nothing is retired while a route may still arrive')
  assert.equal(root.global.list().length, 0, 'and nothing is written')
})

test('progress: a missing route is still bounded — the delta is not processed twice', async () => {
  const root = tmpRoot()
  const session = stubSession('session-progress-noroute2', undefined)
  // Retrying is safe because nothing is written and no cursor moves: running
  // the same skip repeatedly must be idempotent, not accumulate state.
  await runDirectProbe(stubCtxWithLlm([]), root, 'session-progress-noroute2', session, undefined, 42)
  await runDirectProbe(stubCtxWithLlm([]), root, 'session-progress-noroute2', session, undefined, 42)
  assert.equal(root.distillSeqOf('session-progress-noroute2'), 0)
  assert.equal(root.global.list().length, 0)
  assert.deepEqual(root.distillActivity(), [], 'and it does not litter the activity trace either')
})

test('progress: a partially-applied run is re-entrant — the retry does not duplicate', async () => {
  const root = tmpRoot()
  const session = stubSession('session-progress-retry', { provider: 'p', model: 'm' })
  const chunks = [
    { type: 'text-delta', index: 0, text: '{"entries":[{"topic":"retry-card","summary":"后台提炼进度语义","category":"lesson","content":"同一条事实在重试后仍只应留下一张卡"}]}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  // Run 1 writes the card but its progress is LOST (simulating a crash right
  // after the write). Run 2 re-reads the same delta and re-proposes the same
  // card.
  await runDirectProbe(stubCtxWithLlm(chunks), root, 'session-progress-retry', session, undefined, 42)
  const first = root.global.get('retry-card')?.body
  await runDirectProbe(stubCtxWithLlm(chunks), root, 'session-progress-retry', session, undefined, 0)
  assert.equal(root.global.list().length, 1, 'the retry converges on one card, it does not duplicate')
  assert.equal(root.global.get('retry-card')?.body, first)
})

// --- curator progress: a truncated pass must NOT record the store as done ----

/** Drive the real `curate()` with a stubbed model over one target store. */
const curateProbe = async (
  root: MemoryRoot,
  label: string,
  store: MemoryStore,
  modelReply: string,
): Promise<void> => {
  const ctx = stubCtxWithLlm([
    { type: 'text-delta', index: 0, text: modelReply },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const curator = new MemoryCurator(ctx as never, root, console as never)
  type Curate = (target: { label: string, store: MemoryStore }, route: { provider: string, model: string }, id: never) => Promise<void>
  return (curator as unknown as { curate: Curate })
    .curate({ label, store }, { provider: 'p', model: 'm' }, 'session-curate-probe' as never)
}

test('curator progress: a truncated pass stays due instead of recording itself done', async () => {
  const root = tmpRoot()
  // 120 full-size cards cannot fit the 40k input cap, so the pass truncates.
  for (let i = 0; i < 120; i += 1) {
    await seed(root.global, `wide-${String(i).padStart(3, '0')}`, 'x'.repeat(MAX_TOPIC_BODY_CHARS))
  }
  assert.equal(serializeStore(root.global).truncated, true, 'the fixture really truncates')
  await curateProbe(root, 'global', root.global, '{"edits": []}')
  // Recording here would mark the WHOLE store reviewed while most of it was
  // never read — those cards would then never be looked at again.
  assert.equal(root.curatedHashOf('global'), undefined, 'a truncated pass records nothing')
})

test('curator progress: a truncated pass still advances the rotation anchor', async () => {
  const root = tmpRoot()
  for (let i = 0; i < 120; i += 1) {
    await seed(root.global, `turn-${String(i).padStart(3, '0')}`, 'y'.repeat(MAX_TOPIC_BODY_CHARS))
  }
  assert.equal(root.curateCursorOf('global'), undefined, 'no anchor before the first pass')
  await curateProbe(root, 'global', root.global, '{"edits": []}')
  const anchor = root.curateCursorOf('global')
  assert.ok(anchor !== undefined, 'the pass leaves an anchor so the omitted tail is next')
  assert.ok(!serializeStore(root.global).seen.has(anchor), 'and it names a card this pass did not read')
})

test('curator progress: a whole-store pass DOES record, so it is not re-swept', async () => {
  const root = tmpRoot()
  for (let i = 0; i < 10; i += 1) await seed(root.global, `small-${String(i)}`, `内容 ${String(i)}`)
  assert.equal(serializeStore(root.global).truncated, false)
  await curateProbe(root, 'global', root.global, '{"edits": []}')
  assert.equal(root.curatedHashOf('global'), root.global.fingerprint(), 'a fully-reviewed store is marked done')
  assert.equal(root.curateCursorOf('global'), undefined, 'and the rotation anchor is cleared')
})

test('curator progress: a failed model call records nothing and moves no anchor', async () => {
  const root = tmpRoot()
  for (let i = 0; i < 120; i += 1) {
    await seed(root.global, `fail-${String(i).padStart(3, '0')}`, 'z'.repeat(MAX_TOPIC_BODY_CHARS))
  }
  const ctx = stubCtxWithLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }])
  const curator = new MemoryCurator(ctx as never, root, console as never)
  type Curate = (target: { label: string, store: MemoryStore }, route: { provider: string, model: string }, id: never) => Promise<void>
  await (curator as unknown as { curate: Curate })
    .curate({ label: 'global', store: root.global }, { provider: 'p', model: 'm' }, 'session-fail' as never)
  assert.equal(root.curatedHashOf('global'), undefined, 'nothing is recorded for a pass that never ran')
  assert.equal(root.curateCursorOf('global'), undefined, 'and the rotation does not move either')
})

test('curator progress: a pass whose WRITE failed does not record the store as done', async () => {
  const root = tmpRoot()
  for (let i = 0; i < 10; i += 1) await seed(root.global, `fail-write-${String(i)}`, `内容 ${String(i)}`)
  assert.equal(serializeStore(root.global).truncated, false, 'a whole-list pass, so only the write can stop the record')
  // The model asks for a real edit; the store refuses to apply it.
  root.global.remove = () => Promise.reject(new Error('file locked'))
  const ctx = stubCtxWithLlm([
    { type: 'text-delta', index: 0, text: '{"edits":[{"op":"delete","topics":["fail-write-0"]}]}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const curator = new MemoryCurator(ctx as never, root, console as never)
  type Curate = (target: { label: string, store: MemoryStore }, route: { provider: string, model: string }, id: never) => Promise<void>
  await assert.rejects(
    (curator as unknown as { curate: Curate })
      .curate({ label: 'global', store: root.global }, { provider: 'p', model: 'm' }, 'session-write-fail' as never),
    /file locked/,
    'the write failure surfaces',
  )
  // Recording here would mark the store reviewed although this pass never got
  // past its first edit — the cards it never reached would never be looked at
  // again. The fingerprint must stay absent so the sweep retries.
  assert.equal(root.curatedHashOf('global'), undefined, 'a half-applied pass records nothing')
})

// --- rename: the only op that can move a LONE card onto a new key --------------
//
// Before this, a single `legacy-*` card could never be renamed: `rewrite` keeps
// the key, there is no create op, and merge demanded two sources. The
// restructure directive therefore asked for something the protocol could not
// express — measured against the live store, where a lone legacy card survived
// a pass whose fingerprint matched exactly.

test('curator applyEdits: a lone card can be RENAMED onto a new key', async () => {
  const store = tmpStore()
  await seed(store, 'legacy-abc12345', '用户位于成都，无需再问')
  const out = await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['legacy-abc12345'],
      target: { topic: 'user-location-chengdu', summary: '用户在成都', category: 'fact', content: '用户位于成都，无需再问' },
    }],
  })
  assert.equal(out.merged, 1, 'the rename lands')
  assert.equal(store.get('legacy-abc12345'), undefined, 'the placeholder key is gone')
  assert.equal(store.get('user-location-chengdu')?.body, '用户位于成都，无需再问', 'and the content moved with it')
  assert.equal(out.events.length, 1)
  assert.equal(out.events[0]!.op, 'rename', 'the ledger says RENAME, not merge — the explanation must match what happened')
  assert.equal(out.events[0]!.target, 'user-location-chengdu')
})

test('curator applyEdits: a rename archives the old card like any other removal', async () => {
  const store = tmpStore()
  await seed(store, 'legacy-abc12345', '用户位于成都，无需再问')
  await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['legacy-abc12345'],
      target: { topic: 'user-location-chengdu', summary: '用户在成都', category: 'fact', content: '用户位于成都，无需再问' },
    }],
  })
  assert.ok(store.archivedCards().some(c => c.topic === 'legacy-abc12345'), 'the old key is recoverable')
})

test('curator applyEdits: a one-key merge onto ITSELF is still rejected', async () => {
  const store = tmpStore()
  await seed(store, 'solo-card', '内容')
  // One cited key whose target IS that key is a no-op rewrite, not a merge and
  // not a rename — `rewrite` is the op for it.
  const out = await curatorApply(store, {
    edits: [{ op: 'merge', topics: ['solo-card'], target: { topic: 'solo-card', summary: 's', category: 'fact', content: '内容' } }],
  })
  assert.equal(out.merged, 0, 'rejected: this is what rewrite is for')
  assert.equal(out.events.length, 0, 'and it is not recorded as a rename')
})

test('curator applyEdits: a rename cannot land on an existing uncited key', async () => {
  const store = tmpStore()
  await seed(store, 'legacy-abc12345', '旧内容')
  await seed(store, 'occupied-key', '别人的内容')
  const out = await curatorApply(store, {
    edits: [{
      op: 'merge',
      topics: ['legacy-abc12345'],
      target: { topic: 'occupied-key', summary: 's', category: 'fact', content: '旧内容' },
    }],
  })
  // Same collision guard as a multi-source merge: renaming onto a live key
  // would silently overwrite a card nobody cited (and carry its pin over).
  assert.equal(out.merged, 0)
  assert.equal(store.get('occupied-key')?.body, '别人的内容', 'the live card is untouched')
  assert.equal(store.get('legacy-abc12345')?.body, '旧内容', 'and the source stays put')
})

test('curator applyEdits: a rename still needs the new key to be well formed', async () => {
  const store = tmpStore()
  await seed(store, 'legacy-abc12345', '内容')
  const out = await curatorApply(store, {
    edits: [{ op: 'merge', topics: ['legacy-abc12345'], target: { topic: '中文键', summary: 's', category: 'fact', content: '内容' } }],
  })
  assert.equal(out.merged, 0, 'a key that slugifies to nothing is refused')
  assert.equal(store.get('legacy-abc12345')?.body, '内容')
})
