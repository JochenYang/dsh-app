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
import path from 'node:path'
import { BrowserWindow, WebContentsView, ipcMain, nativeTheme, session, shell, type WebContents } from 'electron'
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
   * @param preload - absolute path of the built Platform preload.
   * @param getLocale - the app's resolved language, at call time.
   * @param getTheme - the app's resolved appearance, at call time.
   */
  constructor(
    private readonly preload: string,
    private readonly getLocale: () => PlatformLocale,
    private readonly getTheme: () => 'light' | 'dark',
  ) {}

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
   * tear down a page the user is looking at; any real change closes the view,
   * because a document prepared with the previous account must not outlive it.
   *
   * @param next - the snapshot, or null when signed out.
   */
  setSession(next: PlatformSession | null): void {
    if (next?.token === this.account?.token && next?.origin === this.account?.origin
      && next?.embeddedPageDist === this.account?.embeddedPageDist) return
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
    this.close()
    const account = this.account
    if (account === null) throw new Error('platform view: no account session')
    const generation = this.generation
    // Before the document loads: the page resolves its palette from
    // `prefers-color-scheme` at paint time, so the appearance must be in place
    // when it does (see applyTheme).
    this.applyTheme()

    // A fresh, non-persistent partition per view: Platform cookies must not reach
    // the app's session, and closing the view must discard them.
    const browserSession = session.fromPartition(`dsh-platform-${randomUUID()}`)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    const injected = new Set<number>()
    const deploymentHeaders = account.requestHeaders ?? {}
    browserSession.webRequest.onCompleted((details) => { injected.delete(details.id) })
    browserSession.webRequest.onErrorOccurred((details) => { injected.delete(details.id) })
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      let headers = Object.fromEntries(
        Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      )
      if (new URL(details.url).origin === account.origin) {
        injected.add(details.id)
        // The DEPLOYMENT's headers, never the user's token: the token reaches the
        // page through the preload's bootstrap channel, which is why a redirect
        // cannot carry it anywhere (upstream's rule, kept verbatim).
        headers = { ...headers, ...deploymentHeaders }
        if (deploymentHeaders.cookie !== undefined) {
          headers.cookie = mergePlatformCookies(headers.cookie ?? '', deploymentHeaders.cookie)
        }
      } else if (injected.has(details.id)) {
        // A redirected subresource must not carry deployment headers to another host.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => !Object.hasOwn(deploymentHeaders, name)),
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
    // credential must not: every one of them closes the view.
    const closeIfCurrent = (): void => { if (this.view === view) this.close() }
    const onOwnerNavigation = (): void => { closeIfCurrent() }
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
    view.webContents.session.on('will-download', (event) => { event.preventDefault() })

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
   * the whole guard: the sender must be THIS view's main frame, on the session's
   * origin. A subframe, another webContents, or a stale frame gets nothing.
   *
   * @param sender - the webContents that asked.
   * @param senderUrl - that frame's URL.
   * @returns the origin, token and locale to hand the preload.
   * @throws when the caller is not the current Platform main frame.
   */
  bootstrap(sender: WebContents, senderUrl: string): { origin: string, token: string, locale: PlatformLocale } {
    const view = this.view
    const account = this.account
    if (view === undefined || account === null || sender !== view.webContents) {
      throw new Error('platform view: rejected bootstrap')
    }
    if (new URL(senderUrl).origin !== account.origin) throw new Error('platform view: rejected bootstrap origin')
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
   * The partition is per-view and non-persistent, so clearing is what guarantees
   * the credential cannot be replayed by a later view that happens to reuse the
   * name — the uuid makes that unlikely and this makes it impossible.
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
    if (!view.webContents.isDestroyed()) view.webContents.close()
    void browserSession.clearStorageData().catch(() => {
      // Unreachable once the partition's only view is closed.
    })
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
      event.returnValue = view.bootstrap(event.sender, frameOf(event) ?? '')
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
