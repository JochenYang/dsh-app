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

test('memory_save fires the curator trigger for a persistent save', async () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-tools-')))
  const { ctx, tools } = stubCtx()
  const fired: string[] = []
  registerMemoryTools(ctx, root, (_parent, sessionId) => { fired.push(String(sessionId)) })

  const save = tools.get('memory_save') as {
    execute(args: unknown, exec: unknown): Promise<{ saved?: boolean }>
  }
  const result = await save.execute(SAVE_ARGS, { agent: { id: 'session-abc', session: { header: { cwd: 'D:\proj' } } } })
  assert.equal(result.saved, true)
  assert.deepEqual(fired, ['session-abc'])
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
  await save.execute(SAVE_ARGS, { agent: { id: 'session-abc', session: { header: { cwd: 'D:\proj' } } } })
  const dup = await save.execute(SAVE_ARGS, { agent: { id: 'session-abc', session: { header: { cwd: 'D:\proj' } } } })
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
  const result = await save.execute(SAVE_ARGS, { agent: { id: 'session-abc', session: { header: { cwd: 'D:\proj' } } } })
  assert.equal(result.saved, true)
})
