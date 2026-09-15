/**
 * The 网络搜索 settings section.
 *
 * Three concerns, in the order the user meets them:
 * 1. **Which provider answers** — the 品牌/原生 switch. This is the page's
 *    headline control: it decides whether `ctx.web` resolves this plugin's
 *    engine chain or the upstream DeepSeek search, and it takes effect
 *    immediately (no restart).
 * 2. **The engine chain** — per-engine enable, priority, key, and a live
 *    probe. Ordering is expressed as up/down moves rather than a number
 *    field, so the list is the single source of the order.
 * 3. **Chain behavior** — fallback vs rotate, budget, cache TTL, result cap.
 *
 * Secret hygiene: literal apiKey values come back from the host masked
 * (••••••); a save that leaves the mask untouched sends it back and the host
 * keeps the stored value. `$ENV:NAME` references are verbatim.
 *
 * @module @dsh-app/plugin-websearch/client/websearch-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { EngineEntry, EngineStatus, WebSearchFile } from '../wire.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'

const ROUTE = '/plugins/@dsh-app/plugin-websearch/api'

/** One engine row as the host serializes it. */
interface EngineView {
  readonly id: string
  readonly label: string
  readonly tier: 'free' | 'key'
  readonly hint: string
  readonly entry: EngineEntry
  readonly status: EngineStatus
}

/** One provider choice with its real availability. */
interface ProviderView {
  readonly id: string
  readonly selected: boolean
  readonly state: 'ready' | 'unavailable' | 'unknown'
  readonly reason?: string
}

/** The host route's payload (mirror of the host's buildView). */
interface ConfigResponse {
  readonly file: WebSearchFile
  readonly engines: readonly EngineView[]
  readonly activeProvider: string
  readonly providers: readonly ProviderView[]
  readonly filePath: string
  readonly seamAvailable: boolean
}

/** One engine's probe outcome. */
interface ProbeRow {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly latencyMs?: number
  readonly resultCount?: number
  readonly error?: string
}

interface ProbeResponse {
  readonly query: string
  readonly results: readonly ProbeRow[]
  readonly provider: string
}

/** The end-to-end self-check's outcome (runs through `ctx.web.search`). */
interface SelfTestResponse {
  readonly query: string
  readonly ok?: boolean
  readonly provider?: string
  readonly resultCount?: number
  readonly latencyMs?: number
  readonly cached?: boolean
  readonly engine?: string
  readonly failedEngines?: readonly string[]
  readonly note?: string
  readonly error?: string
  readonly chainExhausted?: boolean
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  'dsh-app': '品牌引擎链',
  'deepseek-official': 'DeepSeek 官方',
}

/** zh-CN label for one engine status. */
function statusLabel(status: EngineStatus): { text: string, tone: 'ok' | 'err' | 'muted' } {
  switch (status.state) {
    case 'ready':
      return { text: '就绪', tone: 'ok' }
    case 'blocked':
      // Enabled but missing what it needs — the message says whether that is
      // an API key or a SearXNG instance, so the badge never claims the wrong
      // remedy.
      return { text: status.message ?? '缺少必要配置', tone: 'err' }
    case 'disabled':
      return { text: '已停用', tone: 'muted' }
    case 'error':
      return { text: status.message ?? '上次探测失败', tone: 'err' }
    default:
      return { text: '未探测', tone: 'muted' }
  }
}

/**
 * How long a success notice stays on screen.
 *
 * A save confirmation is transient feedback, not state: leaving it up forever
 * (the previous behaviour) made a stale "引擎开关已保存" sit above the form
 * and read as a current condition. Errors deliberately do NOT auto-dismiss —
 * they describe something the user still has to act on.
 */
const NOTICE_TIMEOUT_MS = 3_000

/**
 * The section component.
 * @returns the rendered settings section.
 */
export function WebSearchSection(): ReactNode {
  const [view, setView] = useState<ConfigResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The current success notice, tagged with a sequence number so that saving
   * the SAME message twice still restarts the dismiss timer (a plain string
   * would be a no-op state update and the second save would inherit the first
   * one's remaining time).
   */
  const [notice, setNotice] = useState<{ text: string, seq: number } | null>(null)
  const noticeSeq = useRef(0)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<ProbeResponse | null>(null)
  const [probeBusy, setProbeBusy] = useState(false)
  const [selfTest, setSelfTest] = useState<SelfTestResponse | null>(null)
  const [selfTestBusy, setSelfTestBusy] = useState(false)
  const [draft, setDraft] = useState<WebSearchFile | null>(null)
  const [instancesText, setInstancesText] = useState('')
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null)

  /** Show a transient success notice, replacing any previous one. */
  const showNotice = useCallback((text: string): void => {
    noticeSeq.current += 1
    setNotice({ text, seq: noticeSeq.current })
  }, [])

  // Auto-dismiss the success notice. Keyed on the notice object, so a new
  // save clears the old timer and starts a fresh one.
  useEffect(() => {
    if (notice === null) return undefined
    const timer = setTimeout(() => { setNotice(null) }, NOTICE_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [notice])

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchJson<ConfigResponse>(`${ROUTE}/config`)
      setView(next)
      setDraft(next.file)
      setInstancesText(next.file.searxngInstances.join('\n'))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Persist the current draft (plus the instance textarea) and refresh. */
  const save = useCallback(async (next: WebSearchFile, instances: string, message: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const body = {
        ...next,
        searxngInstances: instances
          .split('\n')
          .map(line => line.trim())
          .filter(line => line !== ''),
      }
      const saved = await fetchJson<ConfigResponse>(`${ROUTE}/config/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      setView(saved)
      setDraft(saved.file)
      setInstancesText(saved.file.searxngInstances.join('\n'))
      setError(null)
      showNotice(message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [showNotice])

  /** Move one engine up or down, then persist the new order. */
  const move = useCallback((id: string, delta: number): void => {
    if (draft === null) return
    const ordered = [...draft.engines].sort((a, b) => a.priority - b.priority)
    const index = ordered.findIndex(entry => entry.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= ordered.length) return
    const [moved] = ordered.splice(index, 1)
    ordered.splice(target, 0, moved)
    const reprioritized = ordered.map((entry, position) => ({ ...entry, priority: position }))
    const next: WebSearchFile = { ...draft, engines: reprioritized }
    setDraft(next)
    void save(next, instancesText, '引擎顺序已保存')
  }, [draft, instancesText, save])

  /** Flip one engine's enable bit, then persist. */
  const toggleEngine = useCallback((id: string): void => {
    if (draft === null) return
    const next: WebSearchFile = {
      ...draft,
      engines: draft.engines.map(entry => entry.id === id ? { ...entry, enabled: !entry.enabled } : entry),
    }
    setDraft(next)
    void save(next, instancesText, '引擎开关已保存')
  }, [draft, instancesText, save])

  /** Edit one engine's key (kept in the draft until Save is pressed). */
  const setKey = useCallback((id: string, apiKey: string): void => {
    if (draft === null) return
    setDraft({
      ...draft,
      engines: draft.engines.map(entry => entry.id === id ? { ...entry, apiKey } : entry),
    })
  }, [draft])

  /** Persist the engine keys the user typed. */
  const saveKeys = useCallback((): void => {
    if (draft === null) return
    void save(draft, instancesText, '密钥已保存')
  }, [draft, instancesText, save])

  /** Persist the non-engine settings (mode, budget, cache, cap, instances). */
  const saveSettings = useCallback((patch: Partial<WebSearchFile>): void => {
    if (draft === null) return
    const next: WebSearchFile = { ...draft, ...patch }
    setDraft(next)
    void save(next, instancesText, '设置已保存')
  }, [draft, instancesText, save])

  /** Run the probe for one engine or all of them. */
  const runProbe = useCallback(async (id?: string): Promise<void> => {
    setProbeBusy(true)
    setProbe(null)
    try {
      const result = await fetchJson<ProbeResponse>(`${ROUTE}/engine/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(id === undefined ? {} : { id }),
      })
      setProbe(result)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProbeBusy(false)
    }
  }, [])

  /** Run the end-to-end self-check through the real `ctx.web` seam. */
  const runSelfTest = useCallback(async (): Promise<void> => {
    setSelfTestBusy(true)
    setSelfTest(null)
    try {
      const result = await fetchJson<SelfTestResponse>(`${ROUTE}/selftest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      setSelfTest(result)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSelfTestBusy(false)
    }
  }, [])

  if (view === null || draft === null) {
    return (
      <div className="dshWs-section">
        <h3 className="dshWs-title">网络搜索</h3>
        {error === null
          ? <p className="dshWs-hint">正在加载…</p>
          : <div className="dshWs-banner">{error}</div>}
      </div>
    )
  }

  const ordered = [...draft.engines].sort((a, b) => a.priority - b.priority)
  const activeLabel = PROVIDER_LABELS[draft.provider] ?? draft.provider
  const brandActive = draft.provider === 'dsh-app'

  /** Switching provider is the one action worth confirming: it changes what
   * every future web_search call does, and the other side may be unusable
   * (the upstream provider needs a DeepSeek key and a mounted loader row). */
  const requestSwitch = (provider: string): void => {
    if (provider === draft.provider) return
    setConfirmSwitch(provider)
  }

  /** The target provider's own verdict, used to make the confirm dialog
   * honest about what the user is about to select. */
  const providerReason = (id: string): string | undefined =>
    view.providers.find(item => item.id === id)?.reason

  return (
    <div className="dshWs-section">
      <h3 className="dshWs-title">网络搜索</h3>
      <p className="dshWs-hint">
        决定 <code>web_search</code> 工具走哪条链路。工具本身是内核自带的，这里只切换它背后的搜索来源。
      </p>

      {!view.seamAvailable && (
        <div className="dshWs-warning">
          当前内核没有 <code>ctx.web</code> 服务，品牌引擎链无法注册；配置仍可编辑，但不会生效。
        </div>
      )}
      {error !== null && <div className="dshWs-banner">{error}</div>}
      {notice !== null && <div className="dshWs-noticeOk">{notice.text}</div>}

      <div className="dshWs-card">
        <div className="dshWs-cardHead">
          <h4 className="dshWs-cardTitle">搜索来源</h4>
          <span className="dshWs-badge">当前：{activeLabel}</span>
        </div>
        <div className="dshWs-providerRow" role="radiogroup" aria-label="搜索来源">
          {view.providers.map((provider) => {
            const label = PROVIDER_LABELS[provider.id] ?? provider.id
            const dot = provider.state === 'ready'
              ? ' dshWs-providerDotOn'
              : provider.state === 'unavailable' ? ' dshWs-providerDotOff' : ''
            const stateText = provider.state === 'ready'
              ? '可用'
              : provider.state === 'unavailable' ? '不可用' : '状态未知'
            return (
              <button
                key={provider.id}
                type="button"
                role="radio"
                aria-checked={provider.selected}
                className={`dshWs-providerCard${provider.selected ? ' dshWs-providerCardOn' : ''}`}
                disabled={busy}
                onClick={() => { requestSwitch(provider.id) }}
              >
                <span className="dshWs-providerHead">
                  <span className={`dshWs-providerDot${dot}`} aria-hidden="true" />
                  {label}
                  <span className="dshWs-badge">{provider.selected ? '使用中' : stateText}</span>
                </span>
                <span className="dshWs-providerMeta">
                  {provider.selected
                    ? (provider.state === 'ready' ? '当前生效' : provider.reason ?? stateText)
                    : provider.reason ?? (provider.id === 'dsh-app'
                      ? '免费引擎优先，失败自动回退，无需密钥'
                      : '内核自带的 DeepSeek 搜索，需要 DEEPSEEK_API_KEY 且按次计费')}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="dshWs-card">
        <div className="dshWs-cardHead">
          <h4 className="dshWs-cardTitle">引擎链</h4>
          <span className="dshWs-badge">按顺序尝试，失败自动回退</span>
        </div>
        <p className="dshWs-hint">
          从上到下依次尝试；靠前的引擎返回结果后即停止，只有失败或空结果才会继续往下走。
        </p>
        {ordered.map((entry, index) => {
          const meta = view.engines.find(item => item.id === entry.id)
          const label = meta?.label ?? entry.id
          const tier = meta?.tier ?? 'free'
          const hint = meta?.hint ?? ''
          const status = meta?.status ?? { state: 'unknown' as const }
          const rendered = statusLabel(status)
          const probeRow = probe?.results.find(row => row.id === entry.id)
          return (
            <div className="dshWs-engineRow" key={entry.id}>
              <div className="dshWs-order">
                <button
                  type="button"
                  className="dshWs-orderBtn"
                  aria-label={`上移 ${label}`}
                  disabled={busy || index === 0}
                  onClick={() => { move(entry.id, -1) }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="dshWs-orderBtn"
                  aria-label={`下移 ${label}`}
                  disabled={busy || index === ordered.length - 1}
                  onClick={() => { move(entry.id, 1) }}
                >
                  ▼
                </button>
              </div>
              <div className="dshWs-engineMain">
                <div className="dshWs-engineName">
                  <span>{index + 1}. {label}</span>
                  <span className={`dshWs-badge ${tier === 'free' ? 'dshWs-badgeFree' : 'dshWs-badgeKey'}`}>
                    {tier === 'free' ? '免费' : '需密钥'}
                  </span>
                  <span className={`dshWs-engineStatus${rendered.tone === 'ok' ? ' dshWs-engineStatusOk' : rendered.tone === 'err' ? ' dshWs-engineStatusErr' : ''}`}>
                    {rendered.text}
                  </span>
                </div>
                <div className="dshWs-engineHint">{hint}</div>
                {probeRow !== undefined && (
                  <div className={`dshWs-engineStatus${probeRow.ok ? ' dshWs-engineStatusOk' : ' dshWs-engineStatusErr'}`}>
                    {probeRow.ok
                      ? `探测成功：${String(probeRow.resultCount ?? 0)} 条结果，${String(probeRow.latencyMs ?? 0)} ms`
                      : `探测失败：${probeRow.error ?? '未知原因'}`}
                  </div>
                )}
                {tier === 'key' && (
                  <input
                    className="dshWs-input"
                    type="text"
                    placeholder="API Key 或 $ENV:变量名"
                    aria-label={`${label} 的 API Key`}
                    value={entry.apiKey ?? ''}
                    disabled={busy}
                    onChange={(event) => { setKey(entry.id, event.target.value) }}
                  />
                )}
              </div>
              <div className="dshWs-engineActions">
                <button
                  type="button"
                  className="dshWs-button"
                  disabled={probeBusy}
                  onClick={() => { void runProbe(entry.id) }}
                >
                  测试
                </button>
                <button
                  type="button"
                  className="dshWs-toggle"
                  role="switch"
                  aria-checked={entry.enabled}
                  aria-label={`${label} 启用`}
                  disabled={busy}
                  onClick={() => { toggleEngine(entry.id) }}
                />
              </div>
            </div>
          )
        })}
        <div className="dshWs-row">
          <button type="button" className="dshWs-button" disabled={probeBusy} onClick={() => { void runProbe() }}>
            {probeBusy ? '测试中…' : '一键测试全部'}
          </button>
          <button type="button" className="dshWs-button" disabled={busy} onClick={saveKeys}>
            保存密钥
          </button>
        </div>
        <div className="dshWs-row">
          <button type="button" className="dshWs-button dshWs-buttonPrimary" disabled={selfTestBusy} onClick={() => { void runSelfTest() }}>
            {selfTestBusy ? '端到端自检中…' : '端到端自检'}
          </button>
          <span className="dshWs-fieldHint">走一次真实搜索，验证 web_search 当前到底解析到哪个来源</span>
        </div>
        {selfTest !== null && (
          <div className="dshWs-probeList">
            <div className="dshWs-hint">自检查询：「{selfTest.query}」</div>
            {selfTest.error === undefined ? (
              <>
                <div className="dshWs-probeRow">
                  <span className="dshWs-probeName">{PROVIDER_LABELS[selfTest.provider ?? ''] ?? selfTest.provider ?? '未知'}</span>
                  <span className="dshWs-engineStatusOk">
                    {String(selfTest.resultCount ?? 0)} 条结果 / {String(selfTest.latencyMs ?? 0)} ms
                    {selfTest.engine !== undefined ? ` · 实际引擎 ${selfTest.engine}` : ''}
                    {selfTest.cached === true ? ' · 缓存命中' : ''}
                  </span>
                </div>
                {selfTest.note !== undefined && (
                  <div className="dshWs-hint">{selfTest.note}</div>
                )}
              </>
            ) : (
              <div className="dshWs-probeRow">
                <span className="dshWs-engineStatusErr">
                  {selfTest.chainExhausted === true ? '引擎链全部失败：' : '自检失败：'}
                  {selfTest.error}
                </span>
              </div>
            )}
          </div>
        )}
        {probe !== null && (
          <div className="dshWs-probeList">
            <div className="dshWs-hint">探测查询：「{probe.query}」</div>
            {probe.results.map(row => (
              <div className="dshWs-probeRow" key={row.id}>
                <span className="dshWs-probeName">{row.label}</span>
                <span className={row.ok ? 'dshWs-engineStatusOk' : 'dshWs-engineStatusErr'}>
                  {row.ok
                    ? `${String(row.resultCount ?? 0)} 条结果 / ${String(row.latencyMs ?? 0)} ms`
                    : row.error ?? '失败'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dshWs-card">
        <h4 className="dshWs-cardTitle">回退策略</h4>
        <div className="dshWs-segmented" role="group" aria-label="回退策略">
          <button
            type="button"
            className={`dshWs-segBtn${draft.mode === 'fallback' ? ' dshWs-segBtnOn' : ''}`}
            aria-pressed={draft.mode === 'fallback'}
            disabled={busy}
            onClick={() => { saveSettings({ mode: 'fallback' }) }}
          >
            固定顺序
          </button>
          <button
            type="button"
            className={`dshWs-segBtn${draft.mode === 'rotate' ? ' dshWs-segBtnOn' : ''}`}
            aria-pressed={draft.mode === 'rotate'}
            disabled={busy}
            onClick={() => { saveSettings({ mode: 'rotate' }) }}
          >
            轮询
          </button>
        </div>
        <p className="dshWs-fieldHint">
          {draft.mode === 'fallback'
            ? '每次搜索都从第一个可用引擎开始，结果最稳定。'
            : '每次搜索从下一个引擎开始（循环），把请求摊到多个引擎上，适合免费额度有限的情况。'}
        </p>
        <div className="dshWs-grid">
          <label className="dshWs-field dshWs-fieldGrow">
            <span className="dshWs-label">超时预算（毫秒）</span>
            <input
              className="dshWs-input"
              type="number"
              min={3000}
              max={120000}
              step={1000}
              value={draft.timeoutMs}
              disabled={busy}
              onChange={(event) => { setDraft({ ...draft, timeoutMs: Number(event.target.value) }) }}
              onBlur={() => { saveSettings({}) }}
            />
          </label>
          <label className="dshWs-field dshWs-fieldGrow">
            <span className="dshWs-label">结果上限</span>
            <input
              className="dshWs-input"
              type="number"
              min={1}
              max={50}
              value={draft.maxResults}
              disabled={busy}
              onChange={(event) => { setDraft({ ...draft, maxResults: Number(event.target.value) }) }}
              onBlur={() => { saveSettings({}) }}
            />
          </label>
          <label className="dshWs-field dshWs-fieldGrow">
            <span className="dshWs-label">缓存（分钟，0 关闭）</span>
            <input
              className="dshWs-input"
              type="number"
              min={0}
              max={60}
              value={draft.cacheTtlMinutes}
              disabled={busy}
              onChange={(event) => { setDraft({ ...draft, cacheTtlMinutes: Number(event.target.value) }) }}
              onBlur={() => { saveSettings({}) }}
            />
          </label>
        </div>
        <label className="dshWs-field dshWs-fieldBlock">
          <span className="dshWs-label">SearXNG 实例（每行一个，留空则跳过该引擎）</span>
          <textarea
            className="dshWs-textarea"
            placeholder="https://searx.example.com"
            value={instancesText}
            disabled={busy}
            onChange={(event) => { setInstancesText(event.target.value) }}
          />
        </label>
        <p className="dshWs-fieldHint">
          多数公共 SearXNG 实例未启用 JSON API，请填自建实例（配置里开启 <code>search.formats: [json]</code>）。
        </p>
        <div className="dshWs-row">
          <button type="button" className="dshWs-button" disabled={busy} onClick={() => { saveSettings({}) }}>
            保存设置
          </button>
        </div>
      </div>

      <p className="dshWs-path">配置文件：{view.filePath}</p>

      <ConfirmDialog
        open={confirmSwitch !== null}
        title="切换搜索来源"
        message={confirmSwitch === null ? '' : (() => {
          const target = confirmSwitch
          const label = PROVIDER_LABELS[target] ?? target
          const reason = providerReason(target)
          const base = target === 'deepseek-official'
            ? '切换后 web_search 将由 DeepSeek 官方搜索回答，需要有效的 DEEPSEEK_API_KEY，且每次搜索计费。'
            : '切换后 web_search 将由品牌引擎链回答（免费引擎优先，失败自动回退）。'
          // When the host already knows the target cannot work, saying so in
          // the confirmation is the difference between an informed choice and
          // a silent breakage the user discovers at the next search.
          const warn = reason === undefined ? '' : `\n\n注意：${label} 当前${reason}`
          return `${base}${warn}\n\n确定切换吗？`
        })()}
        confirmLabel="切换"
        busy={busy}
        onConfirm={() => {
          const provider = confirmSwitch
          setConfirmSwitch(null)
          if (provider !== null && draft !== null) {
            void save({ ...draft, provider }, instancesText, '搜索来源已切换')
          }
        }}
        onClose={() => { setConfirmSwitch(null) }}
      />
    </div>
  )
}
