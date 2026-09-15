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
 * Every string this page renders comes from the `dsh-app.mcp` namespace
 * through the `t` standard seat: the section registers with `locale: NS`, so
 * the renderer hands the component a namespace-bound translate that reads the
 * active UI locale at call time and re-renders on a language switch. Text the
 * HOST wrote (route rejections, mount messages, per-server import reasons)
 * arrives as a code plus its params and renders through the same dictionary —
 * {@link hostMessage} is the one place that decides how.
 *
 * @module @dsh-app/plugin-mcp/client/mcp-section
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { entryToExternal, mapExternalServer, parseMcpServersJson } from '../wire.ts'
import type { HostText } from '../wire.ts'
import { failureOf, failureText, fetchJson, hostListText, hostMessage, PageError } from './api.ts'
import type { Failure } from './api.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { NS, type McpKey } from './locales.ts'

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
  readonly status: { readonly state: string, readonly message?: HostText, readonly warnings?: readonly HostText[], readonly toolCount?: number }
}

interface ServersResponse {
  readonly enabled: boolean
  readonly filePath: string
  readonly mountAvailable: boolean
  readonly servers: readonly ServerView[]
  readonly imported?: readonly string[]
  readonly renamed?: ReadonlyArray<{ readonly from: string, readonly to: string }>
  readonly failed?: ReadonlyArray<{ readonly name: string, readonly reason: HostText }>
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

/** One rename the host applied while importing (name → valid serverName). */
interface RenameRow {
  readonly from: string
  readonly to: string
}

/** One server the host refused while importing, with its coded reason. */
interface FailedRow {
  readonly name: string
  readonly reason: HostText
}

/**
 * The transient success notice, kept as DATA rather than a rendered sentence:
 * the banner resolves it through `t` on every render, so a language switch
 * rewrites the note that is still on screen.
 */
type Notice =
  | { readonly kind: 'created' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'imported'; readonly count: number; readonly renamed: readonly RenameRow[] }
  | { readonly kind: 'enabled'; readonly name: string }
  | { readonly kind: 'disabled'; readonly name: string }
  | { readonly kind: 'deleted'; readonly name: string }

/** What the import form reports back once the host answered. */
interface ImportReport {
  readonly imported: readonly string[]
  readonly renamed: readonly RenameRow[]
  readonly failed: readonly FailedRow[]
}

/**
 * Render one success notice in the active locale.
 * @param notice - the notice this page set.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
function noticeText(notice: Notice, t: TranslateNS<typeof NS>): string {
  switch (notice.kind) {
    case 'created':
      return t('mcp.notice.created')
    case 'saved':
      return t('mcp.notice.saved')
    case 'enabled':
      return t('mcp.notice.enabled', { name: notice.name })
    case 'disabled':
      return t('mcp.notice.disabled', { name: notice.name })
    case 'deleted':
      return t('mcp.notice.deleted', { name: notice.name })
    case 'imported': {
      // The rename list is a sentence of its own, and its separator is part of
      // the language (、 / ,): both stay keys so neither is baked in here.
      const renamed = notice.renamed.length === 0 ? '' : t('mcp.notice.importRenamed', {
        names: notice.renamed
          .map(entry => `${entry.from} → ${entry.to}`)
          .join(t('mcp.listSeparator')),
      })
      return t('mcp.notice.imported', { count: notice.count, renamed })
    }
  }
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

/**
 * `KEY=VALUE` per line → record; a line without `=` is an error the banner
 * explains in the active locale.
 */
function parseKeyValue(text: string): { ok: true, value: Record<string, string> } | { ok: false, failure: Failure } {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      return {
        ok: false,
        failure: { source: 'key', key: 'mcp.error.keyValue', params: { line: trimmed } },
      }
    }
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
 * bulk). Throws {@link PageError} for the one-server gate (this page's own
 * sentence, a dictionary key); the wire parser's rejections are coded and
 * classified by {@link failureOf}.
 */
function draftFromJson(text: string, previous: Draft): Draft {
  const parsed = parseMcpServersJson(text)
  if (parsed.length !== 1) {
    throw new PageError({
      source: 'key',
      key: 'mcp.error.jsonSingle',
      params: { count: parsed.length },
    })
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
  // Empty-only gate: the serverName shape is validated server-side
  // (validateEntry → 400 with a zh-CN reason); the client never duplicates it.
  if (name === '') {
    throw new PageError({ source: 'key', key: 'mcp.error.serverNameRequired' })
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
      throw new PageError({ source: 'key', key: 'mcp.error.commandRequired' })
    }
    body.command = draft.command.trim()
    const args = draft.argsText.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (args.length > 0) body.args = args
    if (draft.envText.trim() !== '') {
      const env = parseKeyValue(draft.envText)
      if (!env.ok) throw new PageError(env.failure)
      body.env = env.value
    }
    if (draft.cwd.trim() !== '') body.cwd = draft.cwd.trim()
  } else {
    const url = draft.url.trim()
    // Empty-only gate: URL legality is validated server-side (validateEntry →
    // 400); an empty value is rejected here so a blank form never posts.
    if (url === '') {
      throw new PageError({ source: 'key', key: 'mcp.error.urlRequired' })
    }
    body.url = url
    if (draft.headersText.trim() !== '') {
      const headers = parseKeyValue(draft.headersText)
      if (!headers.ok) throw new PageError(headers.failure)
      body.headers = headers.value
    }
  }
  if (draft.toolCallTimeoutMs.trim() !== '') {
    // Empty-only gate: positivity is enforced server-side (validateEntry →
    // 400); a non-numeric entry serializes to null and is rejected there.
    body.toolCallTimeoutMs = Number(draft.toolCallTimeoutMs)
  }
  return body
}

/** Mount state → its badge copy. Class names stay literal (styling, not copy). */
const STATUS_BADGE: Record<string, { key: McpKey, className: string }> = {
  mounted: { key: 'mcp.status.mounted', className: 'dshMcp-badge dshMcp-badgeOn' },
  starting: { key: 'mcp.status.starting', className: 'dshMcp-badge' },
  disabled: { key: 'mcp.status.disabled', className: 'dshMcp-badge dshMcp-badgeOff' },
  error: { key: 'mcp.status.error', className: 'dshMcp-badge dshMcp-badgeErr' },
  unavailable: { key: 'mcp.status.unavailable', className: 'dshMcp-badge dshMcp-badgeErr' },
}

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type McpSectionProps = PropsLocale<typeof NS>

/**
 * Render the MCP settings section.
 * @param props - the framework-supplied `t` seat of this page's namespace.
 * @returns the section page; it owns its data, so no inject face is needed.
 */
export function McpSection({ t }: McpSectionProps): ReactNode {
  const [data, setData] = useState<ServersResponse | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editView, setEditView] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ServerView | null>(null)
  const [error, setError] = useState<Failure | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const value = await fetchJson<ServersResponse>('/servers')
      setData(value)
      setError(undefined)
    } catch (failure) {
      setError(failureOf(failure))
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
      const value = await fetchJson<ServersResponse>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setData(value)
      return value
    } catch (failure) {
      setError(failureOf(failure))
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
      setError(failureOf(failure))
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
      setError(failureOf(failure))
      return
    }
    try {
      await post(draft.id === null ? '/server/create' : '/server/update', draft.id === null ? body : { ...body, id: draft.id })
      setDraft(null)
      setNotice(draft.id === null ? { kind: 'created' } : { kind: 'saved' })
    } catch {
      // post() already surfaced the error banner.
    }
  }, [draft, editView, jsonText, post])

  const onImport = useCallback(async () => {
    try {
      const value = await post('/server/import', { json: importText })
      const report: ImportReport = {
        imported: value.imported ?? [],
        renamed: value.renamed ?? [],
        failed: value.failed ?? [],
      }
      setImportReport(report)
      if (report.failed.length === 0) {
        setImportOpen(false)
        setImportText('')
        setNotice({ kind: 'imported', count: report.imported.length, renamed: report.renamed })
      }
    } catch {
      // post() already surfaced the error banner.
    }
  }, [importText, post])

  const onToggle = useCallback(async (view: ServerView) => {
    try {
      await post('/server/update', { ...view, enabled: !view.enabled })
      setNotice(!view.enabled ? { kind: 'enabled', name: view.serverName } : { kind: 'disabled', name: view.serverName })
    } catch {
      // post() already surfaced the error banner.
    }
  }, [post])

  const onDelete = useCallback(async (view: ServerView) => {
    try {
      await post('/server/delete', { id: view.id })
      if (draft?.id === view.id) setDraft(null)
      setConfirmTarget(null)
      setNotice({ kind: 'deleted', name: view.serverName })
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
      <p className="dshMcp-title">{t('mcp.nav')}</p>
      <p className="dshMcp-hint">{t('mcp.intro')}</p>

      {error !== undefined ? <div className="dshMcp-banner" role="alert">{failureText(error, t)}</div> : null}
      {notice !== undefined ? <div className="dshMcp-noticeOk">{noticeText(notice, t)}</div> : null}
      {data !== null && !data.mountAvailable
        ? <div className="dshMcp-warning">{t('mcp.mountUnavailable')}</div>
        : null}

      {draft !== null
        ? (
          <form className="dshMcp-form" onSubmit={(event) => { event.preventDefault(); void onSave() }}>
            <div className="dshMcp-formHead">
              <p className="dshMcp-formTitle">
                {draft.id === null ? t('mcp.form.createTitle') : t('mcp.form.editTitle', { name: draft.serverName })}
              </p>
              <div className="dshMcp-viewToggle" role="tablist" aria-label={t('mcp.form.viewAria')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editView === 'form'}
                  className={editView === 'form' ? 'dshMcp-viewBtn dshMcp-viewBtnOn' : 'dshMcp-viewBtn'}
                  disabled={busy || editView === 'form'}
                  onClick={switchToForm}
                >{t('mcp.form.viewForm')}</button>
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
                  <span className="dshMcp-label">{t('mcp.json.label')}</span>
                  <textarea
                    className="dshMcp-textarea dshMcp-jsonArea"
                    value={jsonText}
                    spellCheck={false}
                    placeholder={'{\n  "figma": {\n    "type": "stdio",\n    "command": "npx",\n    "args": ["-y", "figma-developer-mcp"]\n  }\n}'}
                    disabled={busy}
                    aria-label={t('mcp.json.aria')}
                    onChange={(event) => { setJsonText(event.target.value) }}
                  />
                  <span className="dshMcp-fieldHint">
                    {t('mcp.json.hint')}
                    {jsonInvalid ? t('mcp.json.invalid') : ''}
                  </span>
                </div>
              )
              : (
                <>
                  <div className="dshMcp-row">
                    <div className="dshMcp-field dshMcp-fieldGrow">
                      <span className="dshMcp-label">{t('mcp.field.serverName')}</span>
                      <input
                        className="dshMcp-input"
                        value={draft.serverName}
                        placeholder={t('mcp.field.serverNamePlaceholder')}
                        disabled={busy}
                        aria-label={t('mcp.field.serverNameAria')}
                        onChange={(event) => { setDraft({ ...draft, serverName: event.target.value }) }}
                      />
                      <span className="dshMcp-fieldHint">{t('mcp.field.serverNameHint')}</span>
                    </div>
                    <div className="dshMcp-field">
                      <span className="dshMcp-label">{t('mcp.field.transport')}</span>
                      <div className="dshMcp-radioGroup" role="radiogroup" aria-label={t('mcp.field.transport')}>
                        <label>
                          <input
                            type="radio"
                            name="dshMcpTransport"
                            checked={draft.transport === 'stdio'}
                            disabled={busy}
                            onChange={() => { setDraft({ ...draft, transport: 'stdio' }) }}
                          />
                          {t('mcp.field.transportStdio')}
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="dshMcpTransport"
                            checked={draft.transport === 'streamable-http'}
                            disabled={busy}
                            onChange={() => { setDraft({ ...draft, transport: 'streamable-http' }) }}
                          />
                          {t('mcp.field.transportHttp')}
                        </label>
                      </div>
                    </div>
                  </div>

                  {draft.transport === 'stdio'
                    ? (
                      <>
                        <div className="dshMcp-row">
                          <div className="dshMcp-field dshMcp-fieldGrow">
                            <span className="dshMcp-label">{t('mcp.field.command')}</span>
                            <input
                              className="dshMcp-input"
                              value={draft.command}
                              placeholder={t('mcp.field.commandPlaceholder')}
                              disabled={busy}
                              aria-label={t('mcp.field.command')}
                              onChange={(event) => { setDraft({ ...draft, command: event.target.value }) }}
                            />
                          </div>
                          <div className="dshMcp-field">
                            <span className="dshMcp-label">{t('mcp.field.cwd')}</span>
                            <input
                              className="dshMcp-input"
                              value={draft.cwd}
                              disabled={busy}
                              aria-label={t('mcp.field.cwdAria')}
                              onChange={(event) => { setDraft({ ...draft, cwd: event.target.value }) }}
                            />
                          </div>
                        </div>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">{t('mcp.field.args')}</span>
                          <textarea
                            className="dshMcp-textarea"
                            value={draft.argsText}
                            placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:/workspace'}
                            disabled={busy}
                            aria-label={t('mcp.field.argsAria')}
                            onChange={(event) => { setDraft({ ...draft, argsText: event.target.value }) }}
                          />
                        </div>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">{t('mcp.field.env')}</span>
                          <textarea
                            className="dshMcp-textarea"
                            value={draft.envText}
                            placeholder={'GITHUB_TOKEN=$ENV:GITHUB_TOKEN'}
                            disabled={busy}
                            aria-label={t('mcp.field.envAria')}
                            onChange={(event) => { setDraft({ ...draft, envText: event.target.value }) }}
                          />
                        </div>
                      </>
                    )
                    : (
                      <>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">{t('mcp.field.url')}</span>
                          <input
                            className="dshMcp-input"
                            value={draft.url}
                            placeholder="http://127.0.0.1:3000/mcp"
                            disabled={busy}
                            aria-label={t('mcp.field.url')}
                            onChange={(event) => { setDraft({ ...draft, url: event.target.value }) }}
                          />
                        </div>
                        <div className="dshMcp-field">
                          <span className="dshMcp-label">{t('mcp.field.headers')}</span>
                          <textarea
                            className="dshMcp-textarea"
                            value={draft.headersText}
                            placeholder={'Authorization=$ENV:MCP_TOKEN'}
                            disabled={busy}
                            aria-label={t('mcp.field.headersAria')}
                            onChange={(event) => { setDraft({ ...draft, headersText: event.target.value }) }}
                          />
                        </div>
                      </>
                    )}

                  <div className="dshMcp-row">
                    <div className="dshMcp-field">
                      <span className="dshMcp-label">{t('mcp.field.timeout')}</span>
                      <input
                        className="dshMcp-input"
                        value={draft.toolCallTimeoutMs}
                        disabled={busy}
                        aria-label={t('mcp.field.timeoutAria')}
                        onChange={(event) => { setDraft({ ...draft, toolCallTimeoutMs: event.target.value }) }}
                      />
                    </div>
                  </div>
                </>
              )}

            <div className="dshMcp-formActions">
              <button type="submit" className="dshMcp-button dshMcp-buttonPrimary" disabled={busy}>
                {busy
                  ? t('mcp.form.saving')
                  : draft.id === null ? t('mcp.form.save') : t('mcp.form.saveEdit')}
              </button>
              <button
                type="button"
                className="dshMcp-button"
                disabled={busy}
                onClick={() => { setDraft(null); setError(undefined) }}
              >{t('mcp.cancel')}</button>
            </div>
          </form>
        )
        : (
          <div className="dshMcp-toolbar">
            <span className="dshMcp-count">
              {data === null ? '' : t('mcp.count', { count: data.servers.length })}
            </span>
            <div className="dshMcp-toolbarActions">
              <button
                type="button"
                className="dshMcp-button"
                disabled={busy || (data !== null && !data.enabled)}
                onClick={() => { setImportOpen(true); setImportReport(null); setError(undefined) }}
              >{t('mcp.import.action')}</button>
              <button
                type="button"
                className="dshMcp-button dshMcp-buttonPrimary"
                disabled={busy || (data !== null && !data.enabled)}
                onClick={() => { setDraft(emptyDraft()); setEditView('form'); setError(undefined) }}
              >{t('mcp.add.action')}</button>
            </div>
          </div>
        )}

      {importOpen
        ? (
          <form className="dshMcp-form" onSubmit={(event) => { event.preventDefault(); void onImport() }}>
            <p className="dshMcp-formTitle">{t('mcp.import.title')}</p>
            <div className="dshMcp-field">
              <span className="dshMcp-label">{t('mcp.import.label')}</span>
              <textarea
                className="dshMcp-textarea dshMcp-jsonArea"
                value={importText}
                spellCheck={false}
                disabled={busy}
                placeholder={'{\n  "mcpServers": {\n    "context7": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "@upstash/context7-mcp"]\n    },\n    "exa": { "type": "http", "url": "https://mcp.exa.ai/mcp" }\n  }\n}'}
                aria-label={t('mcp.import.aria')}
                onChange={(event) => { setImportText(event.target.value) }}
              />
              <span className="dshMcp-fieldHint">{t('mcp.import.hint')}</span>
            </div>
            {importReport !== null
              ? (
                <div className="dshMcp-importReport">
                  {importReport.imported.length > 0
                    ? (
                      <div className="dshMcp-noticeOk">
                        {t('mcp.import.imported', {
                          names: importReport.imported.join(t('mcp.listSeparator')),
                        })}
                      </div>
                    )
                    : null}
                  {importReport.renamed.map(entry => (
                    <div key={entry.to} className="dshMcp-warning">
                      {t('mcp.import.renamed', { from: entry.from, to: entry.to })}
                    </div>
                  ))}
                  {importReport.failed.map(entry => (
                    <div key={entry.name} className="dshMcp-banner">
                      {t('mcp.import.failed', { name: entry.name, reason: hostMessage(entry.reason, t) })}
                    </div>
                  ))}
                </div>
              )
              : null}
            <div className="dshMcp-formActions">
              <button type="submit" className="dshMcp-button dshMcp-buttonPrimary" disabled={busy || importText.trim() === ''}>
                {busy ? t('mcp.import.busy') : t('mcp.import.submit')}
              </button>
              <button
                type="button"
                className="dshMcp-button"
                disabled={busy}
                onClick={() => { setImportOpen(false); setImportReport(null) }}
              >{t('mcp.import.close')}</button>
            </div>
          </form>
        )
        : null}

      {data !== null && !data.enabled
        ? <div className="dshMcp-warning">{t('mcp.disabled')}</div>
        : null}

      <div className="dshMcp-list">
        {sortedServers.length === 0 && draft === null && !importOpen
          ? <div className="dshMcp-empty">{t('mcp.empty')}</div>
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
                  {t(badge.key)}
                  {view.status.state === 'mounted' && view.status.toolCount !== undefined
                    ? t('mcp.card.badgeTools', { count: view.status.toolCount })
                    : ''}
                </span>
              </div>
              {/* The host explains an unhealthy entry with a code; the badge's own
                  copy is the last resort, so an unknown code still shows a line. */}
              {view.status.message !== undefined
                ? <div className="dshMcp-warning">{hostMessage(view.status.message, t, t(badge.key))}</div>
                : null}
              {view.status.warnings !== undefined && view.status.warnings.length > 0
                ? <div className="dshMcp-warning">{hostListText(view.status.warnings, t)}</div>
                : null}
              <div className="dshMcp-meta">{meta}</div>
              <div className="dshMcp-cardActions">
                <button
                  type="button"
                  className="dshMcp-toggle"
                  role="switch"
                  aria-checked={view.enabled}
                  aria-label={t('mcp.card.toggleAria', { name: view.serverName })}
                  disabled={busy}
                  onClick={() => { void onToggle(view) }}
                />
                <button
                  type="button"
                  className="dshMcp-button"
                  disabled={busy}
                  onClick={() => { openEdit(view) }}
                >{t('mcp.card.edit')}</button>
                <button
                  type="button"
                  className="dshMcp-button dshMcp-buttonDanger"
                  disabled={busy}
                  onClick={() => { setConfirmTarget(view) }}
                >{t('mcp.card.delete')}</button>
              </div>
            </div>
          )
        })}
      </div>

      {data !== null ? <p className="dshMcp-path" title={data.filePath}>{t('mcp.path', { path: data.filePath })}</p> : null}

      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('mcp.confirm.deleteTitle', { name: confirmTarget?.serverName ?? '' })}
        message={t('mcp.confirm.deleteMessage')}
        confirmLabel={t('mcp.confirm.delete')}
        cancelLabel={t('mcp.cancel')}
        busy={busy}
        onConfirm={() => { if (confirmTarget !== null) void onDelete(confirmTarget) }}
        onClose={() => { setConfirmTarget(null) }}
      />
    </div>
  )
}
