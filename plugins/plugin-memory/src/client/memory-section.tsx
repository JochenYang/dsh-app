/**
 * The memory settings section: master toggle, global stats, store path, and
 * the global/project topic-card lists — rows show a card's summary and expand
 * to its full body on click; destructive actions go through a confirm dialog.
 * All data flows through the host half's routes; a toggle flip takes effect
 * on the next prompt assembly without a restart.
 *
 * Every string comes from the `dsh-app.memory` namespace through the `t`
 * standard seat: the section registers with `locale: NS`, so the renderer
 * hands the component a namespace-bound translate that reads the active UI
 * locale at call time and re-renders on a language switch. State carries
 * dictionary keys rather than rendered sentences, so banners and notices
 * follow the language too.
 *
 * @module @dsh-app/plugin-memory/client/memory-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { NS } from './locales.ts'
import type { MemoryKey } from './locales.ts'
import { ROUTE_PREFIX, type HostText, type MemoryCardRow, type MemoryDistillActivity, type MemoryEntriesResponse, type MemoryProjectSummary, type MemoryStatus } from '../types.ts'

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type MemorySectionProps = PropsLocale<typeof NS>

/**
 * One message the page shows: a key of this page's dictionary, or a coded
 * message from the host (see {@link HostText}) this page renders itself.
 */
type Notice =
  | { readonly source: 'key'; readonly key: MemoryKey; readonly params?: Record<string, unknown> }
  | { readonly source: 'host'; readonly host: HostText | undefined; readonly fallback: string }

/** A failure carrying the host's coded message, when one came with it. */
class HostError extends Error {
  constructor(readonly host: HostText | undefined, fallback: string) {
    super(fallback)
  }
}

/**
 * Render a coded host message.
 *
 * The host never sends prose for anything the user reads (see `HostText` in
 * types.ts): it sends a code plus the values the sentence interpolates, and the
 * copy lives in this page's dictionary. `text` is the host's own English
 * diagnostic, used only for a code this build does not know — a newer kernel
 * must degrade to a readable banner, never to a blank one.
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
 * unknown code falls back to the host's English diagnostic, so a newer kernel
 * beside an older page still says something actionable.
 */
function routeErrorCopy(t: TranslateNS<typeof NS>, host: HostText | undefined, fallback: string): string {
  const params = host?.params ?? {}
  return hostMessage(host, {
    'route.scopeRequired': t('memory.host.scopeRequired'),
    'route.slugRequired': t('memory.host.slugRequired'),
    'route.slugInvalid': t('memory.host.slugInvalid'),
    'route.projectUnknown': t('memory.host.projectUnknown'),
    'route.topicInvalid': t('memory.host.topicInvalid'),
    'route.pinnedNotBoolean': t('memory.host.pinnedNotBoolean'),
    'route.topicUnknown': t('memory.host.topicUnknown'),
    'route.matchRequired': t('memory.host.matchRequired'),
    'route.enabledNotBoolean': t('memory.host.enabledNotBoolean'),
    'route.distillNotBoolean': t('memory.host.distillNotBoolean'),
    'route.bodyTooLarge': t('memory.host.bodyTooLarge'),
    'route.invalidBody': t('memory.host.invalidBody', { detail: String(params.detail ?? '') }),
    'route.clearProjectFailed': t('memory.host.clearProjectFailed'),
    'route.clearGlobalFailed': t('memory.host.clearGlobalFailed'),
  }, fallback)
}

/** Classify a failed request: the host's coded message when it sent one. */
function wireNotice(failure: unknown): Notice {
  if (failure instanceof HostError) return { source: 'host', host: failure.host, fallback: failure.message }
  return { source: 'host', host: undefined, fallback: failure instanceof Error ? failure.message : String(failure) }
}

/**
 * Render a notice in the active locale.
 * @param notice - the classified message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
function noticeText(notice: Notice, t: TranslateNS<typeof NS>): string {
  if (notice.source === 'key') return t(notice.key, notice.params)
  return routeErrorCopy(t, notice.host, notice.fallback)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/** Local wall-clock time for one distill trace, e.g. `14:03`. */
function fmtTime(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Display name for a project: basename of the cwd, falling back to slug. */
function projectTitle(project: MemoryProjectSummary): string {
  if (project.cwd === '') return project.slug
  const parts = project.cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u)
  return parts[parts.length - 1] ?? project.slug
}

/** Backend + token suffix for one distill trace, e.g. ` · 直调 1.2k tokens`. */
function formatBackend(item: MemoryDistillActivity, t: TranslateNS<typeof NS>): string {
  if (item.backend === undefined) return ''
  const channel = t(item.backend === 'direct' ? 'memory.backend.direct' : 'memory.backend.subagent')
  if (item.tokens === undefined) return t('memory.activity.backend', { channel })
  const tokens = item.tokens >= 1000 ? `${(item.tokens / 1000).toFixed(1)}k` : String(item.tokens)
  return t('memory.activity.backendTokens', { channel, tokens })
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string, host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/** Distill-activity rows shown before the "show all" fold (list caps at 20). */
const ACTIVITY_PREVIEW = 5

/** Global card rows shown before the "show all" fold. */
const CARDS_PREVIEW = 5

/** Main-line summary cap (the store already limits summaries to 40 chars;
 *  this only guards against a hand-edited card file). */
const SUMMARY_PREVIEW_CHARS = 80

/** What the confirm dialog is armed to destroy: a whole store, or a single card. */
type ConfirmState =
  | { kind: 'clear', scope: 'global' | 'project', slug: string, title: string, cards: number }
  | { kind: 'forget', scope: 'global' | 'project', slug: string, topic: string, summary: string, pinned: boolean }

/** Display line for a card summary, capped for the row. */
function summaryLine(summary: string): string {
  return summary.length <= SUMMARY_PREVIEW_CHARS ? summary : `${summary.slice(0, SUMMARY_PREVIEW_CHARS)}…`
}

/** Category labels in the user's language (the wire stores English keys). */
const CATEGORY_LABELS: Record<string, MemoryKey | undefined> = {
  preference: 'memory.category.preference',
  convention: 'memory.category.convention',
  decision: 'memory.category.decision',
  lesson: 'memory.category.lesson',
  fact: 'memory.category.fact',
}

/** A card's category name, falling back to the raw wire value. */
function categoryLabel(category: string, t: TranslateNS<typeof NS>): string {
  const key = CATEGORY_LABELS[category]
  return key === undefined ? category : t(key)
}

/** Dialog heading for the armed action. */
function confirmTitle(state: ConfirmState | null, t: TranslateNS<typeof NS>): string {
  if (state === null) return ''
  if (state.kind === 'clear') return state.scope === 'global' ? t('memory.confirm.clearGlobalTitle') : t('memory.confirm.clearProjectTitle')
  return state.pinned ? t('memory.confirm.forgetPinnedTitle') : t('memory.confirm.forgetTitle')
}

/** Dialog body for the armed action. */
function confirmMessage(state: ConfirmState | null, t: TranslateNS<typeof NS>): string {
  if (state === null) return ''
  if (state.kind === 'clear') {
    const target = state.scope === 'global'
      ? t('memory.scope.global.inline')
      : t('memory.scope.projectNamed', { title: state.title })
    return t('memory.confirm.clearMessage', { target, cards: String(state.cards) })
  }
  const where = state.scope === 'global' ? t('memory.scope.global.inline') : t('memory.scope.project.inline')
  return t('memory.confirm.forgetMessage', { where, summary: state.summary, topic: state.topic })
}

/** Expansion-set key for one card row. */
function rowKey(scope: 'global' | 'project', slug: string, topic: string): string {
  return `${scope}:${slug}:${topic}`
}

/** One card row: summary + meta line, click the main area to expand the body. */
function CardRow(props: {
  card: MemoryCardRow
  /** Full body text; undefined while the body-carrying list is still loading. */
  body: string | undefined
  expanded: boolean
  busy: boolean
  t: TranslateNS<typeof NS>
  onToggle: () => void
  onPin: () => void
  onForget: () => void
}): ReactNode {
  const { card, body, expanded, busy, t, onToggle, onPin, onForget } = props
  return (
    <div className="dshm_entryRow">
      <button
        type="button"
        className="dshm_entryMain"
        aria-expanded={expanded}
        title={expanded ? t('memory.card.collapse') : t('memory.card.expand')}
        onClick={onToggle}
      >
        <span className="dshm_entryText">{card.pinned ? '📌 ' : ''}{summaryLine(card.summary)}</span>
        <span className="dshm_entryMeta">{t('memory.card.meta', { category: categoryLabel(card.category, t), topic: card.topic, updated: card.updated })}</span>
        {expanded
          ? <span className="dshm_entryBody">{body ?? t('memory.card.bodyLoading')}</span>
          : null}
      </button>
      <button
        type="button"
        className={card.pinned ? 'dshm_pinBtn dshm_pinBtnOn' : 'dshm_pinBtn'}
        aria-pressed={card.pinned}
        aria-label={card.pinned ? t('memory.card.unpin.aria') : t('memory.card.pin.aria')}
        disabled={busy}
        onClick={onPin}
      >{card.pinned ? t('memory.card.pinned') : t('memory.card.pin')}</button>
      <button
        type="button"
        className="dshm_button dshm_buttonDanger"
        aria-label={t('memory.card.delete.aria')}
        disabled={busy}
        onClick={onForget}
      >{t('memory.action.delete')}</button>
    </div>
  )
}

export function MemorySection({ t }: MemorySectionProps): ReactNode {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [error, setError] = useState<Notice | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  const [activityExpanded, setActivityExpanded] = useState(false)
  const [listExpanded, setListExpanded] = useState(false)
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [projectRows, setProjectRows] = useState<{ slug: string, cards: MemoryCardRow[] } | null>(null)
  const [expandedCards, setExpandedCards] = useState<ReadonlySet<string>>(new Set())
  const [globalBodies, setGlobalBodies] = useState<MemoryCardRow[] | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    try {
      setStatus(await fetchJson<MemoryStatus>(`${ROUTE_PREFIX}/status`))
      setError(undefined)
    } catch (failure) {
      setError(wireNotice(failure))
    }
  }, [])

  const loadProjectRows = useCallback(async (slug: string) => {
    const data = await fetchJson<MemoryEntriesResponse>(`${ROUTE_PREFIX}/entries?slug=${encodeURIComponent(slug)}`)
    setProjectRows({ slug, cards: data.cards })
  }, [])

  useEffect(() => { void load() }, [load])

  const onToggle = useCallback(async () => {
    if (status === null || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      const next = !status.enabled
      await fetchJson<{ enabled: boolean }>(`${ROUTE_PREFIX}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      setNotice({ source: 'key', key: next ? 'memory.notice.enabled' : 'memory.notice.disabled' })
      await load()
    } catch (failure) {
      setError(wireNotice(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [status, load])

  const onToggleDistill = useCallback(async () => {
    if (status === null || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      const next = !status.distill
      await fetchJson(`${ROUTE_PREFIX}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distill: next }),
      })
      setNotice({ source: 'key', key: next ? 'memory.notice.distillOn' : 'memory.notice.distillOff' })
      await load()
    } catch (failure) {
      setError(wireNotice(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [status, load])

  const onPin = useCallback(async (scope: 'global' | 'project', slug: string, topic: string, pinned: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      await fetchJson(`${ROUTE_PREFIX}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, pinned, ...(scope === 'project' ? { scope: 'project', slug } : {}) }),
      })
      setNotice({ source: 'key', key: pinned ? 'memory.notice.pinned' : 'memory.notice.unpinned' })
      if (scope === 'project') await loadProjectRows(slug)
      else await load()
    } catch (failure) {
      setError(wireNotice(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [load, loadProjectRows])

  /** Drop one card by its topic key. Every caller goes through the confirm dialog. */
  const runForget = useCallback(async (scope: 'global' | 'project', slug: string, topic: string) => {
    const result = await fetchJson<{ forgotten: number, removed: string[] }>(`${ROUTE_PREFIX}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match: topic, ...(scope === 'project' ? { scope: 'project', slug } : {}) }),
    })
    setNotice({
      source: 'key',
      key: result.forgotten > 0 ? 'memory.notice.forgotten' : 'memory.notice.noMatch',
      params: { count: result.forgotten },
    })
    if (scope === 'project') { await loadProjectRows(slug); await load() }
    else await load()
  }, [load, loadProjectRows])

  const onToggleProject = useCallback(async (project: MemoryProjectSummary) => {
    if (openSlug === project.slug) {
      setOpenSlug(null)
      return
    }
    setOpenSlug(project.slug)
    setProjectRows(null)
    setNotice(undefined)
    try {
      await loadProjectRows(project.slug)
    } catch (failure) {
      setError(wireNotice(failure))
      setOpenSlug(null)
    }
  }, [openSlug, loadProjectRows])

  /** Expand/collapse one card row. The first GLOBAL expand lazily pulls the
   *  body-carrying list (the status payload ships summaries only); project
   *  rows already carry their bodies. */
  const onToggleCard = useCallback(async (scope: 'global' | 'project', slug: string, topic: string) => {
    const key = rowKey(scope, slug, topic)
    const opening = !expandedCards.has(key)
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (opening) next.add(key)
      else next.delete(key)
      return next
    })
    if (!opening || scope !== 'global' || globalBodies !== null) return
    try {
      const data = await fetchJson<MemoryEntriesResponse>(`${ROUTE_PREFIX}/entries`)
      setGlobalBodies(data.cards)
    } catch (failure) {
      setError(wireNotice(failure))
    }
  }, [expandedCards, globalBodies])

  /** Run whatever the confirm dialog was armed for: clear a store, or drop one card. */
  const onConfirm = useCallback(async () => {
    const target = confirming
    if (target === null || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setConfirming(null)
    setNotice(undefined)
    try {
      if (target.kind === 'clear') {
        await fetchJson(`${ROUTE_PREFIX}/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target.scope === 'global' ? { scope: 'global' } : { scope: 'project', slug: target.slug }),
        })
        setNotice({
          source: 'key',
          key: target.scope === 'global' ? 'memory.notice.clearedGlobal' : 'memory.notice.clearedProject',
          params: { title: target.title },
        })
        await load()
      } else {
        await runForget(target.scope, target.slug, target.topic)
      }
    } catch (failure) {
      setError(wireNotice(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [confirming, load, runForget])

  /** Body of one global card from the lazily loaded list (undefined = not loaded yet). */
  const globalBodyOf = (topic: string): string | undefined =>
    globalBodies?.find(card => card.topic === topic)?.body

  /** `{state}` for the toggle labels; the unknown state reads as pending. */
  const pending = t('memory.state.pending')

  return (
    <div className="dshm_section">
      <p className="dshm_title">{t('memory.title')}</p>
      <p className="dshm_hint">
        {t('memory.intro')}
      </p>

      {error !== undefined ? <div className="dshm_banner" role="alert">{noticeText(error, t)}</div> : null}
      {notice !== undefined ? <div className="dshm_noticeOk">{noticeText(notice, t)}</div> : null}
      {/* A destructive confirmation is a body-portal modal, not a banner at the
          top of the section: the button that armed it sits far down the list,
          so a top-anchored banner would make the user hunt for it. */}
      <ConfirmDialog
        open={confirming !== null}
        title={confirmTitle(confirming, t)}
        message={confirmMessage(confirming, t)}
        confirmLabel={t('memory.action.delete')}
        cancelLabel={t('memory.action.cancel')}
        busy={busy}
        onConfirm={() => { void onConfirm() }}
        onClose={() => { setConfirming(null) }}
      />

      <div className="dshm_toggleRow">
        <span className="dshm_toggleLabel">{t('memory.toggle.enabled', { state: status === null ? pending : status.enabled ? t('memory.state.enabled') : t('memory.state.disabled') })}</span>
        <button
          type="button"
          className="dshm_toggle"
          role="switch"
          aria-checked={status?.enabled ?? false}
          aria-label={t('memory.toggle.enabled.aria')}
          disabled={busy || status === null}
          onClick={() => { void onToggle() }}
        />
      </div>

      <div className="dshm_toggleRow">
        <span className="dshm_toggleLabel">
          {t('memory.toggle.distill', { state: status === null ? pending : status.distill ? t('memory.state.on') : t('memory.state.off') })}
          <span className="dshm_toggleHint">{t('memory.toggle.distill.hint')}</span>
        </span>
        <button
          type="button"
          className="dshm_toggle"
          role="switch"
          aria-checked={status?.distill ?? false}
          aria-label={t('memory.toggle.distill.aria')}
          disabled={busy || status === null || (status !== null && !status.enabled)}
          onClick={() => { void onToggleDistill() }}
        />
      </div>

      <div className="dshm_cards">
        <div className="dshm_card">
          <div className="dshm_cardLabel">{t('memory.scope.global')}</div>
          <div className="dshm_cardValue">{status === null ? pending : String(status.cards)}</div>
        </div>
        <div className="dshm_card">
          <div className="dshm_cardLabel">{t('memory.stats.size')}</div>
          <div className="dshm_cardValue">{status === null ? pending : fmtBytes(status.sizeBytes)}</div>
        </div>
        <div className="dshm_card">
          <div className="dshm_cardLabel">{t('memory.stats.projects')}</div>
          <div className="dshm_cardValue">{status === null ? pending : String(status.projects.length)}</div>
        </div>
        <div className="dshm_card">
          <div className="dshm_cardLabel">{t('memory.stats.storeDir')}</div>
          <div
            className="dshm_cardPath"
            title={status === null ? '' : t('memory.storePath.title', { path: status.storePath })}
          >{status === null ? pending : status.storePath}</div>
        </div>
      </div>

      {status !== null && status.distill && status.activity.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">{t('memory.activity.title')}</div>
            <div className="dshm_hint">{t('memory.activity.hint')}</div>
            {status.activity.slice(0, activityExpanded ? status.activity.length : ACTIVITY_PREVIEW).map((item: MemoryDistillActivity) => (
              <div key={`${item.at}-${item.session}`} className="dshm_activityRow">
                <span className="dshm_activityTime">{fmtTime(item.at)}</span>
                <span className="dshm_activityMeta">{t('memory.activity.row', { session: item.session, saved: item.saved === 0 ? t('memory.activity.none') : t('memory.activity.added', { count: item.saved }) })}{formatBackend(item, t)}</span>
              </div>
            ))}
            {status.activity.length > ACTIVITY_PREVIEW
              ? (
                <button
                  type="button"
                  className="dshm_button dshm_activityMore"
                  aria-expanded={activityExpanded}
                  onClick={() => { setActivityExpanded(expanded => !expanded) }}
                >
                  {activityExpanded ? t('memory.action.collapse') : t('memory.action.showAll', { count: status.activity.length })}
                </button>
              )
              : null}
          </div>
        )
        : null}

      {status !== null && status.globalList.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">{t('memory.scope.global')}</div>
            <div className="dshm_hint">{t('memory.list.hint', { count: CARDS_PREVIEW })}</div>
            {status.globalList.slice(0, listExpanded ? status.globalList.length : CARDS_PREVIEW).map(card => (
              <CardRow
                key={card.topic}
                card={card}
                body={globalBodyOf(card.topic)}
                expanded={expandedCards.has(rowKey('global', '', card.topic))}
                busy={busy}
                t={t}
                onToggle={() => { void onToggleCard('global', '', card.topic) }}
                onPin={() => { void onPin('global', '', card.topic, !card.pinned) }}
                onForget={() => { setConfirming({ kind: 'forget', scope: 'global', slug: '', topic: card.topic, summary: card.summary, pinned: card.pinned }) }}
              />
            ))}
            {status.globalList.length > CARDS_PREVIEW
              ? (
                <button
                  type="button"
                  className="dshm_button dshm_activityMore"
                  aria-expanded={listExpanded}
                  onClick={() => { setListExpanded(expanded => !expanded) }}
                >
                  {listExpanded ? t('memory.action.collapse') : t('memory.action.showAll', { count: status.globalList.length })}
                </button>
              )
              : null}
          </div>
        )
        : null}

      <div className="dshm_actions">
        <button
          type="button"
          className="dshm_button dshm_buttonDanger"
          disabled={busy || status === null || status.cards === 0}
          onClick={() => { setConfirming({ kind: 'clear', scope: 'global', slug: '', title: t('memory.scope.global'), cards: status?.cards ?? 0 }) }}
        >{t('memory.action.clearGlobal')}</button>
      </div>

      {status !== null && status.projects.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">{t('memory.scope.project')}</div>
            <div className="dshm_hint">{t('memory.projects.hint')}</div>
            {status.projects.map(project => (
              <div key={project.slug} className="dshm_projectBlock">
                <div className="dshm_projectRow">
                  <span className="dshm_projectName" title={project.cwd === '' ? project.slug : project.cwd}>{projectTitle(project)}</span>
                  <span className="dshm_projectMeta">{t('memory.projects.meta', { cards: String(project.cards), size: fmtBytes(project.sizeBytes) })}</span>
                  <button
                    type="button"
                    className="dshm_button"
                    aria-expanded={openSlug === project.slug}
                    disabled={busy}
                    onClick={() => { void onToggleProject(project) }}
                  >{openSlug === project.slug ? t('memory.action.collapse') : t('memory.action.items')}</button>
                  <button
                    type="button"
                    className="dshm_button dshm_buttonDanger"
                    disabled={busy}
                    onClick={() => { setConfirming({ kind: 'clear', scope: 'project', slug: project.slug, title: projectTitle(project), cards: project.cards }) }}
                  >{t('memory.action.delete')}</button>
                </div>
                {openSlug === project.slug
                  ? (
                    projectRows === null || projectRows.slug !== project.slug
                      ? <div className="dshm_hint">{t('memory.projects.loading')}</div>
                      : projectRows.cards.length === 0
                        ? <div className="dshm_hint">{t('memory.projects.empty')}</div>
                        : projectRows.cards.map(card => (
                          <CardRow
                            key={card.topic}
                            card={card}
                            body={card.body}
                            expanded={expandedCards.has(rowKey('project', project.slug, card.topic))}
                            busy={busy}
                            t={t}
                            onToggle={() => { void onToggleCard('project', project.slug, card.topic) }}
                            onPin={() => { void onPin('project', project.slug, card.topic, !card.pinned) }}
                            onForget={() => { setConfirming({ kind: 'forget', scope: 'project', slug: project.slug, topic: card.topic, summary: card.summary, pinned: card.pinned }) }}
                          />
                        ))
                  )
                  : null}
              </div>
            ))}
          </div>
        )
        : null}
    </div>
  )
}
