/**
 * The tool-result trigger: WHEN to ask whether the tree moved.
 *
 * The defect this suite exists for is the one that looks authoritative rather than
 * broken. `isStale` compares Git HEAD, and an uncommitted edit does not move HEAD, so
 * before this the graph answered a question about `src/util.ts` from the file as it
 * was BEFORE the edit — reporting `current`. There is no error to notice and no empty
 * list to be suspicious of; the answer is simply about the wrong bytes.
 *
 * **AND THE DEFECT THE FIRST VERSION INTRODUCED.** This module used to mark the project
 * `stale` on every notification, which meant a `Read`, a `Grep` or a passing test run
 * reported a stale graph nobody had made stale — and, because a query re-armed the same
 * path, kept it walking. So what this module owns now is only the TIMING of a question:
 * `request` asks the queue to check, and the queue decides. None of the cases below may
 * observe a state change here, because nothing has been proved yet.
 *
 * Three properties decide whether that works, and each is tested rather than inferred:
 *
 *   1. a burst of results costs ONE check, not one per result;
 *   2. the window is not extended by later results — extending postpones the check for
 *      as long as tool calls keep arriving, which is exactly a long turn;
 *   3. a check is owed but never started after unload, because the graph handles close
 *      in the same teardown.
 *
 * The timer is injected, so none of this waits on a real clock.
 *
 * @module plugin-codegraph/tests/refresh
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createRefreshScheduler, DEFAULT_DEBOUNCE_MS, type RefreshOptions } from '../src/refresh.ts'

/** A hand-driven clock: `run()` fires every armed timer in order of arming. */
function fakeClock(): {
  setTimer: RefreshOptions['setTimer']
  clearTimer: RefreshOptions['clearTimer']
  run: () => void
  armed: () => number
  delays: number[]
} {
  const timers = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  return {
    setTimer: (callback, ms) => {
      const id = next
      next += 1
      timers.set(id, callback)
      delays.push(ms)
      return id
    },
    clearTimer: (handle) => { timers.delete(handle as number) },
    run: () => {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, callback] of pending) callback()
    },
    armed: () => timers.size,
    delays,
  }
}

/** A scheduler wired to a fake clock, recording what it asked the queue for. */
function scheduler(): {
  notify: (cwd: string) => void
  dispose: () => void
  requests: string[]
  clock: ReturnType<typeof fakeClock>
} {
  const clock = fakeClock()
  const requests: string[] = []
  const created = createRefreshScheduler({
    request: (cwd) => { requests.push(cwd) },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { notify: created.notify, dispose: created.dispose, requests, clock }
}

describe('createRefreshScheduler', () => {
  it('asks for ONE check after the debounce, and changes no state', () => {
    // The order and the absence of a state change are both the point. A notification
    // carries no verdict: the graph must not become `stale` here, because nothing has
    // been compared yet — and a read-only tool result must never reach the model as
    // "this graph is behind".
    const { notify, requests, clock } = scheduler()
    notify('D:/p')
    assert.deepEqual(requests, [], 'nothing is asked before the window closes')
    assert.equal(clock.armed(), 1)
    assert.deepEqual(clock.delays, [DEFAULT_DEBOUNCE_MS], 'the window is the documented debounce')
    clock.run()
    assert.deepEqual(requests, ['D:/p'], 'the check is asked for when the window closes')
  })

  it('coalesces a burst into one check', () => {
    // A turn that edits five files settles five tool results. Each one is a real signal,
    // but five walks over one project is a directory walk each — and the fifth would
    // read exactly what the first is about to.
    const { notify, requests, clock } = scheduler()
    for (let index = 0; index < 5; index += 1) notify('D:/p')
    assert.equal(clock.armed(), 1, 'only one timer is armed')
    clock.run()
    assert.deepEqual(requests, ['D:/p'])
  })

  it('does NOT extend the window when more results arrive', () => {
    // Extending on every result would postpone the check for as long as tool calls keep
    // arriving — that is a long turn, which is precisely when the graph is most out of
    // date. The FIRST result in a window names the moment; later ones join it.
    const { notify, clock } = scheduler()
    notify('D:/p')
    notify('D:/p')
    notify('D:/p')
    assert.deepEqual(clock.delays, [DEFAULT_DEBOUNCE_MS], 'one timer, still at the original delay')
  })

  it('keeps projects apart', () => {
    // Two sessions on two projects are two independent windows; one project's burst
    // must not swallow the other's signal.
    const { notify, requests, clock } = scheduler()
    notify('D:/a')
    notify('D:/b')
    clock.run()
    assert.deepEqual(requests.sort(), ['D:/a', 'D:/b'])
  })

  it('checks again for a result after the window closed', () => {
    // A second edit after the first check settled is a new question. This is the
    // sequence a real session produces: edit, ask, edit again.
    const { notify, requests, clock } = scheduler()
    notify('D:/p')
    clock.run()
    notify('D:/p')
    clock.run()
    assert.deepEqual(requests, ['D:/p', 'D:/p'])
  })

  it('starts no check after dispose, and clears the armed timer', () => {
    // The queue's teardown closes every open graph. A timer that survived unload would
    // fire a walk into a closed database — the failure that lands on the boot audit
    // rather than on a warning.
    const { notify, dispose, requests, clock } = scheduler()
    notify('D:/p')
    assert.equal(clock.armed(), 1)
    dispose()
    assert.equal(clock.armed(), 0, 'the armed timer was cleared, not merely ignored')
    clock.run()
    assert.deepEqual(requests, [], 'nothing ran')
    notify('D:/p')
    assert.equal(clock.armed(), 0, 'a notification after dispose arms nothing')
  })

  it('ignores an empty project path', () => {
    // The listener above it already refuses a blank cwd; a scheduler that asked for one
    // would key a check by ''.
    const { notify, requests, clock } = scheduler()
    notify('')
    assert.equal(clock.armed(), 0)
    clock.run()
    assert.deepEqual(requests, [])
  })
})
