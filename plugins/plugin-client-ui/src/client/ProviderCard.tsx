/**
 * One provider card: brand icon, name/route, credential status dot, and the
 * editor surface (API key + endpoint + protocol for declared routes). Writes
 * go through settings.mutate (path ops) + credentials.set, same contract the
 * upstream editor uses.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CredentialView, IApiClient, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  deletePath, getPath, nodeAtPath, rehydrateSchema, setPath,
} from '@deepseek-ai/dsh-client-schema-form'
import { deriveKeyRef, messageOf, protocolChoices, type BrandProviderRow } from './models-store.ts'

/** Brand palette for provider icons (hashed by route id). */
const ICON_COLORS = ['#4b67fc', '#7c5cfc', '#2fa8e0', '#35b46f', '#e0a13c', '#e0655c']

/** Two-letter brand glyph for a provider route. */
export function brandGlyph(provider: string): { text: string; color: string } {
  const cleaned = provider.replace(/[^a-z0-9]/gi, '')
  const text = cleaned.slice(0, 2).toUpperCase() || 'AI'
  let hash = 0
  for (const ch of provider) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return { text, color: ICON_COLORS[hash % ICON_COLORS.length] ?? '#4b67fc' }
}

/** Minimal path ops carrying `after` over `before` (fields the card sees). */
function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

export interface ProviderCardProps {
  row: BrandProviderRow
  namespace: SettingsNamespaceView | undefined
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  readOnly: boolean
  onToast: (text: string, ok: boolean) => void
  onRemoved: (provider: string) => void
  t: (key: string) => string
}

export function ProviderCard({ row, namespace, api, readOnly, onToast, onRemoved, t }: ProviderCardProps): ReactNode {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const glyph = brandGlyph(row.provider)

  const status = !row.active
    ? { dot: 'dshapp-dot-off', label: t('statusInactive') }
    : row.apiKeyEnv === undefined
      ? { dot: 'dshapp-dot-ok', label: t('statusNative') }
      : row.credential?.configured === true
        ? { dot: 'dshapp-dot-ok', label: t('statusConfigured') }
        : { dot: 'dshapp-dot-missing', label: t('statusMissingKey') }

  return (
    <div className="dshapp-card">
      <div className="dshapp-card-head">
        <span className="dshapp-card-icon" style={{ background: glyph.color }} aria-hidden="true">
          {glyph.text}
        </span>
        <span className="dshapp-card-names">
          <span className="dshapp-card-name">{row.displayName}</span>
          {row.provider !== row.displayName
            ? <span className="dshapp-card-route">{row.provider}</span>
            : null}
        </span>
      </div>
      <div className="dshapp-card-status">
        <span className={`dshapp-dot ${status.dot}`} />
        <span>{status.label}</span>
      </div>
      {editing && namespace !== undefined
        ? (
          <ProviderEditor
            row={row}
            namespace={namespace}
            api={api}
            readOnly={readOnly}
            onToast={onToast}
            onClose={() => { setEditing(false) }}
            t={t}
          />
        )
        : null}
      <div className="dshapp-card-actions">
        <button type="button" className="dshapp-btn dshapp-btn-primary" onClick={() => { setEditing(v => !v) }}>
          {editing ? t('collapse') : t('configure')}
        </button>
        {row.removable && !readOnly
          ? confirming
            ? (
              <>
                <button
                  type="button"
                  className="dshapp-btn dshapp-btn-danger"
                  onClick={() => {
                    void removeProvider(row, api).then((failure) => {
                      if (failure === undefined) {
                        onToast(`${row.displayName} ${t('removedToast')}`, true)
                        onRemoved(row.provider)
                      } else {
                        onToast(failure, false)
                        setConfirming(false)
                      }
                    })
                  }}
                >
                  {t('confirmRemove')}
                </button>
                <button type="button" className="dshapp-btn" onClick={() => { setConfirming(false) }}>
                  {t('cancel')}
                </button>
              </>
            )
            : (
              <button type="button" className="dshapp-btn dshapp-btn-danger" onClick={() => { setConfirming(true) }}>
                {t('remove')}
              </button>
            )
          : null}
      </div>
    </div>
  )
}

/** Remove a hand-declared route: unset its profile subtree. */
async function removeProvider(
  row: BrandProviderRow,
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>,
): Promise<string | undefined> {
  try {
    const response = await api.settings.mutate({
      ns: row.settingsNs,
      ops: [{ op: 'unset', path: [...row.settingsPath] }],
    })
    if (!response.result.ok) return response.result.error.message
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

interface EditorProps {
  row: BrandProviderRow
  namespace: SettingsNamespaceView
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  readOnly: boolean
  onToast: (text: string, ok: boolean) => void
  onClose: () => void
  t: (key: string) => string
}

/** The inline editor: API key (credential) + endpoint + protocol (declared). */
function ProviderEditor({ row, namespace, api, readOnly, onToast, onClose, t }: EditorProps): ReactNode {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const subtree = getPath(namespace.user, row.settingsPath)
    return typeof subtree === 'object' && subtree !== null && !Array.isArray(subtree)
      ? structuredClone(subtree) as Record<string, unknown>
      : {}
  })
  const [keyDraft, setKeyDraft] = useState('')
  const [keyState, setKeyState] = useState<CredentialView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [committedOriginal, setCommittedOriginal] = useState<unknown>(
    () => getPath(namespace.user, row.settingsPath),
  )
  const [expectedRevision, setExpectedRevision] = useState(() => namespace.revision)
  const root = useMemo(() => rehydrateSchema(namespace.schema), [namespace.schema])
  const keyRef = useMemo(() => {
    const profile = getPath(namespace.value, row.settingsPath)
    const named = typeof profile === 'object' && profile !== null
      ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
      : undefined
    return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(row.provider)
  }, [namespace, row])
  const declared = row.declared
  const protocols = useMemo(() => (declared ? protocolChoices(namespace) : []), [declared, namespace])

  useEffect(() => {
    let stale = false
    setKeyState(undefined)
    void api.credentials.describe({ refs: [keyRef] }).then(
      (response) => {
        if (stale || !response.result.ok) return
        setKeyState(response.result.value.credentials[keyRef])
      },
      () => undefined,
    )
    return () => { stale = true }
  }, [api.credentials, keyRef])

  const stringAt = (key: string): string | undefined => {
    const value = getPath(draft, [key])
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  }
  const setField = (key: string, next: string | undefined): void => {
    const value = next === undefined || next.trim().length === 0 ? undefined : next
    setDraft(current => value === undefined ? deletePath(current, [key]) : setPath(current, [key], value))
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const keyValue = keyDraft.trim()
      let next = draft
      if (declared && stringAt('apiKeyEnv') === undefined && keyValue.length > 0) {
        next = setPath(draft, ['apiKeyEnv'], keyRef)
      }
      const node = nodeAtPath(root, row.settingsPath)
      const ops: SettingsPathOpView[] = node === undefined && row.settingsPath.length === 0
        ? [{ op: 'set', path: [], value: next }]
        : pathOps(row.settingsPath, committedOriginal, next)
      if (ops.length > 0) {
        const response = await api.settings.mutate({ ns: row.settingsNs, ops, expectedRevision })
        if (!response.result.ok) {
          setFailure(response.result.error.code === 'settings-conflict'
            ? t('conflict')
            : response.result.error.message)
          return
        }
        setCommittedOriginal(getPath(response.result.value.user, row.settingsPath))
        setExpectedRevision(response.result.value.revision)
        setDraft(next)
      }
      if (keyValue.length > 0) {
        const stored = await api.credentials.set({ ref: keyRef, value: keyValue })
        if (!stored.result.ok) {
          setFailure(stored.result.error.message)
          return
        }
      }
      setKeyDraft('')
      onToast(`${row.displayName} ${t('savedToast')}`, true)
      onClose()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const keyLocked = keyState?.writable === false
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('keyInput')}</span>
        <input
          type="password"
          autoComplete="off"
          className="dshapp-input"
          value={keyDraft}
          placeholder={keyLocked
            ? t('keyEnvLocked')
            : keyState?.configured === true ? t('keyStored') : t('keyPlaceholder')}
          disabled={readOnly || busy || keyLocked}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('baseUrl')}</span>
        <input
          type="text"
          className="dshapp-input"
          value={stringAt('baseURL') ?? ''}
          placeholder="https://api.example.com/v1"
          disabled={readOnly || busy}
          onChange={(event) => { setField('baseURL', event.target.value === '' ? undefined : event.target.value) }}
        />
      </label>
      {declared
        ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #8b97b0)' }}>{t('protocol')}</span>
            <select
              className="dshapp-input"
              value={stringAt('api') ?? ''}
              disabled={readOnly || busy}
              onChange={(event) => { setField('api', event.target.value === '' ? undefined : event.target.value) }}
            >
              <option value="">{t('protocolUnset')}</option>
              {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          </label>
        )
        : null}
      {failure !== undefined
        ? <p style={{ margin: 0, fontSize: 12, color: '#e08585' }}>{failure}</p>
        : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="dshapp-btn dshapp-btn-primary"
          disabled={readOnly || busy}
          onClick={() => { void apply() }}
        >
          {busy ? t('saving') : t('save')}
        </button>
        <button type="button" className="dshapp-btn" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}
