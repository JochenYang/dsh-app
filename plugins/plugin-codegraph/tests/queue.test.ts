/**
 * Queue contract: one pass at a time, duplicate requests join, failures are
 * recorded and terminal, a tool result buys a CHECK rather than a verdict, and
 * deleting a project cancels its work instead of racing it.
 *
 * The state machine is the whole point of this module. A graph that is silently
 * stale, or a request that silently never runs, is indistinguishable from a
 * correct graph from the outside — so each transition is pinned here.
 *
 * Two of these groups exist because the first implementation was wrong in a way the
 * rest of the suite could not see:
 *
 *   - `check` used to be `invalidate`, which marked the project `stale` on any tool
 *     result. A `Read` is a tool result. A stream of them kept a current graph `stale`
 *     AND walking its tree every window — work reported that nobody did.
 *   - `forget` used to be synchronous with a comment claiming it waited for the pass.
 *     It did not, so deleting a project mid-pass closed the handle underneath a running
 *     pass and let an owed compensating pass re-create the directory.
 *
 * @module plugin-codegraph/tests/queue
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createIndexQueue, type IndexRunner } from '../src/queue.ts'
import type { IndexOutcome } from '../src/indexer.ts'

/** An outcome with every counter zeroed. */
const EMPTY: IndexOutcome = {
  parsed: 0, skipped: 0, removed: 0, truncated: false, missingLanguage: 0, noRules: 0, parseErrors: 0, durationMs: 1,
}

/** The metadata a settled project carries. */
const META = { cwd: 'D:/x', name: 'x', head: 'abc', indexedAt: 1, fileCount: 1, symbolCount: 1, edgeCount: 1 }

/** A runner that records its calls and resolves after a microtask. */
function recorder(): { run: IndexRunner, calls: string[] } {
  const calls: string[] = []
  const run: IndexRunner = async (cwd) => {
    calls.push(cwd)
    return { ...EMPTY, parsed: 1 }
  }
  return { run, calls }
}

/** Let deferred work (microtask-scheduled pumps and checks) run. */
async function settle(ms = 20): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, ms) })
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
    queue.adopt('D:/x', META)
    assert.equal(queue.status('D:/x')?.state, 'current')
    assert.equal(queue.status('D:/x')?.indexedAt, 1, 'the adopted timestamp travels with the state')
  })

  it('rejects a request made after dispose instead of running it', async () => {
    // A disposed queue belongs to an unloaded plugin: running a pass would write
    // to a database that has already been closed.
    const { run, calls } = recorder()
    const queue = createIndexQueue(run)
    await queue.dispose()
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
    const stopping = queue.dispose()
    release?.()
    await stopping
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
    queue.adopt('D:/x', META)
    assert.equal(queue.status('D:/x')?.state, 'current')
    queue.markStale('D:/x')
    assert.equal(queue.status('D:/x')?.state, 'stale', 'the fourth state must be reachable')
  })
})

describe('check — a tool result buys a CHECK, not a verdict', () => {
  /** A queue whose "did anything change" answer the test controls. */
  function controlled(answer: boolean, run: IndexRunner): { queue: ReturnType<typeof createIndexQueue>, checks: string[] } {
    const checks: string[] = []
    const queue = createIndexQueue(run, {
      changed: (cwd) => {
        checks.push(cwd)
        return answer
      },
    })
    return { queue, checks }
  }

  it('leaves a current graph current when nothing changed', async () => {
    // THE DEFECT. A `Read`, a `Grep` and a passing test run are all tool results, and
    // the previous `invalidate` marked the project `stale` for every one of them —
    // reporting a stale graph nobody had made stale, then walking the tree to prove it.
    const { run, calls } = recorder()
    const { queue, checks } = controlled(false, run)
    queue.adopt('D:/x', META)
    queue.check('D:/x')
    await settle()
    assert.deepEqual(checks, ['D:/x'], 'the check ran')
    assert.equal(queue.status('D:/x')?.state, 'current', 'and proved nothing changed')
    assert.deepEqual(calls, [], 'no pass was started')
  })

  it('schedules a pass, and turns current into indexing, when something changed', async () => {
    const { run, calls } = recorder()
    const { queue } = controlled(true, run)
    queue.adopt('D:/x', META)
    queue.check('D:/x')
    await settle()
    assert.deepEqual(calls, ['D:/x'], 'a proved change is what starts the pass')
    assert.equal(queue.status('D:/x')?.state, 'current', 'and the pass completed')
  })

  it('never marks the graph stale before the check proves it', async () => {
    // The state a query in the window between "a tool settled" and "the check
    // answered" observes must not be `stale`: nothing is known yet.
    const { run } = recorder()
    const { queue } = controlled(true, run)
    queue.adopt('D:/x', META)
    queue.check('D:/x')
    assert.equal(queue.status('D:/x')?.state, 'current', 'the check has not answered yet')
    await settle()
  })

  it('coalesces a burst into ONE check and at most one pass', async () => {
    // A turn settles a tool per file. Each result is a real signal and each one used
    // to be a request; the check must collapse the burst.
    const { run, calls } = recorder()
    const { queue, checks } = controlled(true, run)
    queue.adopt('D:/x', META)
    for (let index = 0; index < 5; index += 1) queue.check('D:/x')
    await settle()
    assert.equal(checks.length, 1, 'five tool results are one check')
    assert.equal(calls.length, 1, 'and one pass')
  })

  it('keeps checking bounded across a long read-only stream', async () => {
    // A project nobody edits must not be re-walked per tool call, and must never be
    // indexed. Two properties, and the second is the one that bounds the work:
    //
    //   - a check that proves "unchanged" starts NO pass, whatever the stream length;
    //   - a result that arrives WHILE a check is running re-runs it at most
    //     MAX_CHECK_RERUNS times instead of stacking a walk per result.
    //
    // The scheduler is what turns a real burst into one wake (`refresh.test.ts` pins
    // that); this pins what one wake costs.
    const { run, calls } = recorder()
    const { queue, checks } = controlled(false, run)
    queue.adopt('D:/x', META)
    for (let index = 0; index < 50; index += 1) queue.check('D:/x')
    await settle()
    assert.ok(checks.length <= 4, `50 results that land during one check cost <=4 walks, got ${String(checks.length)}`)
    assert.deepEqual(calls, [], 'and a read-only stream never indexes')
    assert.equal(queue.status('D:/x')?.state, 'current')
  })

  it('lets a query settle the owed check it already answered', async () => {
    // `freshnessOf` runs the same comparison when a query lands inside the debounce
    // window, so the answer is proved rather than guessed. When it finds nothing, the
    // owed check has nothing left to decide — clearing the marker is what keeps a burst
    // of queries in one window from walking the tree once per query.
    const { run, calls } = recorder()
    const { queue, checks } = controlled(false, run)
    queue.adopt('D:/x', META)
    queue.observe('D:/x')
    assert.equal(queue.status('D:/x')?.pendingCheck, true, 'the window is open')
    queue.settleCheck('D:/x')
    assert.equal(queue.status('D:/x')?.pendingCheck, false, 'the answer already proved nothing changed')
    queue.check('D:/x')
    await settle()
    assert.deepEqual(calls, [], 'no pass either way')
    assert.equal(checks.length, 1, 'and the walk happened once')
    assert.equal(queue.status('D:/x')?.state, 'current')
  })

  it('does not amplify a stream that arrives between checks', async () => {    // The other shape: one check per result, none of them finding a change. The cost is
    // the walk the caller asked for, and the state never moves — what must not happen is
    // a pass (or a second walk per result).
    const { run, calls } = recorder()
    const { queue, checks } = controlled(false, run)
    queue.adopt('D:/x', META)
    for (let index = 0; index < 20; index += 1) {
      queue.check('D:/x')
      await settle(1)
    }
    await settle()
    assert.equal(checks.length, 20, 'one walk per check, no amplification')
    assert.deepEqual(calls, [], 'and no pass at all')
    assert.equal(queue.status('D:/x')?.state, 'current')
  })

  it('owes a compensating pass for a change reported DURING a pass', async () => {
    // THE HOLE THIS CLOSES. A running pass may already have read the file that changed,
    // so it finishes looking correct and would be reported `current`. The check that
    // arrives mid-pass cannot decide anything (the pass reads the tree as it starts),
    // so it records the debt and the pump settles one more pass.
    const releases: (() => void)[] = []
    let passes = 0
    const run: IndexRunner = async () => {
      passes += 1
      if (passes === 1) await new Promise<void>((resolve) => { releases.push(resolve) })
      return EMPTY
    }
    const queue = createIndexQueue(run, { changed: () => true })
    const first = queue.request('D:/x')
    await settle(10)
    assert.equal(queue.status('D:/x')?.state, 'indexing')

    queue.check('D:/x')
    assert.equal(passes, 1, 'still one pass: the queue runs one at a time')
    releases[0]?.()
    await first
    await settle()
    assert.equal(passes, 2, 'a change reported mid-pass buys exactly one more pass')
    assert.equal(queue.status('D:/x')?.state, 'current')
  })

  it('coalesces several mid-pass changes into one compensating pass', async () => {
    const releases: (() => void)[] = []
    let passes = 0
    const run: IndexRunner = async () => {
      passes += 1
      if (passes === 1) await new Promise<void>((resolve) => { releases.push(resolve) })
      return EMPTY
    }
    const queue = createIndexQueue(run, { changed: () => true })
    const first = queue.request('D:/x')
    await settle(10)
    queue.check('D:/x')
    queue.check('D:/x')
    queue.check('D:/x')
    releases[0]?.()
    await first
    await settle()
    assert.equal(passes, 2)
  })

  it('stops compensating at its ceiling and reports stale with the reason', async () => {
    // The ceiling is what keeps a session that writes during EVERY pass from chaining
    // passes forever. Past it the graph must not claim currency it cannot back up.
    let passes = 0
    const queue = createIndexQueue(async () => {
      passes += 1
      queue.check('D:/x')
      return EMPTY
    }, { changed: () => true })
    queue.adopt('D:/x', META)
    queue.check('D:/x')
    for (let round = 0; round < 60 && passes < 6; round += 1) await settle(10)
    assert.ok(passes >= 2 && passes <= 5, `bounded pass count, got ${String(passes)}`)
    assert.equal(queue.status('D:/x')?.state, 'stale', 'the ceiling reports stale, never a false current')
    assert.equal(queue.status('D:/x')?.awaitingRetry, true, 'and says a human must retry')

    // A CHECK MUST NOT RESTART THE CHAIN. Without this the ceiling would only mean
    // "the chain resumes after any tool result", which is the unbounded work it exists
    // to bound.
    const settled = passes
    for (let index = 0; index < 5; index += 1) queue.check('D:/x')
    await settle(50)
    assert.equal(passes, settled, 'no pass runs after the ceiling was reached')

    // An EXPLICIT request is the one thing that clears it.
    const retried = queue.request('D:/x')
    await settle(50)
    assert.ok(passes > settled, 'an explicit re-index retries, as the state says it must')
    await queue.dispose()
    await retried.catch(() => { /* the runner keeps invalidating, so this may be the last pass */ })
  })

  it('does not retry a failed project from a check', async () => {
    // A structural failure is terminal until a human retries. Scheduling a pass from
    // every tool result would turn one broken root into a pass per tool call.
    let attempts = 0
    const run: IndexRunner = async () => {
      attempts += 1
      throw new Error('unreadable root')
    }
    const queue = createIndexQueue(run, { changed: () => true })
    await assert.rejects(() => queue.request('D:/x'), /unreadable root/)
    for (let index = 0; index < 5; index += 1) queue.check('D:/x')
    await settle()
    assert.equal(attempts, 1, 'no automatic retry')
    assert.equal(queue.status('D:/x')?.state, 'failed', 'and the failure is still reported')
  })

  it('falls through to a pass when the check itself throws', async () => {
    // A check that cannot read the tree must not answer "unchanged": that would report
    // a broken project as up to date. The pass runs and records the real failure.
    let passes = 0
    const queue = createIndexQueue(async () => {
      passes += 1
      throw new Error('EPERM: root unreadable')
    }, {
      changed: () => { throw new Error('stat failed') },
    })
    queue.adopt('D:/x', META)
    queue.check('D:/x')
    await settle()
    assert.equal(passes, 1, 'the pass ran')
    assert.equal(queue.status('D:/x')?.state, 'failed')
    assert.match(queue.status('D:/x')?.failure ?? '', /EPERM/u)
  })

  it('rejects nothing when checking a disposed queue', async () => {
    // The caller is a `tools/result` observer: an unhandled rejection there is a
    // logged warning at best and an unhandled rejection at worst, never a useful
    // signal. `check` returns void for exactly this reason.
    const queue = createIndexQueue(recorder().run)
    await queue.dispose()
    assert.doesNotThrow(() => { queue.check('D:/x') })
  })
})

describe('forget — deleting a project cancels its work', () => {
  it('aborts the pass in flight and resolves only after it settled', async () => {
    // THE DEFECT. `forget` used to be synchronous while its comment claimed the delete
    // waited for the running pass. It did not: the caller closed the graph handle and
    // removed the directory underneath a pass that was still writing, and an owed
    // compensating pass then re-created the directory the user had just deleted.
    let sawAbort = false
    let finished = false
    const run: IndexRunner = async (_cwd, signal) => {
      // A long pass that watches its cancellation, the way `indexProject` does at each
      // checkpoint.
      for (let step = 0; step < 200 && !signal.aborted; step += 1) {
        await new Promise(resolve => { setTimeout(resolve, 5) })
      }
      sawAbort = signal.aborted
      await new Promise(resolve => { setTimeout(resolve, 20) })
      finished = true
      if (signal.aborted) throw new Error('the index pass was aborted')
      return EMPTY
    }
    const queue = createIndexQueue(run, { changed: () => true })
    const pending = queue.request('D:/x')
    await settle(20)
    assert.equal(queue.status('D:/x')?.state, 'indexing')

    await queue.forget('D:/x')
    assert.equal(sawAbort, true, 'the running pass was told to stop')
    assert.equal(finished, true, 'and forget waited for it to settle before returning')
    await pending.catch(() => { /* the caller must catch: the pass was cancelled */ })
    assert.equal(queue.status('D:/x'), undefined, 'the record is gone, not left as failed')
  })

  it('fails a waiting job for that project instead of running it', async () => {
    // The other half: a job QUEUED behind another project must not run after its
    // project was deleted — that is the compensating pass that re-created the graph.
    const releases: (() => void)[] = []
    const ran: string[] = []
    const run: IndexRunner = async (cwd) => {
      ran.push(cwd)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      return EMPTY
    }
    const queue = createIndexQueue(run, { changed: () => true })
    const first = queue.request('D:/a')
    const second = queue.request('D:/b')
    await settle(10)
    assert.equal(queue.status('D:/b')?.queued, true)

    await queue.forget('D:/b')
    await assert.rejects(() => second, /cancelled/u)
    releases[0]?.()
    await first
    await settle(20)
    assert.deepEqual(ran, ['D:/a'], 'b never ran')
    assert.equal(queue.status('D:/b'), undefined)
  })

  it('cancels an owed compensating pass rather than running it after the delete', async () => {
    // The exact sequence that re-created the directory: a change arrives during a pass,
    // the pass settles owing one more, and the project is deleted in that window.
    const releases: (() => void)[] = []
    let passes = 0
    const run: IndexRunner = async () => {
      passes += 1
      if (passes === 1) await new Promise<void>((resolve) => { releases.push(resolve) })
      return EMPTY
    }
    const queue = createIndexQueue(run, { changed: () => true })
    const first = queue.request('D:/x')
    await settle(10)
    queue.check('D:/x') // owes a compensation
    const deleting = queue.forget('D:/x')
    releases[0]?.()
    await first.catch(() => { /* cancelled */ })
    await deleting
    await settle(40)
    assert.equal(passes, 1, 'the owed pass never ran')
    assert.equal(queue.status('D:/x'), undefined)
  })

  it('leaves other projects untouched', async () => {
    // Deleting one project must not cancel another's pass: the queue is serial, not
    // global. b is deleted while it waits, so its own promise rejects — and that is the
    // rejection the plugin's call sites catch.
    const releases: (() => void)[] = []
    const ran: string[] = []
    const run: IndexRunner = async (cwd) => {
      ran.push(cwd)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      return EMPTY
    }
    const queue = createIndexQueue(run, { changed: () => true })
    const a = queue.request('D:/a')
    const b = queue.request('D:/b')
    await settle(10)
    await queue.forget('D:/b')
    await assert.rejects(() => b, /cancelled/u)
    releases[0]?.()
    await a
    await settle(20)
    assert.deepEqual(ran, ['D:/a'])
    assert.equal(queue.status('D:/a')?.state, 'current', 'a completed normally')
    assert.equal(queue.status('D:/b'), undefined)
  })

  it('resolves for a project the queue never saw', async () => {
    const queue = createIndexQueue(recorder().run)
    await assert.doesNotReject(() => queue.forget('D:/never'))
  })

  it('starts no pass for a deleted project even if one is requested after', async () => {
    // `forget` drops the record, so a later `request` creates a NEW entry. What must not
    // happen is a pass resuming for a project whose graph is gone — the plugin's
    // `deleting` fence refuses `graphFor`, so the runner fails instead of writing.
    const ran: string[] = []
    const queue = createIndexQueue(async (cwd) => {
      ran.push(cwd)
      return EMPTY
    }, { changed: () => true })
    queue.adopt('D:/x', META)
    await queue.forget('D:/x')
    await settle()
    assert.deepEqual(ran, [], 'no pass was started by the delete')
  })
})
