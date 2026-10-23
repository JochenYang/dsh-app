/**
 * The conversation-page graph view.
 *
 * A native `conversation.view` tab (the same ring 对话 / 审查 / 轨迹 and the Git
 * view register into), so there is no floating chrome to mis-position and the
 * panel can never cover the chat.
 *
 * Two zooms, one component, because they are one picture:
 *
 *   - **files** — the overview. One node per file, positioned on a circle by a
 *     deterministic order, edges being cross-file imports and calls. A circle is
 *     chosen over a force layout on purpose: a simulation re-arranges on every
 *     frame, so the same graph draws a different picture each visit and a reader
 *     cannot build a mental map of it. Sorted order on a circle is stable.
 *   - **one file** — its symbols down a column, in line order, with the calls
 *     between them. Clicking a file switches to it; the back link returns.
 *
 * Why the drawing is hand-written rather than a charting library: the whole
 * surface is nodes, lines and two labels, and the suite's rule is that a client
 * half composes the host's primitives rather than pulling in a renderer of its
 * own. Nothing here re-implements a primitive — there is no dialog, no diff, no
 * table — only an `<svg>` with circles, lines and `<text>`.
 *
 * @module @dsh-app/plugin-codegraph/client/graph-tab
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type CodegraphKey } from './locales.ts'

/** The route prefix the host half registers. */
const ROUTE_PREFIX = '/api/plugins/dsh-app/codegraph'

/** The view's translate seat. */
type CodegraphTranslate = TranslateNS<typeof NS>

/** One file node as the host reports it. */
interface FileNode {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly symbols: number
}

/** One symbol node as the host reports it. */
interface SymbolNode {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly line: number
  readonly parent?: string
}

/** One edge between two nodes. */
interface ViewEdge {
  readonly from: string
  readonly to: string
  readonly kind: string
}

/** What `GET /graph` answers, tagged by zoom. */
type GraphAnswer =
  | { readonly kind: 'files', readonly files: FileGraphPayload }
  | { readonly kind: 'symbols', readonly symbols: SymbolGraphPayload }
  /** No graph yet; a pass was queued, so ask again shortly. */
  | { readonly kind: 'indexing' }

/** A host failure carrying the coded message the client renders. */
interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly text?: string
}

/**
 * The hook a view gets when the framework did not hand one over.
 *
 * Module-level and stable: a fresh arrow on every render would be a new selector
 * identity each time, which makes the hook re-subscribe on every pass. It answers
 * undefined, so a view without the prop renders the "no session" note instead of
 * throwing.
 */
const NO_SESSIONS = (): undefined => undefined

/** Fetch one route and unwrap the suite envelope. */
async function fetchGraph<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string, host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value as T
}

/** The overview payload, as the host sends it. */
interface FileGraphPayload {
  readonly nodes: readonly FileNode[]
  readonly edges: readonly ViewEdge[]
  readonly truncated: boolean
  readonly totalFiles: number
}

/** One file's symbols, as the host sends them. */
interface SymbolGraphPayload {
  readonly path: string
  readonly nodes: readonly SymbolNode[]
  readonly edges: readonly ViewEdge[]
  readonly truncated: boolean
  readonly totalSymbols: number
}

/**
 * The file overview.
 *
 * A LIST, not a ring. The ring was the first attempt and it failed the moment
 * file names got long: `RapooBatteryTray.GlobalUsings.g.cs` beside `AutoStart.cs`
 * on a fixed-radius circle puts every label on top of its neighbour, and the
 * picture stops being readable exactly when a project has enough files to be
 * worth drawing.
 *
 * What the reader actually asks of this screen is "which files are big, and where
 * do they live" — both of which a grouped list answers better than a diagram:
 *
 *   - grouped by directory, so the tree structure is the layout itself;
 *   - one row per file, with its symbol count as a proportional bar, so size is
 *     comparable down the column instead of guessed from a circle's radius;
 *   - the row is the click target, so the label is part of it.
 *
 * The reference counts (how many other files import this one) ride along as a
 * quiet number: it is the one fact the file-level graph carries that the file
 * list cannot show on its own.
 */
function FileOverview({ files, onOpen, t }: {
  files: FileGraphPayload
  onOpen: (path: string) => void
  t: CodegraphTranslate
}): ReactNode {
  const groups = useMemo(() => groupByDirectory(files.nodes), [files.nodes])
  const largest = useMemo(() => Math.max(1, ...files.nodes.map(node => node.symbols)), [files.nodes])
  const inbound = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of files.edges) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1)
    return counts
  }, [files.edges])
  return (
    <div className="dshcg_viewPad">
      <div className="dshcg_viewHead">
        <h2 className="dshcg_viewHeadTitle">{t('codegraph.view.title')}</h2>
        <span className="dshcg_viewHeadMeta">
          {t('codegraph.view.totals', { files: files.nodes.length, total: files.totalFiles })}
        </span>
      </div>
      {groups.map((group) => (
        <section key={group.dir} className="dshcg_group">
          <h3 className="dshcg_groupTitle">{group.dir === '' ? t('codegraph.view.root') : group.dir}</h3>
          <ul className="dshcg_files">
            {group.files.map((node) => {
              const refs = inbound.get(node.id) ?? 0
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    className="dshcg_file"
                    onClick={() => { onOpen(node.path) }}
                  >
                    <span className="dshcg_fileName">{node.name}</span>
                    {/* A proportional bar rather than a number alone: length is
                        read at a glance down the column, the count is read only
                        when the reader wants it. */}
                    <span className="dshcg_fileBar" aria-hidden="true">
                      <span
                        className="dshcg_fileBarFill"
                        style={{ width: `${String(Math.max(2, Math.round((node.symbols / largest) * 100)))}%` }}
                      />
                    </span>
                    <span className="dshcg_fileCount">{t('codegraph.view.fileMeta', { count: node.symbols })}</span>
                    <span className="dshcg_fileRefs">
                      {refs === 0 ? '' : t('codegraph.view.refs', { count: refs })}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {files.truncated
        ? <p className="dshcg_viewNote">{t('codegraph.view.truncated', { kept: files.nodes.length, total: files.totalFiles })}</p>
        : null}
    </div>
  )
}

/**
 * Files grouped by their directory, in path order.
 *
 * The group KEY is the directory with a trailing slash so the root group sorts
 * first (`` sorts before any name), and the display drops it. Grouping here
 * rather than on the host keeps the wire payload one flat list — a projection
 * that already exists and is tested.
 */
function groupByDirectory(nodes: readonly FileNode[]): { dir: string, files: FileNode[] }[] {
  const byDir = new Map<string, FileNode[]>()
  for (const node of nodes) {
    const slash = node.path.lastIndexOf('/')
    const dir = slash < 0 ? '' : node.path.slice(0, slash)
    const list = byDir.get(dir)
    if (list === undefined) byDir.set(dir, [node])
    else list.push(node)
  }
  return [...byDir.entries()]
    .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))
    .map(([dir, list]) => ({ dir, files: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
}

/** One file's symbols, in line order, with the calls between them. */
function SymbolList({ symbols, onBack, t }: {
  symbols: SymbolGraphPayload
  onBack: () => void
  t: CodegraphTranslate
}): ReactNode {
  // The edges are drawn as a quiet "→" on the caller rather than as a diagram:
  // a file's symbols are a COLUMN at reading order, and a curve between two rows
  // a few pixels apart carries less than the name of the callee does.
  const callsFrom = useMemo(() => {
    const byId = new Map(symbols.nodes.map(node => [node.id, node.name]))
    const map = new Map<string, string[]>()
    for (const edge of symbols.edges) {
      const callee = byId.get(edge.to)
      if (callee === undefined) continue
      const list = map.get(edge.from)
      if (list === undefined) map.set(edge.from, [callee])
      else list.push(callee)
    }
    return map
  }, [symbols.nodes, symbols.edges])
  return (
    <div className="dshcg_viewFile">
      {/* A BACK BUTTON, not a text link sitting in the title row. It was a bare
          `<button>` with no border and no padding, which read as part of the
          heading — the one control on the screen that must look pressable. */}
      <div className="dshcg_viewFileHead">
        {/* Text only. The arrow was decoration: the label already says "all
            files", and a glyph beside it only adds a second thing to read. */}
        <button type="button" className="dshcg_viewBack" onClick={onBack}>
          {t('codegraph.view.back')}
        </button>
      </div>
      <div className="dshcg_viewFileTitle" title={symbols.path}>{symbols.path}</div>
      {symbols.nodes.length === 0
        ? <p className="dshcg_viewNote">{t('codegraph.view.emptyFile')}</p>
        : (
          // A TABLE, because the three columns carry three different kinds of
          // fact (what it is, what it is called, where it lives) and a reader
          // scans down each one. The flex row this replaces let every row size
          // itself, so the line numbers landed at a different x on every row.
          <table className="dshcg_symbols">
            <thead>
              <tr>
                <th scope="col">{t('codegraph.view.colKind')}</th>
                <th scope="col">{t('codegraph.view.colName')}</th>
                <th scope="col">{t('codegraph.view.colLine')}</th>
                <th scope="col">{t('codegraph.view.colCalls')}</th>
              </tr>
            </thead>
            <tbody>
              {symbols.nodes.map((node) => {
                const callees = callsFrom.get(node.id) ?? []
                return (
                  <tr key={node.id}>
                    <td className="dshcg_symbolKind" data-kind={node.kind}>{node.kind}</td>
                    <td className="dshcg_symbolName">{node.parent === undefined ? node.name : `${node.parent}.${node.name}`}</td>
                    <td className="dshcg_symbolLine">{node.line}</td>
                    <td className="dshcg_symbolCalls">
                      {callees.length === 0 ? '' : `→ ${callees.join(', ')}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      {symbols.truncated
        ? <p className="dshcg_viewNote">{t('codegraph.view.truncated', { kept: symbols.nodes.length, total: symbols.totalSymbols })}</p>
        : null}
    </div>
  )
}

/**
 * The session's project directory, from the framework's own session list.
 *
 * `useSessions` is a standard prop on EVERY slot component, so the view reads the
 * list the same way the shell does — no service lookup in `apply` (an undeclared
 * read of the traced proxy throws), and no second source of truth about which
 * project a session belongs to. The session-scoped snapshot carries no `cwd`; the
 * LIST row does, which is the accessor upstream itself uses.
 *
 * The hook is called at the TOP LEVEL of the component, never inside `useMemo`:
 * `useSessions` IS a hook, so calling it from a memo callback makes the hook count
 * depend on whether the memo recomputed, which React rejects — the view then
 * throws and its slot entry is dropped, which reads as "the tab is empty". The
 * selector itself is what does the narrowing, so the memo was never needed.
 *
 * @param useSessions - the framework's selector hook over the session list.
 * @param sessionId - the session whose project is wanted.
 * @returns the project directory, or undefined outside a project.
 */
function useProjectDir(
  useSessions: (select: (state: unknown) => unknown) => unknown,
  sessionId: string | undefined,
): string | undefined {
  const cwd = useSessions((state) => {
    if (sessionId === undefined) return undefined
    const byId = (state as { byId?: Readonly<Record<string, { cwd?: unknown } | undefined>> } | undefined)?.byId
    const value = byId?.[sessionId]?.cwd
    return typeof value === 'string' && value !== '' ? value : undefined
  })
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** What the tab body receives from the view-tab ring. */
export interface GraphTabProps extends PropsLocale<typeof NS> {
  /** Current session identity, supplied by the framework. */
  readonly sessionId?: string | undefined
  /** Framework selector hook over the session list (standard slot prop). */
  readonly useSessions?: (select: (state: unknown) => unknown) => unknown
}

/** The tab body. */
export function GraphTab({ sessionId, useSessions, t }: GraphTabProps): ReactNode {
  const cwd = useProjectDir(useSessions ?? NO_SESSIONS, sessionId)
  const [answer, setAnswer] = useState<GraphAnswer | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [openPath, setOpenPath] = useState<string | undefined>(undefined)
  // A generation counter discards a stale load: switching files quickly issues two
  // requests, and last-response-wins would show the previous file's symbols under
  // the new file's name.
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = generation.current + 1
    generation.current = mine
    if (cwd === undefined) {
      setAnswer(undefined)
      return
    }
    try {
      const url = openPath === undefined
        ? `${ROUTE_PREFIX}/graph?cwd=${encodeURIComponent(cwd)}`
        : `${ROUTE_PREFIX}/graph?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(openPath)}`
      const next = await fetchGraph<GraphAnswer>(url)
      if (generation.current !== mine) return
      setAnswer(next)
      setFailure(undefined)
    } catch (error: unknown) {
      if (generation.current !== mine) return
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [cwd, openPath])

  useEffect(() => { void load() }, [load])

  // While the host reports `indexing`, ask again. The first visit to a project
  // that has never been indexed gets that answer, and without this poll the page
  // would sit on "building" for ever even after the pass finished.
  //
  // The delay is deliberately unhurried: a first pass over a real repository takes
  // seconds to minutes, so polling faster would only add load. Each tick is one
  // request that answers immediately from the queue's own state.
  useEffect(() => {
    if (answer?.kind !== 'indexing') return
    const timer = setTimeout(() => { void load() }, 2500)
    return () => { clearTimeout(timer) }
  }, [answer, load])

  if (cwd === undefined) {
    return <p className="dshcg_viewNote dshcg_viewPad">{t('codegraph.view.noSession')}</p>
  }
  if (failure !== undefined) {
    // The host's own diagnostic, which names the cause; the copy above it says
    // what was being read.
    return <p className="dshcg_viewNote dshcg_viewPad" role="alert">{failure}</p>
  }
  if (answer === undefined) {
    return <p className="dshcg_viewNote dshcg_viewPad">{t('codegraph.view.loading')}</p>
  }
  if (answer.kind === 'indexing') {
    // Distinct from `loading`: the host has started a pass and this page is
    // waiting for it, which is a different thing to say than "reading".
    return <p className="dshcg_viewNote dshcg_viewPad">{t('codegraph.view.indexing')}</p>
  }
  if (answer.kind === 'symbols') {
    return <SymbolList symbols={answer.symbols} onBack={() => { setOpenPath(undefined) }} t={t} />
  }
  if (answer.files.nodes.length === 0) {
    return <p className="dshcg_viewNote dshcg_viewPad">{t('codegraph.view.empty')}</p>
  }
  return <FileOverview files={answer.files} onOpen={setOpenPath} t={t} />
}
