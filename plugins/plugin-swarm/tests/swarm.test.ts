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
import {
  projectSwarmConfig,
  readRetiredSwarmConfig,
  retireSwarmConfigFile,
  SWARM_CONFIG_FIELDS,
  SwarmConfigValidationError,
  validateSwarmConfigPatch,
} from '../src/user-config.ts'
import type { SwarmConfigEditor } from '../src/routes.ts'

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
  /** Child session events (turn/end failure facts read off the log). */
  readonly events?: readonly { type: string, data: unknown }[]
  /**
   * Provider-reported usage, as the kernel's `tokenUsage` projection would hold
   * it for this child's session by the time the child settles.
   */
  readonly usage?: { readonly inputTokens: number, readonly outputTokens: number }
  /**
   * Totals the same cell already holds when a resume is accepted: the epochs an
   * earlier batch already accounted. Absent means "none measured", which reads
   * as zero and overcounts them (the documented best-effort).
   */
  readonly priorUsage?: { readonly inputTokens: number, readonly outputTokens: number }
  /** Settle delay in ms (default 0); orders settlements across children. */
  readonly delay?: number
  /** Emit the terminal synchronously inside startContinuable (pre-wait). */
  readonly sync?: boolean
}

/**
 * Mock the one read `childUsage` makes of the kernel's projection service: each
 * mock child session is registered with the totals its real `tokenUsage` cell
 * would hold. An unregistered session (or key) answers `undefined`, mirroring
 * `stateOf` on a profile that does not carry the `token-meter` row.
 */
function mockSessionProjections() {
  const totals = new WeakMap<object, { uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }>()
  const set = (session: object, usage: { readonly inputTokens: number, readonly outputTokens: number } | undefined): void => {
    if (usage === undefined) totals.delete(session)
    else totals.set(session, { uncachedInputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })
  }
  return {
    service: {
      stateOf: (session: unknown, key: string) => {
        const registered = key === 'tokenUsage' ? totals.get(session as object) : undefined
        return registered === undefined ? undefined : { totals: registered }
      },
    },
    /** Register one mock child session with the usage its projection cell holds. */
    track: (session: object, spec: MockChild): object => {
      set(session, spec.usage)
      return session
    },
    /** Move one session's cell (a resumed epoch advances it past its baseline). */
    set,
  }
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
  const projections = mockSessionProjections()
  const ctx = {
    get: (name: string) => name === 'sessionProjections' ? projections.service : undefined,
    sessionProjections: projections.service,
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
          localAgent: { session: projections.track({ snapshotEvents: () => spec.events ?? [] }, spec) },
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
      usage: { inputTokens: 10, outputTokens: 5 },
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
  const usage = { inputTokens: 60, outputTokens: 40 }
  const ctx = mockOneShotCtx({
    a: { stopReason: 'completed', text: 'a', usage },
    b: { stopReason: 'completed', text: 'b', usage },
    c: { stopReason: 'completed', text: 'c', usage },
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
  const projections = mockSessionProjections()
  const sessions = new Map<string, object>()
  let launches = 0
  // One stable session object per child: the kernel answers every lookup with
  // the same instance, which is what makes its projection cell addressable.
  const sessionOf = (key: string): object | undefined => {
    const spec = children[key]
    if (spec === undefined) return undefined
    let session = sessions.get(key)
    if (session === undefined) {
      session = projections.track({ snapshotEvents: () => spec.events ?? [] }, spec)
      sessions.set(key, session)
    }
    return session
  }
  const ctx = {
    get: (name: string) => name === 'sessionProjections' ? projections.service : undefined,
    sessionProjections: projections.service,
    on: (event: string, listener: (info: unknown) => void) => {
      assert.equal(event, 'subagent/end')
      listeners.push(listener)
      return () => {}
    },
    agents: {
      get: (id: unknown) => {
        // Live-child lookup: the swarm addresses children as `child-<key>`.
        const session = sessionOf(String(id).replace(/^child-/, ''))
        return session === undefined ? undefined : { session }
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
        const session = sessionOf(key)
        // While the follow-up is accepted the cell still holds the epochs a
        // previous batch paid for; this epoch advances it before settling.
        if (session !== undefined) projections.set(session, children[key].priorUsage)
        // The retried child succeeds.
        setTimeout(() => {
          if (session !== undefined) projections.set(session, children[key].usage)
          emit(String(childId), { stopReason: 'completed', text: `${key} recovered` })
        }, 0)
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
      usage: { inputTokens: 900, outputTokens: 200 },
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

test('runSwarmBatch (continuable): a resumed epoch reports only its own usage', async () => {
  // The projection is cumulative over the child's whole session, so a retried
  // item has to subtract the totals its first epoch already reported —
  // otherwise every batch re-bills the tokens its predecessor paid for.
  const harness = mockContinuableCtx({
    flaky: {
      stopReason: 'error',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '429', code: 'RATE_LIMIT' } } } }],
      priorUsage: { inputTokens: 100, outputTokens: 20 },
      usage: { inputTokens: 300, outputTokens: 80 },
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
  assert.equal(flaky.status, 'completed')
  assert.equal(flaky.retries, 1)
  // 300/80 cumulative, 100/20 of it already accounted: this epoch is 200/60.
  assert.deepEqual(flaky.usage, { inputTokens: 200, outputTokens: 60, totalTokens: 260 })
  assert.equal(steady.usage, undefined, 'a child whose session carries no totals reports none')
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

// --- the settings-page config -------------------------------------------------

/** The shipped overlay row's values (plugins/dsh-app.patch.yml): what one layer yields. */
const LAYER = {
  enabled: true,
  maxItems: 64,
  defaultConcurrency: 8,
  maxConcurrency: 16,
  adaptive: true,
  itemMaxRetries: 2,
  itemRetryDelayMs: 15000,
  perItemOutputLimit: 4000,
  tokenBudget: 0,
  startStaggerMs: 1000,
}

/** The effective values here: the layer values with one knob already customized. */
const EFFECTIVE = { ...LAYER, maxItems: 32 }

test('validateSwarmConfigPatch: unknown fields, wrong types, and floors reject the whole patch', () => {
  assert.throws(() => validateSwarmConfigPatch({ nonsense: 1 }), { code: 'config.unknownField', params: { field: 'nonsense' } })
  assert.throws(() => validateSwarmConfigPatch({ maxConcurrency: 0 }), { code: 'config.belowMinimum', params: { field: 'maxConcurrency', minimum: 1 } })
  assert.throws(() => validateSwarmConfigPatch({ maxItems: 1 }), { code: 'config.belowMinimum', params: { field: 'maxItems', minimum: 2 } })
  assert.throws(() => validateSwarmConfigPatch({ perItemOutputLimit: 0 }), { code: 'config.belowMinimum', params: { field: 'perItemOutputLimit', minimum: 1 } })
  assert.throws(() => validateSwarmConfigPatch({ adaptive: 'yes' }), { code: 'config.notBoolean', params: { field: 'adaptive' } })
  assert.throws(() => validateSwarmConfigPatch({ enabled: 1 }), { code: 'config.notBoolean', params: { field: 'enabled' } })
  assert.deepEqual(validateSwarmConfigPatch({ tokenBudget: 0 }), { tokenBudget: 0 }, 'the budget legitimately allows 0 (disabled)')
  assert.deepEqual(validateSwarmConfigPatch({ maxConcurrency: 12.6 }), { maxConcurrency: 12 }, 'a fractional count floors')
  assert.deepEqual(validateSwarmConfigPatch({ maxItems: null }), { maxItems: null }, 'null is how the page clears a value')
})

test('projectSwarmConfig: a one-field patch carries every editable field and leaks no schema default', () => {
  const next = projectSwarmConfig({ provider: 'spawn', maxDepth: 1 }, LAYER, { adaptive: false }, EFFECTIVE)
  assert.equal(next.adaptive, false, 'the named field takes the written value')
  assert.equal(next.maxItems, 32, 'an unnamed field keeps the effective value, not the schema default 8')
  assert.equal(next.maxConcurrency, 16, 'nor the schema default 8')
  assert.equal(next.startStaggerMs, 1000, 'nor the schema default 800')
  assert.equal(next.provider, 'spawn', 'structural fields survive the row replacement')
  assert.equal(next.maxDepth, 1)
  for (const field of SWARM_CONFIG_FIELDS) assert.ok(field in next, `${field} must travel with every write`)
})

test('projectSwarmConfig: a cleared field returns to the layer value, or to the schema default when no layer sets it', () => {
  const cleared = projectSwarmConfig({ provider: 'spawn' }, LAYER, { maxItems: null }, EFFECTIVE)
  assert.equal(cleared.maxItems, 64, 'null means "back to the shipped value", not "keep the customization"')
  const dropped = projectSwarmConfig({ provider: 'spawn' }, {}, { enabled: null }, EFFECTIVE)
  assert.ok(!Object.hasOwn(dropped, 'enabled'), 'with no layer value to return to, the schema default is the deployment value')
})

test('readRetiredSwarmConfig: a missing, malformed, or partial store degrades to what it can import', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshs-test-'))
  const warnings: string[] = []
  const log = (m: string): void => { warnings.push(m) }

  assert.equal(readRetiredSwarmConfig(join(dir, 'absent.json'), log), undefined, 'no store: nothing to import')

  writeFileSync(join(dir, 'bad.json'), '{not json')
  assert.equal(readRetiredSwarmConfig(join(dir, 'bad.json'), log), undefined)
  assert.ok(warnings.some(w => w.includes('unreadable JSON')))

  writeFileSync(join(dir, 'list.json'), '[1, 2]')
  assert.equal(readRetiredSwarmConfig(join(dir, 'list.json'), log), undefined)
  assert.ok(warnings.some(w => w.includes('expected a JSON object')))

  writeFileSync(join(dir, 'mixed.json'), JSON.stringify({ maxConcurrency: 24, adaptive: false, startStaggerMs: 'fast', enabled: 1 }))
  const imported = readRetiredSwarmConfig(join(dir, 'mixed.json'), log)
  assert.deepEqual(imported, { maxConcurrency: 24, adaptive: false }, 'only usable values travel')
  assert.ok(warnings.some(w => w.includes('"startStaggerMs"')), 'a non-numeric field is reported, not imported')
  assert.ok(warnings.some(w => w.includes('"enabled"')), 'a non-boolean field is reported, not imported')
})

test('retireSwarmConfigFile: the retired store is renamed aside and kept verbatim', async () => {
  const { existsSync, mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshs-test-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, '{"maxItems": 32}', 'utf8')

  const movedTo = retireSwarmConfigFile(file)
  assert.ok(movedTo !== undefined, 'the file must be moved aside, never deleted')
  assert.equal(existsSync(file), false, 'the old path is free, so the import cannot run twice')
  assert.equal(readFileSync(movedTo, 'utf8'), '{"maxItems": 32}', "the user's own file survives verbatim")
  assert.equal(retireSwarmConfigFile(join(dir, 'gone.json')), undefined, 'a missing file is not an error')
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

// --- host-message codes (the settings page owns the copy) ----------------------

/** The Han range: a wire payload must never carry one — the client renders copy. */
const HAN = /[\u4e00-\u9fff]/

test('SwarmConfigValidationError: the wire form is a code, its params, and an English diagnostic', () => {
  const reject = (patch: Record<string, unknown>): SwarmConfigValidationError => {
    try {
      validateSwarmConfigPatch(patch)
    } catch (error) {
      assert.ok(error instanceof SwarmConfigValidationError, 'the write must be rejected by the coded error')
      return error
    }
    throw new Error('expected the write to be rejected')
  }

  assert.deepEqual(reject({ nonsense: 1 }).hostText(), {
    code: 'config.unknownField',
    params: { field: 'nonsense' },
    text: 'unknown config field "nonsense"',
  })
  assert.deepEqual(reject({ adaptive: 'yes' }).hostText(), {
    code: 'config.notBoolean',
    params: { field: 'adaptive' },
    text: '"adaptive" must be a boolean',
  })
  assert.deepEqual(reject({ maxItems: 1 }).hostText(), {
    code: 'config.belowMinimum',
    params: { field: 'maxItems', minimum: 2 },
    text: '"maxItems" must be a number >= 2',
  })
  // The point of the contract: no Chinese prose crosses to the client, and an
  // unknown code still has an English diagnostic to fall back to.
  for (const patch of [{ nonsense: 1 }, { adaptive: 'yes' }, { maxItems: 1 }]) {
    const host = reject(patch).hostText()
    assert.ok(!HAN.test(JSON.stringify(host)), 'the wire form must contain no Han characters')
    assert.ok((host.text ?? '') !== '')
  }
})

// --- the settings route over a fake config editor ------------------------------

/** One mounted settings route plus the configs its fake editor was asked to store. */
interface MountedRoutes {
  /** GET /config. */
  get(): Promise<Response>
  /** POST /config with a raw body (the unparsable case needs one). */
  post(body: string): Promise<Response>
  /** What the change callbacks derived, in call order: exactly what would be stored. */
  readonly writes: Record<string, unknown>[]
  /** The path the fake editor reports as its document. */
  readonly documentPath: string
}

/**
 * Mount the settings route over a fake Connection exact-Fetch registry.
 *
 * The editor fake mirrors the kernel's `configEditor`: it hands the change
 * callback the raw config the entry currently carries and the config the layers
 * alone yield, and records what the callback derived — which is what would land
 * in the profile patch.
 *
 * @param options - host variations: a failing editor, or a host with none.
 * @returns the mounted route and what it stored.
 */
async function mountRoutes(options: { failing?: boolean, editorless?: boolean } = {}): Promise<MountedRoutes> {
  const { registerSwarmRoutes, ROUTE_PREFIX } = await import('../src/routes.ts')
  const documentPath = 'C:/dsh-home/profiles/ds.app/cordis.patch.yml'
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const writes: Record<string, unknown>[] = []
  const editor: SwarmConfigEditor = {
    documentPath,
    edit: async (_entry, change) => {
      if (options.failing === true) throw new Error('EACCES: permission denied, open profile/cordis.patch.yml')
      writes.push(change({ provider: 'spawn', maxDepth: 1 }, LAYER))
    },
  }
  registerSwarmRoutes({
    register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => {
      handlers.set(route.path, route.fetch)
      return Promise.resolve(async () => { handlers.delete(route.path) })
    },
  }, {
    live: () => EFFECTIVE,
    layerDefaults: () => LAYER,
    entry: () => ({ options: { id: 'swarm' } }),
    ...(options.editorless === true ? {} : { editor }),
  })
  const handler = handlers.get(`${ROUTE_PREFIX}/config`)
  assert.ok(handler !== undefined, 'the config route must be registered')
  return {
    writes,
    documentPath,
    get: () => handler(new Request(`dsh-app://app${ROUTE_PREFIX}/config`)),
    post: (body) => handler(new Request(`dsh-app://app${ROUTE_PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })),
  }
}

test('swarm routes: a one-field save writes every editable field, so untouched knobs keep the shipped value', async () => {
  const routes = await mountRoutes()
  const saved = await routes.post(JSON.stringify({ adaptive: false }))
  assert.equal(saved.status, 200)
  assert.equal(routes.writes.length, 1)
  const written = routes.writes[0]

  // The profile row REPLACES the overlay's config, so a field left out of the
  // write falls back to the SCHEMA default — maxItems 8, pool 4, stagger 800 —
  // and silently retunes a knob the user never touched.
  for (const field of SWARM_CONFIG_FIELDS) assert.ok(field in written, `${field} must travel with every write`)
  assert.equal(written.adaptive, false, 'the written field takes the new value')
  assert.equal(written.maxItems, 32, 'the effective value, never the schema default 8')
  assert.equal(written.maxConcurrency, 16, 'the layer value, never the schema default 8')
  assert.equal(written.startStaggerMs, 1000, 'the layer value, never the schema default 800')
  assert.equal(written.provider, 'spawn', 'structural fields survive the row replacement')
  assert.equal(written.maxDepth, 1)
})

test('swarm routes: a cleared field returns to the layer value, and GET reports defaults, changes, and effective values', async () => {
  const routes = await mountRoutes()
  await routes.post(JSON.stringify({ maxItems: null, adaptive: false }))
  assert.equal(routes.writes[0].maxItems, LAYER.maxItems, 'clearing returns the shipped value')
  assert.equal(routes.writes[0].adaptive, false, 'the other field of the same patch still applies')

  const body = await (await routes.get()).json() as { value: { defaults: Record<string, number | boolean>, overrides: Record<string, number | boolean>, effective: Record<string, number | boolean>, filePath: string } }
  assert.deepEqual(body.value.overrides, { maxItems: 32 }, 'only the field that differs from the layer is a customization')
  assert.equal(body.value.defaults.maxItems, 64)
  assert.equal(body.value.effective.maxItems, 32)
  assert.equal(body.value.effective.startStaggerMs, 1000)
  assert.equal(body.value.filePath, routes.documentPath)
})

test('swarm routes: every failure answers a coded host message, never Chinese prose', async () => {
  const rejected = await (await mountRoutes()).post(JSON.stringify({ nonsense: 1 }))
  assert.equal(rejected.status, 400)
  const rejectedText = await rejected.text()
  assert.deepEqual(
    (JSON.parse(rejectedText) as { error: { code: string, host: unknown } }).error,
    {
      code: 'bad-request',
      message: 'unknown config field "nonsense"',
      host: { code: 'config.unknownField', params: { field: 'nonsense' }, text: 'unknown config field "nonsense"' },
    },
  )
  assert.ok(!HAN.test(rejectedText), 'a rejected write must not answer with a Chinese sentence')

  const unparsable = await (await mountRoutes()).post('{not json')
  assert.equal(unparsable.status, 400)
  const unparsableBody = await unparsable.json() as { error: { host: { code: string } } }
  assert.equal(unparsableBody.error.host.code, 'route.invalidBody')
  assert.ok(!HAN.test(JSON.stringify(unparsableBody)))

  // A profile patch the kernel cannot write: the 500 is a coded message too
  // (it used to be a Chinese sentence). The diagnostic is the fs error itself —
  // it carries a path, so only the code is asserted.
  const unwritable = await (await mountRoutes({ failing: true })).post(JSON.stringify({ adaptive: false }))
  assert.equal(unwritable.status, 500)
  const unwritableBody = await unwritable.json() as { error: { code: string, host: { code: string, text: string } } }
  assert.equal(unwritableBody.error.code, 'io')
  assert.equal(unwritableBody.error.host.code, 'route.writeFailed')
  assert.ok(unwritableBody.error.host.text !== '', 'the fallback diagnostic must not be empty')

  // A host with no config editor cannot persist at all: say so instead of
  // answering a save that never happened.
  const editorless = await mountRoutes({ editorless: true })
  const refused = await editorless.post(JSON.stringify({ adaptive: false }))
  assert.equal(refused.status, 503)
  assert.equal((await refused.json() as { error: { host: { code: string } } }).error.host.code, 'route.noEditor')
  assert.equal(editorless.writes.length, 0)
  assert.equal((await (await editorless.get()).json() as { value: { filePath: string } }).value.filePath, '', 'no editor, no path to show')
})

// --- plugin shape guards -------------------------------------------------------

test('plugin shape: settle-time session reads declare the agents service in inject', async () => {
  const plugin = await import('../src/index.ts')
  assert.ok(
    (plugin.inject as readonly string[]).includes('agents'),
    'liveChildSession reads ctx.agents after children settle; an undeclared access throws '
    + 'cordis "without inject" and marks every settled item failed',
  )
})
