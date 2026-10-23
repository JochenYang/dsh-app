/**
 * The code graph settings section.
 *
 * Two surfaces in one page, because they answer one question each:
 *
 *   - **Projects** — one tab per project that has a graph, and under the selected
 *     tab that project's own state: how fresh it is, what the last pass did, and
 *     the reasons its answer may be incomplete. The tab strip is
 *     `SegmentedTabs`, the shell's own primitive, rather than a hand-rolled row
 *     of buttons: the sliding indicator, the arrow/Home/End keys and the single
 *     tab stop all come with it.
 *   - **Languages** — which grammars are present, which ship with the plugin,
 *     and which would need a download. "Installed" and "indexable" are reported
 *     separately: a grammar with no extraction rules parses to nothing, and a
 *     page that conflated the two would promise a language that silently yields
 *     an empty graph.
 *
 * Everything comes from the host routes; nothing is computed here that the host
 * already knows, so the page and the tools can never disagree about a project's
 * state.
 *
 * @module @dsh-app/plugin-codegraph/client/section
 */

import { Button, PathLabel, SegmentedTabs, Tag, Tooltip, fileSizeText, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, NS, type CodegraphKey } from './locales.ts'
import { nameBubble } from './row.ts'

/** The route prefix the host half registers. */
const ROUTE_PREFIX = '/api/plugins/dsh-app/codegraph'

/** One project row as the host reports it. */
interface ProjectRow {
  readonly cwd: string
  readonly name: string
  readonly state: string
  readonly indexedAt: number
  readonly queued: boolean
  readonly failure?: string
  readonly lastOutcome?: {
    readonly parsed: number
    readonly skipped: number
    readonly removed: number
    readonly truncated: boolean
    readonly unsupported: number
    readonly parseErrors: number
    readonly tooLarge: number
    readonly durationMs: number
    readonly removalSkipped: boolean
  }
}

/** One language row as the host reports it. */
interface LanguageRow {
  readonly id: string
  readonly label: string
  readonly bundled: boolean
  readonly installed: boolean
  readonly supported: boolean
  readonly bytes: number
  readonly extensions: readonly string[]
}

/** A host failure carrying the coded message the client renders. */
interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly text?: string
}

/** The section's translate seat, taken from the slot's own namespace type. */
type CodegraphTranslate = TranslateNS<typeof NS>

/** A failure that already carries the host's code and params. */
class HostError extends Error {
  readonly host: HostText | undefined
  constructor(host: HostText | undefined, fallback: string) {
    super(host?.text ?? fallback)
    this.host = host
  }
}

/**
 * GET/POST one route and unwrap the suite envelope.
 *
 * `cache: 'no-store'` matters here beyond politeness: every answer on this page is
 * a live index state, and a cached one would show "up to date" for a graph that is
 * rebuilding — the exact invisible-staleness this plugin exists to prevent.
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string, host?: HostText } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value as T
}

/**
 * Render a host code through this plugin's dictionary.
 *
 * The host answers a code plus params; the sentence lives here. An unknown code
 * falls back to the host's English diagnostic, which only happens when the UI is
 * older than the kernel — never by matching on prose.
 */
function hostMessage(t: CodegraphTranslate, error: unknown): string {
  if (error instanceof HostError && error.host !== undefined) {
    const key = `codegraph.host.${error.host.code.replace(/^route\./u, '')}` as CodegraphKey
    const params = error.host.params ?? {}
    // The action is a host word (`install`/`remove`/`reindex`); interpolating it
    // raw would put an English verb inside a Chinese sentence. Translate it first,
    // and leave it alone when it is not one of the three (an unknown verb is
    // better shown than swallowed).
    const action = typeof params.action === 'string' ? params.action : undefined
    const actionKey = action === undefined ? undefined : `codegraph.host.action.${action}` as CodegraphKey
    const actionLabel = action === undefined
      ? undefined
      : (actionKey !== undefined && actionKey in en ? t(actionKey) : action)
    // The fallback key carries the raw detail so an unrecognised code still says
    // something actionable instead of an empty row.
    return t(key, {
      ...params,
      ...actionLabel === undefined ? {} : { action: actionLabel },
      detail: String(params.detail ?? error.message),
    })
  }
  return t('codegraph.host.unknown', { detail: error instanceof Error ? error.message : String(error) })
}

/**
 * The state pill, composed from the shell's `Tag`.
 *
 * A capsule has a FIXED geometry in this design system and only its palette
 * varies (`Tag.module.css`), so a hand-rolled pill would read as subtly wrong
 * beside every other tag at native size — and its tone tokens are exactly the
 * ones an alias name typed from memory gets wrong. The tone map is the whole
 * implementation:
 */
const STATE_TONE: Record<string, { key: CodegraphKey, tone: TagTone }> = {
  unindexed: { key: 'codegraph.state.unindexed', tone: 'outline' },
  indexing: { key: 'codegraph.state.indexing', tone: 'info' },
  current: { key: 'codegraph.state.current', tone: 'success' },
  stale: { key: 'codegraph.state.stale', tone: 'warning' },
  failed: { key: 'codegraph.state.failed', tone: 'danger' },
}

function StatePill({ state, queued, t }: { state: string, queued: boolean, t: CodegraphTranslate }): ReactNode {
  const entry = STATE_TONE[state]
  // An unknown state is shown raw rather than dropped: a host on a newer line
  // naming a state this UI does not know must not render as "unindexed".
  return (
    <>
      {entry === undefined
        ? <Tag tone="neutral">{state}</Tag>
        : <Tag tone={entry.tone}>{t(entry.key)}</Tag>}
      {queued ? <Tag tone="quiet">{t('codegraph.queued')}</Tag> : null}
    </>
  )
}

/** One project's panel: state, last outcome, the reasons an answer may be partial. */
function ProjectPanel({ project, busy, onReindex, t }: {
  project: ProjectRow
  busy: boolean
  onReindex: (cwd: string) => void
  t: CodegraphTranslate
}): ReactNode {
  const outcome = project.lastOutcome
  const indexed = project.indexedAt > 0
    ? t('codegraph.stat.indexed', { when: new Date(project.indexedAt).toLocaleString() })
    : t('codegraph.stat.never')
  return (
    <div className="dshcg_card">
      <div className="dshcg_row">
        {/* `PathLabel` is the suite's path presentation: subdued directories, a
            primary filename, and the complete path on hover — the same shape a
            hand-rolled ellipsis plus a native `title` was imitating. */}
        <PathLabel path={project.cwd} className="dshcg_path" />
        <StatePill state={project.state} queued={project.queued} t={t} />
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => { onReindex(project.cwd) }}
        >
          {busy ? t('codegraph.reindexing') : t('codegraph.reindex')}
        </Button>
      </div>
      <div className="dshcg_meta">
        <span>{indexed}</span>
        {outcome === undefined ? null : (
          <>
            <span>{t('codegraph.stat.files', { count: outcome.parsed + outcome.skipped })}</span>
            <span>{t('codegraph.outcome', {
              parsed: outcome.parsed,
              skipped: outcome.skipped,
              removed: outcome.removed,
              duration: `${(outcome.durationMs / 1000).toFixed(1)}s`,
            })}</span>
          </>
        )}
      </div>
      {project.failure === undefined ? null : (
        <p className="dshcg_notice dshcg_noticeError">{t('codegraph.failure', { detail: project.failure })}</p>
      )}
      {outcome?.truncated === true ? <p className="dshcg_notice dshcg_noticeWarn">{t('codegraph.outcome.truncated')}</p> : null}
      {outcome?.removalSkipped === true ? <p className="dshcg_notice dshcg_noticeWarn">{t('codegraph.outcome.removalSkipped')}</p> : null}
      {outcome !== undefined && outcome.unsupported > 0
        ? <p className="dshcg_notice">{t('codegraph.outcome.unsupported', { count: outcome.unsupported })}</p>
        : null}
      {outcome !== undefined && outcome.parseErrors > 0
        ? <p className="dshcg_notice">{t('codegraph.outcome.parseErrors', { count: outcome.parseErrors })}</p>
        : null}
      {outcome !== undefined && outcome.tooLarge > 0
        ? <p className="dshcg_notice">{t('codegraph.outcome.tooLarge', { count: outcome.tooLarge })}</p>
        : null}
    </div>
  )
}

/** One language row: its install state and the one action available. */
function LanguageItem({ language, busy, onAction, t }: {
  language: LanguageRow
  busy: boolean
  onAction: (action: 'install' | 'remove', id: string) => void
  t: CodegraphTranslate
}): ReactNode {
  // Three distinct claims, shown separately: shipped with the plugin, present on
  // disk, and read by the extractor. A language can be installed and still yield
  // nothing, and saying "installed" alone would promise a working graph.
  const tag = language.bundled
    ? t('codegraph.languages.bundled')
    : language.installed ? t('codegraph.languages.installed') : t('codegraph.languages.missing')
  // The CALL SITE is what stops the empty bubble: `Tooltip` renders `label`'s
  // text and documents `''` as "shortcut keys only", so passing an empty string
  // (which `extensions.join('  ')` did for the regex grammar) opened a blank
  // bubble. `nameBubble` decides, and this branch is what renders NO Tooltip at
  // all — `label: ''` and `label: undefined` are the same pixels inside the
  // primitive, so removing this branch brings the defect back with `row.ts`
  // unchanged. `styles.test.ts` pins the branch.
  const bubble = nameBubble(language.extensions)
  const name = <span className="dshcg_langName">{language.label}</span>
  // Two rows, because the card is a 240px column at the grid's floor: the name
  // and its action share the first row (the name absorbs the slack and truncates
  // only when it truly has to), and the tags sit on the second. On one flat
  // wrapped line the button dropped below the tags and every card whose tags
  // differed in width ended up a different height.
  return (
    <div className="dshcg_lang">
      <div className="dshcg_langMain">
        {bubble.label === undefined
          ? name
          : <Tooltip label={bubble.label} side="top">{name}</Tooltip>}
        {language.bundled ? null : (
          <span className="dshcg_langAction">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => { onAction(language.installed ? 'remove' : 'install', language.id) }}
            >
              {busy
                ? t('codegraph.languages.installing')
                : language.installed ? t('codegraph.languages.remove') : t('codegraph.languages.install')}
            </Button>
          </span>
        )}
      </div>
      <div className="dshcg_langMeta">
        <Tag tone={language.bundled ? 'outline' : language.installed ? 'quiet' : 'neutral'}>{tag}</Tag>
        {language.installed ? <Tag tone="quiet">{fileSizeText(language.bytes)}</Tag> : null}
        {language.supported ? null : <Tag tone="neutral">{t('codegraph.languages.unsupported')}</Tag>}
      </div>
    </div>
  )
}

/** The settings section entry point. */
export function CodegraphSection({ t }: PropsLocale<typeof NS>): ReactNode {
  const translate: CodegraphTranslate = t
  const [projects, setProjects] = useState<readonly ProjectRow[]>([])
  const [languages, setLanguages] = useState<readonly LanguageRow[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  // Two separate channels on purpose. A load failure is about the page not being
  // able to read the graph; an action failure is about one button. Sharing one
  // slot meant a later successful load silently erased an action error the user
  // was never told was resolved — the failure simply vanished from the screen.
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  // Keyed busy sets, not single ids: two projects re-indexing at once must not
  // clear each other's spinner (a single `busyProject` string does exactly that).
  const [busyProjects, setBusyProjects] = useState<ReadonlySet<string>>(() => new Set())
  const [busyLanguages, setBusyLanguages] = useState<ReadonlySet<string>>(() => new Set())
  // A generation counter discards a stale load that resolves after a newer one:
  // two quick actions each trigger a load, and last-response-wins would show the
  // older snapshot.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = generation.current + 1
    generation.current = mine
    try {
      const [status, langs] = await Promise.all([
        fetchJson<{ projects: ProjectRow[] }>(`${ROUTE_PREFIX}/status`),
        fetchJson<{ languages: LanguageRow[] }>(`${ROUTE_PREFIX}/languages`),
      ])
      if (generation.current !== mine) return
      setProjects(status.projects)
      setLanguages(langs.languages)
      setLoadError(undefined)
      // Keep the selection if it still exists; otherwise fall to the newest.
      setSelected(current => (
        current !== undefined && status.projects.some(project => project.cwd === current)
          ? current
          : status.projects[0]?.cwd
      ))
    } catch (error) {
      if (generation.current !== mine) return
      setLoadError(hostMessage(translate, error))
    }
  }, [translate])

  useEffect(() => { void load() }, [load])

  /** Run one action, keeping its own spinner and its own error. */
  const runAction = useCallback(async (
    kind: 'project' | 'language',
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const mark = kind === 'project' ? setBusyProjects : setBusyLanguages
    const unmark = (): void => {
      mark(current => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
    mark(current => new Set(current).add(id))
    setActionError(undefined)
    try {
      await fetchJson(`${ROUTE_PREFIX}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await load()
    } catch (error) {
      setActionError(hostMessage(translate, error))
    } finally {
      unmark()
    }
  }, [load, translate])

  const onReindex = useCallback((cwd: string) => {
    void runAction('project', cwd, { action: 'reindex', cwd })
  }, [runAction])

  const onLanguageAction = useCallback((action: 'install' | 'remove', id: string) => {
    void runAction('language', id, { action, id })
  }, [runAction])

  // The tab strip needs at least one item; with none, the empty-state sentence
  // carries the whole message instead of an empty control. The array is built as
  // a non-empty tuple when it has an entry, which is the type `SegmentedTabs`
  // declares — no assertion needed.
  const tabs = useMemo(() => projects.map((project, index) => ({
    value: project.cwd,
    label: project.name,
    // Indexed, not derived from the path: sanitising `D:/a/b-c` and `D:/a/b_c`
    // both collapse to `-D--a-b-c`, and two projects sharing a DOM id makes the
    // tab's `aria-controls` and the keyboard Home/End sweep target the wrong
    // panel — a switch that silently shows another project's state.
    id: `dshcg-tab-${String(index)}`,
    panelId: `dshcg-panel-${String(index)}`,
  })), [projects])

  const current = projects.find(project => project.cwd === selected)

  return (
    <div className="dshcg_section">
      {/* The rail renders a section's own heading (the shell's header slot is a
          different surface), so this page carries one and names itself with it. */}
      <h2 className="dshcg_title" id="dshcg-section-title">{translate('codegraph.title')}</h2>
      <p className="dshcg_intro">{translate('codegraph.intro')}</p>
      {loadError === undefined ? null : <p className="dshcg_notice dshcg_noticeError" role="alert">{loadError}</p>}
      {actionError === undefined ? null : <p className="dshcg_notice dshcg_noticeError" role="alert">{actionError}</p>}

      {projects.length === 0 ? (
        <p className="dshcg_empty">{translate('codegraph.empty')}</p>
      ) : (
        <>
          {/* A one-item tablist is not a choice, so a single project renders no
              strip: the sliding indicator has nothing to slide between and the
              tablist announces an interaction that does not exist. */}
          {tabs.length > 1 ? (
            <div className="dshcg_tabs">
              <SegmentedTabs
                items={[tabs[0]!, ...tabs.slice(1)]}
                value={selected ?? tabs[0]!.value}
                onChange={setSelected}
                label={translate('codegraph.project.label')}
              />
            </div>
          ) : null}
          {current === undefined ? null : (
            // The panel is named by its tab (`aria-labelledby`) and focusable, so
            // Tab reaches the content — the two halves of the tabs pattern the
            // primitive leaves to the caller (`panels remain caller-owned`).
            <div
              id={tabs.find(tab => tab.value === current.cwd)?.panelId}
              role="tabpanel"
              aria-labelledby={tabs.find(tab => tab.value === current.cwd)?.id}
              tabIndex={0}
            >
              <ProjectPanel
                project={current}
                busy={busyProjects.has(current.cwd)}
                onReindex={onReindex}
                t={translate}
              />
            </div>
          )}
        </>
      )}

      <div className="dshcg_card">
        <div className="dshcg_row">
          <strong>{translate('codegraph.languages.title')}</strong>
        </div>
        <p className="dshcg_intro">{translate('codegraph.languages.intro')}</p>
        <div className="dshcg_langs">
          {languages.map(language => (
            <LanguageItem
              key={language.id}
              language={language}
              busy={busyLanguages.has(language.id)}
              onAction={onLanguageAction}
              t={translate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
