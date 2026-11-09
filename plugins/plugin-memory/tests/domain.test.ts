/**
 * Domain as a first-class field: derivation (D1), the card field itself (D2),
 * the tool surface that reports it (D3), the index/ordering/status wiring (D4)
 * and the curator input that consumes it (D5).
 *
 * The point of this file is not that a `domain:` line parses — it is the four
 * behaviours that silently break if it does not: a domain-only edit is not
 * swallowed as `unchanged`, a round-trip loses no field, an omitted domain is
 * inherited rather than cleared, and an existing store's index does not move.
 *
 * @module @dsh-app/plugin-memory/tests/domain
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir, scratchRoot, scratchStore } from './scratch.ts'
import {
  CARD_CAP,
  CARD_WARN_AT,
  DOMAIN_CAP,
  INDEX_WARN_AT,
  MemoryRoot,
  projectSlug,
  cardFingerprint,
  contentHash,
  domainOf,
  indexLineKey,
  isValidDomain,
  parseCard,
  queryTokens,
  renderCard,
  textMatchesQuery,
  validateCardInput,
  type MemoryCategory,
  type TopicCard,
} from '../src/memory-store.ts'
import { INDEX_LINE_CEILING } from '../src/prompt.ts'
import { CURATE_BUDGET, MemoryCurator, buildCuratePrompt, serializeStore } from '../src/curator.ts'
import { ROUTE_PREFIX, registerMemoryRoutes } from '../src/routes.ts'
import { registerMemoryTools } from '../src/tools.ts'
import recallCorpus from './fixtures/recall-queries.json'

const save = async (store: ReturnType<typeof scratchStore>, name: string, body: string, extra: { category?: MemoryCategory, summary?: string, domain?: string } = {}): Promise<void> => {
  await store.upsert({
    name,
    category: extra.category ?? 'lesson',
    summary: extra.summary ?? `${name} hook`,
    body,
    ...(extra.domain === undefined ? {} : { domain: extra.domain }),
  })
}

// --- D1: domainOf -------------------------------------------------------------

test('domainOf: a declared domain wins, otherwise the topic key\'s first segment', () => {
  assert.deepEqual(domainOf({ name: 'dsh-plugin-install-prunes-suite' }), { key: 'dsh', src: 'inferred' })
  assert.deepEqual(domainOf({ name: 'windows-acl-compact-refuses' }), { key: 'windows', src: 'inferred' })
  // No hyphen: the whole key is the domain (and it is non-empty, which is what
  // every metric and index line depends on).
  assert.deepEqual(domainOf({ name: 'redux' }), { key: 'redux', src: 'inferred' })
  assert.deepEqual(domainOf({ name: 'dsh-plugin-install', domain: 'desktop-shell' }), { key: 'desktop-shell', src: 'declared' })
  // A declared domain that equals the derived one still reports `declared`:
  // the two states answer different questions (what decided it), and a metric
  // that folded them would never be able to say how many cards are declared.
  assert.deepEqual(domainOf({ name: 'dsh-x', domain: 'dsh' }), { key: 'dsh', src: 'declared' })
})

test('domainOf: every key in the recall corpus derives a non-empty, valid domain', () => {
  assert.ok(recallCorpus.cards.length >= 20)
  for (const card of recallCorpus.cards) {
    const { key, src } = domainOf({ name: card.topic })
    assert.notEqual(key, '', `${card.topic} derived no domain`)
    assert.equal(src, 'inferred', `${card.topic} declares nothing`)
    assert.ok(isValidDomain(key), `${card.topic} derived an invalid domain "${key}"`)
  }
})

test('isValidDomain: ASCII kebab-case, at most 16 characters', () => {
  assert.equal(isValidDomain('dsh'), true)
  assert.equal(isValidDomain('dsh-app'), true)
  assert.equal(isValidDomain('a'), true)
  assert.equal(isValidDomain(''), false)
  assert.equal(isValidDomain('-lead'), false)
  assert.equal(isValidDomain('Upper'), false)
  assert.equal(isValidDomain('域'), false)
  assert.equal(isValidDomain('a'.repeat(17)), false, 'the index prefix cannot afford a 17-char domain')
})

// --- D2: the card field -------------------------------------------------------

const SAMPLE: TopicCard = {
  name: 'dsh-plugin-install',
  category: 'lesson',
  summary: '安装会剪掉套件层',
  created: '2026-01-02',
  updated: '2026-01-03',
  body: 'dsh plugin install 会剪掉品牌套件层，安装后要重新跑一次套件链接。',
  malformed: false,
}

test('D2 round-trip: every field survives render → parse, with and without a domain', () => {
  for (const card of [SAMPLE, { ...SAMPLE, domain: 'desktop-shell' }]) {
    const parsed = parseCard(card.name, renderCard(card))
    assert.deepEqual(parsed, card, `round-trip lost a field for ${card.domain ?? 'no domain'}`)
  }
})

test('D2 render: a card without a domain renders no `domain:` line (existing bytes do not move)', () => {
  const text = renderCard(SAMPLE)
  assert.equal(text.includes('domain:'), false)
  assert.equal(text, [
    '---',
    'name: dsh-plugin-install',
    'category: lesson',
    'summary: 安装会剪掉套件层',
    'created: 2026-01-02',
    'updated: 2026-01-03',
    '---',
    '',
    SAMPLE.body,
    '',
  ].join('\n'))
})

test('D2 parse: unknown keys are ignored and an invalid domain reads as absent, never malformed', () => {
  const text = [
    '---',
    'name: some-topic',
    'category: fact',
    'domain: Not A Domain',
    'confidence: 0.9',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    '---',
    '',
    'body text',
    '',
  ].join('\n')
  const card = parseCard('some-topic', text)
  assert.equal(card.malformed, false)
  assert.equal(card.domain, undefined, 'an unusable domain falls back to the derived one')
  assert.equal(card.body, 'body text')
  assert.equal(card.summary, '(no summary)')
})

test('D2 fingerprint: the domain is part of what a reader would call the content', () => {
  const plain = cardFingerprint(SAMPLE)
  const declared = cardFingerprint({ ...SAMPLE, domain: 'desktop-shell' })
  assert.notEqual(plain, declared, 'a domain-only change must not hash the same')
  // ... and it must be stable for the SAME card, or the read-before-edit witness
  // would reject every legitimate curator edit.
  assert.equal(cardFingerprint({ ...SAMPLE, domain: 'desktop-shell' }), declared)
})

test('D2 validateCardInput: a domain that is not ASCII kebab-case is refused', () => {
  const base = { name: 'dsh-x', category: 'lesson', summary: 'hook', body: 'body' }
  assert.equal(validateCardInput(base), undefined)
  assert.equal(validateCardInput({ ...base, domain: 'dsh' }), undefined)
  assert.match(String(validateCardInput({ ...base, domain: 'Not A Domain' })), /invalid domain/)
  assert.match(String(validateCardInput({ ...base, domain: 'a'.repeat(17) })), /invalid domain/)
})

test('D2 upsert: changing ONLY the domain answers `updated` and lands on disk', async () => {
  const store = scratchStore('dshm-domain-only-')
  await save(store, 'dsh-plugin-install', 'body text')
  const before = readFileSync(join(store.storePath, 'dsh-plugin-install.md'), 'utf8')
  assert.equal(before.includes('domain:'), false)

  const result = await store.upsert({ name: 'dsh-plugin-install', category: 'lesson', body: 'body text', domain: 'desktop-shell' })
  assert.equal(result.op, 'updated', 'a domain-only edit must not be swallowed as unchanged')
  assert.equal(result.card.domain, 'desktop-shell')
  const after = readFileSync(join(store.storePath, 'dsh-plugin-install.md'), 'utf8')
  assert.match(after, /^domain: desktop-shell$/mu)
  assert.equal(store.get('dsh-plugin-install')?.domain, 'desktop-shell')

  // Repeating the same write is now a no-op...
  const again = await store.upsert({ name: 'dsh-plugin-install', category: 'lesson', body: 'body text', domain: 'desktop-shell' })
  assert.equal(again.op, 'unchanged')
  // ... and omitting the domain INHERITS it rather than clearing it.
  const inherited = await store.upsert({ name: 'dsh-plugin-install', category: 'lesson', body: 'body text (revised)' })
  assert.equal(inherited.op, 'updated')
  assert.equal(inherited.card.domain, 'desktop-shell')
})

test('R1 queryTokens: a script boundary is a word boundary', () => {
  // Chinese runs scripts together with no separator, so the naive split left
  // `memory召回` as ONE token — matched only if the text happened to contain
  // that exact concatenation, which is the defect token-AND exists to fix.
  assert.deepEqual(queryTokens('memory召回'), ['memory', '召回'])
  assert.deepEqual(queryTokens('召回memory'), ['召回', 'memory'])
  assert.deepEqual(queryTokens('dsh插件安装'), ['dsh', '插件安装'])
  assert.deepEqual(queryTokens('memory 召回'), ['memory', '召回'])
  assert.deepEqual(queryTokens('dsh-app-vs-stock'), ['dsh', 'app', 'vs', 'stock'])
  assert.deepEqual(queryTokens('   '), [])
  // The matcher, not only the tokenizer: the words are apart in the text.
  assert.equal(textMatchesQuery('memory 用于保存，召回使用 token', 'memory召回'), true)
  assert.equal(textMatchesQuery('memory 用于保存，召回使用 token', '召回memory'), true)
  assert.equal(textMatchesQuery('memory 用于保存', 'memory召回'), false)
})

test('R1 search: a mixed-script query that the phrase rule cannot match still hits', async () => {
  const store = scratchStore('dshm-domain-mixed-')
  await save(store, 'memory-recall-note', 'memory 用于保存，召回使用 token AND 规则。')
  assert.deepEqual(store.search('memory召回').map(card => card.name), ['memory-recall-note'])
  assert.deepEqual(store.search('召回memory').map(card => card.name), ['memory-recall-note'])
})

test('R1 search: CJK-ONLY compounds are NOT split — a known limit, asserted so it stays known', async () => {
  // `索引漂移` is two Chinese words to a reader and ONE token here: Chinese has
  // no separator to split on, and splitting the compound needs a dictionary and
  // a segmenter. That is not in this round's scope, and pretending otherwise
  // would make the corpus lie. A space works, and the single compound still
  // matches wherever it appears literally.
  const store = scratchStore('dshm-domain-cjk-')
  await save(store, 'index-drift-note', '索引每次写入后重建只是约定；索引与卡集漂移会注入幽灵话题。')
  assert.deepEqual(store.search('索引 漂移').map(card => card.name), ['index-drift-note'], 'space-separated CJK is two tokens')
  assert.deepEqual(store.search('索引漂移').map(card => card.name), [], 'the compound is one substring and appears nowhere verbatim')
})

// --- D4: index, ordering, status ---------------------------------------------

test('D4 reindex: cards of one domain sit next to each other', async () => {
  const store = scratchStore('dshm-domain-order-')
  await save(store, 'agent-loop', 'a', { category: 'fact' })
  await save(store, 'dsh-second', 'b', { category: 'preference' })
  await save(store, 'windows-one', 'c', { category: 'lesson' })
  await save(store, 'dsh-first', 'd', { category: 'convention' })
  await store.reindex()
  const keys = store.indexText().split('\n').map(line => indexLineKey(line)).filter((key): key is string => key !== undefined)
  // Groups by domain; INSIDE a group the category order decides (preference
  // before convention), which is the order the rest of the plugin already uses.
  assert.deepEqual(keys, ['agent-loop', 'dsh-second', 'dsh-first', 'windows-one'], 'domains group, and category orders inside a group')
})

test('D4 index line: a DECLARED domain that the key does not already carry is rendered', async () => {
  const store = scratchStore('dshm-domain-prefix-')
  await save(store, 'dsh-plugin-install', 'body', { domain: 'desktop-shell' })
  await save(store, 'windows-acl', 'body2')
  await store.reindex()
  const text = store.indexText()
  assert.match(text, /- \[lesson\] \[desktop-shell\] dsh-plugin-install — /u)
  // The inferred one stays prefix-free: the key already starts with it.
  assert.match(text, /- \[lesson\] windows-acl — /u)
  assert.equal(indexLineKey('- [lesson] [desktop-shell] dsh-plugin-install — hook (updated 2026-01-01)'), 'dsh-plugin-install')
  assert.equal(indexLineKey('- [lesson] windows-acl — hook (updated 2026-01-01)'), 'windows-acl')
  assert.equal(indexLineKey('- [lesson] (updated 2026-01-01)'), undefined, 'a malformed line answers undefined, not a wrong key')
})

test('D4 index cost: an inferred domain adds nothing, a declared one adds exactly its prefix', async () => {
  const inferred = scratchStore('dshm-domain-cost-a-')
  for (let i = 0; i < 6; i += 1) await save(inferred, `dsh-card-${String(i)}`, `body ${String(i)}`)
  await inferred.reindex()
  // The pre-domain line format, rebuilt here so the comparison is explicit.
  // Trimmed, because `indexText()` trims the trailing newline of the stored file.
  const legacy = ['# Memory index (auto-generated from topics/; edits are overwritten)', '',
    ...inferred.list().sort((a, b) => a.name.localeCompare(b.name)).map(card => `- [${card.category}] ${card.name} — ${card.summary} (updated ${card.updated})`), '']
    .join('\n').trim()
  // EQUAL, not "at most": an inferred domain is already in the key, so a single
  // added character here would be the redundancy the design refuses.
  assert.equal(inferred.indexText().length, legacy.length, 'inferred domains add not one character')

  const declared = scratchStore('dshm-domain-cost-b-')
  for (let i = 0; i < 6; i += 1) await save(declared, `dsh-card-${String(i)}`, `body ${String(i)}`, { domain: 'desktop-shell' })
  await declared.reindex()
  const lines = declared.indexText().split('\n').filter(line => line.startsWith('- '))
  assert.equal(lines.length, 6)
  for (const line of lines) assert.ok(line.includes('[desktop-shell] '), 'a declared domain is visible once per line it changes')
})

test('D4 metrics: domain counts come from one read of the cards', async () => {
  const store = scratchStore('dshm-domain-metrics-')
  await save(store, 'dsh-a', 'a')
  await save(store, 'dsh-b', 'b')
  await save(store, 'windows-a', 'c')
  await save(store, 'windows-b', 'd', { domain: 'platform' })
  const metrics = store.metrics()
  assert.equal(metrics.cards, 4)
  assert.equal(metrics.domains, 3, 'dsh, windows and the declared platform')
  assert.equal(metrics.maxDomainCards, 2)
})

test('D4 /status rows carry the domain columns and the warning bands', async () => {
  const root = scratchRoot('dshm-domain-status-')
  const store = root.projectFor('D:\\proj\\domain-status')
  await save(store, 'dsh-a', 'a')
  await save(store, 'windows-a', 'b')
  const { listProjects } = await import('../src/memory-store.ts')
  const rows = listProjects(root.dir)
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.domains, 2)
  assert.equal(row.maxDomainCards, 1)
  assert.equal(row.cardWarn, false)
  assert.equal(row.indexWarn, false)
  assert.equal(row.rotCards, 0)
  assert.equal(row.staleCards, 0)
})

test('W1: the warning bands are 80% of the caps they measure, and the caps match the real ones', () => {
  assert.equal(CARD_CAP, CURATE_BUDGET.cards, 'the /status card cap restates the curator target')
  assert.equal(INDEX_LINE_CEILING, 50)
  assert.equal(CARD_WARN_AT, Math.ceil(CARD_CAP * 0.8))
  assert.equal(INDEX_WARN_AT, Math.ceil(INDEX_LINE_CEILING * 0.8))
  // DOMAIN_CAP stays outside every gate this round; the constant only decides
  // whether a measurement row is written.
  assert.equal(DOMAIN_CAP > 0, true)
})

// --- D3: the tool surface -----------------------------------------------------

/** Minimal tool registrar (same shape as the tools suite). */
function stubCtx(): { ctx: never, tools: Map<string, unknown> } {
  const tools = new Map<string, unknown>()
  const ctx = {
    tools: {
      register(definition: { name: string }): () => void {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get: (name: string): unknown => (name === 'agents' ? { get: () => ({ id: 'agent-1' }) } : undefined),
  }
  return { ctx: ctx as never, tools }
}

const CWD = 'D:\\proj\\domain-tools'
const EXEC = { agent: { id: 'session-domain', session: { header: { cwd: CWD } } } }

interface DomainResult {
  saved?: boolean
  op?: string
  reason?: string
  domain?: { key: string, src: string, cards: number, summaries: string[] }
  domainOver?: boolean
}

const saveTool = (tools: Map<string, unknown>): { execute(args: unknown, exec: unknown): Promise<DomainResult> } =>
  tools.get('memory_save') as { execute(args: unknown, exec: unknown): Promise<DomainResult> }

test('D3 memory_save: a declared domain is persisted and reported with its sibling count', async () => {
  const root = scratchRoot('dshm-domain-tool-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save_ = saveTool(tools)
  const first = await save_.execute({ topic: 'dsh-one', category: 'fact', summary: '第一篇', content: '正文一', domain: 'Desktop Shell' }, EXEC)
  assert.equal(first.saved, true)
  assert.deepEqual(first.domain?.key, 'desktop-shell', 'the declared domain is slugified')
  assert.equal(first.domain?.src, 'declared')
  assert.equal(first.domainOver, false, 'DOMAIN_CAP is measurement-only this round')
  const file = readFileSync(join(root.projectFor(CWD).storePath, 'dsh-one.md'), 'utf8')
  assert.match(file, /^domain: desktop-shell$/mu)
})

test('D3 memory_save: omitting the domain derives it, persists nothing, and keeps a stored one', async () => {
  const root = scratchRoot('dshm-domain-tool2-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save_ = saveTool(tools)
  const created = await save_.execute({ topic: 'dsh-two', category: 'fact', summary: '第二篇', content: '正文二' }, EXEC)
  assert.equal(created.domain?.key, 'dsh')
  assert.equal(created.domain?.src, 'inferred')
  const store = root.projectFor(CWD)
  assert.equal(readFileSync(join(store.storePath, 'dsh-two.md'), 'utf8').includes('domain:'), false, 'a derived domain is not written')

  await save_.execute({ topic: 'dsh-two', category: 'fact', content: '正文二', domain: 'shell' }, EXEC)
  const updated = await save_.execute({ topic: 'dsh-two', category: 'fact', content: '正文二改' }, EXEC)
  assert.equal(updated.op, 'updated')
  assert.equal(updated.domain?.key, 'shell', 'an update that omits the domain keeps the stored one')
  assert.equal(updated.domain?.src, 'declared')
})

test('D3 memory_save: the domain context caps its summaries at five, each at 40 characters', async () => {
  const root = scratchRoot('dshm-domain-tool3-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save_ = saveTool(tools)
  const first = await save_.execute({ topic: 'dsh-card-0', category: 'fact', summary: '第0张卡的摘要', content: '正文 0' }, EXEC)
  // The phase gate's shape: three cards in one domain answer three summaries.
  await save_.execute({ topic: 'dsh-card-1', category: 'fact', summary: '第1张卡的摘要', content: '正文 1' }, EXEC)
  const three = await save_.execute({ topic: 'dsh-card-2', category: 'fact', summary: '第2张卡的摘要', content: '正文 2' }, EXEC)
  assert.equal(first.domain?.cards, 1)
  assert.equal(three.domain?.cards, 3)
  assert.equal(three.domain?.summaries.length, 3)
  assert.equal(three.domain?.summaries[0], '第0张卡的摘要', 'summaries name the bucket, oldest-written first')

  for (let i = 3; i < 7; i += 1) {
    await save_.execute({
      topic: `dsh-card-${String(i)}`,
      category: 'fact',
      summary: `第${String(i)}张卡的摘要`,
      content: `正文 ${String(i)}`,
    }, EXEC)
  }
  const result = await save_.execute({ topic: 'dsh-card-6', category: 'fact', content: '正文 6 改' }, EXEC)
  assert.equal(result.domain?.cards, 7, 'the count covers the whole domain, not the capped list')
  assert.equal(result.domain?.summaries.length, 5, 'the summaries are a routing hint, not a second index')
  for (const summary of result.domain?.summaries ?? []) assert.ok(summary.length <= 40)
})

test('D3 memory_save: an unusable domain is refused with a correctable reason', async () => {
  const root = scratchRoot('dshm-domain-tool4-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const result = await saveTool(tools).execute({ topic: 'dsh-x', category: 'fact', summary: 'hook', content: '正文', domain: '域' }, EXEC)
  assert.equal(result.saved, false)
  assert.match(String(result.reason), /invalid domain/)
})

// --- D5: the curator's input ---------------------------------------------------

test('D5 the domain reaches /ledger: curator event → distill-state → route payload', async () => {
  // The wire type (`MemoryLedgerRow`) and the host type (`LedgerEntry`) are two
  // declarations; this walks the whole chain so a field that exists in only one
  // of them cannot pass.
  const root = scratchRoot('dshm-domain-ledger-')
  const store = root.projectFor('D:\\proj\\ledger')
  await save(store, 'dsh-keep', '保留的卡')
  await save(store, 'dsh-drop', '要删掉的卡')
  const curator = new MemoryCurator(null as never, root, console as never)
  const seen = new Map(store.list().map(card => [card.name, contentHash(cardFingerprint(card))]))
  const out = await (curator as unknown as {
    applyEdits(
      s: MemoryStore,
      u: unknown,
      seen: ReadonlyMap<string, string>,
    ): Promise<{ events: Array<Record<string, unknown>> }>
  }).applyEdits(store, { edits: [{ op: 'delete', topics: ['dsh-drop'] }] }, seen)
  assert.equal(out.events.length, 1)
  assert.equal(out.events[0]!.domain, 'dsh', 'the curator stamps the domain on the event')
  // What the curator's caller does with the events (see curator.ts runPass).
  root.recordLedgerBatch(out.events.map(event => ({ ...event, scope: 'proj', pass: 'curate' as const, session: 'abcd1234' })))

  const routes: Array<{ path: string, fetch(request: Request): Promise<Response> }> = []
  registerMemoryRoutes({
    register: (route: { path: string, fetch(request: Request): Promise<Response> }) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const route = routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/ledger`)
  assert.ok(route !== undefined)
  const response = await route.fetch(new Request(`https://localhost${route.path}`, { method: 'GET' }))
  const body = await response.json() as { value: { entries: Array<Record<string, unknown>> } }
  assert.equal(body.value.entries[0]?.domain, 'dsh', 'and the settings payload carries it')
  assert.deepEqual(body.value.entries[0]?.keys, ['dsh-drop'])
})

// --- D5: the curator's input (prompt shape) ------------------------------------

test('D5 serializeStore: every card section states its domain and its reference count', async () => {
  const store = scratchStore('dshm-domain-curate-')
  await save(store, 'dsh-version-pin', '内核钉在 v0.18.7，文件在 src/kernel/manager.ts:120。')
  await save(store, 'dsh-plain', '没有具体引用的陈述。')
  const { text } = serializeStore(store)
  assert.match(text, /### dsh-version-pin \[lesson\] \(updated \d{4}-\d{2}-\d{2}; domain dsh, refs [1-9]\d*\)/u)
  assert.match(text, /### dsh-plain \[lesson\] \(updated \d{4}-\d{2}-\d{2}; domain dsh, refs 0\)/u)
})

test('D5 buildCuratePrompt: the domain and reference rules reach the model', () => {
  const { system } = buildCuratePrompt('### dsh-a [lesson] (updated 2026-01-01; domain dsh, refs 0)\nbody')
  assert.match(system, /DOMAIN/u)
  assert.match(system, /refs > 0/u)
})

// --- T1: existing state and index compatibility --------------------------------

test('move: a declared domain follows the card into the target project', async () => {
  const root = scratchRoot('dshm-domain-move-')
  const source = root.projectFor('D:\\proj\\move-from')
  const targetCwd = 'D:\\proj\\move-to'
  // The target has to exist AND carry a stamp that walks back to its slug
  // (the move route's rule), which a single write is what creates.
  await save(root.projectFor(targetCwd), 'placeholder-note', 'target store exists')
  const target = root.moveTargetBySlug(projectSlug(targetCwd))
  assert.ok(target !== undefined, 'the stamped target is addressable')
  await save(source, 'dsh-plugin-install', 'body text here', { domain: 'desktop-shell' })
  assert.equal(await source.moveCardTo(target, 'dsh-plugin-install'), 'moved')
  // Without the field riding along, the card would be silently re-bucketed as
  // `dsh` — the same class of silent change the pin handling prevents.
  assert.equal(target.get('dsh-plugin-install')?.domain, 'desktop-shell')
})

test('curator/store: a rollback or a rename never loses nor invents a declared domain', async () => {
  // `null` in `upsert`'s domain argument exists for exactly this: a caller
  // restoring a snapshot whose card declared NOTHING must be able to say so,
  // instead of inheriting whatever the failed operation wrote.
  const store = scratchStore('dshm-domain-null-')
  await save(store, 'plain-card', '无声明域的正文')
  const inherited = await store.upsert({ name: 'plain-card', category: 'lesson', body: '无声明域的正文', domain: null })
  assert.equal(inherited.op, 'unchanged', 'null against an undeclared card is a no-op')
  await store.upsert({ name: 'plain-card', category: 'lesson', body: '无声明域的正文', domain: 'platform' })
  const cleared = await store.upsert({ name: 'plain-card', category: 'lesson', body: '无声明域的正文', domain: null })
  assert.equal(cleared.op, 'updated')
  assert.equal(cleared.card.domain, undefined, 'null clears a declaration')
  assert.equal(store.get('plain-card')?.domain, undefined)
})

test('forget: a key-shaped sweep stays on the exact-phrase rule the tool documents', async () => {
  // A hyphen is what splits one word into two tokens, so a key-shaped input
  // reaches the token-AND path by accident. On a READ that is a gain; on a
  // DELETE it is the difference between one card and every card that happens to
  // mention both words. Key-shaped input therefore keeps the historical rule.
  const store = scratchStore('dshm-domain-forget-')
  await save(store, 'dsh-config-cli', 'dsh config 的读取顺序')
  await save(store, 'dsh-plugin-config', 'dsh 的插件配置放在 config 目录下，顺序不固定')
  const result = await store.forget('dsh-config')
  assert.deepEqual(result.removed, ['dsh-config-cli'], 'only the card where the phrase really appears')
  assert.equal(store.list().length, 1)
  // A phrase that is NOT key-shaped gets the full matcher, which is what the
  // widening was for.
  const swept = await store.forget('配置 目录')
  assert.deepEqual(swept.removed, ['dsh-plugin-config'])
})

test('T1: a card written before the domain field reads back byte-identically', async () => {
  const dir = scratchDir('dshm-domain-legacy-')
  const store = new (await import('../src/memory-store.ts')).MemoryStore(dir)
  const legacy = [
    '---',
    'name: legacy-topic',
    'category: fact',
    'summary: 老卡',
    'created: 2025-12-01',
    'updated: 2025-12-02',
    '---',
    '',
    '老的正文',
    '',
  ].join('\n')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(store.storePath, { recursive: true })
  writeFileSync(join(store.storePath, 'legacy-topic.md'), legacy)

  const card = store.get('legacy-topic')
  assert.ok(card !== undefined)
  assert.equal(card.domain, undefined)
  assert.equal(renderCard(card), legacy, 'rendering an unchanged card reproduces its bytes')
  assert.deepEqual(domainOf(card), { key: 'legacy', src: 'inferred' })
})
