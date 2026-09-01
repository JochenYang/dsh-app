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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function friendlyFailure(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes('baseurl') || normalized.includes('endpoint')) {
    return '该 provider 没有内置目录，请检查 baseURL 和 wire 协议。'
  }
  if (normalized.includes('credential') || normalized.includes('api key') || normalized.includes('unauthorized')) {
    return 'provider 需要凭据，请检查官方“模型”页的凭据配置，或填写临时 API Key。'
  }
  if (normalized.includes('timeout') || normalized.includes('network') || normalized.includes('fetch')) {
    return 'provider 暂时无法访问，请检查网络和端点后重试。'
  }
  return 'dsh 暂时无法从该 provider 获取模型，请检查协议、端点和凭据。'
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
  const { open, onClose, onAdopt, existingIds, api, target } = props
  const [models, setModels] = useState<readonly LlmDiscoveredModel[] | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
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
      setFailure(friendlyFailure(messageOf(error)))
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
  const label = target.provider ?? '当前新路由'
  return (
    <div className="dshAma-modalMask" role="presentation" onClick={onClose}>
      <div
        className="dshAma-modal dshAma-discoveryModal"
        role="dialog"
        aria-modal="true"
        aria-label="从 provider 发现模型"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshAma-modalHead">
          <span className="dshAma-modalTitle">从 provider 发现模型</span>
          <button type="button" className="dshAma-iconButton" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="dshAma-modalBody">
          <div className="dshAma-discoverySource">
            <span className="dshAma-discoverySourceLabel">发现来源</span>
            <code>{label}</code>
          </div>
          <p className="dshAma-hint">
            使用 dsh 当前 provider 的模型发现接口，导入结果只填入草稿，保存后才会写入配置。
          </p>
          {isDraftRoute
            ? (
              <label className="dshAma-field">
                <span className="dshAma-fieldLabel">临时 API Key（可选，不会保存）</span>
                <input
                  className="dshAma-input"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  aria-label="临时 API Key"
                  placeholder="需要鉴权时填写"
                  onChange={(event) => { setApiKey(event.target.value) }}
                />
              </label>
            )
            : null}
          {!canDiscover
            ? <p className="dshAma-error">请先填写新路由的 baseURL 和 wire 协议。</p>
            : failure !== undefined
              ? (
                <div className="dshAma-error">
                  <p>provider 未返回模型：{failure}</p>
                  <button type="button" className="dshAma-button" onClick={() => { void discover(apiKey) }}>重试</button>
                </div>
              )
              : busy
                ? <p className="dshAma-hint">正在向 provider 获取模型…</p>
                : (
                  <>
                    <div className="dshAma-discoveryToolbar">
                      <input
                        className="dshAma-input"
                        type="search"
                        value={query}
                        placeholder="筛选模型 ID 或名称"
                        aria-label="筛选模型"
                        onChange={(event) => { setQuery(event.target.value) }}
                      />
                      <button type="button" className="dshAma-button" onClick={() => { void discover(apiKey) }}>重新发现</button>
                    </div>
                    <div className="dshAma-discoveryList">
                      {visibleModels.map(model => {
                        const meta = [
                          model.name !== undefined && model.name !== model.id ? model.name : '',
                          model.contextWindow === undefined ? '' : `上下文 ${formatCapacity(model.contextWindow)}`,
                          model.maxTokens === undefined ? '' : `输出 ${formatCapacity(model.maxTokens)}`,
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
                              <small>{meta === '' ? 'provider 未提供额外信息' : meta}</small>
                            </span>
                            {existingIds.has(model.id) ? <span className="dshAma-muted">已配置</span> : null}
                          </label>
                        )
                      })}
                      {visibleModels.length === 0
                        ? <p className="dshAma-hint">没有可导入的模型。</p>
                        : null}
                    </div>
                  </>
                )}
        </div>
        <div className="dshAma-modalFoot">
          <button type="button" className="dshAma-button" onClick={onClose}>取消</button>
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
          >{`采用 ${String(picked.size)} 个模型`}</button>
        </div>
      </div>
    </div>
  )
}
