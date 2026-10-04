/**
 * The skill detail card: what one catalog row actually is, opened from the
 * card's name. The list page carries a truncated description, a version and a
 * star count; the detail adds the counts the source tracks (downloads, stars,
 * published versions), the sub-category labels, the author's page, and the
 * last update — enough to decide whether to install without leaving the panel.
 *
 * Copy arrives as props from the caller's dictionary (this module owns no
 * strings). Same modal idiom as confirm-dialog: mask + centered card, Esc and
 * the mask close it, Enter activates the focused action.
 *
 * @module @dsh-app/plugin-market/client/skill-detail
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Translate } from './messages.ts'
import type { SkillDetailEntry } from './api.ts'
import { Spinner } from './spinner.tsx'

/** The translated seat type the panel hands down. */
type T = (key: Parameters<Translate>[0], params?: Record<string, string | number>) => string

/** A date as YYYY-MM-DD (locale-independent, matching the host's own format). */
function fmtDate(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface SkillDetailDialogProps {
  open: boolean
  /** The loaded detail; null while loading or after a failure. */
  detail: SkillDetailEntry | null
  /** The failure's message, empty when there is none. */
  error: string
  /** Whether the skill is already installed (drives the action shown). */
  installed: boolean
  busy: boolean
  t: T
  onClose: () => void
  onInstall: (slug: string) => void
  onUninstall: (slug: string) => void
}

/**
 * Render the detail card over the panel.
 * @returns null when closed.
 */
export function SkillDetailDialog({
  open, detail, error, installed, busy, t, onClose, onInstall, onUninstall,
}: SkillDetailDialogProps): ReactNode {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  if (!open) return null
  const stats: Array<{ label: string, value: string }> = detail === null ? [] : [
    { label: t('mkt.skill.detailDownloads'), value: String(detail.downloads) },
    { label: t('mkt.skill.detailStars'), value: String(detail.stars) },
    { label: t('mkt.skill.detailVersionsLabel'), value: String(detail.versions) },
  ]
  return createPortal(
    <div className="dshMkt-dialogWrap" role="presentation" onClick={onClose}>
      <div
        className="dshMkt-detailCard"
        role="dialog"
        aria-modal="true"
        aria-label={detail?.name ?? t('mkt.skill.detailTitle')}
        onClick={(event) => { event.stopPropagation() }}
      >
        {error !== '' ? (
          <>
            <div className="dshMkt-dialogTitle">{t('mkt.skill.detailTitle')}</div>
            <div className="dshMkt-dialogMessage dshMkt-stripError">{error}</div>
            <div className="dshMkt-dialogActions">
              <button type="button" className="dshMkt-button" onClick={onClose}>{t('mkt.skill.detailClose')}</button>
            </div>
          </>
        ) : detail === null ? (
          <div className="dshMkt-detailLoading"><Spinner /> {t('mkt.skill.detailLoading')}</div>
        ) : (
          <>
            <div className="dshMkt-detailHead">
              {detail.iconUrl !== undefined ? (
                <img className="dshMkt-avatar dshMkt-avatarImg" src={detail.iconUrl} alt="" loading="lazy" />
              ) : (
                <span className="dshMkt-avatar dshMkt-avatar2" aria-hidden="true">{detail.slug.slice(0, 1).toUpperCase()}</span>
              )}
              <div className="dshMkt-detailId">
                {detail.owner !== undefined ? <span className="dshMkt-cardOwner">{detail.owner}</span> : null}
                <h3 className="dshMkt-detailName">{detail.name}</h3>
                <span className="dshMkt-detailSlug">{detail.slug}{detail.version !== '' ? ` · v${detail.version}` : ''}</span>
              </div>
            </div>
            <p className="dshMkt-detailDesc">{detail.description === '' ? t('mkt.card.noDescription') : detail.description}</p>
            <div className="dshMkt-detailStats">
              {stats.map(stat => (
                <span key={stat.label} className="dshMkt-detailStat">
                  <span className="dshMkt-detailStatValue">{stat.value}</span>
                  <span className="dshMkt-detailStatLabel">{stat.label}</span>
                </span>
              ))}
            </div>
            <div className="dshMkt-detailMeta">
              {detail.category !== '' ? <span className="dshMkt-badge">{detail.category}</span> : null}
              {detail.subCategories.map(label => <span key={label} className="dshMkt-badge">{label}</span>)}
              {detail.updatedAt !== undefined ? (
                <span className="dshMkt-hint">{t('mkt.skill.detailUpdated', { date: fmtDate(detail.updatedAt) })}</span>
              ) : null}
            </div>
            <div className="dshMkt-dialogActions">
              {detail.sourceUrl !== undefined ? (
                <a className="dshMkt-button" href={detail.sourceUrl} target="_blank" rel="noreferrer noopener">{t('mkt.skill.detailSource')}</a>
              ) : null}
              <button type="button" className="dshMkt-button" onClick={onClose}>{t('mkt.skill.detailClose')}</button>
              {installed ? (
                <button
                  type="button"
                  className="dshMkt-button dshMkt-buttonDanger"
                  disabled={busy}
                  onClick={() => { onUninstall(detail.slug) }}
                >
                  {t('mkt.skill.uninstall')}
                </button>
              ) : (
                <button
                  type="button"
                  className="dshMkt-button dshMkt-buttonPrimary"
                  disabled={busy}
                  autoFocus
                  onClick={() => { onInstall(detail.slug) }}
                >
                  {t('mkt.skill.install')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
