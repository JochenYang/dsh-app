/**
 * Behavioral tests for the bounded "stop, then wait" path.
 *
 * What is load-bearing here:
 *   - issuing a stop is not proof the work stopped (`workspace/session-stop` is
 *     fire-and-return), so the wait is what the delete actually acts on;
 *   - the wait is BOUNDED, and a still-running session is reported with the ids
 *     that were active — a caller may not read a timeout as "probably settled";
 *   - an activity read that THROWS is "cannot tell", which keeps the id active for
 *     the rest of the window instead of passing as idle;
 *   - a stop dispatch that fails is reported with the listeners' own messages, and
 *     a host with no stop seam cannot claim the work stopped.
 *
 * The clock and the sleeper are injected, so the bound is exercised deterministically
 * instead of by waiting out the real budget.
 *
 * @module @dsh-app/plugin-archives/tests/stop
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopAndWait, type StopWaitOptions } from '../src/stop.ts'

/** A wait whose clock advances only when it sleeps — no real time passes. */
function virtualWait(timeoutMs: number, pollMs: number): { wait: StopWaitOptions; ticks: () => number } {
  let ticks = 0
  return {
    ticks: () => ticks,
    wait: {
      timeoutMs,
      pollMs,
      now: () => ticks * pollMs,
      sleep: async () => { ticks += 1 },
    },
  }
}

test('a stop whose work settles resolves as settled', async () => {
  let running = true
  const asked: string[] = []
  const { wait } = virtualWait(50, 5)

  const outcome = await stopAndWait({
    ids: ['session-a'],
    activity: async () => (running ? [{ kind: 'turn' }] : []),
    stop: async (id: string) => {
      asked.push(id)
      running = false
    },
    wait,
  })

  assert.deepEqual(outcome, { kind: 'settled' })
  assert.deepEqual(asked, ['session-a'])
})

test('a wait that times out reports the ids that were still active', async () => {
  const { wait, ticks } = virtualWait(30, 10)

  const outcome = await stopAndWait({
    ids: ['session-a', 'session-b'],
    activity: async (id: string) => (id === 'session-b' ? [{ kind: 'turn' }] : []),
    stop: async () => {},
    wait,
  })

  assert.equal(outcome.kind, 'still-running')
  if (outcome.kind !== 'still-running') return
  assert.deepEqual(outcome.ids, ['session-b'], 'the answer names what is still active, not the whole list')
  assert.equal(ticks(), 3, 'the budget, not an unbounded loop, ended the wait')
})

test('an activity seam that cannot answer never settles the wait', async () => {
  const { wait } = virtualWait(20, 5)

  const outcome = await stopAndWait({
    ids: ['session-a'],
    activity: async () => { throw new Error('waterfall disposed') },
    stop: async () => {},
    wait,
  })

  assert.equal(outcome.kind, 'still-running')
  if (outcome.kind !== 'still-running') return
  assert.deepEqual(outcome.ids, ['session-a'], '"cannot tell" stays active rather than passing as idle')
})

test('a failing stop dispatch keeps the listeners\' own messages', async () => {
  const { wait } = virtualWait(20, 5)

  const outcome = await stopAndWait({
    ids: ['session-a'],
    activity: async () => [{ kind: 'turn' }],
    stop: async () => { throw new AggregateError([new Error('cancel seam disposed')]) },
    wait,
  })

  assert.equal(outcome.kind, 'stop-failed')
  if (outcome.kind !== 'stop-failed') return
  assert.match(outcome.detail, /cancel seam disposed/)
})

test('a host without a stop seam cannot claim the work stopped', async () => {
  const { wait, ticks } = virtualWait(20, 5)

  const outcome = await stopAndWait({
    ids: ['session-a'],
    activity: async () => [{ kind: 'turn' }],
    stop: undefined,
    wait,
  })

  assert.equal(outcome.kind, 'stop-failed')
  assert.equal(ticks(), 0, 'nothing was waited for: no stop could be issued')
})

test('an empty id list settles without asking anything', async () => {
  let asked = 0
  const { wait } = virtualWait(20, 5)

  const outcome = await stopAndWait({
    ids: [],
    activity: async () => { asked += 1; return [] },
    stop: async () => { asked += 1 },
    wait,
  })

  assert.deepEqual(outcome, { kind: 'settled' })
  assert.equal(asked, 0)
})
