/**
 * Model discovery through dsh's provider adapter.
 *
 * This is intentionally separate from the models.dev importer: the built-in
 * API knows the exact provider route and can return the endpoint's live model
 * list without making the UI maintain a second provider directory.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { formatCapacity } from './fields.ts'
import type { ModelDraft } from './fields.ts'
import type { AdvancedModelsRemote } from './store.ts'
import { message, messageText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'

/** Draft target used by the built-in dsh discovery endpoint. */
export interface ProviderDiscoveryTarget {
  settingsNs: string
  provider?: string
  baseURL?: string
  api?: string
}

/** Props for {@link ProviderModelDiscoveryDialog}. */
export interface ProviderModelDiscoveryDialogProps {
  open: boolean
  onClose: () => void
  onAdopt: (rows: ModelDraft[]) => void
  existingIds: ReadonlySet<string>
  api: Pick<AdvancedModelsRemote, 'llm'>
  target: ProviderDiscoveryTarget | undefined
  /** The page's namespace-bound translate seat. */
  t: Translate
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classify the adapter's own diagnostic into a sentence of this page's
 * dictionary: the adapter words its refusal in English and names the class of
 * failure, not what the user should check.
 * @param diagnostic - the adapter's diagnostic.
 * @returns the message the dialog renders.
 */
function discoveryFailure(diagnostic: string): PageMessage {
  const normalized = diagnostic.toLowerCase()
  if (normalized.includes('baseurl') || normalized.includes('endpoint')) {
    return message('adv.discovery.failure.baseUrl')
  }
  if (normalized.includes('credential') || normalized.includes('api key') || normalized.includes('unauthorized')) {
    return message('adv.discovery.failure.credentials')
  }
  if (normalized.includes('timeout') || normalized.includes('network') || normalized.includes('fetch')) {
    return message('adv.discovery.failure.network')
  }
  return message('adv.discovery.failure.default')
}

function requestOf(target: ProviderDiscoveryTarget, apiKey: string): LlmModelDiscoveryRequest {
  return {
    ...(target.provider === undefined ? {} : { provider: target.provider }),
    ...(target.baseURL?.trim() === '' || target.baseURL === undefined ? {} : { baseURL: target.baseURL.trim() }),
    ...(target.api?.trim() === '' || target.api === undefined ? {} : { api: target.api.trim() }),
    ...(apiKey.trim() === '' ? {} : { apiKey }),
  }
}

function draftOf(model: LlmDiscoveredModel): ModelDraft {
  const draft: ModelDraft = { id: model.id }
  if (model.name !== undefined && model.name !== model.id) draft.name = model.name
  if (model.contextWindow !== undefined) draft.contextWindow = model.contextWindow
  if (model.maxTokens !== undefined) draft.maxTokens = model.maxTokens
  return draft
}

function targetKey(target: ProviderDiscoveryTarget | undefined): string {
  if (target === undefined) return ''
  return [target.settingsNs, target.provider ?? '', target.baseURL ?? '', target.api ?? ''].join('\u0000')
}

/** Discover and adopt models reported by the selected dsh provider. */
export function ProviderModelDiscoveryDialog(props: ProviderModelDiscoveryDialogProps): ReactNode {
  const { open, onClose, onAdopt, existingIds, api, target, t } = props
  const [models, setModels] = useState<readonly LlmDiscoveredModel[] | undefined>(undefined)
  const [failure, setFailure] = useState<PageMessage | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const requestGeneration = useRef(0)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const key = targetKey(target)
  const isDraftRoute = target?.provider === undefined
  const canDiscover = target !== undefined && (
    target.provider !== undefined
    || (target.baseURL?.trim() !== '' && target.api?.trim() !== '')
  )

  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized === '') return models ?? []
    return (models ?? []).filter(model => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(normalized))
  }, [models, query])

  const discover = async (secret: string): Promise<void> => {
    if (target === undefined || !canDiscover) return
    const generation = ++requestGeneration.current
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await api.llm.discoverModels(target.settingsNs, requestOf(target, secret), abort.signal)
      if (generation !== requestGeneration.current) return
      if (!response.ok) throw new Error(response.error.message)
      setModels(response.value)
      setPicked(new Set(response.value
        .filter((model: LlmDiscoveredModel) => !existingIds.has(model.id))
        .map((model: LlmDiscoveredModel) => model.id)))
    } catch (error) {
      if (generation !== requestGeneration.current || abort.signal.aborted) return
      setFailure(discoveryFailure(messageOf(error)))
      setModels(undefined)
      setPicked(new Set())
    } finally {
      if (generation === requestGeneration.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      setApiKey('')
      return
    }
    setModels(undefined)
    setFailure(undefined)
    setQuery('')
    setPicked(new Set())
    if (canDiscover) void discover('')
    return () => { abortRef.current?.abort() }
    // `key` captures the complete draft target without re-running on parent
    // object identity changes while the user is typing elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, api])

  if (!open || target === undefined) return null
  const label = target.provider ?? t('adv.discovery.draftRoute')
  return (
    <div className="dshAma-modalMask" role="presentation" onClick={onClose}>
      <div
        className="dshAma-modal dshAma-discoveryModal"
        role="dialog"
        aria-modal="true"
        aria-label={t('adv.discovery.title')}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshAma-modalHead">
          <span className="dshAma-modalTitle">{t('adv.discovery.title')}</span>
          <button type="button" className="dshAma-iconButton" aria-label={t('adv.common.close')} onClick={onClose}>✕</button>
        </div>
        <div className="dshAma-modalBody">
          <div className="dshAma-discoverySource">
            <span className="dshAma-discoverySourceLabel">{t('adv.discovery.source')}</span>
            <code>{label}</code>
          </div>
          <p className="dshAma-hint">
            {t('adv.discovery.hint')}
          </p>
          {isDraftRoute
            ? (
              <label className="dshAma-field">
                <span className="dshAma-fieldLabel">{t('adv.discovery.apiKeyLabel')}</span>
                <input
                  className="dshAma-input"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  aria-label={t('adv.discovery.apiKeyAria')}
                  placeholder={t('adv.discovery.apiKeyPlaceholder')}
                  onChange={(event) => { setApiKey(event.target.value) }}
                />
              </label>
            )
            : null}
          {!canDiscover
            ? <p className="dshAma-error">{t('adv.discovery.needTarget')}</p>
            : failure !== undefined
              ? (
                <div className="dshAma-error">
                  <p>{t('adv.discovery.failed', { message: messageText(failure, t) })}</p>
                  <button
                    type="button" className="dshAma-button"
                    onClick={() => { void discover(apiKey) }}
                  >{t('adv.common.retry')}</button>
                </div>
              )
              : busy
                ? <p className="dshAma-hint">{t('adv.discovery.loading')}</p>
                : (
                  <>
                    <div className="dshAma-discoveryToolbar">
                      <input
                        className="dshAma-input"
                        type="search"
                        value={query}
                        placeholder={t('adv.discovery.filterPlaceholder')}
                        aria-label={t('adv.discovery.filterAria')}
                        onChange={(event) => { setQuery(event.target.value) }}
                      />
                      <button
                        type="button" className="dshAma-button"
                        onClick={() => { void discover(apiKey) }}
                      >{t('adv.discovery.refresh')}</button>
                    </div>
                    <div className="dshAma-discoveryList">
                      {visibleModels.map(model => {
                        const meta = [
                          model.name !== undefined && model.name !== model.id ? model.name : '',
                          model.contextWindow === undefined
                            ? ''
                            : t('adv.discovery.metaContext', { value: formatCapacity(model.contextWindow) }),
                          model.maxTokens === undefined
                            ? ''
                            : t('adv.discovery.metaOutput', { value: formatCapacity(model.maxTokens) }),
                        ].filter(Boolean).join(' · ')
                        return (
                          <label key={model.id} className="dshAma-discoveryRow">
                            <input
                              type="checkbox"
                              checked={picked.has(model.id)}
                              onChange={() => {
                                setPicked(current => {
                                  const next = new Set(current)
                                  if (!next.delete(model.id)) next.add(model.id)
                                  return next
                                })
                              }}
                            />
                            <span className="dshAma-discoveryModel">
                              <strong>{model.id}</strong>
                              <small>{meta === '' ? t('adv.discovery.noMeta') : meta}</small>
                            </span>
                            {existingIds.has(model.id)
                              ? <span className="dshAma-muted">{t('adv.discovery.configured')}</span>
                              : null}
                          </label>
                        )
                      })}
                      {visibleModels.length === 0
                        ? <p className="dshAma-hint">{t('adv.discovery.empty')}</p>
                        : null}
                    </div>
                  </>
                )}
        </div>
        <div className="dshAma-modalFoot">
          <button type="button" className="dshAma-button" onClick={onClose}>{t('adv.common.cancel')}</button>
          <button
            type="button"
            className="dshAma-button dshAma-buttonPrimary"
            disabled={busy || picked.size === 0}
            onClick={() => {
              const adopted = (models ?? []).filter(model => picked.has(model.id)).map(draftOf)
              if (adopted.length === 0) return
              onAdopt(adopted)
              onClose()
            }}
          >{t('adv.import.adopt', { count: picked.size })}</button>
        </div>
      </div>
    </div>
  )
}
