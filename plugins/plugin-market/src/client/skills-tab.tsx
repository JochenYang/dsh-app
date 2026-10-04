/**
 * The Skills tab: one page of the SkillHub catalog per search (server-side
 * keyword match, category filter, stars ordering as shipped by the API), the
 * installed skills below it, and install/uninstall with the same confirm
 * and strip feedback idioms the plugin tabs use. Install copies a zip into
 * `$DSH_HOME/skills/<slug>/` — the hint after success is that the kernel
 * picks it up on its next scan (restart for a running session).
 *
 * The category filter is one wrapping strip with a single sliding highlight.
 * It cannot be the kernel SegmentedControl: that control divides ONE row by
 * segment count, so thirteen labels overflow the panel, and the two-control
 * split leaves each row highlighting its own first segment. Cards are keyed
 * by the source's author-qualified name, never the slug — a slug repeats
 * within a single page.
 *
 * @module @dsh-app/plugin-market/client/skills-tab
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './messages.ts'
import { marketApi } from './api.ts'
import type { SkillDetailEntry, SkillEntry } from './api.ts'
import { CategoryStrip } from './category-strip.tsx'
import { SkillDetailDialog } from './skill-detail.tsx'
import { Spinner } from './spinner.tsx'

/** A small deterministic hash for the fallback avatar colour (FNV-1a). */
function hashCodeOf(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The translated seat type the panel hands down. */
type T = (key: Parameters<Translate>[0], params?: Record<string, string | number>) => string

/** One installed skill's facts as the panel holds them. */
interface InstalledInfo {
  readonly name: string
  readonly description: string
  readonly files: number
  readonly bytes: number
}

/**
 * A card's React key. A slug repeats inside one page (two authors publish the
 * same one — measured: `dev-expert` twice and `anti-fraud` three times on one
 * browse page), and duplicate keys make React reconcile the list against the
 * wrong children, leaving rows of the previous page in the DOM — which reads
 * as "the category filter does nothing". The author-qualified name is unique;
 * the fallback covers a source that declares no namespace, where the
 * positional index keeps the list internally consistent.
 */
function cardKeyOf(skill: SkillEntry, index: number): string {
  return skill.canonical ?? `${skill.owner ?? ''}#${skill.slug}#${String(index)}`
}

/** Category chips: the API's raw keys; the label key resolves per locale. */
const SKILL_CATEGORIES: ReadonlyArray<{ readonly key: string, readonly labelKey: string }> = [
  { key: '', labelKey: 'mkt.skill.catAll' },
  { key: 'office-efficiency', labelKey: 'mkt.skill.cat.officeEfficiency' },
  { key: 'content-creation', labelKey: 'mkt.skill.cat.contentCreation' },
  { key: 'dev-programming', labelKey: 'mkt.skill.cat.devProgramming' },
  { key: 'data-analysis', labelKey: 'mkt.skill.cat.dataAnalysis' },
  { key: 'design-media', labelKey: 'mkt.skill.cat.designMedia' },
  { key: 'ai-agent', labelKey: 'mkt.skill.cat.aiAgent' },
  { key: 'knowledge-management', labelKey: 'mkt.skill.cat.knowledgeManagement' },
  { key: 'business-ops', labelKey: 'mkt.skill.cat.businessOps' },
  { key: 'education', labelKey: 'mkt.skill.cat.education' },
  { key: 'professional', labelKey: 'mkt.skill.cat.professional' },
  { key: 'it-ops-security', labelKey: 'mkt.skill.cat.itOpsSecurity' },
  { key: 'life-service', labelKey: 'mkt.skill.cat.lifeService' },
]

/** Bytes humanized (the installed list's size column). */
function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${String(bytes)} B`
}

/**
 * The skill card's icon: the source's CDN icon when it declares one (lazy
 * loaded), falling back to the slug's first letter on error or absence.
 * Letter takes the SLUG, not the display name, so the mark and the installed
 * directory always agree.
 */
function SkillAvatar({ skill }: { skill: SkillEntry }): ReactNode {
  const [failed, setFailed] = useState(false)
  const src = !failed && skill.iconUrl !== undefined ? skill.iconUrl : ''
  if (src !== '') {
    return (
      <img
        className="dshMkt-avatar dshMkt-avatarImg"
        src={src}
        alt=""
        loading="lazy"
        onError={() => { setFailed(true) }}
      />
    )
  }
  return (
    <span className={`dshMkt-avatar dshMkt-avatar${hashCodeOf(skill.slug) % 6}`} aria-hidden="true">
      {skill.slug.slice(0, 1).toUpperCase()}
    </span>
  )
}

/**
 * The Skills tab body. Stacked in one column: the catalog's search form, the
 * category filter, the result grid, then the installed list. Both load
 * independently.
 */
export function SkillsTab({ t, onStripped }: { t: T, onStripped?: (kind: 'ok' | 'error', text: string) => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<readonly SkillEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [installed, setInstalled] = useState<ReadonlyMap<string, InstalledInfo>>(new Map())
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error', text: string } | null>(null)
  // The open detail: the slug being read, its loaded detail, and its error.
  const [detailSlug, setDetailSlug] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillDetailEntry | null>(null)
  const [detailError, setDetailError] = useState('')

  // Request sequencing: a slow earlier load (browse, 30 rows) must never
  // overwrite the result of a later one (a category filter, 24 rows) — the
  // stale response landing last is exactly the "filter does nothing" bug.
  // The latest call wins; earlier ones discard their answers.
  const loadSeq = useRef(0)
  const load = async (q: string, cat: string, page: number): Promise<void> => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const result = await marketApi.skillSearch(q, cat, page)
      if (seq !== loadSeq.current) return
      setItems(result.items)
      setTotal(result.total)
    } catch (cause) {
      if (seq !== loadSeq.current) return
      setItems([])
      setTotal(0)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const loadInstalled = async (): Promise<void> => {
    try {
      const result = await marketApi.skillsInstalled()
      setInstalled(new Map(result.items.map(item => [item.slug, { name: item.name, description: item.description, files: item.files, bytes: item.bytes }])))
    } catch {
      // The installed list is secondary: a failure leaves the map empty.
      setInstalled(new Map())
    }
  }

  // The reload runs on a category/search/page change. Selecting the category
  // that is already selected is a no-op (the strip's own onClick guards it),
  // and `load` is skipped when nothing changed so switching tabs or re-mounts
  // never refetch a page the panel already holds.
  const lastQuery = useRef<string | null>(null)
  useEffect(() => {
    const key = `${submitted}\u0000${category}\u0000${String(page)}`
    if (lastQuery.current === key) return
    lastQuery.current = key
    void load(submitted, category, page)
  }, [submitted, category, page])

  useEffect(() => {
    void loadInstalled()
  }, [])

  const openDetail = async (slug: string): Promise<void> => {
    setDetailSlug(slug)
    setDetail(null)
    setDetailError('')
    try {
      setDetail(await marketApi.skillDetail(slug))
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const act = async (slug: string, action: 'install' | 'uninstall'): Promise<void> => {
    setBusySlug(slug)
    setNotice(null)
    try {
      await (action === 'install' ? marketApi.skillInstall(slug) : marketApi.skillUninstall(slug))
      await loadInstalled()
      setNotice({
        kind: 'ok',
        text: action === 'install'
          ? t('mkt.skill.installed', { slug })
          : t('mkt.skill.uninstalled', { slug }),
      })
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusySlug(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 24))

  return (
    <>
      {notice !== null ? (
        <div className={`dshMkt-strip ${notice.kind === 'error' ? 'dshMkt-stripError' : ''}`}>{notice.text}</div>
      ) : null}
      <form
        className="dshMkt-filters"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(query.trim())
          setPage(1)
        }}
      >
        <input
          className="dshMkt-input"
          type="search"
          placeholder={t('mkt.skill.searchPlaceholder')}
          aria-label={t('mkt.skill.searchAria')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="dshMkt-button dshMkt-buttonPrimary">{t('mkt.skill.search')}</button>
      </form>
      {/* The shared sliding-strip filter (see category-strip.tsx), so the two
          catalog tabs filter the same way. */}
      <CategoryStrip
        items={SKILL_CATEGORIES.map(chip => ({ key: chip.key, label: t(chip.labelKey as Parameters<T>[0]) }))}
        value={category}
        label={t('mkt.skill.catGroupAria')}
        onChange={(key) => { setCategory(key); setPage(1) }}
      />

      {loading ? (
        <div className="dshMkt-empty"><Spinner /> {t('mkt.skill.loading')}</div>
      ) : error !== '' ? (
        <div className="dshMkt-empty dshMkt-stripError">{error}</div>
      ) : items.length === 0 ? (
        <div className="dshMkt-empty">{t('mkt.skill.empty')}</div>
      ) : (
        <div className="dshMkt-grid">
          {items.map((skill, index) => {
            const installedInfo = installed.get(skill.slug)
            const busy = busySlug === skill.slug
            return (
              <div key={cardKeyOf(skill, index)} className="dshMkt-card">
                <div className="dshMkt-cardHead">
                  <SkillAvatar skill={skill} />
                  <span className="dshMkt-cardId">
                    {skill.owner !== undefined && <span className="dshMkt-cardOwner">{skill.owner}</span>}
                    {/* The name is the affordance for the detail view: a
                        button, so it is reachable and announced as one. */}
                    <button
                      type="button"
                      className="dshMkt-pkgName dshMkt-pkgNameBtn"
                      title={t('mkt.skill.detailHint')}
                      onClick={() => { void openDetail(skill.slug) }}
                    >
                      {skill.name}
                    </button>
                  </span>
                  <span className="dshMkt-cardAction">
                    {installedInfo === undefined ? (
                      <button
                        type="button"
                        className="dshMkt-button dshMkt-buttonPrimary"
                        disabled={busySlug !== null}
                        onClick={() => { void act(skill.slug, 'install') }}
                      >
                        {busy ? <Spinner /> : null}
                        {t('mkt.skill.install')}
                      </button>
                    ) : (
                      <Tooltip label={t('mkt.skill.installedMeta', { files: installedInfo.files, size: fmtBytes(installedInfo.bytes) })} side="bottom">
                        <span className="dshMkt-badge dshMkt-badgeOn">{t('mkt.skill.installedBadge')}</span>
                      </Tooltip>
                    )}
                  </span>
                </div>
                <p className="dshMkt-desc">{skill.description === '' ? t('mkt.card.noDescription') : skill.description}</p>
                <div className="dshMkt-cardFoot">
                  <span className="dshMkt-cardTags">
                    {skill.category !== '' ? <span className="dshMkt-badge">{skill.category}</span> : null}
                    {skill.version !== '' ? <span className="dshMkt-badge">v{skill.version}</span> : null}
                  </span>
                  <span className="dshMkt-cardStars">★ {String(skill.stars)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="dshMkt-rowBetween">
        <span className="dshMkt-hint">
          {total > 0 ? t('mkt.skill.total', { shown: items.length, total }) : ''}
        </span>
        <span className="dshMkt-cardStars">
          {page > 1 ? (
            <button type="button" className="dshMkt-button" disabled={loading} onClick={() => { setPage(p => Math.max(1, p - 1)) }}>‹</button>
          ) : null}
          {page < totalPages ? (
            <button type="button" className="dshMkt-button" disabled={loading} onClick={() => { setPage(p => p + 1) }}>›</button>
          ) : null}
        </span>
      </div>
      {/* Source attribution: the catalog is a third-party service, named in
        * the panel's own footer — data comes from somewhere visible, or the
        * market reads as an endorsement of every listing. */}
      <p className="dshMkt-hint dshMkt-skillSource">{t('mkt.skill.source')}</p>
      {installed.size > 0 ? (
        <>
          <h3 className="dshMkt-sectionTitle">{t('mkt.skill.installedTitle', { count: installed.size })}</h3>
          <div className="dshMkt-grid">
            {[...installed.entries()].map(([slug, info]) => (
              <div key={slug} className="dshMkt-card">
                <div className="dshMkt-cardHead">
                  <span className="dshMkt-cardId">
                    <span className="dshMkt-cardOwner">{slug}</span>
                    <span className="dshMkt-pkgName">{info.name}</span>
                  </span>
                  <span className="dshMkt-cardAction">
                    <button
                      type="button"
                      className="dshMkt-button dshMkt-buttonDanger"
                      disabled={busySlug !== null}
                      onClick={() => { void act(slug, 'uninstall') }}
                    >
                      {busySlug === slug ? <Spinner /> : null}
                      {t('mkt.skill.uninstall')}
                    </button>
                  </span>
                </div>
                {/* The skill's own one-line description, read from its
                    SKILL.md — a name and a size alone say nothing about what
                    the skill does. */}
                <p className="dshMkt-desc">{info.description === '' ? t('mkt.card.noDescription') : info.description}</p>
                {/* The size pair rides the catalog card's own footer slot (the
                    ★ position): a lone grey line under the description had no
                    anchor, while here it reads as the card's meta corner and
                    the two grids line up. No installed badge — the section
                    heading and the uninstall button already say that. */}
                <div className="dshMkt-cardFoot">
                  <span className="dshMkt-cardTags" />
                  <span className="dshMkt-inlineMeta">{t('mkt.skill.installedMeta', { files: info.files, size: fmtBytes(info.bytes) })}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <SkillDetailDialog
        t={t}
        detail={detail}
        error={detailError}
        open={detailSlug !== null}
        installed={detailSlug !== null && installed.has(detailSlug)}
        busy={busySlug !== null}
        onClose={() => { setDetailSlug(null); setDetail(null); setDetailError('') }}
        onInstall={(slug) => { void act(slug, 'install') }}
        onUninstall={(slug) => { void act(slug, 'uninstall') }}
      />
    </>
  )
}
