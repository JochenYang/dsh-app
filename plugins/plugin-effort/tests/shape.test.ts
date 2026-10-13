/**
 * The control's shape, pinned: what the container draws for each state.
 *
 * The bug these tests exist for is invisible to every other suite here. Dragging
 * a track that was "following the provider default" turns it into a track with a
 * level, and the two shapes differed in the DOM by a whole note line — which the
 * official menu, placed from its own height, answered by moving the whole card
 * 20px and re-laying the track out under the pointer.
 *
 * Two halves of the fix are asserted here. The note LINE is drawn in every state
 * (only its sentence is state-dependent), and unset and ready differ in the knob
 * and in nothing else that is structural. `styles.test.ts` pins the other two
 * facts — the line's height floor and the container's inline-size containment —
 * because they are declarations rather than decisions.
 *
 * What this cannot reach: the JSX is a React component and there is no DOM in
 * this suite, so "the line is always rendered" is asserted through the shape it
 * renders from, not by mounting it. A hand that removed the `<p>` from
 * `slider.tsx` and left `controlShapeFor` alone would keep these tests green; the
 * shape's `note` is a `string` rather than a `string | null` precisely so that no
 * state can express "no line".
 *
 * @module plugin-effort/tests/shape
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { resolveEffort, type EffortSnapshot, type EffortState } from '../src/client/levels.ts'
import { controlShapeFor, noteTextFor, type EffortTranslate } from '../src/client/shape.ts'

/** A snapshot with one provider group and the given models. */
function snapshot(
  models: readonly { id: string, efforts?: readonly { id: string, name: string }[], defaultEffort?: string }[],
  current?: { provider: string, model: string, reasoningEffort?: string },
): EffortSnapshot {
  return {
    current: current ?? null,
    groups: [{
      id: 'p1',
      models: models.map(model => ({
        id: model.id,
        ...model.efforts === undefined ? {} : { reasoning: { efforts: model.efforts, ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort } } },
      })),
    }],
  }
}

const FOUR = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

/** The real dictionary lookup, stubbed to its key so an assertion reads as the key. */
const t: EffortTranslate = key => `key:${key}`

/** The three states the assertions are about, plus the two the render still has. */
const UNSET = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1' }))
const READY = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'max' }))
const ONE = resolveEffort(snapshot([{ id: 'm1', efforts: [FOUR[0]!] }], { provider: 'p1', model: 'm1', reasoningEffort: 'off' }))
const UNKNOWN = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'xhigh' }))
const ABSENT: EffortState = { kind: 'absent' }

/** Every state, so a claim about "all of them" is made against all of them. */
const EVERY_STATE: readonly EffortState[] = [UNSET, READY, ONE, UNKNOWN, ABSENT]

/** The layers a shape puts in the container, top to bottom. */
function layers(shape: ReturnType<typeof controlShapeFor>): readonly string[] {
  return ['note', ...shape.ticks ? ['ticks'] : [], ...shape.knob ? ['knob'] : []]
}

/** Every field two shapes disagree on. */
function disagreement(a: Record<string, unknown>, b: Record<string, unknown>): readonly string[] {
  return Object.keys(a).filter(key => a[key] !== b[key])
}

describe('controlShapeFor', () => {
  it('draws the note line in every state, sentence or not', () => {
    for (const state of EVERY_STATE) {
      const shape = controlShapeFor(state, null, t, 0)
      assert.equal(typeof shape.note, 'string', `${state.kind}: the note line is not a string`)
    }
  })

  it('gives an unset track and a ready one the same layers, apart from the knob', () => {
    const unset = controlShapeFor(UNSET, null, t, -1)
    const ready = controlShapeFor(READY, null, t, 3)
    // The line is in both; only its sentence is state-dependent.
    assert.equal(typeof unset.note, 'string')
    assert.equal(typeof ready.note, 'string')
    // The ready shape is the unset shape plus the knob — not a rearrangement of it.
    assert.deepEqual(layers(unset), ['note', 'ticks'])
    assert.deepEqual(layers(ready), ['note', 'ticks', 'knob'])
    assert.deepEqual(disagreement(unset, ready), ['note', 'knob'])
    assert.equal(unset.ticks, ready.ticks)
    assert.equal(unset.noteError, ready.noteError)
  })

  it('draws the scale only where there is one to draw', () => {
    // A one-level model is FULL and inert: the level is the maximum, so there is
    // no scale to tick.
    assert.equal(controlShapeFor(ONE, null, t, 0).ticks, false)
    // A level off this model's scale has no honest position and no drag either.
    assert.equal(controlShapeFor(UNKNOWN, null, t, -1).ticks, false)
    assert.equal(controlShapeFor(ABSENT, null, t, -1).ticks, false)
  })

  it('draws no knob without a position, in every state', () => {
    for (const state of EVERY_STATE) {
      assert.equal(controlShapeFor(state, null, t, -1).knob, false, `${state.kind}: a knob with no position`)
    }
    assert.equal(controlShapeFor(UNSET, null, t, -1).knob, false, 'an unset track claims a level')
    assert.equal(controlShapeFor(UNKNOWN, null, t, 0).knob, false, 'a level off the scale claims a position')
    assert.equal(controlShapeFor(READY, null, t, 3).knob, true)
  })

  it('shows the failure in its own tone, over whatever the state had to say', () => {
    const failure = { code: 'effort.error.timeout' as const }
    const shape = controlShapeFor(UNSET, failure, t, -1)
    assert.equal(shape.noteError, true)
    assert.equal(shape.note, 'key:effort.error.timeout')
    assert.equal(controlShapeFor(UNSET, null, t, -1).noteError, false)
  })
})

describe('noteTextFor', () => {
  it('names the reason in each state that has one, and says nothing in the rest', () => {
    assert.equal(noteTextFor(UNSET, null, t), 'key:effort.noteUnset')
    assert.equal(noteTextFor(ONE, null, t), 'key:effort.noteSingle')
    assert.equal(noteTextFor(UNKNOWN, null, t), 'key:effort.noteUnknown')
    // The track speaks for itself here: a knob at a level needs no caption.
    assert.equal(noteTextFor(READY, null, t), '')
    assert.equal(noteTextFor(ABSENT, null, t), '')
  })

  it('keeps the sentence out of the shape when there is nothing to explain', () => {
    // '' and not null: the line is drawn either way (see the module header).
    assert.equal(controlShapeFor(READY, null, t, 3).note, '')
  })
})
