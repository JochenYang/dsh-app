/**
 * Unit tests for the `rewindAnchors` projection fold (`src/projection.ts`).
 *
 * The fold mirrors the kernel's own surface rules, so these tests pin the two
 * that matter: `append` pushes, `replace` splices and records what it hid. They
 * also pin the turn tracking, which is NOT carried on message events — a
 * `turn/start` opens a turn and every following node belongs to it.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyRewindEvent,
  initRewindState,
  rewindStateSchema,
  rewindView,
  type RewindState,
} from '../src/projection.ts'

/** Fold a whole event list from an empty state. */
function fold(events: readonly unknown[]): RewindState {
  return events.reduce<RewindState>((state, event) => applyRewindEvent(state, event), initRewindState())
}

/** A `turn/start` event. */
function turnStart(seq: number, turn: number): unknown {
  return { type: 'turn/start', seq, time: 1000 + seq, data: { turn } }
}

/** A real user prompt on the surface. */
function user(seq: number, text: string): unknown {
  return {
    type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append',
    data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** An assistant reply on the surface. */
function assistant(seq: number, text: string): unknown {
  return {
    type: 'assistant/message', seq, time: 1000 + seq, surfaceOp: 'append',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/** A tool result on the surface. */
function toolResult(seq: number): unknown {
  return {
    type: 'tool/result', seq, time: 1000 + seq, surfaceOp: 'append',
    data: { message: { role: 'tool', toolCallId: 'c', toolName: 'Bash', content: [{ type: 'text', text: 'out' }] } },
  }
}

/**
 * The recall placeholder replacing a range (what a recall writes).
 *
 * `user/message` with this plugin's own source kind — NOT the `system/message`
 * this fixture used to build. The real placeholder must be a user message
 * (a system message has to match the open turn/step, which an idle recall cannot
 * satisfy, and the session then fails to load), and the fold identifies its own
 * replacements by that source kind alone.
 */
function placeholder(seq: number, startSeq: number, endSeq: number, sourceSeqs: readonly number[]): unknown {
  return {
    type: 'user/message', seq, time: 1000 + seq,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [...sourceSeqs],
    data: { id: `ph${seq}`, role: 'user', content: [], source: { kind: 'dsh-app-rewind' } },
  }
}

/**
 * A compaction-style replacement: `user/message` from ANOTHER producer.
 *
 * Nothing about a recall, and it must not hide turns — on real logs this class of
 * replacement outnumbers recalls ~190:1, so counting it would hide genuinely
 * kept history on almost every compacted session.
 */
function compaction(seq: number, startSeq: number, endSeq: number, sourceSeqs: readonly number[]): unknown {
  return {
    type: 'user/message', seq, time: 1000 + seq,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [...sourceSeqs],
    data: { id: `ck${seq}`, role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint' } },
  }
}

test('an ignored event returns the same state reference', () => {
  const state = initRewindState()
  assert.equal(applyRewindEvent(state, { type: 'turn/end', seq: 1, data: {} }), state)
  assert.equal(applyRewindEvent(state, { type: 'step/start', seq: 2, data: { turn: 0, step: 0 } }), state)
  assert.equal(applyRewindEvent(state, null), state)
  assert.equal(applyRewindEvent(state, { type: 'user/message', seq: 3, data: {} }), state)
})

test('append pushes a node and the view lists user prompts newest first', () => {
  const state = fold([
    turnStart(0, 1), user(1, 'first'), assistant(2, 'a'),
    turnStart(3, 2), user(4, 'second'), assistant(5, 'b'),
  ])
  const view = rewindView(state)
  assert.equal(view.anchors.length, 2)
  assert.deepEqual(view.anchors.map((a) => a.seq), [4, 1])
  assert.equal(view.anchors[0].n, 1)
  assert.equal(view.anchors[0].preview, 'second')
})

test('turn numbers come from turn/start, not from message data', () => {
  const state = fold([
    turnStart(0, 1), user(1, 'a'),
    turnStart(2, 2), user(3, 'b'),
  ])
  const view = rewindView(state)
  assert.equal(view.anchors[0].turn, 2)
  assert.equal(view.anchors[1].turn, 1)
})

test('a replace splices the range out and hides its turns', () => {
  const state = fold([
    turnStart(0, 1), user(1, 'keep'), assistant(2, 'kept'),
    turnStart(3, 2), user(4, 'recall'), assistant(5, 'gone'),
    // Recall everything from seq 4 on.
    placeholder(6, 4, 5, [4, 5]),
  ])
  const view = rewindView(state)
  assert.deepEqual(view.anchors.map((a) => a.seq), [1])
  assert.deepEqual(view.hiddenTurns, [2])
})

test('a replace over a tool-bearing turn hides the whole turn', () => {
  const state = fold([
    turnStart(0, 1), user(1, 'keep'), assistant(2, 'kept'),
    turnStart(3, 2), user(4, 'recall'), assistant(5, ''), toolResult(6), assistant(7, 'done'),
    placeholder(8, 4, 7, [4, 5, 6, 7]),
  ])
  const view = rewindView(state)
  assert.deepEqual(view.anchors.map((a) => a.seq), [1])
  assert.deepEqual(view.hiddenTurns, [2])
})

test('a replacement by ANOTHER producer hides nothing', () => {
  // The transcript must only lose turns this plugin cut. On real logs the other
  // producers outnumber recalls by roughly 190:1 — `system/message` 241,
  // `tool/result` 127, `compact-checkpoint` 8 against 2 recalls — so counting
  // them all hid genuinely kept history on almost every compacted session.
  const state = fold([
    turnStart(0, 1), user(1, 'q'), assistant(2, 'a'),
    compaction(3, 1, 2, [1, 2]),
  ])
  const view = rewindView(state)
  assert.deepEqual(view.hiddenTurns, [], 'a compaction checkpoint must not hide turns')
  // The surface still shrinks — the replacement itself is real, the plugin just
  // does not claim it as a recall.
  assert.deepEqual(state.nodes.map((n) => n.seq), [3])
})

test('a recall that shadows no user prompt is still a recall', () => {
  // The identification is the SOURCE KIND, not what was shadowed: a recall whose
  // range happens to hold no prompt is still this plugin's cut and still hides
  // its turns. (An earlier rule inferred ownership from the range's contents.)
  const state = fold([
    turnStart(0, 1), user(1, 'q'), assistant(2, 'a'),
    placeholder(3, 2, 2, [2]),
  ])
  const view = rewindView(state)
  assert.deepEqual(view.hiddenTurns, [1])
  assert.deepEqual(view.anchors.map((a) => a.seq), [1])
})

test('a second recall accumulates hidden turns and advances the cut id', () => {
  const state = fold([
    turnStart(0, 1), user(1, 'one'),
    turnStart(2, 2), user(3, 'two'),
    turnStart(4, 3), user(5, 'three'),
    placeholder(6, 5, 5, [5]),
    placeholder(7, 3, 6, [3, 6]),
  ])
  const view = rewindView(state)
  assert.deepEqual(view.hiddenTurns, [2, 3])
  assert.deepEqual(view.anchors.map((a) => a.seq), [1])
})

test('injected context is not an anchor', () => {
  const injected = {
    type: 'user/message', seq: 2, time: 1002, surfaceOp: 'append',
    data: { id: 'i', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'agent-instructions' } },
  }
  const state = fold([turnStart(0, 1), user(1, 'real'), injected])
  const view = rewindView(state)
  assert.deepEqual(view.anchors.map((a) => a.seq), [1])
})

test('the initial state satisfies its own schema', () => {
  assert.equal(rewindStateSchema.safeParse(initRewindState()).success, true)
})

test('folded state satisfies its own schema', () => {
  const state = fold([
    turnStart(0, 1), user(1, 'a'), assistant(2, 'b'),
    turnStart(3, 2), user(4, 'c'),
    placeholder(5, 4, 4, [4]),
  ])
  const parsed = rewindStateSchema.safeParse(state)
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})
