/**
 * DSH APP session archive manager — settings-page section (client half UI).
 *
 * Layout: header totals → collapsible project groups (each a bordered panel:
 * clickable header with caret, project title + cwd, session rows with title,
 * date, size, and a delete that moves the session into the trash), with
 * per-project delete-all → the retention panel (the tier the trash is kept for,
 * the startup-sweep switch, usage and "sweep now") → the session trash panel
 * (entries with restore / delete-for-good, multi-select with a bulk bar, and an
 * empty-the-trash action).
 * Deletion is a two-step flow: every request first opens the confirmation
 * dialog (naming what will move and the bytes it carries, plus a
 * "stop running sessions first" checkbox), confirming POSTs the batch and
 * reloads the listing. The host re-checks every fence server-side, so a stale
 * UI can never delete a live or unarchived session; `stopFirst` is the one way a
 * running session may still be deleted, and it is a checkbox inside that dialog
 * rather than a second one because it changes WHAT the same delete does, not
 * whether it happens.
 *
 * ## The trash panel is where deletion stops being final
 *
 * `/delete` moves a session's log directory into the plugin's own trash instead
 * of unlinking it, so the panel below is the undo: each entry restores its
 * sessions to their original paths (and re-creates their archive records), and
 * only "delete for good" frees the bytes. Every confirmation on this page — the
 * delete and prune requests above, and those two irreversible trash actions —
 * is the host's own `Modal` + `Button` (never a hand-drawn mask and card),
 * because those are the surfaces where a misclick moves or frees data nobody
 * meant to touch.
 *
 * ## Two kinds of message, and only one of them is a banner
 *
 * A result the user just caused (a delete, a restore, a purge, a sweep, a saved
 * retention tier, and a failure of any of those) is an ANNOUNCEMENT: it goes
 * through the host's own `Toast`, which owns the banner, the hold, the fade and
 * the unmount, and it leaves nothing behind. A CONDITION the page is in — a
 * listing that would not load, a trash panel that would not load, a settings
 * file that cannot be understood — stays inline instead, because a banner that
 * vanishes would leave the reader believing the condition did too.
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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react'
import { Button, Checkbox, IconWarningOutlineRegular, Modal, Switch, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ArchiveDeleteResult,
  ArchiveGroup,
  ArchiveList,
  ArchivePruneResult,
  ArchivePurgeResult,
  ArchiveRestoreDeletedResult,
  ArchiveRestoreResult,
  ArchiveSettingsView,
  ArchiveSkipped,
  ArchiveSweepResult,
  ArchiveTrashEntry,
  ArchiveTrashList,
  HostText,
} from '../types.ts'
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
      /** Move these archived sessions' log directories into the trash. */
      kind: 'delete'
      /** Session ids the batch would move. */
      ids: string[]
      /** Human name of the target (one session's title, or a project's title). */
      label: string
      /** Bytes the batch would carry into the trash (measured at list time). */
      bytes: number
    }
  | {
      /** Drop stale archive records from the registry (logs already gone). */
      kind: 'prune'
      /** Stale records the action would drop (measured at list time). */
      count: number
    }

/**
 * A destructive trash action awaiting confirmation.
 *
 * These two are the page's only irreversible actions: everything the trash
 * offers besides them either restores a directory or drops a record (undoable by
 * archiving again), so only they and the delete/prune request above ask first.
 */
type TrashConfirmState =
  | {
      /** Delete one entry for good. */
      kind: 'purge'
      /** The entry the button belongs to. */
      entry: ArchiveTrashEntry
    }
  | {
      /** Delete the chosen entries for good (the multi-select bar). */
      kind: 'purgeMany'
      /** Entries the action would remove, measured when the dialog opened. */
      entries: number
      /** Sessions those entries hold. */
      sessions: number
      /** Bytes the action would free. */
      bytes: number
      /** Every selected row's own handle, which is what the route takes. */
      ids: string[]
    }
  | {
      /** Delete every entry for good. */
      kind: 'empty'
      /** Entries the action would remove (measured when the dialog opened). */
      entries: number
      /** Sessions those entries hold. */
      sessions: number
      /** Bytes the action would free. */
      bytes: number
      /** Every session id in the trash, which is what the route takes. */
      ids: string[]
    }
  | {
      /** Age every entry past the configured retention tier (irreversible). */
      kind: 'sweep'
      /** The tier the sweep will apply; `0` means it will do nothing. */
      days: number
      /** Entries currently in the trash (what the sentence makes concrete). */
      entries: number
      /** Bytes currently in the trash. */
      bytes: number
    }

/**
 * One transient outcome on screen.
 *
 * A result the user just caused is an ANNOUNCEMENT, not a state: it belongs to
 * the host's `Toast`, which owns the banner, the hold, the fade and the unmount.
 * A persistent condition — a listing that would not load, a settings file that
 * cannot be understood — is NOT this shape: it stays inline, because a banner
 * that disappears would leave the reader believing the condition went away too.
 */
interface ToastState {
  /**
   * Per-show sequence, and the `Toast`'s key.
   *
   * Showing the same sentence twice must replay the banner: keyed by text alone,
   * the second show would keep the first one's nearly-elapsed hold and vanish
   * before it could be read.
   */
  readonly seq: number
  /** Finished, already-localized sentence. */
  readonly text: string
  /** `success` brings the primitive's own check glyph; `warn` keeps its warning
   *  tint and the longer hold, because what it says has to be read. */
  readonly tone: 'success' | 'warn'
  /** Whether the sentence continues into the "go and look" control. */
  readonly viewTrash?: boolean
}

/** How long a success banner holds — the primitive's own announcement default. */
const TOAST_HOLD_MS = 3000

/**
 * How long a banner carrying a warning holds.
 *
 * The kernel's own "read this before acting" value (8s, `plugins/AGENTS.md` §6):
 * a skipped-id line names sessions the user has to find, and the 3s announcement
 * window is gone before that is possible.
 */
const TOAST_READ_HOLD_MS = 8000

/**
 * The controls a toast continues into, or `undefined` when it continues into none.
 *
 * The prefix is the dictionary's existing sentence joiner rather than a second
 * piece of punctuation written here: it is visible copy, and a language-sensitive
 * one (zh joins with a full-width mark, en with an ASCII one).
 * @param toast - the banner being shown.
 * @param t - this page's translate.
 * @param onViewTrash - scrolls to the trash panel the sentence pointed at.
 * @returns the `actions` seat of the primitive, or `undefined`.
 */
function toastActions(
  toast: ToastState,
  t: ArchivesTranslate,
  onViewTrash: () => void,
): readonly { label: string; prefix?: string; onClick: () => void }[] | undefined {
  if (toast.viewTrash !== true) return undefined
  return [{
    prefix: t('archives.notice.join.notices'),
    label: t('archives.notice.action.viewTrash'),
    onClick: onViewTrash,
  }]
}

/**
 * The retention tiers this page offers.
 *
 * A deliberate copy of the host's closed set (`src/settings.ts`): the route
 * refuses any other value, so a page offering one would be painting a button that
 * always fails. What the page SHOWS is still the value the host answered with,
 * because the host normalizes what it stores.
 */
const RETENTION_TIERS = [0, 7, 15, 30, 90] as const

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

/** Row title: the projection title, or a shortened id when untitled. The id
 * itself travels in the Tooltip — a native title= cannot carry it when the
 * visible text already is the id. */
function rowTitle(id: string, title: string): ReactNode {
  if (title !== '') {
    return (
      <Tooltip label={id} side="top">
        <span className="dshar_rowTitle">{title}</span>
      </Tooltip>
    )
  }
  const short = id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-6)}` : id
  return (
    <Tooltip label={id} side="top">
      <span className="dshar_rowTitle dshar_rowTitleUnnamed">{short}</span>
    </Tooltip>
  )
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
    'route.badStopFirst': t('archives.host.badStopFirst'),
    'route.listFailed': t('archives.host.listFailed', { detail }),
    'route.deleteFailed': t('archives.host.deleteFailed', { detail }),
    'route.trashFailed': t('archives.host.trashFailed', { detail }),
    'route.purgeFailed': t('archives.host.purgeFailed', { detail }),
    'route.restoreUnsupported': t('archives.host.restoreUnsupported'),
    'route.restoreFailed': t('archives.host.restoreFailed', { detail }),
    'route.restoreDeletedUnsupported': t('archives.host.restoreDeletedUnsupported'),
    'route.restoreDeletedFailed': t('archives.host.restoreDeletedFailed', { detail }),
    'route.pruneUnsupported': t('archives.host.pruneUnsupported'),
    'route.pruneFailed': t('archives.host.pruneFailed', { detail }),
    'route.sessionQueryUnavailable': t('archives.host.sessionQueryUnavailable'),
    'route.queryRequired': t('archives.host.queryRequired'),
    'route.searchFailed': t('archives.host.searchFailed', { detail }),
    'route.badRetentionDays': t('archives.host.badRetentionDays'),
    'route.badSweepOnStartup': t('archives.host.badSweepOnStartup'),
    'route.settingsFailed': t('archives.host.settingsFailed', { detail }),
    'route.settingsWriteFailed': t('archives.host.settingsWriteFailed', { detail }),
    'route.sweepFailed': t('archives.host.sweepFailed', { detail }),
  }, fallback)
}

/** Wire skip reasons → this page's dictionary keys (an unknown code shows raw). */
const SKIP_REASONS: Record<string, ArchivesKey> = {
  live: 'archives.skip.live',
  'not-archived': 'archives.skip.notArchived',
  missing: 'archives.skip.missing',
  io: 'archives.skip.io',
  unsupported: 'archives.skip.unsupported',
  'already-in-trash': 'archives.skip.alreadyInTrash',
  'not-in-trash': 'archives.skip.notInTrash',
  'target-exists': 'archives.skip.targetExists',
  'path-outside-root': 'archives.skip.pathOutsideRoot',
  'cross-device': 'archives.skip.crossDevice',
  concurrent: 'archives.skip.concurrent',
  'trash-interrupted': 'archives.skip.trashInterrupted',
  'trash-unconfirmed': 'archives.skip.trashUnconfirmed',
  'needs-root': 'archives.skip.needsRoot',
  'tree-too-large': 'archives.skip.treeTooLarge',
  'tree-unavailable': 'archives.skip.treeUnavailable',
  'still-running': 'archives.skip.stillRunning',
  'stop-failed': 'archives.skip.stopFailed',
}

/** Restore warning codes → this page's dictionary keys (an unknown code shows raw). */
const WARNING_COPY: Record<string, ArchivesKey> = {
  'trash-cleanup-failed': 'archives.trash.warn.cleanupFailed',
  'archive-record-failed': 'archives.trash.warn.recordFailed',
  'trash-member-already-home': 'archives.trash.warn.alreadyHome',
  'trash-member-lost': 'archives.trash.warn.lost',
  'projcache-cleanup-failed': 'archives.trash.warn.projcacheFailed',
  'projcache-shard-not-a-file': 'archives.trash.warn.projcacheNotAFile',
  'trash-time-mismatch': 'archives.trash.warn.timeMismatch',
}

/** Why a trash row offers no restore → this page's sentence. */
const RESTORE_BLOCK_COPY: Record<string, ArchivesKey> = {
  'no-payload': 'archives.trash.block.noPayload',
  unconfirmed: 'archives.trash.block.unconfirmed',
  'needs-root': 'archives.trash.block.needsRoot',
  'outside-root': 'archives.trash.block.outsideRoot',
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean; value?: T; error?: { message?: string; host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/** One project group panel: collapsible header with meta + restore/delete-all, then session rows. */
function GroupPanel({ group, busy, onDeleteSessions, onRestoreSessions, t }: {
  group: ArchiveGroup
  busy: boolean
  onDeleteSessions: (group: ArchiveGroup) => void
  onRestoreSessions: (group: ArchiveGroup) => void
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
        {group.cwd !== '' && (
          <Tooltip label={group.cwd} side="top" maxWidth={640}>
            <span className="dshar_groupPath">{group.cwd}</span>
          </Tooltip>
        )}
        <span className="dshar_groupMeta">
          <span>{t('archives.group.sessions', { count: group.sessions.length })}</span>
          <span>{fmtBytes(group.totalBytes)}</span>
          <button
            type="button"
            className="dshar_button"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); onRestoreSessions(group) }}
          >
            {t('archives.restoreAll')}
          </button>
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
              className="dshar_button"
              disabled={busy}
              onClick={() => { onRestoreSessions({ ...group, sessions: [session] }) }}
            >
              {t('archives.restore')}
            </button>
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
 * The trash rows: one line per entry, with restore and delete-for-good.
 *
 * A row is an ENTRY, not a session: one `/delete` call moves its whole batch
 * into one entry, and the host restores or purges an entry as a unit. Showing
 * the batch as one row is therefore the honest shape — a per-session row would
 * promise a per-session restore the storage layer does not offer.
 *
 * ## Multi-select is a MODE, and the bar is what says so
 *
 * The bulk actions live behind an explicit multi-select toggle rather than a
 * checkbox on every row: this panel's rows carry two destructive buttons each, and
 * a third always-present control beside them turns a 7px click into a data-loss
 * decision. In the mode, the header swaps the summary for select-all /
 * select-none / leave-mode, and a footer bar carries the two batch actions with
 * the count they would act on. Leaving the mode clears the selection — a hidden
 * selection that survives a mode change is how the next "delete for good" takes
 * rows nobody meant to mark.
 */
function TrashPanel({ list, busy, selected, onEnterSelect, onToggleSelected, onSelectAll, onSelectNone, onExitSelect, onBulkRestore, onBulkPurge, onRestore, onPurge, onEmpty, panelRef, t }: {
  list: ArchiveTrashList
  busy: boolean
  /** Selected row handles, or null when multi-select is off. */
  selected: readonly string[] | null
  onEnterSelect: () => void
  onToggleSelected: (trashId: string) => void
  onSelectAll: () => void
  onSelectNone: () => void
  onExitSelect: () => void
  onBulkRestore: () => void
  onBulkPurge: () => void
  onRestore: (entry: ArchiveTrashEntry) => void
  onPurge: (entry: ArchiveTrashEntry) => void
  onEmpty: () => void
  /** The panel's own element, so a sentence that points here can scroll to it. */
  panelRef: Ref<HTMLDivElement>
  t: ArchivesTranslate
}): ReactNode {
  const [expanded, setExpanded] = useState(true)
  const toggle = useCallback(() => { setExpanded((value) => !value) }, [])
  const onHeaderKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button') !== null) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  }, [toggle])
  const selecting = selected !== null
  const chosen = new Set(selected ?? [])
  /** The rows a batch action would name: what is marked, in listing order. */
  const chosenEntries = list.entries.filter((entry) => chosen.has(entry.trashId))
  const chosenBytes = chosenEntries.reduce((total, entry) => total + entry.totalBytes, 0)
  const chosenSessions = chosenEntries.reduce((count, entry) => count + entry.members.length, 0)
  return (
    <div ref={panelRef} className={`dshar_group ${expanded ? 'dshar_groupExpanded' : 'dshar_groupCollapsed'}`}>
      <div
        className="dshar_groupHeader"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={onHeaderKeyDown}
      >
        <span className="dshar_caret" aria-hidden="true" />
        <span className="dshar_groupTitle">{t('archives.trash.title')}</span>
        <span className="dshar_groupMeta">
          {selecting ? (
            <>
              <span>{t('archives.trash.selected', { count: chosen.size })}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || chosen.size === list.entries.length}
                onClick={(event) => { event.stopPropagation(); onSelectAll() }}
              >
                {t('archives.trash.selectAll')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || chosen.size === 0}
                onClick={(event) => { event.stopPropagation(); onSelectNone() }}
              >
                {t('archives.trash.selectNone')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={(event) => { event.stopPropagation(); onExitSelect() }}
              >
                {t('archives.trash.selectExit')}
              </Button>
            </>
          ) : (
            <>
              <span>
                {t('archives.trash.summary', {
                  entries: list.entries.length,
                  sessions: list.sessionCount,
                  bytes: fmtBytes(list.totalBytes),
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || list.entries.length === 0}
                onClick={(event) => { event.stopPropagation(); onEnterSelect() }}
              >
                {t('archives.trash.selectMode')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="dshar_btnDanger"
                disabled={busy || list.entries.length === 0}
                onClick={(event) => { event.stopPropagation(); onEmpty() }}
              >
                {t('archives.trash.emptyAll')}
              </Button>
            </>
          )}
        </span>
      </div>
      {expanded && (list.entries.length === 0
        ? <div className="dshar_empty">{t('archives.trash.empty')}</div>
        : list.entries.map((entry) => (
          <div className="dshar_row" key={entry.trashId}>
            {selecting && (
              <Checkbox
                className="dshar_selectCell"
                checked={chosen.has(entry.trashId)}
                disabled={busy}
                label={t('archives.trash.selectRow', { label: entryLabel(entry, t) })}
                onChange={() => { onToggleSelected(entry.trashId) }}
              />
            )}
            {entry.members.length === 1
              ? rowTitle(entry.members[0].sessionId, entry.members[0].title)
              : entry.members.length === 0
                ? (
                  <span className="dshar_rowTitle">
                    {entry.state === 'unverified'
                      ? t('archives.trash.unverifiedRow')
                      : t('archives.trash.leftover')}
                  </span>
                  )
                : <span className="dshar_rowTitle">{t('archives.trash.rowMany', { count: entry.members.length })}</span>}
            <span className="dshar_rowMeta">
              {entry.state === 'interrupted' && (
                <Tooltip label={t('archives.trash.interruptedHint')} side="top" maxWidth={520}>
                  <span className="dshar_trashInterrupted">
                    {t('archives.trash.interrupted', { count: entry.members.filter((member) => member.present).length })}
                  </span>
                </Tooltip>
              )}
              {entry.state === 'purging' && (
                <Tooltip label={t('archives.trash.purgingHint')} side="top" maxWidth={520}>
                  <span className="dshar_trashInterrupted">{t('archives.trash.purging')}</span>
                </Tooltip>
              )}
              {entry.state === 'unverified' && (
                <Tooltip label={t('archives.trash.unverifiedHint')} side="top" maxWidth={520}>
                  <span className="dshar_trashInterrupted">{t('archives.trash.unverified')}</span>
                </Tooltip>
              )}
              <span>{t('archives.trash.deletedAt', { date: fmtDate(Date.parse(entry.deletedAt)) })}</span>
              <span>{fmtBytes(entry.totalBytes)}</span>
              {/* A restore is offered only when a request would actually do
                  something: `restorable` is answered by the host per request,
                  from the payload and the sessions root it can see. A row that
                  cannot be restored says why instead of offering a button that
                  fails every time — and "delete for good" stays available, since
                  a row that can be listed must always have a way out. */}
              {entry.state !== 'purging' && !entry.restorable && entry.restorableBlock !== undefined && (
                <Tooltip label={t('archives.trash.blockHint')} side="top" maxWidth={520}>
                  <span className="dshar_trashInterrupted">
                    {RESTORE_BLOCK_COPY[entry.restorableBlock] === undefined
                      ? entry.restorableBlock
                      : t(RESTORE_BLOCK_COPY[entry.restorableBlock])}
                  </span>
                </Tooltip>
              )}
              {entry.state !== 'purging' && entry.restorable && !selecting && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onRestore(entry) }}>
                  {t('archives.trash.restore')}
                </Button>
              )}
              {!selecting && (
                <Button
                  variant="outline"
                  size="sm"
                  className="dshar_btnDanger"
                  disabled={busy}
                  onClick={() => { onPurge(entry) }}
                >
                  {entry.state === 'purging' ? t('archives.trash.retryPurge') : t('archives.trash.purge')}
                </Button>
              )}
            </span>
          </div>
        )))}
      {expanded && selecting && list.entries.length > 0 && (
        <div className="dshar_bulkBar" role="group" aria-label={t('archives.trash.bulkAria')}>
          <span className="dshar_bulkCount">
            {t('archives.trash.bulkSummary', {
              entries: chosen.size,
              sessions: chosenSessions,
              bytes: fmtBytes(chosenBytes),
            })}
          </span>
          <Button variant="ghost" size="sm" disabled={busy || chosen.size === 0} onClick={onBulkRestore}>
            {t('archives.trash.bulkRestore')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="dshar_btnDanger"
            disabled={busy || chosen.size === 0}
            onClick={onBulkPurge}
          >
            {t('archives.trash.bulkPurge')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * What one trash row is called, for a control that needs a name.
 *
 * The same three-way answer the row's own title uses (a member's title, the batch
 * count, or the leftover's label) — a checkbox labelled "select row 3" tells a
 * screen reader nothing about WHICH row.
 * @param entry - the row.
 * @param t - this page's translate.
 * @returns the label text.
 */
function entryLabel(entry: ArchiveTrashEntry, t: ArchivesTranslate): string {
  if (entry.members.length === 1) {
    return entry.members[0].title !== '' ? entry.members[0].title : entry.members[0].sessionId
  }
  if (entry.members.length === 0) {
    return entry.state === 'unverified' ? t('archives.trash.unverifiedRow') : t('archives.trash.leftover')
  }
  return t('archives.trash.rowMany', { count: entry.members.length })
}

/**
 * The address a row's requests carry: its OWN trash id.
 *
 * One rule for every row, which is what makes a listed row always clearable: the
 * trash id is the entry's identity on disk, so the same request works for a batch,
 * for a row whose members are all gone, and for an unfinished deletion whose
 * metadata is gone. The host also accepts a present member's session id (a caller
 * that has one may use it), but this page never has to choose between the two —
 * and choosing the member ids is what used to leave those rows unreachable.
 */
function rowAddress(entry: ArchiveTrashEntry): string[] {
  return [entry.trashId]
}

/**
 * One batch's skipped ids, counted per reason, as the sentence the page shows.
 *
 * Counting alone hides two things the host already told us, and both are what a
 * user needs to act: WHICH sessions a tree-level refusal was about (`sessions` —
 * a busy subagent child, a member still parked) and WHAT the host's own diagnostic
 * says (`detail`, English by design: the host never sends prose). They are data,
 * so they are rendered verbatim after the counted line.
 */
function skippedNotice(skipped: readonly ArchiveSkipped[], t: ArchivesTranslate): string {
  const counts = new Map<string, number>()
  for (const skip of skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1)
  const reasons = [...counts]
    // An unknown reason code has no key of its own: show the code raw.
    .map(([reason, count]) => `${SKIP_REASONS[reason] === undefined ? reason : t(SKIP_REASONS[reason])} × ${count}`)
    .join(t('archives.notice.join.reasons'))
  const head = t('archives.notice.skipped', { count: skipped.length, reasons })
  const lines = skipped.flatMap((skip) => {
    const notes: string[] = []
    if (skip.sessions !== undefined && skip.sessions.length > 0) {
      notes.push(t('archives.notice.skippedSessions', { ids: skip.sessions.join(t('archives.notice.join.reasons')) }))
    }
    if (skip.detail !== undefined && skip.detail !== '') {
      notes.push(t('archives.notice.skippedDetail', { detail: skip.detail }))
    }
    return notes.length === 0
      ? []
      : [t('archives.notice.skipLine', { id: skip.id, notes: notes.join(t('archives.notice.join.notices')) })]
  })
  return lines.length === 0 ? head : `${head} ${lines.join(t('archives.notice.join.notices'))}`
}

/** The non-fatal problems of a restore, counted per code. */
function warningsNotice(warnings: ReadonlyArray<{ code: string }>, t: ArchivesTranslate): string {
  const counts = new Map<string, number>()
  for (const warning of warnings) counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1)
  const items = [...counts]
    .map(([code, count]) => `${WARNING_COPY[code] === undefined ? code : t(WARNING_COPY[code])} × ${count}`)
    .join(t('archives.notice.join.reasons'))
  return t('archives.trash.warn.list', { items })
}

/**
 * The settings section: load the grouped listing on mount, confirm-and-move to
 * the trash, the trash panel below it, plus a cross-session full-text search
 * panel (GET /search?q=...).
 */
export function ArchivesSection({ t }: ArchivesSectionProps): ReactNode {
  const [list, setList] = useState<ArchiveList | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** The one transient outcome on screen (see {@link ToastState}). */
  const [toast, setToast] = useState<ToastState | null>(null)
  /** The sequence the last banner was shown with: one per show, never reused. */
  const toastSeq = useRef(0)
  /** The trash panel, which the delete sentence's "view" control scrolls to. */
  const trashPanel = useRef<HTMLDivElement | null>(null)
  const [trash, setTrash] = useState<ArchiveTrashList | null>(null)
  const [trashError, setTrashError] = useState<Failure | null>(null)
  const [trashBusy, setTrashBusy] = useState(false)
  const [trashConfirm, setTrashConfirm] = useState<TrashConfirmState | null>(null)
  /** Selected trash rows, or null when multi-select is off (see `TrashPanel`). */
  const [selected, setSelected] = useState<string[] | null>(null)
  /** The delete dialog's "stop running sessions first" answer. */
  const [stopFirst, setStopFirst] = useState(false)
  const [settings, setSettings] = useState<ArchiveSettingsView | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  /** A failed /settings read, rendered through the dictionary like every notice. */
  const [settingsError, setSettingsError] = useState<Failure | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ items: Array<{ id: string; title: string; createdAt: number; cwd: string; snippet: string }>; agentToolAvailable: boolean } | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)

  /**
   * Show one transient outcome.
   *
   * Every show takes the next sequence number, and that number is the `Toast`'s
   * key: a repeated sentence must restart the banner instead of inheriting the
   * first one's nearly-elapsed hold.
   * @param text - the finished, already-localized sentence.
   * @param tone - `success` for work that finished clean, `warn` for a result
   *   carrying skipped ids or a warning (it also earns the longer hold).
   * @param options.viewTrash - append the "go and look at the trash" control.
   */
  const showToast = useCallback((
    text: string,
    tone: ToastState['tone'],
    options?: { readonly viewTrash?: boolean },
  ) => {
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text,
      tone,
      ...(options?.viewTrash === true ? { viewTrash: true } : {}),
    })
  }, [])

  /**
   * Unmount the banner that reported `seq`, and only that one.
   *
   * A fade that finishes late must not clear the banner a newer action just
   * raised, which is what an unconditional `setToast(null)` would do.
   * @param seq - the sequence the fading banner was shown with.
   */
  const dismissToast = useCallback((seq: number) => {
    setToast((current) => (current !== null && current.seq === seq ? null : current))
  }, [])

  /**
   * Scroll to the trash panel the delete sentence pointed at.
   *
   * The banner goes first: the press acknowledges the sentence, and a banner
   * hovering over the panel it just scrolled to would sit on top of the very
   * thing it was talking about.
   */
  const onViewTrash = useCallback(() => {
    setToast(null)
    trashPanel.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])

  const load = useCallback(async () => {
    try {
      setList(await fetchJson<ArchiveList>(`${ROUTE_PREFIX}/list`))
      setError(null)
    } catch (loadError) {
      setError(asFailure(loadError))
    }
    try {
      setTrash(await fetchJson<ArchiveTrashList>(`${ROUTE_PREFIX}/trash`))
      setTrashError(null)
    } catch (trashLoadError) {
      // The trash is the page's second surface: its failure must not blank the
      // archive listing, which is what this page is for. The panel says so
      // itself instead.
      setTrashError(asFailure(trashLoadError))
    }
    try {
      setSettings(await fetchJson<ArchiveSettingsView>(`${ROUTE_PREFIX}/settings`))
      setSettingsError(null)
    } catch (settingsFailure) {
      // The retention panel is the page's third surface, and its own failure is
      // reported in its own notice: a kernel that cannot answer it must not blank
      // the listing or the trash.
      setSettingsError(asFailure(settingsFailure))
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

  /** Open the confirmation dialog for one session or a whole project group. */
  const onDeleteSessions = useCallback((group: ArchiveGroup) => {
    const ids = group.sessions.map((session) => session.id)
    const bytes = group.sessions.reduce((total, session) => total + session.sizeBytes, 0)
    const label = group.sessions.length === 1 && group.sessions[0].title !== ''
      ? t('archives.target.session', { title: group.sessions[0].title })
      : t('archives.target.group', { title: groupHeading(group, t), count: ids.length })
    setConfirm({ kind: 'delete', ids, label, bytes })
  }, [t])

  /**
   * Restore one session (or a whole group) out of the archive.
   *
   * No confirmation dialog, deliberately: a delete moves a whole log directory
   * and earns the pause, while restoring only drops an id from the archive set
   * and never touches the stored log — so it is undoable by archiving again.
   * Making the user confirm a reversible action is how a dialog teaches people
   * to click through dialogs.
   */
  const onRestoreSessions = useCallback(async (group: ArchiveGroup) => {
    setBusy(true)
    try {
      const result = await fetchJson<ArchiveRestoreResult>(`${ROUTE_PREFIX}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: group.sessions.map((session) => session.id) }),
      })
      const parts = [t('archives.notice.restored', { count: result.restored.length })]
      if (result.skipped.length > 0) parts.push(skippedNotice(result.skipped, t))
      showToast(
        parts.join(t('archives.notice.join.notices')),
        result.skipped.length > 0 ? 'warn' : 'success',
      )
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      // A failed restore must not blank the listing: surface it as a banner, the
      // same way a failed prune is reported.
      showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
    } finally {
      setBusy(false)
    }
  }, [load, showToast, t])

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
        showToast(t('archives.notice.pruned', { count: result.pruned }), 'success')
      } else {
        const result = await fetchJson<ArchiveDeleteResult>(`${ROUTE_PREFIX}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // `stopFirst` travels only when the box is ticked: the host refuses a
          // non-boolean, and an always-present `false` would read as a decision the
          // user never made.
          body: JSON.stringify({ ids: confirm.ids, ...(stopFirst ? { stopFirst: true } : {}) }),
        })
        const parts = [t('archives.notice.trashed', { count: result.deleted.length, bytes: fmtBytes(result.freedBytes) })]
        // The archive records are KEPT (they are what hides these sessions from the
        // sidebar), so the header's stale-record hint just grew by these ids. Say so:
        // "Prune" is how they go.
        if (result.deleted.length > 0) parts.push(t('archives.notice.recordsKept'))
        if (result.skipped.length > 0) parts.push(skippedNotice(result.skipped, t))
        showToast(
          parts.join(t('archives.notice.join.notices')),
          result.skipped.length > 0 ? 'warn' : 'success',
          // The sentence says "restore them below", so it ends with the control
          // that goes there — the panel may well be off screen.
          { viewTrash: true },
        )
      }
      setConfirm(null)
      setStopFirst(false)
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      if (kind === 'prune') {
        // A failed prune (e.g. an older kernel without the write path) must
        // not blank the listing — surface it as a banner.
        showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
        setConfirm(null)
      } else {
        setError(failure)
      }
    } finally {
      setBusy(false)
    }
  }, [confirm, load, showToast, stopFirst, t])

  /**
   * Restore one trash entry: the sessions go back to their original paths and
   * their archive records come back, so they land in this page's own listing.
   *
   * No confirm dialog, for the same reason archiving a session has none: it is
   * undoable by deleting again, and the pause belongs on the action that cannot
   * be walked back.
   */
  const onRestoreEntry = useCallback(async (entry: ArchiveTrashEntry) => {
    setTrashBusy(true)
    try {
      const result = await fetchJson<ArchiveRestoreDeletedResult>(`${ROUTE_PREFIX}/restore-deleted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: rowAddress(entry) }),
      })
      const parts = [t('archives.trash.notice.restored', { count: result.restored.length })]
      // Warnings first: they describe work that DID happen with a caveat, and a
      // skipped-id line underneath reads as a list of what did not.
      if (result.warnings.length > 0) parts.push(warningsNotice(result.warnings, t))
      if (result.skipped.length > 0) parts.push(skippedNotice(result.skipped, t))
      showToast(
        parts.join(t('archives.notice.join.notices')),
        result.warnings.length > 0 || result.skipped.length > 0 ? 'warn' : 'success',
      )
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
    } finally {
      setTrashBusy(false)
    }
  }, [load, showToast, t])

  /** Ask before the one action on this page that cannot be undone. */
  const onPurgeEntry = useCallback((entry: ArchiveTrashEntry) => {
    setTrashConfirm({ kind: 'purge', entry })
  }, [])

  /** Ask before emptying the whole trash. */
  const onEmptyTrash = useCallback(() => {
    if (trash === null || trash.entries.length === 0) return
    setTrashConfirm({
      kind: 'empty',
      entries: trash.entries.length,
      sessions: trash.sessionCount,
      bytes: trash.totalBytes,
      ids: trash.entries.flatMap((entry) => rowAddress(entry)),
    })
  }, [trash])

  /**
   * Run the sweep (POST /sweep) — the same implementation the startup sweep uses.
   *
   * Declared before {@link onConfirmTrash}: that dialog dispatches to it, and a
   * `const` read before its own initializer is a render-time crash, not a lint
   * warning.
   */
  const onConfirmSweep = useCallback(async () => {
    setTrashBusy(true)
    try {
      const result = await fetchJson<ArchiveSweepResult>(`${ROUTE_PREFIX}/sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const parts = [result.purged.length === 0
        ? t('archives.retention.notice.nothing')
        : t('archives.retention.notice.swept', { count: result.purged.length, bytes: fmtBytes(result.freedBytes) })]
      if (result.warnings.length > 0) parts.push(warningsNotice(result.warnings, t))
      if (result.skipped.length > 0) parts.push(skippedNotice(result.skipped, t))
      showToast(
        parts.join(t('archives.notice.join.notices')),
        result.warnings.length > 0 || result.skipped.length > 0 ? 'warn' : 'success',
      )
      setTrashConfirm(null)
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
      setTrashConfirm(null)
    } finally {
      setTrashBusy(false)
    }
  }, [load, showToast, t])

  /** Ask before the sweep: it is a purge, so it earns the same dialog. */
  const onAskSweep = useCallback(() => {
    if (settings === null) return
    setTrashConfirm({
      kind: 'sweep',
      days: settings.settings.retentionDays,
      entries: trash?.entries.length ?? 0,
      bytes: trash?.totalBytes ?? 0,
    })
  }, [settings, trash])

  /** Confirm the pending trash action: POST, surface the outcome, reload. */
  const onConfirmTrash = useCallback(async () => {
    if (trashConfirm === null) return
    // The sweep is its own route, and its dialog carries no ids: hand it over
    // before the purge path reads a field it does not have.
    if (trashConfirm.kind === 'sweep') {
      await onConfirmSweep()
      return
    }
    const state = trashConfirm
    const ids = state.kind === 'purge' ? rowAddress(state.entry) : state.ids
    setTrashBusy(true)
    try {
      const result = await fetchJson<ArchivePurgeResult>(`${ROUTE_PREFIX}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const parts = [state.kind === 'empty'
        ? t('archives.trash.notice.emptied', { bytes: fmtBytes(result.freedBytes) })
        : state.kind === 'purgeMany'
          ? t('archives.trash.notice.purgedMany', { count: result.purged.length, bytes: fmtBytes(result.freedBytes) })
          : t('archives.trash.notice.purged', { count: result.purged.length, bytes: fmtBytes(result.freedBytes) })]
      // Warnings describe work that DID happen with something left behind (a
      // cache shard that would not go); the skipped ids are what did not happen.
      if (result.warnings.length > 0) parts.push(warningsNotice(result.warnings, t))
      if (result.skipped.length > 0) parts.push(skippedNotice(result.skipped, t))
      showToast(
        parts.join(t('archives.notice.join.notices')),
        result.warnings.length > 0 || result.skipped.length > 0 ? 'warn' : 'success',
      )
      setTrashConfirm(null)
      // The rows that are gone cannot stay marked, and a stale selection is what
      // the next batch action would act on.
      setSelected(state.kind === 'purgeMany' ? [] : null)
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
      setTrashConfirm(null)
    } finally {
      setTrashBusy(false)
    }
  }, [load, onConfirmSweep, showToast, t, trashConfirm])

  // --- multi-select on the trash panel -------------------------------------

  /** Enter the mode with nothing marked: a selection nobody made is a surprise. */
  const onEnterSelect = useCallback(() => {
    setSelected([])
  }, [])

  const onToggleSelected = useCallback((trashId: string) => {
    setSelected((current) => current === null
      ? [trashId]
      : current.includes(trashId)
        ? current.filter((id) => id !== trashId)
        : [...current, trashId])
  }, [])

  /** Every row the panel is showing — the only rows a "select all" may mean. */
  const onSelectAll = useCallback(() => {
    setSelected(trash === null ? [] : trash.entries.map((entry) => entry.trashId))
  }, [trash])

  const onSelectNone = useCallback(() => { setSelected([]) }, [])

  /** Leaving the mode clears the selection: see `TrashPanel`. */
  const onExitSelect = useCallback(() => { setSelected(null) }, [])

  /** Restore every marked row, in one request (the host restores one entry each). */
  const onBulkRestore = useCallback(async () => {
    if (selected === null || selected.length === 0) return
    setTrashBusy(true)
    try {
      const result = await fetchJson<ArchiveRestoreDeletedResult>(`${ROUTE_PREFIX}/restore-deleted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selected }),
      })
      const parts = [t('archives.trash.notice.restored', { count: result.restored.length })]
      if (result.warnings.length > 0) parts.push(warningsNotice(result.warnings, t))
      if (result.skipped.length > 0) parts.push(skippedNotice(result.skipped, t))
      showToast(
        parts.join(t('archives.notice.join.notices')),
        result.warnings.length > 0 || result.skipped.length > 0 ? 'warn' : 'success',
      )
      setSelected([])
      await load()
    } catch (actionError) {
      const failure = asFailure(actionError)
      showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
    } finally {
      setTrashBusy(false)
    }
  }, [load, selected, showToast, t])

  /** Ask before the irreversible batch action, with the numbers it would take. */
  const onBulkPurge = useCallback(() => {
    if (trash === null || selected === null || selected.length === 0) return
    const chosen = new Set(selected)
    const rows = trash.entries.filter((entry) => chosen.has(entry.trashId))
    setTrashConfirm({
      kind: 'purgeMany',
      entries: rows.length,
      sessions: rows.reduce((count, entry) => count + entry.members.length, 0),
      bytes: rows.reduce((total, entry) => total + entry.totalBytes, 0),
      ids: [...selected],
    })
  }, [selected, trash])

  // --- retention ------------------------------------------------------------

  /**
   * Write one setting.
   *
   * A write is confirmed by the reloaded value, not by optimism: the host
   * normalizes what it stores (`./settings.ts`, where `0` is a real tier and a
   * malformed field falls back), and the panel then shows what it will actually
   * use.
   */
  const onSaveSettings = useCallback(async (next: { retentionDays?: number; sweepOnStartup?: boolean }) => {
    if (settings === null) return
    setSettingsBusy(true)
    try {
      const view = await fetchJson<ArchiveSettingsView>(`${ROUTE_PREFIX}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          retentionDays: next.retentionDays ?? settings.settings.retentionDays,
          sweepOnStartup: next.sweepOnStartup ?? settings.settings.sweepOnStartup,
        }),
      })
      setSettings(view)
      showToast(t('archives.retention.notice.saved'), 'success')
    } catch (settingsError) {
      const failure = asFailure(settingsError)
      showToast(routeErrorCopy(t, failure.host, failure.fallback), 'warn')
    } finally {
      setSettingsBusy(false)
    }
  }, [settings, showToast, t])

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
          <Tooltip label={t('archives.stale.hint')} side="bottom">
            <span className="dshar_staleHint">
              {t('archives.stale.count', { count: list.staleCount })}
              <button
                type="button"
                className="dshar_button"
                disabled={busy}
                onClick={() => { setConfirm({ kind: 'prune', count: list.staleCount }) }}
              >
                {t('archives.prune')}
              </button>
            </span>
          </Tooltip>
        )}
      </div>

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
              <div key={hit.id} className="dshar_searchHit">
                {rowTitle(hit.id, hit.title)}
                <span className="dshar_rowMeta">
                  <span>{fmtDate(hit.createdAt)}</span>
                  {hit.cwd !== '' && (
                    <Tooltip label={hit.cwd} side="top" maxWidth={640}>
                      <span>{hit.cwd}</span>
                    </Tooltip>
                  )}
                </span>
                {hit.snippet !== '' && <div className="dshar_searchSnippet">{hit.snippet}</div>}
              </div>
            ))}
          {!searchResults.agentToolAvailable && (
            <div className="dshar_notice dshar_noticeWarn">{t('archives.search.noAgentTool')}</div>
          )}
        </div>
      )}

      {/* The pending delete / prune confirmation, in the host's own dialog
          primitive: the mask, blur, elevation, focus trap, Escape and the modal
          layer come with it, and it is the same shape as the trash dialogs
          below. This page styles only the sentence and the one checkbox. */}
      <Modal
        open={confirm !== null}
        onClose={() => { if (!busy) { setConfirm(null); setStopFirst(false) } }}
        title={confirm === null
          ? ''
          : confirm.kind === 'prune'
            ? t('archives.confirm.ariaPrune')
            : t('archives.confirm.ariaDelete')}
        closeLabel={t('archives.confirm.cancel')}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => { setConfirm(null); setStopFirst(false) }}
            >
              {t('archives.confirm.cancel')}
            </Button>
            <Button
              variant="primary"
              // Prune only drops archive records whose logs are already gone — no
              // bytes are released, so it must not wear the destructive fill. Red is
              // reserved for the branch that really deletes data.
              className={confirm?.kind === 'prune' ? undefined : 'dshar_dangerPrimary'}
              disabled={busy}
              onClick={() => { void onConfirm() }}
            >
              {busy
                ? (confirm?.kind === 'prune' ? t('archives.confirm.pruneBusy') : t('archives.confirm.deleteBusy'))
                : (confirm?.kind === 'prune' ? t('archives.confirm.pruneAction') : t('archives.confirm.deleteAction'))}
            </Button>
          </>
        )}
      >
        <p className="dshar_modalBody">
          {confirm === null
            ? ''
            : confirm.kind === 'prune'
              ? t('archives.confirm.prune', { count: confirm.count })
              : t('archives.confirm.delete', { label: confirm.label, bytes: fmtBytes(confirm.bytes) })}
        </p>
        {/* A running session is skipped unless the delete is allowed to stop it
            first, and that changes WHAT this same confirm does — so it is a
            checkbox inside this dialog, not a second dialog. */}
        {confirm?.kind === 'delete' && (
          <div className="dshar_confirmOption">
            <Checkbox
              checked={stopFirst}
              disabled={busy}
              label={t('archives.confirm.stopFirst')}
              onChange={setStopFirst}
            />
            <span className="dshar_confirmHint">{t('archives.confirm.stopFirstHint')}</span>
          </div>
        )}
      </Modal>

      {empty
        ? <div className="dshar_empty">{t('archives.empty')}</div>
        : list.groups.map((group) => (
          <GroupPanel key={group.cwd} group={group} busy={busy} onDeleteSessions={onDeleteSessions} onRestoreSessions={(target) => { void onRestoreSessions(target) }} t={t} />
        ))}

      {/* The retention policy: how long the trash is kept, whether it is swept at
          startup, what it currently holds, and the button that runs the same sweep
          now. Every value shown is what the host will actually use (it normalizes
          on write and on read), not what this page wished it had stored. */}
      <div className="dshar_group">
        <div className="dshar_groupHeader dshar_groupHeaderStatic">
          <span className="dshar_groupTitle">{t('archives.retention.title')}</span>
          <span className="dshar_groupMeta">
            <Button
              variant="outline"
              size="sm"
              className="dshar_btnDanger"
              disabled={settingsBusy || settings === null}
              onClick={onAskSweep}
            >
              {t('archives.retention.sweep')}
            </Button>
          </span>
        </div>
        {settingsError !== null && (
          <div className="dshar_notice dshar_noticeWarn">{routeErrorCopy(t, settingsError.host, settingsError.fallback)}</div>
        )}
        {settings === null
          ? <div className="dshar_empty">{t('archives.retention.loading')}</div>
          : (
            <div className="dshar_retention">
              {settings.malformed && (
                <div className="dshar_notice dshar_noticeWarn">{t('archives.retention.malformed')}</div>
              )}
              <div className="dshar_tierRow">
                <span className="dshar_tierLabel">{t('archives.retention.days')}</span>
                <span className="dshar_tierGroup" role="group" aria-label={t('archives.retention.days')}>
                  {RETENTION_TIERS.map((days) => (
                    <button
                      key={days}
                      type="button"
                      className={`dshar_tier ${settings.settings.retentionDays === days ? 'dshar_tierOn' : ''}`}
                      aria-pressed={settings.settings.retentionDays === days}
                      disabled={settingsBusy}
                      onClick={() => { void onSaveSettings({ retentionDays: days }) }}
                    >
                      {days === 0 ? t('archives.retention.day.forever') : t('archives.retention.day.days', { days })}
                    </button>
                  ))}
                </span>
              </div>
              <div className="dshar_tierRow">
                <Switch
                  checked={settings.settings.sweepOnStartup}
                  disabled={settingsBusy}
                  label={t('archives.retention.sweepOnStartup')}
                  onChange={(next) => { void onSaveSettings({ sweepOnStartup: next }) }}
                />
              </div>
              <div className="dshar_retentionUsage">
                {t('archives.retention.usage', {
                  entries: trash?.entries.length ?? 0,
                  sessions: trash?.sessionCount ?? 0,
                  bytes: fmtBytes(trash?.totalBytes ?? 0),
                })}
                {trash?.oldestDeletedAt !== undefined && trash.newestDeletedAt !== undefined && (
                  <span className="dshar_retentionSpan">
                    {t('archives.retention.usageSpan', {
                      oldest: fmtDate(Date.parse(trash.oldestDeletedAt)),
                      newest: fmtDate(Date.parse(trash.newestDeletedAt)),
                    })}
                  </span>
                )}
              </div>
            </div>
          )}
      </div>

      {/* The trash: what deletion actually did, and the way back. */}
      {trashError !== null
        ? <div className="dshar_notice dshar_noticeWarn">{routeErrorCopy(t, trashError.host, trashError.fallback)}</div>
        : trash === null
          ? <div className="dshar_empty">{t('archives.loading')}</div>
          : (
            <TrashPanel
              list={trash}
              busy={trashBusy}
              selected={selected}
              onEnterSelect={onEnterSelect}
              onToggleSelected={onToggleSelected}
              onSelectAll={onSelectAll}
              onSelectNone={onSelectNone}
              onExitSelect={onExitSelect}
              onBulkRestore={() => { void onBulkRestore() }}
              onBulkPurge={onBulkPurge}
              onRestore={(entry) => { void onRestoreEntry(entry) }}
              onPurge={onPurgeEntry}
              onEmpty={onEmptyTrash}
              panelRef={trashPanel}
              t={t}
            />
          )}

      {/* A result the user just caused is an ANNOUNCEMENT, so it goes through the
          host's own `Toast`: the banner, its hold, its fade and its unmount are
          the primitive's, and this page draws none of them. It sits at the
          section's root rather than inside a panel — a panel that is collapsed or
          unmounted must not take the message with it — and it is the primitive
          itself, not a wrapper around one. */}
      {toast !== null && (
        <Toast
          // The sequence is the key: the same sentence twice must replay the
          // banner instead of inheriting the first one's nearly-elapsed hold.
          key={toast.seq}
          text={toast.text}
          // `tone` is only ever `success` on this primitive: it swaps in the
          // design's own check glyph. A warning takes the `icon` seat instead —
          // that is where the warning tint lives — and the longer hold below,
          // because what it says has to be read.
          {...(toast.tone === 'success'
            ? { tone: 'success' as const }
            : { icon: <IconWarningOutlineRegular /> })}
          holdMs={toast.tone === 'warn' ? TOAST_READ_HOLD_MS : TOAST_HOLD_MS}
          actions={toastActions(toast, t, onViewTrash)}
          onDone={() => { dismissToast(toast.seq) }}
        />
      )}

      {/* The host's own dialog primitive: mask, blur, elevation, focus trap,
          Escape and the modal layer come with it, and a theme change is free.
          This page styles only the sentence inside. */}
      <Modal
        open={trashConfirm !== null}
        onClose={() => { if (!trashBusy) setTrashConfirm(null) }}
        title={trashConfirm === null
          ? ''
          : trashConfirm.kind === 'empty'
            ? t('archives.trash.confirm.emptyTitle')
            : trashConfirm.kind === 'purgeMany'
              ? t('archives.trash.confirm.bulkTitle')
              : trashConfirm.kind === 'sweep'
                ? t('archives.retention.confirm.title')
                : t('archives.trash.confirm.purgeTitle')}
        closeLabel={t('archives.trash.confirm.cancel')}
        footer={(
          <>
            <Button variant="outline" disabled={trashBusy} onClick={() => { setTrashConfirm(null) }}>
              {t('archives.trash.confirm.cancel')}
            </Button>
            <Button
              variant="primary"
              className="dshar_dangerPrimary"
              disabled={trashBusy || (trashConfirm?.kind === 'sweep' && trashConfirm.days === 0)}
              onClick={() => { void onConfirmTrash() }}
            >
              {trashBusy
                ? t('archives.trash.confirm.busy')
                : (trashConfirm === null
                  ? t('archives.trash.confirm.purgeAction')
                  : trashConfirm.kind === 'empty'
                    ? t('archives.trash.confirm.emptyAction')
                    : trashConfirm.kind === 'purgeMany'
                      ? t('archives.trash.confirm.bulkAction')
                      : trashConfirm.kind === 'sweep'
                        ? t('archives.retention.confirm.action')
                        : t('archives.trash.confirm.purgeAction'))}
            </Button>
          </>
        )}
      >
        <p className="dshar_modalBody">
          {trashConfirm === null
            ? ''
            : trashConfirm.kind === 'empty'
              ? t('archives.trash.confirm.emptyBody', {
                entries: trashConfirm.entries,
                sessions: trashConfirm.sessions,
                bytes: fmtBytes(trashConfirm.bytes),
              })
              : trashConfirm.kind === 'purgeMany'
                ? t('archives.trash.confirm.bulkBody', {
                  entries: trashConfirm.entries,
                  sessions: trashConfirm.sessions,
                  bytes: fmtBytes(trashConfirm.bytes),
                })
                : trashConfirm.kind === 'sweep'
                  // `0` is the "keep for ever" tier: the sweep would do nothing, and
                  // the dialog says so instead of asking to confirm a no-op.
                  ? (trashConfirm.days === 0
                    ? t('archives.retention.confirm.bodyForever')
                    : t('archives.retention.confirm.body', {
                      days: trashConfirm.days,
                      entries: trashConfirm.entries,
                      bytes: fmtBytes(trashConfirm.bytes),
                    }))
                  : t('archives.trash.confirm.purgeBody', {
                    label: entryLabel(trashConfirm.entry, t),
                    bytes: fmtBytes(trashConfirm.entry.totalBytes),
                  })}
        </p>
      </Modal>
    </div>
  )
}
