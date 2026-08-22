/**
 * models.dev import dialog: search the feed, pick a provider, check models,
 * adopt them as draft rows. Nothing is written here — adoption only fills
 * the form; the section's save path (validated, conflict-checked
 * `settings.mutate`) decides what actually lands in settings.yaml.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelDraft } from './fields.ts'
import { fetchModelsDev, mapProviderModels, searchProviders } from './models-dev.ts'
import type { ModelsDevProvider } from './models-dev.ts'

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
}

/** One provider row with its mapped models and pick state. */
interface ProviderDraft {
  provider: ModelsDevProvider
  models: { id: string; draft: ModelDraft }[]
}

/**
 * The import flow. The feed fetch runs once per open; a network/CORS failure
 * is a dead end for the BUTTON, not the page — the manual form stays usable.
 */
export function ModelsDevImportDialog(props: ModelsDevImportDialogProps): ReactNode {
  const { open, onClose, onAdopt, existingIds } = props
  const [providers, setProviders] = useState<readonly ModelsDevProvider[] | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ProviderDraft | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
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
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { stale = true }
  }, [open, providers])

  const results = useMemo(
    () => providers === undefined ? [] : searchProviders(providers, query).slice(0, 20),
    [providers, query],
  )

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
        aria-label="从 models.dev 导入模型"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshAma-modalHead">
          <span className="dshAma-modalTitle">从 models.dev 导入模型</span>
          <button type="button" className="dshAma-iconButton" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="dshAma-modalBody">
          {failure !== undefined
            ? (
              <div className="dshAma-error">
                <p>无法访问 models.dev（{failure}）。可能是网络或浏览器跨域限制，可关闭后手动填写字段。</p>
                <button
                  type="button" className="dshAma-button"
                  onClick={() => { setProviders(undefined); setFailure(undefined) }}
                >重试</button>
              </div>
            )
            : busy || providers === undefined
              ? <p className="dshAma-hint">正在获取 models.dev 目录…</p>
              : (
                <>
                  <input
                    className="dshAma-input"
                    type="text"
                    value={query}
                    placeholder="搜索 provider（如 opencode、deepseek、openai-compatible）"
                    aria-label="搜索 provider"
                    onChange={(event) => { setQuery(event.target.value); setExpanded(undefined) }}
                  />
                  {query.trim() === '' ? <p className="dshAma-hint">输入关键词搜索 provider，再选择要导入的模型。</p> : null}
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
                          {provider.npm === '@ai-sdk/openai-compatible' ? ' · openai-completions 参考' : ''}
                        </span>
                      </button>
                    ))}
                    {query.trim() !== '' && results.length === 0
                      ? <p className="dshAma-hint">没有匹配的 provider。</p>
                      : null}
                  </div>
                  {expanded === undefined ? null : (
                    <div className="dshAma-candidateBlock">
                      <p className="dshAma-hint">
                        {expanded.provider.id} 的模型（已跳过不支持工具调用的条目；compat 预设请在各行按网关确认）：
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
                              {existingIds.has(model.id) ? <span className="dshAma-muted">（已配置）</span> : null}
                            </label>
                          </li>
                        ))}
                        {expanded.models.length === 0
                          ? <p className="dshAma-hint">该 provider 没有可导入的模型（可能均不支持工具调用）。</p>
                          : null}
                      </ul>
                    </div>
                  )}
                </>
              )}
        </div>
        <div className="dshAma-modalFoot">
          <button type="button" className="dshAma-button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="dshAma-button dshAma-buttonPrimary"
            disabled={expanded === undefined || picked.size === 0}
            onClick={() => {
              if (expanded === undefined) return
              onAdopt(expanded.models.filter(model => picked.has(model.id)).map(model => model.draft))
              onClose()
            }}
          >{`采用 ${String(picked.size)} 个模型`}</button>
        </div>
      </div>
    </div>
  )
}
