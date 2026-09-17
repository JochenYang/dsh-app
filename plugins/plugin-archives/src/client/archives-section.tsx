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
 * Every user-visible string this page renders comes from the `dsh-app.archives`
 * namespace through the `t` standard seat: the section registers with
 * `locale: NS`, so the renderer hands the component — and, through its props,
 * the group panels below — a namespace-bound translate that reads the active UI
 * locale at call time and re-renders on a language switch. A failure from the
 * host arrives as a stable CODE plus the values to interpolate (see `HostText`
 * in ../types.ts) and is worded by this page's dictionary; session titles, ids
 * and byte counts are data and stay verbatim.
 *
 * @module @dsh-app/plugin-archives/client/archives-section
 */

import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArchiveDeleteResult, ArchiveGroup, ArchiveList, ArchivePruneResult, HostText } from '../types.ts'
import { NS, type ArchivesKey } from './locales.ts'

/**
 * The plugin's route prefix on the shared Connection `/api` channel (mirrors
 * the host half; the Connection registry admits no `@` in a path segment, so
 * the npm scope travels as `dsh-app`).
 */
const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-archives'

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type ArchivesSectionProps = PropsLocale<typeof NS>

/** The page's namespace-bound translate, handed to the sub-components below. */
type ArchivesTranslate = TranslateNS<typeof NS>

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

/**
 * Group heading: the host's name for the group, or this page's copy when the
 * group has no project directory. The host sends an EMPTY title for that case
 * on purpose — a heading is copy, and copy is written in the locale table.
 */
function groupHeading(group: ArchiveGroup, t: ArchivesTranslate): string {
  return group.cwd === '' ? t('archives.group.noCwd') : group.title
}

/** A failure carrying the host's coded message, when one came with it. */
class HostError extends Error {
  constructor(readonly host: HostText | undefined, fallback: string) {
    super(fallback)
  }
}

/** A failed request as this page carries it: the host's coded message when it
 *  sent one, plus the line to show when there is nothing readable to map. */
interface Failure {
  readonly host?: HostText
  readonly fallback: string
}

/** Classify a failed request. */
function asFailure(failure: unknown): Failure {
  if (failure instanceof HostError) return { host: failure.host, fallback: failure.message }
  return { fallback: failure instanceof Error ? failure.message : String(failure) }
}

/**
 * Render a coded host message.
 *
 * The host never sends prose for anything the user reads (see `HostText` in
 * types.ts): it sends a code plus the values the sentence interpolates, and the
 * copy lives here. `text` is the host's own English diagnostic, used only for a
 * code this build does not know — a newer kernel must degrade to a readable
 * line, never to a blank one.
 *
 * @param value - the host message, if it sent one.
 * @param copy - this build's copy for the codes it knows.
 * @param fallback - line to show when the host sent nothing at all.
 * @returns the copy of the active locale.
 */
function hostMessage(
  value: HostText | undefined,
  copy: Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (value === undefined) return fallback
  return copy[value.code] ?? value.text ?? fallback
}

/**
 * Route-failure copy: every code this plugin's routes can answer with. An
 * unknown code falls back to the host's English diagnostic.
 *
 * The old fence codes are gone with the fences themselves: the Connection
 * carrier applies its Host/Origin trust check and its method dispatch before a
 * route handler runs, so a rejected call answers the channel's own status
 * without a coded message from this plugin.
 */
function routeErrorCopy(t: ArchivesTranslate, host: HostText | undefined, fallback: string): string {
  const params = host?.params ?? {}
  const detail = String(params.detail ?? '')
  return hostMessage(host, {
    'route.idsRequired': t('archives.host.idsRequired'),
    'route.listFailed': t('archives.host.listFailed', { detail }),
    'route.deleteFailed': t('archives.host.deleteFailed', { detail }),
    'route.pruneUnsupported': t('archives.host.pruneUnsupported'),
    'route.pruneFailed': t('archives.host.pruneFailed', { detail }),
    'route.sessionQueryUnavailable': t('archives.host.sessionQueryUnavailable'),
    'route.queryRequired': t('archives.host.queryRequired'),
    'route.searchFailed': t('archives.host.searchFailed', { detail }),
  }, fallback)
}

/** Wire skip reasons → this page's dictionary keys (an unknown code shows raw). */
const SKIP_REASONS: Record<string, ArchivesKey> = {
  live: 'archives.skip.live',
  'not-archived': 'archives.skip.notArchived',
  missing: 'archives.skip.missing',
  io: 'archives.skip.io',
  unsupported: 'archives.skip.unsupported',
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string; host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/** One project group panel: collapsible header with meta + delete-all, then session rows. */
function GroupPanel({ group, busy, onDeleteSessions, t }: {
  group: ArchiveGroup
  busy: boolean
  onDeleteSessions: (group: ArchiveGroup) => void
  t: ArchivesTranslate
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
        <span className="dshar_groupTitle">{groupHeading(group, t)}</span>
        {group.cwd !== '' && <span className="dshar_groupPath" title={group.cwd}>{group.cwd}</span>}
        <span className="dshar_groupMeta">
          <span>{t('archives.group.sessions', { count: group.sessions.length })}</span>
          <span>{fmtBytes(group.totalBytes)}</span>
          <button
            type="button"
            className="dshar_button dshar_buttonDanger"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); onDeleteSessions(group) }}
          >
            {t('archives.deleteAll')}
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
              {t('archives.delete')}
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The settings section: load the grouped listing on mount, confirm-and-delete,
 * plus a cross-session full-text search panel (GET /search?q=...).
 */
export function ArchivesSection({ t }: ArchivesSectionProps): ReactNode {
  const [list, setList] = useState<ArchiveList | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ items: Array<{ id: string; title: string; createdAt: number; cwd: string; snippet: string }>; agentToolAvailable: boolean } | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setList(await fetchJson<ArchiveList>(`${ROUTE_PREFIX}/list`))
      setError(null)
    } catch (loadError) {
      setError(asFailure(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Cross-session full-text search over the live-preferred corpus. */
  const onSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (q === '') return
    setSearchBusy(true)
    try {
      setSearchResults(await fetchJson<{ items: Array<{ id: string; title: string; createdAt: number; cwd: string; snippet: string }>; agentToolAvailable: boolean }>(`${ROUTE_PREFIX}/search?q=${encodeURIComponent(q)}`))
      setError(null)
    } catch (searchError) {
      setError(asFailure(searchError))
    } finally {
      setSearchBusy(false)
    }
  }, [searchQuery])

  /** Arm the confirm banner for one session or a whole project group. */
  const onDeleteSessions = useCallback((group: ArchiveGroup) => {
    setNotice(null)
    const ids = group.sessions.map((session) => session.id)
    const bytes = group.sessions.reduce((total, session) => total + session.sizeBytes, 0)
    const label = group.sessions.length === 1 && group.sessions[0].title !== ''
      ? t('archives.target.session', { title: group.sessions[0].title })
      : t('archives.target.group', { title: groupHeading(group, t), count: ids.length })
    setConfirm({ kind: 'delete', ids, label, bytes })
  }, [t])

  /** Confirm the pending action: POST, surface the outcome, reload. */
  const onConfirm = useCallback(async () => {
    if (confirm === null) return
    // Captured before the try: narrowing does not flow into catch blocks,
    // and the branch decides how a failure is surfaced.
    const kind = confirm.kind
    setBusy(true)
    try {
      if (confirm.kind === 'prune') {
        const result = await fetchJson<ArchivePruneResult>(`${ROUTE_PREFIX}/prune`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        setNotice({ kind: 'ok', text: t('archives.notice.pruned', { count: result.pruned }) })
      } else {
        const result = await fetchJson<ArchiveDeleteResult>(`${ROUTE_PREFIX}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: confirm.ids }),
        })
        const parts = [t('archives.notice.deleted', { count: result.deleted.length, bytes: fmtBytes(result.freedBytes) })]
        if (result.deleted.length > 0) {
          // The archive-set records are kept on purpose — dropping them would
          // un-hide the session in the client's stale list snapshot. Say so,
          // since the header's stale-record hint just grew by these ids.
          parts.push(t('archives.notice.recordsKept'))
        }
        if (result.skipped.length > 0) {
          const counts = new Map<string, number>()
          for (const skip of result.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1)
          const skippedText = [...counts]
            // An unknown reason code has no key of its own: show the code raw.
            .map(([reason, count]) => `${SKIP_REASONS[reason] === undefined ? reason : t(SKIP_REASONS[reason])} × ${count}`)
            .join(t('archives.notice.join.reasons'))
          parts.push(t('archives.notice.skipped', { count: result.skipped.length, reasons: skippedText }))
        }
        setNotice(result.skipped.length > 0
          ? { kind: 'warn', text: parts.join(t('archives.notice.join.notices')) }
          : { kind: 'ok', text: parts[0] })
      }
      setConfirm(null)
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      if (kind === 'prune') {
        // A failed prune (e.g. an older kernel without the write path) must
        // not blank the listing — surface it as a dismissible notice.
        setNotice({ kind: 'warn', text: routeErrorCopy(t, failure.host, failure.fallback) })
        setConfirm(null)
      } else {
        setError(failure)
      }
    } finally {
      setBusy(false)
    }
  }, [confirm, load, t])

  if (error !== null) {
    return (
      <div className="dshar_section">
        <h2 className="dshar_title">{t('archives.title')}</h2>
        <div className="dshar_notice dshar_noticeWarn">{routeErrorCopy(t, error.host, error.fallback)}</div>
      </div>
    )
  }

  if (list === null) {
    return (
      <div className="dshar_section">
        <h2 className="dshar_title">{t('archives.title')}</h2>
        <div className="dshar_empty">{t('archives.loading')}</div>
      </div>
    )
  }

  const empty = list.groups.length === 0
  return (
    <div className="dshar_section">
      <div className="dshar_header">
        <h2 className="dshar_title">{t('archives.title')}</h2>
        <span className="dshar_sub">
          {empty
            ? t('archives.sub.empty')
            : t('archives.sub.summary', { count: list.archivedCount, bytes: fmtBytes(list.totalBytes), projects: list.groups.length })}
        </span>
        {list.staleCount > 0 && (
          <span className="dshar_staleHint" title={t('archives.stale.hint')}>
            {t('archives.stale.count', { count: list.staleCount })}
            <button
              type="button"
              className="dshar_button"
              disabled={busy}
              onClick={() => {
                setNotice(null)
                setConfirm({ kind: 'prune', count: list.staleCount })
              }}
            >
              {t('archives.prune')}
            </button>
          </span>
        )}
      </div>

      {notice !== null && <div className={`dshar_notice ${notice.kind === 'warn' ? 'dshar_noticeWarn' : 'dshar_noticeOk'}`}>{notice.text}</div>}

      {/* Cross-session full-text search */}
      <div className="dshar_search">
        <input
          type="text"
          className="dshar_searchInput"
          value={searchQuery}
          placeholder={t('archives.search.placeholder')}
          disabled={searchBusy}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void onSearch() } }}
          onChange={(event) => { setSearchQuery(event.target.value) }}
        />
        <button type="button" className="dshar_button" disabled={searchBusy || searchQuery.trim() === ''} onClick={() => { void onSearch() }}>
          {searchBusy ? t('archives.search.busy') : t('archives.search.action')}
        </button>
      </div>
      {searchResults !== null && (
        <div className="dshar_searchResults">
          {searchResults.items.length === 0
            ? <div className="dshar_empty">{t('archives.search.empty')}</div>
            : searchResults.items.map((hit) => (
              <div key={hit.id} className="dshar_searchHit" title={hit.id}>
                {rowTitle(hit.id, hit.title)}
                <span className="dshar_rowMeta">
                  <span>{fmtDate(hit.createdAt)}</span>
                  {hit.cwd !== '' && <span title={hit.cwd}>{hit.cwd}</span>}
                </span>
                {hit.snippet !== '' && <div className="dshar_searchSnippet">{hit.snippet}</div>}
              </div>
            ))}
          {!searchResults.agentToolAvailable && (
            <div className="dshar_notice dshar_noticeWarn">{t('archives.search.noAgentTool')}</div>
          )}
        </div>
      )}

      {confirm !== null && (
        <div className="dshar_confirm" role="alertdialog" aria-label={confirm.kind === 'prune' ? t('archives.confirm.ariaPrune') : t('archives.confirm.ariaDelete')}>
          {confirm.kind === 'prune' ? (
            <span>{t('archives.confirm.prune', { count: confirm.count })}</span>
          ) : (
            <span>{t('archives.confirm.delete', { label: confirm.label, bytes: fmtBytes(confirm.bytes) })}</span>
          )}
          <span className="dshar_confirmActions">
            <button
              type="button"
              className={confirm.kind === 'prune' ? 'dshar_button' : 'dshar_button dshar_buttonDanger'}
              disabled={busy}
              onClick={() => { void onConfirm() }}
            >
              {busy
                ? (confirm.kind === 'prune' ? t('archives.confirm.pruneBusy') : t('archives.confirm.deleteBusy'))
                : (confirm.kind === 'prune' ? t('archives.confirm.pruneAction') : t('archives.confirm.deleteAction'))}
            </button>
            <button type="button" className="dshar_button" disabled={busy} onClick={() => { setConfirm(null) }}>
              {t('archives.confirm.cancel')}
            </button>
          </span>
        </div>
      )}

      {empty
        ? <div className="dshar_empty">{t('archives.empty')}</div>
        : list.groups.map((group) => (
          <GroupPanel key={group.cwd} group={group} busy={busy} onDeleteSessions={onDeleteSessions} t={t} />
        ))}
    </div>
  )
}
