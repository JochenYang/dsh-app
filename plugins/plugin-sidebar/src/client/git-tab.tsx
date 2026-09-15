/**
 * The Git tab of the sidebar dock / native view: worker-queue style Git
 * surface over the fenced host routes.
 *   - 变更: porcelain entries grouped by top-level directory (VS Code SCM
 *     order: Changes first, Staged below); click a file row for its diff;
 *     hover rows for +/−; commit box on top with a full-change review.
 *   - 同步/分支/贮藏 (top bar): pull/push/fetch with a 120 s deadline,
 *     ahead/behind badges (↑N ↓N) beside the branch pill, a click-to-open
 *     branch switcher dropdown (checkout + create), and stash push/pop.
 *   - 图谱 (modal): `git log --graph --all --oneline` in a centered dialog —
 *     click a commit row to see its file stat INSIDE the modal.
 *
 * Every string this tab renders comes from the `dsh-app.sidebar` namespace
 * through the `t` standard seat: the view registers with `locale: NS`, so the
 * renderer hands the component — and, through its props, the diff/detail
 * helpers below — a namespace-bound translate that reads the active UI locale
 * at call time and re-renders on a language switch. What the ROUTE writes
 * crosses the wire as a CODE (see `host-text.ts` in the host half) and is
 * worded here; what git itself wrote (stdout excerpts, porcelain letters,
 * commit messages) is a diagnostic and is shown verbatim.
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { FsApiError, gitApi } from './api.ts'
import type { GitActionValue, GitBranchList, GitStatusEntry, HostText } from './api.ts'
import { NS, type SidebarKey } from './locales.ts'

/** The tab's namespace-bound translate, handed to the render helpers below. */
type SidebarTranslate = TranslateNS<typeof NS>

/**
 * Render a coded host message.
 *
 * The host never sends prose for anything the tab shows: it sends a code plus
 * the values the copy interpolates (see `host-text.ts` in the host half).
 * `text` is the host's own English diagnostic and is used only for a code this
 * build does not know, so a newer kernel beside an older tab degrades to a
 * readable line rather than to a blank notice.
 *
 * @param host - the coded message, when the host sent one.
 * @param copy - this build's copy for the codes it knows.
 * @param fallback - line to show when there is no code at all.
 * @returns the copy of the active locale.
 */
function hostMessage(
  host: HostText | undefined,
  copy: Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (host === undefined) return fallback
  return copy[host.code] ?? host.text ?? fallback
}

/**
 * Codes whose copy REPLACES the sentence: each already reads as a complete
 * statement, so wrapping it in `sidebar.fail.detail` would repeat the frame.
 * Keyed by the wire `code` — the category this tab has always branched on.
 */
const STANDALONE_COPY: Readonly<Record<string, SidebarKey>> = {
  'git-missing': 'sidebar.fail.gitMissing',
  'git-timeout': 'sidebar.fail.timeout',
  'forbidden': 'sidebar.fail.forbidden',
}

/**
 * Copy for the coded messages the frame sentence (`sidebar.fail.detail`)
 * wraps. The zh entries are byte-identical to the sentences the host used to
 * send; only the carrier changed.
 */
function detailCopy(t: SidebarTranslate): Readonly<Record<string, string>> {
  return {
    'git.noRemoteSync': t('sidebar.fail.noRemoteSync'),
    'git.noRemotePull': t('sidebar.fail.noRemotePull'),
    'git.noRemotePush': t('sidebar.fail.noRemotePush'),
    'git.detachedPull': t('sidebar.fail.detachedPull'),
    'git.branchNameMissing': t('sidebar.fail.branchNameMissing'),
    'git.branchNameInvalid': t('sidebar.fail.branchNameInvalid'),
  }
}

/** Bounded git stdout a sync action returns, or nothing for other ops. */
function actionOut(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && typeof (value as GitActionValue).out === 'string'
    ? (value as GitActionValue).out
    : undefined
}

/**
 * Pull/push success wording from git's own verdict: "Already up to date." /
 * "Everything up-to-date" mean nothing actually moved, which deserves a
 * different notice than a real transfer (git's messages are English — the
 * fenced env passes no locale). The classifier returns a dictionary key, not
 * a sentence, so the notice follows the active language.
 */
function pullNotice(value: unknown): SidebarKey {
  const out = actionOut(value)
  return out !== undefined && /already up to date/iu.test(out) ? 'sidebar.pull.upToDate' : 'sidebar.pull.done'
}

function pushNotice(value: unknown): SidebarKey {
  const out = actionOut(value)
  return out !== undefined && /everything up-to-date/iu.test(out) ? 'sidebar.push.upToDate' : 'sidebar.push.done'
}

/**
 * Props of {@link GitTab} (the view inject face plus the framework-supplied
 * `t` seat of this plugin's namespace; other framework fields are ignored).
 */
export type GitTabProps = PropsLocale<typeof NS> & {
  /** Workspace root (the session cwd); undefined with no session. */
  cwd: string | undefined
  /** Host-owned session identity used to bind every Git request. */
  sessionId?: string
}

/** One diff text as a colored block. */
function DiffView(props: { text: string, truncated?: boolean, t: SidebarTranslate }): ReactNode {
  if (props.text === '') return <p className="dshAsb-hint">{props.t('sidebar.diff.empty')}</p>
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
    <>
      {props.truncated ? <p className="dshAsbGit-warning">{props.t('sidebar.diff.truncated')}</p> : null}
      <pre className="dshAsbGit-diff">
        {rows.map(row => (
          <div key={row.key} className={row.cls}>
            <span className="dshAsbGit-diffNo">{row.old === undefined ? '  ' : String(row.old).padEnd(4)}</span>
            <span className="dshAsbGit-diffNo">{row.new === undefined ? '  ' : String(row.new).padEnd(4)}</span>
            <span className="dshAsbGit-diffText">{row.text === '' ? ' ' : row.text}</span>
          </div>
        ))}
      </pre>
    </>
  )
}

/** Small chevron for directory group rows. */
function ChevronGlyph({ open }: { open: boolean }): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ flex: 'none', pointerEvents: 'none' }}>
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
  const { cwd, sessionId, t } = props
  const [entries, setEntries] = useState<readonly GitStatusEntry[]>([])
  const [branch, setBranch] = useState('')
  const [detached, setDetached] = useState(false)
  /** Divergence vs the upstream (null = no upstream); drives the ↑N ↓N badges. */
  const [ahead, setAhead] = useState<number | null>(null)
  const [behind, setBehind] = useState<number | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [logText, setLogText] = useState<string | undefined>(undefined)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | undefined>(undefined)
  const [graphOpen, setGraphOpen] = useState(false)
  const [showFor, setShowFor] = useState<{ sha: string, message: string, stat: string, requestId: number } | undefined>(undefined)
  const [diffFor, setDiffFor] = useState<{ path: string, cached: boolean, text: string | undefined, truncated?: boolean, error: string | undefined, requestId: number } | undefined>(undefined)
  /** 变更 | 仓库文件 selection + the tracked-file listing. */
  const [listMode, setListMode] = useState<'changes' | 'files'>('changes')
  const [repoFiles, setRepoFiles] = useState<readonly string[] | undefined>(undefined)
  const [repoFilesTruncated, setRepoFilesTruncated] = useState(false)
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState<string | undefined>(undefined)
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
  /** Which action op is in flight (drives per-button loading labels). */
  const [pendingOp, setPendingOp] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [restoreFor, setRestoreFor] = useState<string | undefined>(undefined)
  /** Branch switcher dropdown (absolute panel below the branch pill). */
  const [branchPanelOpen, setBranchPanelOpen] = useState(false)
  const [branchList, setBranchList] = useState<GitBranchList | undefined>(undefined)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState<string | undefined>(undefined)
  const [newBranchName, setNewBranchName] = useState('')
  const viewGeneration = useRef(0)
  const statusRequestId = useRef(0)
  const logRequestId = useRef(0)
  const filesRequestId = useRef(0)
  const diffRequestId = useRef(0)
  const showRequestId = useRef(0)
  const branchesRequestId = useRef(0)
  const branchMenuRef = useRef<HTMLDivElement | null>(null)
  const cwdRef = useRef(cwd)
  const sessionIdRef = useRef(sessionId)
  cwdRef.current = cwd
  sessionIdRef.current = sessionId

  const isCurrent = (generation: number, targetCwd: string, targetSessionId: string): boolean => (
    viewGeneration.current === generation
    && cwdRef.current === targetCwd
    && sessionIdRef.current === targetSessionId
  )

  const failureText = (failure: unknown): string => {
    if (failure instanceof FsApiError) {
      const standalone = STANDALONE_COPY[failure.code]
      if (standalone !== undefined) return t(standalone)
      // Everything else is a detail the frame sentence wraps: the host's coded
      // message when it sent one, its English diagnostic otherwise (a raw git
      // stderr excerpt is a diagnostic, never copy).
      const detail = hostMessage(failure.host, detailCopy(t), failure.message).trim().replace(/\s+/gu, ' ')
      return detail === '' ? t('sidebar.fail.generic') : t('sidebar.fail.detail', { detail })
    }
    if (failure instanceof Error) return failure.message
    return String(failure)
  }

  const loadStatus = (targetCwd: string, targetSessionId: string, generation: number): Promise<boolean> => {
    const requestId = statusRequestId.current + 1
    statusRequestId.current = requestId
    setStatusLoading(true)
    return gitApi.status(targetCwd, targetSessionId).then(
      result => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || statusRequestId.current !== requestId) return false
        setEntries(result.entries)
        setBranch(result.branch)
        setDetached(result.detached)
        setAhead(result.ahead)
        setBehind(result.behind)
        setError(undefined)
        return true
      },
      (failure: unknown) => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || statusRequestId.current !== requestId) return false
        setEntries([])
        setBranch('')
        setDetached(false)
        setAhead(null)
        setBehind(null)
        setNotice(undefined)
        setError(failureText(failure))
        return false
      },
    ).finally(() => {
      if (isCurrent(generation, targetCwd, targetSessionId) && statusRequestId.current === requestId) setStatusLoading(false)
    })
  }

  const loadLog = (targetCwd: string, targetSessionId: string, generation: number): Promise<boolean> => {
    const requestId = logRequestId.current + 1
    logRequestId.current = requestId
    setLogLoading(true)
    setLogError(undefined)
    return gitApi.log(targetCwd, targetSessionId).then(
      result => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || logRequestId.current !== requestId) return false
        setLogText(result.text)
        return true
      },
      (failure: unknown) => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || logRequestId.current !== requestId) return false
        setLogText(undefined)
        setLogError(failureText(failure))
        return false
      },
    ).finally(() => {
      if (isCurrent(generation, targetCwd, targetSessionId) && logRequestId.current === requestId) setLogLoading(false)
    })
  }

  const loadRepoFiles = (targetCwd: string, targetSessionId: string, generation: number): Promise<boolean> => {
    const requestId = filesRequestId.current + 1
    filesRequestId.current = requestId
    setFilesLoading(true)
    setFilesError(undefined)
    return gitApi.ls(targetCwd, targetSessionId).then(
      result => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || filesRequestId.current !== requestId) return false
        setRepoFiles(result.files)
        setRepoFilesTruncated(result.truncated === true)
        return true
      },
      (failure: unknown) => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || filesRequestId.current !== requestId) return false
        setRepoFiles(undefined)
        setRepoFilesTruncated(false)
        setFilesError(failureText(failure))
        return false
      },
    ).finally(() => {
      if (isCurrent(generation, targetCwd, targetSessionId) && filesRequestId.current === requestId) setFilesLoading(false)
    })
  }

  const loadBranches = (targetCwd: string, targetSessionId: string, generation: number): void => {
    const requestId = branchesRequestId.current + 1
    branchesRequestId.current = requestId
    setBranchesLoading(true)
    setBranchesError(undefined)
    gitApi.branchList(targetCwd, targetSessionId).then(
      result => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || branchesRequestId.current !== requestId) return
        setBranchList(result)
      },
      (failure: unknown) => {
        if (!isCurrent(generation, targetCwd, targetSessionId) || branchesRequestId.current !== requestId) return
        setBranchList(undefined)
        setBranchesError(failureText(failure))
      },
    ).finally(() => {
      if (isCurrent(generation, targetCwd, targetSessionId) && branchesRequestId.current === requestId) setBranchesLoading(false)
    })
  }

  const openGraph = (): void => {
    setGraphOpen(true)
    setShowFor(undefined)
    if (cwd !== undefined && sessionId !== undefined) void loadLog(cwd, sessionId, viewGeneration.current)
  }

  const toggleBranchPanel = (): void => {
    if (branchPanelOpen) {
      setBranchPanelOpen(false)
      return
    }
    setBranchPanelOpen(true)
    // Re-list on every open: branches change under us without events.
    if (cwd !== undefined && sessionId !== undefined) {
      setBranchList(undefined)
      loadBranches(cwd, sessionId, viewGeneration.current)
    }
  }

  const checkoutBranch = (name: string): void => {
    if (cwd === undefined || sessionId === undefined) return
    setBranchPanelOpen(false)
    void run(() => gitApi.action('branch.checkout', cwd, undefined, undefined, sessionId, name), t('sidebar.branch.switched', { name }))
  }

  const createBranch = (): void => {
    if (cwd === undefined || sessionId === undefined) return
    const name = newBranchName.trim()
    if (name === '') return
    setBranchPanelOpen(false)
    setNewBranchName('')
    void run(() => gitApi.action('branch.create', cwd, undefined, undefined, sessionId, name), t('sidebar.branch.created', { name }))
  }

  // No wire event for repo state; refreshing on mount/cwd and after actions.
  useEffect(() => {
    const generation = viewGeneration.current + 1
    viewGeneration.current = generation
    statusRequestId.current += 1
    logRequestId.current += 1
    filesRequestId.current += 1
    diffRequestId.current += 1
    showRequestId.current += 1
    branchesRequestId.current += 1
    if (cwd === undefined) {
      setEntries([])
      setBranch('')
      setDetached(false)
      setAhead(null)
      setBehind(null)
      setStatusLoading(false)
      setLogText(undefined)
      setLogLoading(false)
      setLogError(undefined)
      setDiffFor(undefined)
      setRepoFiles(undefined)
      setRepoFilesTruncated(false)
      setFilesLoading(false)
      setFilesError(undefined)
      setRestoreFor(undefined)
      setGraphOpen(false)
      setShowFor(undefined)
      setCommitMessage('')
      setListMode('changes')
      setCollapsedDirs(new Set())
      setBusy(false)
      setPendingOp(undefined)
      setError(undefined)
      setNotice(undefined)
      setBranchPanelOpen(false)
      setBranchList(undefined)
      setBranchesLoading(false)
      setBranchesError(undefined)
      setNewBranchName('')
      return
    }
    setEntries([])
    setBranch('')
    setDetached(false)
    setAhead(null)
    setBehind(null)
    setStatusLoading(false)
    setLogText(undefined)
    setLogLoading(false)
    setLogError(undefined)
    setDiffFor(undefined)
    setRepoFiles(undefined)
    setRepoFilesTruncated(false)
    setFilesLoading(false)
    setFilesError(undefined)
    setRestoreFor(undefined)
    setGraphOpen(false)
    setShowFor(undefined)
    setCommitMessage('')
    setListMode('changes')
    setCollapsedDirs(new Set())
    setBusy(false)
    setPendingOp(undefined)
    setError(undefined)
    setNotice(undefined)
    setBranchPanelOpen(false)
    setBranchList(undefined)
    setBranchesLoading(false)
    setBranchesError(undefined)
    setNewBranchName('')
    if (sessionId === undefined) {
      setError(t('sidebar.fail.noSession'))
      return
    }
    void loadStatus(cwd, sessionId, generation)
    // Prefetch the graph so switching to it is instant; failures surface in
    // the graph view with a retry instead of a silent forever-loading state.
    void loadLog(cwd, sessionId, generation)
  }, [cwd, sessionId])

  const refresh = (): void => {
    if (cwd === undefined || sessionId === undefined) return
    const generation = viewGeneration.current
    setError(undefined)
    setNotice(undefined)
    void loadStatus(cwd, sessionId, generation)
    if (listMode === 'files') void loadRepoFiles(cwd, sessionId, generation)
    if (graphOpen) void loadLog(cwd, sessionId, generation)
  }

  const run = async (action: () => Promise<unknown>, okText: string | ((value: unknown) => string), op?: string): Promise<boolean> => {
    if (cwd === undefined || sessionId === undefined) return false
    setBusy(true)
    setPendingOp(op)
    setError(undefined)
    setNotice(undefined)
    try {
      const actionValue = await action()
      const generation = viewGeneration.current
      const refreshed = await loadStatus(cwd, sessionId, generation)
      if (graphOpen) await loadLog(cwd, sessionId, generation)
      if (!refreshed) return false
      setNotice(typeof okText === 'function' ? okText(actionValue) : okText)
      return true
    } catch (failure) {
      setError(failureText(failure))
      return false
    } finally {
      setBusy(false)
      setPendingOp(undefined)
    }
  }

  const openDiff = (path: string, cached: boolean, untracked = false): void => {
    if (cwd === undefined || sessionId === undefined) return
    const requestId = diffRequestId.current + 1
    diffRequestId.current = requestId
    setDiffFor({ path, cached, text: undefined, error: undefined, requestId })
    gitApi.diff(cwd, path, cached, sessionId, untracked).then(
      result => { setDiffFor(current => current?.requestId !== requestId ? current : { ...current, text: result.text, truncated: result.truncated }) },
      (failure: unknown) => {
        setDiffFor(current => current?.requestId !== requestId ? current
          : { ...current, error: failureText(failure) })
      },
    )
  }

  const openCommit = (sha: string): void => {
    if (cwd === undefined || sessionId === undefined) return
    const requestId = showRequestId.current + 1
    showRequestId.current = requestId
    setShowFor({ sha, message: t('sidebar.loading'), stat: '', requestId })
    gitApi.show(cwd, sha, sessionId).then(
      result => setShowFor(current => current?.requestId !== requestId ? current : { sha, message: String(result.message ?? ''), stat: String(result.stat ?? ''), requestId }),
      (failure: unknown) => setShowFor(current => current?.requestId !== requestId ? current : { sha, message: t('sidebar.graph.readFailed', { message: failureText(failure) }), stat: '', requestId }),
    )
  }

  useEffect(() => {
    if (!graphOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setGraphOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [graphOpen])

  // Branch dropdown: close on any outside pointer press or Escape (same
  // dismiss patterns as the graph modal, adapted to a non-modal panel).
  useEffect(() => {
    if (!branchPanelOpen) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const node = branchMenuRef.current
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) setBranchPanelOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBranchPanelOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [branchPanelOpen])

  if (cwd === undefined) {
    return (
      <div className="dshAsbGit">
        <style>{GIT_CSS}</style>
        <p className="dshAsb-hint">{t('sidebar.noSession')}</p>
      </div>
    )
  }

  // A single porcelain entry can have both an index and a worktree change
  // (for example `MM`). Render it in both groups so neither half disappears.
  const staged = entries.filter(entry => entry.indexStatus !== ' ' && entry.indexStatus !== '?')
  const unstaged = entries.filter(entry => entry.untracked || entry.worktreeStatus !== ' ')
  const aheadCount = ahead ?? 0
  const behindCount = behind ?? 0
  const currentBranch = branchList?.current ?? null
  const branchLabel = statusLoading
    ? t('sidebar.branch.loading')
    : error !== undefined
      ? t('sidebar.branch.unavailable')
      : detached
        ? t('sidebar.branch.detached')
        : branch === ''
          ? t('sidebar.branch.unnamed')
          : t('sidebar.branch.named', { branch })

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

  // Render-function row/group builders, CALLED DIRECTLY (never used as JSX
  // component tags): as inline components their identity would change every
  // render, remounting the whole list subtree and resetting its scroll.
  const groupRow = (entry: GitStatusEntry, cached: boolean, readonly = false): ReactNode => {
    // VS Code-style status letter: U untracked / M modified / D deleted / A added.
    const status = cached ? entry.indexStatus : entry.untracked ? '?' : entry.worktreeStatus
    const letter = status === '?' ? 'U' : status === ' ' ? '·' : status
    const pathTitle = entry.originalPath === undefined ? entry.path : `${entry.originalPath} → ${entry.path}`
    const canRestore = !readonly && !cached && !entry.untracked && entry.worktreeStatus !== ' '
    return (
      <div className="dshAsbGit-row">
        <button type="button" className="dshAsbGit-rowPath" title={pathTitle}
          onClick={() => { openDiff(entry.path, cached, entry.untracked) }}>
          <span className={`dshAsbGit-letter${letter === 'U' ? ' dshAsbGit-letterNew' : cached ? ' dshAsbGit-letterStaged' : ''}`}>{letter}</span>
          <span className="dshAsbGit-path">{entry.path}</span>
        </button>
        {!readonly ? (
          <span className="dshAsbGit-rowActions">
            <button type="button" className="dshAsbGit-link" disabled={busy || sessionId === undefined} title={t(cached ? 'sidebar.action.unstage' : 'sidebar.action.stage', { path: entry.path })} aria-label={t(cached ? 'sidebar.action.unstage' : 'sidebar.action.stage', { path: entry.path })}
              onClick={() => { void run(() => gitApi.action(cached ? 'unstage' : 'stage', cwd, entry.path, undefined, sessionId), t(cached ? 'sidebar.action.unstaged' : 'sidebar.action.staged')) }}>
              {cached ? '−' : '+'}
            </button>
            {canRestore
              ? (
                <button type="button" className="dshAsbGit-link dshAsbGit-linkDanger" disabled={busy || sessionId === undefined} title={t('sidebar.action.restore', { path: entry.path })} aria-label={t('sidebar.action.restore', { path: entry.path })}
                  onClick={() => { setRestoreFor(entry.path) }}>
                  ↺
                </button>
              )
              : null}
          </span>
        ) : null}
      </div>
    )
  }

  /** One directory group: expandable header + indented file rows (DEFAULT
   * expanded — the tree opens fully so nothing is hidden behind a fold). */
  const groupBlock = (group: { key: string, files: GitStatusEntry[] }, cached: boolean, readonly = false): ReactNode => {
    if (group.key === '') {
      return <>{group.files.map(entry => <Fragment key={entry.path}>{groupRow(entry, cached, readonly)}</Fragment>)}</>
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
                {groupRow(entry, cached, readonly)}
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
            placeholder={t('sidebar.commit.placeholder')} aria-label={t('sidebar.commit.label')}
            onChange={(event) => { setCommitMessage(event.target.value) }}
          />
          <button type="button" className="dshAsbGit-primary" disabled={busy || statusLoading || sessionId === undefined || commitMessage.trim() === '' || staged.length === 0}
            title={t('sidebar.commit.title')}
            onClick={() => {
              void run(() => gitApi.action('commit', cwd, undefined, commitMessage, sessionId), t('sidebar.commit.done'))
                .then(success => { if (success) setCommitMessage('') })
            }}>{busy ? '…' : t('sidebar.commit.action')}</button>
        </div>
        <div className="dshAsbGit-head">
          <div className="dshAsbGit-seg" role="tablist" aria-label={t('sidebar.list.aria')}>
            <button type="button" role="tab" aria-selected={listMode === 'changes'} className={`dshAsbGit-segBtn${listMode === 'changes' ? ' dshAsbGit-segActive' : ''}`}
              onClick={() => { setListMode('changes'); setDiffFor(undefined) }}>{t('sidebar.list.changes', { count: entries.length })}</button>
            <button type="button" role="tab" aria-selected={listMode === 'files'} className={`dshAsbGit-segBtn${listMode === 'files' ? ' dshAsbGit-segActive' : ''}`}
              onClick={() => {
                setListMode('files')
                setDiffFor(undefined)
                if (cwd !== undefined && sessionId !== undefined && repoFiles === undefined && !filesLoading) {
                  void loadRepoFiles(cwd, sessionId, viewGeneration.current)
                }
              }}>{t('sidebar.list.files')}</button>
            </div>
          <div className="dshAsbGit-tools">
            <button type="button" className="dshAsbGit-link" disabled={busy || statusLoading || sessionId === undefined || unstaged.length === 0}
              onClick={() => { void run(() => gitApi.action('stage', cwd, undefined, undefined, sessionId), t('sidebar.stageAll.done')) }}>{t('sidebar.stageAll')}</button>
            <button type="button" className="dshAsbGit-link" disabled={busy || statusLoading || sessionId === undefined || staged.length === 0}
              onClick={() => { void run(() => gitApi.action('unstage', cwd, undefined, undefined, sessionId), t('sidebar.unstageAll.done')) }}>{t('sidebar.unstageAll')}</button>
            <button type="button" className="dshAsbGit-link" disabled={busy || filesLoading || statusLoading || sessionId === undefined} aria-label={t('sidebar.refreshAria')} title={t('sidebar.refreshAria')}
              onClick={refresh}>{t('sidebar.refresh')}</button>
          </div>
        </div>
        {listMode === 'files'
          ? (
            <>
              <p className="dshAsbGit-hint">{t('sidebar.files.hint')}</p>
              {filesLoading ? <p className="dshAsb-hint">{t('sidebar.files.loading')}</p> : null}
              {filesError !== undefined ? <p className="dshAsb-error" role="alert">{filesError} <button type="button" className="dshAsbGit-link" onClick={() => { if (cwd !== undefined && sessionId !== undefined) void loadRepoFiles(cwd, sessionId, viewGeneration.current) }}>{t('sidebar.retry')}</button></p> : null}
              {repoFilesTruncated ? <p className="dshAsbGit-warning">{t('sidebar.files.truncated')}</p> : null}
              {repoFiles !== undefined && repoFiles.length === 0 && filesError === undefined ? <p className="dshAsb-hint">{t('sidebar.files.empty')}</p> : null}
              {dirGroups((repoFiles ?? []).map<GitStatusEntry>(path => ({
                path, xy: '  ', indexStatus: ' ', worktreeStatus: ' ', staged: false, untracked: false,
              }))).map(group => (
                <Fragment key={`f:${group.key}`}>{groupBlock(group, false, true)}</Fragment>
              ))}
            </>
          )
          : (
            <>
              {statusLoading && entries.length === 0 && error === undefined ? <p className="dshAsb-hint">{t('sidebar.status.loading')}</p> : null}
              {error !== undefined ? <p className="dshAsbError-box" role="alert"><span>{error}</span><button type="button" className="dshAsbGit-link" onClick={refresh}>{t('sidebar.retry')}</button></p> : null}
              {notice !== undefined ? <p className="dshAsb-notice" role="status">{notice}</p> : null}
              {error === undefined && !(statusLoading && entries.length === 0) ? (
                <>
                  {dirGroups(unstaged).map(group => (
                    <Fragment key={`u:${group.key}`}>{groupBlock(group, false)}</Fragment>
                  ))}
                  {!statusLoading && unstaged.length === 0 && staged.length === 0 ? <p className="dshAsbGit-hint">{t('sidebar.status.clean')}</p> : null}
                  {staged.length > 0 || unstaged.length > 0 ? <p className="dshAsbGit-group">{t('sidebar.status.staged', { count: staged.length })}</p> : null}
                  {dirGroups(staged).map(group => (
                    <Fragment key={`s:${group.key}`}>{groupBlock(group, true)}</Fragment>
                  ))}
                  {!statusLoading && entries.length > 0 && staged.length === 0 ? <p className="dshAsb-hint">{t('sidebar.status.noStaged')}</p> : null}
                </>
              ) : null}
            </>
          )}
      </div>
      <div className="dshAsbGit-resize" role="separator" aria-orientation="vertical" aria-label={t('sidebar.resizeAria')} onPointerDown={startResize} />
      <div className="dshAsbGit-detail">
        {diffFor === undefined
          ? <p className="dshAsb-hint">{t('sidebar.detail.empty')}</p>
          : (
            <>
              <p className="dshAsbGit-diffPath" title={diffFor.path}>{diffFor.path}</p>
              {diffFor.error !== undefined ? <p className="dshAsb-error">{diffFor.error}</p> : null}
              {diffFor.text === undefined && diffFor.error === undefined ? <p className="dshAsb-hint">{t('sidebar.loading')}</p> : null}
              {diffFor.text !== undefined ? <DiffView text={diffFor.text} truncated={diffFor.truncated} t={t} /> : null}
            </>
          )}
      </div>
    </div>
  )

  // --- graph modal (SCM Graph style: click a commit to see its files) --------
  const graphModal = graphOpen ? (
    <div className="dshAsbGit-modalMask" role="presentation" onClick={() => { setGraphOpen(false) }}>
      <div
        className="dshAsbGit-modal" role="dialog" aria-modal="true" aria-label={t('sidebar.graph.title')}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshAsbGit-modalHead">
          <span className="dshAsbGit-title">{t('sidebar.graph.title')}</span>
          <button type="button" className="dshAsbGit-link" disabled={busy || logLoading || sessionId === undefined}
            onClick={() => {
              if (cwd !== undefined && sessionId !== undefined) void loadLog(cwd, sessionId, viewGeneration.current)
            }}>{t('sidebar.refresh')}</button>
          <button type="button" className="dshAsbGit-modalClose" aria-label={t('sidebar.graph.close')} onClick={() => { setGraphOpen(false) }}>✕</button>
        </div>
        <div className="dshAsbGit-modalBody">
          {logError !== undefined ? <p className="dshAsbError-box" role="alert"><span>{logError}</span><button type="button" className="dshAsbGit-link" onClick={() => { if (cwd !== undefined && sessionId !== undefined) void loadLog(cwd, sessionId, viewGeneration.current) }}>{t('sidebar.retry')}</button></p> : null}
          {logLoading && logText === undefined && logError === undefined ? <p className="dshAsb-hint">{t('sidebar.loading')}</p> : null}
          {logText !== undefined && logText === '' && logError === undefined ? <p className="dshAsb-hint">{t('sidebar.graph.empty')}</p> : null}
          {logText !== undefined && logText !== '' ? (
            <div className="dshAsbGraph">
              {showFor !== undefined
                ? (
                  <div className="dshAsbGit-diffBlock">
                    <button type="button" className="dshAsbGit-link" onClick={() => { setShowFor(undefined) }}>{t('sidebar.graph.back')}</button>
                    <p className="dshAsbGit-diffPath" title={String(showFor.sha)}>{t('sidebar.graph.commit', { sha: String(showFor.sha).slice(0, 8) })}</p>
                    <pre className="dshAsbGit-commitMsg">{String(showFor.message ?? '')}</pre>
                    {String(showFor.message ?? '').trim().split('\n').length <= 1
                      ? <p className="dshAsb-hint">{t('sidebar.graph.noBody')}</p>
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
                          <button key={index} type="button" className="dshAsbGraph-line" title={t('sidebar.graph.rowTitle')}
                            onClick={() => {
                              if (cwd !== undefined) {
                                openCommit(sha)
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
          <div className="dshAsbGit-branchWrap" ref={branchMenuRef}>
            <button type="button" className="dshAsbGit-branchBtn" title={t('sidebar.branch.switch')} aria-label={t('sidebar.branch.switch')}
              aria-expanded={branchPanelOpen} disabled={sessionId === undefined} onClick={toggleBranchPanel}>
              <span className="dshAsbGit-branchText" title={branchLabel}>{branchLabel}</span>
              {aheadCount > 0 ? <span className="dshAsbGit-diverge" title={t('sidebar.branch.ahead', { count: aheadCount })}>{`↑${String(aheadCount)}`}</span> : null}
              {behindCount > 0 ? <span className="dshAsbGit-diverge" title={t('sidebar.branch.behind', { count: behindCount })}>{`↓${String(behindCount)}`}</span> : null}
              <span className="dshAsbGit-branchCaret" aria-hidden>▾</span>
            </button>
            {branchPanelOpen ? (
              <div className="dshAsbGit-branchMenu" role="dialog" aria-label={t('sidebar.branch.switch')}>
                <p className="dshAsbGit-branchMenuTitle">{t('sidebar.branch.local')}</p>
                {branchesLoading ? <p className="dshAsb-hint">{t('sidebar.branch.reading')}</p> : null}
                {branchesError !== undefined ? (
                  <p className="dshAsb-error" role="alert">
                    {branchesError}
                    <button type="button" className="dshAsbGit-link" onClick={() => { if (cwd !== undefined && sessionId !== undefined) loadBranches(cwd, sessionId, viewGeneration.current) }}>{t('sidebar.retry')}</button>
                  </p>
                ) : null}
                {branchList !== undefined && branchList.branches.length === 0 && branchesError === undefined ? <p className="dshAsb-hint">{t('sidebar.branch.empty')}</p> : null}
                {(branchList?.branches ?? []).map(name => (
                  <button key={name} type="button"
                    className={`dshAsbGit-branchItem${name === currentBranch ? ' dshAsbGit-branchItemCur' : ''}`}
                    disabled={busy || sessionId === undefined}
                    title={name === currentBranch ? t('sidebar.branch.current', { name }) : t('sidebar.branch.switchTo', { name })}
                    onClick={() => { checkoutBranch(name) }}>
                    <span className="dshAsbGit-branchItemMark" aria-hidden>{name === currentBranch ? '✓' : ''}</span>
                    <span className="dshAsbGit-branchItemName">{name}</span>
                  </button>
                ))}
                <div className="dshAsbGit-branchCreate">
                  <input className="dshAsbGit-input" type="text" value={newBranchName} placeholder={t('sidebar.branch.newName')} aria-label={t('sidebar.branch.newName')}
                    onChange={(event) => { setNewBranchName(event.target.value) }}
                    onKeyDown={(event) => { if (event.key === 'Enter') createBranch() }} />
                  <button type="button" className="dshAsbGit-link" disabled={busy || sessionId === undefined || newBranchName.trim() === ''} onClick={createBranch}>{t('sidebar.branch.create')}</button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="dshAsbGit-topActions">
            <span className="dshAsbGit-syncGroup" role="group" aria-label={t('sidebar.sync.group')}>
              <button type="button" className="dshAsbGit-syncBtn" disabled={busy || statusLoading || sessionId === undefined}
                title={t('sidebar.pull.title')} aria-label={t('sidebar.pull.aria')}
                onClick={() => { void run(() => gitApi.action('pull', cwd, undefined, undefined, sessionId), value => t(pullNotice(value)), 'pull') }}>{pendingOp === 'pull' ? '…' : t('sidebar.pull.action')}</button>
              <button type="button" className="dshAsbGit-syncBtn" disabled={busy || statusLoading || sessionId === undefined}
                title={t('sidebar.push.title')} aria-label={t('sidebar.push.aria')}
                onClick={() => { void run(() => gitApi.action('push', cwd, undefined, undefined, sessionId), value => t(pushNotice(value)), 'push') }}>{pendingOp === 'push' ? '…' : t('sidebar.push.action')}</button>
              <button type="button" className="dshAsbGit-syncBtn" disabled={busy || statusLoading || sessionId === undefined}
                title={t('sidebar.fetch.title')} aria-label={t('sidebar.fetch.aria')}
                onClick={() => { void run(() => gitApi.action('fetch', cwd, undefined, undefined, sessionId), t('sidebar.fetch.done'), 'fetch') }}>{pendingOp === 'fetch' ? '…' : t('sidebar.fetch.action')}</button>
            </span>
            <span className="dshAsbGit-syncGroup" role="group" aria-label={t('sidebar.stash.group')}>
              <button type="button" className="dshAsbGit-syncBtn" disabled={busy || statusLoading || sessionId === undefined}
                title={t('sidebar.stash.pushTitle')} aria-label={t('sidebar.stash.pushAria')}
                onClick={() => { void run(() => gitApi.action('stash.push', cwd, undefined, undefined, sessionId), t('sidebar.stash.pushDone'), 'stash.push') }}>{pendingOp === 'stash.push' ? '…' : t('sidebar.stash.push')}</button>
              <button type="button" className="dshAsbGit-syncBtn" disabled={busy || statusLoading || sessionId === undefined}
                title={t('sidebar.stash.popTitle')} aria-label={t('sidebar.stash.popAria')}
                onClick={() => { void run(() => gitApi.action('stash.pop', cwd, undefined, undefined, sessionId), t('sidebar.stash.popDone'), 'stash.pop') }}>{pendingOp === 'stash.pop' ? '…' : t('sidebar.stash.pop')}</button>
            </span>
            <button type="button" className="dshAsbGit-ghostBtn" disabled={statusLoading || sessionId === undefined} onClick={openGraph}>{t('sidebar.graph.open')}</button>
          </div>
        </div>
      ) : null}
      {statusView}
      {graphModal}
      {restoreFor !== undefined ? (
        <div className="dshAsbGit-modalMask" role="presentation" onClick={() => { if (!busy) setRestoreFor(undefined) }}>
          <div className="dshAsbGit-confirm" role="dialog" aria-modal="true" aria-labelledby="dshAsbGit-restoreTitle" onClick={(event) => { event.stopPropagation() }}>
            <h2 id="dshAsbGit-restoreTitle">{t('sidebar.restore.title')}</h2>
            <p>{t('sidebar.restore.before')}<code>{restoreFor}</code>{t('sidebar.restore.after')}</p>
            <div className="dshAsbGit-confirmActions">
              <button type="button" className="dshAsbGit-reviewBtn" disabled={busy} onClick={() => { setRestoreFor(undefined) }}>{t('sidebar.cancel')}</button>
              <button type="button" className="dshAsbGit-dangerBtn" disabled={busy}
                onClick={() => {
                  const path = restoreFor
                  setRestoreFor(undefined)
                  void run(() => gitApi.action('restore', cwd, path, undefined, sessionId), t('sidebar.action.restored'))
                }}>{t('sidebar.restore.confirm')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Git tab styles (prefix dshAsbGit-). */
const GIT_CSS = `
/* Popover/dialog surface: the native dark --dsw-alias-bg-overlay resolves
   to a mid grey (97,102,107) that reads as a bright slab against the
   near-black UI; the redesigned dark palette is black-based, so use the
   layer-1 black there (light theme keeps the token default). */
:root { --dshapp-overlay: var(--dsw-alias-bg-overlay, #fff); }
body[data-ds-dark-theme] { --dshapp-overlay: var(--dsw-alias-bg-layer-1); }
.dshAsbGit { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px max(160px, var(--dsh-composer-height, 152px) + 16px); min-height: 0; flex: 1 1 auto; width: 100%; box-sizing: border-box; overflow: hidden; }
.dshAsbGit-cols { display: flex; flex: 1 1 0; min-height: 0; overflow: hidden; gap: 0; }
.dshAsbGit-list { flex: none; min-height: 0; overflow: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 6px; padding-right: 10px; }
.dshAsbGit-list > * { flex-shrink: 0; }
.dshAsbGit-resize { flex: none; width: 8px; cursor: col-resize; margin: 0 -2px 0 2px; z-index: 2; }
.dshAsbGit-detail { flex: 1 1 0; min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 6px; padding-left: 8px; }
.dshAsbGit-detail > * { flex-shrink: 0; }
.dshAsbGit-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshAsbGit-branchWrap { position: relative; min-width: 0; max-width: 58%; }
.dshAsbGit-branchBtn { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; padding: 3px 10px; border: none; border-radius: 999px; background: rgba(148, 163, 184, 0.2); color: var(--dsw-alias-label-secondary, #475569); cursor: pointer; font-size: 11.5px; }
.dshAsbGit-branchBtn:hover:not(:disabled) { background: rgba(148, 163, 184, 0.34); color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGit-branchBtn:disabled { opacity: .55; cursor: default; }
.dshAsbGit-branchText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsbGit-diverge { flex: none; font-size: 10.5px; font-weight: 600; color: var(--dsw-alias-brand-primary, #2563eb); }
.dshAsbGit-branchCaret { flex: none; font-size: 9px; opacity: .65; }
.dshAsbGit-topActions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: none; }
.dshAsbGit-syncGroup { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 999px; }
.dshAsbGit-syncBtn { padding: 2px 9px; border: none; border-radius: 999px; background: none; color: var(--dsw-alias-label-secondary, #475569); cursor: pointer; font-size: 11px; }
.dshAsbGit-syncBtn:hover:not(:disabled) { background: rgba(148, 163, 184, 0.18); color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGit-syncBtn:disabled { opacity: .5; cursor: default; }
.dshAsbGit-branchMenu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 55; width: min(280px, 90vw); max-height: 320px; overflow: auto; box-sizing: border-box; padding: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 10px; background: var(--dshapp-overlay); box-shadow: 0 12px 32px rgba(0, 0, 0, .18); display: flex; flex-direction: column; gap: 2px; }
.dshAsbGit-branchMenuTitle { margin: 0 0 4px; padding: 0 6px; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11px; }
.dshAsbGit-branchItem { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 5px 6px; border: none; border-radius: 6px; background: none; color: inherit; text-align: left; cursor: pointer; font-size: 12px; }
.dshAsbGit-branchItem:hover:not(:disabled) { background: rgba(148, 163, 184, 0.16); }
.dshAsbGit-branchItem:disabled { opacity: .5; cursor: default; }
.dshAsbGit-branchItemCur { color: var(--dsw-alias-brand-primary, #2563eb); font-weight: 600; }
.dshAsbGit-branchItemMark { flex: none; width: 12px; font-size: 10px; }
.dshAsbGit-branchItemName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsbGit-branchCreate { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAsbGit-branchCreate .dshAsbGit-input { flex: 1; min-width: 0; }
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
.dshAsbGit-primary { padding: 6px 14px; border: none; border-radius: 8px; background: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-label-primary-foreground, #fff); cursor: pointer; font-size: 12px; flex: none; font-weight: 600; }
.dshAsbGit-primary:disabled { opacity: .5; cursor: default; }
.dshAsbGit-reviewBtn { flex: none; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary, #475569); cursor: pointer; font-size: 12px; }
.dshAsbGit-reviewBtn:hover { background: rgba(148, 163, 184, 0.18); color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGit-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-top: 2px; }
.dshAsbGit-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-left: auto; justify-content: flex-end; }
.dshAsbGit-title { font-weight: 600; font-size: 13px; }
.dshAsbGit-group { margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11px; }
.dshAsbGit-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; overflow: hidden; }
.dshAsbGit-row:hover { background: rgba(148, 163, 184, 0.16); }
.dshAsbGit-rowPath { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; padding: 0; border: none; background: none; color: inherit; text-align: left; cursor: pointer; font-size: 12.5px; }
.dshAsbGit-letter { flex: none; width: 14px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary, #94a3b8); }
.dshAsbGit-letterStaged { color: var(--dsw-alias-state-success-primary, #16a34a); }
.dshAsbGit-letterNew { color: var(--dsw-alias-label-primary, #2563eb); }
.dshAsbGit-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsbGit-rowActions { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 44px; min-width: 44px; visibility: hidden; opacity: 0; pointer-events: none; }
.dshAsbGit-row:hover .dshAsbGit-rowActions, .dshAsbGit-row:focus-within .dshAsbGit-rowActions { visibility: visible; opacity: 1; pointer-events: auto; }
.dshAsbGit-link { min-height: 24px; padding: 2px 4px; border: none; border-radius: 4px; background: none; color: var(--dsw-alias-brand-primary, #3b82f6); cursor: pointer; font-size: 11.5px; }
.dshAsbGit-link:disabled { opacity: .5; cursor: default; }
.dshAsbGit-linkDanger { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dshAsbGit-input { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 12.5px; }
.dshAsbGit-commitRow { display: flex; align-items: center; gap: 6px; }
.dshAsbGit-commitRow .dshAsbGit-input { flex: 1; min-width: 0; }
.dshAsbGit-primary { padding: 5px 12px; border: none; border-radius: 6px; background: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-label-primary-foreground, #fff); cursor: pointer; font-size: 12px; flex: none; }
.dshAsbGit-primary:disabled { opacity: .5; cursor: default; }
.dshAsbGit-diffBlock { display: flex; flex-direction: column; gap: 4px; }
.dshAsbGit-diffPath { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 11.5px; white-space: normal; overflow-wrap: anywhere; word-break: break-all; line-height: 1.5; }
.dshAsbGit-commitMsg { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-family: inherit; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.dshAsbGit-diff, .dshAsbGit-graph { margin: 0; padding: 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.5; overflow: auto; max-height: calc(100vh - 280px); }
.dshAsbGit-diffAdd { color: var(--dsw-alias-state-success-primary, #15803d); background: rgba(22, 163, 74, 0.08); }
.dshAsbGit-diffDel { color: var(--dsw-alias-state-error-primary, #b91c1c); background: rgba(220, 38, 38, 0.08); }
.dshAsbGit-graph { white-space: pre; color: var(--dsw-alias-label-primary, #0f172a); }
.dshAsbGraph { display: flex; flex-direction: column; }
.dshAsbGraph-line { display: block; width: 100%; padding: 0; border: none; background: none; color: inherit; text-align: left; cursor: pointer; font-family: inherit; font-size: inherit; line-height: inherit; }
.dshAsbGraph-line:hover { background: rgba(59, 130, 246, 0.1); }
.dshAsbGraph-plain { display: block; white-space: pre; }
.dshAsbGit-top[hidden] { display: none; }
.dshAsbGit-modalMask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.5)); }
.dshAsbGit-modal { display: flex; flex-direction: column; width: min(860px, calc(100vw - 80px)); max-height: min(640px, calc(100vh - 96px)); border-radius: 10px; background: var(--dshapp-overlay); box-shadow: 0 20px 50px rgba(0, 0, 0, .25); }
.dshAsbGit-modalHead { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAsbGit-modalHead .dshAsbGit-title { flex: 1; }
.dshAsbGit-modalClose { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px; background: none; color: var(--dsw-alias-label-secondary, #64748b); cursor: pointer; font-size: 11px; }
.dshAsbGit-modalClose:hover { background: rgba(148, 163, 184, 0.3); }
.dshAsbGit-confirm { width: min(420px, calc(100vw - 40px)); padding: 18px; border-radius: 12px; background: var(--dshapp-overlay); box-shadow: 0 20px 50px rgba(0, 0, 0, .25); }
.dshAsbGit-confirm h2 { margin: 0 0 8px; font-size: 15px; }
.dshAsbGit-confirm p { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.dshAsbGit-confirm code { color: var(--dsw-alias-label-primary, #0f172a); font-family: ui-monospace, Consolas, monospace; }
.dshAsbGit-confirmActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.dshAsbGit-dangerBtn { min-height: 30px; padding: 5px 12px; border: none; border-radius: 7px; background: #dc2626; color: #fff; cursor: pointer; font-size: 12px; }
.dshAsbGit-dangerBtn:disabled { opacity: .5; cursor: default; }
.dshAsbGit-modalBody { padding: 12px 14px; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.dshAsbGit-dirRow { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; cursor: pointer; border: none; background: none; color: inherit; width: 100%; text-align: left; font-size: 12.5px; user-select: none; -webkit-user-select: none; }
.dshAsbGit-dirRow:hover { background: rgba(148, 163, 184, 0.16); }
.dshAsbGit-dirName { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsbGit-dirCount { margin-left: 2px; padding: 0 6px; border-radius: 999px; background: rgba(148, 163, 184, 0.18); color: var(--dsw-alias-label-secondary, #64748b); font-size: 10.5px; }
.dshAsbGit-fileRow { padding-left: 18px; border-left: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.10)); margin-left: 12px; }
.dshAsbError-box { margin: 2px 0; color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshAsb-hint { margin: 2px 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 12px; }
.dshAsb-error { margin: 2px 0; color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 12px; }
.dshAsb-notice { margin: 2px 0; color: var(--dsw-alias-state-success-primary, #16a34a); font-size: 12px; }
.dshAsbGit-warning { margin: 2px 0; padding: 6px 8px; border-radius: 6px; background: rgba(234, 179, 8, .14); color: var(--dsw-alias-state-warn-primary, #a16207); font-size: 11px; }
.dshAsbGit-rowPath:focus-visible, .dshAsbGit-dirRow:focus-visible, .dshAsbGit-link:focus-visible, .dshAsbGit-primary:focus-visible, .dshAsbGit-ghostBtn:focus-visible, .dshAsbGit-segBtn:focus-visible, .dshAsbGit-reviewBtn:focus-visible, .dshAsbGit-dangerBtn:focus-visible, .dshAsbGit-modalClose:focus-visible, .dshAsbGraph-line:focus-visible, .dshAsbGit-input:focus-visible, .dshAsbGit-branchBtn:focus-visible, .dshAsbGit-syncBtn:focus-visible, .dshAsbGit-branchItem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: 2px; }
@media (hover: none), (pointer: coarse) { .dshAsbGit-rowActions { visibility: visible; opacity: 1; pointer-events: auto; } }
`
