/**
 * The code graph's own sidebar page: every project, then one project's graph.
 *
 * Two levels, because they answer two different questions:
 *
 *   - **All projects** — which projects have a graph, how fresh it is, and how
 *     big. This is the only screen that can answer that, because it is the only
 *     one not tied to a session.
 *   - **One project** — the same surface the conversation tab draws, reused
 *     through `GraphPanel` so the two entry points cannot drift.
 *
 * The project list comes from `GET /status`, which the settings page already
 * reads; nothing here is computed that the host already knows.
 *
 * @module @dsh-app/plugin-codegraph/client/page
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GraphPanel, type CodegraphTranslate } from './graph-tab.tsx'
import { NS, type CodegraphKey } from './locales.ts'

/** The route prefix the host half registers. */
const ROUTE_PREFIX = '/api/plugins/dsh-app/codegraph'

/** One project row, as `GET /status` reports it. */
interface ProjectRow {
  readonly cwd: string
  readonly name: string
  readonly state: string
  readonly indexedAt: number
  readonly queued: boolean
  readonly failure?: string
}

/** The glyph in the sidebar row. */
export function CodegraphPanelIcon({ size }: SidebarPanelIconOwnerProps): ReactElement {
  // A graph: three nodes joined by two edges. Stroke-only and `currentColor` like
  // every other row glyph, so it follows the rail's own colours.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="8" cy="12" r="1.6" />
      <path d="M5.4 4.3 10.4 4.8M4.7 5.5 7.4 10.6M11.3 6.4 8.7 10.6" />
    </svg>
  )
}

/** One row in the project list. */
function ProjectItem({ project, selected, onPick, t }: {
  project: ProjectRow
  selected: boolean
  onPick: (cwd: string) => void
  t: CodegraphTranslate
}): ReactElement {
  const when = project.indexedAt > 0
    ? t('codegraph.page.when', { when: new Date(project.indexedAt).toLocaleDateString() })
    : t('codegraph.page.never')
  return (
    <li>
      <button
        type="button"
        className="dshcg_proj"
        data-selected={selected ? '1' : undefined}
        onClick={() => { onPick(project.cwd) }}
      >
        <span className="dshcg_projName">{project.name}</span>
        <span className="dshcg_projMeta">{when}</span>
        <span className="dshcg_projState" data-state={project.state}>
          {t(`codegraph.state.${project.state}` as CodegraphKey)}
        </span>
      </button>
    </li>
  )
}

/** The page. */
export function CodegraphPage({ t }: PropsLocale<typeof NS>): ReactElement {
  const [projects, setProjects] = useState<readonly ProjectRow[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  // A generation counter, for the same reason the settings page has one: a slow
  // first load must not overwrite a newer answer.
  const [generation] = useState(() => ({ current: 0 }))

  const load = useCallback(async (): Promise<void> => {
    const mine = generation.current + 1
    generation.current = mine
    try {
      const response = await fetch(`${ROUTE_PREFIX}/status`, { credentials: 'same-origin', cache: 'no-store' })
      const body = (await response.json()) as { ok: boolean, value?: { projects: ProjectRow[] }, error?: { message?: string } }
      if (generation.current !== mine) return
      if (!response.ok || body.ok !== true) {
        setFailure(body.error?.message ?? `HTTP ${String(response.status)}`)
        return
      }
      setProjects(body.value?.projects ?? [])
      setFailure(undefined)
    } catch (error: unknown) {
      if (generation.current !== mine) return
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [generation])

  useEffect(() => { void load() }, [load])

  // Keep the selection valid: a project that disappears must not leave the panel
  // pointing at a path the host no longer knows.
  useEffect(() => {
    setSelected(current => (
      current !== undefined && projects.some(project => project.cwd === current)
        ? current
        : projects[0]?.cwd
    ))
  }, [projects])

  const current = useMemo(
    () => projects.find(project => project.cwd === selected),
    [projects, selected],
  )

  return (
    <div className="dshcg_page">
      <header className="dshcg_pageHead">
        <h1 className="dshcg_pageTitle">{t('codegraph.page.title')}</h1>
        <span className="dshcg_pageMeta">
          {t('codegraph.page.count', { count: projects.length })}
        </span>
      </header>
      {failure === undefined ? null : <p className="dshcg_notice dshcg_noticeError" role="alert">{failure}</p>}
      {projects.length === 0
        ? <p className="dshcg_viewNote">{t('codegraph.page.empty')}</p>
        : (
          <div className="dshcg_pageBody">
            <nav className="dshcg_pageRail" aria-label={t('codegraph.page.projects')}>
              <ul className="dshcg_projs">
                {projects.map((project) => (
                  <ProjectItem
                    key={project.cwd}
                    project={project}
                    selected={project.cwd === selected}
                    onPick={setSelected}
                    t={t}
                  />
                ))}
              </ul>
            </nav>
            <section className="dshcg_pageMain" aria-live="polite">
              <div className="dshcg_pagePath" title={current?.cwd}>{current?.cwd ?? ''}</div>
              <GraphPanel
                cwd={current?.cwd}
                t={t}
                emptyNote={t('codegraph.page.pick')}
              />
            </section>
          </div>
        )}
    </div>
  )
}
