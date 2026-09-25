/**
 * The preset-packages page (the 预设包 tab of 维护): the list of locally
 * authored presets with per-row export (download a `.dshpreset` file) and a
 * file-picker import. Above it sits the config-backup block: a whole-config zip
 * (the host settings file, the home patch layer, the credential store, plugin
 * configs, market sources, the profile patch layer) with one-click export —
 * secret-shaped content is scanned and every hit rides the answer as an
 * `x-dsh-backup-warnings` header this half turns into a notice, because the
 * archive carries plaintext keys by design — and a file-picker import that
 * turns a 409 conflict into an explicit overwrite confirmation. The host
 * enforces every rule (whitelist, containment, caps); this half only mirrors
 * the upload size caps for an instant local answer.
 *
 * @module @dsh-app/plugin-presets/client/presets-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText } from '../wire.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { NS } from './locales.ts'
import { hostMessage, type Translate } from './messages.ts'
import { BACKUP_WARNINGS_HEADER, decodeBackupWarnings } from './backup-warnings.ts'

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type PresetsSectionProps = PropsLocale<typeof NS>

/**
 * The plugin's route prefix on the shared Connection `/api` channel (mirrors
 * the host half; the registry admits no `@` in a path segment, so the npm
 * scope travels as `dsh-app`).
 */
const ROUTE = '/api/plugins/dsh-app/plugin-presets'

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
  readonly error?: {
    readonly code?: string
    readonly message?: string
    /** The coded message; see `HostText` in src/wire.ts. */
    readonly host?: HostText
    readonly entry?: string
    readonly files?: unknown
  }
}

/** A failure carrying the host's coded message, when one came with it. */
class HostError extends Error {
  constructor(readonly host: HostText | undefined, fallback: string) {
    super(fallback)
  }
}

/** One failure's banner line: a coded host message in this locale, else the error's own text. */
function failureText(failure: unknown, t: Translate): string {
  if (failure instanceof HostError) return hostMessage(failure.host, t, failure.message)
  return failure instanceof Error ? failure.message : String(failure)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string, host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/**
 * Pull a reason out of a failed response, tolerating non-JSON bodies: the
 * host's coded message renders through this page's dictionary (an unknown code
 * falls back to the host's English diagnostic), while `entry`/`files` carry the
 * structured extras the overwrite dialogs read.
 */
async function errorReasonOf(response: Response, t: Translate): Promise<{ code: string, message: string, entry: string, files: readonly string[] }> {
  const body = await response.json().catch(() => undefined) as ErrorBody | undefined
  const fallback = body?.error?.message ?? t('presets.request.failed', { status: response.status })
  return {
    code: body?.error?.code ?? '',
    message: hostMessage(body?.error?.host, t, fallback),
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
 * cannot flood the dialog (the full list stays in the host's refusal). The
 * list separator is a dictionary entry: a joiner hardcoded here cannot serve
 * both languages. One archive path is shown as what it IS on the user's
 * machine: `credentials.yaml` is the API-key store, and a user must not
 * have to recognize an internal archive path to know their keys are being
 * replaced.
 */
function describeConflictFiles(files: readonly string[], t: Translate): string {
  if (files.length === 0) return t('presets.conflict.none')
  const named = files.map((file) => (file === 'credentials.yaml' ? t('presets.backup.file.credentials') : file))
  const head = named.slice(0, 5).join(t('presets.list.separator'))
  return named.length > 5 ? t('presets.conflict.more', { head, count: named.length }) : head
}

/** Human size for a file count/bytes summary. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Render the preset-packages settings section.
 * @param props - the framework-supplied `t` seat of this page's namespace.
 * @returns the section page.
 */
export function PresetsSection({ t }: PresetsSectionProps): ReactNode {
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
      setError(failureText(failure, t))
    }
  }, [t])

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
        throw new Error((await errorReasonOf(response, t)).message)
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
      setNotice(t('presets.export.done', { entry }))
    } catch (failure) {
      setError(failureText(failure, t))
    } finally {
      setBusy(false)
    }
  }, [t])

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
        const reason = await errorReasonOf(response, t)
        setPendingOverwrite({ buffer, entry: reason.entry })
        setError(undefined)
        return
      }
      if (!response.ok) {
        throw new Error((await errorReasonOf(response, t)).message)
      }
      const body = (await response.json()) as { ok: boolean, value?: { entry: string, files: number } }
      if (body.ok === true && body.value !== undefined) {
        setNotice(t('presets.import.done', { entry: body.value.entry, files: body.value.files }))
        await load()
      } else {
        throw new Error(t('presets.import.unknown'))
      }
    } catch (failure) {
      setError(failureText(failure, t))
    } finally {
      setBusy(false)
    }
  }, [load, t])

  const onFileChosen = useCallback(async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t('presets.import.tooLarge'))
      return
    }
    try {
      const buffer = await file.arrayBuffer()
      await runImport(buffer, false)
    } catch (failure) {
      setError(failureText(failure, t))
    }
  }, [runImport, t])

  /** Download the whole-config backup as a dated zip file. */
  const onBackupExport = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch(`${ROUTE}/config-export`, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) {
        throw new Error((await errorReasonOf(response, t)).message)
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
      const file = `dsh-config-backup-${localDateStamp()}.zip`
      // The archive carries the credential store by design, so the host
      // reports every secret-shaped file it packed; the notice is where the
      // user learns the zip holds plaintext keys.
      const warnings = decodeBackupWarnings(response.headers.get(BACKUP_WARNINGS_HEADER))
      setNotice(warnings.length === 0
        ? t('presets.backup.export.done', { file })
        : `${t('presets.backup.export.done', { file })} ${t('presets.backup.export.secrets', {
          list: warnings
            .map((warning) => t('presets.host.backupSecretContent', { rel: warning.rel, rule: warning.rule }))
            .join(t('presets.list.separator')),
        })}`)
    } catch (failure) {
      setError(failureText(failure, t))
    } finally {
      setBusy(false)
    }
  }, [t])

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
        const reason = await errorReasonOf(response, t)
        setPendingBackupOverwrite({ buffer, files: reason.files })
        setError(undefined)
        return
      }
      if (!response.ok) {
        throw new Error((await errorReasonOf(response, t)).message)
      }
      const body = (await response.json()) as { ok: boolean, value?: { written: number, unchanged: number, backups: readonly string[] } }
      if (body.ok === true && body.value !== undefined) {
        const { written, unchanged, backups } = body.value
        // Clause fragments: each locale's fragment carries its own separator,
        // and the sentence is the written part plus this tail.
        const parts = [t('presets.backup.restore.written', { written })]
        if (unchanged > 0) parts.push(t('presets.backup.restore.unchanged', { unchanged }))
        if (backups.length > 0) parts.push(t('presets.backup.restore.backedUp'))
        setNotice(`${parts.join('')}${t('presets.backup.restore.tail')}`)
      } else {
        throw new Error(t('presets.import.unknown'))
      }
    } catch (failure) {
      setError(failureText(failure, t))
    } finally {
      setBusy(false)
    }
  }, [t])

  const onBackupFileChosen = useCallback(async (file: File) => {
    if (file.size > MAX_BACKUP_UPLOAD_BYTES) {
      setError(t('presets.backup.tooLarge'))
      return
    }
    try {
      const buffer = await file.arrayBuffer()
      await runBackupImport(buffer, false)
    } catch (failure) {
      setError(failureText(failure, t))
    }
  }, [runBackupImport, t])

  const presets = data?.presets ?? []

  return (
    <div className="dshPresets-section">
      <p className="dshPresets-title">{t('presets.nav')}</p>

      {error !== undefined ? <div className="dshPresets-banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshPresets-noticeOk">{notice}</div> : null}

      <div className="dshPresets-card">
        <div className="dshPresets-cardMain">
          <span className="dshPresets-entryName">{t('presets.backup.title')}</span>
          <span className="dshPresets-hint">{t('presets.backup.intro')}</span>
        </div>
        <div className="dshPresets-cardActions">
          <button
            type="button"
            className="dshPresets-button"
            disabled={busy}
            aria-label={t('presets.backup.export')}
            onClick={() => { void onBackupExport() }}
          >{t('presets.backup.export')}</button>
          <button
            type="button"
            className="dshPresets-button dshPresets-buttonPrimary"
            disabled={busy}
            onClick={() => { backupInputRef.current?.click() }}
          >{t('presets.backup.import')}</button>
        </div>
      </div>
      <input
        ref={backupInputRef}
        type="file"
        accept=".zip"
        aria-label={t('presets.backup.pick')}
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void onBackupFileChosen(file)
        }}
      />

      <p className="dshPresets-hint">{t('presets.intro')}</p>

      <div className="dshPresets-toolbar">
        <span className="dshPresets-count">{data === null ? '' : t('presets.count', { count: presets.length })}</span>
        <div className="dshPresets-cardActions">
          <button
            type="button"
            className="dshPresets-button dshPresets-buttonPrimary"
            disabled={busy}
            onClick={() => { fileInputRef.current?.click() }}
          >{t('presets.import.action')}</button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".dshpreset"
        aria-label={t('presets.import.pick')}
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
              {t('presets.empty')}
            </div>
          )
          : null}
        {presets.map(summary => (
          <div key={summary.entry} className="dshPresets-card">
            <div className="dshPresets-cardMain">
              <span className="dshPresets-entryName">{summary.entry}</span>
              <span className="dshPresets-meta">{t('presets.row.meta', { files: summary.files, size: formatBytes(summary.bytes) })}</span>
            </div>
            <div className="dshPresets-cardActions">
              <button
                type="button"
                className="dshPresets-button"
                disabled={busy}
                aria-label={t('presets.export.aria', { entry: summary.entry })}
                onClick={() => { void onExport(summary.entry) }}
              >{t('presets.export.action')}</button>
            </div>
          </div>
        ))}
      </div>

      {data !== null && data.root !== '' ? <p className="dshPresets-path">{t('presets.root', { root: data.root })}</p> : null}

      <ConfirmDialog
        open={pendingOverwrite !== null}
        title={t('presets.overwrite.title', { entry: pendingOverwrite?.entry ?? '' })}
        message={t('presets.overwrite.message')}
        confirmLabel={t('presets.overwrite.confirm')}
        cancelLabel={t('presets.dialog.cancel')}
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
        title={t('presets.backupOverwrite.title')}
        message={pendingBackupOverwrite === null
          ? ''
          : t('presets.backupOverwrite.message', { files: describeConflictFiles(pendingBackupOverwrite.files, t) })}
        confirmLabel={t('presets.overwrite.confirm')}
        cancelLabel={t('presets.dialog.cancel')}
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
