/**
 * Aggregation: usage rows → summary/heatmap wire shapes.
 *
 * Day keys use the server's local timezone (the numbers a user cross-checks
 * against their own day are the ones they expect). Cost is an estimate in
 * CNY: the built-in DeepSeek price table carries the official idle/peak
 * dual-tier rates (peak applied per row timestamp), and can be overridden
 * or extended per provider/model through the plugin config or the user
 * config file (`<storeDir>/config.json`).
 *
 * @module @dsh-app/plugin-usage/aggregate
 */

import type { UsageAgg, UsageHeatCell, UsageModelAgg, UsagePrice, UsageRow, UsageSummary } from './types.ts'

const DAY_MS = 86_400_000

/**
 * Built-in price table: DeepSeek official pricing in CNY (¥) per 1M tokens,
 * idle tier, fetched from api-docs.deepseek.com 2026-08-26:
 *
 *   v4-flash / v4-flash-vision-exp: cache-hit 0.05 / input 1.5 / output 4.5
 *   v4-pro:                          cache-hit 0.15 / input 4.5 / output 13.5
 *
 * Peak hours (weekdays 9:00-12:00 & 14:00-18:00 Beijing time) bill 2x on
 * every rate, so each row carries peakFactor 2 and costOf() applies it per
 * row timestamp — unlike a flat idle-tier table this estimates the real
 * bill. Cache-write has no separate official price and is billed at the
 * input (cache-miss) rate, matching DeepSeek's convention. Prices may
 * change upstream; re-check the page before shipping a bump. Config rows
 * with the same provider/model replace these; rows for other models
 * (e.g. personal gateways) extend the table.
 */
export const DEFAULT_PRICING: UsagePrice[] = [
  // DeepSeek V4 (direct API, both observed provider ids).
  { provider: 'deepseek-official', model: 'deepseek-v4-flash', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 1.5, peakFactor: 2 },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 4.5, peakFactor: 2 },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 1.5, peakFactor: 2 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 1.5, peakFactor: 2 },
  { provider: 'deepseek', model: 'deepseek-v4-pro', input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 4.5, peakFactor: 2 },
  { provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 1.5, peakFactor: 2 },
  // Legacy model names (deprecated 2026-07-24) alias v4-flash's modes.
  { provider: 'deepseek', model: 'deepseek-chat', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 1.5, peakFactor: 2 },
  { provider: 'deepseek', model: 'deepseek-reasoner', input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 1.5, peakFactor: 2 },
]

/** Merge config pricing over the built-in table (config row wins per key). */
export function mergePricing(config: readonly UsagePrice[]): UsagePrice[] {
  const merged = new Map(DEFAULT_PRICING.map((p) => [`${p.provider}/${p.model}`, p]))
  for (const entry of config) merged.set(`${entry.provider}/${entry.model}`, entry)
  return [...merged.values()]
}

function priceFor(prices: readonly UsagePrice[], provider: string, model: string): UsagePrice | undefined {
  return prices.find((entry) => entry.provider === provider && entry.model === model)
}

/**
 * DeepSeek's peak billing window: Beijing time (UTC+8, no DST) weekdays
 * 9:00-12:00 and 14:00-18:00. Evaluated per row so dual-tier prices apply
 * to the hour each request actually ran in.
 */
function isPeakHour(time: number): boolean {
  const bj = new Date(time + 8 * 3_600_000)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = bj.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function costOf(row: UsageRow, price: UsagePrice | undefined): number {
  if (price === undefined) return 0
  const factor = isPeakHour(row.time) ? (price.peakFactor ?? 1) : 1
  return (
    ((row.inputTokens + row.cacheWriteTokens) / 1e6) * price.input * factor
    + (row.cacheReadTokens / 1e6) * price.cacheRead * factor
    + (row.outputTokens / 1e6) * price.output * factor
  )
}

function localDateKey(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfLocalDay(time: number): number {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function emptyAgg(date: string): UsageAgg {
  return {
    date,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    billedInputTokens: 0,
    cacheHitRate: 0,
    cost: 0,
  }
}

function addToAgg(target: UsageAgg, row: UsageRow, price: UsagePrice | undefined): void {
  target.requests += 1
  target.inputTokens += row.inputTokens
  target.outputTokens += row.outputTokens
  target.cacheReadTokens += row.cacheReadTokens
  target.cacheWriteTokens += row.cacheWriteTokens
  target.reasoningTokens += row.reasoningTokens
  target.billedInputTokens += row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens
  target.cost += costOf(row, price)
}

function finalize(agg: UsageAgg): void {
  agg.cacheHitRate = agg.billedInputTokens > 0 ? agg.cacheReadTokens / agg.billedInputTokens : 0
}

/**
 * Aggregate rows into a `days`-day summary: totals, per-day series (holes
 * filled with empty days), and per-model rows sorted by billed input.
 */
export function summarize(rows: readonly UsageRow[], days: number, prices: readonly UsagePrice[]): UsageSummary {
  const today = startOfLocalDay(Date.now())
  const since = today - (days - 1) * DAY_MS
  const until = today + DAY_MS - 1
  const totals = emptyAgg('')
  const byDay = new Map<string, UsageAgg>()
  const byModel = new Map<string, UsageModelAgg>()
  for (const row of rows) {
    if (row.time < since || row.time > until) continue
    const price = priceFor(prices, row.provider, row.model)
    addToAgg(totals, row, price)
    const dayKey = localDateKey(row.time)
    let day = byDay.get(dayKey)
    if (day === undefined) {
      day = emptyAgg(dayKey)
      byDay.set(dayKey, day)
    }
    addToAgg(day, row, price)
    const modelKey = `${row.provider}/${row.model}`
    let model = byModel.get(modelKey)
    if (model === undefined) {
      model = { ...emptyAgg(''), provider: row.provider, model: row.model, share: 0, modelTokens: 0 }
      byModel.set(modelKey, model)
    }
    model.modelTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
    addToAgg(model, row, price)
  }
  finalize(totals)
  const daily: UsageAgg[] = []
  for (let offset = 0; offset < days; offset += 1) {
    const key = localDateKey(since + offset * DAY_MS)
    const day = byDay.get(key)
    if (day !== undefined) finalize(day)
    daily.push(day ?? emptyAgg(key))
  }
  const models: UsageModelAgg[] = [...byModel.values()].map((model) => {
    finalize(model)
    return { ...model, share: totals.billedInputTokens > 0 ? model.billedInputTokens / totals.billedInputTokens : 0 }
  }).sort((a, b) => b.billedInputTokens - a.billedInputTokens)
  return { since, until, totals, models, daily }
}

/**
 * Aggregate rows into a `weeks`-week heatmap grid. `since` is inclusive-day
 * aligned by the caller; hit-rate is cache-read share of billed input.
 */
export function heatmap(
  rows: readonly UsageRow[],
  weeks: number,
  since: number,
  until: number,
): UsageHeatCell[] {
  const cells = new Map<string, UsageHeatCell & { billedInput: number }>()
  for (let offset = 0; offset < weeks * 7; offset += 1) {
    const key = localDateKey(since + offset * DAY_MS)
    cells.set(key, { date: key, requests: 0, totalTokens: 0, cacheHitRate: 0, billedInput: 0 })
  }
  for (const row of rows) {
    if (row.time < since || row.time > until) continue
    const cell = cells.get(localDateKey(row.time))
    if (cell === undefined) continue
    cell.requests += 1
    cell.totalTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
    cell.cacheHitRate += row.cacheReadTokens
    cell.billedInput += row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens
  }
  return [...cells.values()].map(({ billedInput, ...cell }) => ({
    ...cell,
    cacheHitRate: billedInput > 0 ? cell.cacheHitRate / billedInput : 0,
  }))
}

/** Expose day math to the route layer (single source for both endpoints). */
export { DAY_MS, startOfLocalDay }
