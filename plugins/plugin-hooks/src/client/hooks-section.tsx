/**
 * The Hooks settings section: entry cards with live mount status, an
 * add/edit form (dialect-selective fields + file/inline mode toggle), enable
 * toggles, and delete via the in-app ConfirmDialog.
 * @module @dsh-app/plugin-hooks/client/hooks-section
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmDialog } from './confirm-dialog.tsx'

const ROUTE = '/plugins/@dsh-app/plugin-hooks/api'

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
  status: { state: string; message?: string }
}
interface HooksResponse {
  enabled: boolean
  filePath: string
  mountAvailable: boolean
  bridges: readonly BridgeView[]
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string } }
  if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
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

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  mounted: { label: '已挂载', className: 'dshHk-badge dshHk-badgeOn' },
  starting: { label: '挂载中', className: 'dshHk-badge' },
  disabled: { label: '已停用', className: 'dshHk-badge dshHk-badgeOff' },
  error: { label: '挂载失败', className: 'dshHk-badge dshHk-badgeErr' },
  unavailable: { label: '内核不支持', className: 'dshHk-badge dshHk-badgeErr' },
}

export function HooksSection(): ReactNode {
  const [data, setData] = useState<HooksResponse | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<BridgeView | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setData(await fetchJson<HooksResponse>(`${ROUTE}/hooks`)); setError(undefined) }
    catch (f) { setError(f instanceof Error ? f.message : String(f)) }
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
    } catch (f) { setError(f instanceof Error ? f.message : String(f)); throw f }
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
      if (content === '') { setError('配置内容不能为空'); return }
      body.configContent = draft.configContent
    } else {
      const configPath = draft.configPath.trim()
      if (configPath === '') { setError('请填写 hooks.json 的绝对路径'); return }
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
      setNotice(draft.id === null ? '已添加并挂载' : '已保存并重新挂载')
    } catch { /* post surfaced the error */ }
  }, [draft, post])

  const onToggle = useCallback(async (view: BridgeView) => {
    try { await post('bridge/update', { ...view, enabled: !view.enabled }); setNotice(!view.enabled ? '已启用' : '已停用') }
    catch { /* post surfaced */ }
  }, [post])

  const onDelete = useCallback(async (view: BridgeView) => {
    try {
      await post('bridge/delete', { id: view.id })
      if (draft?.id === view.id) setDraft(null)
      setConfirmTarget(null)
      setNotice('已删除')
    } catch { /* post surfaced */ }
  }, [draft, post])

  const sorted = useMemo(() => data === null ? [] : [...data.bridges].sort((a, b) => a.dialect.localeCompare(b.dialect) || a.configPath.localeCompare(b.configPath)), [data])

  return (
    <div className="dshHk-section">
      <p className="dshHk-title">Hooks</p>
      <p className="dshHk-hint">
        复用已有的 Claude Code / Codex hooks 配置，或直接在此编写：SessionStart、prompt 提交、工具调用前后、Stop 等时机的命令钩子自动生效。
        命令在本机执行，请确认来源可信。保存后即时挂载。
      </p>
      {error !== undefined ? <div className="dshHk-banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshHk-noticeOk">{notice}</div> : null}
      {data !== null && !data.mountAvailable ? <div className="dshHk-warning">当前内核不支持动态挂载：配置可保存但不会生效。</div> : null}

      {draft !== null ? (
        <form className="dshHk-form" onSubmit={(e) => { e.preventDefault(); void onSave() }}>
          <p className="dshHk-formTitle">{draft.id === null ? '添加 Hook 配置' : '编辑 Hook 配置'}</p>
          <div className="dshHk-row">
            <div className="dshHk-field">
              <span className="dshHk-label">类型</span>
              <div className="dshHk-radioGroup" role="radiogroup" aria-label="类型">
                <label><input type="radio" name="dshHkDialect" checked={draft.dialect === 'native'} disabled={busy} onChange={() => { setDraft({ ...draft, dialect: 'native' }) }} />DSH 原生（推荐）</label>
                <label><input type="radio" name="dshHkDialect" checked={draft.dialect === 'claude-code'} disabled={busy} onChange={() => { setDraft({ ...draft, dialect: 'claude-code' }) }} />Claude Code 兼容</label>
                <label><input type="radio" name="dshHkDialect" checked={draft.dialect === 'codex'} disabled={busy} onChange={() => { setDraft({ ...draft, dialect: 'codex' }) }} />Codex 兼容</label>
              </div>
              <span className="dshHk-fieldHint">DSH 原生为应用自有格式，规则更简单直观；兼容格式用于复用已有的 Claude Code / Codex hooks 配置文件。应用只读取/托管配置，不会写入它们的安装目录。</span>
            </div>
          </div>

          {draft.dialect !== 'native' && (
            <div className="dshHk-field">
              <span className="dshHk-label">配置来源</span>
              <div className="dshHk-radioGroup" role="radiogroup" aria-label="配置来源">
                <label><input type="radio" name="dshHkSource" checked={draft.configSource === 'file'} disabled={busy} onChange={() => { setDraft({ ...draft, configSource: 'file' }) }} />导入已有配置</label>
                <label><input type="radio" name="dshHkSource" checked={draft.configSource === 'inline'} disabled={busy} onChange={() => { setDraft({ ...draft, configSource: 'inline' }) }} />手动编写</label>
              </div>
            </div>
          )}

          {draft.dialect === 'native' ? (
            <div className="dshHk-field">
              <span className="dshHk-label">规则配置</span>
              <textarea className="dshHk-input" style={{ minHeight: '220px', fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre', overflowX: 'auto' }} value={draft.configContent} spellCheck={false} disabled={busy}
                placeholder={NATIVE_PLACEHOLDER}
                onChange={(e) => { setDraft({ ...draft, configContent: e.target.value }) }} />
              <span className="dshHk-fieldHint">
                规则字段：name（名称）、on（时机：pre-tool-use / post-tool-use / prompt-submit / session-start）、matcher（可选正则，匹配工具名）、action（block = 拦截，context = 注入提醒上下文）、message（拦截原因或提醒文本）。
              </span>
            </div>
          ) : draft.configSource === 'file' ? (
            <div className="dshHk-field dshHk-fieldGrow">
              <span className="dshHk-label">配置文件路径</span>
              <input className="dshHk-input" value={draft.configPath} placeholder="例如 D:/proj/.claude/hooks.json" disabled={busy} onChange={(e) => { setDraft({ ...draft, configPath: e.target.value }) }} />
              <span className="dshHk-fieldHint">指向你已有的 hooks.json；应用只读取该文件，不修改它。</span>
            </div>
          ) : (
            <div className="dshHk-field">
              <span className="dshHk-label">配置内容</span>
              <textarea className="dshHk-input" style={{ minHeight: '200px', fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre', overflowX: 'auto' }} value={draft.configContent} spellCheck={false} disabled={busy}
                placeholder={'{\n  "hooks": {\n    "Stop": [\n      { "hooks": [{ "type": "command", "command": "echo done" }] }\n    ]\n  }\n}'}
                onChange={(e) => { setDraft({ ...draft, configContent: e.target.value }) }} />
              <span className="dshHk-fieldHint">直接编写或粘贴 hooks.json 内容；保存后由应用托管，无需手动管理文件。</span>
            </div>
          )}

          {draft.dialect === 'claude-code' && (
            <div className="dshHk-row">
              <div className="dshHk-field dshHk-fieldGrow">
                <span className="dshHk-label">插件根目录（可选）</span>
                <input className="dshHk-input" value={draft.pluginRoot} disabled={busy} onChange={(e) => { setDraft({ ...draft, pluginRoot: e.target.value }) }} />
                <span className="dshHk-fieldHint">命令中引用插件路径时替换为此值</span>
              </div>
              <div className="dshHk-field dshHk-fieldGrow">
                <span className="dshHk-label">项目目录（可选）</span>
                <input className="dshHk-input" value={draft.projectDir} disabled={busy} onChange={(e) => { setDraft({ ...draft, projectDir: e.target.value }) }} />
                <span className="dshHk-fieldHint">命令中引用项目路径时替换为此值；默认为会话工作区</span>
              </div>
            </div>
          )}
          {draft.dialect === 'codex' && (
            <div className="dshHk-field dshHk-fieldGrow">
              <span className="dshHk-label">模型名（可选）</span>
              <input className="dshHk-input" value={draft.model} placeholder="例如 deepseek-v4" disabled={busy} onChange={(e) => { setDraft({ ...draft, model: e.target.value }) }} />
              <span className="dshHk-fieldHint">Codex 事件中 stamp 的模型名</span>
            </div>
          )}
          <div className="dshHk-row">
            <div className="dshHk-field">
              <span className="dshHk-label">默认超时 ms（可选）</span>
              <input className="dshHk-input" value={draft.defaultTimeoutMs} placeholder="600000" disabled={busy} onChange={(e) => { setDraft({ ...draft, defaultTimeoutMs: e.target.value }) }} />
            </div>
            <div className="dshHk-field">
              <span className="dshHk-label">stderr 摘要上限（可选）</span>
              <input className="dshHk-input" value={draft.stderrSummaryMaxChars} placeholder="500" disabled={busy} onChange={(e) => { setDraft({ ...draft, stderrSummaryMaxChars: e.target.value }) }} />
            </div>
          </div>
          <div className="dshHk-formActions">
            <button type="submit" className="dshHk-button dshHk-buttonPrimary" disabled={busy}>{busy ? '保存中…' : draft.id === null ? '添加并挂载' : '保存并重新挂载'}</button>
            <button type="button" className="dshHk-button" disabled={busy} onClick={() => { setDraft(null); setError(undefined) }}>取消</button>
          </div>
        </form>
      ) : (
        <div className="dshHk-toolbar">
          <span className="dshHk-count">{data === null ? '' : `共 ${String(data.bridges.length)} 个配置`}</span>
          <button type="button" className="dshHk-button dshHk-buttonPrimary" disabled={busy || (data !== null && !data.enabled)} onClick={() => { setDraft(emptyDraft()); setError(undefined) }}>添加 Hook 配置</button>
        </div>
      )}

      <div className="dshHk-list">
        {sorted.length === 0 && draft === null ? <div className="dshHk-empty">还没有配置 Hook。可以导入已有的 hooks.json，或直接手动编写。</div> : null}
        {sorted.map((view) => {
          const badge = STATUS_BADGE[view.status.state] ?? STATUS_BADGE.disabled
          return (
            <div key={view.id} className="dshHk-card">
              <div className="dshHk-cardHead">
                <span className="dshHk-dialect">{view.dialect === 'native' ? 'DSH 原生' : view.dialect}</span>
                <span className="dshHk-badge">{view.configSource === 'inline' ? '在线编写' : '文件'}</span>
                <span className={badge.className}>{badge.label}</span>
              </div>
              {view.status.message !== undefined ? <div className="dshHk-warning">{view.status.message}</div> : null}
              <div className="dshHk-meta">{view.configPath}</div>
              <div className="dshHk-cardActions">
                <button type="button" className="dshHk-toggle" role="switch" aria-checked={view.enabled} aria-label="启用/停用" disabled={busy} onClick={() => { void onToggle(view) }} />
                <button type="button" className="dshHk-button" disabled={busy} onClick={() => { setDraft(draftFromView(view)) }}>编辑</button>
                <button type="button" className="dshHk-button dshHk-buttonDanger" disabled={busy} onClick={() => { setConfirmTarget(view) }}>删除</button>
              </div>
            </div>
          )
        })}
      </div>
      {data !== null ? <p className="dshHk-path" title={data.filePath}>配置文件：{data.filePath}</p> : null}
      <ConfirmDialog
        open={confirmTarget !== null}
        title="删除 Hook 配置"
        message="该配置将停止运行，配置文件中的条目一并删除。"
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => { if (confirmTarget !== null) void onDelete(confirmTarget) }}
        onClose={() => { setConfirmTarget(null) }}
      />
    </div>
  )
}
