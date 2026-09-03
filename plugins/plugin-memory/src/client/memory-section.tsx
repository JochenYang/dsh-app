/**
 * The memory settings section: master toggle, global stats, file path, and
 * the per-project memory list — each project row shows its own entry
 * count/size and a (confirmed, irreversible) clear action. All data flows
 * through the host half's routes; the toggle takes effect on the next
 * prompt assembly without a restart.
 *
 * @module @dsh-app/plugin-memory/client/memory-section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MemoryDistillActivity, MemoryEntriesResponse, MemoryProjectSummary, MemoryStatus } from '../types.ts'

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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

const ROUTE = '/plugins/@dsh-app/plugin-memory/api'

/** Distill-activity rows shown before the "show all" fold (list caps at 20). */
const ACTIVITY_PREVIEW = 5

/** Global entry rows shown before the "show all" fold. */
const ENTRIES_PREVIEW = 5

/** What the confirm banner is about to clear. */
interface ConfirmState {
  scope: 'global' | 'project'
  slug: string
  title: string
  entries: number
}

export function MemorySection(): ReactNode {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  const [activityExpanded, setActivityExpanded] = useState(false)
  const [entriesExpanded, setEntriesExpanded] = useState(false)
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [projectRows, setProjectRows] = useState<{ slug: string, entries: MemoryEntriesResponse['entries'] } | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    try {
      setStatus(await fetchJson<MemoryStatus>(`${ROUTE}/status`))
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  const loadProjectRows = useCallback(async (slug: string) => {
    const data = await fetchJson<MemoryEntriesResponse>(`${ROUTE}/entries?slug=${encodeURIComponent(slug)}`)
    setProjectRows({ slug, entries: data.entries })
  }, [])

  useEffect(() => { void load() }, [load])

  const onToggle = useCallback(async () => {
    if (status === null || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      const next = !status.enabled
      await fetchJson<{ enabled: boolean }>(`${ROUTE}/config`, {
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
      await fetchJson(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distill: next }),
      })
      setNotice(next ? '已开启后台提炼：会话静默 1 分钟后自动补记' : '已关闭后台提炼：仅保留对话中的即时记录')
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [status, load])

  const onPin = useCallback(async (scope: 'global' | 'project', slug: string, text: string, pinned: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      await fetchJson(`${ROUTE}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, pinned, ...(scope === 'project' ? { scope: 'project', slug } : {}) }),
      })
      setNotice(pinned ? '已固定：该条目将始终随会话注入，不再受注入长度截断影响' : '已取消固定')
      if (scope === 'project') await loadProjectRows(slug)
      else await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [load, loadProjectRows])

  const onForget = useCallback(async (scope: 'global' | 'project', slug: string, text: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await fetchJson<{ forgotten: number }>(`${ROUTE}/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match: text, ...(scope === 'project' ? { scope: 'project', slug } : {}) }),
      })
      setNotice(result.forgotten > 0 ? `已删除 ${String(result.forgotten)} 条记忆` : '没有找到匹配的条目')
      if (scope === 'project') { await loadProjectRows(slug); await load() }
      else await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
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

  const onClear = useCallback(async () => {
    if (confirming === null || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    const target = confirming
    setConfirming(null)
    setNotice(undefined)
    try {
      await fetchJson(`${ROUTE}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.scope === 'global' ? { scope: 'global' } : { scope: 'project', slug: target.slug }),
      })
      setNotice(target.scope === 'global' ? '已清空全局记忆' : `已删除项目「${target.title}」的记忆`)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [confirming, load])

  return (
    <div className="dshm_section">
      <p className="dshm_title">会话记忆</p>
      <p className="dshm_hint">
        模型在对话中主动记录长期有效的信息（跨会话持久保存），每个新会话自动带入。
        全局记忆（偏好与习惯）对所有项目生效；项目记忆（决策/约定/教训）仅注入该项目的会话，互不串扰。
        记忆不含密钥等敏感信息；文件为纯文本，可手动编辑。
      </p>

      {error !== undefined ? <div className="dshm_banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshm_noticeOk">{notice}</div> : null}
      {confirming !== null
        ? (
          <div className="dshm_confirm">
            <span>即将删除{confirming.scope === 'global' ? '全局记忆' : `项目「${confirming.title}」的记忆`}（{String(confirming.entries)} 条），删除后不可恢复。</span>
            <span className="dshm_confirmActions">
              <button type="button" className="dshm_button dshm_buttonDanger" disabled={busy} onClick={() => { void onClear() }}>确认删除</button>
              <button type="button" className="dshm_button" disabled={busy} onClick={() => { setConfirming(null) }}>取消</button>
            </span>
          </div>
        )
        : null}

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
          <span className="dshm_toggleHint">会话静默 1 分钟后，后台只读代理自动补记遗漏的持久信息</span>
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
          <div className="dshm_cardLabel">全局记忆条目</div>
          <div className="dshm_cardValue">{status === null ? '…' : String(status.entries)}</div>
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
          <div className="dshm_cardLabel">全局记忆文件</div>
          <div className="dshm_cardPath" title={status?.filePath ?? ''}>{status === null ? '…' : status.filePath}</div>
        </div>
      </div>

      {status !== null && status.distill && status.activity.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">最近提炼</div>
            <div className="dshm_hint">后台只读代理在会话静默 1 分钟后自动运行，以下为最近记录（时间 · 来源会话 · 保存条数）。</div>
            {status.activity.slice(0, activityExpanded ? status.activity.length : ACTIVITY_PREVIEW).map((item: MemoryDistillActivity) => (
              <div key={`${item.at}-${item.session}`} className="dshm_activityRow">
                <span className="dshm_activityTime">{fmtTime(item.at)}</span>
                <span className="dshm_activityMeta">会话 {item.session} · {item.saved === 0 ? '无新条目' : `保存 ${String(item.saved)} 条`}</span>
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
            <div className="dshm_projectsTitle">全局条目</div>
            <div className="dshm_hint">固定（📌）的条目始终随会话注入，不受注入长度截断影响；未固定的按“每分类保留最新”挑选。列表按保存时间倒序，默认只显示最近 {String(ENTRIES_PREVIEW)} 条。</div>
            {[...status.globalList].reverse().slice(0, entriesExpanded ? status.globalList.length : ENTRIES_PREVIEW).map((entry, index) => (
              <div key={`${entry.text}-${index}`} className="dshm_entryRow">
                <span className="dshm_entryText">{entry.text}</span>
                <button
                  type="button"
                  className={entry.pinned ? 'dshm_pinBtn dshm_pinBtnOn' : 'dshm_pinBtn'}
                  aria-pressed={entry.pinned}
                  aria-label={entry.pinned ? '取消固定该条目' : '固定该条目'}
                  disabled={busy}
                  onClick={() => { void onPin('global', '', entry.text, !entry.pinned) }}
                >{entry.pinned ? '已固定' : '固定'}</button>
                <button
                  type="button"
                  className="dshm_button dshm_buttonDanger"
                  aria-label="删除该条目"
                  disabled={busy}
                  onClick={() => { void onForget('global', '', entry.text) }}
                >删除</button>
              </div>
            ))}
            {status.globalList.length > ENTRIES_PREVIEW
              ? (
                <button
                  type="button"
                  className="dshm_button dshm_activityMore"
                  aria-expanded={entriesExpanded}
                  onClick={() => { setEntriesExpanded(expanded => !expanded) }}
                >
                  {entriesExpanded ? '收起' : `查看全部（${String(status.globalList.length)} 条）`}
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
          disabled={busy || status === null || status.entries === 0}
          onClick={() => { setConfirming({ scope: 'global', slug: '', title: '全局', entries: status?.entries ?? 0 }) }}
        >清空全局记忆</button>
      </div>

      {status !== null && status.projects.length > 0
        ? (
          <div className="dshm_projects">
            <div className="dshm_projectsTitle">项目记忆</div>
            <div className="dshm_hint">点击“条目”展开该项目的记忆明细，可逐条固定或删除；“删除”移除整个项目的记忆目录（需确认）。</div>
            {status.projects.map(project => (
              <div key={project.slug} className="dshm_projectBlock">
                <div className="dshm_projectRow">
                  <span className="dshm_projectName" title={project.cwd === '' ? project.slug : project.cwd}>{projectTitle(project)}</span>
                  <span className="dshm_projectMeta">{String(project.entries)} 条 · {fmtBytes(project.sizeBytes)}</span>
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
                    onClick={() => { setConfirming({ scope: 'project', slug: project.slug, title: projectTitle(project), entries: project.entries }) }}
                  >删除</button>
                </div>
                {openSlug === project.slug
                  ? (
                    projectRows === null || projectRows.slug !== project.slug
                      ? <div className="dshm_hint">加载中…</div>
                      : projectRows.entries.length === 0
                        ? <div className="dshm_hint">（暂无条目）</div>
                        : [...projectRows.entries].reverse().map((entry, index) => (
                          <div key={`${entry.text}-${index}`} className="dshm_entryRow">
                            <span className="dshm_entryText">{entry.text}</span>
                            <button
                              type="button"
                              className={entry.pinned ? 'dshm_pinBtn dshm_pinBtnOn' : 'dshm_pinBtn'}
                              aria-pressed={entry.pinned}
                              aria-label={entry.pinned ? '取消固定该条目' : '固定该条目'}
                              disabled={busy}
                              onClick={() => { void onPin('project', project.slug, entry.text, !entry.pinned) }}
                            >{entry.pinned ? '已固定' : '固定'}</button>
                            <button
                              type="button"
                              className="dshm_button dshm_buttonDanger"
                              aria-label="删除该条目"
                              disabled={busy}
                              onClick={() => { void onForget('project', project.slug, entry.text) }}
                            >删除</button>
                          </div>
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
