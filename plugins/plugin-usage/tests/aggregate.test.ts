/**
 * Unit tests for aggregation: summary totals/cost, canonical pricing with
 * provider/model aliases, config overrides, and the heatmap grid.
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-usage/tests/aggregate
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, heatmap, mergePricing, startOfLocalDay, summarize, DEFAULT_PRICING } from '../src/aggregate.ts'
import type { UsagePrice, UsageRow } from '../src/types.ts'

const now = Date.now()

const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  seq: 1,
  time: now,
  sessionId: 's1',
  turn: 0,
  step: 1,
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...overrides,
})

// --- mergePricing ----------------------------------------------------------------

test('mergePricing: the built-in table is canonical (one row per model)', () => {
  assert.equal(DEFAULT_PRICING.length, 3)
  assert.deepEqual(DEFAULT_PRICING.map(p => p.model).sort(), [
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4-pro',
  ])
})

test('mergePricing: a config row replaces the canonical row, others extend', () => {
  const custom: UsagePrice = { provider: 'deepseek', model: 'deepseek-v4-flash', input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }
  const gateway: UsagePrice = { provider: 'gw', model: 'gw-1', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }
  const merged = mergePricing([custom, gateway])
  assert.equal(merged.length, 4)
  assert.equal(merged.find(p => p.provider === 'deepseek' && p.model === 'deepseek-v4-flash')?.input, 9)
  assert.ok(merged.some(p => p.provider === 'gw'))
})

test('mergePricing: an alias-spelled config row still overrides the canonical row', () => {
  const custom: UsagePrice = { provider: 'deepseek-official', model: 'deepseek-chat', input: 7, output: 7, cacheRead: 7, cacheWrite: 7 }
  const merged = mergePricing([custom])
  assert.equal(merged.length, 3)
  assert.equal(merged.find(p => p.provider === 'deepseek' && p.model === 'deepseek-v4-flash'), undefined)
  const summary = summarize([row()], 30, merged)
  assert.equal(summary.totals.cost, 7 + 3.5)
})

// --- summarize -------------------------------------------------------------------

test('summarize: totals count every in-window row', () => {
  const summary = summarize([row(), row({ sessionId: 's2', inputTokens: 2_000_000 })], 30, DEFAULT_PRICING)
  assert.equal(summary.totals.requests, 2)
  assert.equal(summary.totals.inputTokens, 3_000_000)
  assert.equal(summary.totals.outputTokens, 1_000_000)
  assert.equal(summary.models.length, 1)
  assert.equal(summary.daily.length, 30)
})

test('summarize: alias spellings bill like their canonical rows', () => {
  const canonical = summarize([row()], 30, DEFAULT_PRICING)
  const aliased = summarize(
    [row({ provider: 'deepseek-official', model: 'deepseek-chat' })],
    30,
    DEFAULT_PRICING,
  )
  assert.ok(canonical.totals.cost > 0)
  assert.equal(aliased.totals.cost, canonical.totals.cost)
})

test('summarize: an unpriced model contributes tokens but no cost', () => {
  const summary = summarize([row({ provider: 'unknown', model: 'nope' })], 30, DEFAULT_PRICING)
  assert.equal(summary.totals.requests, 1)
  assert.equal(summary.totals.inputTokens, 1_000_000)
  assert.equal(summary.totals.cost, 0)
})

test('summarize: rows outside the window are ignored', () => {
  const summary = summarize([row({ time: now - 60 * DAY_MS })], 30, DEFAULT_PRICING)
  assert.equal(summary.totals.requests, 0)
})

// --- heatmap ---------------------------------------------------------------------

test('heatmap: one row lands in its day cell with requests and tokens', () => {
  const since = startOfLocalDay(now)
  const cells = heatmap([row({ time: since + 3_600_000 })], 1, since, since + DAY_MS - 1)
  assert.equal(cells.length, 7)
  const today = cells.filter(c => c.requests > 0)
  assert.equal(today.length, 1)
  assert.equal(today[0]!.totalTokens, 1_500_000)
})

test('heatmap: cache-hit rate divides cache-read by billed input', () => {
  const since = startOfLocalDay(now)
  const cells = heatmap(
    [row({ time: since + 3_600_000, inputTokens: 0, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 100 })],
    1,
    since,
    since + DAY_MS - 1,
  )
  const hit = cells.find(c => c.requests > 0)!
  assert.equal(hit.cacheHitRate, 300 / 400)
})
