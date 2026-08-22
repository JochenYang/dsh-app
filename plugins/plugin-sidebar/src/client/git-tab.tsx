/**
 * The Git tab of the sidebar dock / native view: worker-queue style Git
 * surface over the fenced host routes.
 *   - 变更: porcelain entries grouped by top-level directory (VS Code SCM
 *     order: Changes first, Staged below); click a file row for its diff;
 *     hover rows for +/−; commit box on top with a full-change review.
 *   - 图谱 (modal): `git log --graph --all --oneline` in a centered dialog —
 *     click a commit row to see its file stat INSIDE the modal.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FsApiError, gitApi } from './api.ts'
import type { GitStatusEntry } from './api.ts'

/** Props of {@link GitTab} (view inject face; extra fields ignored). */
export interface GitTabProps {
  /** Workspace root (the session cwd); undefined with no session. */
  cwd: string | undefined
  sessionId?: unknown
  api?: unknown
}

/** One diff text as a colored block. */
function DiffView(props: { text: string }): ReactNode {
  if (props.text === '') return <p className="dshAsb-hint">无差异（未变更）</p>
  const lines = props.text.split('\n')
  // Unified-diff line numbering: each @@ hunk carries the new/old start
  // lines; + counts against new, - against old, context against both.
  let oldNo = 0
  let newNo = 0
  const rows = lines.map((line, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk !== null) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      return { key: index, text: line, cls: undefined, old: undefined, new: undefined }
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const row = { key: index, text: line, cls: 'dshAsbGit-diffAdd', old: undefined, new: newNo }
      newNo += 1
      return row
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const row = { key: index, text: line, cls: 'dshAsbGit-diffDel', old: oldNo, new: undefined }
      oldNo += 1
      return row
    }
    const row = { key: index, text: line, cls: undefined, old: oldNo, new: newNo }
    oldNo += 1
    newNo += 1
    return row
  })
  return (
    <pre className="dshAsbGit-diff">
      {rows.map(row => (
        <div key={row.key} className={row.cls}>
          <span className="dshAsbGit-diffNo">{row.old === undefined ? '  ' : String(row.old).padEnd(4)}</span>
          <span className="dshAsbGit-diffNo">{row.new === undefined ? '  ' : String(row.new).padEnd(4)}</span>
          <span className="dshAsbGit-diffText">{row.text === '' ? ' ' : row.text}</span>
        </div>
      ))}
    </pre>
  )
}

/** Small chevron for directory group rows. */
function ChevronGlyph({ open }: { open: boolean }): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden style={{ flex: 'none' }}>
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        style={{ transform: open ? 'rotate(90deg)' : undefined, transformOrigin: 'center', transition: 'transform 120ms ease' }} />
    </svg>
  )
}

/**
 * The Git tab body.
 * @param props - session facts (cwd drives the repository).
 * @returns the Git surface.
 */
export function GitTab(props: GitTabProps): ReactNode {
  const { cwd } = props
  const [entries, setEntries] = useState<readonly GitStatusEntry[]>([])
  const [branch, setBranch] = useState('')
  const [logText, setLogText] = useState<string | undefined>(undefined)
  const [graphOpen, setGraphOpen] = useState(false)
  const [showFor, setShowFor] = useState<{ sha: string, message: string, stat: string } | undefined>(undefined)
  const [diffFor, setDiffFor] = useState<{ path: string, cached: boolean, text: string | undefined, error: string | undefined } | undefined>(undefined)
  /** 变更 | 仓库文件 selection + the tracked-file listing. */
  const [listMode, setListMode] = useState<'changes' | 'files'>('changes')
  const [repoFiles, setRepoFiles] = useState<readonly string[] | undefined>(undefined)
  const [commitMessage, setCommitMessage] = useState('')
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set())
  // Left/right split ratio (0..1 of the pane); drag the divider to adjust.
  const [listWidth, setListWidth] = useState(300)
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = listWidth
    const onMove = (e: PointerEvent): void => {
      setListWidth(Math.min(560, Math.max(260, startWidth + (e.clientX - startX))))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const openGraph = (): void => {
    setGraphOpen(true)
    setShowFor(undefined)
    if (cwd !== undefined) {
      gitApi.log(cwd).then(
        result => setLogText(result.text),
        () => { setLogText(undefined); setError('图谱读取失败') },
      )
    }
  }

  const load = (): void => {
    if (cwd === undefined) return
    gitApi.status(cwd).then(
      result => { setEntries(result.entries); setBranch(result.branch); setError(undefined) },
      (failure: unknown) => {
        setError(failure instanceof FsApiError && failure.code === 'git-error'
          ? '仓库不可用（可能不是 Git 仓库或 git 命令缺失）'
          : failure instanceof Error ? failure.message : String(failure))
      },
    )
  }
  // No wire event for repo state; refreshing on mount/cwd and after actions.
  useEffect(() => {
    if (cwd === undefined) {
      setEntries([])
      setLogText(undefined)
      setDiffFor(undefined)
      setError(undefined)
      return
    }
    load()
    // Prefetch the graph so switching to it is instant; failures surface in
    // the graph view with a retry instead of a silent forever-loading state.
    gitApi.log(cwd).then(
      result => setLogText(result.text),
      () => { setLogText(undefined) },
    )
  }, [cwd])

  const refresh = (): void => {
    load()
    if (cwd !== undefined && graphOpen) {
      gitApi.log(cwd).then(
        result => setLogText(result.text),
        () => { setLogText(undefined); setError('图谱读取失败') },
      )
    }
  }

  const run = async (action: () => Promise<unknown>, okText: string): Promise<void> => {
    if (cwd === undefined) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      setNotice(okText)
      load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const openDiff = (path: string, cached: boolean): void => {
    if (cwd === undefined) return
    setDiffFor({ path, cached, text: undefined, error: undefined })
    gitApi.diff(cwd, path, cached).then(
      result => { setDiffFor(current => current?.path !== path ? current : { ...current, text: result.text }) },
      (failure: unknown) => {
        setDiffFor(current => current?.path !== path ? current
          : { ...current, error: failure instanceof Error ? failure.message : String(failure) })
      },
    )
  }

  if (cwd === undefined) {
    return (
      <div className="dshAsbGit">
        <style>{GIT_CSS}</style>
        <p className="dshAsb-hint">打开一个会话后，可在这里查看其工作区的 Git 状态。</p>
      </div>
    )
  }

  const staged = entries.filter(entry => entry.staged)
  const unstaged = entries.filter(entry => !entry.staged && !entry.untracked)
  const untracked = entries.filter(entry => entry.untracked)

  /** Group an entry list by its top-level directory (VS Code SCM tree view). */
  const dirGroups = (list: readonly GitStatusEntry[]): { key: string, files: GitStatusEntry[] }[] => {
    const byDir = new Map<string, GitStatusEntry[]>()
    for (const entry of list) {
      const slash = entry.path.indexOf('/')
      const key = slash === -1 ? '' : entry.path.slice(0, slash)
      const bucket = byDir.get(key) ?? []
      bucket.push(entry)
      byDir.set(key, bucket)
    }
    return [...byDir.entries()]
      .sort(([a], [b]) => (a === '' ? '\uffff' : a).localeCompare(b === '' ? '\uffff' : b))
      .map(([key, files]) => ({ key, files }))
  }

  const GroupRow = (props: { entry: GitStatusEntry }): ReactNode => {
    const { entry } = props
    // VS Code-style status letter: U untracked / M modified / D deleted / A added.
    const letter = entry.untracked ? 'U'
      : entry.xy[0] !== ' ' ? entry.xy[0] : entry.xy[1] !== ' ' ? entry.xy[1] : 'M'
    return (
      <div className="dshAsbGit-row">
        <button type="button" className="dshAsbGit-rowPath" title={entry.path}
          onClick={() => { openDiff(entry.path, entry.staged) }}>
          <span className={`dshAsbGit-letter${letter === 'U' ? ' dshAsbGit-letterNew' : entry.staged ? ' dshAsbGit-letterStaged' : ''}`}>{letter}</span>
          <span className="dshAsbGit-path">{entry.path}</span>
        </button>
        <span className="dshAsbGit-rowActions">
          <button type="button" className="dshAsbGit-link" disabled={busy}
            onClick={() => { void run(() => gitApi.action(entry.staged ? 'unstage' : 'stage', cwd, entry.path), entry.staged ? '已取消暂存' : '已暂存') }}>
            {entry.staged ? '−' : '+'}
          </button>
          {!entry.staged && !entry.untracked
            ? (
              <button type="button" className="dshAsbGit-link dshAsbGit-linkDanger" disabled={busy} title="还原文件"
                onClick={() => { void run(() => gitApi.action('restore', cwd, entry.path), '已还原') }}>
                ↺
              </button>
            )
            : null}
        </span>
      </div>
    )
  }

  /** One directory group: expandable header + indented file rows (DEFAULT
   * expanded — the tree opens fully so nothing is hidden behind a fold). */
  const GroupBlock = (props: { group: { key: string, files: GitStatusEntry[] } }): ReactNode => {
    const { group } = props
    if (group.key === '') {
      return <>{group.files.map(entry => <GroupRow key={entry.path} entry={entry} />)}</>
    }
    const open = !collapsedDirs.has(group.key)
    return (
      <>
        <button type="button" className="dshAsbGit-dirRow" aria-expanded={open}
          onClick={() => {
            setCollapsedDirs(current => {
              const next = new Set(current)
              if (!next.delete(group.key)) next.add(group.key)
              return next
            })
          }}>
          <ChevronGlyph open={open} />
          <span className="dshAsbGit-dirName">{group.key}/</span>
          <span className="dshAsbGit-dirCount">{String(group.files.length)}</span>
        </button>
        {open
          ? group.files.map(entry => (
              <div key={entry.path} className="dshAsbGit-fileRow">
                <GroupRow entry={entry} />
              </div>
            ))
          : null}
      </>
    )
  }

  // --- status view: left = change list, right = diff preview (SAME two-column
  // pattern as the file view: clicking a row previews in the right pane,
  // never navigates away). -----------------------------------------------
  const statusView = (
    <div className="dshAsbGit-cols">
      <div className="dshAsbGit-list" style={{ width: `${String(listWidth)}px` }}>
        <div className="dshAsbGit-commitRow">
          <input
            className="dshAsbGit-input" type="text" value={commitMessage}
            placeholder="提交信息（提交前可查看全部变更）" aria-label="提交信息"
            onChange={(event) => { setCommitMessage(event.target.value) }}
          />
          <button type="button" className="dshAsbGit-primary" disabled={busy || commitMessage.trim() === '' || staged.length === 0}
            title="提交已暂存的内容"
            onClick={() => {
              void run(() => gitApi.action('commit', cwd, undefined, commitMessage), '已提交')
                  .then(() => setCommitMessage(''))
            }}>{busy ? '…' : '提交'}</button>
        </div>
        <div className="dshAsbGit-head">
          <div className="dshAsbGit-seg" role="tablist" aria-label="Git 列表">
            <button type="button" role="tab" aria-selected={listMode === 'changes'} className={`dshAsbGit-segBtn${listMode === 'changes' ? ' dshAsbGit-segActive' : ''}`}
              onClick={() => { setListMode('changes'); setDiffFor(undefined) }}>变更（{String(entries.length)}）</button>
            <button type="button" role="tab" aria-selected={listMode === 'files'} className={`dshAsbGit-segBtn${listMode === 'files' ? ' dshAsbGit-segActive' : ''}`}
              onClick={() => {
                setListMode('files')
                setDiffFor(undefined)
                if (cwd !== undefined && repoFiles === undefined) {
                  gitApi.ls(cwd).then(
                    result => setRepoFiles(result.files),
                    () => { setRepoFiles([]); setError('仓库文件列表读取失败') },
                  )
                }
              }}>仓库文件</button>
          </div>
          <button type="button" className="dshAsbGit-link" disabled={busy}
            onClick={() => { void run(() => (listMode === 'files' && cwd !== undefined && repoFiles === undefined
              ? gitApi.ls(cwd).then(r => setRepoFiles(r.files))
              : gitApi.ls(cwd!)) as Promise<unknown>, '已刷新'); setListMode(listMode) }}>刷新</button>
        </div>
        {listMode === 'files'
          ? (
            <>
              <p className="dshAsbGit-hint">仓库跟踪文件——点击查看它与 HEAD 的差异；无变化的文件标注“未变更”。</p>
              {repoFiles === undefined ? <p className="dshAsb-hint">加载中…</p> : null}
              {repoFiles?.length === 0 ? <p className="dshAsb-hint">仓库无跟踪文件。</p> : null}
              {dirGroups((repoFiles ?? []).map<GitStatusEntry>(path => ({
                path, xy: '--', staged: false, untracked: false,
              }))).map(group => (
                <GroupBlock key={`f:${group.key}`} group={group} />
              ))}
            </>
          )
          : (
            <>
              {error !== undefined ? <p className="dshAsb-error">{error}</p> : null}
              {notice !== undefined ? <p className="dshAsb-notice">{notice}</p> : null}
              {dirGroups(unstaged.concat(untracked)).map(group => (
                <GroupBlock key={`u:${group.key}`} group={group} />
              ))}
              {unstaged.length + untracked.length === 0 ? <p className="dshAsb-hint">工作区干净。</p> : null}
              <p className="dshAsbGit-group">已暂存（{String(staged.length)}）</p>
              {dirGroups(staged).map(group => (
                <GroupBlock key={`s:${group.key}`} group={group} />
              ))}
              {staged.length === 0 ? <p className="dshAsb-hint">无已暂存变更。</p> : null}
            </>
          )}
      </div>
      <div className="dshAsbGit-resize" role="separator" aria-orientation="vertical" aria-label="调整面板宽度" onPointerDown={startResize} />
      <div className="dshAsbGit-detail">
        {diffFor === undefined
          ? <p className="dshAsb-hint">点击左侧文件查看预览。</p>
          : (
            <>
              <p className="dshAsbGit-diffPath" title={diffFor.path}>{diffFor.path}</p>
              {diffFor.error !== undefined ? <p className="dshAsb-error">{diffFor.error}</p> : null}
              {diffFor.text === undefined && diffFor.error === undefined ? <p className="dshAsb-hint">加载中…</p> : null}
              {diffFor.text !== undefined ? <DiffView text={diffFor.text} /> : null}
            </>
          )}
      </div>
    </div>
  )

  // --- graph modal (SCM Graph style: click a commit to see its files) --------
  const graphModal = graphOpen ? (
    <div className="dshAsbGit-modalMask" role="presentation" onClick={() => { setGraphOpen(false) }}>
      <div
        className="dshAsbGit-modal" role="dialog" aria-modal="true" aria-label="Git 图谱"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshAsbGit-modalHead">
          <span className="dshAsbGit-title">Git 图谱</span>
          <button type="button" className="dshAsbGit-link" disabled={busy}
            onClick={() => {
              if (cwd !== undefined) {
                gitApi.log(cwd).then(result => setLogText(result.text), () => setLogText(undefined))
              }
            }}>刷新</button>
          <button type="button" className="dshAsbGit-modalClose" aria-label="关闭图谱" onClick={() => { setGraphOpen(false) }}>✕</button>
        </div>
        <div className="dshAsbGit-modalBody">
          {error !== undefined ? <p className="dshAsbError-box">{error} <button type="button" className="dshAsbGit-link" onClick={refresh}>重试</button></p> : null}
          {logText === undefined && error === undefined ? <p className="dshAsb-hint">加载中…</p> : null}
          {logText !== undefined && logText === '' ? <p className="dshAsb-hint">暂无提交。</p> : null}
          {logText !== undefined && logText !== '' ? (
            <div className="dshAsbGraph">
              {showFor !== undefined
                ? (
                  <div className="dshAsbGit-diffBlock">
                    <button type="button" className="dshAsbGit-link" onClick={() => { setShowFor(undefined) }}>← 返回图谱</button>
                    <p className="dshAsbGit-diffPath" title={String(showFor.sha)}>commit {String(showFor.sha).slice(0, 8)}</p>
                    <pre className="dshAsbGit-commitMsg">{String(showFor.message ?? '')}</pre>
                    {String(showFor.message ?? '').trim().split('\n').length <= 1
                      ? <p className="dshAsb-hint">（该提交没有正文）</p>
                      : null}
                    <pre className="dshAsbGit-graph">{String(showFor.stat ?? '')}</pre>
                  </div>
                )
                : (
                  <pre className="dshAsbGit-graph">
                    {logText.split('\n').map((line, index) => {
                      const match = /^[\*\|\\\/\s]+([0-9a-f]{7,40})/.exec(line)
                      const sha = match === null ? undefined : match[1]
                      return sha === undefined
                        ? <span key={index} className="dshAsbGraph-plain">{line}</span>
                        : (
                          <button key={index} type="button" className="dshAsbGraph-line" title="查看提交变更"
                            onClick={() => {
                              if (cwd !== undefined) {
                                // Optimistic feedback: loading first, then the
                                // structured message + stat split.
                                setShowFor({ sha, message: '加载中…', stat: '' })
                                gitApi.show(cwd, sha).then(
                                  result => setShowFor({ sha, message: String(result.message ?? ''), stat: String(result.stat ?? '') }),
                                  (failure: unknown) => setShowFor({ sha, message: `读取失败：${failure instanceof Error ? failure.message : String(failure)}`, stat: '' }),
                                )
                              }
                            }}>{line}</button>
                        )
                    })}
                  </pre>
                )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="dshAsbGit" data-conversation-composer-overlay="">
      <style>{GIT_CSS}</style>
      {cwd !== undefined ? (
        <div className="dshAsbGit-top">
          <span className="dshAsbGit-branch" title="当前分支">{branch === '' ? '（非 Git 仓库/分离头）' : `⎇ ${branch}`}</span>
          <button type="button" className="dshAsbGit-ghostBtn" onClick={openGraph}>◈ 图谱</button>
        </div>
      ) : null}
      {statusView}
      {graphModal}
    </div>
  )
}

/** Git tab styles (prefix dshAsbGit-). */
const GIT_CSS = `
.dshAsbGit { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px calc(var(--dsh-composer-height, 132px) + 16px); min-height: 0; height: 100%; width: 100%; box-sizing: border-box; overflow: hidden; }
.dshAsbGit-cols { display: flex; flex: 1; min-height: 0; overflow: hidden; gap: 0; }
.dshAsbGit-list { flex: none; min-height: 0; overflow: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 6px; padding-right: 10px; }
.dshAsbGit-resize { flex: none; width: 8px; cursor: col-resize; margin: 0 -2px 0 2px; z-index: 2; }
.dshAsbGit-detail { flex: 1; min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 6px; padding-left: 8px; }
.dshAsbGit-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshAsbGit-branch { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.2); color: var(--dsw-alias-label-secondary, #475569); font-size: 11.5px; max-width: 60%; }
.dshAsbGit-ghostBtn { flex: none; padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 999px; background: none; color: var(--dsw-alias-label-secondary, #475569); cursor: pointer; font-size: 11.5px; }
.dshAsbGit-ghostBtn:hover { background: rgba(148, 163, 184, 0.18); color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGit-seg { display: flex; gap: 12px; }
.dshAsbGit-segBtn { padding: 2px 0; border: none; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-secondary, #64748b); cursor: pointer; font-size: 12px; }
.dshAsbGit-segBtn:hover { color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGit-segActive { color: var(--dsw-alias-brand-primary, #2563eb); border-bottom-color: var(--dsw-alias-brand-primary, #2563eb); }
.dshAsbGit-hint { margin: 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11px; }
.dshAsbGit-reviewFile { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: none; border-radius: 6px; background: none; color: inherit; text-align: left; cursor: pointer; font-size: 12.5px; width: 100%; min-width: 0; }
.dshAsbGit-reviewFile:hover { background: rgba(148, 163, 184, 0.16); }
.dshAsbGit-commitRow { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, rgba(148,163,184,.08)); }
.dshAsbGit-commitRow .dshAsbGit-input { flex: 1; min-width: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
.dshAsbGit-primary { padding: 6px 14px; border: none; border-radius: 8px; background: var(--dsw-alias-brand-primary, #3b82f6); color: #fff; cursor: pointer; font-size: 12px; flex: none; font-weight: 600; }
.dshAsbGit-primary:disabled { opacity: .5; cursor: default; }
.dshAsbGit-reviewBtn { flex: none; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary, #475569); cursor: pointer; font-size: 12px; }
.dshAsbGit-reviewBtn:hover { background: rgba(148, 163, 184, 0.18); color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGit-head { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.dshAsbGit-title { font-weight: 600; font-size: 13px; }
.dshAsbGit-group { margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11px; }
.dshAsbGit-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; }
.dshAsbGit-row:hover { background: rgba(148, 163, 184, 0.16); }
.dshAsbGit-rowPath { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; padding: 0; border: none; background: none; color: inherit; text-align: left; cursor: pointer; font-size: 12.5px; }
.dshAsbGit-letter { flex: none; width: 14px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary, #94a3b8); }
.dshAsbGit-letterStaged { color: #16a34a; }
.dshAsbGit-letterNew { color: #2563eb; }
.dshAsbGit-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsbGit-rowActions { flex: none; display: none; gap: 8px; }
.dshAsbGit-row:hover .dshAsbGit-rowActions { display: flex; }
.dshAsbGit-link { padding: 0; border: none; background: none; color: var(--dsw-alias-brand-primary, #3b82f6); cursor: pointer; font-size: 11.5px; }
.dshAsbGit-link:disabled { opacity: .5; cursor: default; }
.dshAsbGit-linkDanger { color: #dc2626; }
.dshAsbGit-input { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 12.5px; }
.dshAsbGit-commitRow { display: flex; align-items: center; gap: 6px; }
.dshAsbGit-commitRow .dshAsbGit-input { flex: 1; min-width: 0; }
.dshAsbGit-primary { padding: 5px 12px; border: none; border-radius: 6px; background: var(--dsw-alias-brand-primary, #3b82f6); color: #fff; cursor: pointer; font-size: 12px; flex: none; }
.dshAsbGit-primary:disabled { opacity: .5; cursor: default; }
.dshAsbGit-diffBlock { display: flex; flex-direction: column; gap: 4px; }
.dshAsbGit-diffPath { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 11.5px; white-space: normal; overflow-wrap: anywhere; word-break: break-all; line-height: 1.5; }
.dshAsbGit-commitMsg { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-family: inherit; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.dshAsbGit-diff, .dshAsbGit-graph { margin: 0; padding: 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.5; overflow: auto; max-height: calc(100vh - 280px); }
.dshAsbGit-diffAdd { color: #15803d; background: rgba(22, 163, 74, 0.08); }
.dshAsbGit-diffDel { color: #b91c1c; background: rgba(220, 38, 38, 0.08); }
.dshAsbGit-graph { white-space: pre; color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGraph { display: flex; flex-direction: column; }
.dshAsbGraph-line { display: block; width: 100%; padding: 0; border: none; background: none; color: inherit; text-align: left; cursor: pointer; font-family: inherit; font-size: inherit; line-height: inherit; }
.dshAsbGraph-line:hover { background: rgba(59, 130, 246, 0.1); }
.dshAsbGraph-plain { display: block; white-space: pre; }
.dshAsbGit-top[hidden] { display: none; }
.dshAsbGit-modalMask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(15, 23, 42, .45); }
.dshAsbGit-modal { display: flex; flex-direction: column; width: min(860px, calc(100vw - 80px)); max-height: min(640px, calc(100vh - 96px)); border-radius: 10px; background: var(--dsw-alias-bg-overlay, #fff); box-shadow: 0 20px 50px rgba(15, 23, 42, .25); }
.dshAsbGit-modalHead { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAsbGit-modalHead .dshAsbGit-title { flex: 1; }
.dshAsbGit-modalClose { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px; background: none; color: var(--dsw-alias-label-secondary, #64748b); cursor: pointer; font-size: 11px; }
.dshAsbGit-modalClose:hover { background: rgba(148, 163, 184, 0.3); }
.dshAsbGit-modalBody { padding: 12px 14px; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.dshAsbGit-dirRow { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; cursor: pointer; border: none; background: none; color: inherit; width: 100%; text-align: left; font-size: 12.5px; }
.dshAsbGit-dirRow:hover { background: rgba(148, 163, 184, 0.16); }
.dshAsbGit-dirName { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsbGit-dirCount { margin-left: 2px; padding: 0 6px; border-radius: 999px; background: rgba(148, 163, 184, 0.18); color: var(--dsw-alias-label-secondary, #64748b); font-size: 10.5px; }
.dshAsbGit-fileRow { padding-left: 18px; border-left: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.10)); margin-left: 12px; }
.dshAsbError-box { margin: 2px 0; color: #dc2626; font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshAsb-hint { margin: 2px 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 12px; }
.dshAsb-error { margin: 2px 0; color: #dc2626; font-size: 12px; }
.dshAsb-notice { margin: 2px 0; color: #16a34a; font-size: 12px; }
`
