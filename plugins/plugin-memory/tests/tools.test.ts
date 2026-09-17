/**
 * Unit tests for the three memory tools over a stub registrar: upsert
 * semantics, the write-time similarity gate, recall forms, forget forms, and
 * the background-trigger wiring.
 *
 * @module @dsh-app/plugin-memory/tests/tools
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot } from '../src/memory-store.ts'
import { registerMemoryTools } from '../src/tools.ts'

/** Minimal tool registrar capturing the definitions as they register. */
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
      // Only the agents lookup is exercised by the save path.
      return name === 'agents' ? { get: () => ({ id: 'agent-1' }) } : undefined
    },
  }
  return { ctx: ctx as never, tools }
}

const SAVE_ARGS = {
  topic: 'e2e-trigger-probe',
  category: 'preference',
  summary: '触发探针',
  content: 'e2e trigger probe',
  scope: 'global',
}

/** A realistic exec face: an attached agent with a workspace and an event
 * feed (the save path stamps its own-save marker at the feed's last seq). */
const EXEC = {
  agent: {
    id: 'session-abc',
    session: {
      header: { cwd: 'D:\\proj' },
      snapshotEvents: () => [{ type: 'user/message', seq: 7 }],
    },
  },
}

interface SaveResult { saved?: boolean, op?: string, reason?: string, topic?: string, existing?: string, related?: string[] }

const saveTool = (tools: Map<string, unknown>): { execute(args: unknown, exec: unknown): Promise<SaveResult> } =>
  tools.get('memory_save') as { execute(args: unknown, exec: unknown): Promise<SaveResult> }

test('memory_save: create → update → unchanged, firing the trigger only on change', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-')))
  const { ctx, tools } = stubCtx()
  const fired: string[] = []
  registerMemoryTools(ctx, root, (_parent, sessionId) => { fired.push(String(sessionId)) })
  const save = saveTool(tools)

  const created = await save.execute(SAVE_ARGS, EXEC)
  assert.equal(created.saved, true)
  assert.equal(created.op, 'created')
  assert.deepEqual(fired, ['session-abc'])
  assert.equal(root.ownSaveSeqOf('session-abc'), 7, 'own-save marker at the feed tail')

  const updated = await save.execute({ ...SAVE_ARGS, content: 'revised probe body' }, EXEC)
  assert.equal(updated.op, 'updated', 'same topic rewrites the card')
  assert.equal(root.global.list().length, 1, 'still one card — no duplicate')

  const noop = await save.execute({ ...SAVE_ARGS, content: 'revised probe body' }, EXEC)
  assert.equal(noop.op, 'unchanged')
  assert.equal(fired.length, 2, 'a no-op save does not re-arm the background passes')
})

test('memory_save: creating a near-duplicate under a NEW key is rejected with a pointer', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-dup-')))
  await root.global.upsert({ name: 'pnpm11-allowscripts', category: 'lesson', summary: 'pnpm 11 白名单', body: 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)
  const dup = await save.execute({
    topic: 'pnpm-workspace-yaml',
    category: 'lesson',
    summary: 'pnpm 白名单位置',
    content: 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效',
    scope: 'global',
  }, EXEC)
  assert.equal(dup.saved, false)
  assert.match(dup.reason ?? '', /duplicate-of/)
  assert.equal(dup.existing, 'pnpm11-allowscripts', 'the pointer names the covering card')
  assert.equal(root.global.list().length, 1, 'nothing was persisted')
})

test('memory_save: invalid topic / missing summary / credentials are rejected with guidance', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-rej-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  const badTopic = await save.execute({ ...SAVE_ARGS, topic: '中文主题' }, EXEC)
  assert.equal(badTopic.saved, false)
  assert.match(badTopic.reason ?? '', /ASCII/)

  const noSummary = await save.execute({ ...SAVE_ARGS, topic: 'fresh-topic', summary: '' }, EXEC)
  assert.equal(noSummary.saved, false)
  assert.match(noSummary.reason ?? '', /summary is required/)
  const updated = await save.execute(SAVE_ARGS, EXEC)
  assert.equal(updated.saved, true)
  const updateNoSummary = await save.execute({ ...SAVE_ARGS, summary: '', content: 'new body' }, EXEC)
  assert.equal(updateNoSummary.saved, true, 'updating without a summary inherits the old one')

  const secret = await save.execute({ ...SAVE_ARGS, topic: 'creds', content: 'api_key: sk-abc123def456ghi7' }, EXEC)
  assert.equal(secret.saved, false)
  assert.match(secret.reason ?? '', /凭据/)
})

test('memory_save strips a commit id out of the content before persisting', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-cid-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)
  const result = await save.execute(
    { topic: 'stream-race', category: 'lesson', summary: '流式竞态', content: '修复了流式竞态，fb8b001 已提交', scope: 'global' },
    EXEC,
  )
  assert.equal(result.saved, true)
  const card = root.global.get('stream-race')
  assert.ok(card !== undefined)
  assert.ok(card.body.includes('修复了流式竞态'), 'the fact survives')
  assert.ok(!card.body.includes('fb8b001'), 'the commit id does not')
})

test('memory_save: an update-path validation failure returns a structured reason, never a throw', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-upd-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)
  await save.execute(SAVE_ARGS, EXEC)
  // Over-long content on an EXISTING topic must come back as a correctable
  // reason, not a store-level throw.
  const tooLong = await save.execute({ ...SAVE_ARGS, content: 'x'.repeat(401) }, EXEC)
  assert.equal(tooLong.saved, false)
  assert.match(tooLong.reason ?? '', /content too long/)
  const credentialSummary = await save.execute({ ...SAVE_ARGS, summary: 'api_key: sk-abc123def456' }, EXEC)
  assert.equal(credentialSummary.saved, false)
  assert.match(credentialSummary.reason ?? '', /凭据|credential/)
})

test('memory_save survives an unavailable agents service', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-noagent-')))
  const tools = new Map<string, unknown>()
  const ctx = {
    tools: { register: (d: { name: string }) => { tools.set(d.name, d); return () => undefined } },
    // A kernel without the agents service: get returns undefined.
    get: () => undefined,
  }
  registerMemoryTools(ctx as never, root, () => { throw new Error('must not be called') })
  const save = saveTool(tools)
  const result = await save.execute(SAVE_ARGS, EXEC)
  assert.equal(result.saved, true)
})

interface RecallScopeView { found?: boolean, card?: { topic: string, body: string }, cards?: Array<{ topic: string }>, total?: number, matched?: number }
interface RecallResult { global?: RecallScopeView, project?: RecallScopeView, reason?: string }

test('memory_recall: topic fetch, keyword filter, and full-scope listing', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-recall-')))
  await root.global.upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  await root.global.upsert({ name: 'tokyo-servers', category: 'fact', summary: '东京服务器', body: '服务器在东京' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = tools.get('memory_recall') as { execute(args: unknown, exec: unknown): Promise<RecallResult> }

  const byTopic = await recall.execute({ topic: 'pnpm-typecheck' }, { agent: undefined })
  assert.equal(byTopic.global?.found, true)
  assert.ok(byTopic.global?.card?.body.includes('typecheck'))
  const missing = await recall.execute({ topic: 'not-there' }, { agent: undefined })
  assert.equal(missing.global?.found, false)

  const hit = await recall.execute({ query: 'pnpm' }, { agent: undefined })
  assert.equal(hit.global?.matched, 1, 'one card matches the keyword')
  assert.equal(hit.global?.total, 2, 'the total says a card was filtered out')
  assert.equal(hit.global?.cards?.[0]?.topic, 'pnpm-typecheck')

  const all = await recall.execute({}, { agent: undefined })
  assert.equal(all.global?.total, 2)
  assert.equal(all.global?.matched, undefined, 'no query → full listing, no matched count')
  assert.equal(all.global?.cards?.length, 2)
})

test('memory_forget: topic key deletes one card; text sweeps by content', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-forget-')))
  await root.global.upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  await root.global.upsert({ name: 'tokyo-servers', category: 'fact', summary: '东京服务器', body: '服务器在东京' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = tools.get('memory_forget') as { execute(args: unknown, exec: unknown): Promise<{ forgotten: number, scopes?: Record<string, { removed: string[] }> }> }

  const byKey = await forget.execute({ match: 'pnpm-typecheck', scope: 'global' }, EXEC)
  assert.equal(byKey.forgotten, 1)
  assert.deepEqual(byKey.scopes?.global.removed, ['pnpm-typecheck'])
  assert.ok(root.global.get('pnpm-typecheck') === undefined)

  const byContent = await forget.execute({ match: '东京', scope: 'global' }, EXEC)
  assert.equal(byContent.forgotten, 1)
  assert.equal(root.global.list().length, 0)
})
