/**
 * The MCP settings section: server cards with live mount status, an add/edit
 * dialog with a FORM/JSON toggle (VS Code MCP editor style — the JSON side
 * speaks the standard mcpServers shape), and a bulk JSON import over the
 * host's /server/import route. Saves apply to the running process inline, so
 * a save is always also the deployment.
 *
 * Secret hygiene: literal env/header values come back from the host masked
 * (••••••); a form or JSON view that leaves the mask untouched sends it back
 * and the host keeps the stored value. `$ENV:NAME` references are verbatim.
 *
 * @module @dsh-app/plugin-mcp/client/mcp-section
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { entryToExternal, mapExternalServer, parseMcpServersJson, McpValidationError } from '../wire.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'

const ROUTE = '/plugins/@dsh-app/plugin-mcp/api'

/** The host route's payload (mirror of McpServersResponse). */
interface ServerView {
  readonly id: string
  readonly serverName: string
  readonly transport: string
  readonly enabled: boolean
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly status: { readonly state: string, readonly message?: string, readonly toolCount?: number }
}

interface ServersResponse {
  readonly enabled: boolean
  readonly filePath: string
  readonly mountAvailable: boolean
  readonly servers: readonly ServerView[]
  readonly imported?: readonly string[]
  readonly renamed?: ReadonlyArray<{ readonly from: string, readonly to: string }>
  readonly failed?: ReadonlyArray<{ readonly name: string, readonly reason: string }>
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/** Editable form state; every field is a string (textareas included). */
interface Draft {
  id: string | null
  serverName: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  command: string
  argsText: string
  envText: string
  cwd: string
  url: string
  headersText: string
  toolCallTimeoutMs: string
}

function emptyDraft(): Draft {
  return {
    id: null,
    serverName: '',
    transport: 'stdio',
    enabled: true,
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    url: '',
    headersText: '',
    toolCallTimeoutMs: '',
  }
}

function draftFromView(view: ServerView): Draft {
  return {
    id: view.id,
    serverName: view.serverName,
    transport: view.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    enabled: view.enabled,
    command: view.command ?? '',
    argsText: (view.args ?? []).join('\n'),
    envText: Object.entries(view.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    cwd: view.cwd ?? '',
    url: view.url ?? '',
    headersText: Object.entries(view.headers ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    toolCallTimeoutMs: view.toolCallTimeoutMs === undefined ? '' : String(view.toolCallTimeoutMs),
  }
}

/** `KEY=VALUE` per line → record; a line without `=` is an error. */
function parseKeyValue(text: string): { ok: true, value: Record<string, string> } | { ok: false, reason: string } {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return { ok: false, reason: `键值对格式不正确：「${trimmed}」（应为 KEY=VALUE）` }
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return { ok: true, value: out }
}

/** Serialize the current form state into the external mcpServers fragment.
 * An untouched new draft (no name yet) serializes to '' — the textarea then
 * shows its placeholder example instead of a nonsense `"": {...}` fragment. */
function draftToExternal(draft: Draft): string {
  if (draft.id === null && draft.serverName.trim() === '') return ''
  const args = draft.argsText.split('\n').map(line => line.trim()).filter(line => line !== '')
  const env = parseKeyValue(draft.envText)
  const headers = parseKeyValue(draft.headersText)
  const timeout = Number(draft.toolCallTimeoutMs)
  return JSON.stringify(entryToExternal({
    serverName: draft.serverName,
    transport: draft.transport,
    ...(draft.transport === 'stdio'
      ? { command: draft.command.trim(), ...(args.length > 0 ? { args } : {}), ...(env.ok ? { env: env.value } : {}), ...(draft.cwd.trim() !== '' ? { cwd: draft.cwd.trim() } : {}) }
      : { url: draft.url.trim(), ...(headers.ok ? { headers: headers.value } : {}) }),
    ...(draft.toolCallTimeoutMs.trim() !== '' && Number.isFinite(timeout) && timeout > 0 ? { toolCallTimeoutMs: timeout } : {}),
  }), null, 2)
}

/**
 * Parse the JSON editor's text into an updated draft. Accepts a bare
 * `{"name": {...}}` fragment (the editor's own serialization) or a wrapped
 * `{"mcpServers": {...}}` paste — the latter only when it holds exactly one
 * server, because the edit dialog is one server's editor (use 导入 JSON for
 * bulk). Throws Error with a zh-CN reason.
 */
function draftFromJson(text: string, previous: Draft): Draft {
  const parsed = parseMcpServersJson(text)
  if (parsed.length !== 1) {
    throw new Error(`编辑模式只对应一个服务器（当前 JSON 含 ${String(parsed.length)} 个）；批量配置请用列表页的「导入 JSON」`)
  }
  const { name, def } = parsed[0]
  const raw = mapExternalServer(name, def) as Record<string, unknown>
  const env = (raw.env as Record<string, string> | undefined) ?? {}
  const headers = (raw.headers as Record<string, string> | undefined) ?? {}
  return {
    ...previous,
    serverName: String(raw.serverName),
    transport: raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    argsText: Array.isArray(raw.args) ? (raw.args as string[]).join('\n') : '',
    envText: Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    headersText: Object.entries(headers).map(([key, value]) => `${key}=${value}`).join('\n'),
    toolCallTimeoutMs: raw.toolCallTimeoutMs === undefined ? '' : String(raw.toolCallTimeoutMs),
  }
}

/** One structured save body from either editor view. */
function bodyFromDraft(draft: Draft): Record<string, unknown> {
  const name = draft.serverName.trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new McpValidationError('serverName 只能包含字母、数字、下划线和连字符（1–32 位）')
  }
  const body: Record<string, unknown> = {
    serverName: name,
    transport: draft.transport,
    // Preserve the entry's own enabled state: saving an edit to a disabled
    // server must not implicitly re-enable and mount it.
    enabled: draft.id === null ? true : draft.enabled,
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') {
      throw new McpValidationError('stdio 服务器必须填写启动命令（command）')
    }
    body.command = draft.command.trim()
    const args = draft.argsText.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (args.length > 0) body.args = args
    if (draft.envText.trim() !== '') {
      const env = parseKeyValue(draft.envText)
      if (!env.ok) throw new McpValidationError(env.reason)
      body.env = env.value
    }
    if (draft.cwd.trim() !== '') body.cwd = draft.cwd.trim()
  } else {
    const url = draft.url.trim()
    if (!/^https?:\/\//.test(url)) {
      throw new McpValidationError('streamable-http 服务器必须填写合法的 http(s) URL')
    }
    body.url = url
    if (draft.headersText.trim() !== '') {
      const headers = parseKeyValue(draft.headersText)
      if (!headers.ok) throw new McpValidationError(headers.reason)
      body.headers = headers.value
    }
  }
  if (draft.toolCallTimeoutMs.trim() !== '') {
    const timeout = Number(draft.toolCallTimeoutMs)
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new McpValidationError('工具调用超时必须是正数（毫秒）')
    }
    body.toolCallTimeoutMs = timeout
  }
  return body
}

const STATUS_BADGE: Record<string, { label: string, className: string }> = {
  mounted: { label: '已挂载', className: 'dshMcp-badge dshMcp-badgeOn' },
  starting: { label: '挂载中', className: 'dshMcp-badge' },
  disabled: { label: '已停用', className: 'dshMcp-badge dshMcp-badgeOff' },
  error: { label: '挂载失败', className: 'dshMcp-badge dshMcp-badgeErr' },
  unavailable: { label: '内核不支持', className: 'dshMcp-badge dshMcp-badgeErr' },
}

export function McpSection(): ReactNode {
  const [data, setData] = useState<ServersResponse | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editView, setEditView] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReport, setImportReport] = useState<{ imported: readonly string[], renamed: ReadonlyArray<{ from: string, to: string }>, failed: ReadonlyArray<{ name: string, reason: string }> } | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ServerView | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const value = await fetchJson<ServersResponse>(`${ROUTE}/servers`)
      setData(value)
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Success notices are transient: auto-clear shortly after they appear, so
  // the user isn't left with a stale toast until the next navigation. Errors
  // stay until the next action (they carry actionable context worth reading).
  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { setNotice(undefined) }, 5_000)
    return () => { clearTimeout(timer) }
  }, [notice])

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    setBusy(true)
    setNotice(undefined)
    try {
      const value = await fetchJson<ServersResponse>(`${ROUTE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setData(value)
      return value
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      throw failure
    } finally {
      setBusy(false)
    }
  }, [])

  const openEdit = useCallback((view: ServerView) => {
    const next = draftFromView(view)
    setDraft(next)
    setEditView('form')
    setJsonText(draftToExternal(next))
  }, [])

  /** JSON → form: only switches when the JSON parses into one server. An
   * empty editor (untouched new draft) switches freely — nothing to parse. */
  const switchToForm = useCallback(() => {
    if (jsonText.trim() === '') {
      setEditView('form')
      setError(undefined)
      return
    }
    try {
      if (draft !== null) setDraft(draftFromJson(jsonText, draft))
      setEditView('form')
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [draft, jsonText])

  const onSave = useCallback(async () => {
    if (draft === null) return
    let body: Record<string, unknown>
    try {
      body = editView === 'json'
        ? (() => {
            const next = draftFromJson(jsonText, draft)
            return bodyFromDraft(next)
          })()
        : bodyFromDraft(draft)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return
    }
    try {
      await post(draft.id === null ? 'server/create' : 'server/update', draft.id === null ? body : { ...body, id: draft.id })
      setDraft(null)
      setNotice(draft.id === null ? '已添加并挂载，工具对当前及新会话即时可用' : '已保存并重新挂载')
    } catch {
      // post() already surfaced the error banner.
    }
  }, [draft, editView, jsonText, post])

  const onImport = useCallback(async () => {
    try {
      const value = await post('server/import', { json: importText })
      const report = { imported: value.imported ?? [], renamed: value.renamed ?? [], failed: value.failed ?? [] }
      setImportReport(report)
      if (report.failed.length === 0) {
        setImportOpen(false)
        setImportText('')
        const renamedNote = report.renamed.length > 0
          ? `（已自动改名：${report.renamed.map(entry => `${entry.from} → ${entry.to}`).join('、')}）`
          : ''
        setNotice(`已导入 ${String(report.imported.length)} 个服务器并挂载${renamedNote}`)
      }
    } catch {
      // post() already surfaced the error banner.
    }
  }, [importText, post])

  const onToggle = useCallback(async (view: ServerView) => {
    try {
      await post('server/update', { ...view, enabled: !view.enabled })
      setNotice(!view.enabled ? `已启用 ${view.serverName}` : `已停用 ${view.serverName}`)
    } catch {
      // post() already surfaced the error banner.
    }
  }, [post])

  const onDelete = useCallback(async (view: ServerView) => {
    try {
      await post('server/delete', { id: view.id })
      if (draft?.id === view.id) setDraft(null)
      setConfirmTarget(null)
      setNotice(`已删除 ${view.serverName}`)
    } catch {
      // post() already surfaced the error banner.
    }
  }, [draft, post])

  const sortedServers = useMemo(() => {
    if (data === null) return []
    return [...data.servers].sort((a, b) => a.serverName.localeCompare(b.serverName))
  }, [data])

  const jsonInvalid = editView === 'json' && error !== undefined

  return (
    <div className="dshMcp-section">
      <p className="dshMcp-title">MCP 服务器</p>
      <p className="dshMcp-hint">
        把外部 MCP 服务器接入模型：每个服务器的工具会以 mcp__服务器名__工具名 的形式原生出现。
        stdio 服务器将在本机启动对应命令进程，请确认命令来源可信。保存后立即挂载，无需重启。
        支持粘贴标准 mcpServers JSON（Claude / Cursor / VS Code 配置同款形状）。注意：工具定义会占用每轮对话的上下文，按需启用。
      </p>

      {error !== undefined ? <div className="dshMcp-banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshMcp-noticeOk">{notice}</div> : null}
      {data !== null && !data.mountAvailable
        ? <div className="dshMcp-warning">当前内核不支持 MCP 动态挂载：配置可以保存，但服务器不会挂载、工具不可用。</div>
        : null}

      {draft !== null
        ? (
          <form className="dshMcp-form" onSubmit={(event) => { event.preventDefault(); void onSave() }}>
            <div className="dshMcp-formHead">
              <p className="dshMcp-formTitle">{draft.id === null ? '添加 MCP 服务器' : `编辑 ${draft.serverName}`}</p>
              <div className="dshMcp-viewToggle" role="tablist" aria-label="编辑视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={editView === 'form'}
                  className={editView === 'form' ? 'dshMcp-viewBtn dshMcp-viewBtnOn' : 'dshMcp-viewBtn'}
                  disabled={busy || editView === 'form'}
                  onClick={switchToForm}
                >表单</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editView === 'json'}
                  className={editView === 'json' ? 'dshMcp-viewBtn dshMcp-viewBtnOn' : 'dshMcp-viewBtn'}
                  disabled={busy || editView === 'json'}
                  onClick={() => { setJsonText(draftToExternal(draft)); setEditView('json'); setError(undefined) }}
                >JSON</button>
              </div>
            </div>

            {editView === 'json'
              ? (
                <div className="dshMcp-field">
                  <span className="dshMcp-label">完整配置</span>
                  <textarea
                    className="dshMcp-textarea dshMcp-jsonArea"
                    value={jsonText}
                    spellCheck={false}
                    placeholder={'{\n  "figma": {\n    "type": "stdio",\n    "command": "npx",\n    "args": ["-y", "figma-developer-mcp"]\n  }\n}'}
                    disabled={busy}
                    aria-label="MCP 服务器 JSON 配置"
                    onChange={(event) => { setJsonText(event.target.value) }}
                  />
                  <span className="dshMcp-fieldHint">
                    支持直接粘贴 {'{"server-name": {...}}'} 或 {'{"mcpServers": {"server-name": {...}}}'}；编辑模式只对应一个服务器，批量请用「导入 JSON」。
                    {jsonInvalid ? '当前内容解析失败，修正后可保存或切回表单。' : ''}
                  </span>
                </div>
              )
              : (
                <>
                  <div className="dshMcp-row">
                    <div className="dshMcp-field dshMcp-fieldGrow">
                      <span className="dshMcp-label">serverName（工具命名空间）</span>
                      <input
                        className="dshMcp-input"
                        value={draft.serverName}
                        placeholder="例如 github"
                        disabled={busy}
                        aria-label="serverName"
                        onChange={(event) => { setDraft({ ...draft, serverName: event.target.value }) }}
                      />
                      <span className="dshMcp-fieldHint">1–32 位字母/数字/下划线/连字符，工具名形如 mcp__服务器名__工具名</span>
                    </div>
                    <div className="dshMcp-field">
                      <span className="dshMcp-label">传输方式</span>
                      <div className="dshMcp-radioGroup" role="radiogroup" aria-label="传输方式">
                        <label>
                          <input
                            type="radio"
                            name="dshMcpTransport"
                            checked={draft.transport === 'stdio'}
                            disabled={busy}
                            onChange={() => { setDraft({ ...draft, transport: 'stdio' }) }}
                          />
                          stdio（本机进程）
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="dshMcpTransport"
                            checked={draft.transport === 'streamable-http'}
                            disabled={busy}
                            onChange={() => { setDraft({ ...draft, transport: 'streamable-http' }) }}
                          />
                          Streamable HTTP
                        </label>
                      </div>
                    </div>
                  </div>

                  {draft.transport === 'stdio'
                    ? (
                      <>
                        <div className="dshMcp-row">
                          <div className="dshMcp-field dshMcp-fieldGrow">
                            <span className="dshMcp-label">启动命令</span>
                            <input
                              className="dshMcp-input"
                              value={draft.command}
                              placeholder="例如 npx"
                              disabled={busy}
                              aria-label="启动命令"
                              onChange={(event) => { setDraft({ ...draft, command: event.target.value }) }}
                            />
                          </div>
                          <div className="dshMcp-field">
                            <span className="dshMcp-label">工作目录（可选）</span>
                            <input
                              className="dshMcp-input"
                              value={draft.cwd}
                              disabled={busy}
                              aria-label="工作目录"
                              onChange={(event) => { setDraft({ ...draft, cwd: event.target.value }) }}
                            />
                          </div>
                        </div>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">参数（每行一个）</span>
                          <textarea
                            className="dshMcp-textarea"
                            value={draft.argsText}
                            placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:/workspace'}
                            disabled={busy}
                            aria-label="启动参数"
                            onChange={(event) => { setDraft({ ...draft, argsText: event.target.value }) }}
                          />
                        </div>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">环境变量（每行 KEY=VALUE；值可写 $ENV:变量名 引用环境变量）</span>
                          <textarea
                            className="dshMcp-textarea"
                            value={draft.envText}
                            placeholder={'GITHUB_TOKEN=$ENV:GITHUB_TOKEN'}
                            disabled={busy}
                            aria-label="环境变量"
                            onChange={(event) => { setDraft({ ...draft, envText: event.target.value }) }}
                          />
                        </div>
                      </>
                    )
                    : (
                      <>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">服务地址</span>
                          <input
                            className="dshMcp-input"
                            value={draft.url}
                            placeholder="http://127.0.0.1:3000/mcp"
                            disabled={busy}
                            aria-label="服务地址"
                            onChange={(event) => { setDraft({ ...draft, url: event.target.value }) }}
                          />
                        </div>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">请求头（每行 KEY=VALUE；值可写 $ENV:变量名 引用环境变量）</span>
                          <textarea
                            className="dshMcp-textarea"
                            value={draft.headersText}
                            placeholder={'Authorization=$ENV:MCP_TOKEN'}
                            disabled={busy}
                            aria-label="请求头"
                            onChange={(event) => { setDraft({ ...draft, headersText: event.target.value }) }}
                          />
                        </div>
                      </>
                    )}

                  <div className="dshMcp-row">
                    <div className="dshMcp-field">
                      <span className="dshMcp-label">工具调用超时 ms（可选，默认 60000）</span>
                      <input
                        className="dshMcp-input"
                        value={draft.toolCallTimeoutMs}
                        disabled={busy}
                        aria-label="工具调用超时"
                        onChange={(event) => { setDraft({ ...draft, toolCallTimeoutMs: event.target.value }) }}
                      />
                    </div>
                  </div>
                </>
              )}

            <div className="dshMcp-formActions">
              <button type="submit" className="dshMcp-button dshMcp-buttonPrimary" disabled={busy}>
                {busy ? '保存中…' : draft.id === null ? '添加并挂载' : '保存并重新挂载'}
              </button>
              <button type="button" className="dshMcp-button" disabled={busy} onClick={() => { setDraft(null); setError(undefined) }}>取消</button>
            </div>
          </form>
        )
        : (
          <div className="dshMcp-toolbar">
            <span className="dshMcp-count">{data === null ? '' : `共 ${String(data.servers.length)} 个服务器`}</span>
            <div className="dshMcp-toolbarActions">
              <button
                type="button"
                className="dshMcp-button"
                disabled={busy || (data !== null && !data.enabled)}
                onClick={() => { setImportOpen(true); setImportReport(null); setError(undefined) }}
              >导入 JSON</button>
              <button
                type="button"
                className="dshMcp-button dshMcp-buttonPrimary"
                disabled={busy || (data !== null && !data.enabled)}
                onClick={() => { setDraft(emptyDraft()); setEditView('form'); setError(undefined) }}
              >添加服务器</button>
            </div>
          </div>
        )}

      {importOpen
        ? (
          <form className="dshMcp-form" onSubmit={(event) => { event.preventDefault(); void onImport() }}>
            <p className="dshMcp-formTitle">从 JSON 导入</p>
            <div className="dshMcp-field">
              <span className="dshMcp-label">mcpServers 配置</span>
              <textarea
                className="dshMcp-textarea dshMcp-jsonArea"
                value={importText}
                spellCheck={false}
                disabled={busy}
                placeholder={'{\n  "mcpServers": {\n    "context7": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "@upstash/context7-mcp"]\n    },\n    "exa": { "type": "http", "url": "https://mcp.exa.ai/mcp" }\n  }\n}'}
                aria-label="mcpServers JSON"
                onChange={(event) => { setImportText(event.target.value) }}
              />
              <span className="dshMcp-fieldHint">
                支持粘贴 {'{"server-name": {...}}'} 或带 {"mcpServers"} 包装的完整配置（Claude / Cursor / VS Code 同款形状）。逐条导入，失败的条目不影响其余。
              </span>
            </div>
            {importReport !== null
              ? (
                <div className="dshMcp-importReport">
                  {importReport.imported.length > 0
                    ? <div className="dshMcp-noticeOk">已导入：{importReport.imported.join('、')}</div>
                    : null}
                  {importReport.renamed.map(entry => (
                    <div key={entry.to} className="dshMcp-warning">
                      已自动改名：{entry.from} → {entry.to}（服务器名会成为工具命名空间 mcp__名称__工具名，不能含空格等字符）
                    </div>
                  ))}
                  {importReport.failed.map(entry => (
                    <div key={entry.name} className="dshMcp-banner">{entry.name}：{entry.reason}</div>
                  ))}
                </div>
              )
              : null}
            <div className="dshMcp-formActions">
              <button type="submit" className="dshMcp-button dshMcp-buttonPrimary" disabled={busy || importText.trim() === ''}>
                {busy ? '导入中…' : '导入并挂载'}
              </button>
              <button type="button" className="dshMcp-button" disabled={busy} onClick={() => { setImportOpen(false); setImportReport(null) }}>关闭</button>
            </div>
          </form>
        )
        : null}

      {data !== null && !data.enabled
        ? <div className="dshMcp-warning">MCP 管理已整体停用（配置文件 enabled: false）：列表只读，如需启用请编辑配置文件后重启。</div>
        : null}

      <div className="dshMcp-list">
        {sortedServers.length === 0 && draft === null && !importOpen
          ? <div className="dshMcp-empty">还没有配置 MCP 服务器。添加一个（如 filesystem、github），或直接粘贴已有的 mcpServers JSON 导入。</div>
          : null}
        {sortedServers.map((view) => {
          const badge = STATUS_BADGE[view.status.state] ?? STATUS_BADGE.disabled
          const meta = view.transport === 'stdio'
            ? `${view.command ?? ''} ${(view.args ?? []).join(' ')}`
            : view.url ?? ''
          return (
            <div key={view.id} className="dshMcp-card">
              <div className="dshMcp-cardHead">
                <span className="dshMcp-serverName">{view.serverName}</span>
                <span className="dshMcp-badge">{view.transport === 'stdio' ? 'stdio' : 'http'}</span>
                <span className={badge.className}>
                  {badge.label}{view.status.state === 'mounted' && view.status.toolCount !== undefined ? ` · ${String(view.status.toolCount)} 个工具` : ''}
                </span>
              </div>
              {view.status.message !== undefined ? <div className="dshMcp-warning">{view.status.message}</div> : null}
              <div className="dshMcp-meta">{meta}</div>
              <div className="dshMcp-cardActions">
                <button
                  type="button"
                  className="dshMcp-toggle"
                  role="switch"
                  aria-checked={view.enabled}
                  aria-label={`启用 ${view.serverName}`}
                  disabled={busy}
                  onClick={() => { void onToggle(view) }}
                />
                <button type="button" className="dshMcp-button" disabled={busy} onClick={() => { openEdit(view) }}>编辑</button>
                <button type="button" className="dshMcp-button dshMcp-buttonDanger" disabled={busy} onClick={() => { setConfirmTarget(view) }}>删除</button>
              </div>
            </div>
          )
        })}
      </div>

      {data !== null ? <p className="dshMcp-path" title={data.filePath}>配置文件：{data.filePath}</p> : null}

      <ConfirmDialog
        open={confirmTarget !== null}
        title={`删除 MCP 服务器「${confirmTarget?.serverName ?? ''}」`}
        message="该服务器注册的工具将立即从模型侧移除，配置文件中的条目一并删除。"
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => { if (confirmTarget !== null) void onDelete(confirmTarget) }}
        onClose={() => { setConfirmTarget(null) }}
      />
    </div>
  )
}
