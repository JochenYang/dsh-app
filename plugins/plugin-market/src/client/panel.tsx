/**
 * The market panel: a sidebar footer entry ("插件市场") that opens a
 * right-side drawer over the host's market routes.
 *
 * Three tabs keep each concern scannable: 目录 (browse + install/update, with
 * per-source failure reporting), 已安装 (profile dependencies + mount state +
 * updates + uninstall), 软件源 (the https URL list the catalog is fetched
 * from). The installed tab separates its two counts: the label carries the
 * installed total (what the user owns), while pending updates live in a
 * corner badge and a dismissible in-tab banner (one day per dismissal) — a
 * backlog of 2 inside a library of 15 never reads as "only 2 installed".
 * Opening renders from the host's TTL cache when it answers
 * (`cached`), and the payload's `stale`/`snapshot` flags drive an explicit
 * rescue banner instead of silent background work — a failed fetch already
 * burned its timeout once, so retrying stays a visible user decision. The
 * catalog and the installed list are independent requests, and the installed
 * list itself loads in two phases: the local facts first (no registry
 * round-trip, so it paints at once), then a `?updates=1` probe whose fields
 * merge onto the rows already on screen. All
 * state is local to the open panel — closing it drops the view, reopening
 * refetches, so the panel never shows stale mount state.
 *
 * @module @dsh-app/plugin-market/client/panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { normalizeNpmName } from '../identity.ts'
import { marketApi, MarketApiError, PAGED_SOURCE_HOST } from './api.ts'
import type { CatalogEntry, CatalogValue, InstalledPackage, LegacyValue, SourcesValue, UpdateValue } from './api.ts'
import { categoryOptionsOf, entryMatchesQuery } from './catalog-filter.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { sameNameStateOf, updatablePackages, mergeUpdateFacts } from './installed-projection.ts'
import { type HostText } from '../errors.ts'
import { NS } from './locales.ts'
import { hostMessage, sourceReasonOf, type Translate } from './messages.ts'

/** Props delivered by the sidebar slot: column state + this panel's `t` seat. */
export type MarketFooterActionProps = { wide: boolean } & PropsLocale<typeof NS>

type Tab = 'catalog' | 'installed' | 'sources'

/** One line of the dismissible status strip (error or success notice). */
interface Strip {
  readonly kind: 'error' | 'ok'
  readonly text: string
  /** CLI output tail attachable to a success notice. */
  readonly output?: string
  /**
   * Package names pnpm skipped build scripts for — the strip grows a warning
   * bar with the allow-and-retry action (present = signal detected; possibly
   * empty when no name could be extracted from the message).
   */
  readonly blockedBuilds?: readonly string[]
  /** The package a blocked-builds retry would reinstall. */
  readonly retryPackage?: string
}

/** How the served catalog payload was produced (drives the hint banners). */
interface ServedCatalogInfo {
  readonly cachedAt?: number
  readonly cached?: boolean
  readonly stale?: boolean
  readonly snapshot?: boolean
  readonly snapshotAt?: string
}

/** Age beyond which the cache hint calls the snapshot old. */
const CATALOG_CACHE_STALE_MS = 24 * 60 * 60 * 1000

/** Success notices self-clear; errors stay until dismissed (they need reading time). */
const STRIP_AUTO_CLEAR_MS = 8000

/** Beyond these sizes the CLI output tail starts collapsed behind a toggle. */
const LOG_COLLAPSE_LINES = 6
const LOG_COLLAPSE_CHARS = 400

/** localStorage key remembering the day the updates banner was dismissed. */
const UPDATES_BANNER_KEY = 'dshMkt.updatesBannerDismissedOn'

/** Local-calendar date stamp (YYYY-MM-DD) — "same day" follows the user's clock. */
function localDateStamp(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function isUpdatesBannerDismissed(): boolean {
  try {
    return localStorage.getItem(UPDATES_BANNER_KEY) === localDateStamp()
  } catch {
    // Storage unavailable (private mode etc.): the banner simply stays askable.
    return false
  }
}

function isLongOutput(output: string): boolean {
  return output.split(/\r?\n/).length > LOG_COLLAPSE_LINES || output.length > LOG_COLLAPSE_CHARS
}

/** Humanized cache age for the hint ("3 分钟前"); sub-minute reads as fresh. */
function cacheAgeText(cachedAt: number, t: Translate): string {
  const minutes = Math.max(0, Math.floor((Date.now() - cachedAt) / 60_000))
  if (minutes < 1) return t('mkt.age.now')
  if (minutes < 60) return t('mkt.age.minutes', { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('mkt.age.hours', { hours })
  return t('mkt.age.days', { days: Math.floor(hours / 24) })
}

/**
 * One message's text: an API failure carries the host's coded message, which
 * this panel renders in its own language (an unknown code falls back to the
 * host's English diagnostic), while the unknown-error fallback is a key of this
 * panel's dictionary.
 */
function messageOf(error: unknown, t: Translate): string {
  if (error instanceof MarketApiError) return hostMessage(error.host, t, error.message)
  return error instanceof Error ? error.message : t('mkt.error.request')
}

/**
 * The CLI output tail of a status strip: short tails render directly, long
 * ones start collapsed behind a "查看日志" toggle so a full pnpm log cannot
 * flood the panel.
 */
function StripOutput({ output, t }: { output: string, t: Translate }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const long = isLongOutput(output)
  return (
    <>
      {long ? (
        <button type="button" className="dshMkt-logToggle" onClick={() => setExpanded(flag => !flag)}>
          {expanded ? t('mkt.log.collapse') : t('mkt.log.expand')}
        </button>
      ) : null}
      {!long || expanded ? <pre className="dshMkt-log">{output}</pre> : null}
    </>
  )
}

/**
 * The blocked-builds warning inside a status strip: names the packages whose
 * build scripts pnpm skipped and offers the allow-and-retry action. When no
 * name could be extracted from the pnpm message the button stays hidden —
 * retrying with an empty whitelist could not change anything — and the copy
 * points at the manual fix instead.
 */
function BlockedBuildBar({
  names, retryPackage, busyPackage, onRetry, t,
}: {
  names: readonly string[]
  retryPackage: string | undefined
  busyPackage: string | null
  onRetry: (pkg: string, names: readonly string[]) => void
  t: Translate
}): ReactNode {
  return (
    <div className="dshMkt-blockedBar">
      <span className="dshMkt-stripText">
        {names.length > 0
          ? t('mkt.blocked.names', { names: names.join(t('mkt.names.separator')) })
          : t('mkt.blocked.unknown')}
      </span>
      {names.length > 0 && retryPackage !== undefined ? (
        <button
          type="button"
          className="dshMkt-button dshMkt-buttonPrimary"
          disabled={busyPackage !== null}
          onClick={() => { onRetry(retryPackage, names) }}
        >
          {busyPackage === retryPackage ? <span className="dshMkt-spinner" aria-hidden="true" /> : null}
          {busyPackage === retryPackage ? t('mkt.blocked.busy') : t('mkt.blocked.retry')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Market glyph: a 2×2 grid of rounded plugin tiles in the host's linear icon
 * language; the bottom-right tile carries an inset outline — the "active"
 * tile in the collection.
 */
function MarketGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg className="dshMkt-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.25" y="3.25" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <rect x="12.75" y="3.25" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <rect x="3.25" y="12.75" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <rect x="12.75" y="12.75" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <rect x="14.95" y="14.95" width="3.6" height="3.6" rx="1" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The sidebar footer action: a labeled row when the sidebar is wide, a plain
 * icon button on the 56px rail. Geometry mirrors the host's settings trigger
 * (42px row / 36px rail circle, 16px wide icon / 18px rail icon) so both foot
 * rows read as one control set.
 */
export function MarketFooterAction(props: MarketFooterActionProps): ReactNode {
  const { wide, t } = props
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={wide ? 'dshMkt-rowBtn' : 'dshMkt-iconBtn'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('mkt.nav')}
        title={t('mkt.nav')}
        onClick={() => setOpen(true)}
      >
        <MarketGlyph size={wide ? 16 : 18} />
        {wide ? <span>{t('mkt.nav')}</span> : null}
      </button>
      {open ? <MarketPanel onClose={() => setOpen(false)} t={t} /> : null}
    </>
  )
}

/**
 * The drawer body. Mounts only while open (the entry above unmounts it), so
 * every open starts from fresh data.
 */
function MarketPanel({ onClose, t }: { onClose: () => void, t: Translate }): ReactNode {
  const [tab, setTab] = useState<Tab>('catalog')
  const [strip, setStrip] = useState<Strip | null>(null)
  const [loading, setLoading] = useState(true)
  const [installedLoading, setInstalledLoading] = useState(true)
  /** True while the follow-up `?updates=1` probe runs (list already visible). */
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [cacheInfo, setCacheInfo] = useState<ServedCatalogInfo | null>(null)
  const [entries, setEntries] = useState<readonly CatalogEntry[]>([])
  const [failedSources, setFailedSources] = useState<ReadonlyArray<{ url: string, reason: HostText }>>([])
  /** The catalog request itself failed (kept apart from per-source failures). */
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [installed, setInstalled] = useState<readonly InstalledPackage[]>([])
  /** Packages the previous profile declares and this one lacks (see /legacy). */
  const [legacy, setLegacy] = useState<LegacyValue | null>(null)
  /** Session-local dismissal of the inherit row. */
  const [legacyHidden, setLegacyHidden] = useState(false)
  /** Progress of a running inherit batch (`null` when idle). */
  const [legacyBusy, setLegacyBusy] = useState<{ readonly done: number, readonly total: number, readonly name: string } | null>(null)
  const [sources, setSources] = useState<readonly string[]>([])
  const [sourceInput, setSourceInput] = useState('')
  const [busyPackage, setBusyPackage] = useState<string | null>(null)
  const [togglingPackage, setTogglingPackage] = useState<string | null>(null)
  const [savingSources, setSavingSources] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<InstalledPackage | null>(null)
  /**
   * The entry an install confirm is open for, with the cross-origin flag the
   * card computed: it upgrades the confirm copy and turns the request into
   * the force-confirmed replacement the host's gate requires.
   */
  const [installTarget, setInstallTarget] = useState<{ readonly entry: CatalogEntry, readonly crossOrigin: boolean } | null>(null)
  // Read once per panel mount: a same-day dismissal survives closing and
  // reopening the panel, a new day asks again.
  const [updatesDismissed, setUpdatesDismissed] = useState(isUpdatesBannerDismissed)
  // Enter/exit are one CSS transition: the drawer mounts off-screen and is
  // flipped on the next frame, and a close request flips it back before the
  // unmount lands, so the panel slides both ways instead of vanishing.
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => { setShown(true) })
    return () => { cancelAnimationFrame(id) }
  }, [])

  const requestClose = useCallback((): void => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(onClose, CLOSE_ANIMATION_MS)
  }, [onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [requestClose])

  // Success strips self-clear so a settled action never lingers; each new
  // strip (object identity) restarts the timer, unmount cancels it. A strip
  // carrying a blocked-builds warning stays up: it carries the pending
  // allow-and-retry decision, and a self-clearing action button would vanish
  // before the user reaches it.
  useEffect(() => {
    if (strip === null || strip.kind !== 'ok' || strip.blockedBuilds !== undefined) return
    const timer = setTimeout(() => { setStrip(null) }, STRIP_AUTO_CLEAR_MS)
    return () => { clearTimeout(timer) }
  }, [strip])

  const applyCatalogValue = useCallback((value: CatalogValue): void => {
    setEntries(value.plugins)
    setFailedSources(value.failed)
    setSources(value.sources)
    setCacheInfo({
      cachedAt: value.cachedAt,
      cached: value.cached,
      stale: value.stale,
      snapshot: value.snapshot,
      snapshotAt: value.snapshotAt,
    })
    setCatalogError(null)
  }, [])

  /**
   * Second paint: ask for the registry update facts and merge them onto the
   * rows already on screen. Runs only after the local read has rendered, so
   * the registry round-trips can never gate the list; a failure leaves the
   * local rows untouched (the tab's refresh retries).
   */
  const loadInstalledUpdates = useCallback(async (): Promise<void> => {
    setCheckingUpdates(true)
    try {
      const probed = await marketApi.installed(true)
      // mergeUpdateFacts keeps the array identity when nothing changed, so a
      // "no updates" answer re-renders nothing and the list never jumps.
      setInstalled(current => mergeUpdateFacts(current, probed.packages))
    } catch {
      // Supplement only: the probe timing out or failing must not disturb the
      // local facts already shown.
    } finally {
      setCheckingUpdates(false)
    }
  }, [])

  const loadInstalled = useCallback(async (): Promise<void> => {
    setInstalledLoading(true)
    try {
      // Local facts only: no `updates`, so the host answers from disk and the
      // list paints without waiting on any registry request.
      const value = await marketApi.installed()
      setInstalled(value.packages)
      // Same paint, non-fatal: the inherit row is an offer, never a fact the
      // rest of the panel depends on.
      void marketApi.legacy().then(setLegacy).catch(() => undefined)
    } catch (error) {
      setStrip({ kind: 'error', text: t('mkt.installed.loadFailed', { message: messageOf(error, t) }) })
      return
    } finally {
      setInstalledLoading(false)
    }
    void loadInstalledUpdates()
  }, [loadInstalledUpdates, t])

  /**
   * Force reload: skips the host cache and pays the live fetch. The spinner
   * blocks the tab honestly — the user pressed "reload", not "browse cache".
   */
  const refreshCatalog = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      applyCatalogValue(await marketApi.catalog(true))
    } catch (error) {
      // The request (not a source) failed: the catalog tab shows the reason
      // with a prominent reload, not the top strip alone.
      setCatalogError(messageOf(error, t))
    } finally {
      setLoading(false)
    }
  }, [applyCatalogValue, t])

  useEffect(() => {
    let cancelled = false
    // Two independent requests. On a cold open the catalog may pay a live
    // source fetch (no cache, 30 s per source), so the installed list must
    // never queue behind it — it starts now and paints from the local read.
    void (async (): Promise<void> => {
      setLoading(true)
      try {
        const served = await marketApi.catalog()
        if (cancelled) return
        applyCatalogValue(served)
      } catch (error) {
        if (!cancelled) setCatalogError(messageOf(error, t))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    void loadInstalled()
    return () => { cancelled = true }
  }, [applyCatalogValue, loadInstalled, t])

  // Keys are normalized npm names: a catalog source's casing must never hide
  // a same-name collision.
  const installedByName = new Map(installed.map(pkg => [normalizeNpmName(pkg.name), pkg]))
  const updatable = updatablePackages(installed)
  const updateCount = updatable.length

  /** Dismiss the updates banner for the rest of the day. */
  const dismissUpdatesBanner = (): void => {
    try {
      localStorage.setItem(UPDATES_BANNER_KEY, localDateStamp())
    } catch {
      // Same degradation as the read: the panel-local state still hides it.
    }
    setUpdatesDismissed(true)
  }

  const saveSources = async (urls: readonly string[]): Promise<boolean> => {
    setSavingSources(true)
    try {
      const value: SourcesValue = await marketApi.saveSources(urls)
      setSources(value.sources)
      setStrip(null)
      return true
    } catch (error) {
      setStrip({ kind: 'error', text: t('mkt.sources.saveFailed', { message: messageOf(error, t) }) })
      return false
    } finally {
      setSavingSources(false)
    }
  }

  const addSource = async (): Promise<void> => {
    const candidate = sourceInput.trim()
    if (candidate === '') return
    // Keep the optimistic append; a rejected save restores the previous list.
    const previous = sources
    setSourceInput('')
    setSources([...sources, candidate])
    const saved = await saveSources([...sources, candidate])
    if (!saved) setSources(previous)
  }

  const removeSource = async (url: string): Promise<void> => {
    const next = sources.filter(item => item !== url)
    const previous = sources
    setSources(next)
    const saved = await saveSources(next)
    if (!saved) setSources(previous)
  }

  /** Blocked-builds fields of a result/error, for the strip's warning bar. */
  const blockedStripFields = (blockedBuilds: readonly string[] | undefined, retryPackage: string) =>
    (blockedBuilds !== undefined ? { blockedBuilds, retryPackage } : {})

  /**
   * Install every package the previous profile declares but this one lacks.
   *
   * Sequential on purpose: the host serializes installs regardless, and
   * per-package progress is easier to act on than one opaque run. A failure
   * does not abort the batch — the strip names what did not make it and the row
   * stays, so a retry is one click. Specs go over verbatim, so local tarballs,
   * github shorthands and https tarballs work the same as registry ranges.
   */
  const inheritLegacy = async (): Promise<void> => {
    const targets = legacy?.missing ?? []
    if (targets.length === 0) return
    setStrip(null)
    const failed: string[] = []
    for (const [index, pkg] of targets.entries()) {
      setLegacyBusy({ done: index, total: targets.length, name: pkg.name })
      try {
        await marketApi.inherit(pkg.name, pkg.spec)
      } catch {
        failed.push(pkg.name)
      }
    }
    setLegacyBusy(null)
    const succeeded = targets.length - failed.length
    setStrip(failed.length === 0
      ? { kind: 'ok', text: t('mkt.inherit.done', { count: String(succeeded) }) }
      : { kind: 'error', text: t('mkt.inherit.failed', { count: String(failed.length), names: failed.join(', ') }) })
    void loadInstalled()
  }

  const install = async (target: { readonly entry: CatalogEntry, readonly crossOrigin: boolean }): Promise<void> => {
    const { entry, crossOrigin } = target
    setBusyPackage(entry.package)
    setInstallTarget(null)
    setStrip(null)
    try {
      // A cross-origin replacement rides the force path: the flag satisfies
      // the host's same-name gate, and the entry's repo key lets the gate's
      // refusal/log name both sides of the comparison.
      const result = await marketApi.install(entry.package, undefined, crossOrigin ? true : undefined, entry.repoKey)
      void loadInstalled()
      const replacedNote = result.replacedLocal === true
        ? t('mkt.install.replacedLocal')
        : (crossOrigin ? t('mkt.install.replacedCrossOrigin') : '')
      setStrip({
        kind: 'ok',
        text: t('mkt.install.done', {
          package: entry.package,
          version: result.version === undefined ? '' : `@${result.version}`,
          note: replacedNote,
        }),
        output: result.output,
        ...blockedStripFields(result.blockedBuilds, entry.package),
      })
    } catch (error) {
      const blocked = error instanceof MarketApiError ? error.blockedBuilds : undefined
      setStrip({
        kind: 'error',
        text: t('mkt.install.failed', { message: messageOf(error, t) }),
        ...blockedStripFields(blocked, entry.package),
      })
    } finally {
      setBusyPackage(null)
    }
  }

  /**
   * Retry path after a blocked-builds result: whitelist the packages, then
   * re-run the install. The retry may still report blocked builds (e.g. more
   * than one package needed approving across runs), so the strip keeps its
   * warning bar in that case.
   */
  const allowAndRetry = async (pkgName: string, names: readonly string[]): Promise<void> => {
    setBusyPackage(pkgName)
    try {
      const result = await marketApi.allowBuild(pkgName, names)
      void loadInstalled()
      setStrip({
        kind: 'ok',
        text: t('mkt.allowBuild.done', {
          package: pkgName,
          version: result.version === undefined ? '' : `@${result.version}`,
        }),
        output: result.output,
        ...blockedStripFields(result.blockedBuilds, pkgName),
      })
    } catch (error) {
      const blocked = error instanceof MarketApiError ? error.blockedBuilds : undefined
      setStrip({
        kind: 'error',
        text: t('mkt.allowBuild.failed', { message: messageOf(error, t) }),
        ...blockedStripFields(blocked, pkgName),
      })
    } finally {
      setBusyPackage(null)
    }
  }

  /**
   * One installed package to the registry's latest, server-gated via /update.
   * Returns whether it succeeded so the batch loop can count failures.
   */
  const updatePackage = async (pkg: InstalledPackage): Promise<boolean> => {
    setBusyPackage(pkg.name)
    setStrip(null)
    try {
      const result: UpdateValue = await marketApi.update(pkg.name)
      void loadInstalled()
      setStrip({
        kind: 'ok',
        text: t('mkt.update.done', {
          package: pkg.name,
          version: result.version === undefined ? '' : `@${result.version}`,
        }),
        output: result.output,
        ...blockedStripFields(result.blockedBuilds, pkg.name),
      })
      return true
    } catch (error) {
      const blocked = error instanceof MarketApiError ? error.blockedBuilds : undefined
      setStrip({
        kind: 'error',
        text: t('mkt.update.failed', { message: messageOf(error, t) }),
        ...blockedStripFields(blocked, pkg.name),
      })
      return false
    } finally {
      setBusyPackage(null)
    }
  }

  /**
   * Batch update over exactly the packages the tab badge counts. One at a
   * time — the installer queue serializes server-side and the panel is honest
   * about a single mutation — and over a list snapshotted at click: each
   * per-package refresh re-renders `installed`, and the loop must not
   * re-derive its targets mid-run.
   */
  const updateAll = async (): Promise<void> => {
    const targets = updatablePackages(installed)
    let failed = 0
    for (const pkg of targets) {
      const ok = await updatePackage(pkg)
      if (!ok) failed += 1
    }
    setStrip(failed === 0
      ? { kind: 'ok', text: t('mkt.updateAll.done', { count: targets.length }) }
      : {
        kind: 'error',
        text: t('mkt.updateAll.partial', { ok: targets.length - failed, failed }),
      })
  }

  const uninstall = async (pkg: InstalledPackage): Promise<void> => {
    setBusyPackage(pkg.name)
    setConfirmTarget(null)
    setStrip(null)
    try {
      const result = await marketApi.uninstall(pkg.name)
      void loadInstalled()
      setStrip({ kind: 'ok', text: t('mkt.uninstall.done', { package: pkg.name }), output: result.output })
    } catch (error) {
      setStrip({ kind: 'error', text: t('mkt.uninstall.failed', { message: messageOf(error, t) }) })
    } finally {
      setBusyPackage(null)
    }
  }

  const togglePackage = async (pkg: InstalledPackage): Promise<void> => {
    setTogglingPackage(pkg.name)
    setStrip(null)
    try {
      const value = await marketApi.toggle(pkg.name, pkg.entryId, !pkg.enabled)
      void loadInstalled()
      setStrip({
        kind: 'ok',
        text: value.enabled
          ? t('mkt.toggle.enabled', { package: value.package })
          : t('mkt.toggle.disabled', { package: value.package }),
      })
    } catch (error) {
      setStrip({
        kind: 'error',
        text: pkg.enabled
          ? t('mkt.toggle.disableFailed', { message: messageOf(error, t) })
          : t('mkt.toggle.enableFailed', { message: messageOf(error, t) }),
      })
    } finally {
      setTogglingPackage(null)
    }
  }

  /**
   * Install confirm copy. A cross-origin install leads with the replacement
   * warning — the locally installed repo when provable, 未知来源 when not —
   * so the confirm button reads as an informed replacement decision, never
   * a plain install.
   */
  const installConfirmMessage = (): string => {
    if (installTarget === null) return ''
    const installed = installedByName.get(normalizeNpmName(installTarget.entry.package))
    const warning = installTarget.crossOrigin && installed !== undefined
      ? t('mkt.install.crossOrigin', { repo: installed.repoKey ?? t('mkt.unknownRepo') })
      : ''
    return `${warning}${t('mkt.install.confirm', {
      package: installTarget.entry.package,
      name: installTarget.entry.name,
    })}`
  }

  return (
    <div className={shown && !closing ? 'dshMkt-drawer dshMkt-drawerOn' : 'dshMkt-drawer'} role="presentation">
      {/* The drawer slides in over the right edge without dimming the page:
          browsing a catalog is not a modal decision. The collapse control is
          the edge handle (centered on the left border), so no control has to
          live near the native window buttons or the drag strip. */}
      <button
        type="button"
        className="dshMkt-handle"
        onClick={requestClose}
        aria-label={t('mkt.close.aria')}
        title={t('mkt.close.title')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="dshMkt-panel" role="dialog" aria-modal="false" aria-label={t('mkt.nav')}>
        <div className="dshMkt-head">
          <h2 className="dshMkt-title">{t('mkt.nav')}</h2>
        </div>
        <div className="dshMkt-tabs" role="tablist">
          {([['catalog', 'mkt.tab.catalog'], ['installed', 'mkt.tab.installed'], ['sources', 'mkt.tab.sources']] as const).map(([key, labelKey]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'dshMkt-tab dshMkt-tabOn' : 'dshMkt-tab'}
              onClick={() => { setTab(key) }}
            >
              {key === 'installed' ? t('mkt.tab.installedCount', { count: installed.length }) : t(labelKey)}
              {key === 'installed' && updateCount > 0 ? (
                <span className="dshMkt-tabBadge" title={t('mkt.updates.title', { count: updateCount })}>
                  {updateCount > 99 ? '99+' : updateCount}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="dshMkt-body">
          {strip !== null ? (
            <div className={strip.kind === 'error' ? 'dshMkt-banner' : 'dshMkt-noticeOk'} role={strip.kind === 'error' ? 'alert' : 'status'}>
              <div className="dshMkt-stripBody">
                <span className="dshMkt-stripText">{strip.text}</span>
                <button type="button" className="dshMkt-stripClose" aria-label={t('mkt.strip.close')} onClick={() => { setStrip(null) }}>
                  ×
                </button>
              </div>
              {strip.output !== undefined && strip.output !== ''
                ? <StripOutput key={strip.output} output={strip.output} t={t} />
                : null}
              {strip.blockedBuilds !== undefined ? (
                <BlockedBuildBar
                  names={strip.blockedBuilds}
                  retryPackage={strip.retryPackage}
                  busyPackage={busyPackage}
                  onRetry={(pkgName, names) => { void allowAndRetry(pkgName, names) }}
                  t={t}
                />
              ) : null}
            </div>
          ) : null}

          {tab === 'catalog' ? (
            <CatalogTab
              loading={loading}
              loadError={catalogError}
              entries={entries}
              failedSources={failedSources}
              installedByName={installedByName}
              busyPackage={busyPackage}
              cacheInfo={cacheInfo}
              onRefresh={() => { void refreshCatalog() }}
              onGoSources={() => { setTab('sources') }}
              onInstall={(entry, crossOrigin) => { setInstallTarget({ entry, crossOrigin }) }}
              onUpdate={(pkg) => { void updatePackage(pkg) }}
              t={t}
            />
          ) : null}

          {tab === 'installed' ? (
            <>
              {updateCount > 0 && !updatesDismissed ? (
                <div className="dshMkt-noticeOk" role="status">
                  <div className="dshMkt-stripBody">
                    <span className="dshMkt-stripText">{t('mkt.updates.title', { count: updateCount })}</span>
                    <button
                      type="button"
                      className="dshMkt-button dshMkt-buttonPrimary"
                      disabled={busyPackage !== null || togglingPackage !== null}
                      onClick={() => { void updateAll() }}
                    >
                      {t('mkt.updates.all')}
                    </button>
                    <button type="button" className="dshMkt-stripClose" aria-label={t('mkt.updates.dismiss')} onClick={dismissUpdatesBanner}>
                      ×
                    </button>
                  </div>
                </div>
              ) : null}
              <InstalledTab
                loading={installedLoading}
                checkingUpdates={checkingUpdates}
                packages={installed}
                busyPackage={busyPackage}
                togglingPackage={togglingPackage}
                legacy={legacy}
                legacyBusy={legacyBusy}
                legacyHidden={legacyHidden}
                onRefresh={() => { void loadInstalled() }}
                onToggle={(pkg) => { void togglePackage(pkg) }}
                onUninstall={(pkg) => { setConfirmTarget(pkg) }}
                onUpdate={(pkg) => { void updatePackage(pkg) }}
                onInherit={() => { void inheritLegacy() }}
                onDismissLegacy={() => { setLegacyHidden(true) }}
                t={t}
              />
            </>
          ) : null}

          {tab === 'sources' ? (
            <SourcesTab
              loading={loading}
              sources={sources}
              saving={savingSources}
              input={sourceInput}
              onInput={setSourceInput}
              onAdd={() => { void addSource() }}
              onRemove={(url) => { void removeSource(url) }}
              onRefresh={() => { void refreshCatalog() }}
              t={t}
            />
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('mkt.uninstall.title')}
        message={confirmTarget === null ? '' : t('mkt.uninstall.confirm', { package: confirmTarget.name })}
        confirmLabel={t('mkt.uninstall.action')}
        cancelLabel={t('mkt.dialog.cancel')}
        tone="dark"
        busy={busyPackage !== null}
        onConfirm={() => { if (confirmTarget !== null) void uninstall(confirmTarget) }}
        onClose={() => { setConfirmTarget(null) }}
      />

      <ConfirmDialog
        open={installTarget !== null}
        title={t('mkt.install.title')}
        message={installConfirmMessage()}
        confirmLabel={t('mkt.install.action')}
        cancelLabel={t('mkt.dialog.cancel')}
        busy={busyPackage !== null}
        onConfirm={() => { if (installTarget !== null) void install(installTarget) }}
        onClose={() => { setInstallTarget(null) }}
      />
    </div>
  )
}

interface CatalogTabProps {
  loading: boolean
  /** Non-null = the catalog request itself failed (distinct from per-source failures). */
  loadError: string | null
  entries: readonly CatalogEntry[]
  failedSources: ReadonlyArray<{ url: string, reason: HostText }>
  installedByName: ReadonlyMap<string, InstalledPackage>
  busyPackage: string | null
  cacheInfo: ServedCatalogInfo | null
  onRefresh: () => void
  onGoSources: () => void
  /** `crossOrigin` marks the same-name-different-repo install (upgraded confirm + force). */
  onInstall: (entry: CatalogEntry, crossOrigin: boolean) => void
  onUpdate: (pkg: InstalledPackage) => void
  t: Translate
}

/** Rows rendered per page: large directories stay past 3000 entries. */
/** Must match the drawer's CSS transition duration. */
const CLOSE_ANIMATION_MS = 220
const CATALOG_PAGE_SIZE = 100

/** "作者 · 下载量/ stars · 分类" byline of a catalog card (parts may be absent). */
function cardByline(entry: CatalogEntry, t: Translate): string {
  const metric = entry.installs30d !== undefined
    ? t('mkt.card.installs30d', { count: entry.installs30d })
    : (entry.stars !== undefined ? `★ ${String(entry.stars)}` : undefined)
  return [entry.owner, metric, entry.category].filter(part => part !== undefined).join(' · ')
}

function CatalogTab({
  loading, loadError, entries, failedSources, installedByName, busyPackage, cacheInfo, onRefresh, onGoSources, onInstall, onUpdate, t,
}: CatalogTabProps): ReactNode {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [visible, setVisible] = useState(CATALOG_PAGE_SIZE)

  // Distinct options in first-seen order, keyed on the stable categoryId (the
  // label is the fallback key for rows persisted before ids were resolved);
  // "全部" stays the implicit first choice.
  const categories = categoryOptionsOf(entries)

  // Client-side narrowing only — the host already merged and capped the rows.
  const needle = query.trim().toLowerCase()
  const filtered = entries.filter((entry) => {
    if (category !== '' && (entry.categoryId ?? entry.category) !== category) return false
    return entryMatchesQuery(entry, needle)
  })

  // A new filter resets the page window, so a fresh search starts at the top.
  useEffect(() => { setVisible(CATALOG_PAGE_SIZE) }, [query, category])

  if (loading) {
    return (
      <div className="dshMkt-empty">
        <span className="dshMkt-spinner" aria-hidden="true" /> {t('mkt.catalog.loading')}
      </div>
    )
  }
  // Request-level failure with nothing to show: the reload must be the
  // prominent action on the catalog page, not a line in the top strip.
  // (The snapshot fallback always brings entries, so it never lands here.)
  if (loadError !== null || (entries.length === 0 && failedSources.length > 0)) {
    return (
      <div className="dshMkt-failBox" role="alert">
        <p className="dshMkt-failTitle">{t('mkt.catalog.failTitle')}</p>
        {loadError !== null ? <p className="dshMkt-failReason">{loadError}</p> : null}
        {failedSources.map(item => (
          <p key={item.url} className="dshMkt-failReason">{item.url} — {sourceReasonOf(item.reason, t)}</p>
        ))}
        <button type="button" className="dshMkt-button dshMkt-buttonPrimary" onClick={onRefresh}>{t('mkt.reload')}</button>
      </div>
    )
  }
  return (
    <>
      {cacheInfo?.snapshot === true ? (
        <div className="dshMkt-noticeOk" role="status">
          <div className="dshMkt-stripBody">
            <span className="dshMkt-stripText">{t('mkt.catalog.snapshot', { count: entries.length })}</span>
          </div>
          <div className="dshMkt-bannerActions">
            <button type="button" className="dshMkt-button" onClick={onRefresh}>{t('mkt.reload')}</button>
          </div>
        </div>
      ) : cacheInfo?.stale === true ? (
        <div className="dshMkt-banner" role="alert">
          {t('mkt.catalog.stale', { age: cacheAgeText(cacheInfo.cachedAt ?? Date.now(), t) })}
        </div>
      ) : cacheInfo?.cached === true ? (
        <div className="dshMkt-rowBetween">
          <span className="dshMkt-hint">
            {t('mkt.catalog.cached', { age: cacheAgeText(cacheInfo.cachedAt ?? Date.now(), t) })}
            {cacheInfo.cachedAt !== undefined && Date.now() - cacheInfo.cachedAt > CATALOG_CACHE_STALE_MS
              ? t('mkt.catalog.older')
              : ''}
          </span>
          <button type="button" className="dshMkt-button" onClick={onRefresh}>{t('mkt.reload')}</button>
        </div>
      ) : null}
      {failedSources.length > 0 && cacheInfo?.snapshot !== true ? (
        <div className="dshMkt-banner" role="alert">
          {t('mkt.catalog.sourcesFailed', { count: failedSources.length })}
          {failedSources.map(item => (
            <div key={item.url}>{item.url} — {sourceReasonOf(item.reason, t)}</div>
          ))}
          <div className="dshMkt-bannerActions">
            <button type="button" className="dshMkt-button" onClick={onRefresh}>{t('mkt.reload')}</button>
          </div>
        </div>
      ) : null}
      <div className="dshMkt-filters">
        <input
          className="dshMkt-input"
          type="search"
          placeholder={t('mkt.search.placeholder')}
          aria-label={t('mkt.search.aria')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="dshMkt-input dshMkt-select"
          aria-label={t('mkt.category.aria')}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">{t('mkt.category.all')}</option>
          {categories.map(option => (
            <option key={option.key} value={option.key}>{t('mkt.category.option', { label: option.label, count: option.count })}</option>
          ))}
        </select>
      </div>
      <div className="dshMkt-rowBetween">
        <span className="dshMkt-hint">
          {filtered.length === entries.length
            ? t('mkt.catalog.total', { count: entries.length })
            : t('mkt.catalog.filtered', { shown: filtered.length, total: entries.length })}
        </span>
        <button type="button" className="dshMkt-button" onClick={onRefresh}>{t('mkt.refresh')}</button>
      </div>
      {entries.length === 0 ? (
        <div className="dshMkt-empty">
          {t('mkt.catalog.empty')}
          <button type="button" className="dshMkt-button" onClick={onGoSources}>{t('mkt.catalog.goSources')}</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="dshMkt-empty">{t('mkt.catalog.noMatch')}</div>
      ) : filtered.slice(0, visible).map(entry => {
        const pkg = installedByName.get(normalizeNpmName(entry.package))
        const busy = busyPackage === entry.package
        const sourceOnly = entry.installable === false
        // Same-name verdict: the npm name alone never proves identity — the
        // normalized repo keys decide between "the same plugin", "a different
        // plugin sharing the name", and the local/git dev install the market
        // must not touch.
        const state = sameNameStateOf(entry, pkg)
        const localPkg = state.kind === 'local-git' ? pkg : undefined
        const localBadge = localPkg === undefined
          ? undefined
          : (localPkg.source === 'git' ? t('mkt.card.gitInstalled') : t('mkt.card.localInstalled'))
        const localTitle = localPkg === undefined
          ? undefined
          : (localPkg.source === 'git' ? t('mkt.card.gitTitle') : t('mkt.card.localTitle'))
        // Updates ride the same-origin path alone: a cross-origin or
        // local/git "update" would replace a different plugin's install.
        const updatable = state.kind === 'same-origin'
          && pkg !== undefined
          && pkg.updateAvailable === true
          && !pkg.suite
          && !sourceOnly
        // The desktop shell routes cross-origin window.open targets to the
        // system browser, so the title jumps straight to the entry's page.
        const openHomepage = (): void => { if (entry.homepage !== undefined) window.open(entry.homepage, '_blank', 'noopener') }
        return (
          <div key={entry.package} className="dshMkt-card">
            <div className="dshMkt-cardHead">
              {entry.homepage !== undefined ? (
                <button
                  type="button"
                  className="dshMkt-pkgName dshMkt-linkName"
                  title={t('mkt.card.homepage')}
                  onClick={openHomepage}
                >
                  {entry.name}
                </button>
              ) : (
                <span className="dshMkt-pkgName">{entry.name}</span>
              )}
              <span className="dshMkt-cardAction">
                {sourceOnly ? null : localPkg !== undefined ? (
                  <span className="dshMkt-badge dshMkt-badgeOn" title={localTitle}>{localBadge}</span>
                ) : state.kind === 'cross-origin' ? (
                  <span className="dshMkt-actionPair">
                    <span
                      className="dshMkt-badge dshMkt-badgeWarn"
                      title={t('mkt.card.crossOriginTitle')}
                    >
                      {t('mkt.card.crossOriginBadge')}
                    </span>
                    <button
                      type="button"
                      className="dshMkt-button dshMkt-buttonPrimary"
                      disabled={busyPackage !== null}
                      title={t('mkt.card.forceTitle')}
                      onClick={() => onInstall(entry, true)}
                    >
                      {busy ? <span className="dshMkt-spinner" aria-hidden="true" /> : null}
                      {busy ? t('mkt.install.busy') : t('mkt.install.action')}
                    </button>
                  </span>
                ) : pkg === undefined ? (
                  <button
                    type="button"
                    className="dshMkt-button dshMkt-buttonPrimary"
                    disabled={busyPackage !== null}
                    onClick={() => onInstall(entry, false)}
                  >
                    {busy ? <span className="dshMkt-spinner" aria-hidden="true" /> : null}
                    {busy ? t('mkt.install.busy') : t('mkt.install.action')}
                  </button>
                ) : updatable ? (
                  <button
                    type="button"
                    className="dshMkt-button dshMkt-buttonPrimary"
                    disabled={busyPackage !== null}
                    title={pkg.latest !== undefined
                      ? t('mkt.update.toLatest', { version: pkg.latest })
                      : t('mkt.update.toNpmLatest')}
                    onClick={() => onUpdate(pkg)}
                  >
                    {busy ? <span className="dshMkt-spinner" aria-hidden="true" /> : null}
                    {busy ? t('mkt.update.busy') : t('mkt.update.action')}
                  </button>
                ) : (
                  <span className="dshMkt-badge dshMkt-badgeOn">{t('mkt.installed.badge')}</span>
                )}
              </span>
            </div>
            <div className="dshMkt-cardByline">{cardByline(entry, t)}</div>
            <p className="dshMkt-desc">{entry.description === '' ? t('mkt.card.noDescription') : entry.description}</p>
            <div className="dshMkt-meta">{entry.package}</div>
            <div className="dshMkt-cardTags">
              {entry.category !== undefined ? <span className="dshMkt-badge">{entry.category}</span> : null}
              {sourceOnly ? (
                <span
                  className="dshMkt-badge dshMkt-badgeOff"
                  title={entry.homepage !== undefined
                    ? t('mkt.card.sourceOnlyHome', { homepage: entry.homepage })
                    : t('mkt.card.sourceOnlyNoHome')}
                >
                  {t('mkt.card.sourceOnly')}
                </span>
              ) : null}
              {entry.version !== undefined ? (
                <span className="dshMkt-badge" title={t('mkt.card.versionTitle')}>v{entry.version}</span>
              ) : null}
              {state.kind === 'local-git' && state.sameRepo ? (
                <span className="dshMkt-badge" title={t('mkt.card.sameRepoTitle')}>{t('mkt.card.sameRepo')}</span>
              ) : null}
            </div>
          </div>
        )
      })
      }
      {filtered.length > visible ? (
        <button type="button" className="dshMkt-button" onClick={() => setVisible(count => count + CATALOG_PAGE_SIZE)}>
          {t('mkt.catalog.showMore', { count: filtered.length - visible })}
        </button>
      ) : null}
    </>
  )
}

interface InstalledTabProps {
  loading: boolean
  /** True while the follow-up registry probe runs; the list is already visible. */
  checkingUpdates: boolean
  packages: readonly InstalledPackage[]
  busyPackage: string | null
  togglingPackage: string | null
  /** Packages the previous profile declares and this one lacks, or null. */
  legacy: LegacyValue | null
  /** Progress of a running inherit batch (null when idle). */
  legacyBusy: { readonly done: number, readonly total: number, readonly name: string } | null
  /** Session-local dismissal of the inherit row. */
  legacyHidden: boolean
  onRefresh: () => void
  onToggle: (pkg: InstalledPackage) => void
  onUninstall: (pkg: InstalledPackage) => void
  onUpdate: (pkg: InstalledPackage) => void
  onInherit: () => void
  onDismissLegacy: () => void
  t: Translate
}

function InstalledTab({
  loading, checkingUpdates, packages, busyPackage, togglingPackage,
  legacy, legacyBusy, legacyHidden, onRefresh, onToggle, onUninstall, onUpdate, onInherit, onDismissLegacy, t,
}: InstalledTabProps): ReactNode {
  if (loading) {
    return (
      <div className="dshMkt-empty">
        <span className="dshMkt-spinner" aria-hidden="true" /> {t('mkt.installed.loading')}
      </div>
    )
  }
  // One mutation at a time across the panel: the installer queue serializes
  // server-side, these flags keep the UI honest about it.
  const actionsBusy = busyPackage !== null || togglingPackage !== null
  const inheritable = legacy !== null && !legacyHidden && legacy.missing.length > 0
  return (
    <>
      <div className="dshMkt-rowBetween">
        <span className="dshMkt-hint">
          {t('mkt.installed.hint')}
          {checkingUpdates ? t('mkt.installed.checking') : ''}
        </span>
        <button type="button" className="dshMkt-button" disabled={actionsBusy} onClick={onRefresh}>{t('mkt.refresh')}</button>
      </div>
      {/* The suite boots its own profile now; whatever the previous one
          declared and this one lacks is offered here, one click for all of
          it. Specs install verbatim, so local/git/https dependencies work
          like registry ranges. */}
      {inheritable ? (
        <div className="dshMkt-inherit">
          <span className="dshMkt-inheritText">
            {legacyBusy === null
              ? t('mkt.inherit.title', { profile: legacy.profile, count: String(legacy.missing.length) })
              : t('mkt.inherit.busy', {
                  name: legacyBusy.name,
                  done: String(legacyBusy.done + 1),
                  total: String(legacyBusy.total),
                })}
            <span className="dshMkt-hint">{t('mkt.inherit.hint')}</span>
          </span>
          <button
            type="button"
            className="dshMkt-buttonPrimary"
            disabled={legacyBusy !== null || actionsBusy}
            onClick={onInherit}
          >
            {t('mkt.inherit.action', { count: String(legacy.missing.length) })}
          </button>
          <button type="button" className="dshMkt-button" disabled={legacyBusy !== null} onClick={onDismissLegacy}>
            {t('mkt.inherit.dismiss')}
          </button>
        </div>
      ) : null}
      {packages.length === 0 ? (
        <div className="dshMkt-empty">{t('mkt.installed.empty')}</div>
      ) : packages.map(pkg => {
        const busy = busyPackage === pkg.name
        const toggling = togglingPackage === pkg.name
        // Local/git installs are user-managed development copies: the badge in
        // the update slot explains why no update is offered, while toggle and
        // uninstall stay fully usable.
        const local = pkg.source !== 'registry'
        const updatable = pkg.updateAvailable === true && !pkg.suite && !local
        return (
          <div key={pkg.name} className="dshMkt-card">
            <div className="dshMkt-cardHead">
              <span className="dshMkt-pkgName">{pkg.name}</span>
              <span className="dshMkt-badge" title={t('mkt.installed.declared', { version: pkg.version })}>
                {pkg.installedVersion ?? pkg.version}
              </span>
              {updatable && pkg.latest !== undefined && pkg.installedVersion !== undefined ? (
                <span
                  className="dshMkt-badge dshMkt-badgeUpdate"
                  title={t('mkt.installed.updateTitle')}
                >
                  {t('mkt.installed.updateBadge', { from: pkg.installedVersion, to: pkg.latest })}
                </span>
              ) : local ? (
                <span
                  className="dshMkt-badge dshMkt-badgeOn"
                  title={pkg.source === 'git' ? t('mkt.installed.gitTitle') : t('mkt.installed.localTitle')}
                >
                  {pkg.source === 'git' ? t('mkt.installed.git') : t('mkt.installed.local')}
                </span>
              ) : null}
              <span className={pkg.bundled ? 'dshMkt-badge dshMkt-badgeOn' : 'dshMkt-badge dshMkt-badgeOff'}>
                {pkg.bundled ? t('mkt.installed.mounted') : t('mkt.installed.unmounted')}
              </span>
              {pkg.suite ? <span className="dshMkt-badge">{t('mkt.installed.suite')}</span> : null}
            </div>
            <div className="dshMkt-cardFoot">
              <button
                type="button"
                role="switch"
                aria-checked={pkg.enabled}
                className={pkg.enabled ? 'dshMkt-switch dshMkt-switchOn' : 'dshMkt-switch'}
                disabled={pkg.suite || actionsBusy}
                title={pkg.suite
                  ? t('mkt.installed.suiteTitle')
                  : (pkg.enabled ? t('mkt.toggle.disableTitle') : t('mkt.toggle.enableTitle'))}
                onClick={() => onToggle(pkg)}
              >
                {toggling ? <span className="dshMkt-spinner" aria-hidden="true" /> : (
                  <span className="dshMkt-switchTrack" aria-hidden="true"><span className="dshMkt-switchThumb" /></span>
                )}
                {pkg.enabled ? t('mkt.installed.enabled') : t('mkt.installed.disabled')}
              </button>
              {updatable ? (
                <button
                  type="button"
                  className="dshMkt-button dshMkt-buttonPrimary"
                  disabled={actionsBusy}
                  title={pkg.latest !== undefined
                    ? t('mkt.update.toLatest', { version: pkg.latest })
                    : t('mkt.update.toNpmLatest')}
                  onClick={() => onUpdate(pkg)}
                >
                  {busy ? <span className="dshMkt-spinner" aria-hidden="true" /> : null}
                  {busy ? t('mkt.update.busy') : t('mkt.update.action')}
                </button>
              ) : null}
              <button
                type="button"
                className="dshMkt-button dshMkt-buttonDanger"
                disabled={actionsBusy}
                onClick={() => onUninstall(pkg)}
              >
                {busy ? <span className="dshMkt-spinner" aria-hidden="true" /> : null}
                {busy ? t('mkt.uninstall.busy') : t('mkt.uninstall.action')}
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}

interface SourcesTabProps {
  loading: boolean
  sources: readonly string[]
  saving: boolean
  input: string
  onInput: (value: string) => void
  onAdd: () => void
  onRemove: (url: string) => void
  onRefresh: () => void
  t: Translate
}

function SourcesTab({ loading, sources, saving, input, onInput, onAdd, onRemove, onRefresh, t }: SourcesTabProps): ReactNode {
  if (loading) {
    return (
      <div className="dshMkt-empty">
        <span className="dshMkt-spinner" aria-hidden="true" /> {t('mkt.sources.loading')}
      </div>
    )
  }
  return (
    <>
      <p className="dshMkt-hint">
        {t('mkt.sources.intro')}
      </p>
      <div className="dshMkt-row">
        <input
          className="dshMkt-input"
          type="url"
          placeholder="https://example.com/plugins.json"
          value={input}
          aria-label={t('mkt.sources.aria')}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onAdd() }}
        />
        <button type="button" className="dshMkt-button dshMkt-buttonPrimary" disabled={saving || input.trim() === ''} onClick={onAdd}>
          {t('mkt.sources.add')}
        </button>
      </div>
      {sources.length === 0 ? (
        <div className="dshMkt-empty">{t('mkt.sources.empty')}</div>
      ) : sources.map(url => (
        <div key={url} className="dshMkt-card">
          <div className="dshMkt-rowBetween">
            <span className="dshMkt-sourceUrl">{url}</span>
            <button type="button" className="dshMkt-button dshMkt-buttonDanger" disabled={saving} onClick={() => onRemove(url)}>
              {t('mkt.sources.remove')}
            </button>
          </div>
          {url.includes(PAGED_SOURCE_HOST) ? (
            <p className="dshMkt-hint">{t('mkt.sources.paged')}</p>
          ) : null}
        </div>
      ))}
      <div className="dshMkt-rowBetween">
        <span className="dshMkt-hint">{t('mkt.sources.hint')}</span>
        <button type="button" className="dshMkt-button" onClick={onRefresh}>{t('mkt.refresh')}</button>
      </div>
    </>
  )
}
