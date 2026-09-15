/**
 * models.dev import dialog: search the feed, pick a provider, check models,
 * adopt them as draft rows. Nothing is written here — adoption only fills
 * the form; the section's save path (validated, conflict-checked
 * `settings.mutate`) decides what actually lands in settings.yaml.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelDraft } from './fields.ts'
import { describeFetchFailure, fetchModelsDev, mapProviderModels, searchModels, searchProviders, ModelsDevFetchError } from './models-dev.ts'
import type { ModelsDevModelHit, ModelsDevProvider } from './models-dev.ts'
import { messageText, wireText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'

/** Props of {@link ModelsDevImportDialog}. */
export interface ModelsDevImportDialogProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Close the dialog. */
  onClose: () => void
  /** Adopt the picked rows into the current edit target. */
  onAdopt: (rows: ModelDraft[]) => void
  /** Ids already configured; those rows start unchecked. */
  existingIds: ReadonlySet<string>
  /** The page's namespace-bound translate seat. */
  t: Translate
}

/** One provider row with its mapped models and pick state. */
interface ProviderDraft {
  provider: ModelsDevProvider
  models: { id: string; draft: ModelDraft }[]
}

/**
 * Classify a failed feed fetch: the feed's own error carries the source and
 * the reason (worded from the dictionary), anything else is a transport
 * message shown verbatim.
 * @param error - whatever the fetch rejected with.
 * @returns the message the dialog renders.
 */
function fetchFailureMessage(error: unknown): PageMessage {
  return error instanceof ModelsDevFetchError
    ? describeFetchFailure(error.failure)
    : wireText(error instanceof Error ? error.message : String(error))
}

/**
 * The import flow. The feed fetch runs once per open; a network/CORS failure
 * is a dead end for the BUTTON, not the page — the manual form stays usable.
 */
export function ModelsDevImportDialog(props: ModelsDevImportDialogProps): ReactNode {
  const { open, onClose, onAdopt, existingIds, t } = props
  const [providers, setProviders] = useState<readonly ModelsDevProvider[] | undefined>(undefined)
  const [failure, setFailure] = useState<PageMessage | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ProviderDraft | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  /** Picks from the model-name search list (keyed providerId + space + modelId). */
  const [pickedModels, setPickedModels] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || providers !== undefined) return
    let stale = false
    setBusy(true)
    setFailure(undefined)
    fetchModelsDev().then(
      (result) => {
        if (!stale) { setProviders(result); setBusy(false) }
      },
      (error: unknown) => {
        if (stale) return
        setBusy(false)
        setFailure(fetchFailureMessage(error))
      },
    )
    return () => { stale = true }
  }, [open, providers])

  const results = useMemo(
    () => providers === undefined ? [] : searchProviders(providers, query).slice(0, 20),
    [providers, query],
  )
  const modelHits = useMemo(
    () => providers === undefined ? [] : searchModels(providers, query, 30),
    [providers, query],
  )
  const hitKey = (hit: ModelsDevModelHit): string => hit.providerId + ' ' + hit.modelId
  const pickedHits = modelHits.filter(hit => pickedModels.has(hitKey(hit)))
  const adoptCount = pickedHits.length > 0
    ? pickedHits.length
    : expanded === undefined ? 0 : picked.size

  const openProvider = (provider: ModelsDevProvider): void => {
    setExpanded({ provider, models: mapProviderModels(provider) })
    setPicked(new Set(
      mapProviderModels(provider)
        .filter(model => !existingIds.has(model.id))
        .map(model => model.id),
    ))
  }

  if (!open) return null
  return (
    <div className="dshAma-modalMask" role="presentation" onClick={onClose}>
      {/* Stop-mask-click container: clicks inside the dialog must not close it. */}
      <div
        className="dshAma-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('adv.import.title')}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshAma-modalHead">
          <span className="dshAma-modalTitle">{t('adv.import.title')}</span>
          <button type="button" className="dshAma-iconButton" aria-label={t('adv.common.close')} onClick={onClose}>✕</button>
        </div>
        <div className="dshAma-modalBody">
          {failure !== undefined
            ? (
              <div className="dshAma-error">
                <p>{t('adv.import.unreachable', { message: messageText(failure, t) })}</p>
                <button
                  type="button" className="dshAma-button"
                  onClick={() => { setProviders(undefined); setFailure(undefined) }}
                >{t('adv.common.retry')}</button>
              </div>
            )
            : busy || providers === undefined
              ? <p className="dshAma-hint">{t('adv.import.loading')}</p>
              : (
                <>
                  <input
                    className="dshAma-input"
                    type="text"
                    value={query}
                    placeholder={t('adv.import.searchPlaceholder')}
                    aria-label={t('adv.import.searchAria')}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setExpanded(undefined)
                      setPickedModels(new Set())
                    }}
                  />
                  {query.trim() === ''
                    ? <p className="dshAma-hint">{t('adv.import.searchHint')}</p>
                    : null}
                  {modelHits.length > 0 ? (
                    <div className="dshAma-candidateBlock">
                      <p className="dshAma-hint">{t('adv.import.matches')}</p>
                      <ul className="dshAma-candidateList">
                        {modelHits.map(hit => {
                          const key = hitKey(hit)
                          const name = typeof hit.draft.name === 'string' ? hit.draft.name : ''
                          return (
                            <li key={key} className="dshAma-candidate">
                              <label className="dshAma-check">
                                <input
                                  type="checkbox"
                                  checked={pickedModels.has(key)}
                                  onChange={() => {
                                    setPickedModels(current => {
                                      const next = new Set(current)
                                      if (!next.delete(key)) next.add(key)
                                      return next
                                    })
                                  }}
                                />
                                <span>
                                  {name !== '' && name !== hit.modelId
                                    ? t('adv.import.nameWithId', { name, id: hit.modelId })
                                    : hit.modelId}
                                </span>
                                <span className="dshAma-muted">{t('adv.import.providerSuffix', { provider: hit.providerId })}</span>
                                {existingIds.has(hit.modelId)
                                  ? <span className="dshAma-muted">{t('adv.import.configured')}</span>
                                  : null}
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ) : null}
                  <div className="dshAma-providerList">
                    {results.map(provider => (
                      <button
                        key={provider.id}
                        type="button"
                        className={`dshAma-providerRow${expanded?.provider.id === provider.id ? ' dshAma-providerRowActive' : ''}`}
                        onClick={() => { openProvider(provider) }}
                      >
                        <span className="dshAma-providerId">{provider.id}</span>
                        <span className="dshAma-providerMeta">
                          {provider.npm ?? provider.api ?? ''}
                          {provider.npm === '@ai-sdk/openai-compatible' ? t('adv.import.compatReference') : ''}
                        </span>
                      </button>
                    ))}
                    {query.trim() !== '' && results.length === 0 && modelHits.length === 0
                      ? <p className="dshAma-hint">{t('adv.import.noMatch')}</p>
                      : null}
                  </div>
                  {expanded === undefined ? null : (
                    <div className="dshAma-candidateBlock">
                      <p className="dshAma-hint">
                        {t('adv.import.providerModels', { provider: expanded.provider.id })}
                      </p>
                      <ul className="dshAma-candidateList">
                        {expanded.models.map(model => (
                          <li key={model.id} className="dshAma-candidate">
                            <label className="dshAma-check">
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
                              <span>{model.id}</span>
                              {existingIds.has(model.id)
                                ? <span className="dshAma-muted">{t('adv.import.configured')}</span>
                                : null}
                            </label>
                          </li>
                        ))}
                        {expanded.models.length === 0
                          ? <p className="dshAma-hint">{t('adv.import.providerEmpty')}</p>
                          : null}
                      </ul>
                    </div>
                  )}
                </>
              )}
        </div>
        <div className="dshAma-modalFoot">
          <button type="button" className="dshAma-button" onClick={onClose}>{t('adv.common.cancel')}</button>
          <button
            type="button"
            className="dshAma-button dshAma-buttonPrimary"
            disabled={adoptCount === 0}
            onClick={() => {
              if (pickedHits.length > 0) {
                onAdopt(pickedHits.map(hit => hit.draft))
              } else if (expanded !== undefined && picked.size > 0) {
                onAdopt(expanded.models.filter(model => picked.has(model.id)).map(model => model.draft))
              } else {
                return
              }
              onClose()
            }}
          >{t('adv.import.adopt', { count: adoptCount })}</button>
        </div>
      </div>
    </div>
  )
}
