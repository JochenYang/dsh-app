/**
 * DSH APP session archive manager — settings-page section (client half UI).
 *
 * Layout: header totals → pending-delete confirm banner → collapsible
 * project groups (each a bordered panel: clickable header with caret,
 * project title + cwd, session rows with title, date, size, and an
 * irreversible delete), with per-project delete-all.
 * Deletion is a two-step flow: every request first arms the confirm banner
 * (naming what will vanish and the bytes freed); confirming POSTs the batch
 * and reloads the listing. The host re-checks every fence server-side, so a
 * stale UI can never delete a live or unarchived session. Stale archive
 * records (archived ids whose logs are already gone) are counted in the
 * header and pruned through the same confirm-banner flow.
 *
 * @module @dsh-app/plugin-archives/client/archives-section
 */

import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { ArchiveDeleteResult, ArchiveGroup, ArchiveList, ArchivePruneResult } from '../types.ts'

/** A destructive action awaiting the user's confirmation. */
type ConfirmState =
  | {
      /** Remove the on-disk logs of these archived sessions. */
      kind: 'delete'
      /** Session ids the batch would remove. */
      ids: string[]
      /** Human name of the target (one session's title, or a project's title). */
      label: string
      /** Bytes the batch would free (measured at list time). */
      bytes: number
    }
  | {
      /** Drop stale archive records from the registry (logs already gone). */
      kind: 'prune'
      /** Stale records the action would drop (measured at list time). */
      count: number
    }

/** One outcome notice: success or a warning with skipped ids. */
interface NoticeState {
  kind: 'ok' | 'warn'
  text: string
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Row title: the projection title, or a shortened id when untitled. */
function rowTitle(id: string, title: string): ReactNode {
  if (title !== '') return <span className="dshar_rowTitle" title={id}>{title}</span>
  const short = id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-6)}` : id
  return <span className="dshar_rowTitle dshar_rowTitleUnnamed" title={id}>{short}</span>
}

const SKIP_REASONS: Record<string, string> = {
  live: '会话正在进行',
  'not-archived': '不在归档中',
  missing: '日志已不存在',
  io: '文件访问失败',
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/** One project group panel: collapsible header with meta + delete-all, then session rows. */
function GroupPanel({ group, busy, onDeleteSessions }: {
  group: ArchiveGroup
  busy: boolean
  onDeleteSessions: (group: ArchiveGroup) => void
}): ReactNode {
  const [expanded, setExpanded] = useState(true)
  const toggle = useCallback(() => { setExpanded((value) => !value) }, [])
  // Keyboard toggle on the header, but never when focus sits on an inner
  // control (its own Enter/Space handling must not also collapse the panel).
  const onHeaderKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button') !== null) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  }, [toggle])
  return (
    <div className={`dshar_group ${expanded ? 'dshar_groupExpanded' : 'dshar_groupCollapsed'}`}>
      <div
        className="dshar_groupHeader"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={onHeaderKeyDown}
      >
        <span className="dshar_caret" aria-hidden="true" />
        <span className="dshar_groupTitle">{group.title}</span>
        {group.cwd !== '' && <span className="dshar_groupPath" title={group.cwd}>{group.cwd}</span>}
        <span className="dshar_groupMeta">
          <span>{group.sessions.length} 个会话</span>
          <span>{fmtBytes(group.totalBytes)}</span>
          <button
            type="button"
            className="dshar_button dshar_buttonDanger"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); onDeleteSessions(group) }}
          >
            删除全部
          </button>
        </span>
      </div>
      {expanded && group.sessions.map((session) => (
        <div className="dshar_row" key={session.id}>
          {rowTitle(session.id, session.title)}
          <span className="dshar_rowMeta">
            <span>{fmtDate(session.createdAt)}</span>
            <span>{fmtBytes(session.sizeBytes)}</span>
            <button
              type="button"
              className="dshar_button dshar_buttonDanger"
              disabled={busy}
              onClick={() => { onDeleteSessions({ ...group, sessions: [session] }) }}
            >
              删除
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The settings section: load the grouped listing on mount, confirm-and-delete.
 */
export function ArchivesSection(): ReactNode {
  const [list, setList] = useState<ArchiveList | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)

  const load = useCallback(async () => {
    try {
      setList(await fetchJson<ArchiveList>('/plugins/@dsh-app/plugin-archives/api/list'))
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Arm the confirm banner for one session or a whole project group. */
  const onDeleteSessions = useCallback((group: ArchiveGroup) => {
    setNotice(null)
    const ids = group.sessions.map((session) => session.id)
    const bytes = group.sessions.reduce((total, session) => total + session.sizeBytes, 0)
    const label = group.sessions.length === 1 && group.sessions[0].title !== ''
      ? `“${group.sessions[0].title}”`
      : `“${group.title}”的 ${ids.length} 个会话`
    setConfirm({ kind: 'delete', ids, label, bytes })
  }, [])

  /** Confirm the pending action: POST, surface the outcome, reload. */
  const onConfirm = useCallback(async () => {
    if (confirm === null) return
    // Captured before the try: narrowing does not flow into catch blocks,
    // and the branch decides how a failure is surfaced.
    const kind = confirm.kind
    setBusy(true)
    try {
      if (confirm.kind === 'prune') {
        const result = await fetchJson<ArchivePruneResult>('/plugins/@dsh-app/plugin-archives/api/prune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        setNotice({ kind: 'ok', text: `已清理 ${result.pruned} 条无效归档记录` })
      } else {
        const result = await fetchJson<ArchiveDeleteResult>('/plugins/@dsh-app/plugin-archives/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: confirm.ids }),
        })
        const parts = [`已删除 ${result.deleted.length} 个会话，释放 ${fmtBytes(result.freedBytes)}`]
        if (result.skipped.length > 0) {
          const counts = new Map<string, number>()
          for (const skip of result.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1)
          const skippedText = [...counts]
            .map(([reason, count]) => `${SKIP_REASONS[reason] ?? reason} × ${count}`)
            .join('、')
          parts.push(`跳过 ${result.skipped.length} 个（${skippedText}）`)
        }
        setNotice(result.skipped.length > 0 ? { kind: 'warn', text: parts.join('；') } : { kind: 'ok', text: parts[0] })
      }
      setConfirm(null)
      await load()
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError)
      if (kind === 'prune') {
        // A failed prune (e.g. an older kernel without the write path) must
        // not blank the listing — surface it as a dismissible notice.
        setNotice({ kind: 'warn', text: message })
        setConfirm(null)
      } else {
        setError(message)
      }
    } finally {
      setBusy(false)
    }
  }, [confirm, load])

  if (error !== '') {
    return (
      <div className="dshar_section">
        <h2 className="dshar_title">会话归档</h2>
        <div className="dshar_notice dshar_noticeWarn">{error}</div>
      </div>
    )
  }

  if (list === null) {
    return (
      <div className="dshar_section">
        <h2 className="dshar_title">会话归档</h2>
        <div className="dshar_empty">正在读取归档会话…</div>
      </div>
    )
  }

  const empty = list.groups.length === 0
  return (
    <div className="dshar_section">
      <div className="dshar_header">
        <h2 className="dshar_title">会话归档</h2>
        <span className="dshar_sub">
          {empty
            ? '没有已归档的会话'
            : `${list.archivedCount} 个会话 · ${fmtBytes(list.totalBytes)} · ${list.groups.length} 个项目`}
        </span>
        {list.staleCount > 0 && (
          <span className="dshar_staleHint" title="归档记录仍在，但其会话日志已不在磁盘上；清理只会移除这些无效记录">
            另有 {list.staleCount} 条归档记录无日志
            <button
              type="button"
              className="dshar_button"
              disabled={busy}
              onClick={() => {
                setNotice(null)
                setConfirm({ kind: 'prune', count: list.staleCount })
              }}
            >
              清理
            </button>
          </span>
        )}
      </div>

      {notice !== null && <div className={`dshar_notice ${notice.kind === 'warn' ? 'dshar_noticeWarn' : 'dshar_noticeOk'}`}>{notice.text}</div>}

      {confirm !== null && (
        <div className="dshar_confirm" role="alertdialog" aria-label={confirm.kind === 'prune' ? '确认清理归档记录' : '确认删除归档会话'}>
          {confirm.kind === 'prune' ? (
            <span>即将清理 {confirm.count} 条无日志的归档记录，仅移除记录本身，不影响任何会话数据。</span>
          ) : (
            <span>
              即将删除{confirm.label}（约 {fmtBytes(confirm.bytes)}），删除后不可恢复。
            </span>
          )}
          <span className="dshar_confirmActions">
            <button
              type="button"
              className={confirm.kind === 'prune' ? 'dshar_button' : 'dshar_button dshar_buttonDanger'}
              disabled={busy}
              onClick={() => { void onConfirm() }}
            >
              {busy ? (confirm.kind === 'prune' ? '清理中…' : '删除中…') : (confirm.kind === 'prune' ? '确认清理' : '确认删除')}
            </button>
            <button type="button" className="dshar_button" disabled={busy} onClick={() => { setConfirm(null) }}>
              取消
            </button>
          </span>
        </div>
      )}

      {empty
        ? <div className="dshar_empty">归档的会话会在这里按项目分组显示，可在此彻底删除以释放磁盘空间。</div>
        : list.groups.map((group) => (
          <GroupPanel key={group.cwd} group={group} busy={busy} onDeleteSessions={onDeleteSessions} />
        ))}
    </div>
  )
}
