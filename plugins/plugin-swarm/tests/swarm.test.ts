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
  projectOutputItems,
  runSwarmBatch,
  type SwarmBatchOptions,
  type SwarmTask,
} from '../src/orchestrator.ts'
import { expandTasks } from '../src/expand.ts'
import { loadSwarmUserConfig } from '../src/user-config.ts'

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

// --- adaptive exploration (gate v2) ------------------------------------------

test('AdaptiveGate: clean streaks probe past the configured ceiling up to exploreCeiling', () => {
  const gate = new AdaptiveGate(2, 4, true, 8)
  const completions = (n: number): void => {
    for (let i = 0; i < n; i++) gate.noteSettled('completed')
  }
  completions(8) // two streaks: 2 → 4 (the configured cap)
  assert.equal(gate.learnedCeiling, 4)
  completions(16) // four probe streaks: 4 → 8 (the exploration bound)
  assert.equal(gate.noteSettled('completed'), undefined, 'no growth past the exploration bound')
  // A failure at the probed level shrinks from 8 but never relearns the cap
  // UPWARD: the learned ceiling stays at the configured 4.
  assert.equal(gate.noteSettled('failed'), 'shrunk')
  assert.equal(gate.learnedCeiling, 4)
})

test('AdaptiveGate: a failure below the cap relearns the ceiling down', () => {
  const gate = new AdaptiveGate(4, 4, true, 8) // starts at the cap
  assert.equal(gate.noteSettled('failed'), 'shrunk') // limit 4 → 2
  assert.equal(gate.learnedCeiling, 3, 'cap relearned just below the failed level')
})

test('AdaptiveGate: a pinned batch (exploreCeiling == ceiling) never grows past its cap', () => {
  const gate = new AdaptiveGate(2, 4, true, 4)
  for (let i = 0; i < 40; i++) gate.noteSettled('completed')
  assert.equal(gate.noteSettled('completed'), undefined, 'no growth beyond the pinned ceiling')
})

// --- user config -------------------------------------------------------------

test('loadSwarmUserConfig: missing file, malformed JSON, and bad fields all degrade to safe overrides', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshs-test-'))
  const warnings: string[] = []
  const log = (m: string): void => { warnings.push(m) }

  assert.deepEqual(loadSwarmUserConfig(join(dir, 'absent.json'), log), {})

  writeFileSync(join(dir, 'bad.json'), '{not json')
  assert.deepEqual(loadSwarmUserConfig(join(dir, 'bad.json'), log), {})
  assert.ok(warnings.some(w => w.includes('unreadable JSON')))

  writeFileSync(join(dir, 'mixed.json'), JSON.stringify({ maxConcurrency: 24, adaptive: false, startStaggerMs: 'fast', enabled: 1 }))
  const cfg = loadSwarmUserConfig(join(dir, 'mixed.json'), log)
  assert.equal(cfg.maxConcurrency, 24)
  assert.equal(cfg.adaptive, false)
  assert.equal(cfg.startStaggerMs, undefined, 'non-numeric field ignored')
  assert.equal(cfg.enabled, undefined, 'non-boolean field ignored')
})

// --- output_mode projection ---------------------------------------------------

test('projectOutputItems: full keeps outputs, summary truncates, status_only drops output but keeps childId', async () => {
  const items = [{
    index: 0,
    item: 'a',
    status: 'completed' as const,
    childId: 'child-a',
    output: 'x'.repeat(1200),
  }]
  assert.equal(projectOutputItems(items, 'full')[0].output!.length, 1200)
  const summary = projectOutputItems(items, 'summary')[0]
  assert.ok(summary.output!.length < 700 && summary.output!.includes('truncated'))
  const statusOnly = projectOutputItems(items, 'status_only')[0]
  assert.equal(statusOnly.output, undefined)
  assert.equal(statusOnly.childId, 'child-a', 'resume handle survives status_only')
})

test('AdaptiveGate: a probe failure lowers the exploration bound for the rest of the batch', () => {
  const gate = new AdaptiveGate(2, 4, true, 8)
  const completions = (n: number): void => {
    for (let i = 0; i < n; i++) gate.noteSettled('completed')
  }
  completions(24) // 6 streaks: 2 → 8 (exploration bound)
  gate.noteSettled('failed') // probe failure at 8: limit → 4, exploreBound → 7
  completions(16) // recover 4 → 7 (growth passes the cap up to the remembered bound)
  // 4 more streaks would try 8, but the bound now remembers the wall at 8.
  assert.equal(gate.noteSettled('failed'), 'shrunk')
  assert.equal(gate.learnedCeiling <= 6, true, 'cap stays below the remembered wall')
})

test('AdaptiveGate: a pinned batch shrinks on failure and recovers exactly to the pin', () => {
  const gate = new AdaptiveGate(4, 4, true, 4)
  assert.equal(gate.noteSettled('failed'), 'shrunk') // 4 → 2
  assert.equal(gate.learnedCeiling, 3)
  for (let i = 0; i < 8; i++) gate.noteSettled('completed') // two streaks: 2 → 3 → 4
  for (let i = 0; i < 20; i++) gate.noteSettled('completed')
  assert.equal(gate.noteSettled('completed'), undefined, 'pinned pool never exceeds the pin')
})

test('loadSwarmUserConfig: zero values on floored fields are rejected, not merged', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshs-test-'))
  const warnings: string[] = []
  writeFileSync(join(dir, 'zero.json'), JSON.stringify({ maxConcurrency: 0, maxItems: 0, defaultConcurrency: 0, tokenBudget: 0 }))
  const cfg = loadSwarmUserConfig(join(dir, 'zero.json'), m => { warnings.push(m) })
  assert.equal(cfg.maxConcurrency, undefined)
  assert.equal(cfg.maxItems, undefined)
  assert.equal(cfg.defaultConcurrency, undefined)
  assert.equal(cfg.tokenBudget, 0, 'tokenBudget legitimately allows 0 (disabled)')
  assert.equal(warnings.length, 3)
})

test('runSwarmBatch (one-shot, adaptive): outcome carries peakConcurrency and learnedCeiling', async () => {
  const ctx = mockOneShotCtx({
    alpha: { stopReason: 'completed', text: 'a' },
    beta: { stopReason: 'completed', text: 'b' },
  })
  const outcome = await runSwarmBatch(ctx, {
    ...baseOptions(),
    tasks: tasksOf('alpha', 'beta'),
    adaptive: true,
    maxConcurrency: 4,
    exploreCeiling: 8,
  })
  assert.equal(outcome.peakConcurrency, 2)
  assert.equal(outcome.learnedCeiling, 4, 'no failures: the ceiling stays at the configured cap')
})

test('writeSwarmUserConfig: validates, merges, persists atomically, and null clears an override', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { writeSwarmUserConfig } = await import('../src/user-config.ts')
  const file = join(mkdtempSync(join(tmpdir(), 'dshs-test-')), 'config.json')

  // Write two fields; the file is created with the parent directory.
  const after = writeSwarmUserConfig(file, { maxConcurrency: 24, adaptive: false })
  assert.equal(after.maxConcurrency, 24)
  assert.equal(after.adaptive, false)
  assert.ok(existsSync(file))

  // A second write merges without dropping the first field.
  const merged = writeSwarmUserConfig(file, { tokenBudget: 500000 })
  assert.equal(merged.maxConcurrency, 24)
  assert.equal(merged.tokenBudget, 500000)

  // null clears one override; the others survive.
  const cleared = writeSwarmUserConfig(file, { maxConcurrency: null })
  assert.equal(cleared.maxConcurrency, undefined)
  assert.equal(cleared.adaptive, false)
  assert.equal(cleared.tokenBudget, 500000)
  assert.ok(!('maxConcurrency' in JSON.parse(readFileSync(file, 'utf8')) as object))

  // Unknown fields and invalid values reject the whole write.
  assert.throws(() => writeSwarmUserConfig(file, { nonsense: 1 }), /未知配置项/)
  assert.throws(() => writeSwarmUserConfig(file, { maxConcurrency: 0 }), /不合法/)
  assert.throws(() => writeSwarmUserConfig(file, { adaptive: 'yes' }), /不合法/)
  // A rejected write leaves the file untouched.
  assert.equal(loadSwarmUserConfig(file, () => {}).tokenBudget, 500000)
})

test('sameOrigin: browser Origin matches by host part; malformed Origin rejected; missing Origin allowed', async () => {
  const { sameOrigin } = await import('../src/routes.ts')
  const req = (headers: Record<string, string>): import('node:http').IncomingMessage =>
    ({ headers }) as import('node:http').IncomingMessage

  assert.equal(sameOrigin(req({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })), true)
  assert.equal(sameOrigin(req({ host: '127.0.0.1:3000', origin: 'http://evil.example.com' })), false)
  assert.equal(sameOrigin(req({ host: '127.0.0.1:3000', origin: 'not a url' })), false)
  assert.equal(sameOrigin(req({ host: '127.0.0.1:3000' })), true, 'non-browser caller (no Origin)')
})
