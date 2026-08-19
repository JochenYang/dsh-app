/**
 * The brand Models settings section (shadows the upstream `models` entry via
 * a lower list-slot priority). Renders provider cards from the brand store,
 * an add-card for declaring OpenAI-compatible routes, and an in-page toast
 * for save/remove feedback.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { messageOf, protocolChoices, type BrandModelsState, type BrandModelsStore } from './models-store.ts'
import { ProviderCard } from './ProviderCard.tsx'
import cssText from './models.css'

/** Inject the brand stylesheet once per document (idempotent under HMR). */
if (typeof document !== 'undefined') {
  const tagId = 'dsh-app-client-ui/models.css'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-app/plugin-client-ui'
    tag.dataset.pluginCss = tagId
    tag.textContent = cssText
    document.head.appendChild(tag)
  }
}

/** zh copy (the product ships for mainland users first; i18n is follow-up). */
const zh: Record<string, string> = {
  title: '模型',
  intro: '连接服务商、管理凭证与端点。凭证与设置分开保存，删除需确认。',
  loadFailed: '加载失败',
  retry: '重试',
  statusConfigured: '已配置',
  statusMissingKey: '缺少 API Key',
  statusNative: '原生认证',
  statusInactive: '未启用',
  configure: '配置',
  collapse: '收起',
  remove: '移除',
  confirmRemove: '确认移除？',
  cancel: '取消',
  save: '保存',
  saving: '保存中…',
  savedToast: '已保存',
  removedToast: '已移除',
  keyInput: 'API Key',
  keyPlaceholder: '粘贴 API Key（留空则不改动）',
  keyStored: '已保存（重新输入以替换）',
  keyEnvLocked: '由环境变量提供，不可在此修改',
  baseUrl: '接口地址（baseURL）',
  protocol: '协议',
  protocolUnset: '（默认）',
  conflict: '设置已被其他端修改，请重试',
  addTitle: '添加 OpenAI 兼容服务商',
  addId: '路由 ID',
  addName: '显示名称',
  add: '添加',
  addInvalid: '路由 ID 需为小写字母/数字/连字符',
}

export interface BrandModelsSectionInjected {
  controller: BrandModelsStore
  useSnapshot: SnapshotSelectorHook<BrandModelsState>
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
}

/**
 * Props delivered by the slot outlet: the inject face spread FLAT (the
 * renderer erases the share boundary at the render call — same contract as
 * the upstream ModelsSection) plus the owner's `close`. Guarded like the
 * upstream section: a missing face renders null instead of throwing into the
 * slot error boundary (which blanks the whole panel).
 */
export type BrandModelsSectionProps = Partial<BrandModelsSectionInjected> & {
  close: () => void
}

export function BrandModelsSection(props: BrandModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} api={api} />
}

function Loaded({ controller, useSnapshot, api }: BrandModelsSectionInjected): ReactNode {
  const state = useSnapshot(s => s)
  const [toast, setToast] = useState<{ text: string; ok: boolean; seq: number } | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [state.status, controller])

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => { setToast(null) }, 2600)
    return () => { clearTimeout(timer) }
  }, [toast])

  const onToast = (text: string, ok: boolean): void => { setToast({ text, ok, seq: Date.now() }) }

  const t = (key: string): string => zh[key] ?? key

  return (
    <div className="dshapp-models">
      {toast !== null
        ? (
          <div key={toast.seq} className={toast.ok ? 'dshapp-toast' : 'dshapp-toast dshapp-toast-err'} role="status">
            {toast.text}
          </div>
        )
        : null}
      <div className="dshapp-models-header">
        <span className="dshapp-models-title">{t('title')}</span>
        <button type="button" className="dshapp-btn dshapp-btn-primary" onClick={() => { setAdding(v => !v) }}>
          {t('addTitle')}
        </button>
      </div>
      <p className="dshapp-models-intro">{t('intro')}</p>
      {state.status === 'error'
        ? (
          <div className="dshapp-models-error">
            {`${t('loadFailed')}: ${state.error ?? ''}`}
            {' '}
            <button type="button" className="dshapp-btn" onClick={() => { void controller.load() }}>
              {t('retry')}
            </button>
          </div>
        )
        : null}
      {adding
        ? <AddCard api={api} onToast={onToast} onDone={() => { setAdding(false) }} t={t} />
        : null}
      <div className="dshapp-cards">
        {state.rows.map(row => (
          <ProviderCard
            key={row.provider}
            row={row}
            namespace={state.namespaces.get(row.settingsNs)}
            api={api}
            readOnly={!state.writable}
            onToast={onToast}
            onRemoved={() => { void controller.load() }}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

/** Declare a brand-new OpenAI-compatible route under llm-pi-ai. */
function AddCard({
  api, onToast, onDone, t,
}: {
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  onToast: (text: string, ok: boolean) => void
  onDone: () => void
  t: (key: string) => string
}): ReactNode {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState('openai-completions')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [piNamespace, setPiNamespace] = useState<SettingsNamespaceView | undefined>(undefined)

  useEffect(() => {
    let stale = false
    void api.settings.describe({}).then((response) => {
      if (stale || !response.result.ok) return
      setPiNamespace(response.result.value.namespaces.find(view => view.ns === 'llm-pi-ai'))
    }, () => undefined)
    return () => { stale = true }
  }, [api.settings])

  const protocols = useMemo(() => protocolChoices(piNamespace), [piNamespace])
  const idOk = /^[a-z][a-z0-9-]*$/.test(id)

  const submit = async (): Promise<void> => {
    if (!idOk) {
      setFailure(t('addInvalid'))
      return
    }
    setBusy(true)
    setFailure(undefined)
    try {
      const profile: Record<string, unknown> = {
        api: protocol,
        ...(baseURL.trim() === '' ? {} : { baseURL: baseURL.trim() }),
        ...(name.trim() === '' ? {} : { displayName: name.trim() }),
      }
      const keyRef = key.trim() === '' ? undefined : `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
      const ops = [{ op: 'set', path: ['providers', id], value: keyRef === undefined ? profile : { ...profile, apiKeyEnv: keyRef } }]
      const response = await api.settings.mutate({ ns: 'llm-pi-ai', ops })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return
      }
      if (key.trim() !== '' && keyRef !== undefined) {
        const stored = await api.credentials.set({ ref: keyRef, value: key.trim() })
        if (!stored.result.ok) {
          setFailure(stored.result.error.message)
          return
        }
      }
      onToast(`${name.trim() === '' ? id : name.trim()} ${t('savedToast')}`, true)
      onDone()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dshapp-card">
      <div className="dshapp-card-name">{t('addTitle')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('addId')}</span>
          <input className="dshapp-input" value={id} placeholder="my-gateway" onChange={(e) => { setId(e.target.value) }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('addName')}</span>
          <input className="dshapp-input" value={name} placeholder="My Gateway" onChange={(e) => { setName(e.target.value) }} />
        </label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('baseUrl')}</span>
        <input className="dshapp-input" value={baseURL} placeholder="https://api.example.com/v1" onChange={(e) => { setBaseURL(e.target.value) }} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('protocol')}</span>
          <select className="dshapp-input" value={protocol} onChange={(e) => { setProtocol(e.target.value) }}>
            {(protocols.length > 0 ? protocols : ['openai-completions']).map(choice => (
              <option key={choice} value={choice}>{choice}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('keyInput')}</span>
          <input className="dshapp-input" type="password" autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value) }} />
        </label>
      </div>
      {failure !== undefined
        ? <p style={{ margin: 0, fontSize: 12, color: '#e08585' }}>{failure}</p>
        : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="dshapp-btn dshapp-btn-primary" disabled={busy} onClick={() => { void submit() }}>
          {busy ? t('saving') : t('add')}
        </button>
        <button type="button" className="dshapp-btn" disabled={busy} onClick={onDone}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}
