/**
 * Unit tests for event folding: header/message projection, watermark dedupe,
 * and the per-session header cache behind foldLiveEvent.
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-usage/tests/fold
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldEvents, foldLiveEvent, type FoldEvent } from '../src/fold.ts'
import { UsageStore } from '../src/store.ts'
import type { UsageRow } from '../src/types.ts'

const tmpStore = (): UsageStore => {
  const store = new UsageStore({ dir: mkdtempSync(join(tmpdir(), 'dshu-test-')), log: () => {} })
  store.load()
  return store
}

const header = (seq: number, provider: string, model: string): FoldEvent => ({
  seq,
  time: 1_000_000 + seq,
  type: 'request/header',
  data: { header: { config: { provider, model } } },
})

const message = (
  seq: number,
  usage: { inputTokens: number, outputTokens: number },
  source?: { kind: string, provider: string, model: string },
): FoldEvent => ({
  seq,
  time: 1_000_000 + seq,
  type: 'assistant/message',
  data: {
    turn: 0,
    step: 1,
    ...(source === undefined ? {} : { message: { source } }),
    usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  },
})

const rowOf = (store: UsageStore): UsageRow => {
  assert.equal(store.size, 1)
  return store.all()[0]!
}

// --- foldEvents --------------------------------------------------------------

test('foldEvents: a header plus its message folds one row with header provider/model', () => {
  const store = tmpStore()
  const added = foldEvents(store, 's1', [header(1, 'deepseek', 'deepseek-v4-flash'), message(2, { inputTokens: 10, outputTokens: 20 })])
  assert.equal(added, 1)
  const row = rowOf(store)
  assert.equal(row.provider, 'deepseek')
  assert.equal(row.model, 'deepseek-v4-flash')
  assert.equal(row.inputTokens, 10)
  assert.equal(row.outputTokens, 20)
})

test('foldEvents: the message model source wins over the turn header', () => {
  const store = tmpStore()
  foldEvents(store, 's1', [
    header(1, 'deepseek', 'deepseek-v4-flash'),
    message(2, { inputTokens: 1, outputTokens: 1 }, { kind: 'model', provider: 'other', model: 'other-x' }),
  ])
  const row = rowOf(store)
  assert.equal(row.provider, 'other')
  assert.equal(row.model, 'other-x')
})

test('foldEvents: replaying the same events adds nothing (watermark dedupe)', () => {
  const store = tmpStore()
  const events = [header(1, 'deepseek', 'm'), message(2, { inputTokens: 1, outputTokens: 1 })]
  assert.equal(foldEvents(store, 's1', events), 1)
  assert.equal(foldEvents(store, 's1', events), 0)
  assert.equal(store.size, 1)
})

test('foldEvents: events without usage are skipped but still advance the watermark', () => {
  const store = tmpStore()
  const ping: FoldEvent = { seq: 1, time: 1_000_001, type: 'assistant/message', data: { turn: 0 } }
  assert.equal(foldEvents(store, 's1', [ping]), 0)
  assert.equal(store.watermark('s1'), 1)
})

// --- foldLiveEvent (per-session header cache) --------------------------------

test('foldLiveEvent: a message folded in a later call keeps the earlier header', () => {
  const store = tmpStore()
  assert.equal(foldLiveEvent(store, 'live-1', header(1, 'deepseek', 'deepseek-v4-pro')), 0)
  assert.equal(foldLiveEvent(store, 'live-1', message(2, { inputTokens: 5, outputTokens: 6 })), 1)
  const row = rowOf(store)
  assert.equal(row.provider, 'deepseek')
  assert.equal(row.model, 'deepseek-v4-pro')
})

test('foldLiveEvent: sessions do not share cached headers', () => {
  const store = tmpStore()
  foldLiveEvent(store, 'a', header(1, 'deepseek', 'm-a'))
  foldLiveEvent(store, 'b', message(1, { inputTokens: 1, outputTokens: 1 }))
  const row = store.all()[0]!
  assert.equal(row.sessionId, 'b')
  assert.equal(row.provider, '')
  assert.equal(row.model, '')
})

test('foldLiveEvent: a newer header replaces the cached one mid-session', () => {
  const store = tmpStore()
  foldLiveEvent(store, 's', header(1, 'p1', 'm1'))
  foldLiveEvent(store, 's', header(2, 'p2', 'm2'))
  foldLiveEvent(store, 's', message(3, { inputTokens: 1, outputTokens: 1 }))
  const row = rowOf(store)
  assert.equal(row.provider, 'p2')
  assert.equal(row.model, 'm2')
})

// --- fork inheritance ---------------------------------------------------------

test('foldEvents: fromSeq skips a fork inherited prefix the parent already counted', () => {
  const store = tmpStore()
  // A forked session's log physically contains the parent's first 4 events with
  // the SAME seq values. Folding the whole log under the child id would count
  // the parent's model calls twice; fromSeq is the cut that prevents it.
  const inherited = [header(1, 'deepseek', 'm1'), message(2, { inputTokens: 100, outputTokens: 50 })]
  const own = [message(6, { inputTokens: 7, outputTokens: 3 })]
  const added = foldEvents(store, 'child', [...inherited, ...own], 4)
  assert.equal(added, 1, 'only the child own events fold')
  const row = store.all()[0]!
  assert.equal(row.sessionId, 'child')
  assert.equal(row.seq, 6)
  assert.equal(row.inputTokens, 7)
})

test('foldEvents: fromSeq never rewinds below the stored watermark', () => {
  const store = tmpStore()
  foldEvents(store, 's', [message(9, { inputTokens: 1, outputTokens: 1 })])
  // A caller passing a lower floor must not make the store re-count seq 9.
  assert.equal(foldEvents(store, 's', [message(9, { inputTokens: 1, outputTokens: 1 })], 0), 0)
  assert.equal(store.size, 1)
})
