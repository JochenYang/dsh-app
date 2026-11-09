/**
 * The vocabulary layer: query-side alias expansion.
 *
 * What these tests are really protecting, in order of how badly each one would
 * hurt:
 *   1. `forget` must never expand (a synonym is not a delete order);
 *   2. a query with TWO aliases must find a card written with both other names
 *      (the bug that produced this design);
 *   3. exact hits must come first (expansion may only ADD cards);
 *   4. the built-in table stays specific — no abbreviation that also names
 *      something else, measured against a real store;
 *   5. a bound on the expansion, and no expansion a Chinese reader would call a
 *      different word.
 *
 * @module @dsh-app/plugin-memory/tests/aliases
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchRoot, scratchStore } from './scratch.ts'
import { MemoryRoot, textMatchesQuery, type MemoryCategory, type MemoryStore } from '../src/memory-store.ts'
import {
  DEFAULT_ALIAS_GROUPS,
  MAX_ALIAS_MEMBERS,
  MAX_ALIAS_MEMBER_CHARS,
  MAX_ALIAS_VARIANTS,
  mergeAliasGroups,
  parseAliasGroups,
  planAliases,
  queryTokens,
} from '../src/recall-aliases.ts'
import { registerMemoryTools } from '../src/tools.ts'

const save = async (store: MemoryStore, name: string, body: string, category: MemoryCategory = 'fact', summary = ''): Promise<void> => {
  await store.upsert({ name, category, summary: summary === '' ? `${name} hook` : name, body })
}

/** Every alternative offered at one position (position 0 unless told otherwise). */
const alternativesAt = (query: string, position: number, groups: typeof DEFAULT_ALIAS_GROUPS = DEFAULT_ALIAS_GROUPS): string[] =>
  planAliases(query, groups).positions[position] ?? []

// --- positions: per-WORD alternatives -----------------------------------------

test('planAliases: an ordinary query is one position per word, nothing to substitute', () => {
  const plan = planAliases('nothing-here')
  assert.deepEqual(plan.positions, [['nothing'], ['here']])
  assert.deepEqual(plan.variants, ['nothing-here'])
})

test('planAliases: a member position offers its whole group, itself first', () => {
  const alternatives = alternativesAt('幻灯片', 0)
  assert.equal(alternatives[0], '幻灯片', 'the word the user typed leads')
  assert.ok(alternatives.includes('pptd'), 'and the other name is available')
  assert.deepEqual(alternativesAt('powershell', 0).sort(), ['powershell', 'pwsh'])
  assert.deepEqual(alternativesAt('工作区', 0).sort(), ['workspace', '工作区', '工作目录'].sort())
})

test('planAliases: TWO aliases are two independent positions (no sentence rewrite needed)', () => {
  // This is the defect that shaped the design: the first implementation only
  // ever changed ONE member per variant, so a card written `pwsh workspace`
  // matched neither `pwsh 工作区` nor `powershell workspace`.
  const plan = planAliases('powershell 工作区')
  assert.deepEqual(plan.positions[0]!.sort(), ['powershell', 'pwsh'])
  assert.deepEqual(plan.positions[1]!.sort(), ['workspace', '工作区', '工作目录'].sort())
})

test('planAliases: a Chinese compound is ONE word and is not expanded', () => {
  // `工作区域` is "work area", not "workspace". Splitting it would need a
  // segmenter; substring expansion was measured to invent matches
  // (`工作区域` → `workspace域`), so a compound is left alone.
  assert.deepEqual(planAliases('工作区域').positions, [['工作区域']])
  assert.deepEqual(planAliases('非工作区').positions, [['非工作区']])
  // ... while the same word as its own position still expands.
  assert.ok(alternativesAt('工作区', 0).includes('workspace'))
})

test('planAliases: an ASCII word only expands as a whole word', () => {
  assert.deepEqual(planAliases('websocket').positions, [['websocket']])
  assert.ok(alternativesAt('工作区 重连', 0).includes('workspace'), 'the Chinese position still expands next to another word')
})

// --- variants: members that carry a separator -----------------------------------

test('planAliases: a separated member is rewritten, and one member covers every spelling', () => {
  for (const query of ['hot-reload 配置', 'hot reload 配置', 'hot  reload 配置']) {
    const plan = planAliases(query)
    assert.ok(
      plan.variants.some(variant => variant.startsWith('热重载')),
      `${query} should offer 热重载, got ${JSON.stringify(plan.variants)}`,
    )
  }
})

test('planAliases: the rewrite is anchored on ASCII word boundaries', () => {
  // `hot-reload` must not be found inside `shot-reload`.
  assert.deepEqual(planAliases('shot-reload').variants, ['shot-reload'])
  assert.deepEqual(planAliases('shot reload').variants, ['shot reload'])
})

test('planAliases: a rewrite consumes the MATCHED span, not the member length', () => {
  // Two spaces where the member has one: slicing by `member.length` would leave
  // the second space glued to the replacement.
  const plan = planAliases('hot  reload 现在很慢')
  assert.ok(plan.variants.includes('热重载 现在很慢'), JSON.stringify(plan.variants))
})

test('planAliases: two separated members combine, breadth-first', () => {
  const groups = [['a-c', 'x'], ['b-d', 'y']] as const
  const plan = planAliases('a-c b-d', groups)
  assert.ok(plan.variants.includes('x b-d'), JSON.stringify(plan.variants))
  assert.ok(plan.variants.includes('a-c y'), JSON.stringify(plan.variants))
  assert.ok(plan.variants.includes('x y'), `both replaced: ${JSON.stringify(plan.variants)}`)
})

test('planAliases: two separated members combine even when both groups are full', () => {
  // Two legal 7-member groups: the first implementation spent the whole budget
  // on the first group's members and never produced a variant that changed both.
  const groups = [
    ['a-1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
    ['b-1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'],
  ] as const
  const plan = planAliases('a-1 b-1', groups)
  assert.ok(plan.variants.includes('a2 b-1'), `first member alone: ${JSON.stringify(plan.variants)}`)
  assert.ok(plan.variants.includes('a-1 b2'), `second member alone: ${JSON.stringify(plan.variants)}`)
  assert.ok(plan.variants.includes('a2 b2'), `BOTH replaced: ${JSON.stringify(plan.variants)}`)
  assert.ok(plan.variants.length <= MAX_ALIAS_VARIANTS)
})

test('planAliases: separators are folded when deduping, so a small budget is not spent twice', () => {
  // `a-b` and `a b` are the same query to the separator-tolerant pattern, so
  // counting them as two variants left no room for the real alias.
  const plan = planAliases('a-b', [['a-b', 'a b', 'x']], 2)
  assert.deepEqual(plan.variants, ['a-b', 'x'])
})

test('planAliases: the variant budget is bounded and the original is always first', () => {
  const groups = [['a-1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'], ['b-1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']] as const
  const plan = planAliases('a-1 b-1', groups)
  assert.ok(plan.variants.length <= MAX_ALIAS_VARIANTS, `expected <= ${String(MAX_ALIAS_VARIANTS)}, got ${String(plan.variants.length)}`)
  assert.equal(plan.variants[0], 'a-1 b-1', 'the original is variant #0')
})

// --- search: the read path ------------------------------------------------------

test('search: an alias reaches a card whose author used another word', async () => {
  const store = scratchStore('dshm-alias-search-')
  await save(store, 'pptd-import', 'PPT 模板按版式族导入，导入后重建缩略图。')
  await save(store, 'workspace-scope', '每个会话按 workspace 解析记忆作用域。')
  await save(store, 'pwsh-profile', 'pwsh 的 profile 在启动时加载。')

  assert.deepEqual(store.search('幻灯片', DEFAULT_ALIAS_GROUPS).map(card => card.name), ['pptd-import'])
  assert.deepEqual(store.search('工作区', DEFAULT_ALIAS_GROUPS).map(card => card.name), ['workspace-scope'])
  assert.deepEqual(store.search('powershell', DEFAULT_ALIAS_GROUPS).map(card => card.name), ['pwsh-profile'])
})

test('search: a card written with BOTH other names is found by a two-alias query', async () => {
  const store = scratchStore('dshm-alias-combo-')
  await save(store, 'pwsh-workspace-note', 'pwsh 的 workspace 作用域按会话解析。')
  assert.deepEqual(store.search('powershell 工作区', DEFAULT_ALIAS_GROUPS).map(card => card.name), ['pwsh-workspace-note'])
})

test('search: exact hits come first, alias hits after', async () => {
  const store = scratchStore('dshm-alias-order-')
  await save(store, 'a-workspace', 'workspace 的解析顺序。')
  await save(store, 'b-workspace-note', '工作区 的解析顺序。')
  const names = store.search('workspace', DEFAULT_ALIAS_GROUPS).map(card => card.name)
  assert.equal(names[0], 'a-workspace', 'the card that says workspace itself opens the result')
  assert.ok(names.includes('b-workspace-note'), 'and the alias hit is still there')
})

test('search: an alias-only card is exactly what the exact pass misses', async () => {
  const store = scratchStore('dshm-alias-only-')
  await save(store, 'pptd-import', 'PPT 模板按版式族导入。')
  await save(store, 'slides-note', '幻灯片按版式族分组导入。')
  assert.deepEqual(store.search('pptd', []).map(card => card.name), ['pptd-import'], 'the word pptd is in one card only')
  const withTable = store.search('pptd', DEFAULT_ALIAS_GROUPS).map(card => card.name)
  assert.equal(withTable[0], 'pptd-import', 'the exact hit stays first')
  assert.deepEqual(withTable, ['pptd-import', 'slides-note'], 'and the alias added exactly the card the exact pass could not reach')
})

test('search: a separated alternative keeps its boundaries on the CARD side', async () => {
  // The alternative `hot-reload` must not be found inside `shot reload`: the
  // boundary has to be defended where the candidate meets card text too, not
  // only on the query side.
  const store = scratchStore('dshm-alias-boundary-')
  await save(store, 'a-shot', 'shot reload 的说法')
  await save(store, 'b-hot', 'hot reload 之后生效')
  assert.deepEqual(store.search('hmr', DEFAULT_ALIAS_GROUPS).map(card => card.name), ['b-hot'])
})

test('search: no table by default, and an empty table disables expansion', async () => {
  const store = scratchStore('dshm-alias-off-')
  await save(store, 'pptd-import', 'PPT 模板按版式族导入。')
  assert.deepEqual(store.search('幻灯片').map(card => card.name), [], 'the default is "no synonyms"')
  assert.deepEqual(store.search('幻灯片', []).map(card => card.name), [])
  assert.deepEqual(store.search('幻灯片', DEFAULT_ALIAS_GROUPS).map(card => card.name), ['pptd-import'])
})

test('search: expansion can never lose or reorder an exact hit', async () => {
  const store = scratchStore('dshm-alias-superset-')
  await save(store, 'a-pptd', 'pptd 相关')
  await save(store, 'b-slides', '幻灯片 相关')
  await save(store, 'c-plain', '跟模板无关的一点内容')
  const exactOnly = store.search('pptd', []).map(card => card.name)
  const expanded = store.search('pptd', DEFAULT_ALIAS_GROUPS).map(card => card.name)
  assert.deepEqual(exactOnly, ['a-pptd'])
  assert.deepEqual(expanded.slice(0, exactOnly.length), exactOnly, 'the exact prefix is unchanged, in order')
  assert.deepEqual(expanded, ['a-pptd', 'b-slides'])
})

// --- the words mode the variants rely on ---------------------------------------

test('textMatchesQuery words mode: a short alternative cannot leak through a substring', () => {
  // The phrase rule is a substring test; on a VARIANT that would undo the whole
  // point of the boundary check (`ws` inside `pwsh`).
  assert.equal(textMatchesQuery('pwsh profile', 'ws', 'full'), true, 'the historical rule does match — pre-existing, kept')
  assert.equal(textMatchesQuery('pwsh profile', 'ws', 'words'), false, 'the variant rule does not')
  assert.equal(textMatchesQuery('pdfjs module', 'pdf', 'words'), false)
  assert.equal(textMatchesQuery('hot reload', 'hot-reload', 'words'), true, 'normalisation covers the spellings')
})

// --- parse / merge -------------------------------------------------------------

test('parseAliasGroups: every malformed shape is refused, and counted', () => {
  const cases: Array<[unknown, number]> = [
    [null, 1],
    [42, 1],
    ['nope', 1],
    [{}, 1],
    [{ groups: 'no' }, 1],
    [[['only-one']], 1],
    [[[1, 2]], 1],
    [['x'], 1],
  ]
  for (const [input, rejected] of cases) {
    const result = parseAliasGroups(input)
    assert.deepEqual(result.groups, [], `groups for ${JSON.stringify(input)}`)
    assert.equal(result.rejected, rejected, `rejected for ${JSON.stringify(input)}`)
  }
  assert.deepEqual(parseAliasGroups([['a', 'b']]), { groups: [['a', 'b']], rejected: 0 })
  assert.deepEqual(parseAliasGroups({ groups: [['a', 'b']] }), { groups: [['a', 'b']], rejected: 0 })
})

test('parseAliasGroups: a member belongs to ONE group, first come first served', () => {
  const { groups, rejected } = parseAliasGroups([['a', 'shared'], ['shared', 'b']])
  assert.deepEqual(groups, [['a', 'shared']], 'the later group loses the shared member')
  assert.equal(rejected, 1, 'and, left with one member, it is refused')
})

test('parseAliasGroups: over-long members and oversized groups are trimmed to the constants', () => {
  const long = 'x'.repeat(MAX_ALIAS_MEMBER_CHARS + 1)
  const many = Array.from({ length: MAX_ALIAS_MEMBERS + 3 }, (_, i) => `m${String(i)}`)
  const { groups } = parseAliasGroups([[long, 'ok', ...many]])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.includes(long), false, 'an over-long member is dropped')
  assert.equal(groups[0]!.length, MAX_ALIAS_MEMBERS, 'the group is exactly at the ceiling, not one past it')
})

test('mergeAliasGroups: first table wins a repeated member', () => {
  assert.deepEqual(mergeAliasGroups([['ws', 'workspace']], [['ws', 'workshop']]), [['ws', 'workspace']])
  assert.deepEqual(mergeAliasGroups([['a', 'b']], [['c', 'd']]), [['a', 'b'], ['c', 'd']])
})

// --- the built-in table --------------------------------------------------------

test('the built-in table carries only members MEASURED to find the other name', () => {
  const members = new Set(DEFAULT_ALIAS_GROUPS.flat().map(member => member.toLowerCase()))
  // Kept: each one is the same thing in another register, and measured to find
  // at least one card the other spelling could not.
  for (const member of ['pwsh', 'powershell', 'pptd', '幻灯片', 'workspace', '工作区', '工作目录', '热重载', 'hmr']) {
    assert.ok(members.has(member), `"${member}" should be in the built-in table`)
  }
  // Cut after measuring a real store: abbreviations that also name other things
  // (`ws` → 28→37, mostly WebSocket noise) or produced nothing (`pdf` 1→1).
  for (const member of ['ws', 'ps1', 'pdf', 'pdfjs', 'ppt', 'pptx', 'slides', 'compact', 'compactification']) {
    assert.equal(members.has(member), false, `"${member}" was measured as noise and must not come back`)
  }
  // `dsh` is the product's own name in 60 cards: expanding INTO it answered with
  // the whole store (0 → 60), so the group is out even though the two spellings
  // are the same thing. A symmetric table cannot hold a one-way group.
  assert.equal(members.has('dsh'), false, '"dsh" widens every query into the whole store')
  assert.ok(DEFAULT_ALIAS_GROUPS.length <= 5, 'a table that grows without evidence stops being an alias table')
})

// --- the table from disk -------------------------------------------------------

test('MemoryRoot.aliasGroups: a missing or broken file answers the built-in table', () => {
  const expected = mergeAliasGroups(DEFAULT_ALIAS_GROUPS)
  assert.deepEqual(scratchRoot('dshm-alias-missing-').aliasGroups(), expected)

  const broken = scratchRoot('dshm-alias-broken-')
  writeFileSync(join(broken.dir, 'aliases.json'), '{ this is not json')
  assert.deepEqual(broken.aliasGroups(), expected, 'a stray comma must not take recall down')

  const wrongShape = scratchRoot('dshm-alias-wrongshape-')
  writeFileSync(join(wrongShape.dir, 'aliases.json'), JSON.stringify({ nope: true }))
  assert.deepEqual(wrongShape.aliasGroups(), expected)
})

test('MemoryRoot.aliasGroups: the user file ADDS a group, and the built-in table keeps its meaning', async () => {
  const root = scratchRoot('dshm-alias-user-')
  writeFileSync(join(root.dir, 'aliases.json'), JSON.stringify([
    ['斗鱼', 'douyu'],
    // A member the built-in table already owns: the built-in meaning wins.
    ['工作区', 'workshop'],
  ]))
  const groups = root.aliasGroups()
  assert.ok(groups.some(group => group.join(',') === '斗鱼,douyu'), 'the user group is in force')
  const chineseGroup = groups.find(group => group.includes('工作区'))
  assert.deepEqual([...(chineseGroup ?? [])].sort(), ['workspace', '工作区', '工作目录'].sort())

  const store = root.projectFor('D:\\proj\\alias-user')
  await save(store, 'douyu-monitor', '直播间弹幕去重窗口按事件时间排序。')
  assert.deepEqual(store.search('斗鱼', root.aliasGroups()).map(card => card.name), ['douyu-monitor'])
})

// --- the destructive path ------------------------------------------------------

test('forget: a synonym never deletes the cards it might refer to', async () => {
  const store = scratchStore('dshm-alias-forget-')
  await save(store, 'pptd-import', 'PPT 模板按版式族导入。')
  const { removed } = await store.forget('幻灯片')
  assert.deepEqual(removed, [], 'the word 幻灯片 appears in no card, and no alias may stand in for it')
  assert.equal(store.list().length, 1)
})

// --- the tool surface ----------------------------------------------------------

test('memory_recall: the query goes through the alias table the root provides', async () => {
  const root = scratchRoot('dshm-alias-tool-')
  writeFileSync(join(root.dir, 'aliases.json'), JSON.stringify([['斗鱼', 'douyu']]))
  const tools = new Map<string, unknown>()
  registerMemoryTools({
    tools: {
      register(definition: { name: string }): () => void {
        tools.set(definition.name, definition)
        return () => undefined
      },
    },
    get: () => undefined,
  } as never, root)
  const CWD = 'D:\\proj\\alias-tool'
  const store = root.projectFor(CWD)
  await save(store, 'douyu-monitor', '直播间弹幕去重窗口按事件时间排序。')
  const recall = tools.get('memory_recall') as {
    execute(args: unknown, exec: unknown): Promise<{ project: { cards?: Array<{ topic: string }>, matched?: number } }>
  }
  const result = await recall.execute(
    { query: '斗鱼' },
    { agent: { id: 'session-alias', session: { header: { cwd: CWD } } } },
  )
  assert.deepEqual(result.project.cards?.map(card => card.topic), ['douyu-monitor'])
  assert.equal(result.project.matched, 1)
})

test('queryTokens: a script boundary is a word boundary (the splitter the positions use)', () => {
  assert.deepEqual(queryTokens('memory召回'), ['memory', '召回'])
  assert.deepEqual(queryTokens('召回memory'), ['召回', 'memory'])
  assert.deepEqual(queryTokens('dsh插件安装'), ['dsh', '插件安装'])
  assert.deepEqual(queryTokens('dsh-app-vs-stock'), ['dsh', 'app', 'vs', 'stock'])
  assert.deepEqual(queryTokens('   '), [])
})
