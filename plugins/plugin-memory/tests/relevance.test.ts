/**
 * The request-relevance ranker (Z3): what counts as a term, what it takes for
 * a card to be attached, and what keeps it from firing on generic overlap.
 *
 * The numbers are not arbitrary — see the module header of relevance.ts for the
 * replay they were calibrated on (443 human-authored turns against a real
 * 227-card library). What these tests pin is the RULE that replay measured:
 * enough shared distinctive terms, never a store's common vocabulary, at most
 * two cards, deterministic.
 *
 * @module @dsh-app/plugin-memory/tests/relevance
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TopicCard } from '../src/memory-store.ts'
import { RELEVANT_MAX_CARDS, rankRelevantCards, relevanceTerms } from '../src/relevance.ts'

/** A plain card with no date of its own. */
function card(name: string, body: string): TopicCard {
  return { name, category: 'lesson', summary: `${name} summary`, created: '2026-11-01', updated: '2026-11-01', body, malformed: false }
}

/** Identifiers no fixture shares unless it names them. */
const TERMS = ['computedtransform', 'transformtypo', 'tolowercase', 'splittransform', 'iconbuttonname', 'nativefocusring', 'ariahidden']

/** A second, disjoint group of the same kind. */
const OTHER_TERMS = ['gammahotel', 'indiajuliet', 'kilolima', 'mikenovember', 'oscarpapa', 'quebecromeo', 'siertango']

/** Padding that makes a request long enough for the floor to be the full six
 *  (ten identifiers of its own that no card carries). */
const PADDING = 'verify covered consider alphaone bravotwo charliethree deltafour echofive foxtrot golfhotel'

/** A request naming the first `count` of {@link TERMS}, long enough for floor 6. */
function query(count: number): string {
  return `Re-verify the fix: are ${TERMS.slice(0, count).join(' ')} covered? ${PADDING}`
}

test('terms: ASCII identifiers of 5+ characters (case folded) and runs of three Han characters', () => {
  const terms = relevanceTerms('Use checkVisibility on 设置页的归档删除; type apps json 文件 alpha12')
  assert.deepEqual([...terms].sort(), [
    'checkvisibility', 'alpha12',
    '设置页', '置页的', '页的归', '的归档', '归档删', '档删除',
  ].sort(), 'two identifiers and the six trigrams of one Han run; nothing else')
  for (const noise of ['use', 'type', 'apps', 'json']) assert.ok(!terms.has(noise), `"${noise}" is not a term`)
})

test('terms: a Han run ends at every non-Han character, so no term spans punctuation or a space', () => {
  assert.deepEqual([...relevanceTerms('归档 删除')], [], 'two two-character runs carry no trigram')
  assert.deepEqual([...relevanceTerms('归档。删除一下')].sort(), ['删除一', '除一下'].sort())
  assert.deepEqual([...relevanceTerms('ok then')], [], 'short Latin words and nothing else: no terms')
})

test('floor: a long request attaches a card at six shared distinctive terms and not at five', () => {
  const five = card('svg-title-check', `SVG title elements: ${TERMS.slice(0, 5).join(' ')} all behave the same.`)
  assert.deepEqual(rankRelevantCards([five], [five], query(5)), [], 'one short of the floor')
  const six = card('svg-title-check', `SVG title elements: ${TERMS.slice(0, 6).join(' ')} all behave the same.`)
  assert.deepEqual(rankRelevantCards([six], [six], query(6)).map(c => c.name), ['svg-title-check'])
})

test('a short request is judged against half of its own terms, but never fewer than three', () => {
  const store = [card('c', 'settlems defaults quickbrown')]
  const ask = (text: string): string[] => rankRelevantCards(store, store, text).map(c => c.name)
  // Three terms, all shared: the floor of three is met.
  assert.deepEqual(ask('settlems defaults quickbrown'), ['c'])
  // Four terms, two shared: half would be two, the floor is three.
  assert.deepEqual(ask('settlems defaults lazydog'), [])
  // Six terms, three shared: half is three.
  assert.deepEqual(ask('settlems defaults quickbrown lazydog alphaone bravotwo'), ['c'])
  // Eight terms, three shared: half is four.
  assert.deepEqual(ask('settlems defaults quickbrown lazydog alphaone bravotwo charliethree deltafour'), [])
})

test('a term the store shares is not evidence: it stops counting at the third card that carries it', () => {
  const carriers = [card('x1', 'reviewloop'), card('x2', 'reviewloop'), card('x3', 'reviewloop')]
  const target = card('target', `reviewloop ${TERMS.slice(0, 5).join(' ')} done`)
  const request = `reviewloop ${query(5)}`
  // Five distinctive terms plus a term four cards carry: still not six.
  assert.deepEqual(rankRelevantCards([target], [target, ...carriers], request), [])
  // The same term carried by two cards is still distinctive, and makes six.
  assert.deepEqual(rankRelevantCards([target], [target, carriers[0]!], request).map(c => c.name), ['target'])
})

test('the commonness limit grows with the store: one more card per eight', () => {
  const carriers = [card('x1', 'reviewloop'), card('x2', 'reviewloop')]
  const target = card('target', `reviewloop ${TERMS.slice(0, 5).join(' ')} done`)
  const fillers = (count: number): TopicCard[] =>
    Array.from({ length: count }, (_, index) => card(`filler-${String(index)}`, `filler body number ${String(index)}`))
  const request = `reviewloop ${query(5)}`
  // 23 cards: the limit is 2, and `reviewloop` sits in three of them.
  assert.deepEqual(rankRelevantCards([target], [target, ...carriers, ...fillers(20)], request), [])
  // 24 cards: the limit is 3, so the same term counts again.
  assert.deepEqual(rankRelevantCards([target], [target, ...carriers, ...fillers(21)], request).map(c => c.name), ['target'])
})

test('ranking: most shared terms first, ties by key, two cards at most, and the input is never reordered', () => {
  const strong = card('strong-card', TERMS.join(' '))
  const weak = card('weak-card', TERMS.slice(0, 6).join(' '))
  const tiedA = card('tied-a', OTHER_TERMS.join(' '))
  const tiedB = card('tied-b', OTHER_TERMS.join(' '))
  const candidates = [tiedB, weak, strong, tiedA]
  const before = candidates.map(c => c.name)
  const request = `${TERMS.join(' ')} ${OTHER_TERMS.join(' ')} ${PADDING}`
  // strong 7, tied-a 7, tied-b 7, weak 6: score first, then the key.
  assert.deepEqual(rankRelevantCards(candidates, candidates, request).map(c => c.name), ['strong-card', 'tied-a'])
  assert.equal(RELEVANT_MAX_CARDS, 2)
  assert.deepEqual(candidates.map(c => c.name), before, 'the input order is untouched')
})

test('nothing to rank against: an empty request, no candidates, or a request of short words only', () => {
  const target = card('t', TERMS.join(' '))
  assert.deepEqual(rankRelevantCards([target], [target], ''), [])
  assert.deepEqual(rankRelevantCards([], [target], TERMS.join(' ')), [])
  assert.deepEqual(rankRelevantCards([target], [target], 'ok then go on now'), [])
})

test('Chinese: shared compounds attach a card that shares no identifier with the request', () => {
  const target = card('mp-automation-tap', '微信开发者工具的自动化接口里，App.tap 与 dispatchEvent 全部返回 unimplemented，无法用程序触发点击，只能读编译产物验证。')
  const request = '微信开发者工具的自动化里 tap 点不动，unimplemented 是怎么回事，请读编译产物确认'
  assert.deepEqual(rankRelevantCards([target], [target], request).map(c => c.name), ['mp-automation-tap'])
})
