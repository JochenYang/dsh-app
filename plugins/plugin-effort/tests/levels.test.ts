/**
 * Level resolution, pinned: this is where "the slider shows the wrong level"
 * lives or dies.
 *
 * The two regressions these tests exist for are both about positions that were
 * inferred rather than resolved — a level id absent from the current model's list
 * drawn at the left end, and an index carried across a model switch — plus the
 * single-level case, where the honest position is the END of the track rather
 * than its start.
 *
 * @module plugin-effort/tests/levels
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  commitIndexFor,
  indexOfLevel,
  levelKey,
  levelsOf,
  resolveEffort,
  trackModeOf,
  type EffortSnapshot,
} from '../src/client/levels.ts'

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

describe('levelsOf', () => {
  it('keeps the host order verbatim', () => {
    const odd = [{ id: 'max', name: 'Max' }, { id: 'low', name: 'Low' }, { id: 'off', name: 'Off' }]
    const levels = levelsOf(snapshot([{ id: 'm1', efforts: odd }], { provider: 'p1', model: 'm1' }))
    assert.deepEqual(levels.map(level => level.id), ['max', 'low', 'off'])
  })

  it('drops entries without an id and repeat ids, keeping the first of each', () => {
    const levels = levelsOf(snapshot([{
      id: 'm1',
      efforts: [
        { id: 'high', name: 'High' },
        { id: '', name: 'Broken' },
        { id: 'high', name: 'High again' },
        { id: 'max', name: 'Max' },
      ],
    }], { provider: 'p1', model: 'm1' }))
    assert.deepEqual(levels.map(level => level.name), ['High', 'Max'])
  })

  it('falls back to the id when the host sent no name', () => {
    const levels = levelsOf(snapshot([{ id: 'm1', efforts: [{ id: 'high', name: '' }] }], { provider: 'p1', model: 'm1' }))
    assert.deepEqual(levels, [{ id: 'high', name: 'high' }])
  })

  it('answers an empty list when the model is not in the catalog', () => {
    assert.deepEqual(levelsOf(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'other' })), [])
    assert.deepEqual(levelsOf(snapshot([], undefined)), [])
  })
})

describe('indexOfLevel', () => {
  const levels = [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }]

  it('locates a level by id, not by position', () => {
    assert.equal(indexOfLevel(levels, 'max'), 1)
    assert.equal(indexOfLevel(levels, 'off'), 0)
  })

  it('answers -1 for an id the list does not carry, never 0', () => {
    assert.equal(indexOfLevel(levels, 'high'), -1)
    assert.equal(indexOfLevel(levels, undefined), -1)
    assert.equal(indexOfLevel(levels, ''), -1)
    assert.equal(indexOfLevel([], 'max'), -1)
  })
})

describe('resolveEffort', () => {
  it('resolves an explicit selection to its own index', () => {
    const state = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'max' }))
    assert.deepEqual(state, { kind: 'ready', levels: FOUR, index: 3, fallback: false })
  })

  it('falls back to the model default, and says so', () => {
    const state = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR, defaultEffort: 'low' }], { provider: 'p1', model: 'm1' }))
    assert.deepEqual(state, { kind: 'ready', levels: FOUR, index: 1, fallback: true })
  })

  it('reports an unknown level instead of snapping it to the first one', () => {
    const state = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'xhigh' }))
    assert.deepEqual(state, { kind: 'unknown', levels: FOUR, raw: 'xhigh' })
  })

  it('reports an unset position when neither a value nor a default exists', () => {
    const state = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1' }))
    assert.deepEqual(state, { kind: 'unset', levels: FOUR })
  })

  it('prefers the selection over the default even when they disagree', () => {
    const state = resolveEffort(snapshot(
      [{ id: 'm1', efforts: FOUR, defaultEffort: 'off' }],
      { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    ))
    assert.deepEqual(state, { kind: 'ready', levels: FOUR, index: 2, fallback: false })
  })

  it('is absent with no selection, and absent for a model without levels', () => {
    assert.deepEqual(resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], undefined)), { kind: 'absent' })
    assert.deepEqual(resolveEffort(snapshot([{ id: 'm1' }], { provider: 'p1', model: 'm1' })), { kind: 'absent' })
    assert.deepEqual(resolveEffort(snapshot([{ id: 'm1', efforts: [] }], { provider: 'p1', model: 'm1' })), { kind: 'absent' })
  })

  it('treats a default that is not in the list as no default at all', () => {
    const state = resolveEffort(snapshot([{ id: 'm1', efforts: FOUR, defaultEffort: 'xhigh' }], { provider: 'p1', model: 'm1' }))
    assert.deepEqual(state, { kind: 'unset', levels: FOUR })
  })
})

describe('levelKey', () => {
  it('changes when the model changes, and when the advertised list changes', () => {
    const base = snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    const otherModel = snapshot([{ id: 'm1', efforts: FOUR }, { id: 'm2', efforts: FOUR }], { provider: 'p1', model: 'm2', reasoningEffort: 'max' })
    const otherList = snapshot([{ id: 'm1', efforts: [FOUR[0]!, FOUR[3]!] }], { provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    assert.notEqual(levelKey(base), levelKey(otherModel))
    assert.notEqual(levelKey(base), levelKey(otherList))
    assert.equal(levelKey(base), levelKey(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'low' })))
  })

  it('is empty with no selection', () => {
    assert.equal(levelKey(snapshot([{ id: 'm1', efforts: FOUR }], undefined)), '')
  })
})

describe('trackModeOf and commitIndexFor', () => {
  it('is interactive with two or more levels', () => {
    assert.equal(trackModeOf(resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'max' }))), 'interactive')
    assert.equal(trackModeOf(resolveEffort(snapshot([{ id: 'm1', efforts: [FOUR[0]!, FOUR[1]!] }], { provider: 'p1', model: 'm1', reasoningEffort: 'low' }))), 'interactive')
  })

  it('is single with exactly one level, and static only for a level off this scale', () => {
    assert.equal(trackModeOf(resolveEffort(snapshot([{ id: 'm1', efforts: [FOUR[0]!] }], { provider: 'p1', model: 'm1', reasoningEffort: 'off' }))), 'single')
    // The state a session starts in when the model advertises no default: no
    // position yet, but the scale is real, so a drag can pin one.
    assert.equal(trackModeOf(resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1' }))), 'interactive')
    assert.equal(trackModeOf(resolveEffort(snapshot([{ id: 'm1', efforts: FOUR }], { provider: 'p1', model: 'm1', reasoningEffort: 'xhigh' }))), 'static')
    assert.equal(trackModeOf({ kind: 'absent' }), 'static')
  })

  it('commits only from an interactive track, and only a real index', () => {
    assert.equal(commitIndexFor('interactive', 2, 4), 2)
    assert.equal(commitIndexFor('interactive', 0, 4), 0)
    assert.equal(commitIndexFor('single', 0, 1), null)
    assert.equal(commitIndexFor('static', 0, 4), null)
    assert.equal(commitIndexFor('interactive', 4, 4), null)
    assert.equal(commitIndexFor('interactive', -1, 4), null)
    assert.equal(commitIndexFor('interactive', 1.5, 4), null)
  })
})
