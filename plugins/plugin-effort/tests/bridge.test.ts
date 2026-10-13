/**
 * Row identification and node identification, pinned: {@link pickEffortRowIndex} is
 * the rule that decides WHICH row of the official menu the track is placed on, and
 * {@link effortTextChildOf} with {@link pickEffortText} decide which node in the
 * COMPOSER carries the level's colour.
 *
 * They are here together because all three are "find the official node by shape,
 * never by its hashed class", and all three resolve to "write nothing" rather than
 * to a guessed node. {@link pickEffortText} adds the other half of that promise: a
 * card can hold more than one menu button, so the search has to look at every
 * candidate instead of stopping at the first — and the one marker it ranks on is
 * the kernel's own, not a position.
 *
 * The failure these guard against is a fallback: an earlier implementation of this
 * idea matched the row by label and, when the label did not match, placed the
 * control on "the second row" regardless — so a reworded or reordered menu got a
 * slider on the model row. Every case below either matches the official label or
 * answers -1, and -1 means "inject nothing".
 *
 * @module plugin-effort/tests/bridge
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { effortTextChildOf, pickEffortRowIndex, pickEffortText, valueChildOf, type MenuRow } from '../src/client/bridge.ts'

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

describe('effortTextChildOf', () => {
  /** A trigger with the given tag names for its four children. */
  const trigger = (tags: readonly string[]) => ({
    children: {
      length: tags.length,
      item: (index: number) => (tags[index] === undefined ? null : { tagName: tags[index], index }),
    },
  })

  it('is the third child of the four-child trigger the official component renders', () => {
    // [svg icon, span label, span effort, svg chevron], read from the installed
    // model-selection bundle. The index is asserted as well as the tag: it is what
    // says the rule took the third child rather than "a span somewhere".
    assert.deepEqual(effortTextChildOf(trigger(['svg', 'span', 'span', 'svg'])), { tagName: 'span', index: 2 })
  })

  it('refuses a trigger without a level text, which is what the chevron is then', () => {
    // A model that advertises no levels renders three children, and index 2 is the
    // drill chevron: colouring it would paint the level onto an icon.
    assert.equal(effortTextChildOf(trigger(['svg', 'span', 'svg'])), null)
    assert.equal(effortTextChildOf(trigger(['svg', 'span'])), null)
    assert.equal(effortTextChildOf(trigger([])), null)
  })

  it('refuses a trigger whose label or level cell is not a span', () => {
    assert.equal(effortTextChildOf(trigger(['svg', 'span', 'svg', 'svg'])), null)
    // The hero's workspace chip is `[svg, span, svg]` — refused by the count first.
    assert.equal(effortTextChildOf(trigger(['svg', 'svg', 'span', 'svg'])), null)
  })

  it('answers null for a container that hands back nothing', () => {
    const empty = { children: { length: 4, item: () => null } }
    assert.equal(effortTextChildOf(empty), null)
  })

  it('refuses any child count but the four, including one more than the four', () => {
    // The equality is a measured decision rather than tidiness. With "four or
    // more", a span inserted between the model name and the level text — the shape
    // a future build would produce — left index 2 on the INSERTED node, so the
    // level's colour and its mark landed there while the real level text kept the
    // kernel's caption tone. Refusing is the recoverable failure of the two.
    //
    // Every tag below is a real `span`, so nothing but the COUNT can refuse this
    // trigger: under the old lower bound the rule answered with index 2, and that
    // assertion is what fails.
    assert.equal(effortTextChildOf(trigger(['svg', 'span', 'span', 'span', 'svg'])), null)
    assert.equal(effortTextChildOf(trigger(['svg', 'span', 'span', 'span', 'svg'])), null)
    // One fewer, where index 2 is the chevron rather than a level text.
    assert.equal(effortTextChildOf(trigger(['svg', 'span', 'span'])), null)
    // And a four-child trigger whose trailing status cell is a span rather than the
    // icon is ACCEPTED: the rule pins the count and the two cells it writes to, not
    // the tag of a node it never touches.
    assert.deepEqual(effortTextChildOf(trigger(['svg', 'span', 'span', 'span'])), { tagName: 'span', index: 2 })
  })
})

/**
 * A card's menu trigger as the candidate search sees it: the children the shape
 * rule reads, plus the kernel's own open-state marker.
 *
 * `owner` is stamped on every child, so an assertion can say WHICH candidate the
 * answer came from — which is the whole question the cases below exist for.
 *
 * @param owner - the candidate's name.
 * @param tags - the tag names of its children.
 * @param marked - whether it carries `aria-expanded`.
 * @returns the candidate.
 */
const candidate = (owner: string, tags: readonly string[], marked = false) => ({
  children: {
    length: tags.length,
    item: (index: number) => (tags[index] === undefined ? null : { tagName: tags[index], owner }),
  },
  hasAttribute: (name: string) => marked && name === 'aria-expanded',
})

describe('pickEffortText', () => {
  it('takes the model trigger rather than a shape-identical button in front of it', () => {
    // Both candidates have the trigger's four children; only the kernel's own
    // button carries the open state it publishes on every render, and that marker
    // is what the rule ranks on. This is the fixture the old locator failed: it
    // queried the first `aria-haspopup="menu"`, so the decoy took the level's
    // colour and its mark while the real level text kept the caption tone.
    const decoy = candidate('decoy', ['svg', 'span', 'span', 'svg'])
    const model = candidate('model', ['svg', 'span', 'span', 'svg'], true)
    assert.equal(pickEffortText([decoy, model])?.owner, 'model')
  })

  it('skips a candidate whose children are not that shape instead of answering null', () => {
    // The hero workspace chip: three children. The old locator stopped here, the
    // shape rule rejected it, and the feature did nothing at all — the real trigger
    // was never read.
    const hero = candidate('hero', ['svg', 'span', 'svg'], true)
    const model = candidate('model', ['svg', 'span', 'span', 'svg'], true)
    assert.equal(pickEffortText([hero, model])?.owner, 'model')
  })

  it('does not let the marker rescue a candidate of the wrong shape', () => {
    const marked = candidate('marked', ['svg', 'span', 'svg'], true)
    const model = candidate('model', ['svg', 'span', 'span', 'svg'])
    assert.equal(pickEffortText([marked, model])?.owner, 'model')
  })

  it('falls back to DOM order without a marker, and answers null when nothing fits', () => {
    const first = candidate('first', ['svg', 'span', 'span', 'svg'])
    const second = candidate('second', ['svg', 'span', 'span', 'svg'])
    // Two shape-identical buttons and no marker between them: the module takes the
    // first and says so rather than inventing a tie-break — a hashed class is the
    // anchor that breaks silently on the next kernel build.
    assert.equal(pickEffortText([first, second])?.owner, 'first')
    assert.equal(pickEffortText([candidate('hero', ['svg', 'span', 'svg'])]), null)
    assert.equal(pickEffortText([]), null)
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
