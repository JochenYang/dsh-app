/**
 * `creative_role` over the unified delegation seam.
 *
 * Kernel 0.2.1 removed the per-call `persona` and `toolFilter` from
 * `startActivation`, so this module carries the Role two other ways: the Role
 * text at the head of the child's first message, and the allow-list applied to
 * the child's own context from the `subagent/start` edge. The second one is the
 * delicate half — it must land BEFORE the child's first step, which is why the
 * child id is reserved by this tool and the edge is keyed by that id. These
 * assertions drive the real tool and the real edge handler, not a stub of
 * either.
 *
 * @module plugin-creative/tests/role-tool
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { applyPendingRole, createCreativeRoleTool, roleToolFilter } from '../src/role-tool.ts'

interface CapturedSpec {
  readonly provider: string
  readonly label: string
  readonly childId?: string
  readonly delivery: string
  readonly request: {
    readonly prompt: readonly { readonly type: string; readonly text: string }[]
    readonly maxDepth?: number
    readonly persona?: unknown
    readonly toolFilter?: unknown
  }
}

/** The child Agent the kernel makes resident before it delivers the prompt. */
function fakeChild(): { readonly ctx: { tools: { restrict(filter: unknown): () => void } }; readonly session: object } {
  return {
    ctx: { tools: { restrict: () => () => {} } },
    session: {},
  }
}

/** A context whose `agents` service answers one reserved child id. */
function fakeContext(childId: string, child: ReturnType<typeof fakeChild> | undefined): Context {
  return {
    get: (name: string) => name === 'agents'
      ? { get: (id: unknown) => String(id) === childId ? child : undefined }
      : undefined,
  } as unknown as Context
}

describe('creative_role', () => {
  it('reserves the child id, puts the Role text in the prompt, and asks for caller delivery', async () => {
    const captured: CapturedSpec[] = []
    const disposed: string[] = []
    const tool = await createCreativeRoleTool({
      startActivation: async (spec: CapturedSpec) => {
        captured.push(spec)
        return {
          childId: spec.childId,
          messageId: 'm1',
          result: Promise.resolve({
            stopReason: 'completed' as const,
            output: [{ type: 'text', text: 'role output' }],
          }),
          dispose: async () => { disposed.push(String(spec.childId)) },
        }
      },
    })

    const value = await tool.execute(
      { role: 'story-explorer', prompt: 'map the cast' },
      { agent: { ctx: { get: () => undefined } }, signal: new AbortController().signal },
    )

    assert.equal(captured.length, 1)
    const spec = captured[0]
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.label, 'story:story-explorer')
    assert.equal(spec.delivery, 'caller')
    assert.equal(spec.request.maxDepth, 1)
    // A reserved id is what lets the start edge recognise its own child.
    assert.equal(typeof spec.childId, 'string')
    assert.ok(String(spec.childId).length > 0)
    // The seam has neither field any more: the Role rides the prompt instead.
    assert.equal(spec.request.persona, undefined)
    assert.equal(spec.request.toolFilter, undefined)
    const prompt = spec.request.prompt[0].text
    assert.ok(prompt.startsWith('CREATIVE_DSH_ROLE:story-explorer'), prompt.slice(0, 80))
    assert.ok(prompt.endsWith('map the cast'), prompt.slice(-40))

    assert.deepEqual(value, {
      role: 'story-explorer',
      childId: String(spec.childId),
      content: [{ type: 'text', text: 'role output' }],
    })
    assert.deepEqual(disposed, [String(spec.childId)])
  })

  it('restricts the child to the Role tool set from the start edge, exactly once', async () => {
    const restrictions: unknown[] = []
    const child = {
      ctx: { tools: { restrict: (filter: unknown) => { restrictions.push(filter); return () => {} } } },
      session: {},
    }
    let reserved = ''
    const tool = await createCreativeRoleTool({
      startActivation: async (spec: CapturedSpec) => {
        reserved = String(spec.childId)
        // The kernel publishes the start edge once the child is resident and
        // before the prompt is delivered; this is that edge.
        applyPendingRole(fakeContext(reserved, child), spec.childId as never)
        return {
          childId: spec.childId,
          messageId: 'm1',
          result: Promise.resolve({ stopReason: 'completed' as const, output: [] }),
          dispose: async () => {},
        }
      },
    })

    await tool.execute(
      { role: 'consistency-checker', prompt: 'check continuity' },
      { agent: { ctx: { get: () => undefined } }, signal: new AbortController().signal },
    )

    assert.deepEqual(restrictions, [roleToolFilter('consistency-checker')])
    // The entry is consumed: a second edge for the same id applies nothing.
    applyPendingRole(fakeContext(reserved, child), reserved as never)
    assert.equal(restrictions.length, 1)
  })

  it('leaves an unrelated child alone, and reports a failed Role run', async () => {
    const child = fakeChild()
    applyPendingRole(fakeContext('someone-else', child), 'someone-else' as never)
    assert.deepEqual(roleToolFilter('story-explorer').allow, [
      'creative_bundled_reference',
      'read',
      'glob',
      'grep',
    ])

    const tool = await createCreativeRoleTool({
      startActivation: async (spec: CapturedSpec) => ({
        childId: spec.childId,
        messageId: 'm1',
        result: Promise.resolve({ stopReason: 'max-tokens' as const, output: [], diagnostic: 'budget spent' }),
        dispose: async () => {},
      }),
    })
    await assert.rejects(
      tool.execute(
        { role: 'narrative-writer', prompt: 'write it' },
        { agent: { ctx: { get: () => undefined } }, signal: new AbortController().signal },
      ),
      /ended with max-tokens: budget spent/,
    )
  })
})
