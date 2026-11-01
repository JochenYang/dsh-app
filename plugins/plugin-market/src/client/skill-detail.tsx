/**
 * The skill detail card: what one catalog row actually is, opened from the
 * card's name. The list page carries a truncated description, a version and a
 * star count; the detail adds the counts the source tracks (downloads, stars,
 * published versions), the sub-category labels, the author's page, and the
 * last update — enough to decide whether to install without leaving the panel.
 *
 * Copy arrives as props from the caller's dictionary (this module owns no
 * strings). The shell is the host's `Modal` primitive, the same one the settings
 * sections use: it owns the portal, the mask, Escape, the focus trap and the focus
 * return, so this file only supplies the body and the action row.
 *
 * @module @dsh-app/plugin-market/client/skill-detail
 */

import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const stats: Array<{ label: string, value: string }> = detail === null ? [] : [
    { label: t('mkt.skill.detailDownloads'), value: String(detail.downloads) },
    { label: t('mkt.skill.detailStars'), value: String(detail.stars) },
    { label: t('mkt.skill.detailVersionsLabel'), value: String(detail.versions) },
  ]
  // The action row is absent while loading or on failure: there is nothing to act
  // on yet, and the Modal's own close button (labelled by `closeLabel`) covers the
  // dismissal those states need.
  const footer = error !== '' || detail === null ? undefined : (
    <div className="dshMkt-dialogActions">
      {detail.sourceUrl !== undefined ? (
        <a className="dshMkt-button" href={detail.sourceUrl} target="_blank" rel="noreferrer noopener">{t('mkt.skill.detailSource')}</a>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={onClose}>{t('mkt.skill.detailClose')}</Button>
      {installed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => { onUninstall(detail.slug) }}
        >
          {t('mkt.skill.uninstall')}
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => { onInstall(detail.slug) }}
        >
          {t('mkt.skill.install')}
        </Button>
      )}
    </div>
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mkt.skill.detailTitle')}
      closeLabel={t('mkt.skill.detailClose')}
      className="dshMkt-detailCard"
      {...footer === undefined ? {} : { footer }}
    >
      {error !== '' ? (
        <p className="dshMkt-dialogMessage dshMkt-stripError">{error}</p>
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
        </>
      )}
    </Modal>
  )
}
