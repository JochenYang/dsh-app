/**
 * Unit tests for the live swarm board: the in-memory registry the right
 * Sidebar tab reads, and the two board routes on the Connection exact-Fetch
 * registry.
 *
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-swarm/tests/board
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../src/board.ts'
import type { SwarmBatchOutcome, SwarmItemOutcome } from '../src/orchestrator.ts'
import { registerSwarmRoutes, ROUTE_PREFIX } from '../src/routes.ts'
import type { SwarmBoardSnapshot } from '../src/board-types.ts'

const SESSION = 'session-1'

/** One settled item with a few optional facts. */
function item(over: Partial<SwarmItemOutcome> & Pick<SwarmItemOutcome, 'index' | 'item' | 'status'>): SwarmItemOutcome {
  return over
}

/** One aggregate batch outcome. */
function outcome(items: readonly SwarmItemOutcome[]): SwarmBatchOutcome {
  return {
    label: 'audit',
    concurrency: 2,
    total: items.length,
    completed: items.filter(entry => entry.status === 'completed').length,
    failed: items.filter(entry => entry.status === 'failed').length,
    aborted: items.filter(entry => entry.status === 'aborted').length,
    durationMs: 1234,
    ...items.some(entry => entry.usage !== undefined)
      ? { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
      : {},
    items,
  }
}

test('board: begin records every worker as waiting and opens the feed', () => {
  const board = new SwarmBoard()
  const batchId = board.begin({
    sessionId: SESSION,
    label: 'audit',
    mode: 'inline',
    childMode: 'continuable',
    concurrency: 2,
    tasks: [{ index: 0, item: 'alpha' }, { index: 1, item: 'beta' }],
  })
  const snapshot = board.snapshot(SESSION)
  assert.equal(snapshot.batches.length, 1)
  const batch = snapshot.batches[0]
  assert.equal(batch.id, batchId)
  assert.equal(batch.status, 'running')
  assert.equal(batch.total, 2)
  assert.deepEqual(batch.workers.map(worker => worker.status), ['waiting', 'waiting'])
  assert.equal(batch.events.length, 1)
  assert.equal(batch.events[0]?.type, 'batch-started')
})

test('board: progress updates a worker, keeps a bounded preview, and settles the counters', () => {
  const board = new SwarmBoard()
  const batchId = board.begin({
    sessionId: SESSION,
    label: 'audit',
    mode: 'inline',
    childMode: 'continuable',
    concurrency: 2,
    tasks: [{ index: 0, item: 'alpha' }, { index: 1, item: 'beta' }],
  })
  board.observe(SESSION, batchId, { type: 'item-started', index: 0, item: 'alpha' })
  board.observe(SESSION, batchId, {
    type: 'item-settled',
    outcome: item({
      index: 0,
      item: 'alpha',
      status: 'completed',
      durationMs: 400,
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      output: `${'x'.repeat(400)} tail`,
    }),
  })
  board.settle(SESSION, batchId, outcome([
    item({
      index: 0,
      item: 'alpha',
      status: 'completed',
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    }),
    item({ index: 1, item: 'beta', status: 'failed', failureKind: 'content', error: 'refused' }),
  ]))

  const batch = board.snapshot(SESSION).batches[0]!
  assert.equal(batch.status, 'failed')
  assert.equal(batch.completed, 1)
  assert.equal(batch.failed, 1)
  assert.equal(batch.tokens, 12)
  const alpha = batch.workers.find(worker => worker.index === 0)!
  assert.equal(alpha.status, 'completed')
  assert.equal(alpha.tokens, 12)
  assert.ok(alpha.outputPreview !== undefined && alpha.outputPreview.length <= 240)
  const beta = batch.workers.find(worker => worker.index === 1)!
  assert.equal(beta.status, 'failed')
  assert.equal(beta.failureKind, 'content')
  assert.equal(beta.error, 'refused')
  // The closing event is the last one the feed carries.
  assert.equal(batch.events[batch.events.length - 1]?.type, 'batch-settled')
})

test('board: cancel requests reach the batch controller and settle as cancelled', () => {
  const board = new SwarmBoard()
  const reasons: string[] = []
  const batchId = board.begin({
    sessionId: SESSION,
    label: 'audit',
    mode: 'inline',
    childMode: 'continuable',
    concurrency: 1,
    tasks: [{ index: 0, item: 'alpha' }],
  })
  board.attachCancel(SESSION, batchId, (reason) => { reasons.push(reason) })
  assert.equal(board.cancel(SESSION, batchId), true)
  assert.deepEqual(reasons, ['cancelled from the swarm board'])
  const requested = board.snapshot(SESSION).batches[0]!
  assert.equal(requested.cancelRequested, true)
  assert.equal(requested.status, 'running')
  assert.ok(requested.events.some(event => event.type === 'batch-cancel-requested'))

  board.settle(SESSION, batchId, outcome([item({ index: 0, item: 'alpha', status: 'aborted' })]))
  const settled = board.snapshot(SESSION).batches[0]!
  assert.equal(settled.status, 'cancelled')
  assert.equal(settled.aborted, 1)
  // A settled batch refuses a second cancel.
  assert.equal(board.cancel(SESSION, batchId), false)
})

test('board: a missing session is an empty snapshot, never an error', () => {
  const board = new SwarmBoard()
  const snapshot = board.snapshot('nobody')
  assert.equal(snapshot.sessionId, 'nobody')
  assert.deepEqual(snapshot.batches, [])
  assert.equal(typeof snapshot.now, 'number')
})

// --- routes -----------------------------------------------------------------

function mountBoardRoutes(board: SwarmBoard): {
  get: (query: string) => Promise<Response>
  cancel: (body: string) => Promise<Response>
} {
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  registerSwarmRoutes({
    register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => {
      handlers.set(route.path, route.fetch)
      return Promise.resolve(async () => { handlers.delete(route.path) })
    },
  }, {
    live: () => ({
      enabled: true,
      adaptive: true,
      backgroundInPtc: true,
      defaultConcurrency: 4,
      maxConcurrency: 8,
      maxItems: 8,
      startStaggerMs: 800,
      itemMaxRetries: 2,
      itemRetryDelayMs: 15000,
      perItemOutputLimit: 4000,
      tokenBudget: 0,
    }),
    layerDefaults: () => undefined,
    entry: () => undefined,
    board: {
      snapshot: (sessionId) => board.snapshot(sessionId),
      cancel: (sessionId, batchId) => board.cancel(sessionId, batchId),
    },
  })
  const get = handlers.get(`${ROUTE_PREFIX}/board`)
  const cancel = handlers.get(`${ROUTE_PREFIX}/board/cancel`)
  assert.ok(get !== undefined, 'the board read route must be registered')
  assert.ok(cancel !== undefined, 'the board cancel route must be registered')
  return {
    get: (query) => get(new Request(`dsh-app://app${ROUTE_PREFIX}/board${query}`)),
    cancel: (body) => cancel(new Request(`dsh-app://app${ROUTE_PREFIX}/board/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })),
  }
}

test('board route: GET returns the session snapshot and refuses a missing session id', async () => {
  const board = new SwarmBoard()
  board.begin({
    sessionId: SESSION,
    label: 'audit',
    mode: 'inline',
    childMode: 'continuable',
    concurrency: 1,
    tasks: [{ index: 0, item: 'alpha' }],
  })
  const routes = mountBoardRoutes(board)
  const okResponse = await routes.get(`?session=${SESSION}`)
  assert.equal(okResponse.status, 200)
  const body = await okResponse.json() as { ok: boolean, value: SwarmBoardSnapshot }
  assert.equal(body.ok, true)
  assert.equal(body.value.batches.length, 1)

  const missing = await routes.get('')
  assert.equal(missing.status, 400)
  const missingBody = await missing.json() as { error: { host: { code: string } } }
  assert.equal(missingBody.error.host.code, 'route.invalidSession')
  assert.ok(!/[\u4e00-\u9fff]/u.test(JSON.stringify(missingBody)), 'a host failure must not carry Chinese prose')
})

test('board route: POST cancel rejects an unknown batch and forwards a known one', async () => {
  const board = new SwarmBoard()
  const batchId = board.begin({
    sessionId: SESSION,
    label: 'audit',
    mode: 'inline',
    childMode: 'continuable',
    concurrency: 1,
    tasks: [{ index: 0, item: 'alpha' }],
  })
  let cancelled = false
  board.attachCancel(SESSION, batchId, () => { cancelled = true })
  const routes = mountBoardRoutes(board)

  const unknown = await routes.cancel(JSON.stringify({ sessionId: SESSION, batchId: 'missing' }))
  assert.equal(unknown.status, 404)
  const unknownBody = await unknown.json() as { error: { host: { code: string } } }
  assert.equal(unknownBody.error.host.code, 'route.unknownBatch')

  const known = await routes.cancel(JSON.stringify({ sessionId: SESSION, batchId }))
  assert.equal(known.status, 200)
  assert.equal(cancelled, true)
  const knownBody = await known.json() as { value: SwarmBoardSnapshot }
  assert.equal(knownBody.value.batches[0]?.cancelRequested, true)
})
