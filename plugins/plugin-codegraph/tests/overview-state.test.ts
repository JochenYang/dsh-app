/**
 * Which overview text an assembly hands out, across assemblies.
 *
 * `prompt.ts` makes one block stable across an edit; this decides what to do when
 * the block DOES change — because the kernel appends every changed snapshot and
 * retires nothing, two real changes inside a minute are two full re-reads, and a
 * re-index that flips the block to a status sentence and back is two more.
 * Measured on 234 real sessions: 35 re-pushed the overview 354 times, 32 of the
 * 274 recoverable diffs the status flip alone.
 *
 * The three rules, each pinned here with the clock driven by hand:
 *   - a failure passes through and touches nothing;
 *   - a status yields to the last complete block, once the project has one;
 *   - a changed block is adopted at most once per interval, per session.
 *
 * @module plugin-codegraph/tests/overview-state
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { OverviewStabilizer } from '../src/overview-state.ts'

const CWD = 'D:/codes/example'
const MINUTE = 60 * 1000

/** A stabilizer with the production interval and a clock that never moves, for the rules that do not depend on time. */
function rig(): OverviewStabilizer {
  return new OverviewStabilizer({ now: () => 1_000_000, minIntervalMs: 5 * MINUTE })
}

/** The status sentence `prompt.ts` produces while a pass runs. */
const STATUS = 'Code graph: the index for this project is being built right now.'
/** The failure sentence, with its recorded reason. */
const FAILURE = 'Code graph: the last index pass for this project FAILED. Reason: EPERM'

describe('OverviewStabilizer — a failure', () => {
  it('passes the failure through, every time, and records nothing', () => {
    // A failed pass is terminal until a human retries. Showing the previous shape
    // would have the model edit against a graph the plugin itself says not to
    // trust, so this is the one input that bypasses every rule.
    const stabilizer = rig()
    assert.equal(stabilizer.resolve(CWD, {}, 'failure', FAILURE), FAILURE)
    assert.equal(stabilizer.resolve(CWD, {}, 'failure', FAILURE), FAILURE, 'and again')
    assert.equal(stabilizer.changes(CWD), 0, 'a failure is not a change to the shape')
  })

  it('does not disturb the complete block a session was shown', () => {
    const stabilizer = rig()
    const session = {}
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'shape A'), 'shape A')
    assert.equal(stabilizer.resolve(CWD, session, 'failure', FAILURE), FAILURE)
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'shape A'), 'shape A', 'the same shape after recovery, not a new one')
    assert.equal(stabilizer.changes(CWD), 0)
  })

  it('is not borrowed as the last complete block by a later status', () => {
    // A failure recorded as `lastFull` would make the NEXT re-index print a failure
    // sentence as if it were the project's shape.
    const stabilizer = rig()
    assert.equal(stabilizer.resolve(CWD, {}, 'failure', FAILURE), FAILURE)
    assert.equal(stabilizer.resolve(CWD, {}, 'status', STATUS), STATUS, 'no complete block exists yet, so the status stands')
  })

  it('does not reset a session\'s interval', () => {
    // The interval measures from the last ADOPTED change. A failure between two
    // assemblies must not make the next change look due earlier than it is.
    const clock = { now: 0 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 10 * MINUTE })
    const session = {}
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A')
    clock.now = MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'B'), 'B')
    clock.now = 2 * MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'failure', FAILURE), FAILURE)
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'C'), 'B', 'still inside the interval measured from B')
    assert.equal(stabilizer.changes(CWD), 1)
  })
})

describe('OverviewStabilizer — a status', () => {
  it('passes the first-index status through when there is no complete block', () => {
    // The status sentence was written for exactly this window: a first pass on a
    // real repository takes tens of seconds, and silence read as "no graph here".
    const stabilizer = rig()
    assert.equal(stabilizer.resolve(CWD, {}, 'status', STATUS), STATUS)
    assert.equal(stabilizer.resolve(CWD, {}, 'status', STATUS), STATUS, 'and it keeps saying so')
  })

  it('yields to the last complete block through a re-index, so the text never flips', () => {
    // The defect: indexing → status → current turned the whole block into one
    // sentence and back, twice per re-index. The previous shape is still the best
    // description of the project; the tools report `indexing` on their own.
    const stabilizer = rig()
    const session = {}
    const full = stabilizer.resolve(CWD, session, 'full', 'SHAPE')
    assert.equal(stabilizer.resolve(CWD, session, 'status', STATUS), 'SHAPE', 'the status is replaced')
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'SHAPE'), 'SHAPE', 'and the block comes back identical')
    assert.equal(stabilizer.changes(CWD), 0, 'a re-index that changed nothing is not a change')
  })

  it('borrows the latest complete block, whichever session produced it', () => {
    // `lastFull` is the project's, not the session's: a status has no session of
    // its own to borrow from, and the shape it replaces belongs to the project.
    const stabilizer = rig()
    const first = {}
    const second = {}
    assert.equal(stabilizer.resolve(CWD, first, 'full', 'LATEST'), 'LATEST')
    assert.equal(stabilizer.resolve(CWD, second, 'status', STATUS), 'LATEST')
  })

  it('records nothing, so a status can never become a shape', () => {
    const stabilizer = rig()
    const session = {}
    stabilizer.resolve(CWD, session, 'status', STATUS)
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A', 'the first full block is still a first')
    assert.equal(stabilizer.changes(CWD), 0)
  })
})

describe('OverviewStabilizer — a full block', () => {
  it('passes an empty block through and records nothing', () => {
    // '' is silence ("no graph yet"), not a shape; recorded, it would be the
    // `lastFull` a later status hands out in place of the project's real shape.
    const stabilizer = rig()
    assert.equal(stabilizer.resolve(CWD, {}, 'full', ''), '')
    assert.equal(stabilizer.resolve(CWD, {}, 'status', STATUS), STATUS, 'an empty block was not remembered')
    assert.equal(stabilizer.changes(CWD), 0)
  })

  it('adopts the first block a session is offered, and starts no clock there', () => {
    const stabilizer = rig()
    const session = {}
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A')
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A', 'the same text is the same text')
    assert.equal(stabilizer.changes(CWD), 0, 'the first block is not a change')
  })

  it('defers a second change that lands inside the interval', () => {
    // Two changes inside five minutes are usually one edit's noise — a file enters
    // the entry list, then leaves again. The session keeps what it was shown, on
    // every assembly, until the interval has passed.
    const clock = { now: 0 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 5 * MINUTE })
    const session = {}
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A')
    clock.now = MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'B'), 'B', 'the first change is adopted')
    assert.equal(stabilizer.changes(CWD), 1)
    clock.now = 2 * MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'C'), 'B', 'the second change, one minute later, waits')
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'C'), 'B', 'and keeps waiting on every assembly')
    assert.equal(stabilizer.changes(CWD), 1, 'nothing was adopted, so nothing was counted')
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'B'), 'B', 'the text the session has is still B')
  })

  it('adopts the newest candidate at the first assembly after the interval', () => {
    // Delayed, never dropped — and what is adopted is the candidate CURRENT at that
    // assembly, not the one that was deferred.
    const clock = { now: 1_000_000 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 5 * MINUTE })
    const session = {}
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A')
    clock.now += MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'B'), 'B')
    clock.now += MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'C'), 'B', 'one minute after B: waits')
    clock.now += 3 * MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'D'), 'B', 'four minutes after B: still waits')
    clock.now += MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'E'), 'E', 'five minutes after B: adopted, and it is E, not C')
    assert.equal(stabilizer.changes(CWD), 2, 'A→B and B→E, nothing counted for C or D')
    // The interval now measures from E.
    clock.now += MINUTE
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'F'), 'E')
  })

  it('takes the change at exactly the interval, not one millisecond before', () => {
    const clock = { now: 0 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 1000 })
    const session = {}
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'A'), 'A')
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'B'), 'B', 'the first change starts the clock at 0')
    clock.now = 999
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'C'), 'B')
    clock.now = 1000
    assert.equal(stabilizer.resolve(CWD, session, 'full', 'C'), 'C')
  })

  it('re-shows the text a session was shown, even when the project has moved on', () => {
    // The session's text is what the model has in context; `lastFull` is only for
    // statuses. A new session adopts the newest shape at once, with no interval
    // inherited from the old one; the old one keeps what it was shown.
    const clock = { now: 0 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 5 * MINUTE })
    const first = {}
    const second = {}
    assert.equal(stabilizer.resolve(CWD, first, 'full', 'A'), 'A')
    clock.now = MINUTE
    assert.equal(stabilizer.resolve(CWD, first, 'full', 'B'), 'B', 'first adopts its first change at once')
    clock.now = 2 * MINUTE
    assert.equal(stabilizer.resolve(CWD, second, 'full', 'C'), 'C', 'a new session starts from the newest shape')
    assert.equal(stabilizer.resolve(CWD, first, 'full', 'C'), 'B', 'the first session keeps what it was shown')
    // A re-index during the first session's interval must not show it the project's
    // newest block: the next full assembly would take that back, one flip per
    // re-index. The session's own text stands; only a session with none borrows.
    assert.equal(stabilizer.resolve(CWD, first, 'status', STATUS), 'B', 'a status keeps the session\'s text')
    assert.equal(stabilizer.resolve(CWD, {}, 'status', STATUS), 'C', 'a session never shown a block borrows the project\'s latest')
    assert.equal(stabilizer.resolve(CWD, first, 'full', 'C'), 'B', 'and the block after the status is the same text again')
  })
})

describe('OverviewStabilizer — sessions and projects', () => {
  it('times each session on its own clock', () => {
    // Two sessions on one project are two conversations; one's interval must not
    // decide the other's text. Both see the same candidates in the same order and
    // reach the same answer, each from its own record — and a session that has
    // adopted nothing yet has no interval to wait out.
    const clock = { now: 0 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 5 * MINUTE })
    const one = {}
    const two = {}
    assert.equal(stabilizer.resolve(CWD, one, 'full', 'A'), 'A')
    assert.equal(stabilizer.resolve(CWD, two, 'full', 'A'), 'A')
    clock.now = MINUTE
    assert.equal(stabilizer.resolve(CWD, one, 'full', 'B'), 'B', 'session one adopts the change')
    assert.equal(stabilizer.resolve(CWD, two, 'full', 'B'), 'B', 'so does session two, from its own clock')
    clock.now = 2 * MINUTE
    assert.equal(stabilizer.resolve(CWD, one, 'full', 'C'), 'B', 'one is inside its interval')
    assert.equal(stabilizer.resolve(CWD, two, 'full', 'C'), 'B', 'and so is two, by the same rule')
    const three = {}
    assert.equal(stabilizer.resolve(CWD, three, 'full', 'C'), 'C', 'a new session has no interval to wait out')
    assert.equal(stabilizer.changes(CWD), 2, 'one A→B and two A→B; three\'s first block and both deferrals count nothing')
  })

  it('counts adopted changes per project, across its sessions', () => {
    const clock = { now: 0 }
    const stabilizer = new OverviewStabilizer({ now: () => clock.now, minIntervalMs: 1000 })
    const one = {}
    const two = {}
    const other = 'D:/codes/other'
    assert.equal(stabilizer.changes(CWD), 0, 'a project never seen counts zero')
    stabilizer.resolve(CWD, one, 'full', 'A')
    stabilizer.resolve(CWD, two, 'full', 'A')
    assert.equal(stabilizer.changes(CWD), 0, 'first blocks are not changes')
    clock.now = 1000
    assert.equal(stabilizer.resolve(CWD, one, 'full', 'B'), 'B')
    assert.equal(stabilizer.changes(CWD), 1)
    assert.equal(stabilizer.resolve(CWD, two, 'full', 'B'), 'B')
    assert.equal(stabilizer.changes(CWD), 2, 'each session\'s adoption is one re-read')
    assert.equal(stabilizer.resolve(CWD, two, 'full', 'B'), 'B')
    assert.equal(stabilizer.changes(CWD), 2, 'the same text again is not a change')
    assert.equal(stabilizer.resolve(other, one, 'full', 'Z'), 'Z')
    assert.equal(stabilizer.changes(other), 0, 'the other project has its own count')
    assert.equal(stabilizer.changes(CWD), 2, 'and does not touch this one')
  })

  it('falls back to one shared entry when the assembly carries no session', () => {
    // `assembly.agent` is optional; assemblies without one still get the rule,
    // timed together, rather than skipping it.
    const stabilizer = rig()
    assert.equal(stabilizer.resolve(CWD, undefined, 'full', 'A'), 'A')
    assert.equal(stabilizer.resolve(CWD, undefined, 'full', 'B'), 'B')
    assert.equal(stabilizer.resolve(CWD, undefined, 'full', 'C'), 'B', 'the anonymous entry has its own interval')
    assert.equal(stabilizer.changes(CWD), 1)
  })
})
