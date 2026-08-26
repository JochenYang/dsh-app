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
 * @module @dsh-app/plugin-usage/client/usage-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { UsageAgg, UsageBalance, UsageHeatmap, UsageModelAgg, UsageSummary } from '../types.ts'

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  const body = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

// ---------------------------------------------------------------------------
// summary cards
// ---------------------------------------------------------------------------

function Cards({ totals }: { totals: UsageAgg }): ReactNode {
  const items: Array<[string, string, string]> = [
    ['请求数', fmtInt(totals.requests), ''],
    ['总 tokens', fmtTokens(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens), '输入+输出+缓存读写'],
    ['输入 tokens（未命中缓存）', fmtTokens(totals.inputTokens), ''],
    ['输出 tokens', fmtTokens(totals.outputTokens), ''],
    ['缓存命中率', fmtPct(totals.cacheHitRate), `${fmtTokens(totals.cacheReadTokens)} 读 / ${fmtTokens(totals.inputTokens + totals.cacheWriteTokens)} 未命中`],
    ['缓存读 tokens', fmtTokens(totals.cacheReadTokens), ''],
    ['缓存写 tokens', fmtTokens(totals.cacheWriteTokens), ''],
    ['推理 tokens', fmtTokens(totals.reasoningTokens), ''],
    ['估算成本', fmtCost(totals.cost), totals.cost > 0 ? '仅 DeepSeek 官方 API · 分时价估算' : '未配置定价'],
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
// DeepSeek official account balance card (manual query, no polling)
// ---------------------------------------------------------------------------

type BalanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; balance: UsageBalance; at: number }
  | { status: 'error'; message: string }

function BalanceCard(): ReactNode {
  const [state, setState] = useState<BalanceState>({ status: 'idle' })

  const query = useCallback(async () => {
    if (state.status === 'loading') return
    setState({ status: 'loading' })
    try {
      const balance = await fetchJson<UsageBalance>('/plugins/@dsh-app/plugin-usage/api/balance')
      setState({ status: 'ok', balance, at: Date.now() })
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [state.status])

  const entry = state.status === 'ok' ? (state.balance.balances.find((b) => b.currency === 'CNY') ?? state.balance.balances[0]) : undefined
  const value = state.status === 'loading'
    ? '查询中…'
    : entry !== undefined
      ? `${entry.currency === 'CNY' ? '¥' : ''}${entry.total}${entry.currency !== 'CNY' ? ` ${entry.currency}` : ''}`
      : state.status === 'error'
        ? '查询失败'
        : '—'
  const sub = state.status === 'ok' && entry !== undefined
    ? `赠金 ${entry.granted} · 充值 ${entry.toppedUp}`
    : state.status === 'error'
      ? state.message
      : '点击查询 DeepSeek 官方账户'
  const subClass = state.status === 'error' ? 'dshau_cardSub dshau_cardSubError' : 'dshau_cardSub'
  const queriedAt = state.status === 'ok'
    ? ` · ${String(new Date(state.at).getHours()).padStart(2, '0')}:${String(new Date(state.at).getMinutes()).padStart(2, '0')} 查询`
    : ''

  return (
    <div
      className="dshau_card dshau_cardClickable"
      role="button"
      tabIndex={0}
      aria-label="查询 DeepSeek 官方账户余额"
      onClick={() => { void query() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void query()
        }
      }}
    >
      <div className="dshau_cardLabel">API 余额{queriedAt}</div>
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

function HeatCalendar({ heat, metric, onTip }: { heat: HeatmapWire; metric: 'tokens' | 'requests'; onTip: (tip: Tip | null) => void }): ReactNode {
  const { cells, weeks } = heat
  const max = cells.reduce((m, cell) => {
    const v = metric === 'tokens' ? cell.totalTokens : cell.requests
    return v > m ? v : m
  }, 0)
  const dows = ['日', '一', '二', '三', '四', '五', '六']
  const firstDow = new Date(`${cells[0]!.date}T00:00:00`).getDay()
  const monthLabels: string[] = []
  const monthSpans: number[] = []
  for (let w = 0; w < weeks; w += 1) {
    const date = cells[w * 7]!.date
    const prev = w > 0 ? cells[(w - 1) * 7]!.date : ''
    monthLabels.push(w === 0 || date.slice(0, 7) !== prev.slice(0, 7) ? `${Number(date.slice(5, 7))}月` : '')
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
    `请求 ${cell.requests} · 总 tokens ${fmtTokens(cell.totalTokens)}`,
    `缓存命中率 ${fmtPct(cell.cacheHitRate)}`,
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
            title={tipText(cell).join('\n')}
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
const SEGMENTS: Array<{ key: 'cacheReadTokens' | 'inputTokens' | 'cacheWriteTokens' | 'outputTokens'; label: string; color: string }> = [
  { key: 'cacheReadTokens', label: '缓存读', color: 'var(--dsw-alias-state-success-primary)' },
  { key: 'inputTokens', label: '输入', color: 'var(--dsw-alias-brand-primary)' },
  { key: 'cacheWriteTokens', label: '缓存写', color: 'var(--dsw-alias-state-warn-primary)' },
  { key: 'outputTokens', label: '输出', color: 'var(--dsw-alias-state-business-primary)' },
]

const TREND_METRICS: Array<{ id: TrendMetric; label: string }> = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'requests', label: '请求数' },
  { id: 'cost', label: '成本' },
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

function TrendChart({ daily, range, metric, onTip }: {
  daily: UsageAgg[]
  range: number
  metric: TrendMetric
  onTip: (tip: Tip | null) => void
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
        `请求 ${fmtInt(p.requests)} · 命中率 ${fmtPct(p.cacheHitRate)}`,
        `输入 ${fmtTokens(p.inputTokens)} · 缓存读 ${fmtTokens(p.cacheReadTokens)}`,
        `缓存写 ${fmtTokens(p.cacheWriteTokens)} · 输出 ${fmtTokens(p.outputTokens)}`,
        `成本 ${fmtCost(p.cost)}`,
      ]
      : metric === 'requests'
        ? [p.range, `请求 ${fmtInt(p.requests)}`, `命中率 ${fmtPct(p.cacheHitRate)}`, `成本 ${fmtCost(p.cost)}`]
        : [p.range, `成本 ${fmtCost(p.cost)}`, `请求 ${fmtInt(p.requests)}`, `命中率 ${fmtPct(p.cacheHitRate)}`]
    onTip({ text: lines, x, y })
  }

  const hitY = (rate: number): number => padT + plotH - rate * plotH

  return (
    <svg className="dshau_chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每日用量趋势">
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
function TrendLegend({ metric }: { metric: TrendMetric }): ReactNode {
  return (
    <div className="dshau_legend">
      {metric === 'tokens' && SEGMENTS.map((seg) => (
        <span className="dshau_legendItem" key={seg.key}>
          <span className="dshau_legendSwatch" style={{ background: seg.color }} />
          {seg.label}
        </span>
      ))}
      {metric !== 'tokens' && (
        <span className="dshau_legendItem">
          <span className="dshau_legendSwatch" style={{ background: 'var(--dsw-alias-brand-primary)' }} />
          {metric === 'requests' ? '请求数' : '成本'}
        </span>
      )}
      {metric === 'tokens' && (
        <span className="dshau_legendItem">
          <span className="dshau_legendLine" />
          缓存命中率
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// per-model table
// ---------------------------------------------------------------------------

function ModelTable({ models }: { models: UsageModelAgg[] }): ReactNode {
  if (models.length === 0) {
    return <div className="dshau_empty">暂无数据</div>
  }
  return (
    <div className="dshau_tableWrap">
      <table className="dshau_table">
        <thead>
          <tr>
            <th>模型</th>
            <th>请求</th>
            <th>输入</th>
            <th>输出</th>
            <th>缓存读</th>
            <th>缓存写</th>
            <th>命中率</th>
            <th>成本</th>
            <th>占比</th>
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

export function UsageSection(): ReactNode {
  const [range, setRange] = useState<number>(30)
  const [metric, setMetric] = useState<TrendMetric>('tokens')
  const [heatMetric, setHeatMetric] = useState<'tokens' | 'requests'>('tokens')
  const [auto, setAuto] = useState<boolean>(true)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<SummaryWire | null>(null)
  const [heat, setHeat] = useState<HeatmapWire | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [disabled, setDisabled] = useState<boolean | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextSummary, nextHeat] = await Promise.all([
        fetchJson<SummaryWire>(`/plugins/@dsh-app/plugin-usage/api/summary?days=${range}`),
        fetchJson<HeatmapWire>('/plugins/@dsh-app/plugin-usage/api/heatmap?weeks=26'),
      ])
      setSummary(nextSummary)
      setHeat(nextHeat)
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
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
        <div className="dshau_empty">内置用量统计已在用户配置中停用（enabled=false）。将 storages/dsh-app-plugin-usage/config.json 中的 enabled 改为 true 或删除该文件后重启即可恢复。</div>
      </section>
    )
  }

  const loading = summary === null && heat === null && error === ''
  const empty = summary !== null && summary.totals.requests === 0

  return (
    <section className="dshau_section" aria-labelledby="dsh-app-usage-title">
      <div className="dshau_header">
        <h2 id="dsh-app-usage-title" className="dshau_title">用量统计</h2>
        <div className="dshau_tabs" role="tablist" aria-label="统计区间">
          {RANGES.map((days) => (
            <button
              type="button"
              role="tab"
              aria-selected={range === days}
              className="dshau_tab"
              onClick={() => { setRange(days) }}
              key={days}
            >
              {days}
              天
            </button>
          ))}
        </div>
        <button type="button" className="dshau_secondaryButton" onClick={() => { void load() }}>刷新</button>
        <label className="dshau_autoToggle">
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => { setAuto(event.target.checked) }}
          />
          自动刷新
        </label>
      </div>
      {error !== '' && <div className="dshau_banner">{`加载失败：${error}`}</div>}
      {loading ? (
        <div className="dshau_empty">加载中…</div>
      ) : empty ? (
        <>
          <div className="dshau_empty">暂无用量数据</div>
          <BalanceCard />
        </>
      ) : (
        <>
          {summary !== null && <Cards totals={summary.totals} />}
          <BalanceCard />
          <div className="dshau_panel">
            <div className="dshau_panelHeader">
              <h3 className="dshau_panelTitle">
                {`每日热力（最近 26 周${heat !== null ? ` · ${fmtDate(heat.since)} ~ ${fmtDate(heat.until)}` : ''}）`}
              </h3>
              <div className="dshau_legend">
                <span className="dshau_legendItem">
                  <button
                    type="button"
                    className="dshau_secondaryButton"
                    onClick={() => { setHeatMetric(heatMetric === 'tokens' ? 'requests' : 'tokens') }}
                  >
                    {`着色依据：${heatMetric === 'tokens' ? 'Tokens' : '请求数'}`}
                  </button>
                </span>
                <span className="dshau_legendItem">少</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <span className="dshau_legendCell" data-level={level} key={level} />
                ))}
                <span className="dshau_legendItem">多</span>
              </div>
            </div>
            {heat !== null && <HeatCalendar heat={heat} metric={heatMetric} onTip={setTip} />}
          </div>
          <div className="dshau_panel">
            <div className="dshau_panelHeader">
              <h3 className="dshau_panelTitle">{`每日趋势（近 ${range} 天${range > 60 ? '，按周聚合' : ''}）`}</h3>
              <div className="dshau_tabs dshau_metricTabs" role="tablist" aria-label="趋势指标">
                {TREND_METRICS.map((m) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={metric === m.id}
                    className="dshau_tab"
                    onClick={() => { setMetric(m.id) }}
                    key={m.id}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <TrendLegend metric={metric} />
            </div>
            {summary !== null && (
              <TrendChart daily={summary.daily} range={range} metric={metric} onTip={setTip} />
            )}
          </div>
          <div className="dshau_panel">
            <h3 className="dshau_panelTitle">{`按模型用量（近 ${range} 天）`}</h3>
            <ModelTable models={summary?.models ?? []} />
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
