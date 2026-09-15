/**
 * DSH APP usage statistics — settings-page section (client half UI).
 *
 * Layout: summary cards → daily heatmap → redesigned daily trend chart →
 * per-model table. The trend chart is a dual-axis SVG: stacked token bars on
 * the left axis and a cache-hit-rate line on the right axis (the two used to
 * share one axis, which read as nonsense); long ranges collapse to weekly
 * buckets so 365-day views keep readable bars. Tooltips follow the pointer
 * with edge flip; non-essential tips (footer explainer, standalone-page
 * link, caption subtitles) are deliberately absent.
 *
 * Every string this page renders comes from the `dsh-app.usage` namespace
 * through the `t` standard seat: the section registers with `locale: NS`, so
 * the renderer hands the component — and, through its props, the cards, the
 * heatmap, the trend chart and the table below — a namespace-bound translate
 * that reads the active UI locale at call time and re-renders on a language
 * switch. Failures the HOST reports arrive as codes (see `HostText` in
 * types.ts) and are rendered through {@link hostMessage}; model names and the
 * balance figures are data and cross the wire as they are.
 *
 * @module @dsh-app/plugin-usage/client/usage-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText, UsageAgg, UsageBalance, UsageBalanceSnapshot, UsageHeatmap, UsageModelAgg, UsageSummary } from '../types.ts'
import { NS, type UsageKey } from './locales.ts'

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type UsageSectionProps = PropsLocale<typeof NS>

/** The page's namespace-bound translate, handed to the sub-components below. */
type UsageTranslate = TranslateNS<typeof NS>

/** Heatmap window in weeks (the host route's own default). */
const HEAT_WEEKS = 26

/** Month-label keys, indexed by `Date.getMonth()` order. */
const MONTH_KEYS = [
  'usage.cal.m.1', 'usage.cal.m.2', 'usage.cal.m.3', 'usage.cal.m.4', 'usage.cal.m.5', 'usage.cal.m.6',
  'usage.cal.m.7', 'usage.cal.m.8', 'usage.cal.m.9', 'usage.cal.m.10', 'usage.cal.m.11', 'usage.cal.m.12',
] as const satisfies readonly UsageKey[]

/**
 * Localized month label of a 1-12 month number (the pre-i18n page built it as
 * the number followed by 月, which is what the zh entries still say).
 * @param month - calendar month, 1-based.
 * @param t - the page's namespace-bound translate.
 * @returns the month label in the active locale.
 */
function monthLabel(month: number, t: UsageTranslate): string {
  return t(MONTH_KEYS[Math.min(MONTH_KEYS.length, Math.max(1, month)) - 1])
}

/** Wire types the host routes answer with. */
type SummaryWire = UsageSummary
type HeatmapWire = UsageHeatmap

/** One tooltip placement: text lines + anchor point. */
interface Tip {
  text: string[]
  x: number
  y: number
}

/** Metric the trend chart's bars encode. */
type TrendMetric = 'tokens' | 'requests' | 'cost'

/** One plottable trend bucket (a day, or a week for long ranges). */
interface TrendPoint {
  /** X-axis label (MM-DD of the bucket start). */
  label: string
  /** Full bucket span for the tooltip (start ~ end). */
  range: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  cacheHitRate: number
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtInt(n: number): string {
  return n >= 1e6 ? fmtTokens(n) : String(n)
}

function fmtCost(n: number): string {
  return n <= 0 ? '—' : `¥${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A failure carrying the host's coded message, when one came with it. */
class HostError extends Error {
  constructor(readonly host: HostText | undefined, fallback: string) {
    super(fallback)
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  const body = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string; host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/**
 * Codes this build renders, mapped to their dictionary keys.
 *
 * The host never sends prose for anything the user reads (see `HostText` in
 * types.ts): it sends a code plus the values the sentence interpolates, and the
 * sentence lives here. `method-not-allowed` is deliberately absent — only a
 * caller that is not this page can trip it, so it falls through to the host's
 * English diagnostic rather than shipping copy for an unreachable state
 * (plugin-websearch made the same call).
 */
const HOST_KEYS: Readonly<Record<string, UsageKey>> = {
  disabled: 'usage.host.disabled',
  'missing-credential': 'usage.host.balanceMissingCredential',
  'invalid-credential': 'usage.host.balanceInvalidCredential',
  upstream: 'usage.host.balanceUpstream',
  'upstream-http': 'usage.host.balanceUpstreamHttp',
  'upstream-timeout': 'usage.host.balanceUpstreamTimeout',
  'upstream-network': 'usage.host.balanceUpstreamNetwork',
}

/**
 * Render a coded host message.
 *
 * A code this build knows gets the page's own copy with the host's values
 * interpolated; a code it does not (a newer kernel beside an older UI) keeps
 * the host's English diagnostic; a host that sent neither degrades to the
 * caller's fallback — never to a blank line.
 *
 * @param host - the host's coded message, when one came with the failure.
 * @param t - the page's namespace-bound translate seat.
 * @param fallback - text to show when the code is unknown and `text` is absent.
 * @returns the display text of the active locale.
 */
function hostMessage(host: HostText | undefined, t: UsageTranslate, fallback: string): string {
  if (host === undefined) return fallback
  const key = HOST_KEYS[host.code]
  if (key === undefined) return host.text ?? fallback
  return t(key, host.params === undefined ? undefined : { ...host.params })
}

/**
 * A failure the page shows: the host's coded message when one came with it,
 * plus the wire's own text as the last resort. Held coded rather than rendered
 * so a language switch re-labels it.
 */
interface Failure {
  readonly host?: HostText
  readonly message: string
}

/** Classify a failure into the coded form the banner renders. */
function failureOf(failure: unknown): Failure {
  if (failure instanceof HostError) return { host: failure.host, message: failure.message }
  return { message: failure instanceof Error ? failure.message : String(failure) }
}

/** The line for one failure: host copy, the host's diagnostic, or a generic one. */
function failureText(failure: Failure, t: UsageTranslate): string {
  const line = hostMessage(failure.host, t, failure.message)
  return line === '' ? t('usage.error.unknown') : line
}

// ---------------------------------------------------------------------------
// summary cards
// ---------------------------------------------------------------------------

function Cards({ totals, t }: { totals: UsageAgg; t: UsageTranslate }): ReactNode {
  const items: Array<[string, string, string]> = [
    [t('usage.card.requests'), fmtInt(totals.requests), ''],
    [t('usage.card.totalTokens'), fmtTokens(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens), t('usage.card.totalTokensHint')],
    [t('usage.card.inputTokens'), fmtTokens(totals.inputTokens), ''],
    [t('usage.card.outputTokens'), fmtTokens(totals.outputTokens), ''],
    [t('usage.card.cacheHitRate'), fmtPct(totals.cacheHitRate), t('usage.card.cacheHint', { read: fmtTokens(totals.cacheReadTokens), miss: fmtTokens(totals.inputTokens + totals.cacheWriteTokens) })],
    [t('usage.card.cacheReadTokens'), fmtTokens(totals.cacheReadTokens), ''],
    [t('usage.card.cacheWriteTokens'), fmtTokens(totals.cacheWriteTokens), ''],
    [t('usage.card.reasoningTokens'), fmtTokens(totals.reasoningTokens), ''],
    [t('usage.card.cost'), fmtCost(totals.cost), totals.cost > 0 ? t('usage.card.costHintPriced') : t('usage.card.costHintUnpriced')],
  ]
  return (
    <div className="dshau_cards">
      {items.map(([label, value, sub]) => (
        <div className="dshau_card" key={label}>
          <div className="dshau_cardLabel">{label}</div>
          <div className="dshau_cardValue">{value}</div>
          {sub !== '' && <div className="dshau_cardSub" title={sub}>{sub}</div>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DeepSeek official account balance card
//
// Refresh contract: entering the page triggers ONE silent cache-aware query
// (5-minute TTL on the host, silent failure keeps the neutral placeholder —
// errors are only meaningful when the user actively asked); clicking the card
// forces a cache-bypassing re-query and surfaces the failure reason.
// ---------------------------------------------------------------------------

type BalanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; balance: UsageBalance; at: number }
  | { status: 'error'; failure: Failure }

function BalanceCard({ t }: { t: UsageTranslate }): ReactNode {
  const [state, setState] = useState<BalanceState>({ status: 'idle' })
  // In-flight guard lives in a ref so `query` keeps a stable identity: a
  // state-depended callback would recreate itself after every transition
  // (idle→loading→ok→…), re-firing the mount effect below into an endless
  // refresh loop that also parks the card in "查询中…" behind the guard.
  const inFlight = useRef(false)

  const query = useCallback(async (fresh: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setState({ status: 'loading' })
    try {
      const snapshot = await fetchJson<UsageBalanceSnapshot>(`/plugins/@dsh-app/plugin-usage/api/balance${fresh ? '?fresh=1' : ''}`)
      setState({ status: 'ok', balance: snapshot.balance, at: snapshot.fetchedAt })
    } catch (error) {
      // Silent (mount) failures fall back to the neutral placeholder so an
      // unconfigured key never greets the user with a red error.
      if (fresh) {
        setState({ status: 'error', failure: failureOf(error) })
      } else {
        setState({ status: 'idle' })
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  // Mount: one cache-aware refresh — instant value when the TTL holds.
  useEffect(() => { void query(false) }, [query])

  const entry = state.status === 'ok' ? (state.balance.balances.find((b) => b.currency === 'CNY') ?? state.balance.balances[0]) : undefined
  const value = state.status === 'loading'
    ? t('usage.balance.querying')
    : entry !== undefined
      ? `${entry.currency === 'CNY' ? '¥' : ''}${entry.total}${entry.currency !== 'CNY' ? ` ${entry.currency}` : ''}`
      : state.status === 'error'
        ? t('usage.balance.failed')
        : '—'
  const sub = state.status === 'ok' && entry !== undefined
    ? t('usage.balance.detail', { granted: entry.granted, toppedUp: entry.toppedUp })
    : state.status === 'error'
      ? failureText(state.failure, t)
      : t('usage.balance.idle')
  const subClass = state.status === 'error' ? 'dshau_cardSub dshau_cardSubError' : 'dshau_cardSub'
  const queriedAt = state.status === 'ok'
    ? t('usage.balance.queriedAt', {
      time: `${String(new Date(state.at).getHours()).padStart(2, '0')}:${String(new Date(state.at).getMinutes()).padStart(2, '0')}`,
    })
    : ''

  return (
    <div
      className="dshau_card dshau_cardClickable"
      role="button"
      tabIndex={0}
      aria-label={t('usage.balance.aria')}
      onClick={() => { void query(true) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void query(true)
        }
      }}
    >
      <div className="dshau_cardLabel">{t('usage.balance.label')}{queriedAt}</div>
      <div className="dshau_cardValue">{value}</div>
      <div className={subClass} title={sub}>{sub}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// daily heatmap
// ---------------------------------------------------------------------------

function cellLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

function HeatCalendar({ heat, metric, onTip, t }: { heat: HeatmapWire; metric: 'tokens' | 'requests'; onTip: (tip: Tip | null) => void; t: UsageTranslate }): ReactNode {
  const { cells, weeks } = heat
  const max = cells.reduce((m, cell) => {
    const v = metric === 'tokens' ? cell.totalTokens : cell.requests
    return v > m ? v : m
  }, 0)
  const dows = [
    t('usage.cal.dow.sun'), t('usage.cal.dow.mon'), t('usage.cal.dow.tue'), t('usage.cal.dow.wed'),
    t('usage.cal.dow.thu'), t('usage.cal.dow.fri'), t('usage.cal.dow.sat'),
  ]
  const firstDow = new Date(`${cells[0]!.date}T00:00:00`).getDay()
  const monthLabels: string[] = []
  const monthSpans: number[] = []
  for (let w = 0; w < weeks; w += 1) {
    const date = cells[w * 7]!.date
    const prev = w > 0 ? cells[(w - 1) * 7]!.date : ''
    monthLabels.push(w === 0 || date.slice(0, 7) !== prev.slice(0, 7) ? monthLabel(Number(date.slice(5, 7)), t) : '')
    monthSpans.push(0)
  }
  let nextLabel = weeks
  for (let w = weeks - 1; w >= 0; w -= 1) {
    if (monthLabels[w] === '') continue
    monthSpans[w] = Math.max(1, nextLabel - w)
    nextLabel = w
  }
  const tipText = (cell: HeatmapWire['cells'][number]): string[] => [
    cell.date,
    t('usage.cal.tipRequests', { requests: cell.requests, tokens: fmtTokens(cell.totalTokens) }),
    t('usage.cal.tipHitRate', { rate: fmtPct(cell.cacheHitRate) }),
  ]
  return (
    <div
      className="dshau_calendar"
      style={{ gridTemplateColumns: `26px repeat(${weeks}, 13px)`, gridTemplateRows: '16px repeat(7, 13px)' }}
    >
      <div style={{ gridRow: 1, gridColumn: 1 }} />
      {monthLabels.map((label, w) => label !== '' && (
        <div className="dshau_calMonth" style={{ gridRow: 1, gridColumn: `${w + 2} / span ${monthSpans[w]}` }} key={`m${w}`}>{label}</div>
      ))}
      {dows.map((_dow, d) => (
        <div className="dshau_calDow" style={{ gridRow: d + 2, gridColumn: 1 }} key={`d${d}`}>{dows[(firstDow + d) % 7]}</div>
      ))}
      {cells.map((cell, i) => {
        const week = Math.floor(i / 7)
        const dow = i % 7
        const value = metric === 'tokens' ? cell.totalTokens : cell.requests
        const level = cellLevel(value, max)
        return (
          <div
            className="dshau_calCell"
            data-level={level}
            style={{ gridRow: dow + 2, gridColumn: week + 2 }}
            key={cell.date}
            onMouseEnter={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              onTip({ text: tipText(cell), x: rect.left + rect.width / 2, y: rect.top })
            }}
            onMouseMove={(event) => {
              onTip({ text: tipText(cell), x: event.clientX + 14, y: event.clientY + 14 })
            }}
            onMouseLeave={() => { onTip(null) }}
          >
            {cell.date}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// redesigned daily trend chart (dual axis, weekly collapse for long ranges)
// ---------------------------------------------------------------------------

// Stack order = bottom → top. Cache-read sits at the bottom because it is the
// stable base layer (often >90% of tokens); the thin input/output/write bands
// ride on top where their day-to-day variation stays visible.
const SEGMENTS: Array<{ key: 'cacheReadTokens' | 'inputTokens' | 'cacheWriteTokens' | 'outputTokens'; labelKey: UsageKey; color: string }> = [
  { key: 'cacheReadTokens', labelKey: 'usage.seg.cacheRead', color: 'var(--dsw-alias-state-success-primary)' },
  { key: 'inputTokens', labelKey: 'usage.seg.input', color: 'var(--dsw-alias-brand-primary)' },
  { key: 'cacheWriteTokens', labelKey: 'usage.seg.cacheWrite', color: 'var(--dsw-alias-state-warn-primary)' },
  { key: 'outputTokens', labelKey: 'usage.seg.output', color: 'var(--dsw-alias-state-business-primary)' },
]

const TREND_METRICS: Array<{ id: TrendMetric; labelKey: UsageKey }> = [
  { id: 'tokens', labelKey: 'usage.metric.tokens' },
  { id: 'requests', labelKey: 'usage.metric.requests' },
  { id: 'cost', labelKey: 'usage.metric.cost' },
]

/** Smallest round value ≥ value from the 1/2/2.5/5 ladder. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const base = 10 ** Math.floor(Math.log10(value))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= value) return m * base
  }
  return 10 * base
}

function pointValue(point: TrendPoint, metric: TrendMetric): number {
  if (metric === 'requests') return point.requests
  if (metric === 'cost') return point.cost
  return point.inputTokens + point.cacheReadTokens + point.cacheWriteTokens + point.outputTokens
}

function metricTick(value: number, metric: TrendMetric): string {
  if (metric === 'requests') return fmtInt(value)
  if (metric === 'cost') return value >= 1 ? `¥${value.toFixed(0)}` : `¥${value.toFixed(2)}`
  return fmtTokens(value)
}

/** Collapse daily buckets into weekly ones (sums; hit-rate re-weighted). */
function groupWeekly(daily: UsageAgg[]): TrendPoint[] {
  const points: TrendPoint[] = []
  for (let i = 0; i < daily.length; i += 7) {
    const week = daily.slice(i, i + 7)
    if (week.length === 0) continue
    const sum = (pick: (d: UsageAgg) => number): number => week.reduce((acc, d) => acc + pick(d), 0)
    const cacheRead = sum((d) => d.cacheReadTokens)
    const billed = sum((d) => d.inputTokens + d.cacheReadTokens + d.cacheWriteTokens)
    points.push({
      label: week[0]!.date.slice(5),
      range: week.length > 1 ? `${week[0]!.date} ~ ${week[week.length - 1]!.date}` : week[0]!.date,
      requests: sum((d) => d.requests),
      inputTokens: sum((d) => d.inputTokens),
      outputTokens: sum((d) => d.outputTokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: sum((d) => d.cacheWriteTokens),
      cost: sum((d) => d.cost),
      cacheHitRate: billed > 0 ? cacheRead / billed : 0,
    })
  }
  return points
}

function TrendChart({ daily, range, metric, onTip, t }: {
  daily: UsageAgg[]
  range: number
  metric: TrendMetric
  onTip: (tip: Tip | null) => void
  t: UsageTranslate
}): ReactNode {
  const W = 680
  const H = 240
  const padL = 52
  const padR = 44
  const padT = 14
  const padB = 24
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  // Weekly buckets once bars would get unreadably thin.
  const weekly = range > 60
  const points: TrendPoint[] = weekly
    ? groupWeekly(daily)
    : daily.map((d) => ({
      label: d.date.slice(5),
      range: d.date,
      requests: d.requests,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      cacheWriteTokens: d.cacheWriteTokens,
      cost: d.cost,
      cacheHitRate: d.cacheHitRate,
    }))
  const max = niceMax(points.reduce((m, p) => Math.max(m, pointValue(p, metric)), 0))
  const bw = plotW / Math.max(1, points.length)
  const xLabelStep = Math.max(1, Math.ceil(points.length / 8))
  const [hover, setHover] = useState<number | null>(null)

  const showTip = (p: TrendPoint, x: number, y: number): void => {
    const lines = metric === 'tokens'
      ? [
        p.range,
        t('usage.tip.requestsHit', { requests: fmtInt(p.requests), rate: fmtPct(p.cacheHitRate) }),
        t('usage.tip.inputCacheRead', { input: fmtTokens(p.inputTokens), cacheRead: fmtTokens(p.cacheReadTokens) }),
        t('usage.tip.cacheWriteOutput', { cacheWrite: fmtTokens(p.cacheWriteTokens), output: fmtTokens(p.outputTokens) }),
        t('usage.tip.cost', { cost: fmtCost(p.cost) }),
      ]
      : metric === 'requests'
        ? [
          p.range,
          t('usage.tip.requests', { requests: fmtInt(p.requests) }),
          t('usage.tip.hitRate', { rate: fmtPct(p.cacheHitRate) }),
          t('usage.tip.cost', { cost: fmtCost(p.cost) }),
        ]
        : [
          p.range,
          t('usage.tip.cost', { cost: fmtCost(p.cost) }),
          t('usage.tip.requests', { requests: fmtInt(p.requests) }),
          t('usage.tip.hitRate', { rate: fmtPct(p.cacheHitRate) }),
        ]
    onTip({ text: lines, x, y })
  }

  const hitY = (rate: number): number => padT + plotH - rate * plotH

  return (
    <svg className="dshau_chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('usage.trend.aria')}>
      {/* left axis: gridlines + token/request/cost ticks */}
      {[0, 1, 2, 3].map((g) => {
        const gy = padT + (plotH * g) / 3
        return (
          <g key={g}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="var(--dsw-alias-border-l1)" strokeWidth={1} strokeOpacity={0.6} />
            <text x={padL - 6} y={gy + 3} textAnchor="end">{metricTick((max * (3 - g)) / 3, metric)}</text>
          </g>
        )
      })}
      {/* right axis: hit-rate scale, only meaningful against token bars */}
      {metric === 'tokens' && [0, 0.5, 1].map((rate) => (
        <text x={W - padR + 6} y={hitY(rate) + 3} textAnchor="start" key={`r${rate}`}>
          {`${Math.round(rate * 100)}%`}
        </text>
      ))}
      {/* bars */}
      {points.map((p, i) => {
        const x = padL + i * bw
        const baseY = padT + plotH
        if (metric === 'tokens') {
          let y = baseY
          const rects = SEGMENTS.map((seg, s) => {
            const h = (p[seg.key] / max) * plotH
            y -= h
            return <rect x={x} y={y} width={Math.max(1, bw - 2)} height={Math.max(0, h)} rx={1} fill={seg.color} key={s} />
          })
          return (
            <g key={p.range}>
              {rects}
              {i % xLabelStep === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle">{p.label}</text>}
            </g>
          )
        }
        const h = (pointValue(p, metric) / max) * plotH
        return (
          <g key={p.range}>
            <rect x={x} y={baseY - h} width={Math.max(1, bw - 2)} height={Math.max(0, h)} rx={1} fill="var(--dsw-alias-brand-primary)" />
            {i % xLabelStep === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle">{p.label}</text>}
          </g>
        )
      })}
      {/* hit-rate line (right axis) — tokens mode only, and drawn as one
          quiet stroke: per-point circles added visual noise without information */}
      {metric === 'tokens' && (
        <polyline
          points={points.map((p, i) => `${padL + i * bw + bw / 2},${hitY(p.cacheHitRate)}`).join(' ')}
          fill="none"
          stroke="var(--dsw-alias-label-primary)"
          strokeWidth={1.5}
          strokeOpacity={0.55}
          strokeDasharray="4 3"
        />
      )}
      {/* hover hit zones + column highlight */}
      {points.map((p, i) => {
        const x = padL + i * bw
        return (
          <g key={`hit${p.range}`}>
            {hover === i && (
              <rect x={x + 0.5} y={padT + 0.5} width={Math.max(1, bw - 1)} height={plotH - 1} fill="var(--dsw-alias-brand-primary)" fillOpacity={0.06} stroke="var(--dsw-alias-label-primary)" strokeWidth={1} strokeDasharray="3 2" />
            )}
            <rect
              x={x}
              y={padT}
              width={bw}
              height={plotH}
              fill="transparent"
              style={{ cursor: 'crosshair' }}
              onMouseEnter={(event) => {
                setHover(i)
                showTip(p, event.clientX + 14, event.clientY + 14)
              }}
              onMouseMove={(event) => { showTip(p, event.clientX + 14, event.clientY + 14) }}
              onMouseLeave={() => {
                setHover(null)
                onTip(null)
              }}
            />
          </g>
        )
      })}
    </svg>
  )
}

/** Legend row for the trend chart (segments in tokens mode, line ditto). */
function TrendLegend({ metric, t }: { metric: TrendMetric; t: UsageTranslate }): ReactNode {
  return (
    <div className="dshau_legend">
      {metric === 'tokens' && SEGMENTS.map((seg) => (
        <span className="dshau_legendItem" key={seg.key}>
          <span className="dshau_legendSwatch" style={{ background: seg.color }} />
          {t(seg.labelKey)}
        </span>
      ))}
      {metric !== 'tokens' && (
        <span className="dshau_legendItem">
          <span className="dshau_legendSwatch" style={{ background: 'var(--dsw-alias-brand-primary)' }} />
          {t(metric === 'requests' ? 'usage.metric.requests' : 'usage.metric.cost')}
        </span>
      )}
      {metric === 'tokens' && (
        <span className="dshau_legendItem">
          <span className="dshau_legendLine" />
          {t('usage.card.cacheHitRate')}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// per-model table
// ---------------------------------------------------------------------------

function ModelTable({ models, t }: { models: UsageModelAgg[]; t: UsageTranslate }): ReactNode {
  if (models.length === 0) {
    return <div className="dshau_empty">{t('usage.models.empty')}</div>
  }
  return (
    <div className="dshau_tableWrap">
      <table className="dshau_table">
        <thead>
          <tr>
            <th>{t('usage.col.model')}</th>
            <th>{t('usage.col.requests')}</th>
            <th>{t('usage.col.input')}</th>
            <th>{t('usage.col.output')}</th>
            <th>{t('usage.col.cacheRead')}</th>
            <th>{t('usage.col.cacheWrite')}</th>
            <th>{t('usage.col.hitRate')}</th>
            <th>{t('usage.col.cost')}</th>
            <th>{t('usage.col.share')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={`${model.provider}/${model.model}`}>
              <td title={model.provider}>{model.model}</td>
              <td>{fmtInt(model.requests)}</td>
              <td>{fmtTokens(model.inputTokens)}</td>
              <td>{fmtTokens(model.outputTokens)}</td>
              <td>{fmtTokens(model.cacheReadTokens)}</td>
              <td>{fmtTokens(model.cacheWriteTokens)}</td>
              <td>{fmtPct(model.cacheHitRate)}</td>
              <td>{fmtCost(model.cost)}</td>
              <td>
                <span className="dshau_share">
                  {fmtPct(model.share)}
                  <span className="dshau_shareBar" style={{ width: `${Math.max(4, Math.round(model.share * 100))}px` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// section root
// ---------------------------------------------------------------------------

const RANGES = [7, 30, 90, 365] as const

export function UsageSection({ t }: UsageSectionProps): ReactNode {
  const [range, setRange] = useState<number>(30)
  const [metric, setMetric] = useState<TrendMetric>('tokens')
  const [heatMetric, setHeatMetric] = useState<'tokens' | 'requests'>('tokens')
  const [auto, setAuto] = useState<boolean>(true)
  const [error, setError] = useState<Failure | null>(null)
  const [summary, setSummary] = useState<SummaryWire | null>(null)
  const [heat, setHeat] = useState<HeatmapWire | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [disabled, setDisabled] = useState<boolean | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextSummary, nextHeat] = await Promise.all([
        fetchJson<SummaryWire>(`/plugins/@dsh-app/plugin-usage/api/summary?days=${range}`),
        fetchJson<HeatmapWire>(`/plugins/@dsh-app/plugin-usage/api/heatmap?weeks=${HEAT_WEEKS}`),
      ])
      setSummary(nextSummary)
      setHeat(nextHeat)
      setError(null)
    } catch (loadError) {
      setError(failureOf(loadError))
    }
  }, [range])

  // Liveness check first: the host may be disabled by the user config file
  // (the coexistence exit valve — see the host half's header), in which
  // case /status answers active:false and the section shows the notice.
  useEffect(() => {
    let cancelled = false
    fetchJson<{ active: boolean }>('/plugins/@dsh-app/plugin-usage/api/status')
      .then((status) => {
        if (cancelled) return
        if (status.active) {
          setDisabled(false)
          void load()
        } else {
          setDisabled(true)
        }
      })
      .catch(() => {
        if (!cancelled) setDisabled(false)
      })
    return () => { cancelled = true }
  }, [load])

  useEffect(() => {
    if (!auto || disabled !== false) return
    const timer = setInterval(() => { void load() }, 30_000)
    return () => { clearInterval(timer) }
  }, [auto, load, disabled])

  // Keep the tooltip inside the viewport (flip at right/bottom edges).
  useEffect(() => {
    const node = tipRef.current
    if (node === null || tip === null) return
    const rect = node.getBoundingClientRect()
    let { x, y } = tip
    if (x + rect.width > window.innerWidth - 8) x = x - rect.width - 28
    if (y + rect.height > window.innerHeight - 8) y = y - rect.height - 14
    node.style.left = `${Math.max(8, x)}px`
    node.style.top = `${Math.max(8, y)}px`
  }, [tip])

  if (disabled === true) {
    return (
      <section className="dshau_section">
        <div className="dshau_empty">{t('usage.disabled')}</div>
      </section>
    )
  }

  const loading = summary === null && heat === null && error === null
  const empty = summary !== null && summary.totals.requests === 0

  return (
    <section className="dshau_section" aria-labelledby="dsh-app-usage-title">
      <div className="dshau_header">
        <h2 id="dsh-app-usage-title" className="dshau_title">{t('usage.title')}</h2>
        <div className="dshau_tabs" role="tablist" aria-label={t('usage.tabs.aria')}>
          {RANGES.map((days) => (
            <button
              type="button"
              role="tab"
              aria-selected={range === days}
              className="dshau_tab"
              onClick={() => { setRange(days) }}
              key={days}
            >
              {t('usage.tabs.days', { days })}
            </button>
          ))}
        </div>
        <button type="button" className="dshau_secondaryButton" onClick={() => { void load() }}>{t('usage.refresh')}</button>
        <label className="dshau_autoToggle">
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => { setAuto(event.target.checked) }}
          />
          {t('usage.autoRefresh')}
        </label>
      </div>
      {error !== null && <div className="dshau_banner">{t('usage.loadFailed', { message: failureText(error, t) })}</div>}
      {loading ? (
        <div className="dshau_empty">{t('usage.loading')}</div>
      ) : empty ? (
        <>
          <div className="dshau_empty">{t('usage.empty')}</div>
          <BalanceCard t={t} />
        </>
      ) : (
        <>
          {summary !== null && <Cards totals={summary.totals} t={t} />}
          <BalanceCard t={t} />
          <div className="dshau_panel">
            <div className="dshau_panelHeader">
              <h3 className="dshau_panelTitle">
                {t('usage.cal.title', {
                  weeks: HEAT_WEEKS,
                  range: heat !== null ? t('usage.cal.titleRange', { since: fmtDate(heat.since), until: fmtDate(heat.until) }) : '',
                })}
              </h3>
              <div className="dshau_legend">
                <span className="dshau_legendItem">
                  <button
                    type="button"
                    className="dshau_secondaryButton"
                    onClick={() => { setHeatMetric(heatMetric === 'tokens' ? 'requests' : 'tokens') }}
                  >
                    {t('usage.cal.colorBy', { metric: t(heatMetric === 'tokens' ? 'usage.metric.tokens' : 'usage.metric.requests') })}
                  </button>
                </span>
                <span className="dshau_legendItem">{t('usage.cal.less')}</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <span className="dshau_legendCell" data-level={level} key={level} />
                ))}
                <span className="dshau_legendItem">{t('usage.cal.more')}</span>
              </div>
            </div>
            {heat !== null && <HeatCalendar heat={heat} metric={heatMetric} onTip={setTip} t={t} />}
          </div>
          <div className="dshau_panel">
            <div className="dshau_panelHeader">
              <h3 className="dshau_panelTitle">{t('usage.trend.title', { days: range, weekly: range > 60 ? t('usage.trend.weekly') : '' })}</h3>
              <div className="dshau_tabs dshau_metricTabs" role="tablist" aria-label={t('usage.metric.aria')}>
                {TREND_METRICS.map((m) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={metric === m.id}
                    className="dshau_tab"
                    onClick={() => { setMetric(m.id) }}
                    key={m.id}
                  >
                    {t(m.labelKey)}
                  </button>
                ))}
              </div>
              <TrendLegend metric={metric} t={t} />
            </div>
            {summary !== null && (
              <TrendChart daily={summary.daily} range={range} metric={metric} onTip={setTip} t={t} />
            )}
          </div>
          <div className="dshau_panel">
            <h3 className="dshau_panelTitle">{t('usage.models.title', { days: range })}</h3>
            <ModelTable models={summary?.models ?? []} t={t} />
          </div>
        </>
      )}
      <div
        ref={tipRef}
        className="dshau_tooltip"
        style={{ display: tip === null ? 'none' : 'block' }}
      >
        {tip !== null && tip.text.map((line) => (
          <div className={line.length < 12 ? 'dshau_tooltipTitle' : undefined} key={line}>{line}</div>
        ))}
      </div>
    </section>
  )
}
