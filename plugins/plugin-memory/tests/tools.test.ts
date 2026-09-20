/**
 * Unit tests for the three memory tools over a stub registrar: upsert
 * semantics, the write-time similarity gate, recall forms, forget forms, the
 * background-trigger wiring, and the scope contract that replaced the global
 * scope (one scope: the current project; a workspace-less session can do
 * neither).
 *
 * @module @dsh-app/plugin-memory/tests/tools
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot, type MemoryStore } from '../src/memory-store.ts'
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

/** The workspace every workspace-bound call in this suite runs in. */
const CWD = 'D:\\proj'

/** The store a save/recall/forget in {@link CWD} addresses. */
const projectStore = (root: MemoryRoot): MemoryStore => root.projectFor(CWD)

const SAVE_ARGS = {
  topic: 'e2e-trigger-probe',
  category: 'preference',
  summary: '触发探针',
  content: 'e2e trigger probe',
  scope: 'project',
}

/** A realistic exec face: an attached agent whose session works in {@link CWD}. */
const EXEC = {
  agent: {
    id: 'session-abc',
    session: { header: { cwd: CWD } },
  },
}

/** The same face for a session that was started WITHOUT a workspace. */
const EXEC_NO_CWD = {
  agent: {
    id: 'session-no-cwd',
    session: { header: {} },
  },
}

interface SaveResult { saved?: boolean, op?: string, reason?: string, topic?: string, existing?: string, related?: string[], code?: string }

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
  assert.equal(created.topic, 'e2e-trigger-probe')
  assert.deepEqual(fired, ['session-abc'])
  assert.equal(projectStore(root).get('e2e-trigger-probe')?.body, 'e2e trigger probe', 'the card lands in the workspace memory')
  assert.equal(root.global.get('e2e-trigger-probe'), undefined, 'and never in the retired root scope')

  const updated = await save.execute({ ...SAVE_ARGS, content: 'revised probe body' }, EXEC)
  assert.equal(updated.op, 'updated', 'same topic rewrites the card')
  assert.equal(projectStore(root).list().length, 1, 'still one card — no duplicate')

  const noop = await save.execute({ ...SAVE_ARGS, content: 'revised probe body' }, EXEC)
  assert.equal(noop.op, 'unchanged')
  assert.equal(fired.length, 2, 'a no-op save does not re-arm the background passes')
})

test('the scope parameter of all three tools no longer offers the retired global scope', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-scope-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  // `parameters` is the compiled JSON schema: the per-property entries live
  // under `properties`, and the absence of `enum` is the point — an enumerated
  // field answers a stale "global" with a framework INVALID_ARGS that explains
  // nothing, while the free-form field reaches the coded refusal (asserted
  // below).
  type Property = { enum?: string[], description: string }
  for (const name of ['memory_save', 'memory_recall', 'memory_forget']) {
    const definition = tools.get(name) as { parameters: { properties: { scope: Property } } }
    const scope = definition.parameters.properties.scope
    assert.equal(scope.enum, undefined, `${name}: the field is free-form, not an enumeration listing "global"`)
    assert.match(scope.description, /removed/, `${name}: the schema says what happened to the other scope`)
  }
  const save = tools.get('memory_save') as { parameters: { properties: { scope: Property } } }
  assert.match(save.parameters.properties.scope.description, /Only "project"/, 'the accepted value is named')
})

test('memory_save: scope "global" is refused with a stable code, whatever the session', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-global-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  // A stale caller (an older prompt, a queued tool call) can still send the
  // removed scope: it must get the coded refusal, not a silent redirect into
  // whatever scope happens to exist.
  const refused = await save.execute({ ...SAVE_ARGS, scope: 'global' }, EXEC)
  assert.equal(refused.saved, false)
  assert.equal(refused.code, 'scope-global-removed')
  assert.match(refused.reason ?? '', /项目记忆/)
  assert.equal(root.global.list().length, 0, 'nothing reached the retired root scope')
  assert.equal(projectStore(root).list().length, 0, 'and nothing was silently redirected either')

  // Same answer when the session has no workspace: the scope, not the
  // workspace, is what the caller asked wrongly for.
  const refusedNoCwd = await save.execute({ ...SAVE_ARGS, scope: 'global' }, EXEC_NO_CWD)
  assert.equal(refusedNoCwd.code, 'scope-global-removed')
})

test('memory_save: a session with no workspace has no scope to save into', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-nocwd-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)

  // No `scope` key at all: the tool arguments are validated as JSON, so an
  // explicit `undefined` never reaches execute.
  const refused = await save.execute({
    topic: 'no-workspace-save',
    category: 'fact',
    summary: '无工作区',
    content: '没有工作区的会话不该写进任何地方',
  }, EXEC_NO_CWD)
  assert.equal(refused.saved, false)
  assert.equal(refused.code, 'no-workspace')
  assert.equal(root.global.list().length, 0)
  assert.equal(projectStore(root).list().length, 0)
})

test('memory_save: creating a near-duplicate under a NEW key is rejected with a pointer', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-dup-')))
  await projectStore(root).upsert({ name: 'pnpm11-allowscripts', category: 'lesson', summary: 'pnpm 11 白名单', body: 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = saveTool(tools)
  const dup = await save.execute({
    topic: 'pnpm-workspace-yaml',
    category: 'lesson',
    summary: 'pnpm 白名单位置',
    content: 'pnpm 11 白名单必须写进 pnpm-workspace.yaml 才生效',
    scope: 'project',
  }, EXEC)
  assert.equal(dup.saved, false)
  assert.match(dup.reason ?? '', /duplicate-of/)
  assert.equal(dup.existing, 'pnpm11-allowscripts', 'the pointer names the covering card')
  assert.equal(projectStore(root).list().length, 1, 'nothing was persisted')
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
    { topic: 'stream-race', category: 'lesson', summary: '流式竞态', content: '修复了流式竞态，fb8b001 已提交', scope: 'project' },
    EXEC,
  )
  assert.equal(result.saved, true)
  const card = projectStore(root).get('stream-race')
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
interface RecallResult { project?: RecallScopeView, reason?: string, code?: string }

test('memory_recall: topic fetch, keyword filter, and full-scope listing', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-recall-')))
  await projectStore(root).upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  await projectStore(root).upsert({ name: 'tokyo-servers', category: 'fact', summary: '东京服务器', body: '服务器在东京' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = tools.get('memory_recall') as { execute(args: unknown, exec: unknown): Promise<RecallResult> }

  const byTopic = await recall.execute({ topic: 'pnpm-typecheck' }, EXEC)
  assert.equal(byTopic.project?.found, true)
  assert.ok(byTopic.project?.card?.body.includes('typecheck'))
  const missing = await recall.execute({ topic: 'not-there' }, EXEC)
  assert.equal(missing.project?.found, false)

  const hit = await recall.execute({ query: 'pnpm' }, EXEC)
  assert.equal(hit.project?.matched, 1, 'one card matches the keyword')
  assert.equal(hit.project?.total, 2, 'the total says a card was filtered out')
  assert.equal(hit.project?.cards?.[0]?.topic, 'pnpm-typecheck')

  const all = await recall.execute({}, EXEC)
  assert.equal(all.project?.total, 2)
  assert.equal(all.project?.matched, undefined, 'no query → full listing, no matched count')
  assert.equal(all.project?.cards?.length, 2)

  // 'all' is kept as an alias of the one remaining scope, so a call written
  // against the old two-scope shape still reads something.
  const alias = await recall.execute({ scope: 'all' }, EXEC)
  assert.equal(alias.project?.total, 2)
})

test('memory_recall: the retired scope and a workspace-less session are refused with codes', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-recall-scope-')))
  await root.global.upsert({ name: 'old-global-card', category: 'fact', summary: '旧全局', body: '这张卡在根目录里' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = tools.get('memory_recall') as { execute(args: unknown, exec: unknown): Promise<RecallResult> }

  const retired = await recall.execute({ scope: 'global' }, EXEC)
  assert.equal(retired.code, 'scope-global-removed')
  assert.equal(retired.project, undefined, 'the retired root scope is never served')
  assert.equal(JSON.stringify(retired).includes('这张卡在根目录里'), false, 'and its content never leaks through recall')

  const noCwd = await recall.execute({}, EXEC_NO_CWD)
  assert.equal(noCwd.code, 'no-workspace')
})

test('memory_forget: topic key deletes one card; text sweeps by content', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-forget-')))
  await projectStore(root).upsert({ name: 'pnpm-typecheck', category: 'lesson', summary: 'pnpm 跑检查', body: '用 pnpm 跑 typecheck' })
  await projectStore(root).upsert({ name: 'tokyo-servers', category: 'fact', summary: '东京服务器', body: '服务器在东京' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = tools.get('memory_forget') as { execute(args: unknown, exec: unknown): Promise<{ forgotten: number, scopes?: Record<string, { removed: string[] }>, code?: string }> }

  const byKey = await forget.execute({ match: 'pnpm-typecheck', scope: 'project' }, EXEC)
  assert.equal(byKey.forgotten, 1)
  assert.deepEqual(byKey.scopes?.project.removed, ['pnpm-typecheck'])
  assert.ok(projectStore(root).get('pnpm-typecheck') === undefined)

  const byContent = await forget.execute({ match: '东京', scope: 'project' }, EXEC)
  assert.equal(byContent.forgotten, 1)
  assert.equal(projectStore(root).list().length, 0)
})

test('memory_forget: the retired scope and a workspace-less session are refused with codes', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-forget-scope-')))
  await root.global.upsert({ name: 'keep-me', category: 'fact', summary: '旧全局', body: '不该被这个工具删掉' })
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const forget = tools.get('memory_forget') as { execute(args: unknown, exec: unknown): Promise<{ forgotten: number, code?: string }> }

  const retired = await forget.execute({ match: 'keep-me', scope: 'global' }, EXEC)
  assert.equal(retired.forgotten, 0)
  assert.equal(retired.code, 'scope-global-removed')
  assert.notEqual(root.global.get('keep-me'), undefined, 'the retired scope is not writable through the tools either')

  const noCwd = await forget.execute({ match: 'anything' }, EXEC_NO_CWD)
  assert.equal(noCwd.forgotten, 0)
  assert.equal(noCwd.code, 'no-workspace')
})
