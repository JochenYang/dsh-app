/**
 * The provider list: the page's home level, and the shape of one row's summary.
 *
 * The list answers one question — which provider am I about to edit — so a row
 * carries the vendor's mark, the name and a chevron; the route id, protocol and
 * model count belong to the page it opens. It is a reading surface only:
 * creating a provider, its endpoint and its key stay on the official Models
 * page, which is why there is no "add provider" row here.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/provider-list
 */

import type { ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { iconForProvider, ProviderMark } from './provider-mark.tsx'
import { IconChevronRight, IconPin, IconPlus, IconRefresh, IconSpinner } from './icons.tsx'
import type { Translate } from './messages.ts'
import type { RouteRow } from './store.ts'

/** What a row needs, resolved once per render from the route and its profile. */
export interface ProviderSummary {
  /** The route id (also the settings key). */
  readonly route: string
  /** Display name, or the route id when the profile carries none. */
  readonly displayName: string
  /** True when the user layer declares its own model list. */
  readonly declared: boolean
  /** True when the route is currently registered with the adapter. */
  readonly active: boolean
  /** The wire protocol the profile names, when it names one. */
  readonly api?: string
  /** The endpoint the profile names, when it names one. */
  readonly baseURL?: string
  /** Models in the user layer's own list. */
  readonly models: number
  /** Per-model overrides in the user layer. */
  readonly overrides: number
  /** True when the user layer carries a profile for this route (a configured
   *  provider, as opposed to a catalog entry that could be added). */
  readonly configured: boolean
}

/**
 * Summarize one route for the list and the detail header.
 *
 * `profile` is the RESOLVED profile (every layer), because that is what the
 * provider actually serves; the counts are the USER layer's, because that is what
 * this page writes and "3 个覆盖" must mean three overrides of mine, not three
 * catalog entries somebody else shipped.
 *
 * @param row - the joined route row.
 * @param profile - the resolved profile object at the route's settings path.
 * @returns the row summary.
 */
export function summarizeRoute(row: RouteRow, profile: Record<string, unknown>): ProviderSummary {
  const displayName = typeof profile.displayName === 'string' && profile.displayName.trim() !== ''
    ? profile.displayName.trim()
    : row.entry.displayName.trim() !== '' ? row.entry.displayName : row.entry.provider
  const models = Array.isArray(row.userProfile?.models) ? row.userProfile.models.length : 0
  const overrides = typeof row.userProfile?.modelOverrides === 'object'
    && row.userProfile.modelOverrides !== null
    && !Array.isArray(row.userProfile.modelOverrides)
    ? Object.keys(row.userProfile.modelOverrides as Record<string, unknown>).length
    : 0
  return {
    route: row.entry.provider,
    displayName,
    declared: row.entry.declared === true,
    active: row.entry.active,
    ...(typeof profile.api === 'string' && profile.api !== '' ? { api: profile.api } : {}),
    ...(typeof profile.baseURL === 'string' && profile.baseURL !== '' ? { baseURL: profile.baseURL } : {}),
    models,
    overrides,
    configured: row.userProfile !== undefined,
  }
}

/** Props of {@link ProviderListPage}. */
export interface ProviderListPageProps {
  readonly t: Translate
  readonly rows: readonly ProviderSummary[]
  readonly loading: boolean
  readonly readOnly: boolean
  /** Load failure text, already localized by the lower layer. */
  readonly error?: string
  readonly refreshing: boolean
  readonly onOpen: (route: string) => void
  readonly onAdd: () => void
  readonly onRefresh: () => void
  /** Pinned route ids, in pin order. */
  readonly pins: readonly string[]
  readonly onTogglePin: (route: string) => void
}

/** Placeholder rows while the first load is in flight. */
function SkeletonRows(): ReactNode {
  return (
    <div className="dshAma-list" aria-hidden="true">
      {[0, 1, 2, 3].map(key => (
        <div className="dshAma-skelRow" key={key}>
          <span className="dshAma-skel dshAma-skelMark" />
          <span className="dshAma-skel" style={{ width: `${46 - key * 6}%` }} />
        </div>
      ))}
    </div>
  )
}

/**
 * Render the provider list.
 * @param props - see {@link ProviderListPageProps}.
 * @returns the page.
 */
export function ProviderListPage(props: ProviderListPageProps): ReactNode {
  const { t, rows, loading, readOnly, error, refreshing, onOpen, onAdd, onRefresh, pins, onTogglePin } = props
  // Pinned providers first (in pin order), then everything else in the catalog's
  // own order. Only configured rows can be pinned, so the block always means
  // "the providers this user actually uses".
  const ordered = [
    ...pins
      .map(route => rows.find(row => row.route === route && row.configured))
      .filter((row): row is ProviderSummary => row !== undefined),
    ...rows.filter(row => row.configured && !pins.includes(row.route)),
  ]
  const available = rows.filter(row => !row.configured)

  const rowOf = (row: ProviderSummary, index: number): ReactNode => {
    const pinned = pins.includes(row.route)
    return (
      <div
        key={row.route}
        className="dshAma-row"
        style={{ animationDelay: `${String(Math.min(index, 12) * 18)}ms` }}
      >
        <button
          type="button"
          className="dshAma-rowMain"
          onClick={() => { onOpen(row.route) }}
        >
          <ProviderMark iconKey={iconForProvider(row)} label={row.displayName} size={22} />
          <span className="dshAma-rowName">{row.displayName}</span>
          <span className="dshAma-rowChevron"><IconChevronRight /></span>
        </button>
        {row.configured
          ? (
            <Tooltip label={pinned ? t('adv.page.unpin') : t('adv.page.pin')} side="left">
              <Button
                type="button" variant="ghost" size="sm"
                className={`dshAma-iconAction dshAma-pin${pinned ? ' is-on' : ''}`}
                icon={<IconPin filled={pinned} />}
                aria-label={pinned ? t('adv.page.unpin') : t('adv.page.pin')}
                aria-pressed={pinned}
                onClick={() => { onTogglePin(row.route) }}
              />
            </Tooltip>
          )
          : null}
      </div>
    )
  }
  return (
    <div className="dshAma-view">
      <header className="dshAma-pageHead">
        <h2 className="dshAma-pageTitle">
          {t('adv.page.title')}
          {loading ? null : <span className="dshAma-pageCount">{rows.length}</span>}
        </h2>
        <Tooltip label={t('adv.page.refresh')} side="left">
          <Button
            type="button" variant="ghost" size="sm"
            className="dshAma-iconAction"
            icon={refreshing ? <IconSpinner /> : <IconRefresh />}
            aria-label={t('adv.page.refresh')}
            aria-busy={refreshing}
            disabled={loading || refreshing}
            onClick={onRefresh}
          />
        </Tooltip>
      </header>

      {error === undefined
        ? null
        : <p className="dshAma-alert is-err" role="alert">{t('adv.load.failed', { message: error })}</p>}
      {readOnly ? <p className="dshAma-alert" role="status">{t('adv.readOnly')}</p> : null}

      {loading ? <SkeletonRows /> : null}

      {!loading && rows.length === 0 && error === undefined
        ? (
          <div className="dshAma-empty">
            <span className="dshAma-emptyTitle">{t('adv.page.empty')}</span>
            <span className="dshAma-emptyHint">{t('adv.page.emptyHint')}</span>
          </div>
        )
        : null}

      {loading || rows.length === 0
        ? null
        : (
          <>
            {ordered.length === 0
              ? null
              : (
                <>
                  <h3 className="dshAma-listSection">
                    {t('adv.page.configured')}
                    <span className="dshAma-count">{ordered.length}</span>
                  </h3>
                  <div className="dshAma-list">{ordered.map(rowOf)}</div>
                </>
              )}
            {available.length === 0
              ? null
              : (
                <>
                  <h3 className="dshAma-listSection">
                    {t('adv.page.catalog')}
                    <span className="dshAma-count">{available.length}</span>
                  </h3>
                  <div className="dshAma-list">{available.map(rowOf)}</div>
                </>
              )}
          </>
        )}

      {loading ? null : (
        <button type="button" className="dshAma-addRow" disabled={readOnly} onClick={onAdd}>
          <span className="dshAma-addRowIcon" aria-hidden="true"><IconPlus /></span>
          {t('adv.page.add')}
        </button>
      )}
    </div>
  )
}
