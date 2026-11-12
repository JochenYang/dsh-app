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
import type { EngineEntry, EngineStatus, HostText, KeySupport, WebSearchFile } from '../wire.ts'
import { isStoredKeyToken, MAX_KEYS_PER_ENGINE } from '../wire.ts'
// Coded host messages: the code → copy tables live in a React-free module so
// the suite can test them (a .tsx cannot be bundled by the test harness).
import { hostMessage, providerReasonCopy, routeErrorCopy, statusLabel } from './host-message.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { NS, type WebSearchKey } from './locales.ts'
import { PROVIDER_HINT_KEYS, PROVIDER_PRICE_KEYS, providerLabel } from './providers.ts'

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
  readonly keySupport: KeySupport
  /** Where the user creates a key; absent for `none` engines. */
  readonly keyConsole?: string
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
  /** Which configured key answered; absent when the anonymous call did. */
  readonly keyIndex?: number
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
  /**
   * The fetch transport's verdict, reported by the host's fetch provider.
   * Carries no user URLs: the canary only ever probes a neutral host.
   */
  readonly network?: {
    readonly route: 'proxy' | 'direct'
    readonly resolver: 'system' | 'doh' | 'unknown'
    readonly verdict: 'poisoned' | 'clean' | 'inconclusive' | 'unknown'
    readonly checkedAt: number | null
  }
  /**
   * One real fetch through the seam, run by the same self-check: proof that
   * the path the verdict line names actually works right now.
   */
  readonly fetch?: {
    readonly ok: boolean
    readonly statusCode?: number
    readonly bytes?: number
    readonly latencyMs?: number
    readonly error?: HostText
  }
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
 * The fetch-network line of the self-check: which transport the next
 * `web_fetch` uses. The three states are the whole story a user needs — a
 * proxied egress, a clean system resolver, or DoH after a poisoning
 * verdict — and "unknown" before the first fetch says so instead of
 * guessing.
 */
function networkLine(
  network: SelfTestResponse['network'],
  t: TranslateNS<typeof NS>,
): string {
  if (network === undefined) return ''
  if (network.route === 'proxy') return t('ws.net.proxy')
  if (network.resolver === 'doh') {
    return network.verdict === 'inconclusive'
      ? t('ws.net.doh.inconclusive')
      : t('ws.net.doh.poisoned')
  }
  if (network.resolver === 'system') return t('ws.net.system')
  return t('ws.net.unknown')
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

/**
 * What the engine's own free tier gives before a key matters.
 *
 * A fact the user cannot see from inside the app and would otherwise have to
 * leave the page to learn, stated once per engine in the dictionary — a quota
 * that changes is one line of copy, not a code path.
 */
const ENGINE_QUOTA_KEYS: Readonly<Record<string, WebSearchKey>> = {
  anysearch: 'ws.engine.anysearch.keyQuota',
  parallel: 'ws.engine.parallel.keyQuota',
  exa: 'ws.engine.exa.keyQuota',
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
  /** The engine whose key panel is expanded, if any. */
  const [openKey, setOpenKey] = useState<string | null>(null)
  /**
   * Per-engine panel state: the chips (exactly the engine's wire entries — one
   * placeholder per stored literal key, any `$ENV:NAME` verbatim) plus the add
   * field's pending text.
   *
   * Keyed by engine id rather than one shared slot, because switching to another
   * engine and back must not silently discard a list the user was half way
   * through building.
   */
  const [panelDrafts, setPanelDrafts] = useState<Record<string, { chips: string[], input: string }>>({})
  /**
   * The one key input on screen, focused when a panel opens.
   *
   * The panel sits BEFORE its toggle in the DOM (inside the row's main column),
   * so without this a keyboard user who activates 配置密钥 is left with focus
   * past the field and has to shift-tab back to reach it.
   */
  const keyInputRef = useRef<HTMLInputElement | null>(null)
  /**
   * The 配置密钥 button of the expanded row, so closing the panel puts focus
   * back where the user opened it instead of dropping it onto `<body>` (which
   * is where Enter-to-save would otherwise leave a keyboard user).
   */
  const keyToggleRef = useRef<HTMLButtonElement | null>(null)

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

  /**
   * Re-read the stored config.
   *
   * `clearError` is FALSE on the recovery path after a refused save: the
   * refusal is the message the user has to read, and a successful GET a moment
   * later must not paint it away. A reload that clears an error it did not
   * raise is how a rejected write ends up looking like a silent no-op.
   */
  const load = useCallback(async (clearError: boolean): Promise<WebSearchFile | null> => {
    try {
      const next = await fetchJson<ConfigResponse>(`${ROUTE}/config`)
      setView(next)
      setDraft(next.file)
      setInstancesText(next.file.searxngInstances.join('\n'))
      if (clearError) setError(null)
      return next.file
    } catch (cause) {
      // A coded failure (a rejected write, a refused route) gets this page's
      // copy; anything else keeps its own diagnosis.
      setError(cause instanceof HostError
        ? routeErrorCopy(t, cause.host, cause.message)
        : cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [])

  useEffect(() => { void load(true) }, [load])

  /**
   * Persist the current draft (plus the instance textarea) and refresh.
   *
   * Returns whether the write landed. The caller needs that answer: a failed
   * save leaves the draft holding the values the host just REFUSED, so any
   * later action that persists the draft (reorder, toggle, save settings) would
   * re-send them and report their rejection against an unrelated button.
   * `load()` on failure discards the poisoned draft and re-renders from the
   * store, which is the only state the page can be honest about.
   */
  const save = useCallback(async (next: WebSearchFile, instances: string, key: WebSearchKey): Promise<boolean> => {
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
      return true
    } catch (cause) {
      // A coded failure (a rejected write, a refused route) gets this page's
      // copy; anything else keeps its own diagnosis.
      setError(cause instanceof HostError
        ? routeErrorCopy(t, cause.host, cause.message)
        : cause instanceof Error ? cause.message : String(cause))
      // Discard the refused draft so the next reorder/toggle cannot re-send it,
      // but keep the error: this reload is not the message being superseded.
      // The panels are re-derived from what actually got stored, so a stale
      // placeholder cannot wedge them into repeating the same refusal.
      void load(false).then((file) => { if (file !== null) reseedDrafts(file) })
      return false
    } finally {
      setBusy(false)
    }
  }, [showNotice, load])

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

  /**
   * Expand or collapse one engine's key panel.
   *
   * The chips are seeded from the saved list the FIRST time a panel opens — one
   * placeholder per stored literal key (the host never sends the literals) and
   * `$ENV:NAME` references verbatim — and then kept per engine until it is
   * saved or the page reloads.
   */
  const toggleKeyPanel = (id: string, keys: readonly string[] | undefined): void => {
    if (openKey === id) {
      setOpenKey(null)
      return
    }
    setPanelDrafts((current) => current[id] === undefined
      ? { ...current, [id]: { chips: [...keys ?? []], input: '' } }
      : current)
    setOpenKey(id)
  }

  // Move focus into the panel that just opened (see keyInputRef).
  useEffect(() => {
    if (openKey !== null) keyInputRef.current?.focus()
  }, [openKey])

  /** Update one engine's panel draft. */
  const patchPanelDraft = (id: string, patch: Partial<{ chips: string[], input: string }>): void => {
    setPanelDrafts((current) => {
      const base = current[id] ?? { chips: [], input: '' }
      return {
        ...current,
        [id]: { chips: patch.chips ?? base.chips, input: patch.input ?? base.input },
      }
    })
  }

  /** Keys typed into the add field but not yet committed to a chip. */
  const pendingKeys = (text: string): string[] => text
    .split(/[,\n]+/)
    .map(part => part.trim())
    .filter(part => part !== '')

  /**
   * Re-derive every open panel's stored chips from the host's truth.
   *
   * Runs after a REFUSED save. Without it a panel seeded from an older store
   * keeps sending placeholders the host no longer recognises, so every retry
   * fails the same way and the panel has no in-page way back. Keys typed in
   * this session are kept — they are the user's work, not the host's state.
   */
  const reseedDrafts = (file: WebSearchFile): void => {
    setPanelDrafts((current) => {
      const next: Record<string, { chips: string[], input: string }> = {}
      for (const [id, draft] of Object.entries(current)) {
        const stored = file.engines.find(entry => entry.id === id)?.apiKeys ?? []
        next[id] = {
          chips: [...stored, ...draft.chips.filter(chip => !isStoredKeyToken(chip))],
          input: draft.input,
        }
      }
      return next
    })
  }

  /**
   * Commit the add field to chips (Enter, or the 添加 button).
   *
   * The cap is applied HERE, not only at save time: a paste that would overflow
   * otherwise builds a list the host must refuse, with the screen showing a
   * count the error message explains and no obvious way to trim it.
   */
  const addKeyChips = (id: string, chips: readonly string[], input: string): void => {
    const parsed = pendingKeys(input)
    if (parsed.length === 0) return
    const room = Math.max(0, MAX_KEYS_PER_ENGINE - chips.length)
    if (room === 0) {
      setError(t('ws.key.tooManyNotice', { max: MAX_KEYS_PER_ENGINE }))
      return
    }
    const accepted = parsed.slice(0, room)
    if (accepted.length < parsed.length) setError(t('ws.key.tooManyNotice', { max: MAX_KEYS_PER_ENGINE }))
    patchPanelDraft(id, { chips: [...chips, ...accepted], input: '' })
  }

  /** Drop one chip — the only way a stored key is removed. */
  const removeKeyChip = (id: string, chips: readonly string[], index: number): void => {
    patchPanelDraft(id, { chips: chips.filter((_, position) => position !== index) })
    // The × unmounts itself; without this the keyboard user lands on <body> and
    // has to tab back from the top of the page for every deletion.
    keyInputRef.current?.focus()
  }

  /**
   * Persist one engine's key list, then probe that engine.
   *
   * The probe runs AFTER the save because it reads the store: testing first
   * would report the previous keys as though they were the new ones.
   */
  const saveKeysFor = (id: string, chips: readonly string[], input: string): void => {
    if (draft === null) return
    // Whatever is still sitting in the add field is included: a user who pasted
    // a key and pressed 保存 must not silently lose it to a forgotten 添加.
    const apiKeys = [...chips, ...pendingKeys(input)]
    const next: WebSearchFile = {
      ...draft,
      engines: draft.engines.map(entry => entry.id === id ? { ...entry, apiKeys } : entry),
    }
    setDraft(next)
    // Close the panel only once the write landed: the chips keep what the user
    // built while the request is in flight, and the reopened panel is seeded
    // from the host's masked answer rather than from a literal key that the
    // store no longer has in that form.
    void save(next, instancesText, 'ws.notice.keysSaved').then((saved) => {
      if (!saved) return
      setPanelDrafts((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setOpenKey(null)
      // Focus the toggle BEFORE the panel unmounts, or the row loses the
      // keyboard's place entirely.
      keyToggleRef.current?.focus()
      void runProbe(id)
    })
  }
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

  /** Switching the source changes what every future web_search call does, so it
   * is the one action that asks first — and the target's own verdict rides
   * along, so a source the host already knows is unusable says so before the
   * user picks it. */
  const requestSwitch = (provider: string): void => {
    if (provider === draft.provider) return
    setConfirmSwitch(provider)
  }

  /** The target's own verdict, in the dialog's words. */
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
                    : providerReasonCopy(t, provider.reason) || (PROVIDER_HINT_KEYS[provider.id] === undefined
                      // A provider this build has no name for gets the status
                      // word alone rather than a borrowed claim about it.
                      ? stateText
                      : t(PROVIDER_HINT_KEYS[provider.id]))}
                </span>
                {/* Price is a fact about the route, not a state: it belongs on
                    the card whichever one answers. Each payable route carries
                    its OWN sentence — they are not charged the same way, and
                    one shared line said the model route was free until
                    November. */}
                {PROVIDER_PRICE_KEYS[provider.id] === undefined
                  ? null
                  : <span className="dshWs-providerMeta">{t(PROVIDER_PRICE_KEYS[provider.id])}</span>}
              </button>
            )
          })}
        </div>
        <p className="dshWs-hint">{t('ws.provider.ownedHere')}</p>
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
          const keySupport = meta?.keySupport ?? 'none'
          const hintKey = ENGINE_HINT_KEYS[entry.id]
          const hint = hintKey === undefined ? '' : t(hintKey)
          const quotaKey = ENGINE_QUOTA_KEYS[entry.id]
          const status = meta?.status ?? { state: 'unknown' as const }
          const keyCount = status.keyCount ?? 0
          const rendered = statusLabel(status, t)
          const probeRow = probe?.results.find(row => row.id === entry.id)
          // This row's panel draft (empty until the panel is opened).
          const chips = panelDrafts[entry.id]?.chips ?? []
          const chipInput = panelDrafts[entry.id]?.input ?? ''
          // The badge states which of the two quota regimes the engine is in:
          // a keyless engine is simply free, and an engine that can take a key
          // shows how many are configured.
          const badge = keyCount > 0
            ? { text: t('ws.chain.keyed', { count: keyCount }), className: 'dshWs-badgeKey' }
            : { text: t('ws.chain.free'), className: 'dshWs-badgeFree' }
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
                  <span className={`dshWs-badge ${badge.className}`}>
                    {badge.text}
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
                        }) + (probeRow.keyIndex === undefined
                          ? ''
                          : t('ws.chain.probeKey', { index: probeRow.keyIndex + 1 }))
                      : t('ws.chain.probeFail', { reason: probeRow.error?.text ?? t('ws.chain.probeReason') })}
                  </div>
                )}
                {keySupport !== 'none' && openKey === entry.id && (
                  <div className="dshWs-keyPanel" id={`dshWs-key-${entry.id}`}>
                    <div className="dshWs-keyHead">
                      <span className="dshWs-label">{t('ws.key.title')}</span>
                      {chips.length > 0 && (
                        <span className="dshWs-fieldHint">{t('ws.key.chipCount', { count: chips.length })}</span>
                      )}
                      {status.keyState === 'exhausted' && (
                        <span className="dshWs-engineStatusErr">{t('ws.key.exhausted')}</span>
                      )}
                      {(status.keyUnresolved ?? 0) > 0 && (
                        <span className="dshWs-engineStatusErr">
                          {t('ws.key.unresolved', { count: status.keyUnresolved ?? 0 })}
                        </span>
                      )}
                    </div>
                    {quotaKey !== undefined && <p className="dshWs-fieldHint">{t(quotaKey)}</p>}
                    {/*
                      * The chips ARE the configured list, one per key: a stored
                      * literal reads 「已保存 #N」, a key typed in this session
                      * reads 「新密钥 #N」, and an `$ENV:NAME` reference shows
                      * itself (it is not a secret). No chip ever shows a literal
                      * value, stored or not — see the label comment below.
                      */}
                    {chips.length > 0 && (
                      <div className="dshWs-keyChips">
                        {chips.map((chip, position) => {
                          const stored = isStoredKeyToken(chip)
                          const reference = chip.startsWith('$ENV:')
                          // A literal key is NEVER rendered — not the stored ones
                          // and not the one typed a second ago. The chip is a
                          // label, not a value: a value in the DOM is a value in
                          // devtools, in a screenshot, in someone's shoulder
                          // view of the screen. The only place a literal appears
                          // is the input field while it is being typed, and that
                          // field is cleared the moment the key becomes a chip.
                          const kind = stored
                            ? chips.slice(0, position + 1).filter(item => isStoredKeyToken(item)).length
                            : chips.slice(0, position + 1).filter(item => !isStoredKeyToken(item) && !item.startsWith('$ENV:')).length
                          const chipLabel = stored
                            ? t('ws.key.storedChip', { index: kind })
                            : reference
                              ? chip
                              : t('ws.key.newChip', { index: kind })
                          return (
                            <span className="dshWs-chip" key={`${chip}-${String(position)}`}>
                              <span className="dshWs-chipText">{chipLabel}</span>
                              <button
                                type="button"
                                className="dshWs-chipRemove"
                                aria-label={t('ws.key.remove', { label: chipLabel })}
                                disabled={busy}
                                onClick={() => { removeKeyChip(entry.id, chips, position) }}
                              >
                                ×
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    )}
                    <div className="dshWs-row">
                      <input
                        className="dshWs-input dshWs-fieldGrow"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={t('ws.key.label')}
                        placeholder={t('ws.key.placeholder')}
                        value={chipInput}
                        disabled={busy || chips.length >= MAX_KEYS_PER_ENGINE}
                        ref={keyInputRef}
                        onChange={(event) => { patchPanelDraft(entry.id, { input: event.target.value }) }}
                        onKeyDown={(event) => {
                          // Enter commits the field to a chip, so a keyboard user
                          // can build the list without reaching for the button.
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          addKeyChips(entry.id, chips, chipInput)
                        }}
                      />
                      <button
                        type="button"
                        className="dshWs-button"
                        disabled={busy || chipInput.trim() === '' || chips.length >= MAX_KEYS_PER_ENGINE}
                        onClick={() => { addKeyChips(entry.id, chips, chipInput) }}
                      >
                        {t('ws.key.add')}
                      </button>
                    </div>
                    <p className="dshWs-fieldHint">{t('ws.key.chipNote', { max: MAX_KEYS_PER_ENGINE })}</p>
                    <p className="dshWs-fieldHint">{t('ws.key.fallback')}</p>
                    <p className="dshWs-fieldHint">{t('ws.key.sharedAccount')}</p>
                    <div className="dshWs-row">
                      {meta?.keyConsole === undefined ? null : (
                        <a
                          className="dshWs-button"
                          href={meta.keyConsole}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {t('ws.key.get')}
                        </a>
                      )}
                      <button
                        type="button"
                        className="dshWs-button dshWs-buttonPrimary"
                        disabled={busy}
                        onClick={() => { saveKeysFor(entry.id, chips, chipInput) }}
                      >
                        {t('ws.key.save')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="dshWs-engineActions">
                {keySupport === 'none' ? null : (
                  <button
                    type="button"
                    className="dshWs-button"
                    ref={(element) => { if (openKey === entry.id) keyToggleRef.current = element }}
                    aria-expanded={openKey === entry.id}
                    aria-controls={`dshWs-key-${entry.id}`}
                    // Three rows would otherwise share one accessible name;
                    // naming the engine is what tells them apart.
                    aria-label={t('ws.chain.configureAria', { label })}
                    disabled={busy}
                    onClick={() => { toggleKeyPanel(entry.id, meta?.entry.apiKeys) }}
                  >
                    {t('ws.chain.configure')}
                  </button>
                )}
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
            {selfTest.network !== undefined && (
              <div className="dshWs-probeRow">
                <span className="dshWs-probeName">{t('ws.net.title')}</span>
                <span className="dshWs-engineStatusOk">{networkLine(selfTest.network, t)}</span>
              </div>
            )}
            {selfTest.fetch !== undefined && (
              <div className="dshWs-probeRow">
                <span className="dshWs-probeName">{t('ws.fetch.title')}</span>
                {selfTest.fetch.ok === true ? (
                  <span className="dshWs-engineStatusOk">
                    {t('ws.fetch.summary', {
                      status: selfTest.fetch.statusCode ?? 0,
                      bytes: selfTest.fetch.bytes ?? 0,
                      latency: selfTest.fetch.latencyMs ?? 0,
                    })}
                  </span>
                ) : (
                  <span className="dshWs-engineStatusErr">
                    {routeErrorCopy(t, selfTest.fetch.error, t('ws.fetch.failed'))}
                  </span>
                )}
              </div>
            )}
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
          // Named by the target's own label: there are three sources now, and a
          // two-way sentence told everyone switching to the Search API that the
          // BRAND chain would answer.
          const base = t('ws.confirm.toProvider', { label })
          const warn = reason === undefined ? '' : `

${t('ws.confirm.warn', { label, reason })}`
          return `${base}${warn}

${t('ws.confirm.ask')}`
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
