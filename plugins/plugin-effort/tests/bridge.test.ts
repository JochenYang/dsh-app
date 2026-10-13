/**
 * Row identification, pinned: this is the rule that decides WHICH row of the
 * official menu the track is placed on — and, by the same rule, which node inside
 * it the level name's colour is written to.
 *
 * The failure it guards against is a fallback: an earlier implementation of this
 * idea matched the row by label and, when the label did not match, placed the
 * control on "the second row" regardless — so a reworded or reordered menu got a
 * slider on the model row. Every case below either matches the official label or
 * answers -1, and -1 means "inject nothing".
 *
 * @module plugin-effort/tests/bridge
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { pickEffortRowIndex, valueChildOf, type MenuRow } from '../src/client/bridge.ts'

/** The labels the official dictionary publishes in zh-CN. */
const ZH = { model: '模型', effort: '推理等级' }

/** A drill row: a label and (in the official markup) a value cell beside it. */
const row = (label: string, hasValue = true): MenuRow => ({ label, hasValue })

describe('pickEffortRowIndex', () => {
  it('matches the effort row by the official label', () => {
    assert.equal(pickEffortRowIndex([row('模型'), row('推理等级')], ZH), 1)
  })

  it('matches it even when the menu has grown other rows', () => {
    assert.equal(pickEffortRowIndex([row('模型'), row('推理等级'), row('速度')], ZH), 1)
    assert.equal(pickEffortRowIndex([row('速度'), row('模型'), row('推理等级')], ZH), 2)
  })

  it('falls back to the two-row root pane, and only to that', () => {
    // The official root pane renders 模型 first and 推理等级 second by construction.
    assert.equal(pickEffortRowIndex([row('模型'), row('Effort')], { model: '模型', effort: '别的说法' }), 1)
    // Three rows with no label match: refuse rather than guess.
    assert.equal(pickEffortRowIndex([row('模型'), row('Effort'), row('别的')], { model: '模型', effort: '别的说法' }), -1)
    // Two rows whose first is not the model row: refuse.
    assert.equal(pickEffortRowIndex([row('别的'), row('Effort')], { model: '模型', effort: '别的说法' }), -1)
  })

  it('handles the single-row menu of a model without an effort row', () => {
    assert.equal(pickEffortRowIndex([row('模型')], ZH), -1)
  })

  it('requires a value cell beside the label', () => {
    assert.equal(pickEffortRowIndex([row('模型'), row('推理等级', false)], ZH), -1)
  })

  it('compares labels modulo whitespace and case', () => {
    assert.equal(pickEffortRowIndex([row('模型'), row('  推理等级 ')], ZH), 1)
    assert.equal(pickEffortRowIndex([row('Model'), row('Effort')], { model: 'Model', effort: 'Effort' }), 1)
    assert.equal(pickEffortRowIndex([row('Model'), row('  reasoning   EFFORT ')], { model: 'Model', effort: 'reasoning effort' }), 1)
  })

  it('refuses an empty or missing label rather than matching everything', () => {
    assert.equal(pickEffortRowIndex([row('模型'), row('')], { model: '模型', effort: '' }), -1)
    assert.equal(pickEffortRowIndex([], ZH), -1)
  })

  it('never matches the model row as the effort row', () => {
    assert.equal(pickEffortRowIndex([row('模型'), row('模型')], ZH), -1)
  })
})

/** A button whose second child is `second`, as far as `valueChildOf` looks. */
const button = (count: number, second?: { tagName?: string }) => ({
  children: {
    length: count,
    item: (index: number) => (index === 1 && second !== undefined ? second : { index }),
  },
})

describe('valueChildOf', () => {
  it('is the row\'s second child, and nothing else', () => {
    assert.deepEqual(valueChildOf(button(2)), { index: 1 })
    // The official row is [label, value, chevron] and the container is appended
    // fourth: neither moves the cell, which is second by construction.
    assert.deepEqual(valueChildOf(button(4)), { index: 1 })
  })

  it('refuses the chevron, which is what index 1 becomes without a value cell', () => {
    // The official row renders the drill chevron as an `<svg>`; recolouring it
    // would paint the level's colour on an icon instead of on the name.
    assert.equal(valueChildOf(button(3, { tagName: 'svg' })), null)
    assert.equal(valueChildOf(button(3, { tagName: 'SVG' })), null)
    assert.deepEqual(valueChildOf(button(3, { tagName: 'span' })), { tagName: 'span' })
  })

  it('refuses a node the caller marks as its own', () => {
    const container = { index: 1 }
    assert.equal(valueChildOf(button(2, container), container as unknown as Element), null)
  })

  it('answers null for the row shapes the label match already refuses', () => {
    // The same predicate `hasValue` is decided by, so a row this refuses cannot be
    // a row whose name gets tinted.
    assert.equal(valueChildOf(button(1)), null)
    assert.equal(valueChildOf(button(0)), null)
  })
})
