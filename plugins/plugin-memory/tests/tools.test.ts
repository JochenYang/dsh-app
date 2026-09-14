/**
 * Unit tests for the direct-save curator trigger (P2). The e2e path cannot
 * distinguish "memory_save fired the trigger" from "an unrelated distill
 * sweep happened to visit the file", so the wiring is asserted here against
 * a stub tool registrar instead.
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

const SAVE_ARGS = { category: 'preference', content: 'e2e trigger probe', scope: 'global' }

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

test('memory_save fires the curator trigger for a persistent save', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-')))
  const { ctx, tools } = stubCtx()
  const fired: string[] = []
  registerMemoryTools(ctx, root, (_parent, sessionId) => { fired.push(String(sessionId)) })

  const save = tools.get('memory_save') as {
    execute(args: unknown, exec: unknown): Promise<{ saved?: boolean }>
  }
  const result = await save.execute(SAVE_ARGS, EXEC)
  assert.equal(result.saved, true)
  assert.deepEqual(fired, ['session-abc'])
  // The own-save marker lands at the feed's last seq, not at 0.
  assert.equal(root.ownSaveSeqOf('session-abc'), 7)
})

test('memory_save does NOT fire the trigger when nothing was persisted', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-')))
  const { ctx, tools } = stubCtx()
  let calls = 0
  registerMemoryTools(ctx, root, () => { calls += 1 })
  const save = tools.get('memory_save') as {
    execute(args: unknown, exec: unknown): Promise<{ saved?: boolean }>
  }

  // Duplicate content (second save of the same line) must not re-trigger.
  await save.execute(SAVE_ARGS, EXEC)
  const dup = await save.execute(SAVE_ARGS, EXEC)
  assert.equal(dup.saved, false)
  assert.equal(calls, 1)
})

test('memory_save survives an unavailable agents service', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-')))
  const tools = new Map<string, unknown>()
  const ctx = {
    tools: { register: (d: { name: string }) => { tools.set(d.name, d); return () => undefined } },
    // A kernel without the agents service: get returns undefined.
    get: () => undefined,
  }
  registerMemoryTools(ctx as never, root, () => { throw new Error('must not be called') })
  const save = tools.get('memory_save') as {
    execute(args: unknown, exec: unknown): Promise<{ saved?: boolean }>
  }
  const result = await save.execute(SAVE_ARGS, EXEC)
  assert.equal(result.saved, true)
})

test('memory_save strips a commit id out of the content before persisting', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-cid-')))
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const save = tools.get('memory_save') as {
    execute(args: unknown, exec: unknown): Promise<{ saved?: boolean, entry?: string }>
  }
  const result = await save.execute(
    { category: 'lesson', content: '修复了流式竞态，fb8b001 已提交', scope: 'global' },
    EXEC,
  )
  assert.equal(result.saved, true)
  assert.ok(result.entry!.includes('修复了流式竞态'), 'the fact survives')
  assert.ok(!result.entry!.includes('fb8b001'), 'the commit id does not')
})

test('memory_recall with a query returns only matching rows plus the true total', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-recall-')))
  root.global.append('lesson', '用 pnpm 跑 typecheck')
  root.global.append('fact', '服务器在东京')
  const { ctx, tools } = stubCtx()
  registerMemoryTools(ctx, root)
  const recall = tools.get('memory_recall') as {
    execute(args: unknown, exec: unknown): Promise<{ global?: { content: string, matched?: number, total: number } }>
  }
  // No agent attached: scope all → the global half only, as before.
  const hit = await recall.execute({ query: 'pnpm' }, { agent: undefined })
  assert.equal(hit.global?.matched, 1, 'one row matches the keyword')
  assert.equal(hit.global?.total, 2, 'the total says a row was filtered out')
  assert.ok(hit.global?.content.includes('pnpm'))
  assert.ok(!hit.global?.content.includes('东京'))
  const all = await recall.execute({}, { agent: undefined })
  assert.equal(all.global?.total, 2)
  assert.equal(all.global?.matched, undefined, 'no query → full file, no matched count')
})
