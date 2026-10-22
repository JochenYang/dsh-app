/**
 * The embedded Platform view: the kernel's own usage / top-up page, opened inside
 * the app window and signed in.
 *
 * Why this exists at all: the account surface the kernel ships presents balance
 * and profile over its `account` remote, but the pages that show a user's usage
 * and let them add credit are DeepSeek Platform documents, not kernel pages. The
 * kernel therefore hands the shell a private credential snapshot over its IPC
 * channel (`PlatformSession`, published by `installPlatformSessionPublisher` in
 * the runtime's desktop host) and upstream's shell opens a `WebContentsView` onto
 * `/usage` or `/top_up` with that credential injected into the request headers.
 * This module is that view, rebuilt for this shell's window shape.
 *
 * The security model is upstream's, and none of it is optional:
 *
 * - the view lives in its OWN non-persistent partition (`dsh-platform-<uuid>`),
 *   so Platform cookies cannot reach the app session and cannot outlive the view;
 * - EVERY permission request is refused, and downloads are off;
 * - the credential is injected as a request header ONLY for the session's origin,
 *   and any request that was injected is stripped again after a redirect, so
 *   nothing carries the token to another host;
 * - navigation outside that origin is prevented, subframes are refused, and
 *   `window.open` goes to the system browser WITHOUT the session;
 * - the renderer never sees the token: the view's own preload receives it through
 *   a synchronous bootstrap channel and keeps it in a closure.
 *
 * The document is closed on every way the owning window can stop being able to
 * host it — navigation, a dead renderer, a closed window — because the credential
 * snapshot and the partition must be discarded together.
 *
 * @module dsh-app/main/platform-view
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { BrowserWindow, WebContentsView, ipcMain, nativeTheme, session, shell, type Session, type WebContents, type WebFrameMain } from 'electron'
import type { PlatformSession } from './desktop-host'

/** Private channels of the Platform bridge (upstream's names, kept verbatim). */
export const PLATFORM_IPC = {
  bootstrap: 'dsh-platform:bootstrap',
  localeChanged: 'dsh-platform:locale-changed',
  open: 'dsh-platform:open',
  bounds: 'dsh-platform:bounds',
  close: 'dsh-platform:close',
} as const

/** Resolved Platform language; the kernel's embed expects this pair. */
export type PlatformLocale = 'en_US' | 'zh_CN'

/** Bounds in the app window's content coordinates (CSS pixels). */
export interface PlatformBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The pages the account surface may embed. Anything else is refused by name. */
const PLATFORM_PAGES = {
  usage: '/usage',
  'top-up': '/top_up',
} as const

export type PlatformPage = keyof typeof PLATFORM_PAGES

/**
 * Decode a renderer-supplied rectangle.
 *
 * The rectangle arrives from the page, so it is validated rather than trusted: a
 * NaN or a negative or absurd value would put a native view somewhere unknown.
 * Non-integers are rounded because `setBounds` requires integers.
 *
 * @param value - the payload from the renderer.
 * @returns finite, rounded, nonnegative bounds.
 * @throws when a field is missing or out of range.
 */
export function platformBounds(value: unknown): PlatformBounds {
  if (typeof value !== 'object' || value === null) throw new Error('platform bounds: not an object')
  const record = value as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const raw = record[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100_000) {
      throw new Error(`platform bounds: ${key} is not a usable number`)
    }
    result[key] = Math.round(raw)
  }
  return result as unknown as PlatformBounds
}

/**
 * Which page a renderer may ask for.
 *
 * A whitelist rather than a URL: the renderer supplies a NAME, and the URL is
 * built here against the session's own origin, so a page cannot steer the view
 * anywhere else.
 *
 * @param value - the payload from the renderer.
 * @returns the page name.
 * @throws when the name is not one of the supported pages.
 */
export function platformPage(value: unknown): PlatformPage {
  if (typeof value === 'string' && Object.hasOwn(PLATFORM_PAGES, value)) return value as PlatformPage
  throw new Error('platform page: unsupported page')
}

/**
 * Merge two Cookie headers, one pair per name, the later value winning.
 *
 * Duplicated from the kernel's `mergePlatformCookies` rather than imported: that
 * module lives in the runtime's dependency tree, which this shell does not link
 * against. The rule is small and its contract is written down here: pairs without
 * an `=` are dropped, and the deployment's own cookies take precedence.
 *
 * @param base - the session's existing cookies.
 * @param override - deployment cookies whose values win.
 * @returns one Cookie header.
 */
export function mergePlatformCookies(base: string, override: string): string {
  const cookies = new Map<string, string>()
  for (const header of [base, override]) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * The identity a Platform request carries, sampled for ONE call.
 *
 * `timezoneOffsetSeconds` is seconds EAST of UTC (Platform's unit), which is the
 * negation of `Date.prototype.getTimezoneOffset`'s minutes-west.
 */
export interface PlatformClientMetadata {
  readonly version: string
  readonly locale: string
  readonly timezoneOffsetSeconds: number
}

/**
 * Sample the client identity for one Platform request.
 *
 * The offset and language are read at call time on purpose: a request issued
 * after a language change or a DST shift must report what is true then, not what
 * was true when the view opened.
 *
 * @param version - this shell build's version.
 * @param locale - the app's resolved language, at call time.
 * @returns this call's metadata.
 */
export function platformClientMetadata(version: string, locale: PlatformLocale): PlatformClientMetadata {
  return { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
}

/**
 * The client-identity headers a Platform request must carry.
 *
 * Duplicated from the kernel's `platformClientHeaders` for the same reason as
 * {@link mergePlatformCookies}, and kept field-for-field: Platform reads these to
 * tell a desktop client from a web one and to pick the right date bucketing. The
 * bundle id is intentionally empty (upstream's own note), and `x-client-platform`
 * stays `web` unless the account provider was told which desktop OS this is —
 * `desktop-win` / `desktop-mac` are that narrower claim, not a rename of it.
 *
 * @param platform - `darwin` / `win32` when the provider identified the desktop
 *   client, null otherwise.
 * @param client - the metadata sampled for this request.
 * @returns the five identity headers.
 */
export function platformClientHeaders(
  platform: 'darwin' | 'win32' | null,
  client: PlatformClientMetadata,
): Record<string, string> {
  const desktop = platform === null ? {} : { 'x-client-platform': platform === 'win32' ? 'desktop-win' : 'desktop-mac' }
  return {
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    ...desktop,
    'x-client-version': client.version,
    'x-client-locale': client.locale,
    'x-client-timezone-offset': String(client.timezoneOffsetSeconds),
  }
}

/**
 * The partition a view runs in: account-scoped and PERSISTENT once the account ID
 * is known, disposable until then.
 *
 * Page preferences (the "知道了" banner, the timezone choice, the date range) are
 * Platform-side storage, so a throwaway partition resets them on every open. The
 * key is `[origin, userId]` hashed: the same account on the same issuer finds its
 * own storage, and two accounts never share one. With no ID there is nothing
 * stable to key on — the kernel reports null until a profile read succeeds — so
 * the view gets a fresh non-persistent partition instead of a shared guess.
 *
 * @param origin - the session's Platform origin.
 * @param userId - the session's account ID, or null.
 * @returns an Electron partition name.
 */
export function platformPartition(origin: string, userId: string | null): string {
  if (userId === null) return `dsh-platform-${randomUUID()}`
  const digest = createHash('sha256').update(JSON.stringify([origin, userId])).digest('hex')
  return `persist:dsh-platform-${digest}`
}

/**
 * One embedded Platform view, owned by the main window.
 *
 * An instance is reusable: `open` replaces whatever was open (the account may have
 * changed, or the user may switch between usage and top-up), and `close` is safe to
 * call at any time.
 */
export class PlatformView {
  private account: PlatformSession | null = null
  private view: WebContentsView | undefined
  private owner: BrowserWindow | undefined
  private releaseOwner: (() => void) | undefined
  private generation = 0
  /** Appearance this view displaced while open (`nativeTheme` is process-wide). */
  private previousThemeSource: Electron.NativeTheme['themeSource'] | undefined
  /**
   * Storage cleanups, keyed by the session they belong to.
   *
   * Cleanup is asynchronous and a partition can be opened again before the
   * previous cleanup finished, so each new cleanup AWAITS the one before it for
   * the same session. Without that ordering a late `clearStorageData` would wipe
   * the preferences a freshly opened view had just written.
   */
  private readonly storageCleanup = new Map<Session, Promise<{ error: unknown } | null>>()
  /** Sessions that already carry the download refusal (see `open`). */
  private readonly downloadGuards = new WeakSet<Session>()
  private disposed = false

  /**
   * @param preload - absolute path of the built Platform preload.
   * @param getLocale - the app's resolved language, at call time.
   * @param getTheme - the app's resolved appearance, at call time.
   * @param version - this shell build's version, reported to Platform as the client version.
   * @param platform - the OS this shell runs on, or null where Platform must not
   *   be told it is a desktop client (see {@link platformClientHeaders}).
   */
  constructor(
    private readonly preload: string,
    private readonly getLocale: () => PlatformLocale,
    private readonly getTheme: () => 'light' | 'dark',
    private readonly version: string,
    private readonly platform: 'darwin' | 'win32' | null,
  ) {}

  /** This call's client metadata, sampled now rather than at open time. */
  private clientMetadata(): PlatformClientMetadata {
    return platformClientMetadata(this.version, this.getLocale())
  }

  /** The identity headers for this call. */
  private clientHeaders(): Record<string, string> {
    return platformClientHeaders(this.platform, this.clientMetadata())
  }

  /**
   * Carry the app's appearance into the embedded page, remembering what the
   * process had before.
   *
   * Measured against the real Platform origin from a `WebContentsView`: the page
   * follows `prefers-color-scheme` and IGNORES a `?theme=` parameter — with
   * `?theme=light` under a dark OS preference it still painted `rgb(21,21,23)`,
   * and with `?theme=dark` under a light one it stayed white. (`?theme=` is the
   * LOGIN page's lever; upstream's `authorizeUrlWithTheme` is right about that and
   * does not cover these pages.) So the only lever is `nativeTheme.themeSource`.
   *
   * That lever is PROCESS-wide, which is why it is saved and restored rather than
   * set for good: while the view is open the whole process reports the app's
   * appearance, and closing it puts back whatever Electron had — so every other
   * window and native control keeps following the OS as before.
   */
  private applyTheme(): void {
    this.previousThemeSource = nativeTheme.themeSource
    nativeTheme.themeSource = this.getTheme()
  }

  /** Put back the process appearance this view displaced (see {@link applyTheme}). */
  private restoreTheme(): void {
    if (this.previousThemeSource === undefined) return
    nativeTheme.themeSource = this.previousThemeSource
    this.previousThemeSource = undefined
  }

  /**
   * Replace the credential snapshot.
   *
   * An unchanged snapshot is ignored so a re-publish from the kernel does not
   * tear down a page the user is looking at. Two things still adopt it:
   *
   * - the account ID becoming known (`null` → an ID) is identity ENRICHMENT, not
   *   an account change, so the page stays and the storage key upgrades on the
   *   next open rather than dropping what is on screen;
   * - deployment headers can be republished without the credential changing, and
   *   the next request must use the newest ones.
   *
   * Anything else closes the view: a document prepared with the previous account
   * must not outlive it.
   *
   * @param next - the snapshot, or null when signed out.
   */
  setSession(next: PlatformSession | null): void {
    // After `dispose()` the credential is gone for good: adopting a new snapshot
    // would let a spent instance open a signed-in page again.
    if (this.disposed) return
    const current = this.account
    if (next?.token === current?.token && next?.origin === current?.origin
      && next?.embeddedPageDist === current?.embeddedPageDist
      && JSON.stringify(next?.requestHeaders) === JSON.stringify(current?.requestHeaders)) {
      // Same credential, same deployment: adopt the snapshot and keep the page.
      if (next?.userId === current?.userId || current?.userId === null) {
        this.account = next
        return
      }
    }
    this.close()
    this.account = next
  }

  /** Whether a signed-in snapshot is available (the account section's gate). */
  get available(): boolean {
    return this.account !== null
  }

  /**
   * Open `page` over the owning window, signed in.
   *
   * @param owner - the window the view belongs to.
   * @param page - which Platform page.
   * @param bounds - the rectangle to occupy, in content coordinates.
   * @returns when the document has loaded (or aborted its own first navigation).
   * @throws when there is no session, or the load failed for any other reason.
   */
  async open(owner: BrowserWindow, page: PlatformPage, bounds: PlatformBounds): Promise<void> {
    // A disposed instance has already dropped its credential and its storage: it
    // must not be resurrected by whoever still holds a reference.
    if (this.disposed) throw new Error('platform view: disposed')
    this.close()
    const account = this.account
    if (account === null) throw new Error('platform view: no account session')
    const generation = this.generation
    // Before the document loads: the page resolves its palette from
    // `prefers-color-scheme` at paint time, so the appearance must be in place
    // when it does (see applyTheme).
    this.applyTheme()

    // Account-scoped storage, persistent once the account ID is known (see
    // platformPartition): the page's own preferences survive reopening. Platform
    // cookies still never reach the app session, which is a different partition.
    const browserSession = session.fromPartition(platformPartition(account.origin, account.userId))
    // A persisted partition can carry authentication left by an UNCLEAN previous
    // exit, so it is sanitized before any page loads in it. When an earlier
    // cleanup for the same session is still running this one waits for it.
    const failure = await this.cleanStorage(browserSession)
    if (generation !== this.generation) return
    if (failure !== null) {
      this.close()
      throw failure.error
    }
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    const injected = new Set<number>()
    const deploymentHeaders = account.requestHeaders ?? {}
    // Every name this view injects, so a redirect can strip exactly those and
    // leave the page's own headers alone.
    const injectedNames = new Set(
      [...Object.keys(deploymentHeaders), ...Object.keys(this.clientHeaders())].map((name) => name.toLowerCase()),
    )
    browserSession.webRequest.onCompleted((details) => { injected.delete(details.id) })
    browserSession.webRequest.onErrorOccurred((details) => { injected.delete(details.id) })
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      let headers = Object.fromEntries(
        Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      )
      if (new URL(details.url).origin === account.origin) {
        injected.add(details.id)
        // The DEPLOYMENT's headers and this client's identity, never the user's
        // token: the token reaches the page through the preload's bootstrap
        // channel, which is why a redirect cannot carry it anywhere (upstream's
        // rule, kept verbatim). The identity is sampled per request because the
        // language and UTC offset can change while the view is open.
        const identity = { ...deploymentHeaders, ...this.clientHeaders() }
        headers = { ...headers, ...identity }
        if (identity.cookie !== undefined) {
          headers.cookie = mergePlatformCookies(headers.cookie ?? '', identity.cookie)
        }
      } else if (injected.has(details.id)) {
        // A redirected subresource must not carry injected headers to another host.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => !injectedNames.has(name.toLowerCase())),
        )
      }
      callback({ requestHeaders: headers })
    })

    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        additionalArguments: [`--dsh-platform-origin=${account.origin}`],
      },
    })
    this.view = view
    this.owner = owner

    // The document outlives this module's own bookkeeping in several ways, and the
    // credential must not: every one of them closes the view. The owner's own
    // navigation only counts when it replaces the DOCUMENT — the app is a
    // single-page document that pushes history entries while the view is open, and
    // an in-place navigation must not tear the embedded page down. Read from the
    // event's `details` object rather than the deprecated positional arguments: if
    // those go away, `isMainFrame` becomes undefined and the view would silently
    // never close.
    const closeIfCurrent = (): void => { if (this.view === view) this.close() }
    const onOwnerNavigation = (details: Electron.WebContentsDidStartNavigationEventParams): void => {
      if (details.isMainFrame && !details.isSameDocument) closeIfCurrent()
    }
    owner.webContents.on('did-start-navigation', onOwnerNavigation)
    owner.webContents.on('render-process-gone', closeIfCurrent)
    owner.webContents.on('destroyed', closeIfCurrent)
    owner.on('closed', closeIfCurrent)
    this.releaseOwner = () => {
      if (owner.isDestroyed()) return
      owner.webContents.removeListener('did-start-navigation', onOwnerNavigation)
      owner.webContents.removeListener('render-process-gone', closeIfCurrent)
      owner.webContents.removeListener('destroyed', closeIfCurrent)
      owner.removeListener('closed', closeIfCurrent)
    }

    // Payment and documentation leave the app: open in the SYSTEM browser, never
    // here, so the embedded session's credential is not involved.
    view.webContents.setWindowOpenHandler(({ url }) => {
      let destination: URL
      try {
        destination = new URL(url)
      } catch {
        return { action: 'deny' }
      }
      if (destination.protocol === 'https:' && destination.username === '' && destination.password === '') {
        void shell.openExternal(url).catch(() => {
          // A launch failure leaves the embedded page in place to retry.
        })
      }
      return { action: 'deny' }
    })
    const allowed = (url: string): boolean => {
      try {
        const parsed = new URL(url)
        return parsed.origin === account.origin && parsed.username === '' && parsed.password === ''
      } catch {
        return false
      }
    }
    view.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault() })
    view.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault() })
    view.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
    view.webContents.on('preload-error', closeIfCurrent)
    view.webContents.on('render-process-gone', closeIfCurrent)

    // A permission that slips past the session handlers is still refused, and a
    // download from an embedded billing page must not silently land on disk.
    //
    // Registered ONCE per session: a persisted partition is reused across opens,
    // and a listener added per open would accumulate on the Session forever.
    // `close()` deliberately leaves it in place for that reason.
    if (!this.downloadGuards.has(browserSession)) {
      this.downloadGuards.add(browserSession)
      browserSession.on('will-download', (event) => { event.preventDefault() })
    }

    view.setVisible(false)
    owner.contentView.addChildView(view)
    view.setBounds(bounds)
    try {
      const target = new URL(PLATFORM_PAGES[page], account.origin)
      if (account.embeddedPageDist !== undefined) target.searchParams.set('dist', account.embeddedPageDist)
      await view.webContents.loadURL(target.href)
    } catch (error) {
      // Platform documents may replace their own URL before the first load
      // settles, which reports ERR_ABORTED rather than a failed document.
      const aborted = error instanceof Error && (error as { code?: unknown }).code === 'ERR_ABORTED'
      if (!aborted) {
        if (generation === this.generation) this.close()
        throw error
      }
    }
    if (generation === this.generation && this.view === view) view.setVisible(true)
  }

  /** @param bounds - the current viewport rectangle. */
  setBounds(bounds: PlatformBounds): void {
    this.view?.setBounds(bounds)
  }

  /**
   * Credentials and language for the view's own preload, and for nobody else.
   *
   * Called synchronously from the preload's bootstrap channel, so the checks are
   * the whole guard: the sender must be THIS view's MAIN FRAME, on the session's
   * origin. A subframe, another webContents, or a stale frame gets nothing.
   *
   * The main-frame half is checked on the frame object, not inferred from the
   * URL: a subframe on the same origin would otherwise pass the origin test and
   * receive the account credential.
   *
   * @param sender - the webContents that asked.
   * @param frame - that event's sender frame.
   * @returns the origin, token and locale to hand the preload.
   * @throws when the caller is not the current Platform main frame.
   */
  bootstrap(
    sender: WebContents,
    frame: Pick<WebFrameMain, 'url'> | null,
  ): { origin: string, token: string, locale: PlatformLocale } {
    const view = this.view
    const account = this.account
    if (view === undefined || account === null || sender !== view.webContents || frame === null) {
      throw new Error('platform view: rejected bootstrap')
    }
    if (frame !== view.webContents.mainFrame) throw new Error('platform view: rejected bootstrap frame')
    if (new URL(frame.url).origin !== account.origin) throw new Error('platform view: rejected bootstrap origin')
    return { origin: account.origin, token: account.token, locale: this.getLocale() }
  }

  /** Tell the open document that the app's language changed. */
  notifyLocaleChanged(): void {
    const view = this.view
    if (view !== undefined && !view.webContents.isDestroyed()) {
      view.webContents.send(PLATFORM_IPC.localeChanged, this.getLocale())
    }
  }

  /**
   * Destroy the document, release its owner listeners, and discard its storage.
   *
   * The partition is account-scoped and can be PERSISTENT (see
   * {@link platformPartition}), so clearing is what guarantees the credential
   * cannot be replayed by a later view — whether that is the same account
   * reopening the page or a process that died mid-session. Because cleanup is
   * asynchronous, a view opened on the same partition again waits for it.
   */
  close(): void {
    this.generation += 1
    const view = this.view
    this.view = undefined
    this.releaseOwner?.()
    this.releaseOwner = undefined
    // Restore the process appearance first: every return below has to put it
    // back, and several of them return without a view to tear down.
    this.restoreTheme()
    if (view === undefined) return
    const owner = this.owner
    this.owner = undefined
    try {
      if (owner !== undefined && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    } catch {
      // The window is already gone; there is nothing to detach from.
    }
    const browserSession = view.webContents.session
    // The listeners belong to this document, not to the partition: the next view
    // installs its own, and a stale handler would inject into a document it was
    // never given an account for.
    browserSession.webRequest.onBeforeSendHeaders(null)
    browserSession.webRequest.onCompleted(null)
    browserSession.webRequest.onErrorOccurred(null)
    browserSession.flushStorageData()
    // Resolve after the document is really gone, so the cleanup cannot race the
    // close that produced it.
    const destroyed = new Promise<void>((resolve) => {
      if (view.webContents.isDestroyed()) {
        resolve()
        return
      }
      view.webContents.once('destroyed', () => { resolve() })
      view.webContents.close({ waitForBeforeUnload: false })
    })
    void this.cleanStorage(browserSession, destroyed)
  }

  /**
   * Stop accepting documents and wait for every scheduled cleanup.
   *
   * Used on the way out of the process (any quit, and both update install paths),
   * so nothing of the old account is left on disk for the next process to find.
   * After this the instance is spent: a later `open` or `setSession` is a bug in
   * the caller, not something to absorb silently.
   *
   * @throws {AggregateError} when any cleanup failed.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.account = null
    await this.closeAndWait()
  }

  /** Close the view and await its cleanup; see {@link dispose}. */
  async closeAndWait(): Promise<void> {
    this.close()
    const results = await Promise.all([...this.storageCleanup.values()])
    const failures = results.filter((result) => result !== null)
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.error), 'platform storage cleanup failed')
    }
  }

  /**
   * Clear one partition's authentication and caches, after whatever cleanup the
   * same partition already has pending.
   *
   * Every clear runs, and the first failure is reported rather than swallowed:
   * a partition that kept its cookies would leave the credential replayable by a
   * later view, which is the one thing this method exists to prevent.
   *
   * A PERSISTED partition keeps its local storage (that is what makes the page's
   * preferences survive reopening) and loses everything that authenticates. A
   * throwaway partition has no preferences worth keeping, so it is cleared whole.
   *
   * @param browserSession - the view's partition.
   * @param destroyed - resolves once the document using it is gone.
   * @returns null on success, or the failure.
   */
  private cleanStorage(
    browserSession: Session,
    destroyed: Promise<void> = Promise.resolve(),
  ): Promise<{ error: unknown } | null> {
    const previous = this.storageCleanup.get(browserSession)
    const cleanup = Promise.all([previous, destroyed]).then(async () => {
      await browserSession.closeAllConnections()
      const results = await Promise.allSettled([
        // The storage set is named only for a persisted partition: there it keeps
        // local storage while losing cookies and caches. Omitted, Electron clears
        // everything, which is what a throwaway partition wants.
        browserSession.clearStorageData(browserSession.isPersistent()
          ? { storages: ['cookies', 'filesystem', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] }
          : undefined),
        browserSession.clearCache(),
        browserSession.clearAuthCache(),
      ])
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(failures.map((failure): unknown => failure.reason), 'platform storage cleanup failed')
      }
    }).then(
      (): null => null,
      (error: unknown) => ({ error }),
    )
    this.storageCleanup.set(browserSession, cleanup)
    // The registry exists to ORDER cleanups, not to keep them: a settled entry
    // that is still the current one has nothing to wait for.
    void cleanup.then(() => {
      if (this.storageCleanup.get(browserSession) === cleanup) this.storageCleanup.delete(browserSession)
    })
    return cleanup
  }
}

/** Absolute path of the built Platform preload (beside this module in `dist/main`). */
export function platformPreloadPath(): string {
  return path.join(__dirname, 'platform-preload.js')
}

/** The app document's scheme and host. A custom scheme has NO origin (measured:
 * `new URL('dsh-app://app/index.html').origin` is the string `"null"`), so these
 * two fields are the whole identity of "this is the app's own document". */
export const APP_SCHEME = 'dsh-app:'
export const APP_HOSTNAME = 'app'

/**
 * Whether a frame URL belongs to the app document.
 *
 * Compared by SCHEME and HOST, never by origin: `url.origin` is the string
 * `"null"` for a non-special scheme, so an origin comparison rejects the app's
 * own frames — which is exactly what shipped for one round (every Platform IPC
 * answered `rejected sender`, and the embedded page, having loaded, failed its
 * first request with "操作未完成"). Upstream's own `assertDesktopSender` compares
 * the same two fields for the same reason.
 *
 * A `file:` splash document, a subframe, or anything on another scheme answers
 * false; the caller separately checks that the frame belongs to the window this
 * shell owns.
 *
 * @param frameUrl - the sender frame's URL, as Electron reports it.
 * @returns true when the frame is the app document's own.
 */
export function isAppFrame(frameUrl: string | undefined): boolean {
  if (frameUrl === undefined || frameUrl === '') return false
  try {
    const parsed = new URL(frameUrl)
    return parsed.protocol === APP_SCHEME && parsed.hostname === APP_HOSTNAME
  } catch {
    return false
  }
}

/**
 * The main window's IPC surface for the embedded Platform view.
 *
 * Only three operations, and every one of them is reachable ONLY from the app
 * document's own top frame: the sender must be the window this shell owns, its
 * main frame, on the app origin. That is the same double check upstream makes
 * (`assertProductSender`), and it is what keeps a subframe, another window, or a
 * page that navigated away from opening native views or asking for credentials.
 *
 * The bootstrap channel is SYNCHRONOUS (`sendSync` → `returnValue`) because the
 * view's preload has to have the credential before the page's own scripts run;
 * it is answered by {@link PlatformView.bootstrap}, which repeats the sender check
 * against the view itself.
 *
 * @param deps - the owner window, the current view, and the app's language.
 * @returns the disposer that removes every handler.
 */
export function installPlatformIpc(deps: {
  owner: () => WebContents | undefined
  view: () => PlatformView | undefined
  locale: () => PlatformLocale
  log: (line: string) => void
}): () => void {
  /** Whether `sender`'s frame is the app document's top frame in the owner window. */
  const owned = (sender: WebContents, frameUrl: string | undefined): boolean => {
    const owner = deps.owner()
    return owner !== undefined && sender === owner && isAppFrame(frameUrl)
  }
  const frameOf = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string | undefined =>
    event.senderFrame?.url ?? undefined

  ipcMain.handle(PLATFORM_IPC.open, async (event, page: unknown, bounds: unknown): Promise<void> => {
    if (!owned(event.sender, frameOf(event))) throw new Error('platform open: rejected sender')
    const view = deps.view()
    if (view === undefined) throw new Error('platform open: no account surface')
    const win = deps.owner()
    if (win === undefined) throw new Error('platform open: no window')
    // Validate BEFORE the view exists: a bad rectangle or an unknown page name
    // must fail without leaving a native view attached to nothing.
    const rect = platformBounds(bounds)
    const name = platformPage(page)
    const owner = BrowserWindow.fromWebContents(win)
    if (owner === null) throw new Error('platform open: no owning window')
    await view.open(owner, name, rect)
  })

  ipcMain.handle(PLATFORM_IPC.bounds, (event, bounds: unknown): void => {
    if (!owned(event.sender, frameOf(event))) throw new Error('platform bounds: rejected sender')
    deps.view()?.setBounds(platformBounds(bounds))
  })

  ipcMain.handle(PLATFORM_IPC.close, (event): void => {
    if (!owned(event.sender, frameOf(event))) throw new Error('platform close: rejected sender')
    deps.view()?.close()
  })

  ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {
    try {
      const view = deps.view()
      if (view === undefined) throw new Error('platform bootstrap: no view')
      // The FRAME object, not its URL: the main-frame check needs identity, which
      // a URL cannot express (a same-origin subframe has the same one).
      event.returnValue = view.bootstrap(event.sender, event.senderFrame)
    } catch (error) {
      // A refusal leaves the preload with no credential, which is the safe side:
      // the page loads as an ordinary web page rather than as a signed-in one.
      deps.log(`[platform] bootstrap refused: ${(error as Error).message}`)
      event.returnValue = null
    }
  })

  return () => {
    ipcMain.removeHandler(PLATFORM_IPC.open)
    ipcMain.removeHandler(PLATFORM_IPC.bounds)
    ipcMain.removeHandler(PLATFORM_IPC.close)
    ipcMain.removeAllListeners(PLATFORM_IPC.bootstrap)
  }
}
