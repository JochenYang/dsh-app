/**
 * The two corpora the recall and similarity work is measured against.
 *
 * Deliberately NOT assertions about quality: no test here claims a pair "is"
 * similar to a threshold, or that the recall rate is good. A threshold change
 * has to be judged against a distribution, and a distribution has to be printed
 * and read — so the similarity suite asserts the corpus is well FORMED and
 * prints what the current metric makes of it, while the recall suite asserts
 * the only thing that is a contract: the topics a query must find, and the
 * queries that must find nothing.
 *
 * @module @dsh-app/plugin-memory/tests/corpus
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scratchStore } from './scratch.ts'
import {
  MemoryStore,
  contentSimilarity,
  normalizeForMatch,
  textMatchesQuery,
  validateCardInput,
} from '../src/memory-store.ts'
import type { MemoryCategory } from '../src/types.ts'
import similarityCorpus from './fixtures/similarity-corpus.json'
import recallCorpus from './fixtures/recall-queries.json'

/** The closed label vocabulary of the similarity corpus. */
const LABELS = ['dup', 'related', 'distinct'] as const
type Label = (typeof LABELS)[number]

/** Minimum pairs per label — the corpus is worthless under this floor. */
const MIN_PER_LABEL = 20

// --- B3: similarity corpus ---------------------------------------------------

test('similarity corpus: well formed, at least 20 pairs of each label', () => {
  const pairs = similarityCorpus.pairs
  assert.ok(Array.isArray(pairs) && pairs.length >= MIN_PER_LABEL * LABELS.length, `expected >= ${String(MIN_PER_LABEL * LABELS.length)} pairs, got ${String(pairs.length)}`)
  const counts: Record<Label, number> = { dup: 0, related: 0, distinct: 0 }
  for (const pair of pairs) {
    assert.ok(pair.label === 'dup' || pair.label === 'related' || pair.label === 'distinct', `unknown label "${String(pair.label)}"`)
    assert.notEqual(pair.a, pair.b, 'a pair must not compare a text with itself')
    assert.ok(pair.a.trim() !== '' && pair.b.trim() !== '', 'both sides must carry text')
    counts[pair.label] += 1
  }
  for (const label of LABELS) {
    assert.ok(counts[label] >= MIN_PER_LABEL, `label "${label}" has ${String(counts[label])}, needs >= ${String(MIN_PER_LABEL)}`)
  }
})

test('similarity corpus: the current metric is reported per label (no separation claim)', () => {
  // Reported, not asserted: this line is the input to any future threshold
  // decision, and pinning a number here would turn calibration data into a
  // regression test of whatever the metric happens to do today.
  const byLabel = new Map<Label, number[]>()
  for (const pair of similarityCorpus.pairs) {
    const score = contentSimilarity(pair.a, pair.b)
    assert.ok(score >= 0 && score <= 1, `score out of range: ${String(score)}`)
    const list = byLabel.get(pair.label as Label) ?? []
    list.push(score)
    byLabel.set(pair.label as Label, list)
  }
  const rows = LABELS.map((label) => {
    const scores = byLabel.get(label) ?? []
    const mean = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length)
    return `${label}=n${String(scores.length)} mean ${mean.toFixed(3)} max ${Math.max(...scores).toFixed(3)} min ${Math.min(...scores).toFixed(3)}`
  })
  process.stdout.write(`# similarity corpus distribution: ${rows.join(' · ')}\n`)
})

// --- B4: recall corpus -------------------------------------------------------

/** The pre-token-AND matcher, kept verbatim so the comparison survives the
 *  rewrite it is measuring: normalized whole-query substring. */
function legacyMatches(text: string, query: string): boolean {
  const needle = normalizeForMatch(query)
  if (needle === '') return false
  return normalizeForMatch(text).includes(needle)
}

/** The card text every matcher searches (same fields the store uses). */
function cardText(card: { topic: string, summary: string, body: string }): string {
  return `${card.topic} ${card.summary} ${card.body}`
}

test('recall corpus: the fixture cards are all valid, and the topic set is unique', () => {
  const seen = new Set<string>()
  for (const card of recallCorpus.cards) {
    assert.equal(seen.has(card.topic), false, `duplicate topic "${card.topic}"`)
    seen.add(card.topic)
    const invalid = validateCardInput({
      name: card.topic,
      category: card.category,
      summary: card.summary,
      body: card.body,
    })
    assert.equal(invalid, undefined, `${card.topic}: ${String(invalid)}`)
  }
})

test('recall corpus: at least 30 queries, at least 5 of them negative', () => {
  const queries = recallCorpus.queries
  assert.ok(queries.length >= 30, `expected >= 30 queries, got ${String(queries.length)}`)
  const negatives = queries.filter(query => query.negative === true)
  assert.ok(negatives.length >= 5, `expected >= 5 negative queries, got ${String(negatives.length)}`)
  for (const query of queries) {
    if (query.negative === true) {
      assert.equal(query.expectTopics.length, 0, `negative query "${query.q}" must expect nothing`)
      continue
    }
    assert.ok(query.expectTopics.length > 0, `query "${query.q}" expects no topic and is not marked negative`)
  }
})

test('recall corpus: every expected topic is found by the store search', async () => {
  const store = await fixtureStore()
  const misses: string[] = []
  for (const query of recallCorpus.queries) {
    if (query.negative === true) continue
    const found = new Set(store.search(query.q).map(card => card.name))
    for (const topic of query.expectTopics) {
      if (!found.has(topic)) misses.push(`"${query.q}" → ${topic}`)
    }
  }
  assert.deepEqual(misses, [], `expected topics missing: ${misses.join('; ')}`)
})

test('recall corpus: negative queries still find nothing', async () => {
  const store = await fixtureStore()
  const hits: string[] = []
  for (const query of recallCorpus.queries) {
    if (query.negative !== true) continue
    const found = store.search(query.q).map(card => card.name)
    if (found.length > 0) hits.push(`"${query.q}" → ${found.join(', ')}`)
  }
  assert.deepEqual(hits, [], `negative queries matched: ${hits.join('; ')}`)
})

test('recall corpus: token-AND is a superset of the legacy substring rule', async () => {
  const store = await fixtureStore()
  const cards = recallCorpus.cards
  let legacyHits = 0
  let currentHits = 0
  const lost: string[] = []
  for (const query of recallCorpus.queries) {
    // Measured over the SAME store the expectations run against, so the two
    // numbers describe one corpus rather than two.
    const before = cards.filter(card => legacyMatches(cardText(card), query.q)).map(card => card.topic)
    const after = store.search(query.q).map(card => card.name)
    if (before.length > 0) legacyHits += 1
    if (after.length > 0) currentHits += 1
    for (const topic of before) {
      if (!after.includes(topic)) lost.push(`"${query.q}" lost ${topic}`)
    }
    // The predicate itself, not only the store: the two must agree, or the
    // shared matcher has drifted from what `search` does.
    for (const card of cards) {
      assert.equal(
        textMatchesQuery(cardText(card), query.q),
        after.includes(card.topic),
        `predicate and store disagree on "${query.q}" / ${card.topic}`,
      )
    }
  }
  process.stdout.write(`# recall corpus hit rate: legacy ${String(legacyHits)}/${String(recallCorpus.queries.length)} · token-AND ${String(currentHits)}/${String(recallCorpus.queries.length)}\n`)
  assert.deepEqual(lost, [], `queries that used to match and now do not: ${lost.join('; ')}`)
  assert.ok(currentHits >= legacyHits, 'token-AND must not lower the hit count')
})

/** Build the corpus store once per test (a store is cheap; a shared one would
 *  let one test's writes leak into another's expectations). */
async function fixtureStore(): Promise<MemoryStore> {
  const store = scratchStore('dshm-corpus-')
  for (const card of recallCorpus.cards) {
    await store.upsert({
      name: card.topic,
      category: card.category as MemoryCategory,
      summary: card.summary,
      body: card.body,
    })
  }
  return store
}
