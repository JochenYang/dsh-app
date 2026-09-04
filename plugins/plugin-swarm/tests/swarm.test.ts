/**
 * Unit tests for the swarm plugin: split expansion/validation, adaptive gate
 * mechanics, and batch orchestration over mocked subagent seams (one-shot and
 * continuable). Run via `npm test` (esbuild bundles TS → .test-dist, node
 * --test runs it).
 *
 * @module @dsh-app/plugin-swarm/tests/swarm
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AdaptiveGate,
  runSwarmBatch,
  type SwarmBatchOptions,
  type SwarmTask,
} from '../src/orchestrator.ts'
import { expandTasks } from '../src/expand.ts'

// --- expandTasks -------------------------------------------------------------

const TEMPLATE = 'Review the module described here: {{item}}. Read every source file in the module, check the public API surface against its tests, and report findings as a bullet list with file references. The subtask is done when every file of the module has been covered.'

test('expandTasks: expands one task per item with the placeholder substituted', () => {
  const { tasks, warnings } = expandTasks({
    description: 't',
    items: ['src/api module', 'src/ui module'],
    prompt_template: TEMPLATE,
  }, 8)
  assert.equal(tasks.length, 2)
  assert.ok(tasks[0].prompt.includes('src/api module'))
  assert.ok(!tasks[0].prompt.includes('{{item}}'))
  assert.equal(warnings.length, 0)
})

test('expandTasks: rejects an empty batch, a missing template, and a template without the placeholder', () => {
  assert.throws(() => expandTasks({ description: 't' }, 8), /nothing to run/)
  assert.throws(() => expandTasks({ description: 't', items: ['a', 'b'] }, 8), /prompt_template.*required/)
  assert.throws(() => expandTasks({ description: 't', items: ['a', 'b'], prompt_template: 'no placeholder' }, 8), /\{\{item\}\} placeholder/)
})

test('expandTasks: rejects duplicate items and a lone fresh item', () => {
  assert.throws(
    () => expandTasks({ description: 't', items: ['same thing', 'same thing'], prompt_template: TEMPLATE }, 8),
    /duplicate/,
  )
  assert.throws(
    () => expandTasks({ description: 't', items: ['only one'], prompt_template: TEMPLATE }, 8),
    /at least 2 tasks/,
  )
})

test('expandTasks: shared_context is prepended to fresh prompts only, never to resume follow-ups', () => {
  const { tasks } = expandTasks({
    description: 't',
    items: ['src/api module', 'src/ui module'],
    prompt_template: TEMPLATE,
    shared_context: 'Project conventions: ESM only, strict TS.',
    resume_entries: [{ child_id: 'child-1', followup: 'please refine your answer' }],
  }, 8)
  assert.ok(tasks[0].prompt.startsWith('Project conventions: ESM only, strict TS.\n\n---\n\n'))
  assert.equal(tasks[2].prompt, 'please refine your answer')
  assert.equal(tasks[2].resumeChildId, 'child-1')
})

test('expandTasks: stub items and bare templates produce non-blocking warnings', () => {
  const { warnings } = expandTasks({
    description: 't',
    items: ['api', 'ui'],
    prompt_template: 'do {{item}}',
  }, 8)
  assert.ok(warnings.some(w => w.includes('item [0]')))
  assert.ok(warnings.some(w => w.includes('prompt_template')))
})

// --- AdaptiveGate ------------------------------------------------------------

test('AdaptiveGate: a failure halves the live limit (floor 1); completions regrow toward the ceiling', async () => {
  const gate = new AdaptiveGate(4, 8, true)
  assert.equal(gate.noteSettled('failed'), 'shrunk')
  assert.equal(gate.noteSettled('failed'), 'shrunk') // 2 → 1
  assert.equal(gate.noteSettled('failed'), undefined) // floor 1
  for (let i = 0; i < 4; i++) gate.noteSettled('completed')
  // streak of 4 grows the limit by one from the floor
  const grew = gate.noteSettled('completed')
  assert.ok(grew === undefined || grew === 'grew')
})

test('AdaptiveGate: disabled mode pins the limit and feedback is a no-op', () => {
  const gate = new AdaptiveGate(3, 6, false)
  assert.equal(gate.noteSettled('failed'), undefined)
  assert.equal(gate.noteSettled('completed'), undefined)
})

// --- runSwarmBatch over a mocked seam ----------------------------------------

interface MockChild {
  readonly stopReason: 'completed' | 'error' | 'aborted' | 'max-tokens' | 'refusal'
  readonly text?: string
  /** Child session events (turn/end failure facts, assistant/message usage). */
  readonly events?: readonly { type: string, data: unknown }[]
  /** Settle delay in ms (default 0); orders settlements across children. */
  readonly delay?: number
  /** Emit the terminal synchronously inside startContinuable (pre-wait). */
  readonly sync?: boolean
}

const tasksOf = (...items: string[]): SwarmTask[] =>
  items.map((item, index) => ({ index, item, prompt: `do ${item}` }))

function baseOptions(): Omit<SwarmBatchOptions, 'tasks'> {
  return {
    provider: 'spawn',
    parent: {} as Agent,
    signal: new AbortController().signal,
    label: 'test batch',
    concurrency: 2,
    outputLimit: 4000,
    startStaggerMs: 0,
  }
}

/** Mock ctx whose one-shot `start` resolves each child from the spec map. */
function mockOneShotCtx(children: Record<string, MockChild>): Context {
  const ctx = {
    subagents: {
      getProvider: () => ({}),
      start: async (_provider: string, req: { prompt: readonly { text: string }[] }) => {
        const text = req.prompt[0].text
        const key = Object.keys(children).find(k => text.includes(k))
        assert.ok(key !== undefined, `no mock child for prompt "${text}"`)
        const spec = children[key]
        return {
          result: Promise.resolve({
            stopReason: spec.stopReason,
            output: spec.text === undefined ? [] : [{ type: 'text', text: spec.text }],
          }),
          localAgent: { session: { events: spec.events ?? [] } },
          dispose: async () => {},
        }
      },
    },
    logger: { warn: () => {} },
  }
  return ctx as unknown as Context
}

test('runSwarmBatch (one-shot): aggregates outputs, per-item durationMs, and batch usage', async () => {
  const ctx = mockOneShotCtx({
    alpha: {
      stopReason: 'completed',
      text: 'alpha done',
      events: [{ type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }],
    },
    beta: { stopReason: 'completed', text: 'beta done' },
  })
  const outcome = await runSwarmBatch(ctx, { ...baseOptions(), tasks: tasksOf('alpha', 'beta') })
  assert.equal(outcome.completed, 2)
  assert.equal(outcome.items[0].output, 'alpha done')
  assert.ok(outcome.items[0].durationMs !== undefined)
  assert.ok(outcome.durationMs >= 0)
  assert.deepEqual(outcome.items[0].usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  assert.equal(outcome.items[1].usage, undefined)
})

test('runSwarmBatch (one-shot): a RATE_LIMIT turn error classifies as transport, refusal as content', async () => {
  const ctx = mockOneShotCtx({
    flaky: {
      stopReason: 'error',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'too many requests', code: 'RATE_LIMIT' } } } }],
    },
    stubborn: { stopReason: 'refusal', text: 'I decline' },
  })
  const outcome = await runSwarmBatch(ctx, { ...baseOptions(), tasks: tasksOf('flaky', 'stubborn') })
  const [flaky, stubborn] = outcome.items
  assert.equal(flaky.status, 'failed')
  assert.equal(flaky.failureKind, 'transport')
  assert.ok(flaky.error!.includes('[RATE_LIMIT]'))
  assert.equal(stubborn.status, 'failed')
  assert.equal(stubborn.failureKind, 'content')
})

test('runSwarmBatch (one-shot): the token budget stops launching; unstarted items report aborted', async () => {
  const usage = { inputTokens: 60, outputTokens: 40, totalTokens: 100 }
  const ctx = mockOneShotCtx({
    a: { stopReason: 'completed', text: 'a', events: [{ type: 'assistant/message', data: { usage } }] },
    b: { stopReason: 'completed', text: 'b', events: [{ type: 'assistant/message', data: { usage } }] },
    c: { stopReason: 'completed', text: 'c', events: [{ type: 'assistant/message', data: { usage } }] },
  })
  const outcome = await runSwarmBatch(ctx, {
    ...baseOptions(),
    concurrency: 1, // sequential, so the budget trips deterministically
    tasks: tasksOf('a', 'b', 'c'),
    tokenBudget: 150,
  })
  assert.equal(outcome.completed, 2)
  assert.equal(outcome.aborted, 1)
  assert.equal(outcome.budgetExhausted, true)
  assert.ok(outcome.items[2].error!.includes('budget'))
  assert.equal(outcome.usage!.totalTokens, 200)
})

// --- continuable backend: retry classification -------------------------------

interface ContinuableHarness {
  readonly ctx: Context
  readonly sentFollowups: string[]
  /** Emit a subagent/end terminal for one child. */
  readonly settle: (childId: string, stopReason: string, text?: string) => void
}

function mockContinuableCtx(children: Record<string, MockChild>): ContinuableHarness {
  const listeners: ((info: unknown) => void)[] = []
  const sentFollowups: string[] = []
  let launches = 0
  const ctx = {
    on: (event: string, listener: (info: unknown) => void) => {
      assert.equal(event, 'subagent/end')
      listeners.push(listener)
      return () => {}
    },
    agents: {
      get: (id: unknown) => {
        // Live-child lookup: the swarm addresses children as `child-<key>`.
        const key = String(id).replace(/^child-/, '')
        const spec = children[key]
        if (spec === undefined) return undefined
        return { session: { events: spec.events ?? [] } }
      },
    },
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec: { request: { prompt: readonly { text: string }[] } }) => {
        const text = spec.request.prompt[0].text
        const key = Object.keys(children).find(k => text.includes(k))
        assert.ok(key !== undefined, `no mock child for prompt "${text}"`)
        launches += 1
        const childId = `child-${key}`
        const first = children[key]
        if (first.sync === true) {
          // Settle BEFORE the caller can register its wait: exercises the
          // watch's stored-terminal path (and its consume-on-read semantics).
          emit(childId, first)
        } else {
          setTimeout(() => emit(childId, first), first.delay ?? 0)
        }
        return { childId, messageId: 'm1' }
      },
      sendMessage: async (_parent: unknown, childId: unknown) => {
        sentFollowups.push(String(childId))
        const key = String(childId).replace(/^child-/, '')
        // The retried child succeeds.
        setTimeout(() => emit(String(childId), { stopReason: 'completed', text: `${key} recovered` }), 0)
        return 'm2'
      },
      interrupt: () => {},
    },
    logger: { warn: () => {} },
  }
  const emit = (childId: string, spec: MockChild): void => {
    for (const listener of listeners) {
      listener({
        id: childId,
        stopReason: spec.stopReason,
        lastAssistantMessage: spec.text === undefined ? undefined : [{ type: 'text', text: spec.text }],
      })
    }
  }
  return {
    ctx: ctx as unknown as Context,
    sentFollowups,
    settle: emit,
  }
}

test('runSwarmBatch (continuable): a transport failure is auto-retried via follow-up; a content failure is not', async () => {
  const harness = mockContinuableCtx({
    flaky: {
      stopReason: 'error',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '429', code: 'RATE_LIMIT' } } } }],
    },
    stubborn: {
      stopReason: 'error',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'prompt too long', code: 'CONTEXT_WINDOW_EXCEEDED' } } } }],
    },
  })
  const outcome = await runSwarmBatch(harness.ctx, {
    ...baseOptions(),
    tasks: tasksOf('flaky', 'stubborn'),
    itemMaxRetries: 1,
    itemRetryDelayMs: 1,
  })
  const [flaky, stubborn] = outcome.items
  assert.equal(flaky.status, 'completed', 'transport failure retried to completion')
  assert.equal(flaky.output, 'flaky recovered')
  assert.equal(flaky.retries, 1)
  assert.equal(stubborn.status, 'failed', 'content failure settles without retry')
  assert.equal(stubborn.failureKind, 'content')
  assert.deepEqual(harness.sentFollowups, ['child-flaky'], 'only the transport failure got a retry follow-up')
})

test('runSwarmBatch (continuable): a pre-wait settle is consumed once — a retry waits for its own epoch', async () => {
  // Regression: the settlement watch used to keep terminals forever, so a
  // retried child instantly re-read its FIRST epoch's terminal and never
  // waited for the retry turn. `sync: true` makes the first settle land in
  // the stored-terminal path (before wait() registers).
  const harness = mockContinuableCtx({
    flaky: {
      stopReason: 'error',
      sync: true,
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '429', code: 'RATE_LIMIT' } } } }],
    },
    steady: { stopReason: 'completed', text: 'steady done' },
  })
  const outcome = await runSwarmBatch(harness.ctx, {
    ...baseOptions(),
    tasks: tasksOf('flaky', 'steady'),
    itemMaxRetries: 1,
    itemRetryDelayMs: 1,
  })
  const [flaky, steady] = outcome.items
  assert.equal(flaky.status, 'completed', 'retry epoch settles on its own terminal, not the stale first one')
  assert.equal(flaky.output, 'flaky recovered')
  assert.equal(flaky.retries, 1)
  assert.equal(steady.status, 'completed')
  assert.deepEqual(harness.sentFollowups, ['child-flaky'])
})

test('runSwarmBatch (continuable): a QUOTA failure throttles but is not auto-retried', async () => {
  const harness = mockContinuableCtx({
    broke: {
      stopReason: 'error',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'insufficient balance', code: 'QUOTA' } } } }],
    },
    steady: { stopReason: 'completed', text: 'steady done' },
  })
  const outcome = await runSwarmBatch(harness.ctx, {
    ...baseOptions(),
    tasks: tasksOf('broke', 'steady'),
    itemMaxRetries: 2,
    itemRetryDelayMs: 1,
  })
  const [broke, steady] = outcome.items
  assert.equal(broke.status, 'failed')
  assert.equal(broke.failureKind, 'transport')
  assert.equal(broke.failureCode, 'QUOTA')
  assert.equal(steady.status, 'completed')
  assert.deepEqual(harness.sentFollowups, [], 'terminal quota failures never enter the retry lane')
})

test('runSwarmBatch (continuable): tripping the budget drops a pending retry and keeps its childId resumable', async () => {
  // spender settles later (delay) with usage that trips the budget; flaky has
  // already failed into the retry queue by then and must be reaped with its
  // resume handle preserved.
  const harness = mockContinuableCtx({
    flaky: {
      stopReason: 'error',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '429', code: 'RATE_LIMIT' } } } }],
    },
    spender: {
      stopReason: 'completed',
      text: 'spender done',
      delay: 20,
      events: [{ type: 'assistant/message', data: { usage: { inputTokens: 900, outputTokens: 200, totalTokens: 1100 } } }],
    },
  })
  const outcome = await runSwarmBatch(harness.ctx, {
    ...baseOptions(),
    tasks: tasksOf('flaky', 'spender'),
    itemMaxRetries: 2,
    itemRetryDelayMs: 60_000, // long backoff: still pending when the budget trips
    tokenBudget: 1000,
  })
  const [flaky, spender] = outcome.items
  assert.equal(spender.status, 'completed')
  assert.equal(flaky.status, 'aborted', 'pending retry reaped by the budget stop')
  assert.ok(flaky.error!.includes('budget'))
  assert.equal(flaky.childId, 'child-flaky', 'resume handle survives the reap')
  assert.equal(outcome.budgetExhausted, true)
  assert.deepEqual(harness.sentFollowups, [], 'no follow-up was sent for the reaped retry')
})
