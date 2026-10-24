/**
 * The code graph settings section.
 *
 * Two surfaces in one page, because they answer one question each:
 *
 *   - **Projects** — a dropdown of every project that has a graph, and under it
 *     that project's own state: how fresh it is, what the last pass did, and the
 *     reasons its answer may be incomplete. A dropdown rather than a tab strip
 *     because the number of projects is unbounded: `SegmentedTabs` sizes each
 *     segment to its label, so the strip wraps and the names collide as soon as a
 *     user has four or five (measured). `Menu` is the shell's own anchored
 *     dropdown — it scrolls, keeps the keyboard walk, and marks the selection.
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

import { Button, Menu, PathLabel, RiskConfirmation, Tag, Tooltip, fileSizeText, IconChevronDownOutlineRegular, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
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
    readonly missingLanguage: number
    readonly noRules: number
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
function ProjectPanel({ project, busy, onReindex, onForget, t }: {
  project: ProjectRow
  busy: boolean
  onReindex: (cwd: string) => void
  onForget: (cwd: string) => void
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
        {/* Deleting is the way out for a project the user removed from the
            workspace: its graph is real disk space (124 MB for two projects on
            this machine) and nothing else ever removes it. Confirmed through the
            primitive that requires an acknowledgement, because a rebuild costs a
            full index pass. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => { onForget(project.cwd) }}
        >
          {t('codegraph.forget')}
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
      {/* Two DIFFERENT facts, reported apart. The first asks the user to install
          a grammar; the second says nothing is installable. Reporting them as one
          number told users a download would help when their only gap was a .css
          file — measured on this machine, where every skipped file belonged to a
          language that was already installed. */}
      {outcome !== undefined && outcome.missingLanguage > 0
        ? <p className="dshcg_notice dshcg_noticeWarn">{t('codegraph.outcome.missingLanguage', { count: outcome.missingLanguage })}</p>
        : null}
      {outcome !== undefined && outcome.noRules > 0
        ? <p className="dshcg_notice">{t('codegraph.outcome.noRules', { count: outcome.noRules })}</p>
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
  // The anchor is an INLINE span inside the flex item, not the flex item itself.
  // The Tooltip measures its child's rect, so a child that is also a flex box is
  // positioned by the layout algorithm — and every `flex` value tried here moved
  // the bubble: `1 1 auto` filled the row (164px of box for a 31px word, the
  // bubble landing over empty card), and even a shrink-to-fit value left the box
  // under the layout's control. A plain inline span is measured by its TEXT, so
  // the bubble sits over the word whatever the row does. This is the shape
  // `plugin-archives` uses (`rowTitle` wraps an inline span, no `flex` on it).
  const label = <span className="dshcg_langLabel">{language.label}</span>
  const name = bubble.label === undefined
    ? <span className="dshcg_langName">{label}</span>
    // `portal`: the bubble is `position: fixed`, and the settings dialog's panel
    // carries a transform — a transformed ancestor is the containing block for a
    // fixed descendant, so a bubble placed at viewport x=0 rendered at x=120
    // instead. Portaling to `document.body` takes that ancestor out of the chain.
    : (
      <span className="dshcg_langName">
        <Tooltip label={bubble.label} side="top" portal>{label}</Tooltip>
      </span>
    )
  // Two rows, because the card is a 240px column at the grid's floor: the name
  // and its action share the first row (the name absorbs the slack and truncates
  // only when it truly has to), and the tags sit on the second. On one flat
  // wrapped line the button dropped below the tags and every card whose tags
  // differed in width ended up a different height.
  return (
    <div className="dshcg_lang">
      <div className="dshcg_langMain">
        {name}
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
  // The project picker: one dropdown rather than a strip, because the number of
  // projects is unbounded and a strip changes shape as it grows.
  const [pickerOpen, setPickerOpen] = useState(false)
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

  /**
   * Deleting a graph is confirmed before it happens, and the confirmation is a
   * separate step rather than a second click: a rebuild costs a full index pass,
   * which is minutes on a large project.
   */
  const [pendingForget, setPendingForget] = useState<string | undefined>(undefined)
  const [forgetAcknowledged, setForgetAcknowledged] = useState(false)
  const onForget = useCallback((cwd: string) => {
    setPendingForget(cwd)
    setForgetAcknowledged(false)
  }, [])
  const confirmForget = useCallback(() => {
    const cwd = pendingForget
    setPendingForget(undefined)
    setForgetAcknowledged(false)
    if (cwd !== undefined) void runAction('project', cwd, { action: 'forget', cwd })
  }, [pendingForget, runAction])

  const onLanguageAction = useCallback((action: 'install' | 'remove', id: string) => {
    void runAction('language', id, { action, id })
  }, [runAction])

  // The tab strip needs at least one item; with none, the empty-state sentence
  // carries the whole message instead of an empty control. The array is built as
  // a non-empty tuple when it has an entry, which is the type `SegmentedTabs`
  // declares — no assertion needed.
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
          {/* A MENU, not a tab strip.
              `SegmentedTabs` sizes every segment to its own label, so a project
              list grows until the strip wraps and the names collide — measured on
              four real projects, where `dsh-rewind-plugin` and `Warm-kitchen-time`
              broke onto two lines each. The number of projects is unbounded, so
              the control has to be one that does not change shape with it.
              `Menu` is the shell's own anchored dropdown: it scrolls, keeps the
              keyboard walk, and carries the selection marker.
              A single project still gets no control — there is nothing to choose. */}
          {projects.length > 1 ? (
            <div className="dshcg_picker">
              <Menu
                open={pickerOpen}
                // The trigger is a real button, so it is in the tab order and
                // announces what it does; the menu's own anchor is that button.
                anchor={(
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setPickerOpen(open => !open) }}
                    aria-expanded={pickerOpen}
                    aria-haspopup="menu"
                  >
                    <span className="dshcg_pickerLabel">{current?.name ?? translate('codegraph.project.label')}</span>
                    {/* A chevron, because the label alone reads as a static tag: a
                        bordered box showing the current project's name looks like a
                        status chip, not like something that opens a list. This is
                        the shell's own glyph, so it follows the theme. */}
                    <IconChevronDownOutlineRegular size={12} className="dshcg_pickerChevron" />
                  </Button>
                )}
                items={projects.map(project => ({ id: project.cwd, label: project.name }))}
                selectedId={selected}
                onSelect={(id) => { setSelected(id); setPickerOpen(false) }}
                onClose={() => { setPickerOpen(false) }}
                align="start"
                portal
                dense
              />
            </div>
          ) : null}
          {current === undefined ? null : (
            <ProjectPanel
              project={current}
              busy={busyProjects.has(current.cwd)}
              onReindex={onReindex}
              onForget={onForget}
              t={translate}
            />
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

      <RiskConfirmation
        open={pendingForget !== undefined}
        title={translate('codegraph.forgetTitle')}
        description={translate('codegraph.forgetBody', { path: pendingForget ?? '' })}
        acknowledgeLabel={translate('codegraph.forgetAck')}
        cancelLabel={translate('codegraph.forgetCancel')}
        closeLabel={translate('codegraph.forgetCancel')}
        confirmLabel={translate('codegraph.forgetConfirm')}
        acknowledged={forgetAcknowledged}
        onAcknowledgedChange={setForgetAcknowledged}
        onCancel={() => { setPendingForget(undefined); setForgetAcknowledged(false) }}
        onConfirm={confirmForget}
      />
    </div>
  )
}
