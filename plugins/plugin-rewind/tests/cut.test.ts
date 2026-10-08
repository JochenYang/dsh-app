/**
 * Unit tests for the recall computation (`src/cut.ts`).
 *
 * These run against the module alone — no kernel, no session object — because
 * `SessionLike` is structural. The fixtures mirror the real event shapes
 * measured on 0.2.0-rc.2: message events carry no `turn` of their own, and a
 * `system/message` carries `{ turn, step, message }`.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  isUserPrompt,
  listAnchors,
  messageText,
  placeholderData,
  planCut,
  type EventLike,
  type SessionLike,
} from '../src/cut.ts'
import { turnAt } from '../src/recorder.ts'

/** Build one event with the given type, seq, and payload. */
function event(seq: number, type: string, data: unknown, time = 1000 + seq): EventLike {
  return { seq, time, type, data }
}

/**
 * Build a session whose surface holds the SURFACE-ELIGIBLE events only.
 *
 * A real `session.surface.nodes` excludes boundaries like `turn/start`, so the
 * fixture must too — otherwise every range computed here would cite seqs the
 * kernel's own fold would never see.
 */
function sessionOf(events: readonly EventLike[]): SessionLike {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
  return {
    surface: { nodes: events.filter((e) => SURFACE.has(e.type)).map((e) => e.seq) },
    eventAt: (seq: number) => bySeq.get(seq),
  }
}

/** A user prompt event. */
function user(seq: number, text: string): EventLike {
  return event(seq, 'user/message', {
    id: `u${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** An assistant reply event. */
function assistant(seq: number, text: string): EventLike {
  return event(seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

/** A system prompt event. */
function system(seq: number): EventLike {
  return event(seq, 'system/message', { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'S' }] } })
}

/**
 * A turn boundary.
 *
 * Message events carry no `turn`, so every fixture that cares about turn
 * numbers needs one of these before its messages.
 */
function turnStart(seq: number, turn: number): EventLike {
  return event(seq, 'turn/start', { turn })
}

test('messageText joins text blocks and ignores other block types', () => {
  const e = event(1, 'user/message', {
    id: 'u', role: 'user',
    content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }],
    source: { kind: 'user' },
  })
  assert.equal(messageText(e), 'ab')
})

test('messageText reads the nested message.content shape too', () => {
  assert.equal(messageText(assistant(2, 'hello')), 'hello')
})

test('messageText tolerates a malformed payload instead of throwing', () => {
  assert.equal(messageText(event(3, 'user/message', null)), '')
  assert.equal(messageText(event(4, 'user/message', { content: 'nope' })), '')
})

test('isUserPrompt accepts only a real user source', () => {
  assert.equal(isUserPrompt(user(1, 'hi')), true)
  // Injected context travels as a user/message with a non-`user` source kind.
  const injected = event(2, 'user/message', {
    id: 'i', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'agent-instructions' },
  })
  assert.equal(isUserPrompt(injected), false)
  assert.equal(isUserPrompt(assistant(3, 'x')), false)
  assert.equal(isUserPrompt(event(4, 'user/message', { role: 'user', content: [] })), false)
})

test('turnOf reads only a non-negative integer turn', () => {
  // `turnAt` (src/recorder.ts) is the live reader now: a message event carries no
  // turn of its own, so the open turn comes from walking `turn/start`/`turn/end`.
  // This pins the same input discipline for the helper the fold still uses.
  assert.equal(turnAt([{ type: 'turn/start', seq: 0, data: { turn: 3 } }], 0), 3)
  assert.equal(turnAt([{ type: 'turn/start', seq: 0, data: { turn: 0 } }], 0), 0)
  assert.equal(turnAt([{ type: 'turn/start', seq: 0, data: {} }], 0), null)
  assert.equal(turnAt([{ type: 'turn/start', seq: 0, data: { turn: -1 } }], 0), null)
  assert.equal(turnAt([{ type: 'turn/start', seq: 0, data: { turn: 1.5 } }], 0), null)
})

test('listAnchors returns user prompts newest first with 1 = newest', () => {
  const session = sessionOf([system(0), turnStart(1, 1), user(2, 'first'), assistant(3, 'a'), turnStart(4, 2), user(5, 'second'), assistant(6, 'b')])
  const anchors = listAnchors(session)
  assert.equal(anchors.length, 2)
  assert.equal(anchors[0].n, 1)
  assert.equal(anchors[0].seq, 5)
  assert.equal(anchors[0].preview, 'second')
  assert.equal(anchors[1].n, 2)
  assert.equal(anchors[1].seq, 2)
})

test('listAnchors reads the turn from turn/start, not from message data', () => {
  // Message events carry no `turn`; only `turn/start` opens one. An anchor's
  // turn must therefore come from the walk, not from `data.turn`.
  const session = sessionOf([system(0), turnStart(1, 7), user(2, 'a')])
  assert.equal(listAnchors(session)[0].turn, 7)
})

test('listAnchors skips injected context and non-user surface nodes', () => {
  const injected = event(3, 'user/message', {
    id: 'i', role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'agent-instructions' },
  })
  const session = sessionOf([system(0), turnStart(1, 1), user(2, 'real'), injected, assistant(4, 'a')])
  const anchors = listAnchors(session)
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].seq, 2)
})

test('listAnchors caps the list and keeps the newest', () => {
  // One prompt per turn, because that is what the rule counts: a turn's recall
  // point is its FIRST prompt. Repeating prompts inside one turn (the previous
  // fixture did) models a STEERING sequence, which is deliberately not recallable
  // — measured on real logs, 12 turns on this machine carry two prompts and 316
  // carry one.
  const events: EventLike[] = [system(0)]
  for (let i = 2; i <= 7; i += 1) {
    events.push(turnStart(i * 2 - 2, i - 1), user(i * 2 - 1, `m${i}`))
  }
  const anchors = listAnchors(sessionOf(events), 3)
  assert.equal(anchors.length, 3)
  assert.deepEqual(anchors.map((a) => a.seq), [13, 11, 9])
})

test('listAnchors truncates a long preview with an ellipsis', () => {
  const long = 'x'.repeat(200)
  const anchors = listAnchors(sessionOf([system(0), turnStart(1, 1), user(2, long)]))
  assert.equal(anchors[0].preview.length, 81)
  assert.equal(anchors[0].preview.endsWith('…'), true)
})

test('planCut ranges from the recalled message through the surface tail', () => {
  const session = sessionOf([system(0), turnStart(1, 1), user(2, 'first'), assistant(3, 'a'), turnStart(4, 2), user(5, 'second'), assistant(6, 'b')])
  const plan = planCut(session, 1)
  assert.equal('reason' in plan, false)
  if ('reason' in plan) return
  assert.equal(plan.startSeq, 5)
  assert.equal(plan.endSeq, 6)
  assert.deepEqual(plan.shadowedSeqs, [5, 6])
  assert.deepEqual(plan.turns, [2])
  assert.equal(plan.prompt, 'second')
})

test('planCut on the oldest anchor keeps everything before it', () => {
  const session = sessionOf([system(0), turnStart(1, 1), user(2, 'first'), assistant(3, 'a'), turnStart(4, 2), user(5, 'second'), assistant(6, 'b')])
  const plan = planCut(session, 2)
  if ('reason' in plan) return assert.fail('expected a plan')
  assert.equal(plan.startSeq, 2)
  assert.equal(plan.endSeq, 6)
  assert.deepEqual(plan.shadowedSeqs, [2, 3, 5, 6])
  assert.deepEqual(plan.turns, [1, 2])
})

test('planCut reports empty, out-of-range, and not-a-user-message distinctly', () => {
  const empty = sessionOf([system(0), assistant(1, 'a')])
  assert.deepEqual(planCut(empty, 1), { reason: 'empty' })

  const one = sessionOf([system(0), turnStart(1, 1), user(2, 'only'), assistant(3, 'a')])
  assert.deepEqual(planCut(one, 2), { reason: 'outOfRange', available: 1 })
  assert.deepEqual(planCut(one, 0), { reason: 'outOfRange', available: 1 })
  assert.deepEqual(planCut(one, -1), { reason: 'outOfRange', available: 1 })
  assert.deepEqual(planCut(one, 1.5), { reason: 'outOfRange', available: 1 })
})

test('planCut refuses when the anchor is no longer on the surface', () => {
  const bySeq = new Map<number, EventLike>([[0, system(0)], [1, turnStart(1, 1)], [2, user(2, 'gone')]])
  const session: SessionLike = {
    // The user message is in the log but not on the surface.
    surface: { nodes: [0] },
    eventAt: (seq: number) => bySeq.get(seq),
  }
  assert.deepEqual(planCut(session, 1), { reason: 'empty' })
})

test('placeholderData is an empty user message with a producer-owned source', () => {
  const data = placeholderData()
  assert.equal(data.role, 'user')
  assert.equal(data.content.length, 0)
  // The source kind is the plugin's own, so the anchor rule (which accepts only
  // `kind: 'user'`) never offers the placeholder as a recall point.
  assert.equal(data.source.kind, 'dsh-app-rewind')
})
