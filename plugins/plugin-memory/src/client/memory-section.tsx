/**
 * The memory settings section: master toggle, global stats, store path, and
 * the global/project topic-card lists — rows show a card's summary and expand
 * to its full body on click; destructive actions go through a confirm dialog.
 * All data flows through the host half's routes; a toggle flip takes effect
 * on the next prompt assembly without a restart.
 *
 * @module @dsh-app/plugin-memory/client/memory-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { ROUTE_PREFIX, type MemoryCardRow, type MemoryDistillActivity, type MemoryEntriesResponse, type MemoryProjectSummary, type MemoryStatus } from '../types.ts'

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
function formatBackend(item: MemoryDistillActivity): string {
  if (item.backend === undefined) return ''
  const channel = item.backend === 'direct' ? '直调' : '子代理'
  if (item.tokens === undefined) return ` · ${channel}`
  const tokens = item.tokens >= 1000 ? `${(item.tokens / 1000).toFixed(1)}k` : String(item.tokens)
  return ` · ${channel} ${tokens} tokens`
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
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
const CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  convention: '约定',
  decision: '决策',
  lesson: '经验',
  fact: '备忘',
}

/** Dialog heading for the armed action. */
function confirmTitle(state: ConfirmState | null): string {
  if (state === null) return ''
  if (state.kind === 'clear') return state.scope === 'global' ? '清空全局记忆' : '删除项目记忆'
  return state.pinned ? '删除已固定的记忆' : '删除这条记忆'
}

/** Dialog body for the armed action. */
function confirmMessage(state: ConfirmState | null): string {
  if (state === null) return ''
  if (state.kind === 'clear') {
    return `即将删除${state.scope === 'global' ? '全局记忆' : `项目「${state.title}」的记忆`}（${String(state.cards)} 条），删除后不可恢复。`
  }
  const where = state.scope === 'global' ? '全局记忆' : '项目记忆'
  return `即将从${where}中删除这条记忆：\n「${state.summary}」（名称：${state.topic}）\n删除后不可恢复。`
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
  onToggle: () => void
  onPin: () => void
  onForget: () => void
}): ReactNode {
  const { card, body, expanded, busy, onToggle, onPin, onForget } = props
  return (
    <div className="dshm_entryRow">
      <button
        type="button"
        className="dshm_entryMain"
        aria-expanded={expanded}
        title={expanded ? '收起正文' : '查看正文'}
        onClick={onToggle}
      >
        <span className="dshm_entryText">{card.pinned ? '📌 ' : ''}{summaryLine(card.summary)}</span>
        <span className="dshm_entryMeta">{CATEGORY_LABELS[card.category] ?? card.category} · {card.topic} · 更新于 {card.updated}</span>
        {expanded
          ? <span className="dshm_entryBody">{body ?? '（正文加载中…）'}</span>
          : null}
      </button>
      <button
        type="button"
        className={card.pinned ? 'dshm_pinBtn dshm_pinBtnOn' : 'dshm_pinBtn'}
        aria-pressed={card.pinned}
        aria-label={card.pinned ? '取消固定这条记忆' : '固定这条记忆'}
        disabled={busy}
        onClick={onPin}
      >{card.pinned ? '已固定' : '固定'}</button>
      <button
        type="button"
        className="dshm_button dshm_buttonDanger"
        aria-label="删除这条记忆"
        disabled={busy}
        onClick={onForget}
      >删除</button>
    </div>
  )
}

export function MemorySection(): ReactNode {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
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
      setError(failure instanceof Error ? failure.message : String(failure))
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
      setNotice(next ? '已启用：新会话将注入记忆，模型可主动记录' : '已禁用：新会话不再注入记忆，保存工具将拒绝写入')
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
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
      setNotice(next ? '已开启后台提炼：会话静默 1 分钟后，新增内容足够多时补记项目记忆' : '已关闭后台提炼：仅保留对话中的即时记录')
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
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
      setNotice(pinned ? '已固定：该卡将始终随会话注入，不受注入长度截断影响' : '已取消固定')
      if (scope === 'project') await loadProjectRows(slug)
      else await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
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
    setNotice(result.forgotten > 0 ? `已删除 ${String(result.forgotten)} 条记忆` : '没有找到匹配的记忆')
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
      setError(failure instanceof Error ? failure.message : String(failure))
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
      setError(failure instanceof Error ? failure.message : String(failure))
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
        setNotice(target.scope === 'global' ? '已清空全局记忆' : `已删除项目「${target.title}」的记忆`)
        await load()
      } else {
        await runForget(target.scope, target.slug, target.topic)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [confirming, load, runForget])

  /** Body of one global card from the lazily loaded list (undefined = not loaded yet). */
  const globalBodyOf = (topic: string): string | undefined =>
    globalBodies?.find(card => card.topic === topic)?.body

  return (
    <div className="dshm_section">
      <p className="dshm_title">会话记忆</p>
      <p className="dshm_hint">
        模型在对话中主动记录长期有效的信息，每个新会话自动带入；同一主题再次记录会覆盖更新，记忆不会越攒越多。
        全局记忆（偏好与习惯）对所有项目生效；项目记忆（决策/约定/经验）仅注入该项目的会话，还会由后台提炼自动补记，互不串扰。
        记忆不含密钥等敏感信息；每条记忆是一个纯文本 .md 文件，可在下方目录中手动编辑。
      </p>

      {error !== undefined ? <div className="dshm_banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshm_noticeOk">{notice}</div> : null}
      {/* A destructive confirmation is a body-portal modal, not a banner at the
          top of the section: the button that armed it sits far down the list,
          so a top-anchored banner would make the user hunt for it. */}
      <ConfirmDialog
        open={confirming !== null}
        title={confirmTitle(confirming)}
        message={confirmMessage(confirming)}
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => { void onConfirm() }}
        onClose={() => { setConfirming(null) }}
      />

      <div className="dshm_toggleRow">
        <span className="dshm_toggleLabel">启用会话记忆（{status === null ? '…' : status.enabled ? '已启用' : '已禁用'}）</span>
        <button
          type="button"
          className="dshm_toggle"
          role="switch"
          aria-checked={status?.enabled ?? false}
          aria-label="启用会话记忆"
          disabled={busy || status === null}
          onClick={() => { void onToggle() }}
        />
      </div>

      <div className="dshm_toggleRow">
        <span className="dshm_toggleLabel">
          后台自动提炼（{status === null ? '…' : status.distill ? '已开启' : '已关闭'}）
          <span className="dshm_toggleHint">会话静默 1 分钟后，且新增内容足够多时，后台补记遗漏的项目记忆（直接调用模型，低消耗）</span>
        </span>
        <button
          type="button"
          className="dshm_toggle"
          role="switch"
          aria-checked={status?.distill ?? false}
          aria-label="后台自动提炼"
          disabled={busy || status === null || (status !== null && !status.enabled)}
          onClick={() => { void onToggleDistill() }}
        />
      </div>

      <div className="dshm_cards">
        <div className="dshm_card">
          <div className="dshm_cardLabel">全局记忆</div>
          <div className="dshm_cardValue">{status === null ? '…' : String(status.cards)}</div>
        </div>
        <div className="dshm_card">
          <div className="dshm_cardLabel">全局占用</div>
          <div className="dshm_cardValue">{status === null ? '…' : fmtBytes(status.sizeBytes)}</div>
        </div>
        <div className="dshm_card">
          <div className="dshm_cardLabel">记忆项目数</div>
          <div className="dshm_cardValue">{status === null ? '…' : String(status.projects.length)}</div>
        </div>
        <div className="dshm_card">
          <div className="dshm_cardLabel">全局记忆目录</div>
          <div
            className="dshm_cardPath"
            title={status === null ? '' : `${status.storePath}（可手动编辑该目录下的 .md 文件）`}
          >{status === null ? '…' : status.storePath}</div>
        </div>
      </div>

      {status !== null && status.distill && status.activity.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">最近提炼</div>
            <div className="dshm_hint">后台提炼在会话静默 1 分钟后运行，且需累计足够新内容；它只写项目记忆（直接调用模型，低消耗）。以下为最近记录（时间 · 来源会话 · 新增条数 · 通道）。</div>
            {status.activity.slice(0, activityExpanded ? status.activity.length : ACTIVITY_PREVIEW).map((item: MemoryDistillActivity) => (
              <div key={`${item.at}-${item.session}`} className="dshm_activityRow">
                <span className="dshm_activityTime">{fmtTime(item.at)}</span>
                <span className="dshm_activityMeta">会话 {item.session} · {item.saved === 0 ? '无新增' : `新增 ${String(item.saved)} 条`}{formatBackend(item)}</span>
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
                  {activityExpanded ? '收起' : `查看全部（${String(status.activity.length)} 条）`}
                </button>
              )
              : null}
          </div>
        )
        : null}

      {status !== null && status.globalList.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">全局记忆</div>
            <div className="dshm_hint">每条记忆按主题命名，同一主题再次记录会覆盖更新；固定（📌）的记忆始终带入新会话，不受长度截断影响。点击查看正文，默认只显示前 {String(CARDS_PREVIEW)} 条。</div>
            {status.globalList.slice(0, listExpanded ? status.globalList.length : CARDS_PREVIEW).map(card => (
              <CardRow
                key={card.topic}
                card={card}
                body={globalBodyOf(card.topic)}
                expanded={expandedCards.has(rowKey('global', '', card.topic))}
                busy={busy}
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
                  {listExpanded ? '收起' : `查看全部（${String(status.globalList.length)} 条）`}
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
          onClick={() => { setConfirming({ kind: 'clear', scope: 'global', slug: '', title: '全局', cards: status?.cards ?? 0 }) }}
        >清空全局记忆</button>
      </div>

      {status !== null && status.projects.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">项目记忆</div>
            <div className="dshm_hint">点击「条目」展开该项目的记忆列表，再点单条查看正文，可逐条固定或删除；「删除」移除整个项目的记忆目录。删除条目与删除项目都需确认。</div>
            {status.projects.map(project => (
              <div key={project.slug} className="dshm_projectBlock">
                <div className="dshm_projectRow">
                  <span className="dshm_projectName" title={project.cwd === '' ? project.slug : project.cwd}>{projectTitle(project)}</span>
                  <span className="dshm_projectMeta">{String(project.cards)} 条 · {fmtBytes(project.sizeBytes)}</span>
                  <button
                    type="button"
                    className="dshm_button"
                    aria-expanded={openSlug === project.slug}
                    disabled={busy}
                    onClick={() => { void onToggleProject(project) }}
                  >{openSlug === project.slug ? '收起' : '条目'}</button>
                  <button
                    type="button"
                    className="dshm_button dshm_buttonDanger"
                    disabled={busy}
                    onClick={() => { setConfirming({ kind: 'clear', scope: 'project', slug: project.slug, title: projectTitle(project), cards: project.cards }) }}
                  >删除</button>
                </div>
                {openSlug === project.slug
                  ? (
                    projectRows === null || projectRows.slug !== project.slug
                      ? <div className="dshm_hint">加载中…</div>
                      : projectRows.cards.length === 0
                        ? <div className="dshm_hint">（暂无记忆）</div>
                        : projectRows.cards.map(card => (
                          <CardRow
                            key={card.topic}
                            card={card}
                            body={card.body}
                            expanded={expandedCards.has(rowKey('project', project.slug, card.topic))}
                            busy={busy}
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
