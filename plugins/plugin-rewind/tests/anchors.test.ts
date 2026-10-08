/**
 * The two anchor enumerations must agree, byte for byte.
 *
 * The client shows ordinal `n` in its picker and under each message's icon; the
 * host resolves `/rewind n` by RECOMPUTING the same list from the session. Two
 * independent implementations of "which messages are recallable" therefore have
 * to produce identical sequences — and they did not:
 *
 *   - the projection filtered on `text !== ''`;
 *   - the host filtered on prompt-ness.
 *
 * A prompt with no text at all (an attachment-only send, which the composer
 * supports as a first-class path) is then a recall point for the host and not for
 * the client, so every ordinal past it shifts by one: the picker's row for one
 * message recalls a DIFFERENT one, and the message the user aimed at stays in the
 * model's context. Nothing else in the suite could see this, because each side
 * was only ever tested against itself.
 *
 * This file checks the two functions against ONE surface, including the shapes
 * that made them disagree.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { listAnchors, type EventLike, type SessionLike } from '../src/cut.ts'
import { applyRewindEvent, initRewindState, rewindView } from '../src/projection.ts'
import { turnAt } from '../src/recorder.ts'

/** Build one event. */
function event(seq: number, type: string, data: unknown): EventLike {
  return { seq, time: 1000 + seq, type, data }
}

/** A turn boundary. */
function turnStart(seq: number, turn: number): EventLike {
  return event(seq, 'turn/start', { turn })
}

/** A user prompt, optionally with no text blocks at all. */
function user(seq: number, text: string | null): EventLike {
  const content = text === null ? [] : [{ type: 'text', text }]
  return event(seq, 'user/message', { id: `u${seq}`, role: 'user', content, source: { kind: 'user' } })
}

/** An assistant reply. */
function assistant(seq: number, text: string): EventLike {
  return event(seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

/** A `turn/start` is not a surface node; the others are. */
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** A session over a hand-written log. */
function sessionOf(events: readonly EventLike[]): SessionLike {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  return {
    surface: { nodes: events.filter((e) => SURFACE.has(e.type)).map((e) => e.seq) },
    eventAt: (seq: number) => bySeq.get(seq),
  }
}

/** Fold the same log through the projection, as the client's view does. */
function projectedView(events: readonly EventLike[]): { anchors: readonly { n: number, seq: number }[] } {
  let state = initRewindState()
  for (const e of events) {
    state = applyRewindEvent(state, { ...e, surfaceOp: 'append' })
  }
  return rewindView(state)
}

/** Assert both halves produce the same `n` → `seq` mapping. */
function assertAgree(label: string, events: readonly EventLike[]): void {
  const host = listAnchors(sessionOf(events)).map((a) => ({ n: a.n, seq: a.seq }))
  const client = projectedView(events).anchors.map((a) => ({ n: a.n, seq: a.seq }))
  assert.deepEqual(
    client,
    host,
    `${label}: the client's ordinals and the host's disagree\n` +
    `  client: ${JSON.stringify(client)}\n  host:   ${JSON.stringify(host)}`,
  )
}

test('the host and the client agree on one prompt per turn', () => {
  assertAgree('plain', [
    turnStart(0, 1), user(1, 'first'), assistant(2, 'a'),
    turnStart(3, 2), user(4, 'second'), assistant(5, 'b'),
  ])
})

test('they agree when a prompt carries NO text (the shape that shifted every ordinal)', () => {
  // An attachment-only send. The host counts it as a recall point; the client's
  // old `text !== ''` filter did not, so the client's list was one shorter and
  // every ordinal below it named the wrong message.
  assertAgree('attachment-only prompt', [
    turnStart(0, 1), user(1, 'first'), assistant(2, 'a'),
    turnStart(3, 2), user(4, null), assistant(5, 'b'),
    turnStart(6, 3), user(7, 'third'), assistant(8, 'c'),
  ])
  // And the anchor really is offered by both, rather than being dropped twice.
  const events = [
    turnStart(0, 1), user(1, 'first'), assistant(2, 'a'),
    turnStart(3, 2), user(4, null), assistant(5, 'b'),
  ]
  assert.deepEqual(listAnchors(sessionOf(events)).map((a) => a.seq), [4, 1])
  assert.deepEqual(projectedView(events).anchors.map((a) => a.seq), [4, 1])
})

test('they agree when a turn carries a steering message', () => {
  // A mid-turn interjection shares the prompt shape. Only the turn's FIRST prompt
  // is a recall point: a recall starting mid-turn would leave the turn's earlier
  // nodes in the model's context while the client hid the whole turn.
  assertAgree('steering', [
    turnStart(0, 1), user(1, 'the prompt'), assistant(2, 'a'),
    user(3, 'steering'), assistant(4, 'b'),
  ])
  assert.deepEqual(
    listAnchors(sessionOf([
      turnStart(0, 1), user(1, 'the prompt'), assistant(2, 'a'),
      user(3, 'steering'), assistant(4, 'b'),
    ])).map((a) => a.seq),
    [1],
    'a steering message must not become a recall point',
  )
})

test('they agree when the cap truncates the list', () => {
  const events: EventLike[] = []
  for (let i = 1; i <= 60; i += 1) {
    events.push(turnStart(i * 2 - 2, i), user(i * 2 - 1, `m${i}`))
  }
  assertAgree('over the cap', events)
  // Both take the NEWEST end, so the lists are equal and non-empty.
  assert.equal(listAnchors(sessionOf(events)).length, 50)
})

// --- The other three rules that exist twice, unchecked until now ---
//
// `anchors` above is the pair that already had a cross-check, because getting it
// wrong recalled the wrong message. Three MORE rules are implemented once per half
// — "is this a user prompt", "what is this message's text", and "which turn is
// this point in" — and none of them was compared. They drifted silently in exactly
// that shape before (see the module header of `tests/anchors.test.ts`), so each is
// pinned here against the same input.

test('the prompt rule is the same on both halves', () => {
  const prompts: EventLike[] = [
    user(1, 'real'),
    event(2, 'user/message', { id: 'x', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'context' } }),
    event(3, 'user/message', { id: 'y', role: 'user', content: [], source: { kind: 'user' } }),
    event(4, 'user/message', { id: 'z', role: 'user', content: [] }),
    event(5, 'assistant/message', { message: { role: 'assistant', content: [] } }),
  ]
  // The host's rule, then the projection's — as a surface, which is how each
  // consumer sees it.
  const host = listAnchors(sessionOf(prompts)).map((a) => a.seq)
  const client = projectedView(prompts).anchors.map((a) => a.seq)
  assert.deepEqual(client, host, 'the prompt rule differs between the halves')
  // And it is the rule the docs claim: only `source.kind === 'user'`.
  assert.deepEqual(host, [3, 1], 'a context source is not a prompt; a text-less prompt still is')
})

test('the message-text rule is the same on both halves', () => {
  const cases: readonly (readonly EventLike[])[] = [
    // top-level content, nested message.content, and non-text blocks.
    [user(1, 'plain')],
    [event(1, 'user/message', { id: 'a', role: 'user', content: [{ type: 'text', text: 'top' }], source: { kind: 'user' } })],
    [event(1, 'user/message', { id: 'b', role: 'user', message: { content: [{ type: 'text', text: 'nested' }] }, source: { kind: 'user' } })],
    [event(1, 'user/message', {
      id: 'c', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }],
    })],
  ]
  for (const events of cases) {
    const host = listAnchors(sessionOf(events))[0]?.preview
    const client = projectedView(events).anchors[0]?.preview
    assert.equal(client, host, `the text rule differs for ${JSON.stringify(events[0].data)}`)
  }
})

test('the turn rule is the same on both halves', () => {
  // The projection's turn tracking and the recorder's `turnAt` decide the same
  // fact, and the recall passes the PROJECTION's turn numbers to the recorder —
  // so a disagreement means a restore that finds nothing while reporting success.
  // That is the bug this pair produced once already (`turn/end` resetting one side
  // and not the other).
  const events: EventLike[] = [
    turnStart(0, 1), user(1, 'one'), assistant(2, 'a'),
    event(3, 'turn/end', { turn: 1 }),
    turnStart(4, 2), user(5, 'two'), assistant(6, 'b'),
    event(7, 'turn/end', { turn: 2 }),
  ]
  const client = projectedView(events).anchors.map((a) => ({ seq: a.seq, turn: a.turn }))
  for (const anchor of client) {
    const at = turnAt(events.map((e) => ({ type: e.type, seq: e.seq, data: e.data })), anchor.seq)
    assert.equal(
      at,
      anchor.turn,
      `seq ${anchor.seq}: the projection says turn ${String(anchor.turn)}, the recorder says ${String(at)}`,
    )
  }
})
