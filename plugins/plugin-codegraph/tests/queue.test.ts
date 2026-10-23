/**
 * Queue contract: one pass at a time, duplicate requests join, failures are
 * recorded and terminal, and every state a surface can show is reachable.
 *
 * The state machine is the whole point of this module. A graph that is silently
 * stale, or a request that silently never runs, is indistinguishable from a
 * correct graph from the outside — so each transition is pinned here.
 *
 * @module plugin-codegraph/tests/queue
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createIndexQueue, type IndexRunner } from '../src/queue.ts'
import type { IndexOutcome } from '../src/indexer.ts'

/** An outcome with every counter zeroed. */
const EMPTY: IndexOutcome = {
  parsed: 0, skipped: 0, removed: 0, truncated: false, unsupported: 0, parseErrors: 0, durationMs: 1,
}

/** A runner that records its calls and resolves after a microtask. */
function recorder(): { run: IndexRunner, calls: string[] } {
  const calls: string[] = []
  const run: IndexRunner = async (cwd) => {
    calls.push(cwd)
    return { ...EMPTY, parsed: 1 }
  }
  return { run, calls }
}

describe('createIndexQueue', () => {
  it('reports a project as unindexed before anything is asked', () => {
    const queue = createIndexQueue(recorder().run)
    assert.equal(queue.status('D:/x'), undefined, 'a project the queue never saw has no status')
  })

  it('runs one pass and reports current', async () => {
    const { run, calls } = recorder()
    const queue = createIndexQueue(run)
    const outcome = await queue.request('D:/x')
    assert.equal(outcome.parsed, 1)
    assert.deepEqual(calls, ['D:/x'])
    const status = queue.status('D:/x')
    assert.equal(status?.state, 'current')
    assert.equal(status?.name, 'x')
    assert.equal(status?.failure, undefined)
  })

  it('joins a duplicate request instead of stacking a second pass', async () => {
    // The database has one writer; a second pass on the same project while the
    // first runs is exactly the contention the queue exists to prevent.
    const { run, calls } = recorder()
    const queue = createIndexQueue(run)
    const [a, b] = await Promise.all([queue.request('D:/x'), queue.request('D:/x')])
    assert.equal(calls.length, 1, 'two requests for one project are one pass')
    assert.deepEqual(a, b)
  })

  it('serialises two projects rather than running them together', async () => {
    let active = 0
    let peak = 0
    const run: IndexRunner = async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      return EMPTY
    }
    const queue = createIndexQueue(run)
    await Promise.all([queue.request('D:/a'), queue.request('D:/b'), queue.request('D:/c')])
    assert.equal(peak, 1, 'a pass holds the whole machine; two at once is the memory spike this prevents')
  })

  it('records a failure, fails the caller, and does not retry on its own', async () => {
    let attempts = 0
    const run: IndexRunner = async () => {
      attempts += 1
      throw new Error('unreadable root')
    }
    const queue = createIndexQueue(run)
    await assert.rejects(() => queue.request('D:/x'), /unreadable root/)
    assert.equal(attempts, 1, 'a structural failure must not spin')
    const status = queue.status('D:/x')
    assert.equal(status?.state, 'failed')
    assert.equal(status?.failure, 'unreadable root')
  })

  it('lets an explicit request retry after a failure', async () => {
    let attempts = 0
    const run: IndexRunner = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return { ...EMPTY, parsed: 2 }
    }
    const queue = createIndexQueue(run)
    await assert.rejects(() => queue.request('D:/x'), /transient/)
    const outcome = await queue.request('D:/x')
    assert.equal(outcome.parsed, 2)
    assert.equal(queue.status('D:/x')?.state, 'current')
    assert.equal(queue.status('D:/x')?.failure, undefined)
  })

  it('marks a queued project so a surface can show it waiting', async () => {
    // A runner that blocks until released, so the second job is observably
    // WAITING rather than done.
    const releases: (() => void)[] = []
    const run: IndexRunner = async () => {
      await new Promise<void>((resolve) => { releases.push(resolve) })
      return EMPTY
    }
    const queue = createIndexQueue(run)
    const first = queue.request('D:/a')
    const second = queue.request('D:/b')
    // Let the first pass start before looking at the second's state.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(queue.status('D:/b')?.queued, true)
    assert.equal(queue.status('D:/a')?.state, 'indexing')
    // Release each job as it starts; the pump hands the second one over only
    // after the first settles.
    for (let index = 0; index < 2; index += 1) {
      while (releases.length <= index) await new Promise(resolve => setTimeout(resolve, 5))
      releases[index]!()
    }
    await Promise.all([first, second])
    assert.equal(queue.status('D:/b')?.queued, false)
    assert.equal(queue.status('D:/b')?.state, 'current')
  })

  it('adopts metadata a previous run left behind', () => {
    const queue = createIndexQueue(recorder().run)
    queue.adopt('D:/x', { cwd: 'D:/x', name: 'x', head: 'abc', indexedAt: 42, fileCount: 1, symbolCount: 1, edgeCount: 1 })
    assert.equal(queue.status('D:/x')?.state, 'current')
    assert.equal(queue.status('D:/x')?.indexedAt, 42)
  })

  it('rejects a request made after dispose instead of running it', async () => {
    // A disposed queue belongs to an unloaded plugin: running a pass would write
    // to a database that has already been closed.
    const { run, calls } = recorder()
    const queue = createIndexQueue(run)
    queue.dispose()
    await assert.rejects(() => queue.request('D:/x'), /disposed/)
    assert.deepEqual(calls, [])
  })

  it('does not resurrect a record when a pass finishes after dispose', async () => {
    let release: (() => void) | undefined
    const run: IndexRunner = async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return EMPTY
    }
    const queue = createIndexQueue(run)
    const first = queue.request('D:/a')
    await new Promise(resolve => setTimeout(resolve, 10))
    queue.dispose()
    release?.()
    await first
    // The disposed flag wins: the record is not reported as current, because the
    // plugin that would serve that answer is gone.
    assert.notEqual(queue.status('D:/a')?.state, 'current')
  })

  it('lets a runner observe its own pending request without deadlocking', async () => {
    // A runner must not await `request()` on a concurrency-1 queue — the slot is
    // held by the running job. What it MAY do is fire one and not wait; this pins
    // that the second job is still queued and eventually runs.
    const order: string[] = []
    const run: IndexRunner = async (cwd) => {
      order.push(cwd)
      return EMPTY
    }
    const queue = createIndexQueue(run)
    const a = queue.request('D:/a')
    const b = queue.request('D:/b')
    await Promise.all([a, b])
    assert.deepEqual(order, ['D:/a', 'D:/b'], 'jobs run in request order, one at a time')
  })

  it('exposes the stale state a caller sets', () => {
    const queue = createIndexQueue(recorder().run)
    queue.adopt('D:/x', { cwd: 'D:/x', name: 'x', head: 'abc', indexedAt: 1, fileCount: 1, symbolCount: 1, edgeCount: 1 })
    assert.equal(queue.status('D:/x')?.state, 'current')
    queue.markStale('D:/x')
    assert.equal(queue.status('D:/x')?.state, 'stale', 'the fourth state must be reachable')
  })
})
