/**
 * The Skills tab: one page of the SkillHub catalog per search (server-side
 * keyword match, category chips, stars ordering as shipped by the API), the
 * installed skills beside it, and install/uninstall with the same confirm
 * and strip feedback idioms the plugin tabs use. Install copies a zip into
 * `$DSH_HOME/skills/<slug>/` — the hint after success is that the kernel
 * picks it up on its next scan (restart for a running session).
 *
 * @module @dsh-app/plugin-market/client/skills-tab
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './messages.ts'
import { marketApi } from './api.ts'
import type { SkillEntry } from './api.ts'
import { Spinner } from './spinner.tsx'

/** The translated seat type the panel hands down. */
type T = (key: Parameters<Translate>[0], params?: Record<string, string | number>) => string

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
 * The Skills tab body. Two stacks side by side on wide panels: the catalog
 * (search + chips + cards) and the installed list. Both load independently.
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
  const [installed, setInstalled] = useState<ReadonlyMap<string, { readonly files: number, readonly bytes: number }>>(new Map())
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error', text: string } | null>(null)

  const load = async (q: string, cat: string, page: number): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await marketApi.skillSearch(q, cat, page)
      setItems(result.items)
      setTotal(result.total)
    } catch (cause) {
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
      setInstalled(new Map(result.items.map(item => [item.slug, { files: item.files, bytes: item.bytes }])))
    } catch {
      // The installed list is secondary: a failure leaves the map empty.
      setInstalled(new Map())
    }
  }

  useEffect(() => {
    void load(submitted, category, page)
    void loadInstalled()
  }, [submitted, category, page])

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
      <div className="dshMkt-skillChips">
        {SKILL_CATEGORIES.map(chip => (
          <button
            key={chip.key}
            type="button"
            className={`dshMkt-chip${category === chip.key ? ' dshMkt-chipOn' : ''}`}
            onClick={() => { setCategory(chip.key); setPage(1) }}
          >
            {t(chip.labelKey as Parameters<T>[0])}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="dshMkt-empty"><Spinner /> {t('mkt.skill.loading')}</div>
      ) : error !== '' ? (
        <div className="dshMkt-empty dshMkt-stripError">{error}</div>
      ) : items.length === 0 ? (
        <div className="dshMkt-empty">{t('mkt.skill.empty')}</div>
      ) : (
        <div className="dshMkt-grid">
          {items.map(skill => {
            const installedInfo = installed.get(skill.slug)
            const busy = busySlug === skill.slug
            return (
              <div key={skill.slug} className="dshMkt-card">
                <div className="dshMkt-cardHead">
                  <span className="dshMkt-cardId">
                    {skill.owner !== undefined && <span className="dshMkt-cardOwner">{skill.owner}</span>}
                    <span className="dshMkt-pkgName">{skill.name}</span>
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
      {installed.size > 0 ? (
        <>
          <h3 className="dshMkt-sectionTitle">{t('mkt.skill.installedTitle', { count: installed.size })}</h3>
          <div className="dshMkt-grid">
            {[...installed.entries()].map(([slug, info]) => (
              <div key={slug} className="dshMkt-card">
                <div className="dshMkt-cardHead">
                  <span className="dshMkt-pkgName">{slug}</span>
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
                <div className="dshMkt-cardByline">{t('mkt.skill.installedMeta', { files: info.files, size: fmtBytes(info.bytes) })}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}
