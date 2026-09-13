/**
 * The preset-packages settings section: the list of locally authored presets
 * with per-row export (download a `.dshpreset` file) and a file-picker
 * import. Above it sits the config-backup block: a whole-config zip (plugin
 * configs, market sources, the profile patch layer) with one-click export —
 * secret-shaped content is scanned and a hit refuses the export — and a
 * file-picker import that turns a 409 conflict into an explicit overwrite
 * confirmation. The host enforces every rule (whitelist, containment, caps);
 * this half only mirrors the upload size caps for an instant local answer.
 *
 * @module @dsh-app/plugin-presets/client/presets-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmDialog } from './confirm-dialog.tsx'

const ROUTE = '/plugins/@dsh-app/plugin-presets/api'

/** Mirror of the host cap for an instant client-side answer (preset package). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Mirror of the host cap for an instant client-side answer (config backup). */
const MAX_BACKUP_UPLOAD_BYTES = 20 * 1024 * 1024

/** Mirror of the list route's payload. */
interface PresetSummary {
  readonly entry: string
  readonly files: number
  readonly bytes: number
}

interface PresetsResponse {
  readonly root: string
  readonly presets: readonly PresetSummary[]
}

/** Error envelope the host answers with. */
interface ErrorBody {
  readonly ok?: boolean
  readonly error?: { readonly code?: string, readonly message?: string, readonly entry?: string, readonly files?: unknown }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/** Pull a zh-CN reason out of a failed response, tolerating non-JSON bodies. */
async function errorReasonOf(response: Response): Promise<{ code: string, message: string, entry: string, files: readonly string[] }> {
  const body = await response.json().catch(() => undefined) as ErrorBody | undefined
  return {
    code: body?.error?.code ?? '',
    message: body?.error?.message ?? `请求失败（HTTP ${String(response.status)}）`,
    entry: body?.error?.entry ?? '',
    files: Array.isArray(body?.error?.files)
      ? (body.error.files as unknown[]).filter((item): item is string => typeof item === 'string')
      : [],
  }
}

/** Local-calendar date stamp (YYYY-MM-DD) for the backup file name. */
function localDateStamp(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * The conflict list of an overwrite confirmation, capped so a huge backup
 * cannot flood the dialog (the full list stays in the host's refusal).
 */
function describeConflictFiles(files: readonly string[]): string {
  if (files.length === 0) return '（服务器未返回具体清单）'
  const head = files.slice(0, 5).join('、')
  return files.length > 5 ? `${head} 等 ${String(files.length)} 个文件` : head
}

/** Human size for a file count/bytes summary. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function PresetsSection(): ReactNode {
  const [data, setData] = useState<PresetsResponse | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [pendingOverwrite, setPendingOverwrite] = useState<{ buffer: ArrayBuffer, entry: string } | null>(null)
  const [pendingBackupOverwrite, setPendingBackupOverwrite] = useState<{ buffer: ArrayBuffer, files: readonly string[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const backupInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    try {
      const value = await fetchJson<PresetsResponse>(`${ROUTE}/presets`)
      setData(value)
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Success notices are transient; errors stay until the next action.
  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { setNotice(undefined) }, 5_000)
    return () => { clearTimeout(timer) }
  }, [notice])

  const onExport = useCallback(async (entry: string) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch(`${ROUTE}/export?entry=${encodeURIComponent(entry)}`, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) {
        throw new Error((await errorReasonOf(response)).message)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${entry}.dshpreset`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
      setNotice(`已导出 ${entry}.dshpreset`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  const runImport = useCallback(async (buffer: ArrayBuffer, overwrite: boolean) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch(`${ROUTE}/import${overwrite ? '?overwrite=1' : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      })
      if (response.status === 409) {
        // Existing entry: the explicit confirmation IS the overwrite flag's
        // source, so stage the upload and re-post only after the user agrees.
        const reason = await errorReasonOf(response)
        setPendingOverwrite({ buffer, entry: reason.entry })
        setError(undefined)
        return
      }
      if (!response.ok) {
        throw new Error((await errorReasonOf(response)).message)
      }
      const body = (await response.json()) as { ok: boolean, value?: { entry: string, files: number } }
      if (body.ok === true && body.value !== undefined) {
        setNotice(`已导入预设「${body.value.entry}」（${String(body.value.files)} 个文件），可在会话的预设选择器中选用`)
        await load()
      } else {
        throw new Error('导入响应无法识别')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [load])

  const onFileChosen = useCallback(async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('预设包超过 10MB 上限')
      return
    }
    try {
      const buffer = await file.arrayBuffer()
      await runImport(buffer, false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [runImport])

  /** Download the whole-config backup as a dated zip file. */
  const onBackupExport = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch(`${ROUTE}/config-export`, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) {
        throw new Error((await errorReasonOf(response)).message)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `dsh-config-backup-${localDateStamp()}.zip`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
      setNotice(`已导出 dsh-config-backup-${localDateStamp()}.zip（密钥扫描未命中）`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  const runBackupImport = useCallback(async (buffer: ArrayBuffer, overwrite: boolean) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch(`${ROUTE}/config-import${overwrite ? '?overwrite=1' : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      })
      if (response.status === 409) {
        // Differing files on disk: the explicit confirmation IS the overwrite
        // flag's source, so stage the upload and re-post only after the user
        // agrees.
        const reason = await errorReasonOf(response)
        setPendingBackupOverwrite({ buffer, files: reason.files })
        setError(undefined)
        return
      }
      if (!response.ok) {
        throw new Error((await errorReasonOf(response)).message)
      }
      const body = (await response.json()) as { ok: boolean, value?: { written: number, unchanged: number, backups: readonly string[] } }
      if (body.ok === true && body.value !== undefined) {
        const { written, unchanged, backups } = body.value
        const parts = [`已恢复 ${String(written)} 项配置`]
        if (unchanged > 0) parts.push(`${String(unchanged)} 项无变化跳过`)
        if (backups.length > 0) parts.push('原补丁层已自动备份')
        setNotice(`${parts.join('，')}。依赖清单变更需重启应用后生效。`)
      } else {
        throw new Error('导入响应无法识别')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  const onBackupFileChosen = useCallback(async (file: File) => {
    if (file.size > MAX_BACKUP_UPLOAD_BYTES) {
      setError('配置备份超过 20MB 上限')
      return
    }
    try {
      const buffer = await file.arrayBuffer()
      await runBackupImport(buffer, false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [runBackupImport])

  const presets = data?.presets ?? []

  return (
    <div className="dshPresets-section">
      <p className="dshPresets-title">预设包</p>

      {error !== undefined ? <div className="dshPresets-banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshPresets-noticeOk">{notice}</div> : null}

      <div className="dshPresets-card">
        <div className="dshPresets-cardMain">
          <span className="dshPresets-entryName">配置备份</span>
          <span className="dshPresets-hint">
            导出或恢复当前配置：备份包含插件配置与补丁层；已自动扫描常见密钥形态，命中会拒绝导出——请勿手动放入凭据文件。
            依赖清单中的本地 file: 路径会按原样恢复，换一台机器导入可能失效。
          </span>
        </div>
        <div className="dshPresets-cardActions">
          <button
            type="button"
            className="dshPresets-button"
            disabled={busy}
            aria-label="导出配置备份"
            onClick={() => { void onBackupExport() }}
          >导出配置备份</button>
          <button
            type="button"
            className="dshPresets-button dshPresets-buttonPrimary"
            disabled={busy}
            onClick={() => { backupInputRef.current?.click() }}
          >导入配置备份</button>
        </div>
      </div>
      <input
        ref={backupInputRef}
        type="file"
        accept=".zip"
        aria-label="选择配置备份 zip 文件"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void onBackupFileChosen(file)
        }}
      />

      <p className="dshPresets-hint">
        把本机的自定义 agent 预设打包为 .dshpreset 文件分享，或从文件导入。仅列出本机自定义预设；
        内置预设随应用提供，不可导出。导入时会校验包结构与路径安全，写入本机自定义预设目录，
        之后可在会话的预设选择器中选用。
      </p>

      <div className="dshPresets-toolbar">
        <span className="dshPresets-count">{data === null ? '' : `共 ${String(presets.length)} 个自定义预设`}</span>
        <div className="dshPresets-cardActions">
          <button
            type="button"
            className="dshPresets-button dshPresets-buttonPrimary"
            disabled={busy}
            onClick={() => { fileInputRef.current?.click() }}
          >导入预设包</button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".dshpreset"
        aria-label="选择 .dshpreset 文件"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void onFileChosen(file)
        }}
      />

      <div className="dshPresets-list">
        {data !== null && presets.length === 0
          ? (
            <div className="dshPresets-empty">
              还没有可导出的自定义预设。在会话中复制一个现有预设即可创建，或从他人分享的 .dshpreset 文件导入。
            </div>
          )
          : null}
        {presets.map(summary => (
          <div key={summary.entry} className="dshPresets-card">
            <div className="dshPresets-cardMain">
              <span className="dshPresets-entryName">{summary.entry}</span>
              <span className="dshPresets-meta">{String(summary.files)} 个文件 · {formatBytes(summary.bytes)}</span>
            </div>
            <div className="dshPresets-cardActions">
              <button
                type="button"
                className="dshPresets-button"
                disabled={busy}
                aria-label={`导出预设 ${summary.entry}`}
                onClick={() => { void onExport(summary.entry) }}
              >导出</button>
            </div>
          </div>
        ))}
      </div>

      {data !== null && data.root !== '' ? <p className="dshPresets-path">预设目录：{data.root}</p> : null}

      <ConfirmDialog
        open={pendingOverwrite !== null}
        title={`覆盖预设「${pendingOverwrite?.entry ?? ''}」`}
        message="本机已存在同名预设，覆盖导入将替换它的全部文件，且无法撤销。"
        confirmLabel="覆盖导入"
        busy={busy}
        onConfirm={() => {
          if (pendingOverwrite === null) return
          const { buffer } = pendingOverwrite
          setPendingOverwrite(null)
          void runImport(buffer, true)
        }}
        onClose={() => { setPendingOverwrite(null) }}
      />

      <ConfirmDialog
        open={pendingBackupOverwrite !== null}
        title="覆盖现有配置"
        message={pendingBackupOverwrite === null
          ? ''
          : `备份中的以下文件与本机当前配置不同，覆盖导入将替换它们（原补丁层会自动备份），且无法撤销：${describeConflictFiles(pendingBackupOverwrite.files)}`}
        confirmLabel="覆盖导入"
        busy={busy}
        onConfirm={() => {
          if (pendingBackupOverwrite === null) return
          const { buffer } = pendingBackupOverwrite
          setPendingBackupOverwrite(null)
          void runBackupImport(buffer, true)
        }}
        onClose={() => { setPendingBackupOverwrite(null) }}
      />
    </div>
  )
}
