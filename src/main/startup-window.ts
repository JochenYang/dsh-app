/**
 * First-launch splash window.
 *
 * A cold start unpacks and activates the bundled ~103 MB kernel before any dsh
 * server exists, and the main window is created only once that server is
 * healthy. Until then the screen showed nothing but a tray icon, which users
 * read as a hung app. This module owns a small local window that renders that
 * wait as staged progress, and — when the boot fails — as a conclusion plus
 * the actions that can still recover it.
 *
 * Security posture mirrors the main window exactly: contextIsolation, sandbox,
 * nodeIntegration off, and NO preload. There is no IPC channel either: state
 * is pushed with webContents.executeJavaScript, and the failure card answers
 * through the same injection — the page script returns a promise that settles
 * on a click, the idiom update-card.ts already uses for in-page prompts.
 *
 * The page is a static file (static/startup.html, copied to dist/static by
 * scripts/copy-static.mjs, so it ships inside app.asar) loaded over file://.
 * Deliberately nothing else: the splash must not be able to talk to anything.
 */
import { app, BrowserWindow, nativeTheme } from 'electron'
import { isShowingLoadingPage, resetOverlayColor } from './window'
import path from 'node:path'
import type { KernelStatusPayload, KernelStatusStep } from '../shared/types'
import { t, ZH_KERNEL_STATUS_STEP_KEYWORDS } from '../shared/locale'
import { resolveDshHome, PROFILE_PATCH_FILENAME } from './brand-suite'
import { SUITE_PROFILE } from '../shared/constants'
import { readThemePreference, readThemePreferenceFromPatch, resolveThemeMode, type ThemeMode, type ThemePreference } from './theme'

/** Splash page path: dist/main/ -> dist/static/ in a dev build and in asar. */
const SPLASH_PAGE = path.join(__dirname, '..', 'static', 'startup.html')

/**
 * Window background per theme. These are the resolved values of the UI's own
 * `--dsw-alias-bg-base` (see static/startup.html, which carries the same pair
 * with their token names): the window paints before the page does, and a
 * mismatched background is the one flash the splash cannot cover up.
 */
const SPLASH_BG_LIGHT = '#ffffff'
const SPLASH_BG_DARK = '#151517'

/**
 * Failure-card actions. index.ts owns what each one DOES; this module only
 * reports which button was pressed, and the labels are localized at call time.
 */
export type StartupActionId = 'retry' | 'open-logs' | 'quit' | 'install-missing'

interface StartupAction {
  id: StartupActionId
  label: string
  primary?: boolean
}

/**
 * The action set: retry / open log folder / quit, plus a repair when one applies.
 *
 * `install-missing` is offered only when the shell knows which packages are
 * missing (a home-layer row this profile cannot load), because the action is
 * "install the packages that row names" — without them it would have nothing to
 * install.
 */
function failureActions(extra: readonly StartupActionId[] = []): readonly StartupAction[] {
  const actions: StartupAction[] = [
    { id: 'retry', label: t('splash.retry'), primary: true },
    { id: 'open-logs', label: t('splash.openLogs') },
    { id: 'quit', label: t('tray.quit') },
  ]
  if (extra.includes('install-missing')) {
    actions.splice(1, 0, { id: 'install-missing', label: t('splash.installMissing') })
  }
  return actions
}

interface StartupView {
  /** 1-based step; indexes the <li> list in static/startup.html. */
  stage: number
  message: string
  progress: number | null
  /**
   * What was verified for the runtime now starting, when there is something
   * true to say about it. Absent while booting (nothing is verified yet) and
   * for an install that recorded no provenance — see setStartupDigest.
   */
  digest?: string
  /**
   * The page's own skeleton (step labels, the header hint, the failure hint).
   * It rides every push — a few dozen bytes — because that is also what makes
   * it survive a page reload through the replay path, and because the static
   * HTML cannot know the language. Built lazily: `t()` must run after
   * `initLocale()`, which is why this is not a module-level constant.
   */
  skeleton?: { steps: string[]; hint: string; failureHint: string; pause: string; resume: string }
  /**
   * True while the download in flight can be paused (the shell keeps a promise
   * parked on the page's control; this is what ends it), and true when that
   * download is currently paused.
   */
  pausable?: boolean
  paused?: boolean
  /** Brand row: what this app is, and which build is running. */
  brand: { name: string; version: string }
  /**
   * The fixed wish at the foot of the page. Pushed (not baked into the HTML)
   * because the page's own markup cannot know the shell's language, and pushed
   * every time for the same reason the brand row is: a reloaded page replays it.
   */
  saying: string
  /** Appearance the page mirrors onto its root element. */
  theme: ThemeMode
}

/** Product name shown in the splash's brand row (never localized). */
const BRAND_NAME = 'DSH APP'

/** The skeleton the page renders in place of its own Chinese fallbacks. */
function buildSkeleton(): Required<Pick<StartupView, 'skeleton'>>['skeleton'] {
  return {
    steps: [
      t('splash.step.prepare'),
      t('splash.step.extract'),
      t('splash.step.activate'),
      t('splash.step.server'),
      t('splash.step.window'),
    ],
    hint: t('splash.hint'),
    failureHint: t('splash.failureHint'),
    pause: t('splash.pauseDownload'),
    resume: t('splash.resumeDownload'),
  }
}

/**
 * Verification note for the install that just became active. Kept here rather
 * than passed through every status: it is set once, right before the ready
 * status, and must survive a page reload that replays the latest view.
 */
let lastDigest: string | null = null

/**
 * State what was verified, in the shape the install actually used: a tarball
 * install records the artifact's sha512, a layered one records per-layer
 * digests. Passing null claims nothing — better than showing a digest that
 * this install never checked.
 */
export function setStartupDigest(label: string | null): void {
  lastDigest = label
  if (lastView !== null) push(lastView)
}

interface StartupFailure {
  title: string
  detail: string
  actions: readonly StartupAction[]
}

/**
 * The window hosting the loading page — the MAIN window, on the normal boot.
 *
 * This module never creates a window of its own: the main window opens showing
 * the local page (see `window.ts`), which is where the wait belongs, and
 * `attachSplashToWindow` binds this module to it. A window that wants the page
 * somewhere else binds it the same way.
 */
let splash: BrowserWindow | null = null

/**
 * Bind this module to a window that already shows the loading page.
 *
 * @param win - the window (the main window, on the normal boot).
 */
export function attachSplashToWindow(win: BrowserWindow): void {
  splash = win
  pageReady = false
  currentStage = 1
  // Resolve the PERSISTED preference before the first paint. Everything below
  // reads `currentTheme`, and the window background is what shows before the page
  // does — leaving this call out is how the splash and the window chrome stayed
  // on the OS preference while the app itself rendered the user's own setting.
  applyThemePreference()
  stopThemeWatch = watchSystemTheme()
  applyWindowTheme()
  win.on('closed', () => {
    if (splash === win) splash = null
    pageReady = false
    stopThemeWatch?.()
    stopThemeWatch = null
  })
  win.webContents.on('did-start-loading', () => { pageReady = false })
  win.webContents.on('did-finish-load', () => {
    if (splash !== win) return
    pageReady = true
    if (lastView !== null) push(lastView)
  })
  push({ stage: currentStage, message: t('splash.starting'), progress: null })
}

/** Latest view pushed; replayed on did-finish-load so no state is missed. */
let lastView: StartupView | null = null

/**
 * Highest step reached. Kept across statuses so a message that carries no step
 * (e.g. a plain "checking for updates" line) does not blank the list, and so
 * the failure card can show how far the boot got before it stopped.
 */
let currentStage = 1

/**
 * True once the splash page has finished a load.
 *
 * Pushes before that are only remembered, never injected. Measured (probe):
 * an executeJavaScript issued while the document had not committed yet is
 * delivered to whichever document commits next — it landed *after*
 * did-finish-load and overwrote the newer state that the load replay had
 * pushed. Readiness therefore gates injection, and the replay happens in the
 * did-finish-load handler, where isLoading() may still report true.
 */
let pageReady = false

/**
 * Step index for a status line.
 *
 * The messages themselves come from KernelManager's onStatus and from the
 * server phase in index.ts; they are user-visible in the update card and the
 * tray tooltip, so they are reused verbatim rather than duplicated here.
 *
 * `status.step` is the primary source and is language-independent. Only when it
 * is absent — a status from a producer that does not declare a step, e.g. an
 * older path or an injected test status — do we fall back to matching the
 * wording, which works in zh-CN only (see ZH_KERNEL_STATUS_STEP_KEYWORDS). A
 * line that matches neither keeps the current step: the status line itself
 * always tells the truth, so an unmapped message degrades the step indicator
 * instead of lying.
 */
function stageForMessage(message: string, step?: KernelStatusStep): number {
  if (step !== undefined) return step
  for (const hint of ZH_KERNEL_STATUS_STEP_KEYWORDS) {
    if (hint.keywords.some((keyword) => message.includes(keyword))) return hint.step
  }
  return 0
}

/** Push one state into the page; rendering belongs to static/startup.html. */
const STARTUP_STATE_SCRIPT = (view: StartupView): string => `(function () {
  if (typeof window.__dshStartupUpdate !== 'function') return false;
  return window.__dshStartupUpdate(${JSON.stringify(view)}) === true;
})()`

/**
 * Arm the page's pause control for exactly one click. Resolves true on a click,
 * or false when the page settled it because the download moved on. Same parking
 * idiom as the failure card: the promise settles on a click, never on its own,
 * so awaiting it is not a round-trip loop.
 */
const STARTUP_PAUSE_SCRIPT = `(function () {
  if (typeof window.__dshStartupAwaitPause !== 'function') return Promise.resolve(false);
  return window.__dshStartupAwaitPause();
})()`

/** What the shell does with a click; set once by index.ts. */
let pauseToggleHandler: ((wantPaused: boolean) => void) | null = null

/**
 * Register the pause/resume handler. The handler receives the state the user
 * asked for, not a toggle to apply blindly: a click that raced a fresh status
 * must not flip the manager twice.
 */
export function setPauseToggleHandler(handler: (wantPaused: boolean) => void): void {
  pauseToggleHandler = handler
}

/** One armed awaiter at a time; see armPauseControl. */
let pauseArmed = false

/** Arm the control when a status makes it visible, at most one await at a time. */
function armPauseControl(paused: boolean): void {
  const win = splash
  if (pauseArmed || win === null || win.isDestroyed() || win.webContents.isDestroyed() || !pageReady) return
  pauseArmed = true
  win.webContents.executeJavaScript(STARTUP_PAUSE_SCRIPT).then((clicked: unknown) => {
    pauseArmed = false
    // false (or anything unexpected) means the page settled it because the boot
    // moved past the download; only a real click asks for a state change.
    if (clicked === true) pauseToggleHandler?.(!paused)
  }).catch(() => {
    pauseArmed = false
  })
}

/**
 * Show the failure card. The in-page promise resolves only when a button is
 * clicked, so this call parks instead of polling: an injection that resolved
 * on its own would become a main<->renderer round-trip loop (see the
 * chrome-sync note in window.ts).
 */
const STARTUP_FAILURE_SCRIPT = (failure: StartupFailure): string => `(function () {
  if (typeof window.__dshStartupShowFailure !== 'function') return Promise.resolve(null);
  return window.__dshStartupShowFailure(${JSON.stringify(failure)});
})()`

/** Narrow a value returned by the page to a known action id. */
function isActionId(value: unknown): value is StartupActionId {
  return value === 'retry' || value === 'open-logs' || value === 'quit' || value === 'install-missing'
}

/** Everything a push carries; brand, theme, skeleton and digest are push-owned. */
type StartupPush = Omit<StartupView, 'brand' | 'theme' | 'skeleton' | 'digest' | 'saying'>

function push(view: StartupPush): void {
  // The skeleton is built lazily and only once: `t()` resolves against the
  // locale initLocale() installed, and a module-level constant would freeze it
  // before that runs.
  if (lastSkeleton === null) lastSkeleton = buildSkeleton()
  const withDigest = lastDigest === null ? view : { ...view, digest: lastDigest }
  // Brand row and appearance ride every push for the same reason the skeleton
  // does: they survive a page reload through the replay path, and a push that
  // carried neither would blank them.
  const next: StartupView = {
    ...withDigest,
    skeleton: lastSkeleton,
    brand: brandRow(),
    theme: currentTheme,
    saying: t('splash.saying'),
  }
  lastView = next
  const win = splash
  if (!pageReady || win === null || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.executeJavaScript(STARTUP_STATE_SCRIPT(next)).catch(() => undefined)
}

/** Built on the first push; see StartupView.skeleton. */
let lastSkeleton: StartupView['skeleton'] | null = null

/**
 * Brand row: the product name and the build actually running. Read per push
 * (not frozen at import) because `app.getVersion()` is only meaningful once
 * Electron has parsed the package — and because a dev run and a packaged run
 * report different versions, which is exactly the number worth showing.
 */
function brandRow(): StartupView['brand'] {
  return { name: BRAND_NAME, version: app.getVersion() }
}

/**
 * Appearance the splash is currently drawn in.
 *
 * The UI's own preference wins; `system` (its default, and what an unreadable
 * document means) follows the OS, live — the splash can sit on screen for
 * minutes during a first install, and an OS light/dark switch in that window
 * must not leave it mismatched.
 */
let currentTheme: ThemeMode = 'light'

/** The persisted preference, resolved once per run (see applyThemePreference). */
let themePreference: ThemePreference | null = null

/**
 * Resolve the splash's appearance from the UI's setting plus the OS.
 *
 * The setting lives under `$DSH_HOME` — the same home the brand-suite seam links
 * plugins into, resolved through the same helper so the two can never disagree
 * about where the user's dsh lives. WHICH file holds it depends on the kernel
 * line; {@link readThemePreferenceAcrossLines} asks each address in turn.
 */
function applyThemePreference(): ThemeMode {
  themePreference = readThemePreferenceAcrossLines()
  currentTheme = resolveThemeMode(themePreference, nativeTheme.shouldUseDarkColors)
  return currentTheme
}

/**
 * The appearance setting, wherever this machine keeps it.
 *
 * Where it lives moved with the kernel line, and the splash has to read it
 * BEFORE a kernel is resolved — so the shell asks the addresses in the order the
 * lines introduced them and takes the first that answers:
 *
 *   1. the booted profile's own patch — 0.1.7 stores every setting there;
 *   2. `$DSH_HOME/settings.yaml` — every line before it;
 *   3. `$DSH_HOME/settings.yaml.imported` — where 0.1.7 moved (2) after importing
 *      it, so a machine that upgraded and later rolled back still opens on the
 *      preference its owner chose rather than on the OS default.
 *
 * Reading three small files once per start is cheaper than any bookkeeping that
 * would say which one is current, and it cannot be wrong: an address that holds
 * no preference answers null.
 */
function readThemePreferenceAcrossLines(): ThemePreference | null {
  const home = resolveDshHome()
  return readThemePreferenceFromPatch(path.join(home, 'profiles', SUITE_PROFILE, PROFILE_PATCH_FILENAME))
    ?? readThemePreference(path.join(home, 'settings.yaml'))
    ?? readThemePreference(path.join(home, 'settings.yaml.imported'))
}

/**
 * Paint the window chrome in {@link currentTheme}: the window background (what
 * shows before the page does) and the native overlay strip behind the window
 * buttons. Both have to follow a live theme switch, or the buttons float on a
 * strip that no longer matches the page under it.
 */

/**
 * Paint the window's own background for the current theme.
 *
 * Background only, and deliberately NOT the title-bar overlay: the strip has a
 * single owner — the page's own sampler in window.ts (`startChromeSync`), which
 * reads whatever is actually painted under the window controls and applies it.
 * The shell writing that strip as well is what broke it: two writers, two
 * caches, and the loser's colour stuck (a white strip over a dark app, even
 * behind modal masks). The splash page paints its own themed background, so the
 * sampler follows the splash for free — no shell-side theme knowledge needed.
 *
 * The window `backgroundColor` is different: it shows before the page paints
 * (and behind it), so it cannot be sampled and must be set here.
 */
function applyWindowTheme(): void {
  const win = splash
  if (win === null || win.isDestroyed()) return
  if (!isShowingLoadingPage(win)) return
  win.setBackgroundColor(currentTheme === 'dark' ? SPLASH_BG_DARK : SPLASH_BG_LIGHT)
}

/**
 * The appearance the shell resolved for the UI right now.
 *
 * Exported so the embedded Platform view can carry the SAME appearance into the
 * page it hosts: measured, that page follows `prefers-color-scheme` and ignores
 * any `?theme=` parameter (only the LOGIN page honours that one), so the only
 * lever is `nativeTheme.themeSource`.
 *
 * It RE-RESOLVES on every call instead of returning {@link currentTheme}. That
 * cached field is written once, when the splash mounts — and the kernel rewrites
 * the preference the moment the user picks a new theme, so a cached answer is
 * stale for the rest of the run: measured, switching to dark and then opening the
 * top-up page still produced a white page, because this function was still
 * answering the value read at launch. Three small files per call is nothing next
 * to a user-visible app, and the alternative (a listener on a file the KERNEL
 * owns) would have to be invalidated in ways this shell cannot observe.
 *
 * @returns the effective mode, never the raw preference.
 */
export function activeThemeMode(): ThemeMode {
  return applyThemePreference()
}

/**
 * Keep the splash in step with the OS while the preference is `system`.
 * @returns the disposer.
 */
function watchSystemTheme(): () => void {
  const onUpdate = (): void => {
    // A pinned preference ('light' / 'dark') is the user's explicit choice and
    // outranks the OS; only the delegating preference follows the system.
    if (themePreference === 'light' || themePreference === 'dark') return
    const next = resolveThemeMode(themePreference, nativeTheme.shouldUseDarkColors)
    if (next === currentTheme) return
    currentTheme = next
    applyWindowTheme()
    if (lastView !== null) push(lastView)
  }
  nativeTheme.on('updated', onUpdate)
  return () => nativeTheme.off('updated', onUpdate)
}

/** Removed on 'closed'; the listener would otherwise outlive the window. */
let stopThemeWatch: (() => void) | null = null


/**
 * Mirror a kernel/server status onto the splash. No-op once the splash is
 * gone, which is the normal case after boot: main-window statuses keep going
 * to the update card and the tray tooltip exactly as before.
 */
export function updateStartupWindow(status: KernelStatusPayload): void {
  if (splash === null || splash.isDestroyed()) return
  if (status.phase === 'ready') {
    currentStage = 5
  } else if (status.phase !== 'error') {
    // An error keeps the step where the boot stopped — that position is what
    // tells the user how far it got; only the status line changes.
    const mapped = stageForMessage(status.message, status.step)
    if (mapped > 0) currentStage = mapped
  }
  push({
    stage: currentStage,
    message: status.message,
    progress: status.progress,
    pausable: status.phase === 'downloading',
    paused: status.paused === true,
  })
  // The control is visible exactly while the download runs; arming here (rather
  // than once at boot) is what gives every click a fresh awaiter.
  if (status.phase === 'downloading') armPauseControl(status.paused === true)
}

/**
 * Hand off to the real window: the loading page is done and the live UI is
 * about to (or already did) replace it there.
 */
export function handoffToMainWindow(win: BrowserWindow): void {
  // Forget the colour this module painted, so the page's own chrome sync takes
  // over and is not skipped as "already applied".
  resetOverlayColor(win)
  // The window stays — it hosts the live UI now — and this module simply stops
  // driving the page once the real UI has been loaded into it (the caller
  // navigates first).
  splash = null
  pageReady = false
  lastView = null
  lastSkeleton = null
  stopThemeWatch?.()
  stopThemeWatch = null
}

/**
 * Render the failure card and resolve with the action the user picked.
 *
 * @param message - the status line already published for this failure (the
 *   frozen wording from KernelManager / index.ts), reused verbatim.
 * @param detail - the error detail, when it says more than the message does.
 * @param extraActions - actions this failure can offer beyond the frozen set
 *   (only `install-missing`, and only when the shell knows the packages).
 * @returns the chosen action, or null when the splash is gone — a failure
 *   after the main window opened, where the existing recovery paths and
 *   dialogs own the failure — or when the window died before an answer.
 */
export async function showStartupFailure(
  message: string,
  detail: string,
  extraActions: readonly StartupActionId[] = [],
): Promise<StartupActionId | null> {
  const win = splash
  if (win === null || win.isDestroyed() || win.webContents.isDestroyed()) return null
  try {
    const choice = await win.webContents.executeJavaScript(
      STARTUP_FAILURE_SCRIPT({ title: message, detail, actions: failureActions(extraActions) }),
    )
    return isActionId(choice) ? choice : null
  } catch {
    return null
  }
}
