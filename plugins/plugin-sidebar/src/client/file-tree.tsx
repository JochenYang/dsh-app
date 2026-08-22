/**
 * The 文件 view (full page): a two-column workspace browser — the file tree
 * on the left, the preview pane on the right. The tree auto-expands the
 * workspace root on mount (a collapsed root labeled "empty" was a common
 * first-run confusion), and each directory loads lazily when expanded.
 */

import { useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { ReactNode } from 'react'
import type { FsListEntry } from '../fs-routes.ts'
import { FsApiError, listDir, readFile } from './api.ts'
import type { FileContent } from './api.ts'

/** Props of {@link FileTreeTab} (view inject face; extra fields ignored). */
export interface FileTreeTabProps {
  /** Workspace root (the session cwd); undefined with no session. */
  cwd: string | undefined
  sessionId?: unknown
  api?: unknown
}

/** One lazy directory node's loaded children (undefined = not loaded). */
type Children = readonly FsListEntry[] | undefined

/** Chevron that rotates with expansion. */
function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease', flex: 'none' }}>
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Whether a preview path ends with a Markdown extension. */
function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/iu.test(path)
}

/**
 * Sanitize schema over the GitHub default. README mark-up commonly carries
 * legacy alignment attributes and sized images; both are inert, so keep them
 * instead of dropping the tag. Everything else — scripts, event handlers,
 * iframes, javascript:/data: URLs, style elements — stays stripped by the
 * defaults (defaultSchema.tagNames admits no script/style/iframe).
 */
const MD_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    p: [['align']],
    h1: [['align']],
    h2: [['align']],
    h3: [['align']],
    h4: [['align']],
    table: [['align']],
    th: [['align']],
    td: [['align']],
    // defaultSchema's img lacks alt/width/height; keep them for real READMEs.
    img: [['src'], ['alt'], ['width'], ['height'], ['title'], ['align']],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Base64 images inline in markdown previews (src, not href — href keeps
    // its http/https/irc/ircs/mailto/xmpp list from the defaults).
    src: ['http', 'https', 'data'],
  },
}

/**
 * Rendered Markdown preview: GFM tables/task lists, raw-HTML README mark-up
 * through rehype-raw, then a sanitize pass so hostile files stay inert
 * (scripts, event handlers and iframes are stripped, not emitted). Links
 * keep their href — the shell's navigation fence handles open-external.
 */
export function MarkdownPreview(props: { content: string }): ReactNode {
  return (
    <div className="dshAsb-md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, MD_SCHEMA]]}
      >
        {props.content}
      </Markdown>
    </div>
  )
}

/** One tree row (directory or file). */
function TreeRow(props: {
  entry: FsListEntry
  depth: number
  expanded: boolean
  selected: boolean
  onToggleDir: () => void
  onOpenFile: () => void
}): ReactNode {
  const { entry, depth } = props
  const pad = `${String(8 + depth * 14)}px`
  if (entry.kind === 'dir') {
    return (
      <button type="button" className={`dshAsb-treeRow${props.selected ? ' dshAsb-treeRowSelected' : ''}`}
        style={{ paddingLeft: pad }} aria-expanded={props.expanded}
        onClick={props.onToggleDir}>
        <Chevron open={props.expanded} />
        <span className="dshAsb-treeName" title={entry.name}>{entry.name}</span>
      </button>
    )
  }
  const isFile = entry.kind === 'file'
  return (
    <button type="button" className={`dshAsb-treeRow${props.selected ? ' dshAsb-treeRowSelected' : ''}`}
      style={{ paddingLeft: pad }} disabled={!isFile} title={isFile ? entry.name : '失效的链接'}
      onClick={props.onOpenFile}>
      <span className="dshAsb-treeLeafMark" aria-hidden />
      <span className={`dshAsb-treeName${isFile ? '' : ' dshAsb-treeBroken'}`}>{entry.name}</span>
    </button>
  )
}

/**
 * The file view body: tree left, preview right.
 * @param props - the workspace root.
 * @returns the two-column browser.
 */
export function FileTreeTab(props: FileTreeTabProps): ReactNode {
  const { cwd } = props
  const [children, setChildren] = useState<ReadonlyMap<string, Children>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<{ path: string, content: FileContent | undefined, error: string | undefined } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [style] = useState(FILE_TREE_CSS)

  // A workspace switch resets every tree state, then auto-expands the root:
  // the first thing a user wants is its contents, not a collapsed spinner.
  useEffect(() => {
    setChildren(new Map())
    setExpanded(new Set())
    setSelected(undefined)
    setPreview(undefined)
    setError(undefined)
    if (cwd !== undefined) {
      const path = cwd.replace(/\\/gu, '/')
      listDir(path).then(
        result => {
          setChildren(new Map([[path, result.entries]]))
          setExpanded(new Set([path]))
          setError(undefined)
        },
        (failure: unknown) => {
          const message = failure instanceof FsApiError ? failure.message : String(failure)
          setError(`无法读取 ${cwd}：${message}`)
        },
      )
    }
  }, [cwd])

  const toggleDir = (dir: string): void => {
    setExpanded(current => {
      const next = new Set(current)
      if (!next.delete(dir)) next.add(dir)
      return next
    })
  }

  // Load a directory level when it becomes visible (expanded and not yet loaded).
  const pending = useMemo(() => {
    const missing: string[] = []
    for (const dir of expanded) {
      if (!children.has(dir)) missing.push(dir)
    }
    return missing
  }, [expanded, children])

  useEffect(() => {
    if (cwd === undefined || pending.length === 0) return
    let stale = false
    for (const dir of pending) {
      listDir(dir).then(
        result => {
          if (stale) return
          setChildren(current => new Map(current).set(result.dir, result.entries))
          setError(undefined)
        },
        (failure: unknown) => {
          if (stale) return
          const message = failure instanceof FsApiError ? failure.message : String(failure)
          setChildren(current => new Map(current).set(dir, []))
          setError(`无法读取 ${dir}：${message}`)
        },
      )
    }
    return () => { stale = true }
  }, [cwd, pending, children])

  const openFile = (path: string): void => {
    setSelected(path)
    setPreview({ path, content: undefined, error: undefined })
    readFile(path).then(
      content => { setPreview(current => current === undefined || current.path !== path ? current : { path, content, error: undefined }) },
      (failure: unknown) => {
        const message = failure instanceof FsApiError ? failure.message : String(failure)
        setPreview(current => current === undefined || current.path !== path ? current : { path, content: undefined, error: message })
      },
    )
  }

  if (cwd === undefined) {
    return (
      <div className="dshAsbTree-root">
        <style>{style}</style>
        <p className="dshAsb-hint">打开一个会话后，可在这里浏览其工作区文件。</p>
      </div>
    )
  }

  // Tree rows: iterative DFS over expanded+loaded nodes, depth-tracked.
  const root = cwd.replace(/\\/gu, '/')
  const rows: { entry: FsListEntry, dir: string, depth: number }[] = [{ entry: { name: root, kind: 'dir' }, dir: root, depth: -1 }]
  const walk = (dir: string, depth: number): void => {
    const kids = children.get(dir)
    if (kids === undefined) return
    for (const entry of kids) {
      rows.push({ entry, dir, depth })
      if (entry.kind === 'dir' && expanded.has(`${dir}/${entry.name}`.replace(/\\/gu, '/'))) {
        walk(`${dir}/${entry.name}`.replace(/\\/gu, '/'), depth + 1)
      }
    }
  }
  walk(root, 0)
  const fileCount = rows.length - 1

  return (
    <div className="dshAsbTree-root" data-conversation-composer-overlay="">
      <style>{style}</style>
      <div className="dshAsbTree-cols">
        <div className="dshAsbTree-pane">
          {error !== undefined ? <p className="dshAsb-error">{error}</p> : null}
          {rows.map((row, index) => {
            const path = index === 0 ? root : `${row.dir}/${row.entry.name}`.replace(/\\/gu, '/')
            const isRoot = index === 0
            const name = isRoot ? root.split(/[\\/]/).pop() ?? root : row.entry.name
            return (
              <TreeRow
                key={path}
                entry={isRoot ? { name, kind: 'dir' } : row.entry}
                depth={isRoot ? 0 : row.depth + 1}
                expanded={expanded.has(path)}
                selected={selected === path}
                onToggleDir={() => { toggleDir(path) }}
                onOpenFile={() => { openFile(path) }}
              />
            )
          })}
          <p className="dshAsb-hint">
            {fileCount === 0
              ? (expanded.has(root) ? '（空目录）' : '加载中…')
              : `${String(fileCount)} 项`}
          </p>
        </div>
        <div className="dshAsbTree-preview">
          {preview === undefined
            ? <p className="dshAsb-hint">选择左侧文件以预览。</p>
            : (
              <>
                <p className="dshAsb-previewMeta" title={preview.path}>{preview.path}</p>
                {preview.error !== undefined ? <p className="dshAsb-error">{preview.error}</p> : null}
                {preview.content === undefined && preview.error === undefined ? <p className="dshAsb-hint">加载中…</p> : null}
                {preview.content?.kind === 'text'
                  ? isMarkdownPath(preview.path)
                    ? <MarkdownPreview content={preview.content.content} />
                    : <pre className="dshAsb-pre">{preview.content.content}</pre>
                  : null}
                {preview.content?.kind === 'image'
                  ? <img className="dshAsb-img" alt={preview.path} src={`data:${preview.content.mime};base64,${preview.content.dataBase64}`} />
                  : null}
                {preview.content?.kind === 'unsupported'
                  ? <p className="dshAsb-hint">{preview.content.reason}</p>
                  : null}
              </>
            )}
        </div>
      </div>
    </div>
  )
}

/** File view styles (prefix dshAsb/dshAsbTree-); the root mirrors the
 * official trajectory view's layout baseline (height/width 100%, hidden
 * overflow, box-sizing) — that is what keeps the two columns scrolling
 * independently inside a bounded view area. */
const FILE_TREE_CSS = `
.dshAsbTree-root { display: flex; flex-direction: column; overflow: hidden; height: 100%; min-height: 0; width: 100%; box-sizing: border-box; font-size: 13px; color: var(--dsw-alias-label-primary, #0f172a); background: var(--dsw-alias-bg-layer-1, #fff); }
.dshAsbTree-cols { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.dshAsbTree-pane { width: 300px; flex: none; min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 10px 8px calc(var(--dsh-composer-height, 132px) + 16px); border-right: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); display: flex; flex-direction: column; gap: 2px; }
.dshAsbTree-preview { flex: 1; min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 12px 16px calc(var(--dsh-composer-height, 132px) + 16px); display: flex; flex-direction: column; gap: 6px; }
.dshAsbTree-pane > .dshAsb-hint, .dshAsbTree-pane > .dshAsb-error { text-align: right; padding-right: 4px; }
.dshAsb-treeRow { display: flex; align-items: center; gap: 5px; width: 100%; padding: 4px 8px 4px 8px; border: none; border-radius: 6px; background: none; color: inherit; text-align: left; cursor: pointer; font-size: 12.5px; min-width: 0; transition: background 80ms ease; }
.dshAsb-treeRow:hover:not(:disabled) { background: rgba(148, 163, 184, 0.28); }
.dshAsb-treeRowSelected { background: rgba(59, 130, 246, 0.18); color: #2563eb; }
.dshAsb-treeRow:disabled { cursor: default; }
.dshAsb-treeName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAsb-treeBroken { color: var(--dsw-alias-label-secondary, #94a3b8); text-decoration: line-through; }
.dshAsb-treeLeafMark { flex: none; width: 12px; height: 0; }
.dshAsb-previewMeta { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 11.5px; white-space: normal; overflow-wrap: anywhere; word-break: break-all; line-height: 1.5; }
.dshAsb-pre { margin: 0; padding: 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow: auto; }
.dshAsb-img { max-width: 100%; border-radius: 8px; }
.dshAsb-error { margin: 2px 0; color: #dc2626; font-size: 12px; }
.dshAsb-hint { margin: 4px 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 12px; }
.dshAsb-md { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-size: 12.5px; line-height: 1.65; overflow-wrap: anywhere; }
.dshAsb-md > :first-child { margin-top: 0; }
.dshAsb-md > :last-child { margin-bottom: 0; }
.dshAsb-md h1, .dshAsb-md h2, .dshAsb-md h3, .dshAsb-md h4 { margin: 0.9em 0 0.45em; line-height: 1.3; font-weight: 600; }
.dshAsb-md h1 { font-size: 1.25em; }
.dshAsb-md h2 { font-size: 1.15em; }
.dshAsb-md h3 { font-size: 1.05em; }
.dshAsb-md p { margin: 0.5em 0; }
.dshAsb-md a { color: var(--dsw-alias-brand-primary, #2563eb); }
.dshAsb-md code { padding: 0.1em 0.35em; border-radius: 4px; background: rgba(100, 116, 139, 0.18); font-family: ui-monospace, Consolas, monospace; font-size: 0.95em; }
.dshAsb-md pre { margin: 0.5em 0; padding: 8px 10px; border-radius: 6px; background: rgba(15, 23, 42, 0.06); overflow: auto; }
.dshAsb-md pre code { padding: 0; background: none; }
.dshAsb-md ul, .dshAsb-md ol { margin: 0.5em 0; padding-left: 1.5em; }
.dshAsb-md blockquote { margin: 0.5em 0; padding: 0.2em 0.8em; border-left: 3px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); color: var(--dsw-alias-label-secondary, #64748b); }
.dshAsb-md table { border-collapse: collapse; }
.dshAsb-md th, .dshAsb-md td { padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAsb-md img { max-width: 100%; border-radius: 6px; }
.dshAsb-md hr { margin: 0.9em 0; border: none; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
`
