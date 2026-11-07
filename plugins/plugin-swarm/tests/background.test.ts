/**
 * Unit tests for the detached (background-job) execution lane: mode
 * resolution, job registration, the ring/progress contract, cancellation, the
 * report byte budget, and the delivery switch that silences the fresh
 * children's notices in favour of the batch's aggregate report.
 *
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-swarm/tests/background
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  SWARM_OUTPUT_LIMIT_BYTES,
  SWARM_REPORT_BYTES,
  clampUtf8,
  isPtcNestedCall,
  resolveExecutionMode,
  startSwarmBackground,
  type SwarmJobHandle,
  type SwarmJobHooks,
  type SwarmJobSpec,
  type SwarmJobs,
} from '../src/background.ts'
import type { SwarmBatchOutcome } from '../src/orchestrator.ts'

// --- mode resolution ---------------------------------------------------------

test('isPtcNestedCall: only the executor-built nested call id counts', () => {
  // `dsh-tool-executor-ptc` mints `${parentCallId}:ptc:${n}` for a nested call.
  assert.equal(isPtcNestedCall('session-turn-4:toolu_abc:ptc:2'), true)
  assert.equal(isPtcNestedCall('toolu_abc'), false)
  assert.equal(isPtcNestedCall(undefined), false)
})

test('resolveExecutionMode: auto detaches only inside run_code, and only while enabled', () => {
  assert.equal(resolveExecutionMode(undefined, 'toolu_abc:ptc:1', true), 'background')
  assert.equal(resolveExecutionMode('auto', 'toolu_abc:ptc:1', true), 'background')
  assert.equal(resolveExecutionMode(undefined, 'toolu_abc:ptc:1', false), 'inline')
  assert.equal(resolveExecutionMode(undefined, 'toolu_abc', true), 'inline')
  // An explicit request always wins: the model knows more than the heuristic.
  assert.equal(resolveExecutionMode('inline', 'toolu_abc:ptc:1', true), 'inline')
  assert.equal(resolveExecutionMode('background', 'toolu_abc', true), 'background')
})

// --- harness -----------------------------------------------------------------

interface FakeChild {
  readonly stopReason: string
  readonly text?: string
  /** Defer this child's settlement by ms (0 settles on the next tick). */
  readonly delay?: number
}

interface FakeHarness {
  readonly ctx: Context
  /** The `delivery` each child activation asked for. */
  readonly deliveries: (string | undefined)[]
  /** Child ids the batch interrupted on abort. */
  readonly interrupted: string[]
}

function continuationCtx(children: Record<string, FakeChild>): FakeHarness {
  const listeners: ((info: unknown) => void)[] = []
  const deliveries: (string | undefined)[] = []
  const interrupted: string[] = []
  const ctx = {
    get: () => undefined,
    on: (event: string, listener: (info: unknown) => void) => {
      assert.equal(event, 'subagent/end')
      listeners.push(listener)
      return () => {}
    },
    agents: {
      get: (id: unknown) => {
        const key = String(id).replace(/^child-/, '')
        return children[key] === undefined ? undefined : { session: { snapshotEvents: () => [] } }
      },
    },
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startActivation: async (spec: { request: { prompt: readonly { text: string }[] }, delivery?: string }) => {
        deliveries.push(spec.delivery)
        const text = spec.request.prompt[0].text
        const key = Object.keys(children).find(candidate => text.includes(candidate))
        assert.ok(key !== undefined, `no mock child for prompt "${text}"`)
        const childId = `child-${key}`
        setTimeout(() => {
          for (const listener of listeners) {
            listener({
              id: childId,
              stopReason: children[key].stopReason,
              lastAssistantMessage: children[key].text === undefined ? undefined : [{ type: 'text', text: children[key].text }],
            })
          }
        }, children[key].delay ?? 0)
        return { childId, messageId: 'm1', result: new Promise(() => {}), dispose: async () => {} }
      },
      sendMessage: async () => 'm2',
      interrupt: (id: unknown) => { interrupted.push(String(id)) },
    },
    logger: { warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, deliveries, interrupted }
}

interface FakeJob {
  readonly spec: SwarmJobSpec
  readonly hooks: SwarmJobHooks
  readonly appends: { readonly text: string, readonly channel?: string }[]
  readonly progress: string[]
}

/** Minimal registry: registers synchronously and remembers what it was given. */
function fakeJobs(): { readonly jobs: SwarmJobs, readonly started: FakeJob[] } {
  const started: FakeJob[] = []
  const jobs: SwarmJobs = {
    start(spec) {
      const appends: { text: string, channel?: string }[] = []
      const progress: string[] = []
      const handle: SwarmJobHandle = {
        append: (text, options) => { appends.push({ text, ...options === undefined ? {} : { channel: options.channel } }) },
        updateProgress: (line) => { progress.push(line) },
      }
      const hooks = spec.run(handle)
      started.push({ spec, hooks, appends, progress })
      return `swarm-${started.length}`
    },
  }
  return { jobs, started }
}

const PARENT = { id: 'parent-session' } as unknown as Agent

/** Batch options for two fresh items; the orchestrator's own defaults apply. */
function batchOf(items: readonly string[]): Parameters<typeof startSwarmBackground>[0]['batch'] {
  return {
    provider: 'spawn',
    parent: PARENT,
    label: 'test batch',
    tasks: items.map((item, index) => ({ index, item, prompt: `do ${item}` })),
    concurrency: 2,
    outputLimit: 4000,
    startStaggerMs: 0,
  }
}

/** Report renderer stand-in: the real one lives in `index.ts`. */
const render = (outcome: SwarmBatchOutcome, _warnings?: readonly string[], _budget?: number): string =>
  `swarm "${outcome.label}": ${outcome.completed} completed, ${outcome.failed} failed, ${outcome.aborted} aborted\n${outcome.items.map(item => `[${item.index}] ${item.status}`).join('\n')}`

// --- registration ------------------------------------------------------------

test('startSwarmBackground: registers one session-owned swarm job and returns at once', async () => {
  const harness = continuationCtx({ alpha: { stopReason: 'completed', text: 'alpha done' }, beta: { stopReason: 'completed', text: 'beta done', delay: 5 } })
  const { jobs, started } = fakeJobs()
  const { jobId } = startSwarmBackground({
    ctx: harness.ctx,
    jobs,
    parent: PARENT,
    batch: batchOf(['alpha', 'beta']),
    warnings: [],
    callId: 'toolu_abc:ptc:1',
    render,
  })

  assert.equal(jobId, 'swarm-1')
  // Nothing has settled yet, and the call did not wait for anything.
  assert.equal(started.length, 1)
  assert.equal(started[0].spec.kind, 'swarm')
  assert.equal(started[0].spec.label, 'test batch')
  // The job belongs to the SESSION, which is what lets it outlive the call.
  assert.equal(started[0].spec.owner, 'parent-session')
  // The cap is the module's own fixed constant, strictly above the report
  // budget so the kernel's tail-keeping truncation never reaches a report this
  // producer built.
  assert.equal(started[0].spec.outputLimitBytes, SWARM_OUTPUT_LIMIT_BYTES)
  assert.ok((started[0].spec.outputLimitBytes ?? 0) > SWARM_REPORT_BYTES)
  assert.deepEqual(started[0].spec.toolCall, { toolName: 'swarm', callId: 'toolu_abc:ptc:1' })
  assert.deepEqual(started[0].progress, ['0/2 settled'])
  assert.equal(started[0].appends.length, 0)
})

// Fresh children only: `sendMessage` carries no delivery policy, so a resumed
// child keeps the one it was created with (see the module header).
test('startSwarmBackground: fresh children settle to the CALLER, so their per-child notices are silenced', async () => {
  const harness = continuationCtx({ alpha: { stopReason: 'completed', text: 'a' }, beta: { stopReason: 'completed', text: 'b' } })
  const { jobs, started } = fakeJobs()
  startSwarmBackground({ ctx: harness.ctx, jobs, parent: PARENT, batch: batchOf(['alpha', 'beta']), warnings: [], render })
  await started[0].hooks.done
  assert.deepEqual(harness.deliveries, ['caller', 'caller'])
})

// --- settlement --------------------------------------------------------------

test('startSwarmBackground: the report lands as ONE model-facing write, details on the observer channel', async () => {
  const harness = continuationCtx({ alpha: { stopReason: 'completed', text: 'a' }, beta: { stopReason: 'failed', text: 'b' } })
  const { jobs, started } = fakeJobs()
  const { jobId } = startSwarmBackground({ ctx: harness.ctx, jobs, parent: PARENT, batch: batchOf(['alpha', 'beta']), warnings: [], render })
  const outcome = await started[0].hooks.done

  assert.equal(jobId, 'swarm-1')
  assert.equal(outcome.status, 'completed')
  assert.ok(outcome.detail?.startsWith('swarm "test batch": 1 completed, 1 failed'), outcome.detail)

  const stdout = started[0].appends.filter(entry => entry.channel === undefined).map(entry => entry.text)
  const log = started[0].appends.filter(entry => entry.channel === 'log')
  assert.equal(stdout.length, 1, 'the model-facing ring must receive exactly one write')
  assert.ok(stdout[0].includes('[0] completed') && stdout[0].includes('[1] failed'))
  // Per-item lines are for the job-list observer, never the model.
  assert.deepEqual(log.map(entry => entry.text), ['[0] completed · alpha\n', '[1] failed · beta\n'])
  assert.deepEqual(started[0].progress, ['0/2 settled', '1/2 settled', '2/2 settled · [1] failed'])
})

test('startSwarmBackground: every child failing settles the job as failed, like the synchronous tool error', async () => {
  const harness = continuationCtx({ alpha: { stopReason: 'refusal', text: 'no' }, beta: { stopReason: 'refusal', text: 'no' } })
  const { jobs, started } = fakeJobs()
  startSwarmBackground({ ctx: harness.ctx, jobs, parent: PARENT, batch: batchOf(['alpha', 'beta']), warnings: [], render })
  const outcome = await started[0].hooks.done
  assert.equal(outcome.status, 'failed')
})

test('startSwarmBackground: cancel aborts on the job-owned controller and interrupts the children', async () => {
  const harness = continuationCtx({ alpha: { stopReason: 'completed', text: 'a', delay: 60_000 }, beta: { stopReason: 'completed', text: 'b', delay: 60_000 } })
  const { jobs, started } = fakeJobs()
  startSwarmBackground({ ctx: harness.ctx, jobs, parent: PARENT, batch: batchOf(['alpha', 'beta']), warnings: [], render })
  // Let the launch reach `startActivation`; a cancel before any child exists has
  // nothing to interrupt (the workers then exit on the aborted signal).
  await new Promise(resolve => setTimeout(resolve, 10))

  started[0].hooks.cancel('job killed by user')
  const outcome = await started[0].hooks.done

  assert.equal(outcome.status, 'killed')
  assert.ok(outcome.detail?.endsWith('cancelled'), outcome.detail)
  assert.deepEqual([...harness.interrupted].sort(), ['child-alpha', 'child-beta'])
})

test('startSwarmBackground: a broken batch settles the job instead of rejecting it', async () => {
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    agents: { get: () => undefined },
    subagents: {
      // A provider that cannot be resolved makes the orchestrator throw before
      // any child starts.
      getProvider: () => undefined,
      startActivation: async () => { throw new Error('unreachable') },
      sendMessage: async () => 'm',
      interrupt: () => {},
    },
    logger: { warn: () => {} },
  } as unknown as Context
  const { jobs, started } = fakeJobs()
  startSwarmBackground({ ctx, jobs, parent: PARENT, batch: batchOf(['alpha', 'beta']), warnings: [], render })
  const outcome = await started[0].hooks.done
  // A missing provider falls back to the one-shot path, whose activation throws
  // for every item: the job settles `failed` instead of rejecting a producer
  // promise the registry would have to launder into a warning.
  assert.equal(outcome.status, 'failed')
  assert.ok(outcome.detail?.startsWith('swarm "test batch"'), outcome.detail)
})

test('startSwarmBackground: a broken batch settles inside the same byte budget', async () => {
  // `ctx.on` throwing makes the orchestrator's settlement watch fail before any
  // child starts, which is the path the tool cannot see: the job still has to
  // report something the model can read, bounded like the report.
  const ctx = {
    get: () => undefined,
    on: () => { throw new Error('settlement watch unavailable') },
    agents: { get: () => undefined },
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startActivation: async () => { throw new Error('unreachable') },
      sendMessage: async () => 'm',
      interrupt: () => {},
    },
    logger: { warn: () => {} },
  } as unknown as Context
  const { jobs, started } = fakeJobs()
  startSwarmBackground({
    ctx,
    jobs,
    parent: PARENT,
    batch: { ...batchOf(['alpha', 'beta']), label: 'L'.repeat(4000) },
    warnings: [],
    render,
  })
  const outcome = await started[0].hooks.done
  assert.equal(outcome.status, 'failed')
  const written = started[0].appends.map(entry => entry.text).join('')
  assert.ok(written.includes('failed before settlement'), 'the failure must be stated')
  assert.ok(
    Buffer.byteLength(written, 'utf8') <= SWARM_REPORT_BYTES,
    'the failure text must respect the report budget',
  )
})

test('clampUtf8: a byte cut never invents a replacement character, nor deletes a real one', () => {
  // A cut inside a multi-byte sequence must round down, not decode to U+FFFD.
  assert.equal(clampUtf8('输出', 4), '输')
  assert.equal(clampUtf8('输出', 6), '输出')
  // A U+FFFD the text legitimately contains — including at the end — survives,
  // because a `fatal` decoder only rejects an incomplete tail.
  assert.equal(clampUtf8('\uFFFDabcdef', 3), '\uFFFD')
  assert.equal(clampUtf8('a\uFFFD', 4), 'a\uFFFD')
  assert.equal(clampUtf8('abc', 0), '')
})
