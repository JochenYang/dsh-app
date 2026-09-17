/**
 * The Hooks settings section: entry cards with live mount status, an
 * add/edit form (dialect-selective fields + file/inline mode toggle), enable
 * toggles, and delete via the in-app ConfirmDialog.
 *
 * Every string comes from the `dsh-app.hooks` namespace through the `t`
 * standard seat: the section registers with `locale: NS`, so the renderer
 * hands the component a namespace-bound translate that reads the active UI
 * locale at call time and re-renders on a language switch. The host never sends
 * prose for anything the user reads (see `HostText` in ../wire.ts) — it sends a
 * code plus its params and {@link hostMessage} renders this page's copy — so a
 * local failure stays in state as a {@link Notice} (a dictionary key or a coded
 * host message) rather than a rendered sentence, and a fallback line follows
 * the language too.
 *
 * @module @dsh-app/plugin-hooks/client/hooks-section
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText } from '../wire.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { NS } from './locales.ts'
import type { HooksKey } from './locales.ts'
import { hostMessage, HostError, noticeText, wireNotice } from './messages.ts'
import type { Notice } from './messages.ts'

/**
 * The plugin's route prefix on the shared Connection `/api` channel (mirrors
 * the host half; the registry admits no `@` in a path segment, so the npm
 * scope travels as `dsh-app`).
 */
const ROUTE = '/api/plugins/dsh-app/plugin-hooks'

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type HooksSectionProps = PropsLocale<typeof NS>

interface BridgeView {
  id: string
  dialect: string
  enabled: boolean
  configSource: string
  configPath: string
  configContent?: string
  pluginRoot?: string
  projectDir?: string
  model?: string
  defaultTimeoutMs?: number
  stderrSummaryMaxChars?: number
  status: { state: string; message?: HostText }
}
interface HooksResponse {
  enabled: boolean
  filePath: string
  mountAvailable: boolean
  bridges: readonly BridgeView[]
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as {
    ok: boolean
    value?: T
    error?: { code?: string; message?: string; host?: HostText }
  }
  // The host's coded message is rendered in the active locale; its plain
  // `message` is the last-resort line when no code came with the answer.
  if (!response.ok || body.ok !== true) throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  return body.value as T
}

interface Draft {
  id: string | null
  dialect: 'native' | 'claude-code' | 'codex'
  enabled: boolean
  configSource: 'file' | 'inline'
  configPath: string
  configContent: string
  pluginRoot: string
  projectDir: string
  model: string
  defaultTimeoutMs: string
  stderrSummaryMaxChars: string
}

function emptyDraft(): Draft {
  return { id: null, dialect: 'native', enabled: true, configSource: 'inline', configPath: '', configContent: '', pluginRoot: '', projectDir: '', model: '', defaultTimeoutMs: '', stderrSummaryMaxChars: '' }
}
function draftFromView(view: BridgeView): Draft {
  return {
    id: view.id,
    dialect: view.dialect === 'codex' ? 'codex' : view.dialect === 'claude-code' ? 'claude-code' : 'native',
    enabled: view.enabled,
    configSource: view.configSource === 'inline' ? 'inline' : 'file',
    configPath: view.configPath,
    configContent: view.configContent ?? '',
    pluginRoot: view.pluginRoot ?? '',
    projectDir: view.projectDir ?? '',
    model: view.model ?? '',
    defaultTimeoutMs: view.defaultTimeoutMs === undefined ? '' : String(view.defaultTimeoutMs),
    stderrSummaryMaxChars: view.stderrSummaryMaxChars === undefined ? '' : String(view.stderrSummaryMaxChars),
  }
}

const NATIVE_PLACEHOLDER = JSON.stringify({ rules: [
  { name: '禁止修改生成目录', on: 'pre-tool-use', matcher: 'write|edit', action: 'block', message: '生成目录下的文件禁止修改' },
  { name: '编码规范提醒', on: 'prompt-submit', action: 'context', message: '始终遵循项目的提交规范' },
] }, null, 2)

/** Mount status badge: the dictionary key to show, plus the style class. */
const STATUS_BADGE: Record<string, { key: HooksKey; className: string }> = {
  mounted: { key: 'hooks.status.mounted', className: 'dshHk-badge dshHk-badgeOn' },
  starting: { key: 'hooks.status.starting', className: 'dshHk-badge' },
  disabled: { key: 'hooks.status.disabled', className: 'dshHk-badge dshHk-badgeOff' },
  error: { key: 'hooks.status.error', className: 'dshHk-badge dshHk-badgeErr' },
  unavailable: { key: 'hooks.status.unavailable', className: 'dshHk-badge dshHk-badgeErr' },
}

export function HooksSection({ t }: HooksSectionProps): ReactNode {
  const [data, setData] = useState<HooksResponse | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<BridgeView | null>(null)
  const [error, setError] = useState<Notice | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setData(await fetchJson<HooksResponse>(`${ROUTE}/hooks`)); setError(undefined) }
    catch (f) { setError(wireNotice(f)) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { setNotice(undefined) }, 5_000)
    return () => { clearTimeout(timer) }
  }, [notice])

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setNotice(undefined)
    try {
      const value = await fetchJson<HooksResponse>(`${ROUTE}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      setData(value)
    } catch (f) { setError(wireNotice(f)); throw f }
    finally { setBusy(false) }
  }, [])

  const onSave = useCallback(async () => {
    if (draft === null) return
    const inlineMode = draft.dialect === 'native' || draft.configSource === 'inline'
    const body: Record<string, unknown> = {
      dialect: draft.dialect,
      enabled: draft.id === null ? true : draft.enabled,
      configSource: inlineMode ? 'inline' : 'file',
    }
    if (inlineMode) {
      const content = draft.configContent.trim()
      if (content === '') { setError({ source: 'key', key: 'hooks.error.contentRequired' }); return }
      body.configContent = draft.configContent
    } else {
      const configPath = draft.configPath.trim()
      if (configPath === '') { setError({ source: 'key', key: 'hooks.error.pathRequired' }); return }
      // Empty-only gate here: the absolute-path shape is validated server-side
      // (validateBridge → 400 with a zh-CN reason, surfaced by post), so the
      // client never duplicates that rule.
      body.configPath = configPath
    }
    if (draft.dialect === 'claude-code') {
      if (draft.pluginRoot.trim() !== '') body.pluginRoot = draft.pluginRoot.trim()
      if (draft.projectDir.trim() !== '') body.projectDir = draft.projectDir.trim()
    } else if (draft.dialect === 'codex') {
      if (draft.model.trim() !== '') body.model = draft.model.trim()
    }
    for (const [field, val] of [['defaultTimeoutMs', draft.defaultTimeoutMs], ['stderrSummaryMaxChars', draft.stderrSummaryMaxChars]] as const) {
      if (val.trim() !== '') {
        // Empty-only gate: positivity is enforced server-side (400, surfaced by
        // post); a non-numeric entry serializes to null and is rejected there.
        body[field] = Number(val)
      }
    }
    try {
      await post(draft.id === null ? 'bridge/create' : 'bridge/update', draft.id === null ? body : { ...body, id: draft.id })
      setDraft(null)
      setNotice({ source: 'key', key: draft.id === null ? 'hooks.notice.created' : 'hooks.notice.saved' })
    } catch { /* post surfaced the error */ }
  }, [draft, post])

  const onToggle = useCallback(async (view: BridgeView) => {
    try { await post('bridge/update', { ...view, enabled: !view.enabled }); setNotice({ source: 'key', key: !view.enabled ? 'hooks.notice.enabled' : 'hooks.notice.disabled' }) }
    catch { /* post surfaced */ }
  }, [post])

  const onDelete = useCallback(async (view: BridgeView) => {
    try {
      await post('bridge/delete', { id: view.id })
      if (draft?.id === view.id) setDraft(null)
      setConfirmTarget(null)
      setNotice({ source: 'key', key: 'hooks.notice.deleted' })
    } catch { /* post surfaced */ }
  }, [draft, post])

  const sorted = useMemo(() => data === null ? [] : [...data.bridges].sort((a, b) => a.dialect.localeCompare(b.dialect) || a.configPath.localeCompare(b.configPath)), [data])

  return (
    <div className="dshHk-section">
      <p className="dshHk-title">{t('hooks.title')}</p>
      <p className="dshHk-hint">
        {t('hooks.intro')}
      </p>
      {error !== undefined ? <div className="dshHk-banner" role="alert">{noticeText(error, t)}</div> : null}
      {notice !== undefined ? <div className="dshHk-noticeOk">{noticeText(notice, t)}</div> : null}
      {data !== null && !data.mountAvailable ? <div className="dshHk-warning">{t('hooks.mountUnavailable')}</div> : null}

      {draft !== null ? (
        <form className="dshHk-form" onSubmit={(e) => { e.preventDefault(); void onSave() }}>
          <p className="dshHk-formTitle">{draft.id === null ? t('hooks.form.addTitle') : t('hooks.form.editTitle')}</p>
          <div className="dshHk-row">
            <div className="dshHk-field">
              <span className="dshHk-label">{t('hooks.field.dialect')}</span>
              <div className="dshHk-radioGroup" role="radiogroup" aria-label={t('hooks.field.dialect')}>
                <label><input type="radio" name="dshHkDialect" checked={draft.dialect === 'native'} disabled={busy} onChange={() => { setDraft({ ...draft, dialect: 'native' }) }} />{t('hooks.dialect.native')}</label>
                <label><input type="radio" name="dshHkDialect" checked={draft.dialect === 'claude-code'} disabled={busy} onChange={() => { setDraft({ ...draft, dialect: 'claude-code' }) }} />{t('hooks.dialect.claudeCode')}</label>
                <label><input type="radio" name="dshHkDialect" checked={draft.dialect === 'codex'} disabled={busy} onChange={() => { setDraft({ ...draft, dialect: 'codex' }) }} />{t('hooks.dialect.codex')}</label>
              </div>
              <span className="dshHk-fieldHint">{t('hooks.dialect.hint')}</span>
            </div>
          </div>

          {draft.dialect !== 'native' && (
            <div className="dshHk-field">
              <span className="dshHk-label">{t('hooks.field.source')}</span>
              <div className="dshHk-radioGroup" role="radiogroup" aria-label={t('hooks.field.source')}>
                <label><input type="radio" name="dshHkSource" checked={draft.configSource === 'file'} disabled={busy} onChange={() => { setDraft({ ...draft, configSource: 'file' }) }} />{t('hooks.source.file')}</label>
                <label><input type="radio" name="dshHkSource" checked={draft.configSource === 'inline'} disabled={busy} onChange={() => { setDraft({ ...draft, configSource: 'inline' }) }} />{t('hooks.source.inline')}</label>
              </div>
            </div>
          )}

          {draft.dialect === 'native' ? (
            <div className="dshHk-field">
              <span className="dshHk-label">{t('hooks.field.rules')}</span>
              <textarea className="dshHk-input" style={{ minHeight: '220px', fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre', overflowX: 'auto' }} value={draft.configContent} spellCheck={false} disabled={busy}
                placeholder={NATIVE_PLACEHOLDER}
                onChange={(e) => { setDraft({ ...draft, configContent: e.target.value }) }} />
              <span className="dshHk-fieldHint">
                {t('hooks.rules.hint')}
              </span>
            </div>
          ) : draft.configSource === 'file' ? (
            <div className="dshHk-field dshHk-fieldGrow">
              <span className="dshHk-label">{t('hooks.field.configPath')}</span>
              <input className="dshHk-input" value={draft.configPath} placeholder={t('hooks.configPath.placeholder')} disabled={busy} onChange={(e) => { setDraft({ ...draft, configPath: e.target.value }) }} />
              <span className="dshHk-fieldHint">{t('hooks.configPath.hint')}</span>
            </div>
          ) : (
            <div className="dshHk-field">
              <span className="dshHk-label">{t('hooks.field.configContent')}</span>
              <textarea className="dshHk-input" style={{ minHeight: '200px', fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre', overflowX: 'auto' }} value={draft.configContent} spellCheck={false} disabled={busy}
                placeholder={'{\n  "hooks": {\n    "Stop": [\n      { "hooks": [{ "type": "command", "command": "echo done" }] }\n    ]\n  }\n}'}
                onChange={(e) => { setDraft({ ...draft, configContent: e.target.value }) }} />
              <span className="dshHk-fieldHint">{t('hooks.configContent.hint')}</span>
            </div>
          )}

          {draft.dialect === 'claude-code' && (
            <div className="dshHk-row">
              <div className="dshHk-field dshHk-fieldGrow">
                <span className="dshHk-label">{t('hooks.field.pluginRoot')}</span>
                <input className="dshHk-input" value={draft.pluginRoot} disabled={busy} onChange={(e) => { setDraft({ ...draft, pluginRoot: e.target.value }) }} />
                <span className="dshHk-fieldHint">{t('hooks.pluginRoot.hint')}</span>
              </div>
              <div className="dshHk-field dshHk-fieldGrow">
                <span className="dshHk-label">{t('hooks.field.projectDir')}</span>
                <input className="dshHk-input" value={draft.projectDir} disabled={busy} onChange={(e) => { setDraft({ ...draft, projectDir: e.target.value }) }} />
                <span className="dshHk-fieldHint">{t('hooks.projectDir.hint')}</span>
              </div>
            </div>
          )}
          {draft.dialect === 'codex' && (
            <div className="dshHk-field dshHk-fieldGrow">
              <span className="dshHk-label">{t('hooks.field.model')}</span>
              <input className="dshHk-input" value={draft.model} placeholder={t('hooks.model.placeholder')} disabled={busy} onChange={(e) => { setDraft({ ...draft, model: e.target.value }) }} />
              <span className="dshHk-fieldHint">{t('hooks.model.hint')}</span>
            </div>
          )}
          <div className="dshHk-row">
            <div className="dshHk-field">
              <span className="dshHk-label">{t('hooks.field.timeout')}</span>
              <input className="dshHk-input" value={draft.defaultTimeoutMs} placeholder="600000" disabled={busy} onChange={(e) => { setDraft({ ...draft, defaultTimeoutMs: e.target.value }) }} />
            </div>
            <div className="dshHk-field">
              <span className="dshHk-label">{t('hooks.field.stderrMax')}</span>
              <input className="dshHk-input" value={draft.stderrSummaryMaxChars} placeholder="500" disabled={busy} onChange={(e) => { setDraft({ ...draft, stderrSummaryMaxChars: e.target.value }) }} />
            </div>
          </div>
          <div className="dshHk-formActions">
            <button type="submit" className="dshHk-button dshHk-buttonPrimary" disabled={busy}>{busy ? t('hooks.action.saving') : draft.id === null ? t('hooks.action.create') : t('hooks.action.save')}</button>
            <button type="button" className="dshHk-button" disabled={busy} onClick={() => { setDraft(null); setError(undefined) }}>{t('hooks.action.cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="dshHk-toolbar">
          <span className="dshHk-count">{data === null ? '' : t('hooks.count', { count: data.bridges.length })}</span>
          <button type="button" className="dshHk-button dshHk-buttonPrimary" disabled={busy || (data !== null && !data.enabled)} onClick={() => { setDraft(emptyDraft()); setError(undefined) }}>{t('hooks.action.add')}</button>
        </div>
      )}

      <div className="dshHk-list">
        {sorted.length === 0 && draft === null ? <div className="dshHk-empty">{t('hooks.empty')}</div> : null}
        {sorted.map((view) => {
          const badge = STATUS_BADGE[view.status.state] ?? STATUS_BADGE.disabled
          return (
            <div key={view.id} className="dshHk-card">
              <div className="dshHk-cardHead">
                <span className="dshHk-dialect">{view.dialect === 'native' ? t('hooks.dialect.nativeShort') : view.dialect}</span>
                <span className="dshHk-badge">{view.configSource === 'inline' ? t('hooks.badge.inline') : t('hooks.badge.file')}</span>
                <span className={badge.className}>{t(badge.key)}</span>
              </div>
              {/* The host explains an unhealthy entry with a code; the badge's own
                  copy is the last resort, so an unknown code still shows a line. */}
              {view.status.message !== undefined
                ? <div className="dshHk-warning">{hostMessage(view.status.message, t, t(badge.key))}</div>
                : null}
              <div className="dshHk-meta">{view.configPath}</div>
              <div className="dshHk-cardActions">
                <button type="button" className="dshHk-toggle" role="switch" aria-checked={view.enabled} aria-label={t('hooks.toggle.aria')} disabled={busy} onClick={() => { void onToggle(view) }} />
                <button type="button" className="dshHk-button" disabled={busy} onClick={() => { setDraft(draftFromView(view)) }}>{t('hooks.action.edit')}</button>
                <button type="button" className="dshHk-button dshHk-buttonDanger" disabled={busy} onClick={() => { setConfirmTarget(view) }}>{t('hooks.action.delete')}</button>
              </div>
            </div>
          )
        })}
      </div>
      {data !== null ? <p className="dshHk-path" title={data.filePath}>{t('hooks.path', { path: data.filePath })}</p> : null}
      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('hooks.confirm.deleteTitle')}
        message={t('hooks.confirm.deleteMessage')}
        confirmLabel={t('hooks.confirm.deleteConfirm')}
        cancelLabel={t('hooks.action.cancel')}
        busy={busy}
        onConfirm={() => { if (confirmTarget !== null) void onDelete(confirmTarget) }}
        onClose={() => { setConfirmTarget(null) }}
      />
    </div>
  )
}
