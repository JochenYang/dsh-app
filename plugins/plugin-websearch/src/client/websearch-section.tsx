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
 * Every string this page renders comes from the `dsh-app.websearch` namespace
 * through the `t` standard seat: the section registers with `locale: NS`, so
 * the renderer hands the component a namespace-bound translate that reads the
 * active UI locale at call time and re-renders on a language switch. Text the
 * HOST wrote (engine labels and hints, availability reasons, route errors) is
 * shown verbatim. Sentences with inline `<code>` markup are assembled from
 * `…before`/`…after` key pairs, because `t` returns a plain string and the
 * term has to stay a real element.
 *
 * @module @dsh-app/plugin-websearch/client/websearch-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineEntry, EngineStatus, HostText, WebSearchFile } from '../wire.ts'
// Coded host messages: the code → copy tables live in a React-free module so
// the suite can test them (a .tsx cannot be bundled by the test harness).
import { hostMessage, providerReasonCopy, routeErrorCopy, statusLabel } from './host-message.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { NS, type WebSearchKey } from './locales.ts'

/**
 * The host half's route prefix on the shared Connection `/api` channel. Mirrors
 * `ROUTE_PREFIX` in ../routes.ts; the registry admits no `@` in a path segment,
 * so the npm scope travels as `dsh-app`.
 */
const ROUTE = '/api/plugins/dsh-app/plugin-websearch'

/** One engine row as the host serializes it. */
interface EngineView {
  readonly id: string
  readonly label: string
  readonly tier: 'free' | 'key'
  readonly entry: EngineEntry
  readonly status: EngineStatus
}

/** One provider choice with its real availability. */
interface ProviderView {
  readonly id: string
  readonly selected: boolean
  readonly state: 'ready' | 'unavailable' | 'unknown'
  readonly reason?: HostText
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
  readonly error?: HostText
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
  readonly error?: HostText
  readonly chainExhausted?: boolean
}

/** A failure carrying the host's coded message, when one came with it. */
class HostError extends Error {
  constructor(readonly host: HostText | undefined, fallback: string) {
    super(fallback)
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string, host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/**
 * The two provider ids the host can report, as dictionary keys. An unknown id
 * falls through to the id itself — an unnamed provider is still worth showing.
 */
const PROVIDER_KEYS: Readonly<Record<string, WebSearchKey>> = {
  'dsh-app': 'ws.provider.brand',
  'deepseek-official': 'ws.provider.official',
}

function providerLabel(id: string, t: TranslateNS<typeof NS>): string {
  const key = PROVIDER_KEYS[id]
  return key === undefined ? id : t(key)
}

/**
 * How long a success notice stays on screen.
 *
 * A save confirmation is transient feedback, not state: leaving it up forever
 * (the previous behaviour) made a stale "引擎开关已保存" sit above the form and
 * read as a current condition. Errors deliberately do NOT auto-dismiss — they
 * describe something the user still has to act on.
 */
const NOTICE_TIMEOUT_MS = 3_000

/**
 * Engine hints, keyed per engine id. The host sends the roster (ids, labels,
 * tiers) but no copy: a hint is a sentence about a product decision, and it
 * belongs in the dictionary where a missing key fails this package's build.
 */
const ENGINE_HINT_KEYS: Readonly<Record<string, WebSearchKey>> = {
  bing: 'ws.engine.bing.hint',
  anysearch: 'ws.engine.anysearch.hint',
  searxng: 'ws.engine.searxng.hint',
  parallel: 'ws.engine.parallel.hint',
  exa: 'ws.engine.exa.hint',
}

export type WebSearchSectionProps = PropsLocale<typeof NS>

/**
 * The section component.
 * @param props - the framework-supplied `t` seat of this page's namespace.
 * @returns the rendered settings section.
 */
export function WebSearchSection({ t }: WebSearchSectionProps): ReactNode {
  const [view, setView] = useState<ConfigResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The current success notice as a dictionary KEY, tagged with a sequence
   * number so that saving the SAME message twice still restarts the dismiss
   * timer (a plain string would be a no-op state update and the second save
   * would inherit the first one's remaining time). Holding the key rather than
   * the rendered text lets a language switch re-render a notice on screen.
   */
  const [notice, setNotice] = useState<{ key: WebSearchKey, seq: number } | null>(null)
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
  const showNotice = useCallback((key: WebSearchKey): void => {
    noticeSeq.current += 1
    setNotice({ key, seq: noticeSeq.current })
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
      // A coded failure (a rejected write, a refused route) gets this page's
      // copy; anything else keeps its own diagnosis.
      setError(cause instanceof HostError
        ? routeErrorCopy(t, cause.host, cause.message)
        : cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Persist the current draft (plus the instance textarea) and refresh. */
  const save = useCallback(async (next: WebSearchFile, instances: string, key: WebSearchKey): Promise<void> => {
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
      showNotice(key)
    } catch (cause) {
      // A coded failure (a rejected write, a refused route) gets this page's
      // copy; anything else keeps its own diagnosis.
      setError(cause instanceof HostError
        ? routeErrorCopy(t, cause.host, cause.message)
        : cause instanceof Error ? cause.message : String(cause))
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
    void save(next, instancesText, 'ws.notice.orderSaved')
  }, [draft, instancesText, save])

  /** Flip one engine's enable bit, then persist. */
  const toggleEngine = useCallback((id: string): void => {
    if (draft === null) return
    const next: WebSearchFile = {
      ...draft,
      engines: draft.engines.map(entry => entry.id === id ? { ...entry, enabled: !entry.enabled } : entry),
    }
    setDraft(next)
    void save(next, instancesText, 'ws.notice.toggleSaved')
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
    void save(draft, instancesText, 'ws.notice.keysSaved')
  }, [draft, instancesText, save])

  /** Persist the non-engine settings (mode, budget, cache, cap, instances). */
  const saveSettings = useCallback((patch: Partial<WebSearchFile>): void => {
    if (draft === null) return
    const next: WebSearchFile = { ...draft, ...patch }
    setDraft(next)
    void save(next, instancesText, 'ws.notice.settingsSaved')
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
      // A coded failure (a rejected write, a refused route) gets this page's
      // copy; anything else keeps its own diagnosis.
      setError(cause instanceof HostError
        ? routeErrorCopy(t, cause.host, cause.message)
        : cause instanceof Error ? cause.message : String(cause))
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
      // A coded failure (a rejected write, a refused route) gets this page's
      // copy; anything else keeps its own diagnosis.
      setError(cause instanceof HostError
        ? routeErrorCopy(t, cause.host, cause.message)
        : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSelfTestBusy(false)
    }
  }, [])

  if (view === null || draft === null) {
    return (
      <div className="dshWs-section">
        <h3 className="dshWs-title">{t('ws.nav')}</h3>
        {error === null
          ? <p className="dshWs-hint">{t('ws.loading')}</p>
          : <div className="dshWs-banner">{error}</div>}
      </div>
    )
  }

  const ordered = [...draft.engines].sort((a, b) => a.priority - b.priority)
  const activeLabel = providerLabel(draft.provider, t)

  /** Switching provider is the one action worth confirming: it changes what
   * every future web_search call does, and the other side may be unusable
   * (the upstream provider needs a DeepSeek key and a mounted loader row). */
  const requestSwitch = (provider: string): void => {
    if (provider === draft.provider) return
    setConfirmSwitch(provider)
  }

  /** The target provider's own verdict, used to make the confirm dialog
   * honest about what the user is about to select. */
  const providerReason = (id: string): string | undefined => {
    const reason = view.providers.find(item => item.id === id)?.reason
    return reason === undefined ? undefined : providerReasonCopy(t, reason)
  }

  return (
    <div className="dshWs-section">
      <h3 className="dshWs-title">{t('ws.nav')}</h3>
      <p className="dshWs-hint">
        {t('ws.intro.before')} <code>web_search</code> {t('ws.intro.after')}
      </p>

      {!view.seamAvailable && (
        <div className="dshWs-warning">
          {t('ws.seam.before')} <code>ctx.web</code> {t('ws.seam.after')}
        </div>
      )}
      {error !== null && <div className="dshWs-banner">{error}</div>}
      {notice !== null && <div className="dshWs-noticeOk">{t(notice.key)}</div>}

      <div className="dshWs-card">
        <div className="dshWs-cardHead">
          <h4 className="dshWs-cardTitle">{t('ws.source.title')}</h4>
          <span className="dshWs-badge">{t('ws.source.current', { label: activeLabel })}</span>
        </div>
        <div className="dshWs-providerRow" role="radiogroup" aria-label={t('ws.source.aria')}>
          {view.providers.map((provider) => {
            const label = providerLabel(provider.id, t)
            const dot = provider.state === 'ready'
              ? ' dshWs-providerDotOn'
              : provider.state === 'unavailable' ? ' dshWs-providerDotOff' : ''
            const stateText = provider.state === 'ready'
              ? t('ws.provider.ready')
              : provider.state === 'unavailable' ? t('ws.provider.unavailable') : t('ws.provider.unknown')
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
                  <span className="dshWs-badge">
                    {provider.selected ? t('ws.provider.active') : stateText}
                  </span>
                </span>
                <span className="dshWs-providerMeta">
                  {provider.selected
                    ? (provider.state === 'ready' ? t('ws.provider.effective') : providerReasonCopy(t, provider.reason) || stateText)
                    : providerReasonCopy(t, provider.reason) || (provider.id === 'dsh-app'
                      ? t('ws.provider.brandHint')
                      : t('ws.provider.officialHint'))}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="dshWs-card">
        <div className="dshWs-cardHead">
          <h4 className="dshWs-cardTitle">{t('ws.chain.title')}</h4>
          <span className="dshWs-badge">{t('ws.chain.badge')}</span>
        </div>
        <p className="dshWs-hint">{t('ws.chain.hint')}</p>
        {ordered.map((entry, index) => {
          const meta = view.engines.find(item => item.id === entry.id)
          const label = meta?.label ?? entry.id
          const tier = meta?.tier ?? 'free'
          const hintKey = ENGINE_HINT_KEYS[entry.id]
          const hint = hintKey === undefined ? '' : t(hintKey)
          const status = meta?.status ?? { state: 'unknown' as const }
          const rendered = statusLabel(status, t)
          const probeRow = probe?.results.find(row => row.id === entry.id)
          return (
            <div className="dshWs-engineRow" key={entry.id}>
              <div className="dshWs-order">
                <button
                  type="button"
                  className="dshWs-orderBtn"
                  aria-label={t('ws.chain.moveUp', { label })}
                  disabled={busy || index === 0}
                  onClick={() => { move(entry.id, -1) }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="dshWs-orderBtn"
                  aria-label={t('ws.chain.moveDown', { label })}
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
                    {tier === 'free' ? t('ws.chain.free') : t('ws.chain.needsKey')}
                  </span>
                  <span className={`dshWs-engineStatus${rendered.tone === 'ok' ? ' dshWs-engineStatusOk' : rendered.tone === 'err' ? ' dshWs-engineStatusErr' : ''}`}>
                    {rendered.text}
                  </span>
                </div>
                <div className="dshWs-engineHint">{hint}</div>
                {probeRow !== undefined && (
                  <div className={`dshWs-engineStatus${probeRow.ok ? ' dshWs-engineStatusOk' : ' dshWs-engineStatusErr'}`}>
                    {probeRow.ok
                      ? t('ws.chain.probeOk', {
                          count: probeRow.resultCount ?? 0,
                          latency: probeRow.latencyMs ?? 0,
                        })
                      : t('ws.chain.probeFail', { reason: probeRow.error?.text ?? t('ws.chain.probeReason') })}
                  </div>
                )}
                {tier === 'key' && (
                  <input
                    className="dshWs-input"
                    type="text"
                    placeholder={t('ws.chain.keyPlaceholder')}
                    aria-label={t('ws.chain.keyAria', { label })}
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
                  {t('ws.chain.test')}
                </button>
                <button
                  type="button"
                  className="dshWs-toggle"
                  role="switch"
                  aria-checked={entry.enabled}
                  aria-label={t('ws.chain.toggleAria', { label })}
                  disabled={busy}
                  onClick={() => { toggleEngine(entry.id) }}
                />
              </div>
            </div>
          )
        })}
        <div className="dshWs-row">
          <button type="button" className="dshWs-button" disabled={probeBusy} onClick={() => { void runProbe() }}>
            {probeBusy ? t('ws.chain.testing') : t('ws.chain.testAll')}
          </button>
          <button type="button" className="dshWs-button" disabled={busy} onClick={saveKeys}>
            {t('ws.chain.saveKeys')}
          </button>
        </div>
        <div className="dshWs-row">
          <button type="button" className="dshWs-button dshWs-buttonPrimary" disabled={selfTestBusy} onClick={() => { void runSelfTest() }}>
            {selfTestBusy ? t('ws.chain.selftesting') : t('ws.chain.selftest')}
          </button>
          <span className="dshWs-fieldHint">{t('ws.chain.selftestHint')}</span>
        </div>
        {selfTest !== null && (
          <div className="dshWs-probeList">
            <div className="dshWs-hint">{t('ws.chain.selftestQuery', { query: selfTest.query })}</div>
            {selfTest.error === undefined ? (
              <>
                <div className="dshWs-probeRow">
                  <span className="dshWs-probeName">
                    {selfTest.provider === undefined
                      ? t('ws.chain.unknownProvider')
                      : providerLabel(selfTest.provider, t)}
                  </span>
                  <span className="dshWs-engineStatusOk">
                    {t('ws.chain.summary', {
                      count: selfTest.resultCount ?? 0,
                      latency: selfTest.latencyMs ?? 0,
                    })}
                    {selfTest.engine !== undefined ? t('ws.chain.engine', { engine: selfTest.engine }) : ''}
                    {selfTest.cached === true ? t('ws.chain.cached') : ''}
                  </span>
                </div>
                {selfTest.note !== undefined && (
                  <div className="dshWs-hint">{selfTest.note}</div>
                )}
              </>
            ) : (
              <div className="dshWs-probeRow">
                <span className="dshWs-engineStatusErr">
                  {selfTest.chainExhausted === true ? t('ws.chain.chainExhausted') : t('ws.chain.selftestFailed')}
                  {selfTest.error?.text ?? ''}
                </span>
              </div>
            )}
          </div>
        )}
        {probe !== null && (
          <div className="dshWs-probeList">
            <div className="dshWs-hint">{t('ws.chain.probeQuery', { query: probe.query })}</div>
            {probe.results.map(row => (
              <div className="dshWs-probeRow" key={row.id}>
                <span className="dshWs-probeName">{row.label}</span>
                <span className={row.ok ? 'dshWs-engineStatusOk' : 'dshWs-engineStatusErr'}>
                  {row.ok
                    ? t('ws.chain.summary', { count: row.resultCount ?? 0, latency: row.latencyMs ?? 0 })
                    // Probe failures are diagnostics (an HTTP status, a parse
                    // fault): show the detail, in the page's own frame copy.
                    : t('ws.chain.probeFail', { reason: row.error?.text ?? t('ws.chain.probeReason') })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dshWs-card">
        <h4 className="dshWs-cardTitle">{t('ws.mode.title')}</h4>
        <div className="dshWs-segmented" role="group" aria-label={t('ws.mode.aria')}>
          <button
            type="button"
            className={`dshWs-segBtn${draft.mode === 'fallback' ? ' dshWs-segBtnOn' : ''}`}
            aria-pressed={draft.mode === 'fallback'}
            disabled={busy}
            onClick={() => { saveSettings({ mode: 'fallback' }) }}
          >
            {t('ws.mode.fallback')}
          </button>
          <button
            type="button"
            className={`dshWs-segBtn${draft.mode === 'rotate' ? ' dshWs-segBtnOn' : ''}`}
            aria-pressed={draft.mode === 'rotate'}
            disabled={busy}
            onClick={() => { saveSettings({ mode: 'rotate' }) }}
          >
            {t('ws.mode.rotate')}
          </button>
        </div>
        <p className="dshWs-fieldHint">
          {draft.mode === 'fallback' ? t('ws.mode.fallbackHint') : t('ws.mode.rotateHint')}
        </p>
        <div className="dshWs-grid">
          <label className="dshWs-field dshWs-fieldGrow">
            <span className="dshWs-label">{t('ws.field.timeout')}</span>
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
            <span className="dshWs-label">{t('ws.field.maxResults')}</span>
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
            <span className="dshWs-label">{t('ws.field.cache')}</span>
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
          <span className="dshWs-label">{t('ws.field.instances')}</span>
          <textarea
            className="dshWs-textarea"
            placeholder="https://searx.example.com"
            value={instancesText}
            disabled={busy}
            onChange={(event) => { setInstancesText(event.target.value) }}
          />
        </label>
        <p className="dshWs-fieldHint">
          {t('ws.field.instancesHint.before')} <code>search.formats: [json]</code> {t('ws.field.instancesHint.after')}
        </p>
        <div className="dshWs-row">
          <button type="button" className="dshWs-button" disabled={busy} onClick={() => { saveSettings({}) }}>
            {t('ws.save.settings')}
          </button>
        </div>
      </div>

      <p className="dshWs-path">{t('ws.path', { path: view.filePath })}</p>

      <ConfirmDialog
        open={confirmSwitch !== null}
        title={t('ws.confirm.title')}
        message={confirmSwitch === null ? '' : (() => {
          const target = confirmSwitch
          const label = providerLabel(target, t)
          const reason = providerReason(target)
          const base = target === 'deepseek-official'
            ? t('ws.confirm.toOfficial')
            : t('ws.confirm.toBrand')
          // When the host already knows the target cannot work, saying so in
          // the confirmation is the difference between an informed choice and
          // a silent breakage the user discovers at the next search.
          const warn = reason === undefined ? '' : `\n\n${t('ws.confirm.warn', { label, reason })}`
          return `${base}${warn}\n\n${t('ws.confirm.ask')}`
        })()}
        confirmLabel={t('ws.confirm.switch')}
        cancelLabel={t('ws.cancel')}
        busy={busy}
        onConfirm={() => {
          const provider = confirmSwitch
          setConfirmSwitch(null)
          if (provider !== null && draft !== null) {
            void save({ ...draft, provider }, instancesText, 'ws.notice.providerSwitched')
          }
        }}
        onClose={() => { setConfirmSwitch(null) }}
      />
    </div>
  )
}
