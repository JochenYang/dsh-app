/**
 * The swarm settings section: enable toggle (restart-applied), adaptive
 * toggle, and the numeric scheduling knobs. Reads and writes the user config
 * file through the host half's routes; scheduling edits apply to the next
 * swarm call without a restart.
 *
 * Every string comes from the `dsh-app.swarm` namespace through the `t`
 * standard seat: the section registers with `locale: NS`, so the renderer
 * hands the component a namespace-bound translate that reads the active UI
 * locale at call time and re-renders on a language switch. State carries
 * dictionary keys — and coded host messages, never rendered sentences — so
 * banners and notices follow the language too.
 *
 * @module @dsh-app/plugin-swarm/client/swarm-section
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText } from '../wire.ts'
import { NS } from './locales.ts'
import type { SwarmKey } from './locales.ts'

const ROUTE = '/plugins/@dsh-app/plugin-swarm/api'

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type SwarmSectionProps = PropsLocale<typeof NS>

/**
 * One message the page shows: a dictionary key rendered with plain params, a
 * render callback for the messages whose params are themselves translated
 * (the field label in `swarm.error.notNumber`), a coded message the host sent
 * (rendered through {@link hostMessage}), or text the wire already wrote (a
 * bare `HTTP 500`). A sentence never enters state, so a language switch
 * re-renders every message in the active locale.
 */
type Notice =
  | { readonly source: 'key'; readonly key: SwarmKey; readonly params?: Record<string, unknown> }
  | { readonly source: 'render'; readonly render: (t: TranslateNS<typeof NS>) => string }
  | { readonly source: 'host'; readonly host: HostText }
  | { readonly source: 'text'; readonly text: string }

/**
 * Codes this build renders, mapped to their dictionary keys.
 *
 * The host never sends prose for anything the user reads (see `HostText` in
 * wire.ts): it sends a code plus the values the sentence interpolates, and the
 * copy lives here. `route.crossOrigin` and `route.methodOnly` are deliberately
 * absent — only a page that is not this one can trigger them, so they fall
 * through to the host's English diagnostic rather than shipping a sentence for
 * a state no user reaches (plugin-websearch made the same call).
 */
const HOST_KEYS: Readonly<Record<string, SwarmKey>> = {
  'config.unknownField': 'swarm.host.unknownField',
  'config.notBoolean': 'swarm.host.notBoolean',
  'config.belowMinimum': 'swarm.host.belowMinimum',
  'route.writeFailed': 'swarm.host.writeFailed',
  'route.bodyTooLarge': 'swarm.host.bodyTooLarge',
  'route.invalidBody': 'swarm.host.invalidBody',
}

/**
 * Render a coded host message.
 *
 * A code this build knows gets the page's own copy with the host's values
 * interpolated; a code it does not (a newer kernel beside an older UI) keeps
 * the host's English diagnostic; a host that sent neither degrades to the
 * page's generic line — never to a blank banner.
 *
 * @param host - the host's coded message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text of the active locale.
 */
function hostMessage(host: HostText, t: TranslateNS<typeof NS>): string {
  const key = HOST_KEYS[host.code]
  if (key === undefined) return host.text ?? t('swarm.error.generic')
  return t(key, host.params === undefined ? undefined : { ...host.params })
}

/**
 * Classify a failure: the host's coded message when one came with it, the
 * wire's own text otherwise, and the page's generic line when there is none.
 */
function wireNotice(failure: unknown): Notice {
  if (failure instanceof HostError && failure.host !== undefined) {
    return { source: 'host', host: failure.host }
  }
  const text = failure instanceof Error ? failure.message : String(failure)
  return text === '' ? { source: 'key', key: 'swarm.error.generic' } : { source: 'text', text }
}

/**
 * Render a notice in the active locale.
 * @param notice - the classified message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
function noticeText(notice: Notice, t: TranslateNS<typeof NS>): string {
  if (notice.source === 'host') return hostMessage(notice.host, t)
  if (notice.source === 'text') return notice.text
  if (notice.source === 'render') return notice.render(t)
  return t(notice.key, notice.params)
}

/** One numeric field's presentation metadata. */
interface FieldSpec {
  readonly key: string
  readonly labelKey: SwarmKey
  readonly hintKey: SwarmKey
}

const NUMERIC_FIELDS: readonly FieldSpec[] = [
  { key: 'defaultConcurrency', labelKey: 'swarm.field.defaultConcurrency', hintKey: 'swarm.field.defaultConcurrency.hint' },
  { key: 'maxConcurrency', labelKey: 'swarm.field.maxConcurrency', hintKey: 'swarm.field.maxConcurrency.hint' },
  { key: 'maxItems', labelKey: 'swarm.field.maxItems', hintKey: 'swarm.field.maxItems.hint' },
  { key: 'startStaggerMs', labelKey: 'swarm.field.startStaggerMs', hintKey: 'swarm.field.startStaggerMs.hint' },
  { key: 'itemMaxRetries', labelKey: 'swarm.field.itemMaxRetries', hintKey: 'swarm.field.itemMaxRetries.hint' },
  { key: 'itemRetryDelayMs', labelKey: 'swarm.field.itemRetryDelayMs', hintKey: 'swarm.field.itemRetryDelayMs.hint' },
  { key: 'perItemOutputLimit', labelKey: 'swarm.field.perItemOutputLimit', hintKey: 'swarm.field.perItemOutputLimit.hint' },
  { key: 'tokenBudget', labelKey: 'swarm.field.tokenBudget', hintKey: 'swarm.field.tokenBudget.hint' },
]

/** The host route's config payload (mirror of SwarmConfigResponse). */
interface ConfigResponse {
  readonly defaults: Record<string, number | boolean>
  readonly overrides: Record<string, number | boolean>
  readonly effective: Record<string, number | boolean>
  readonly filePath: string
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

export function SwarmSection({ t }: SwarmSectionProps): ReactNode {
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<Notice | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<ConfigResponse>(`${ROUTE}/config`)
      setConfig(data)
      const nextDraft: Record<string, string> = {}
      for (const field of NUMERIC_FIELDS) {
        nextDraft[field.key] = String(data.effective[field.key] ?? '')
      }
      setDraft(nextDraft)
      setError(undefined)
    } catch (failure) {
      setError(wireNotice(failure))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Fields whose draft differs from the current effective value. */
  const dirtyFields = useMemo(() => {
    if (config === null) return []
    return NUMERIC_FIELDS.filter(field => {
      const value = draft[field.key]
      return value !== undefined && value !== String(config.effective[field.key] ?? '')
    })
  }, [config, draft])

  const post = useCallback(async (patch: Record<string, number | boolean | null>) => {
    setBusy(true)
    setNotice(undefined)
    try {
      await fetchJson<ConfigResponse>(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await load()
    } catch (failure) {
      setError(wireNotice(failure))
      throw failure
    } finally {
      setBusy(false)
    }
  }, [load])

  const onSave = useCallback(async () => {
    if (config === null || dirtyFields.length === 0) return
    const patch: Record<string, number | null> = {}
    for (const field of dirtyFields) {
      const raw = draft[field.key] ?? ''
      if (raw.trim() === '') {
        // Cleared input = clear the override (fall back to the overlay value).
        patch[field.key] = null
        continue
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        setError({
          source: 'render',
          render: (translate) => translate('swarm.error.notNumber', { label: translate(field.labelKey) }),
        })
        return
      }
      patch[field.key] = value
    }
    try {
      await post(patch)
      setNotice({ source: 'key', key: 'swarm.notice.saved' })
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, dirtyFields, draft, post])

  const onResetAll = useCallback(async () => {
    if (config === null) return
    const patch: Record<string, null> = {}
    for (const key of Object.keys(config.overrides)) patch[key] = null
    if (Object.keys(patch).length === 0) {
      setNotice({ source: 'key', key: 'swarm.notice.noOverrides' })
      return
    }
    try {
      await post(patch)
      setNotice({ source: 'key', key: 'swarm.notice.resetAll' })
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, post])

  const onToggleEnabled = useCallback(async () => {
    if (config === null) return
    const next = !(config.effective.enabled !== false)
    try {
      await post({ enabled: next })
      setNotice({ source: 'key', key: next ? 'swarm.notice.enabled' : 'swarm.notice.disabled' })
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, post])

  const onToggleAdaptive = useCallback(async () => {
    if (config === null) return
    const next = !(config.effective.adaptive !== false)
    try {
      await post({ adaptive: next })
      setNotice({ source: 'key', key: next ? 'swarm.notice.adaptiveOn' : 'swarm.notice.adaptiveOff' })
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, post])

  const enabled = config !== null && config.effective.enabled !== false
  const adaptive = config !== null && config.effective.adaptive !== false
  /** `{state}` for the toggle labels; the unknown state reads as pending. */
  const pending = t('swarm.state.pending')

  return (
    <div className="dshs_section">
      <p className="dshs_title">{t('swarm.title')}</p>
      <p className="dshs_hint">
        {t('swarm.intro')}
      </p>

      {error !== undefined ? <div className="dshs_banner" role="alert">{noticeText(error, t)}</div> : null}
      {notice !== undefined ? <div className="dshs_noticeOk">{noticeText(notice, t)}</div> : null}

      <div className="dshs_toggleRow">
        <span className="dshs_toggleLabel">
          {t('swarm.toggle.enabled', { state: config === null ? pending : enabled ? t('swarm.state.enabled') : t('swarm.state.disabled') })}
          <span className="dshs_toggleHint">{t('swarm.toggle.enabled.hint')}</span>
        </span>
        <button
          type="button"
          className="dshs_toggle"
          role="switch"
          aria-checked={enabled}
          aria-label={t('swarm.toggle.enabled.aria')}
          disabled={busy || config === null}
          onClick={() => { void onToggleEnabled() }}
        />
      </div>

      <div className="dshs_toggleRow">
        <span className="dshs_toggleLabel">
          {t('swarm.toggle.adaptive', { state: config === null ? pending : adaptive ? t('swarm.state.on') : t('swarm.state.off') })}
          <span className="dshs_toggleHint">{t('swarm.toggle.adaptive.hint')}</span>
        </span>
        <button
          type="button"
          className="dshs_toggle"
          role="switch"
          aria-checked={adaptive}
          aria-label={t('swarm.toggle.adaptive.aria')}
          disabled={busy || config === null}
          onClick={() => { void onToggleAdaptive() }}
        />
      </div>

      <div className="dshs_grid">
        {NUMERIC_FIELDS.map((field) => {
          const overridden = config !== null && config.overrides[field.key] !== undefined
          const dirty = dirtyFields.some(dirtyField => dirtyField.key === field.key)
          return (
            <div key={field.key} className="dshs_field">
              <span className="dshs_fieldLabel">
                {t(field.labelKey)}
                <span className={overridden ? 'dshs_fieldBadge dshs_fieldBadgeCustom' : 'dshs_fieldBadge'}>
                  {overridden ? t('swarm.field.custom') : t('swarm.field.default', { value: config?.defaults[field.key] ?? pending })}
                </span>
              </span>
              <input
                className="dshs_fieldInput"
                type="number"
                min={0}
                value={draft[field.key] ?? ''}
                disabled={busy || config === null}
                aria-label={t(field.labelKey)}
                onChange={(event) => {
                  const { value } = event.target
                  setDraft(previous => ({ ...previous, [field.key]: value }))
                }}
              />
              <span className="dshs_fieldHint">{t(field.hintKey)}{dirty ? t('swarm.field.unsaved') : ''}</span>
            </div>
          )
        })}
      </div>

      <div className="dshs_actions">
        <button
          type="button"
          className="dshs_button dshs_buttonPrimary"
          disabled={busy || config === null || dirtyFields.length === 0}
          onClick={() => { void onSave() }}
        >{dirtyFields.length > 0 ? t('swarm.action.saveCount', { count: dirtyFields.length }) : t('swarm.action.save')}</button>
        <button
          type="button"
          className="dshs_button"
          disabled={busy || config === null || Object.keys(config.overrides).length === 0}
          onClick={() => { void onResetAll() }}
        >{t('swarm.action.resetAll')}</button>
      </div>

      {config !== null
        ? <p className="dshs_path" title={config.filePath}>{t('swarm.path', { path: config.filePath })}</p>
        : null}
    </div>
  )
}
