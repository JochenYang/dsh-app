/**
 * The participant seam (`src/participants.ts`): registration, order, isolation
 * and removal.
 *
 * This is the contract OTHER suite plugins build against, so each clause is
 * pinned here: a recall must reach every registered consumer exactly once, in
 * registration order, and a consumer that throws must cost neither the recall nor
 * the consumers after it. The file revert is one of these participants now
 * (`tests/revert.test.ts` drives it through a mounted plugin), which is why the
 * seam cannot be a best-effort loop that silently stops at the first failure.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createParticipantRegistry, type RewindRecallContext } from '../src/participants.ts'
import type { PlannedCut, SessionLike } from '../src/cut.ts'

/** A recall context: one session id, one cut, and a session view to consult. */
function context(): RewindRecallContext {
  const session: SessionLike = {
    surface: { nodes: [] },
    eventAt: () => undefined,
  }
  const plan: PlannedCut = {
    startSeq: 2,
    endSeq: 3,
    shadowedSeqs: [2, 3],
    turns: [1],
    prompt: 'the recalled message',
    turn: 1,
  }
  return { sessionId: 'session-a', plan, session }
}

/** A registry whose warnings are collected instead of printed. */
function warned(): { registry: ReturnType<typeof createParticipantRegistry>, lines: string[] } {
  const lines: string[] = []
  return {
    registry: createParticipantRegistry({ warn: (message) => { lines.push(message) } }),
    lines,
  }
}

test('every participant reconciles once, in registration order', async () => {
  const { registry } = warned()
  const calls: string[] = []
  const seen: RewindRecallContext[] = []
  registry.register({
    id: 'first',
    reconcileAfterRewind: (recall) => { calls.push('first'); seen.push(recall); return { ok: 1 } },
  })
  registry.register({
    id: 'second',
    // Async on purpose: the registry must await one participant before starting
    // the next, or two consumers restoring one thing race each other.
    reconcileAfterRewind: async (recall) => {
      calls.push('second')
      await Promise.resolve()
      seen.push(recall)
      return { ok: 2 }
    },
  })

  const recall = context()
  const reports = await registry.reconcileAll(recall)
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(seen.length, 2)
  assert.equal(seen[0], recall, 'each participant is handed the same recall context')
  assert.deepEqual([...reports.entries()], [['first', { ok: 1 }], ['second', { ok: 2 }]])
  // `list()` reports registration order — the order `reconcileAll` runs in.
  assert.deepEqual(registry.list().map((entry) => entry.id), ['first', 'second'])
})

test('a duplicate id throws instead of replacing the earlier participant', () => {
  const { registry } = warned()
  registry.register({ id: 'same', reconcileAfterRewind: () => undefined })
  assert.throws(
    () => registry.register({ id: 'same', reconcileAfterRewind: () => undefined }),
    /already registered/,
    'two consumers sharing an id would make the report name one and lose the other',
  )
  assert.equal(registry.list().length, 1, 'the failed registration must not have been added')
})

test('a throwing participant does not stop the next one, and the map omits it', async () => {
  const { registry, lines } = warned()
  const calls: string[] = []
  registry.register({
    id: 'boom',
    reconcileAfterRewind: () => {
      calls.push('boom')
      throw new Error('boom refused')
    },
  })
  registry.register({ id: 'after', reconcileAfterRewind: () => { calls.push('after'); return 'ok' } })

  const reports = await registry.reconcileAll(context())
  assert.deepEqual(calls, ['boom', 'after'], 'the participant after the failure still runs')
  assert.equal(reports.has('boom'), false, 'a failed participant reports nothing')
  assert.equal(reports.get('after'), 'ok')
  const joined = lines.join('\n')
  assert.match(joined, /"boom"/, 'the log line names the participant that failed')
  assert.match(joined, /boom refused/, 'and keeps its own message, which is the only place it survives')
})

test('a rejecting participant is contained the same way', async () => {
  const { registry, lines } = warned()
  const calls: string[] = []
  registry.register({
    id: 'rejects',
    reconcileAfterRewind: async () => {
      calls.push('rejects')
      await Promise.resolve()
      throw new Error('async refusal')
    },
  })
  registry.register({ id: 'after', reconcileAfterRewind: () => { calls.push('after') } })

  const reports = await registry.reconcileAll(context())
  assert.deepEqual(calls, ['rejects', 'after'])
  assert.equal(reports.has('rejects'), false)
  assert.match(lines.join('\n'), /async refusal/)
})

test('unregistering removes the participant and is idempotent', async () => {
  const { registry } = warned()
  const calls: string[] = []
  const dispose = registry.register({ id: 'gone', reconcileAfterRewind: () => { calls.push('gone') } })
  registry.register({ id: 'kept', reconcileAfterRewind: () => { calls.push('kept') } })

  dispose()
  dispose()
  await registry.reconcileAll(context())
  assert.deepEqual(calls, ['kept'], 'an unregistered participant must not run')
  assert.deepEqual(registry.list().map((entry) => entry.id), ['kept'])

  // The id is free again: removing a participant is what lets a plugin reload and
  // re-register under the same name on the same registry.
  const again = registry.register({ id: 'gone', reconcileAfterRewind: () => { calls.push('gone-again') } })
  await registry.reconcileAll(context())
  assert.deepEqual(calls, ['kept', 'kept', 'gone-again'])
  again()
  assert.equal(registry.list().length, 1)
})

test('an empty registry reconciles to an empty map', async () => {
  const { registry } = warned()
  assert.deepEqual([...await registry.reconcileAll(context())], [])
  assert.deepEqual(registry.list(), [])
})

test('a participant that never settles is cut off at the deadline, not awaited forever', async () => {
  // The recall command awaits this loop before it forgets the recorder's
  // before-images and drops the range's snapshots, so a hung participant would
  // freeze the command and leak both. The deadline turns that into the failure
  // the seam already handles.
  const lines: string[] = []
  const registry = createParticipantRegistry({ warn: (message) => { lines.push(message) } }, 20)
  const ran: string[] = []
  registry.register({ id: 'hung', reconcileAfterRewind: () => new Promise(() => {}) })
  registry.register({ id: 'after', reconcileAfterRewind: () => { ran.push('after') } })

  const reports = await registry.reconcileAll(context())

  assert.deepEqual(ran, ['after'], 'the participant after the hung one still ran')
  assert.equal(reports.has('hung'), false, 'a participant past its deadline is omitted from the report')
  assert.equal(reports.get('after'), undefined, 'and the one that settled is still recorded')
  assert.match(lines.join('\n'), /"hung"/u, 'the hung participant is named in the log')
  assert.match(lines.join('\n'), /did not settle/u, 'with the reason it was dropped for')
})

test('a skipped participant does not run, and every other one still does', async () => {
  // A conversation-only recall cuts the transcript and leaves the working tree
  // alone. The file revert must not run — restoring files the user asked to keep
  // would be worse than not recalling at all — while a participant that mirrored
  // the turn still has to reconcile, because the turn is gone from the surface
  // either way.
  const { registry } = warned()
  const ran: string[] = []
  registry.register({ id: 'file-revert', reconcileAfterRewind: () => { ran.push('file-revert') } })
  registry.register({ id: 'board', reconcileAfterRewind: () => { ran.push('board') } })

  const reports = await registry.reconcileAll({ ...context(), skip: new Set(['file-revert']) })

  assert.deepEqual(ran, ['board'], 'only the non-skipped participant ran')
  assert.equal(reports.has('file-revert'), false, 'a skipped participant contributes no report')
  assert.equal(reports.has('board'), true, 'and the others still report')
})

test('skipping is per recall: the same participant runs again next time', async () => {
  // Skipping by id rather than unregistering is what keeps the seam usable: the
  // file revert must still be there for the next ordinary recall.
  const { registry } = warned()
  let runs = 0
  registry.register({ id: 'file-revert', reconcileAfterRewind: () => { runs += 1 } })

  await registry.reconcileAll({ ...context(), skip: new Set(['file-revert']) })
  assert.equal(runs, 0, 'skipped on the first recall')
  await registry.reconcileAll(context())
  assert.equal(runs, 1, 'and it runs on a recall that did not skip it')
})

test('an empty skip set is the same as no skip at all', async () => {
  // The ordinary path must not pay for the new field: an empty set has to behave
  // exactly like the absent one, or a conversation-only recall would leave a
  // difference behind in every other case.
  const { registry } = warned()
  const ran: string[] = []
  registry.register({ id: 'a', reconcileAfterRewind: () => { ran.push('a') } })
  registry.register({ id: 'b', reconcileAfterRewind: () => { ran.push('b') } })

  await registry.reconcileAll({ ...context(), skip: new Set<string>() })

  assert.deepEqual(ran, ['a', 'b'])
})
