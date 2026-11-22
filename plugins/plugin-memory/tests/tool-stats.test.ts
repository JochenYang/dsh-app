/**
 * Call-site counting (M1 / M2), recoverable recall (R1), the forget narrowing
 * (P3), the duplicate pointer (K6), the creation source (P8), the per-store
 * fault isolation of `/status` and `/archive` (P10) and the new `/status` /
 * `/archive` fields — one group per plan work item, each named by the item it
 * pins. The counters themselves (`bumpToolStat`, the state file) are the
 * store's; what is asserted here is that every EXECUTION of a tool is counted
 * under the path the plan names, including the early exits, and that counting
 * never changes what the tool answers.
 *
 * @module @dsh-app/plugin-memory/tests/tool-stats
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderCard } from '../src/card-file.ts'
import {
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  MemoryRoot,
  SIM_DUPLICATE,
  SIM_RELATED,
  contentSimilarity,
  listProjects,
  projectSlug,
  type MemoryStore,
} from '../src/memory-store.ts'
import { ROUTE_PREFIX, registerMemoryRoutes } from '../src/routes.ts'
import { registerMemoryTools } from '../src/tools.ts'
import { scratchRoot } from './scratch.ts'

/** Minimal tool registrar capturing the definitions as they register (the
 *  shape tests/tools.test.ts uses). */
function stubCtx(): { ctx: never, tools: Map<string, unknown> } {
  const tools = new Map<string, unknown>()
  const ctx = {
    tools: {
      register(definition: { name: string }): () => void {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name: string): unknown {
      return name === 'agents' ? { get: () => ({ id: 'agent-1' }) } : undefined
    },
  }
  return { ctx: ctx as never, tools }
}

/** The workspace every workspace-bound call in this suite runs in. */
const CWD = 'D:\\proj-stats'

/** An attached agent whose session works in {@link CWD}. */
const EXEC = { agent: { id: 'session-49ce2455-aaaa', session: { header: { cwd: CWD } } } }

/** The same face for a session that was started WITHOUT a workspace. */
const EXEC_NO_CWD = { agent: { id: 'session-no-cwd', session: { header: {} } } }

/** An execution with no agent attached at all. */
const EXEC_NO_AGENT = {}

interface SaveResult {
  saved?: boolean
  op?: string
  reason?: string
  topic?: string
  existing?: string
  existingCard?: { topic: string, body: string, pinned?: boolean, withheld?: boolean }
  related?: string[]
  code?: string
  category?: string
  field?: string
  domain?: { key: string, cards: number, summaries: string[] }
}

interface RecallView {
  found?: boolean
  topic?: string
  card?: { topic: string, body: string, summary?: string, withheld?: boolean }
  cards?: Array<{ topic: string, body?: string, withheld?: boolean }>
  candidates?: string[]
  fallback?: boolean
  relaxed?: boolean
  query?: string
  total?: number
  matched?: number
  truncated?: boolean
}

interface ForgetResult {
  forgotten?: number
  reason?: string
  code?: string
  scopes?: Record<string, { forgotten: number, remaining: number, removed: string[] }>
  failed?: string[]
}

type Execute<T> = (args: unknown, exec: unknown) => Promise<T>

const saveTool = (tools: Map<string, unknown>): Execute<SaveResult> =>
  (tools.get('memory_save') as { execute: Execute<SaveResult> }).execute

const recallTool = (tools: Map<string, unknown>): Execute<{ project?: RecallView, reason?: string, code?: string }> =>
  (tools.get('memory_recall') as { execute: Execute<{ project?: RecallView }> }).execute

const forgetTool = (tools: Map<string, unknown>): Execute<ForgetResult> =>
  (tools.get('memory_forget') as { execute: Execute<ForgetResult> }).execute

const SAVE_ARGS = { topic: 'stats-probe', category: 'preference', summary: '统计探针', content: 'stats probe body' }

// --- M1 / M2: memory_save -----------------------------------------------------------------

test('M1: memory_save counts created / updated / unchanged', async () => {
  const root = scratchRoot('dshm-stats-save-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  const created = await save(SAVE_ARGS, EXEC)
  assert.equal(created.op, 'created')
  const updated = await save({ ...SAVE_ARGS, content: 'revised stats probe body' }, EXEC)
  assert.equal(updated.op, 'updated')
  const noop = await save({ ...SAVE_ARGS, content: 'revised stats probe body' }, EXEC)
  assert.equal(noop.op, 'unchanged')

  const { save: counts } = root.toolStats()
  assert.equal(counts.created, 1)
  assert.equal(counts.updated, 1)
  assert.equal(counts.unchanged, 1)
  assert.deepEqual(counts.refused, {}, 'a successful run refuses nothing')
})

test('M1: memory_save counts every refusal under its stable code, early exits included', async () => {
  const root = scratchRoot('dshm-stats-refusals-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)
  const refused = async (args: Record<string, unknown>, exec: unknown = EXEC): Promise<void> => {
    const result = await save(args, exec)
    assert.equal(result.saved, false, `${String(args.topic)}: the call is refused`)
  }

  await refused({ ...SAVE_ARGS, topic: 'too-long', content: 'x'.repeat(MAX_TOPIC_BODY_CHARS + 1) })
  await refused({ ...SAVE_ARGS, topic: 'long-summary', summary: 's'.repeat(MAX_SUMMARY_CHARS + 1) })
  await refused({ ...SAVE_ARGS, topic: 'creds', content: 'api_key: sk-abc123def456ghi7' })
  await refused({ ...SAVE_ARGS, topic: '中文主题' })
  await refused({ ...SAVE_ARGS, topic: 'blank', content: '   ' })
  // (`category` is an enum, so an out-of-enum value is refused by the tool
  // framework BEFORE execute — the tool's own `unknown-category` guard is
  // unreachable through the public surface and is not exercised here.)
  await refused({ ...SAVE_ARGS, topic: 'domain', domain: '这是一个纯中文的域名' })
  await refused({ ...SAVE_ARGS, topic: 'no-summary', summary: '' })
  await refused({ ...SAVE_ARGS, scope: 'global' })
  await refused({ ...SAVE_ARGS, topic: 'no-cwd' }, EXEC_NO_CWD)
  root.global.setEnabled(false)
  await refused({ ...SAVE_ARGS, topic: 'disabled' })
  root.global.setEnabled(true)

  assert.deepEqual(root.toolStats().save.refused, {
    'content-too-long': 1,
    'summary-too-long': 1,
    'named-secret': 1,
    'invalid-topic': 1,
    'empty-content': 1,
    'invalid-domain': 1,
    'invalid-input': 1,
    'scope-removed': 1,
    'no-workspace': 1,
    disabled: 1,
  })
  assert.equal(root.projectFor(CWD).list().length, 0, 'and none of them wrote a card')
})

test('M2: the similarity gate counts a hard rejection and a related hint', async () => {
  const root = scratchRoot('dshm-stats-gate-')
  const store = root.projectFor(CWD)
  const original = 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效'
  const reworded = 'pnpm 11 的白名单需要写进 pnpm-workspace.yaml 才会生效'
  await store.upsert({ name: 'pnpm11-allowscripts', category: 'lesson', summary: 'pnpm 11 白名单', body: original })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  const duplicate = await save({ ...SAVE_ARGS, topic: 'pnpm-workspace-yaml', content: original }, EXEC)
  assert.equal(duplicate.saved, false)
  const related = await save({ ...SAVE_ARGS, topic: 'pnpm-allowlist-rule', content: reworded }, EXEC)
  assert.equal(related.saved, true)
  // The precondition that makes the second assertion mean what it says: the
  // reworded text sits in the related band, not above or below it.
  const score = contentSimilarity(reworded, `pnpm 11 白名单 ${original}`)
  assert.ok(score >= SIM_RELATED && score < SIM_DUPLICATE, `the reworded pair scores ${String(score)} — inside the related band`)

  const { gate } = root.toolStats()
  assert.equal(gate.duplicate, 1)
  assert.equal(gate.related, 1)
  assert.deepEqual(related.related, ['pnpm11-allowscripts'], 'the hint itself still rides the answer')
})

test('M1: counting never changes what the tool answers', async () => {
  const root = scratchRoot('dshm-stats-inert-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  // The store already swallows an I/O failure; what is left to prove is that
  // a counter that THROWS (an unknown path, a disk the store could not guard
  // against) does not turn a finished save into an error for the model.
  root.bumpToolStat = () => { throw new Error('counter unavailable') }

  const save = saveTool(tools)
  const result = await save(SAVE_ARGS, EXEC)
  assert.equal(result.saved, true)
  assert.equal(result.op, 'created')
  assert.equal(root.projectFor(CWD).get('stats-probe')?.body, 'stats probe body', 'the card landed')

  const recall = recallTool(tools)
  assert.equal((await recall({ topic: 'stats-probe' }, EXEC)).project?.found, true)
  const forget = forgetTool(tools)
  assert.equal((await forget({ match: 'stats-probe' }, EXEC)).forgotten, 1)
})

// --- M1: memory_recall ------------------------------------------------------------------------

test('M1: memory_recall counts topic / query / list, the misses and the early exits', async () => {
  const root = scratchRoot('dshm-stats-recall-')
  await root.projectFor(CWD).upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  assert.equal((await recall({ topic: 'pnpm-typecheck' }, EXEC)).project?.found, true)
  // No card mentions these words, so the fallback search is empty too.
  const miss = await recall({ topic: 'zzz-nothing-here' }, EXEC)
  assert.equal(miss.project?.found, false)
  assert.equal((await recall({ query: 'pnpm' }, EXEC)).project?.matched, 1)
  assert.equal((await recall({}, EXEC)).project?.total, 1)

  // Early exits (the store is never asked): each is a REFUSAL, booked apart
  // from the recalls that reached the store and found nothing.
  assert.equal((await recall({ scope: 'global' }, EXEC)).code, 'scope-global-removed')
  assert.equal((await recall({}, EXEC_NO_CWD)).code, 'no-workspace')
  root.global.setEnabled(false)
  assert.equal((await recall({}, EXEC)).reason, 'disabled')
  root.global.setEnabled(true)

  assert.deepEqual(root.toolStats().recall, {
    topic: 2, query: 1, list: 1, empty: 1, fallback: 1, relaxed: 0, refused: 3,
    // The topic hit and the one-card query each carried exactly one card.
    hits: { one: 2, few: 0, many: 0 },
  })
})

test('M1: the size of a recall answer lands in its bucket, and a refusal is not a miss', async () => {
  const root = scratchRoot('dshm-stats-recall-hits-')
  const store = root.projectFor(CWD)
  for (let i = 0; i < 7; i += 1) {
    await store.upsert({ name: `server-${String(i)}`, category: 'fact', summary: `服务器 ${String(i)}`, body: `服务器在大阪 ${String(i)}` })
  }
  for (let j = 0; j < 3; j += 1) {
    await store.upsert({ name: `tool-${String(j)}`, category: 'fact', summary: `工具 ${String(j)}`, body: `常用工具 ${String(j)}` })
  }
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  assert.equal((await recall({ query: '大阪 3' }, EXEC)).project?.matched, 1)
  assert.equal((await recall({ query: '大阪 5' }, EXEC)).project?.matched, 1)
  assert.equal((await recall({ query: '工具 1' }, EXEC)).project?.matched, 1)
  assert.equal((await recall({ query: '工具' }, EXEC)).project?.matched, 3)
  assert.equal((await recall({ query: '大阪' }, EXEC)).project?.matched, 7)
  assert.equal((await recall({ query: 'zzz-nothing' }, EXEC)).project?.matched, 0)
  await recall({}, EXEC_NO_CWD)
  await recall({}, EXEC_NO_CWD)

  const { recall: counts } = root.toolStats()
  assert.deepEqual(counts.hits, { one: 3, few: 1, many: 1 })
  assert.equal(counts.empty, 1, 'only the search that found nothing is a miss')
  assert.equal(counts.relaxed, 0, 'and that one found nothing on the wider try either')
  assert.equal(counts.refused, 2, 'the two refusals are not misses')
})

// --- M1: memory_forget ------------------------------------------------------------------------

test('M1: memory_forget counts key deletes, text sweeps and the cards removed', async () => {
  const root = scratchRoot('dshm-stats-forget-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'tokyo-servers', category: 'fact', summary: '东京服务器', body: '服务器在东京' })
  await store.upsert({ name: 'osaka-servers', category: 'fact', summary: '大阪服务器', body: '服务器在大阪' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = forgetTool(tools)

  assert.equal((await forget({ match: 'tokyo-servers' }, EXEC)).forgotten, 1)
  assert.equal((await forget({ match: '服务器', sweep: 'text' }, EXEC)).forgotten, 1)
  // A free-text match without the confirmation is refused: nothing removed,
  // and (until a `forget.refused` counter exists) counted under the mode its
  // shape asks for.
  assert.equal((await forget({ match: '服务器' }, EXEC)).forgotten, 0)
  assert.equal((await forget({ match: 'anything' }, EXEC_NO_CWD)).code, 'no-workspace')

  assert.deepEqual(root.toolStats().forget, { byTopic: 2, byText: 2, removed: 2 })
  assert.equal(store.list().length, 0)
})

// --- R1: recoverable recall ----------------------------------------------------------------------

test('R1: a topic key that names no card falls back to a keyword search (T11)', async () => {
  const root = scratchRoot('dshm-stats-fallback-')
  await root.projectFor(CWD).upsert({ name: 'deck-export', category: 'lesson', summary: 'deck export steps', body: '导出前先清理临时目录' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  const result = await recall({ topic: 'export' }, EXEC)
  assert.equal(result.project?.found, true, 'a recovered card is returned as a found one')
  assert.equal(result.project?.fallback, true, 'and says it came from the fallback')
  assert.equal(result.project?.topic, 'export', 'the key that was asked for stays on the answer')
  assert.equal(result.project?.card?.topic, 'deck-export', 'under its own key')
  assert.deepEqual(result.project?.candidates, ['deck-export'])
  assert.equal(root.toolStats().recall.fallback, 1)
})

test('R1: several fallback hits come back as cards with at most five candidate keys', async () => {
  const root = scratchRoot('dshm-stats-fallback-many-')
  const store = root.projectFor(CWD)
  for (let i = 0; i < 6; i += 1) {
    await store.upsert({ name: `deck-export-${String(i)}`, category: 'fact', summary: `export note ${String(i)}`, body: `导出备注 ${String(i)}` })
  }
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  const result = await recall({ topic: 'export-note' }, EXEC)
  assert.equal(result.project?.fallback, true)
  assert.equal(result.project?.card, undefined, 'a list is not dressed up as one card')
  assert.equal(result.project?.cards?.length, 5)
  assert.equal(result.project?.candidates?.length, 5)
  assert.deepEqual(result.project?.candidates, result.project?.cards?.map(card => card.topic), 'every candidate key names a returned card')
  assert.equal(result.project?.matched, 6, 'the wider count says the list was narrowed')
  assert.equal(result.project?.truncated, true)
  assert.equal(result.project?.total, 6)
})

test('R1: a topic miss with nothing to fall back on stays found:false', async () => {
  const root = scratchRoot('dshm-stats-fallback-none-')
  await root.projectFor(CWD).upsert({ name: 'deck-export', category: 'lesson', summary: 'deck export steps', body: '导出前先清理临时目录' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  const result = await recall({ topic: 'zzz-nothing-here' }, EXEC)
  assert.deepEqual(result.project, { found: false, topic: 'zzz-nothing-here' })
  const { recall: counts } = root.toolStats()
  assert.equal(counts.topic, 1)
  assert.equal(counts.fallback, 1, 'the search still ran')
  assert.equal(counts.empty, 1, 'and the call still came back with nothing')
})

test('R1: an empty query drops its last word once and reports relaxed (T12)', async () => {
  const root = scratchRoot('dshm-stats-relaxed-')
  await root.projectFor(CWD).upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  const result = await recall({ query: 'pnpm typecheck zzz' }, EXEC)
  assert.equal(result.project?.relaxed, true)
  assert.equal(result.project?.query, 'pnpm typecheck zzz', 'the ORIGINAL query rides the answer')
  assert.equal(result.project?.matched, 1)
  assert.deepEqual(result.project?.cards?.map(card => card.topic), ['pnpm-typecheck'])
  assert.equal(root.toolStats().recall.relaxed, 1)
  assert.equal(root.toolStats().recall.query, 1)
  assert.equal(root.toolStats().recall.empty, 0)
})

test('R1: a one-word query is not relaxed, and an unrecoverable query stays empty', async () => {
  const root = scratchRoot('dshm-stats-relaxed-none-')
  await root.projectFor(CWD).upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  const single = await recall({ query: 'zzz' }, EXEC)
  assert.equal(single.project?.relaxed, undefined, 'nothing to drop')
  assert.deepEqual(single.project?.cards, [])
  // Neither word appears, so dropping the second one does not help either.
  const unrecoverable = await recall({ query: 'qqq zzz' }, EXEC)
  assert.equal(unrecoverable.project?.relaxed, undefined, 'the retry missed too, so it is not reported as a relaxation')
  assert.deepEqual(unrecoverable.project?.cards, [])
  const { recall: counts } = root.toolStats()
  assert.equal(counts.query, 2)
  assert.equal(counts.relaxed, 0)
  assert.equal(counts.empty, 2)
})

test('V7: the recall description frames results as background, not instructions', () => {
  const root = scratchRoot('dshm-stats-v7-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const description = (tools.get('memory_recall') as { description: string }).description
  assert.match(description, /snapshot/u)
  assert.match(description, /background material/u)
  assert.match(description, /not\s+instructions/u)
})

// --- P3: forget deletes by key, sweeps only on confirmation --------------------------------------

test('P3: memory_forget refuses free text without sweep "text" and deletes nothing', async () => {
  const root = scratchRoot('dshm-stats-sweep-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'tokyo-servers', category: 'fact', summary: '东京服务器', body: '服务器在东京' })
  await store.upsert({ name: 'osaka-servers', category: 'fact', summary: '大阪服务器', body: '服务器在大阪' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = forgetTool(tools)

  const refused = await forget({ match: '服务器' }, EXEC)
  assert.equal(refused.forgotten, 0)
  assert.equal(refused.code, 'sweep-not-confirmed')
  assert.match(refused.reason ?? '', /sweep/, 'the refusal says how to enable the sweep')
  assert.equal(store.list().length, 2, 'nothing was swept')

  const confirmed = await forget({ match: '服务器', sweep: 'text' }, EXEC)
  assert.equal(confirmed.forgotten, 2, 'the explicit confirmation still sweeps')
})

test('P3: memory_forget deletes a topic key by key only — an absent key sweeps nothing', async () => {
  const root = scratchRoot('dshm-stats-bykey-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'dsh-config-pitfall', category: 'lesson', summary: 'dsh-config 的坑', body: 'dsh-config 写错会导致启动失败' })
  await store.upsert({ name: 'unrelated', category: 'fact', summary: '无关', body: '别动我' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = forgetTool(tools)

  // `dsh-config` is a well-formed key that names no card. Every card whose
  // text mentions it would have been swept by the exact-phrase rule.
  const absent = await forget({ match: 'dsh-config' }, EXEC)
  assert.equal(absent.forgotten, 0)
  assert.equal(absent.scopes?.project.removed.length, 0)
  assert.equal(store.list().length, 2, 'an absent key deletes nothing else either')

  const present = await forget({ match: 'dsh-config-pitfall' }, EXEC)
  assert.equal(present.forgotten, 1)
  assert.deepEqual(present.scopes?.project.removed, ['dsh-config-pitfall'])
  assert.equal(store.get('unrelated')?.body, '别动我')
})

test('P3: POST /forget accepts only a topic key that names a card', async () => {
  const routes: Array<{ path: string, fetch(request: Request): Promise<Response> }> = []
  const root = scratchRoot('dshm-stats-route-forget-')
  const dispose = registerMemoryRoutes({
    register: (route: { path: string, fetch(request: Request): Promise<Response> }) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const cwd = 'D:/codes/ForgetByKey'
  const store = root.projectFor(cwd)
  await store.upsert({ name: 'deck-export', category: 'lesson', summary: '导出', body: 'export 之前先清理' })
  await store.upsert({ name: 'bystander', category: 'fact', summary: '旁观卡', body: '提到了 export 这个词' })
  const slug = projectSlug(cwd)
  const call = async (match: unknown): Promise<{ status: number, code: string | undefined }> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/forget`)
    assert.ok(route !== undefined, 'the forget route is registered')
    const response = await route.fetch(new Request(`https://localhost${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'project', slug, match }),
    }))
    const body = await response.json() as { error?: { host: { code: string } } }
    return { status: response.status, code: body.error?.host.code }
  }

  // A one-letter "key" is well-formed, so the shape check lets it through —
  // and the store would have swept every card containing an "e". No card has
  // that key, so the route refuses instead.
  const stray = await call('e')
  assert.equal(stray.status, 400)
  assert.equal(stray.code, 'route.topicUnknown')
  const freeText = await call('export')
  assert.equal(freeText.status, 400, 'a word that matches by content is not a key')
  assert.equal(freeText.code, 'route.topicUnknown')
  const malformed = await call('not a topic key')
  assert.equal(malformed.status, 400)
  assert.equal(malformed.code, 'route.topicInvalid')
  assert.equal(store.list().length, 2, 'no refused call deleted anything')

  const deleted = await call('deck-export')
  assert.equal(deleted.status, 200)
  assert.equal(store.get('deck-export'), undefined)
  assert.equal(store.get('bystander')?.body, '提到了 export 这个词', 'the card that merely matched the text survives')
})

// --- K6: the duplicate pointer carries the card --------------------------------------------------

test('K6: a duplicate-of refusal carries the existing card', async () => {
  const root = scratchRoot('dshm-stats-k6-')
  const store = root.projectFor(CWD)
  const body = 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效'
  await store.upsert({ name: 'pnpm11-allowscripts', category: 'lesson', summary: 'pnpm 11 白名单', body })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  const refused = await save({ ...SAVE_ARGS, topic: 'pnpm-workspace-yaml', content: body }, EXEC)
  assert.equal(refused.saved, false)
  assert.equal(refused.existing, 'pnpm11-allowscripts', 'the pointer still names the key')
  assert.equal(refused.existingCard?.topic, 'pnpm11-allowscripts')
  assert.equal(refused.existingCard?.body, body, 'the card itself rides the answer')
  assert.equal(refused.existingCard?.pinned, false)
  assert.match(refused.reason ?? '', /compare/iu)
  assert.match(refused.reason ?? '', /drop this save/iu, 'and says giving up is an option')
})

// --- P8: the creation source --------------------------------------------------------------------------

test('P8: a created card carries the creating session; an update carries none', async () => {
  const root = scratchRoot('dshm-stats-source-')
  const store = root.projectFor(CWD)
  const upserts: Array<{ source?: string }> = []
  const real = store.upsert.bind(store)
  store.upsert = async (input: Parameters<MemoryStore['upsert']>[0]) => {
    upserts.push(input)
    return real(input)
  }
  root.projectFor = () => store
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  await save(SAVE_ARGS, EXEC)
  await save({ ...SAVE_ARGS, content: 'revised stats probe body' }, { agent: { id: 'session-aaaa1111-bbbb', session: { header: { cwd: CWD } } } })
  // No agent attached means no workspace either (the cwd rides the agent), so
  // such a call is refused before it could ever create a card: the guard on
  // `exec.agent` is a type narrowing, not a reachable path.
  const noAgent = await save({ ...SAVE_ARGS, topic: 'no-agent' }, EXEC_NO_AGENT)
  assert.equal(noAgent.code, 'no-workspace')

  assert.equal(upserts.length, 2)
  assert.equal(upserts[0]?.source, '49ce2455', 'the CREATE names its session, shortened')
  assert.equal(upserts[1]?.source, undefined, 'an update passes none, so the store keeps the first value')
})

// --- P10 + /status + /archive: the routes ----------------------------------------------------------------

interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

function routes(root: MemoryRoot): { list: RegisteredRoute[], dispose: () => Promise<void> } {
  const list: RegisteredRoute[] = []
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      list.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  return { list, dispose }
}

const call = async (list: RegisteredRoute[], name: string, init?: RequestInit): Promise<Response> => {
  const route = list.find(entry => entry.path === `${ROUTE_PREFIX}/${name}`)
  assert.ok(route !== undefined, `${name} route is registered`)
  return route.fetch(new Request(`https://localhost${route.path}`, init))
}

test('P10: a store whose topics/ is a plain file degrades /status to one error row (T28)', async () => {
  const root = scratchRoot('dshm-stats-badstore-')
  const healthyCwd = 'D:/codes/HealthyStore'
  const store = root.projectFor(healthyCwd)
  await store.upsert({ name: 'live-card', category: 'lesson', summary: '活卡', body: '还在的内容' })
  await store.upsert({ name: 'gone-card', category: 'lesson', summary: '删掉的卡', body: '归档里的内容' })
  await store.forget('gone-card')
  const brokenCwd = 'D:/codes/BrokenStore'
  const brokenSlug = projectSlug(brokenCwd)
  const brokenDir = join(root.dir, 'projects', brokenSlug)
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'project.json'), `${JSON.stringify({ cwd: brokenCwd })}\n`, 'utf8')
  // The store's cards are about to become unreadable, but its UNDO COPIES
  // stay readable — and those are the only way back to them. Give it one
  // the way a deletion does, without ever creating a `topics/` directory.
  mkdirSync(join(brokenDir, 'archive', '2001-01-01'), { recursive: true })
  writeFileSync(join(brokenDir, 'archive', '2001-01-01', 'broken-gone.md'), renderCard({
    name: 'broken-gone', category: 'lesson', summary: '坏库里的卡', created: '2001-01-01', updated: '2001-01-01', body: '还能恢复的内容', malformed: false,
  }), 'utf8')
  // The shape of a store nobody can list: a FILE where `topics/` must be a
  // directory (ENOTDIR on readdir). `listProjects` used to throw on it and
  // take the whole page down.
  writeFileSync(join(brokenDir, 'topics'), 'not a directory', 'utf8')
  const { list, dispose } = routes(root)

  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (message: unknown) => { warnings.push(String(message)) }
  try {
    const response = await call(list, 'status', { method: 'GET' })
    assert.equal(response.status, 200, 'one broken store does not fail the page')
    const body = await response.json() as { value: { projects: Array<{ slug: string, cards: number, error?: string, movable: boolean }> } }
    const healthy = body.value.projects.find(row => row.slug === projectSlug(healthyCwd))
    assert.equal(healthy?.cards, 1, 'the healthy store is summarized as usual')
    assert.equal(healthy?.error, undefined)
    const broken = body.value.projects.find(row => row.slug === brokenSlug)
    assert.ok(broken !== undefined, 'the broken store is still listed')
    assert.match(broken.error ?? '', /topics/u, 'with the reason it could not be read')
    assert.equal(broken.cards, 0)
    assert.equal(broken.movable, false, 'a store that cannot be read must not receive a moved card')
    assert.ok(warnings.some(line => line.includes(brokenSlug)), 'and the failure is logged by slug')

    const archive = await call(list, 'archive', { method: 'GET' })
    assert.equal(archive.status, 200)
    const archived = await archive.json() as { value: { cards: Array<{ topic: string, slug: string }> } }
    assert.deepEqual(archived.value.cards.map(card => card.topic).sort(), ['broken-gone', 'gone-card'],
      'both stores\u2019 undo copies are listed — the unreadable store\u2019s above all')
  } finally {
    console.warn = realWarn
    await dispose()
  }
})

test('P10: on a healthy root /status rows equal the strict listing and carry no degradation key', async () => {
  const root = scratchRoot('dshm-stats-mirror-')
  for (const cwd of ['D:/codes/MirrorA', 'D:/codes/MirrorB']) {
    await root.projectFor(cwd).upsert({ name: 'card', category: 'lesson', summary: '镜像', body: `内容 ${cwd}` })
  }
  const { list, dispose } = routes(root)
  const response = await call(list, 'status', { method: 'GET' })
  const body = await response.json() as { value: { projects: Array<Record<string, unknown>> } }
  assert.deepEqual(body.value.projects, listProjects(root.dir), 'the page and the strict walk agree on a healthy root')
  for (const row of body.value.projects) {
    assert.equal('error' in row, false)
    assert.equal('configUnreadable' in row, false)
  }
  await dispose()
})

test('/status serves the tool counters after the first counted call, and the archive-failure list', async () => {
  const root = scratchRoot('dshm-stats-status-')
  const { list, dispose } = routes(root)
  const read = async (): Promise<Record<string, unknown>> => {
    const response = await call(list, 'status', { method: 'GET' })
    assert.equal(response.status, 200)
    return (await response.json() as { value: Record<string, unknown> }).value
  }

  // Before anything was counted the field is ABSENT, not four zeroes: a state
  // file written before counting existed must read as "not measured".
  const before = await read()
  assert.equal('toolStats' in before, false)
  assert.deepEqual(before.archiveFailures, [])
  assert.equal(before.configUnreadable, false, 'a boolean, so the page can test it without a key check')

  root.bumpToolStat('save.created')
  root.bumpToolStat('recall.empty')
  const after = await read()
  assert.deepEqual(after.toolStats, root.toolStats())
  assert.equal((after.toolStats as { save: { created: number } }).save.created, 1)

  root.recordArchiveFailure('proj-aaaaaaaa', 'card', 'EACCES: archive/ is read-only')
  assert.deepEqual(after.archiveFailures, [], 'read earlier — before the failure was recorded')
  assert.equal(((await read()).archiveFailures as unknown[]).length, 1)
  await dispose()
})

test('/archive reports the newest persisted archive failure of the stores it lists', async () => {
  const root = scratchRoot('dshm-stats-archive-error-')
  const cwdA = 'D:/codes/ArchiveFailed'
  const cwdB = 'D:/codes/ArchiveFine'
  await root.projectFor(cwdA).upsert({ name: 'card-a', category: 'lesson', summary: 'a', body: 'a' })
  await root.projectFor(cwdB).upsert({ name: 'card-b', category: 'lesson', summary: 'b', body: 'b' })
  const slugA = projectSlug(cwdA)
  const slugB = projectSlug(cwdB)
  root.recordArchiveFailure(slugA, 'older', 'EBUSY: first failure')
  root.recordArchiveFailure(slugA, 'newer', 'EACCES: latest failure')
  const { list, dispose } = routes(root)

  const every = await call(list, 'archive', { method: 'GET' })
  const everyBody = await every.json() as { value: { archiveError?: string, archiveErrorSlug?: string } }
  assert.equal(everyBody.value.archiveError, 'EACCES: latest failure', 'the newest row for the store, not the oldest')
  assert.equal(everyBody.value.archiveErrorSlug, slugA)

  const route = list.find(entry => entry.path === `${ROUTE_PREFIX}/archive`)
  assert.ok(route !== undefined)
  const fine = await route.fetch(new Request(`https://localhost${ROUTE_PREFIX}/archive?scope=project&slug=${slugB}`, { method: 'GET' }))
  const fineBody = await fine.json() as { value: { archiveError?: string } }
  assert.equal(fineBody.value.archiveError, undefined, 'a store that never failed does not inherit another one\'s error')
  await dispose()
})

// --- what the second review of this change set found (2026-11-22) -------------------------------

/** A card written straight to disk, the way a hand edit or a sync would: the
 *  write path's validation never sees it. */
function handWrite(store: MemoryStore, name: string, fields: Record<string, string>, body: string): void {
  mkdirSync(join(store.dir, 'topics'), { recursive: true })
  const lines = ['---', `name: ${name}`, `category: ${fields.category ?? 'lesson'}`, `summary: ${fields.summary ?? name}`]
  if (fields.domain !== undefined) lines.push(`domain: ${fields.domain}`)
  lines.push(`created: ${fields.created ?? '2026-11-04'}`, `updated: ${fields.updated ?? '2026-11-04'}`, '---', '', body, '')
  writeFileSync(join(store.dir, 'topics', `${name}.md`), lines.join('\n'), 'utf8')
}

test('P7: memory_recall and the duplicate pointer answer a credential-looking card withheld', async () => {
  const root = scratchRoot('dshm-stats-recall-shield-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'clean-card', category: 'lesson', summary: '干净的卡', body: '干净的内容' })
  const secret = `sk-${'q7Zm4Xp2Lb9Rt6Kw'}`
  handWrite(store, 'leaky-card', { summary: 'deploy' }, `DEPLOYNOTE the key is ${secret}`)
  // The secret in the SUMMARY only: the body is clean, so a save of the same
  // body passes the tool's own check and meets the duplicate gate.
  handWrite(store, 'leaky-summary', { summary: 'token: abcdef1234567890' }, '导出前先清理临时目录')
  await store.reindex()
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = recallTool(tools)

  const byTopic = await recall({ topic: 'leaky-card' }, EXEC)
  assert.equal(byTopic.project?.found, true, 'the card is still reachable — its key, class and date are the point')
  assert.equal(byTopic.project?.card?.topic, 'leaky-card')
  assert.equal(byTopic.project?.card?.withheld, true)
  assert.ok(!JSON.stringify(byTopic).includes(secret) && !JSON.stringify(byTopic).includes('DEPLOYNOTE'),
    'its text never reaches the model: the injection shield is not one recall away from moot')

  const listed = await recall({}, EXEC)
  const rows = listed.project?.cards ?? []
  assert.equal(rows.find(row => row.topic === 'leaky-card')?.withheld, true, 'a list answer withholds it too')
  assert.equal(rows.find(row => row.topic === 'leaky-summary')?.withheld, true)
  assert.equal(rows.find(row => row.topic === 'clean-card')?.body, '干净的内容', 'a clean card is untouched')

  // K6's pointer rides the same view. A save whose body is a NEAR-duplicate of
  // a withheld card's body — near enough for the gate, different in the one
  // place that carried the secret, so the save itself breaks no rule.
  const filler = '部署流水线的检查顺序是先跑类型检查再跑单元测试最后才打包，任何一步失败都不要继续往下走，回滚到上一个稳定版本并通知值班的同事来处理后续问题，同时把失败的日志归档到当天的目录里方便复盘。'
    + '打包阶段还要校验产物的签名与版本号，签名不匹配时一律视为失败而不是警告；发布窗口之外不允许触发生产环境的流水线，Hotfix 除外，而 Hotfix 也必须走同样的检查并补一份事后说明。'
  handWrite(store, 'leaky-body', { summary: 'deploy key' }, `${filler} the deploy key is ${secret} for the runner`)
  const near = await saveTool(tools)({ ...SAVE_ARGS, topic: 'deploy-copy', summary: 'deploy', content: `${filler} the deploy key is rotated-every-week for the runner` }, EXEC)
  assert.equal(near.saved, false, 'the gate still refuses the near-duplicate')
  assert.equal(near.existing, 'leaky-body')
  assert.equal(near.existingCard?.withheld, true, 'and the card it points at comes back withheld')
  assert.equal(JSON.stringify(near).includes(secret), false)
})

test('P7: the domain context of a save does not quote a withheld sibling', async () => {
  const root = scratchRoot('dshm-stats-domain-shield-')
  const store = root.projectFor(CWD)
  // Same domain as the card about to be saved (the key's first segment), with
  // a credential in the summary — the field the context quotes.
  handWrite(store, 'dsh-leaky', { summary: 'token: abcdef1234567890' }, '同域的一张卡')
  await store.reindex()
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const saved = await saveTool(tools)({ ...SAVE_ARGS, topic: 'dsh-clean', summary: 'dsh 的干净卡', content: 'dsh 的干净正文' }, EXEC)
  assert.equal(saved.saved, true)
  assert.equal(saved.domain?.key, 'dsh')
  assert.equal(saved.domain?.cards, 2, 'the count keeps the withheld sibling: the cap decision needs it')
  assert.deepEqual(saved.domain?.summaries, ['dsh 的干净卡'], 'the quotes do not')
})

test('P9: a credential refusal names its code, the rule that matched and the field (T27)', async () => {
  const root = scratchRoot('dshm-stats-cred-code-')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  const byBody = await save({ ...SAVE_ARGS, topic: 'named', content: 'the password: hunter2 hunter2' }, EXEC)
  assert.equal(byBody.saved, false)
  assert.equal(byBody.code, 'credential-refused')
  assert.equal(byBody.category, 'named-secret')
  assert.equal(byBody.field, 'content')
  const bySummary = await save({ ...SAVE_ARGS, topic: 'summary', summary: 'token: abcdef1234567890', content: 'a clean body' }, EXEC)
  assert.equal(bySummary.code, 'credential-refused')
  assert.equal(bySummary.category, 'named-secret')
  assert.equal(bySummary.field, 'summary')
  const vendor = await save({ ...SAVE_ARGS, topic: 'vendor', content: 'the key is sk-proj-abcdefghijklmnop' }, EXEC)
  assert.equal(vendor.category, 'token-prefix')

  // The answer's category IS the counter key: a reader of one can find the other.
  assert.equal(root.toolStats().save.refused['named-secret'], 2)
  assert.equal(root.toolStats().save.refused['token-prefix'], 1)
})

test('P3: a key-shaped word that names no card sweeps when the sweep is confirmed', async () => {
  const root = scratchRoot('dshm-stats-keyword-sweep-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'pnpm-workspace', category: 'lesson', summary: 'pnpm 白名单', body: 'pnpm 11 的白名单写在 workspace 文件里' })
  await store.upsert({ name: 'unrelated', category: 'fact', summary: '无关', body: '别动我' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = forgetTool(tools)

  // `pnpm` is a valid key shape. Without the confirmation it is answered as an
  // absent key, and nothing is swept.
  const unconfirmed = await forget({ match: 'pnpm' }, EXEC)
  assert.equal(unconfirmed.forgotten, 0)
  assert.match(unconfirmed.reason ?? '', /sweep/u)
  assert.equal(store.list().length, 2)
  // With it, the word is the text it always was. This used to be a dead end:
  // the answer told the model to pass sweep: "text" and then ignored it.
  const confirmed = await forget({ match: 'pnpm', sweep: 'text' }, EXEC)
  assert.equal(confirmed.forgotten, 1)
  assert.deepEqual(confirmed.scopes?.project.removed, ['pnpm-workspace'])
  assert.equal(store.get('unrelated')?.body, '别动我')
  // A key that NAMES a card is deleted by key, whatever `sweep` says.
  await store.upsert({ name: 'docker', category: 'fact', summary: 'docker', body: '容器' })
  const byKey = await forget({ match: 'docker', sweep: 'text' }, EXEC)
  assert.deepEqual(byKey.scopes?.project.removed, ['docker'])
})

test('P8: a forget ledger row names the session; a session id the card cannot admit costs nothing', async () => {
  const root = scratchRoot('dshm-stats-ledger-session-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'doomed', category: 'fact', summary: '要删的卡', body: '内容' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  assert.equal((await forgetTool(tools)({ match: 'doomed' }, EXEC)).forgotten, 1)
  const row = root.ledgerEntries().find(entry => entry.keys[0] === 'doomed')
  assert.equal(row?.pass, 'forget')
  assert.equal(row?.session, '49ce2455', 'the session whose call removed it')

  // The settings page's delete names no session: there the user is the actor.
  await store.upsert({ name: 'second', category: 'fact', summary: '第二张', body: '内容' })
  await store.forget('second')
  assert.equal(root.ledgerEntries().find(entry => entry.keys[0] === 'second')?.session, undefined)

  // A session id whose short form is not the shape a card admits is DROPPED.
  // It used to refuse every save of that session with "invalid source".
  const oddExec = { agent: { id: 'session-ab/cdef-1234', session: { header: { cwd: CWD } } } }
  const saved = await saveTool(tools)({ ...SAVE_ARGS, topic: 'odd-session' }, oddExec)
  assert.equal(saved.saved, true)
  assert.equal(store.get('odd-session')?.source, undefined)
})

test('GET /entries carries the creating session of a card that has one, and flags a withheld card', async () => {
  const root = scratchRoot('dshm-stats-entries-source-')
  const cwd = 'D:/codes/EntriesSource'
  const store = root.projectFor(cwd)
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  await saveTool(tools)({ ...SAVE_ARGS, topic: 'with-source' }, { agent: { id: 'session-49ce2455-aaaa', session: { header: { cwd } } } })
  // The page is the user's own surface: it shows the card, and says that no
  // session is shown it — so "whether it stays" can be the user's decision.
  handWrite(store, 'leaky-card', { summary: 'deploy' }, 'DEPLOYNOTE the key is sk-q7Zm4Xp2Lb9Rt6Kw')
  const { list, dispose } = routes(root)
  const route = list.find(entry => entry.path === `${ROUTE_PREFIX}/entries`)
  assert.ok(route !== undefined, 'the entries route is registered')
  const response = await route.fetch(new Request(`https://localhost${route.path}?slug=${projectSlug(cwd)}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  const body = await response.json() as { value: { cards: Array<{ topic: string, source?: string, withheld?: boolean }> } }
  assert.equal(body.value.cards.find(card => card.topic === 'with-source')?.source, '49ce2455')
  assert.equal(body.value.cards.find(card => card.topic === 'with-source')?.withheld, undefined)
  assert.equal(body.value.cards.find(card => card.topic === 'leaky-card')?.withheld, true)
  await dispose()
})

test('POST /pin against a project whose own config.json is broken is refused and writes nothing', async () => {
  const root = scratchRoot('dshm-stats-pin-config-')
  const cwd = 'D:/proj-stats'
  const store = root.projectFor(cwd)
  await store.upsert({ name: 'card', category: 'fact', summary: 'hook', body: 'body' })
  const configPath = join(root.dir, 'projects', projectSlug(cwd), 'config.json')
  await store.addPin('card')
  const before = readFileSync(configPath)
  writeFileSync(configPath, '{"pinned": [')
  const { list, dispose } = routes(root)
  const route = list.find(entry => entry.path === `${ROUTE_PREFIX}/pin`)
  assert.ok(route !== undefined, 'the pin route is registered')
  const realWarn = console.warn
  console.warn = () => {}
  try {
    // Pinning is the write; unpinning reads the (default, empty) pin set and
    // returns early, so it is the one toggle that reaches the broken file.
    const response = await route.fetch(new Request(`https://localhost${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'project', slug: projectSlug(cwd), topic: 'card', pinned: true }),
    }))
    assert.equal(response.status, 500)
    const body = await response.json() as { error: { host: { code: string } } }
    assert.equal(body.error.host.code, 'route.configUnreadable', 'the page hears why, not a bare 500')
    assert.equal(readFileSync(configPath, 'utf8'), '{"pinned": [', 'the broken file keeps its bytes')
  } finally {
    console.warn = realWarn
    writeFileSync(configPath, before)
    await dispose()
  }
})

test('a sweep the filesystem only partly performed says which cards are still there', async () => {
  const root = scratchRoot('dshm-stats-forget-partial-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'loose-a', category: 'fact', summary: 'loose', body: '用 pnpm 跑 typecheck' })
  await store.upsert({ name: 'locked-b', category: 'fact', summary: 'locked', body: '用 pnpm 跑 build' })
  const seam = store as unknown as { unlinkCardFile(name: string): Promise<void> }
  const unlink = seam.unlinkCardFile.bind(store)
  seam.unlinkCardFile = async (name: string) => {
    if (name === 'locked-b') throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY', syscall: 'unlink' })
    await unlink(name)
  }
  // The tool resolves its store through the root: hand it this instance.
  root.projectFor = () => store
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const realWarn = console.warn
  console.warn = () => {}
  try {
    const result = await forgetTool(tools)({ match: 'pnpm', sweep: 'text' }, EXEC)
    assert.equal(result.forgotten, 1)
    assert.equal(result.code, 'partly-removed')
    assert.deepEqual(result.failed, ['locked-b'])
    assert.match(result.reason ?? '', /still there/u)
    assert.equal(root.toolStats().forget.removed, 1, 'only what left the store is counted')
  } finally {
    console.warn = realWarn
  }
})

test('P9: an UPDATE whose inherited summary carries a credential is refused with the same structure', async () => {
  const root = scratchRoot('dshm-stats-cred-update-')
  const store = root.projectFor(CWD)
  // Hand-edited: the write path would have refused this summary.
  handWrite(store, 'odd-summary', { summary: 'token: abcdef1234567890' }, '一份干净的正文')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  // No summary is passed, so the stored one is merged in — and trips the rule.
  const update = { topic: 'odd-summary', category: 'fact', content: '改写后的干净正文' }
  const refused = await save(update, EXEC)
  assert.equal(refused.saved, false)
  assert.equal(refused.code, 'credential-refused')
  assert.equal(refused.category, 'named-secret')
  assert.equal(refused.field, 'summary', 'the field the model has to change — the store\u2019s sentence says "content"')
  assert.match(refused.reason ?? '', /^summary 可能包含密钥/u)
  assert.equal(store.get('odd-summary')?.body, '一份干净的正文', 'nothing was written')
  assert.equal(root.toolStats().save.refused['named-secret'], 1)
  // A length refusal is not dressed up as a credential one.
  const tooLong = await save({ ...update, summary: '换掉的摘要', content: 'x'.repeat(MAX_TOPIC_BODY_CHARS + 1) }, EXEC)
  assert.equal(tooLong.code, undefined)
  assert.match(tooLong.reason ?? '', /content too long/u)
})

test('a tool failure that reaches the model carries no directory of this machine', async () => {
  const root = scratchRoot('dshm-stats-tool-error-')
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'card', category: 'fact', summary: 'hook', body: 'body' })
  const topics = join(root.dir, 'projects', projectSlug(CWD), 'topics')
  // What an fs error looks like: the raw message names the directory, and
  // the error object carries it again as `path`.
  store.list = () => {
    throw Object.assign(new Error(`EACCES: permission denied, scandir '${topics}'`), { code: 'EACCES', syscall: 'scandir', path: topics })
  }
  root.projectFor = () => store
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  await assert.rejects(
    recallTool(tools)({}, EXEC),
    (error: unknown) => error instanceof Error
      && error.message === `EACCES scandir projects/${projectSlug(CWD)}/topics`
      && !error.message.includes(root.dir),
    'the code, the syscall and the store-relative path — the call still fails',
  )
})

test('P10: a store whose ARCHIVE cannot be read is skipped by "empty deleted memory" and named', async () => {
  const root = scratchRoot('dshm-stats-clear-archive-')
  const healthy = root.projectFor('D:/codes/ClearArchiveOk')
  await healthy.upsert({ name: 'gone', category: 'lesson', summary: '删掉的卡', body: '归档里的内容' })
  await healthy.forget('gone')
  const odd = root.projectFor('D:/codes/ClearArchiveOdd')
  await odd.upsert({ name: 'live', category: 'lesson', summary: '活卡', body: '内容' })
  // The store LISTS (its `topics/` is fine); its `archive` is a FILE. The
  // listing-based isolation never saw it, and the loop used to stop there.
  writeFileSync(join(odd.dir, 'archive'), 'not a directory', 'utf8')
  const { list, dispose } = routes(root)
  const realWarn = console.warn
  console.warn = () => {}
  try {
    const response = await call(list, 'archive-clear', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
    })
    assert.equal(response.status, 500)
    const body = await response.json() as { error: { host: { code: string, params: Record<string, unknown> } } }
    assert.equal(body.error.host.code, 'route.archiveClearPartial')
    assert.equal(body.error.host.params.cleared, 1, 'the readable store was cleared, whichever order the loop met it in')
    assert.deepEqual(String(body.error.host.params.slugs), projectSlug('D:/codes/ClearArchiveOdd'))
    assert.equal(healthy.archivedCards().length, 0)
  } finally {
    console.warn = realWarn
    await dispose()
  }
})

test('P10: a project store whose own config.json is broken is flagged on its /status row', async () => {
  const root = scratchRoot('dshm-stats-row-config-')
  const cwd = 'D:/codes/RowConfig'
  await root.projectFor(cwd).upsert({ name: 'card', category: 'lesson', summary: '卡', body: '内容' })
  writeFileSync(join(root.dir, 'projects', projectSlug(cwd), 'config.json'), '{"pinned": [', 'utf8')
  const { list, dispose } = routes(root)
  const response = await call(list, 'status', { method: 'GET' })
  const body = await response.json() as { value: { configUnreadable: boolean, projects: Array<{ slug: string, configUnreadable?: boolean }> } }
  assert.equal(response.status, 200)
  assert.equal(body.value.configUnreadable, false, 'the flag on /status is the ROOT config\'s; this one is the store\'s own')
  assert.equal(body.value.projects.find(row => row.slug === projectSlug(cwd))?.configUnreadable, true)
  assert.equal(listProjects(root.dir).find(row => row.slug === projectSlug(cwd))?.configUnreadable, true)
  await dispose()
})

test('P10: "empty deleted memory" clears the readable stores and names the one it could not read', async () => {
  const root = scratchRoot('dshm-stats-clear-partial-')
  const store = root.projectFor('D:/codes/ClearHealthy')
  await store.upsert({ name: 'gone-card', category: 'lesson', summary: '删掉的卡', body: '归档里的内容' })
  await store.forget('gone-card')
  const brokenCwd = 'D:/codes/ClearBroken'
  const brokenSlug = projectSlug(brokenCwd)
  const brokenDir = join(root.dir, 'projects', brokenSlug)
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'project.json'), `${JSON.stringify({ cwd: brokenCwd })}\n`, 'utf8')
  writeFileSync(join(brokenDir, 'topics'), 'not a directory', 'utf8')
  const { list, dispose } = routes(root)
  const realWarn = console.warn
  console.warn = () => {}
  try {
    const response = await call(list, 'archive-clear', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
    })
    // A clearing that skipped anything is not reported as done. The strict
    // walk used to make this route fail outright — for every project.
    assert.equal(response.status, 500)
    const body = await response.json() as { error: { host: { code: string, params: Record<string, unknown> } } }
    assert.equal(body.error.host.code, 'route.archiveClearPartial')
    assert.equal(body.error.host.params.cleared, 1, 'what WAS cleared is in the answer')
    assert.equal(body.error.host.params.slugs, brokenSlug)
    assert.equal(store.archivedCards().length, 0, 'the readable store was cleared')
  } finally {
    console.warn = realWarn
    await dispose()
  }
})
