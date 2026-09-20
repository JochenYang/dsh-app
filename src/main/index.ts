import { app, BrowserWindow, dialog, Notification, session, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { KernelManager } from '../kernel/manager'
import { OfficePayloadManager } from '../kernel/office-payload'
import {
  bundledKernelChannel,
  bundledTarball,
  decideBundledAdoption,
  findBundledKernel,
  isNewerKernel,
  preferredKernel,
} from '../kernel/bundled'
import { DshServer, resolveLogDir } from './server'
import { APP_URL, desktopHostEntry, hostPackageVersion, hostProfileAnchor, hostTransport, installDshAppProtocol, registerDshAppScheme, type HostProfileAnchor } from './desktop-host'
import { createShellActionHandler, shellActionStampRule, SHELL_ACTIONS_BASE, SHELL_ACTIONS_ENV } from './shell-actions'
import { hostStreamAuthRule } from './host-stream-auth'
import { installSessionHeaderRules } from './session-hooks'
import { isSafeModeEnabled, setSafeMode } from './safe-mode'
import { loadEnvScrubConfig, scrubEnvironment } from './env-scrub'
import { detectLocalProxy, hasProxyEnv, isProxyAlive, withDetectedProxy } from './proxy-detect'
import { devSuiteSources, homeRowsInProfilePatch, prepareBrandSuite, prodSuiteSources, PROFILE_PATCH_FILENAME, resolveDshHome, type PatchSpecifier } from './brand-suite'
import { createMainWindow, isShowingLoadingPage, loadAppIntoWindow, showKernelProgress, showKernelUpdateCard, showToastWhenLoaded } from './window'
import { attachSplashToWindow, handoffToMainWindow, setPauseToggleHandler, setStartupDigest, showStartupFailure, updateStartupWindow } from './startup-window'
import {
  deliverWorkspaceLaunch,
  queueWorkspaceArg,
  takeQueuedWorkspace,
  WORKSPACE_LAUNCH_ATTEMPTS,
  WORKSPACE_LAUNCH_INTERVAL_MS,
  type WorkspaceArgContext,
} from './workspace-launch'
import { closeDialogScript, type CloseDialogChoice } from './close-dialog'
import { inFrameDialogScript } from './in-frame-dialog'
import { noticeThemedDialog, promptThemedDialog } from './themed-dialog'
import { createTray, destroyTray, setTrayTooltip, updateTrayMenu } from './tray'
import { initShellUpdater, checkShellUpdate, consumeUpdaterInstallResult, rollbackShellUpdate } from './updater'
import { KERNEL_CHECK_INTERVAL_MS, KERNEL_NODE_NAME, LEGACY_PROFILE, OFFICE_PAYLOAD_ENV, SUITE_PROFILE, resolveArtifactOwner, resolveArtifactRepo } from '../shared/constants'
import { dropRuntimeMirror, ensureSuiteProfile, mirrorRuntimeIntoProfile, type KernelTreeOutcome, type MigrationOutcome } from './suite-profile'
import { healLogLine, healProfileDependencies } from './profile-heal'
import { alignWindowStateWithLine } from './client-state'
import { initLocale, kernelChannelLabel, kernelUpdateOptionLabel, t } from '../shared/locale'
import type { KernelChannel, KernelStatusPayload } from '../shared/types'

// ---------------------------------------------------------------- config

// Claim the private scheme before Electron is ready — the harness UI is loaded
// from it, which is only allowed for a scheme registered as privileged up front.
registerDshAppScheme()

const isDev = process.env.DSH_APP_DEV === '1'
const devCheckoutDir =
  process.env.DSH_APP_DEV_RUNTIME ??
  (isDev ? path.resolve(process.cwd(), '..', 'deepseek-harness') : undefined)
/**
 * The kernel bundled into THIS build, read once: the channel default below and
 * every install decision (first run, update offer, server-failure reinstall)
 * ask the same files, and none of them may see a different answer.
 */
const bundledKernel = findBundledKernel()
const envChannel = process.env.DSH_APP_CHANNEL ?? ''
/**
 * Kernel line this run follows. An explicit DSH_APP_CHANNEL always wins (it is
 * the documented cross-line escape hatch); with none set the answer comes from
 * the kernel the build actually ships, so a shell packaged from the alpha line
 * installs alpha instead of whatever `stable` points at — the mismatch that let
 * a newer bundled runtime be passed over for an older download.
 */
const channel: KernelChannel =
  envChannel === 'alpha' ? 'alpha'
  : envChannel === 'beta' ? 'beta'
  : envChannel !== '' ? 'stable'
  : bundledKernelChannel(bundledKernel?.manifest ?? null)
const artifactOwner = resolveArtifactOwner()
const artifactRepo = resolveArtifactRepo()
console.log(
  `[kernel] channel ${channel} (${envChannel !== '' ? 'DSH_APP_CHANNEL' : `bundled ${bundledKernel?.manifest?.dshVersion ?? 'none'}`})`,
)

// ------------------------------------------------------------------ state

let kernel: KernelManager
let server: DshServer
/**
 * The on-demand office payload (the LibreOffice engine the runtime no longer
 * ships). Built beside the kernel manager because both read the ACTIVE kernel's
 * manifest: which payload is required is a property of the kernel in force, and
 * the manager resolves it per call so a kernel update changes the answer.
 */
let officePayload: OfficePayloadManager
let mainWindow: BrowserWindow | null = null
let quitting = false
let restartAttempts = 0
let bundledReinstallTried = false
/**
 * Rows in the home-layer patch this profile cannot load, captured before the
 * host starts. They are the one boot failure the shell cannot prevent (the
 * kernel composes that file itself), so they are kept here for the failure card
 * to name — file, line and row.
 */
let homeUnloadable: readonly PatchSpecifier[] = []
/** Safe-mode marker read once per run; toggling always relaunches the app. */
let safeModeActive = false
/**
 * The proxy URL injected into the kernel at the last successful start, or
 * undefined when none was. The watchdog below only ever acts on a proxy THIS
 * shell injected: a proxy the user exported themselves is their business, and
 * restarting on its disappearance would fight their setup.
 */
let injectedProxyUrl: string | undefined
/** Interval handle for the proxy watchdog; cleared on quit. */
let proxyWatchdog: NodeJS.Timeout | undefined

// --------------------------------------------------------------- helpers

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * How often to re-check that an injected proxy is still listening.
 *
 * The proxy is installed into the kernel's undici dispatcher ONCE at boot, so
 * a proxy that disappears afterwards leaves every outbound request — including
 * ones that should go direct — pointed at a closed port. Restarting the server
 * re-runs the boot path, which re-probes and re-decides.
 *
 * The interval is a compromise: short enough that a user who closes their VPN
 * notices quickly, long enough that the probe (a TCP connect to loopback) is
 * negligible. A missed detection costs one interval of failed requests.
 *
 * `DSH_APP_PROXY_WATCHDOG_MS` overrides it, which is how the probe script
 * exercises the restart path without waiting half a minute.
 */
const PROXY_WATCHDOG_INTERVAL_MS = Number(process.env.DSH_APP_PROXY_WATCHDOG_MS ?? 30_000)

/**
 * Start watching the injected proxy.
 *
 * Acts ONLY when this shell injected a proxy and that proxy has stopped
 * accepting connections. Two cases are deliberately ignored:
 * - No proxy was injected: there is nothing to invalidate, and the kernel may
 *   be working fine on a direct connection.
 * - The user exported their own proxy: it is not ours to second-guess.
 */
function startProxyWatchdog(): void {
  if (proxyWatchdog !== undefined) return
  proxyWatchdog = setInterval(() => {
    void (async () => {
      const url = injectedProxyUrl
      if (url === undefined || quitting) return
      if (await isProxyAlive(url)) return
      logKernel(`[kernel] injected proxy ${url} is no longer listening; restarting server to re-detect`)
      injectedProxyUrl = undefined
      await startServerAndOpenWindow()
    })().catch((error: unknown) => {
      logKernel(`[kernel] proxy watchdog failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, PROXY_WATCHDOG_INTERVAL_MS)
}

/** Stop the watchdog (quit path). */
function stopProxyWatchdog(): void {
  if (proxyWatchdog === undefined) return
  clearInterval(proxyWatchdog)
  proxyWatchdog = undefined
}

function broadcastStatus(status: KernelStatusPayload): void {
  // Safe-mode tag: the steady-state labels (tooltip + ready card) must tell
  // the user the suite overlay is off; failure text stays verbatim so the
  // error detail is never mangled.
  const tag = safeModeActive ? t('tray.safeModeTag') : ''
  setTrayTooltip(status.phase === 'ready'
    ? `DSH APP — dsh ${kernel.getCurrent()?.manifest.dshVersion ?? ''}${tag}`
    : `DSH APP — ${status.message}${tag}`)
  // The card itself stays off the loading page (see showKernelProgress: one
  // status surface at a time); this call still runs so the status is recorded
  // for the hand-off and for a later reload of the real UI.
  showKernelProgress(mainWindow, status.phase === 'ready' && safeModeActive ? { ...status, message: `${status.message}${tag}` } : status)
  // Splash mirror: no-op once the page has handed over to the real UI.
  updateStartupWindow(status)
  if (status.phase === 'error') void offerStartupRecovery(status.message, status.error)
}

/**
 * Failure card on the splash, with the actions that can still recover a boot
 * that never reached the main window. Only the windows/folders this shell owns
 * are touched; a failure that happens after the splash is gone resolves to
 * nothing and leaves the existing recovery paths (rollback, release notice,
 * give-up dialog) exactly as they were.
 *
 * Retry re-runs the whole boot through a fresh process: a kernel install that
 * died mid-way and a server that refused to start need different recovery
 * paths, and a relaunch is the one action that covers both without inventing
 * a second state machine (same path the safe-mode toggle already takes).
 */
async function offerStartupRecovery(message: string, detail?: string): Promise<void> {
  // Do not repeat the message when the detail already IS the message line
  // (handleServerDown publishes a status line that carries the reason alone).
  const lines = detail !== undefined && detail !== message ? [detail] : []
  // The rows the profile could not load, before anything else: without this the
  // user's only clue is the kernel's own "plugin tree failed to load", and the
  // row that caused it is in a file they would have no reason to suspect.
  if (homeUnloadable.length > 0) {
    const file = path.join(resolveDshHome(), PROFILE_PATCH_FILENAME)
    lines.push(t('serverFailure.homeRowsIntro', {
      file,
      profile: SUITE_PROFILE,
      count: homeUnloadable.length,
    }))
    for (const row of homeUnloadable) {
      lines.push(t('serverFailure.homeRowLine', { line: row.line, specifier: row.specifier }))
    }
    lines.push(t('serverFailure.homeRowsHint'))
  }
  // Dev mode runs the kernel out of a local harness checkout, where the common
  // failure by far is a stale workspace: the typert artifacts are generated by
  // its build, so a pulled-but-unbuilt checkout fails every plugin
  // registration and no amount of retrying can fix it. Name the command
  // instead of leaving the user with a bare exit code.
  if (isDev) {
    const checkout = process.env.DSH_APP_DEV_RUNTIME
    lines.push(checkout === undefined ? t('devMode.workspaceHint') : t('devMode.workspaceHintAt', { checkout }))
  }
  const choice = await showStartupFailure(message, lines.join('\n'))
  if (choice === 'retry') {
    app.relaunch()
    app.quit()
  } else if (choice === 'open-logs') {
    // The action must not fail on a run that never wrote a log yet.
    try {
      mkdirSync(resolveLogDir(), { recursive: true })
    } catch {
      // Best effort; openPath below reports its own failure.
    }
    void shell.openPath(resolveLogDir())
  } else if (choice === 'quit') {
    app.quit()
  }
}

/**
 * Where the desktop host lives for the active kernel, and what runs it.
 *
 * Node, not Electron: the host's profile resolution loads the
 * `node-addon-require-builtin` native addon, which only accepts runtime
 * fingerprints it knows — and Electron 44.4.1's V8 build is not one of them
 * (the addon names 44.0.0 exactly), so an Electron-as-node child dies with
 * "unsupported Electron runtime fingerprint" before it composes anything. Every
 * runtime ships the Node it was built and tested with, which is what the child
 * runs on; the upstream desktop makes the same choice when the runtime's Node
 * is available.
 *
 * Production: the installed runtime's own `app/` tree — the directory the
 * kernel manager activated, whose node_modules carries `@deepseek-ai/dsh`, the
 * web frontend and the host package itself.
 *
 * Which line that host belongs to decides one more thing about the start, read
 * off its version ({@link hostProfileAnchor}): a 0.1.5-and-earlier host anchors
 * the profile on the profile's OWN node_modules, so the shell mirrors this
 * runtime tree into it ({@link mirrorRuntimeIntoProfile}) — inside the profile,
 * as hardlinks, which is why no `--allow-linked-profile` permission is needed; a
 * 0.1.6-and-later one anchors on this runtime tree and needs neither.
 *
 * Dev: a checkout resolves its packages per app instead of into one installed
 * tree, so the runtime is the desktop-host app inside the checkout — the one
 * directory whose node_modules holds both `@deepseek-ai/dsh` (apps/cli) and
 * `@deepseek-ai/dsh-web-frontend`. `allowLinkedProfile` is what lets the host
 * compose a profile whose bundles resolve outside that tree rather than
 * refusing it as a foreign package. The checkout ships no Node binary, so the
 * machine's own runs the host (`DSH_APP_NODE_BINARY` overrides it).
 *
 * @returns the executable, runtime tree, host entry and permissions to start
 *   with, plus where that host line anchors the profile.
 * @throws when the pieces are not there — the message is the actionable one the
 *   failure card shows.
 */
function hostRuntime(): {
  executable: string
  runtimeDir: string
  entry: string
  allowLinkedProfile: boolean
  /** Undefined when the host package's version maps to nothing (see hostProfileAnchor). */
  profileAnchor: HostProfileAnchor | undefined
  /** Office payload to mirror for the web transport (see DshHostOptions). */
  officeSkillsSource: string
  /** Whether the runtime tree is a checkout; the web transport passes it as the profile resolution mode. */
  checkoutRuntime: boolean
} {
  const nodeBinary = NODE_BINARY_NAME
  if (!isDev) {
    const dir = kernel.getCurrentDir()
    const executable = path.join(dir, 'node', nodeBinary)
    if (!existsSync(executable)) throw new Error(t('hostFailure.nodeMissing', { path: executable }))
    const runtimeDir = path.join(dir, 'app')
    const profileAnchor = hostProfileAnchor(hostPackageVersion(runtimeDir))
    return {
      executable,
      runtimeDir,
      entry: desktopHostEntry(runtimeDir),
      allowLinkedProfile: false,
      profileAnchor,
      // The layout the upstream desktop host expects beside its runtime tree. A
      // released DSH APP runtime carries no office payload yet, so a host line
      // that needs one fails the start with the path it looked for.
      officeSkillsSource: path.join(runtimeDir, '..', 'runtime', 'office-skills'),
      checkoutRuntime: false,
    }
  }
  const checkout = devCheckoutDir
  if (checkout === undefined) throw new Error(t('hostFailure.devHostMissing', { checkout: '../deepseek-harness' }))
  const executable = machineNodeBinary()
  const appDir = path.join(checkout, 'apps', 'desktop-host')
  // The office skills ship inside the workspace checkout as a package of their
  // own; the child wants the payload directory beside its primary-runtime slot.
  const officeSkillsSource = path.join(checkout, 'packages', 'skill', 'skill-office', 'assets')
  if (existsSync(path.join(appDir, 'lib', 'index.js'))) {
    return {
      executable,
      runtimeDir: appDir,
      entry: path.join(appDir, 'lib', 'index.js'),
      allowLinkedProfile: true,
      profileAnchor: hostProfileAnchor(hostPackageVersion(appDir)),
      officeSkillsSource,
      checkoutRuntime: true,
    }
  }
  // A prepared checkout root looks like an installed tree (node_modules with
  // the host package in it); use it when the app was never built in place.
  const entry = desktopHostEntry(checkout)
  if (existsSync(entry)) {
    return {
      executable,
      runtimeDir: checkout,
      entry,
      allowLinkedProfile: true,
      profileAnchor: hostProfileAnchor(hostPackageVersion(checkout)),
      officeSkillsSource,
      checkoutRuntime: true,
    }
  }
  throw new Error(t('hostFailure.devHostMissing', { checkout }))
}

/**
 * The desktop action seam (shell-actions.ts) is the ONLY channel through which
 * a page in the harness UI can make the shell do something native — reveal the
 * log folder, raise a notification, save a text file. It rides the `dsh-app`
 * scheme's own origin instead of a loopback listener, which is what this phase
 * of the app is built on: no port is ever bound, and the kernel child is not
 * involved in the call at all. `installDshAppProtocol` hands it every request
 * below its prefix before anything is forwarded to the host, so it keeps working
 * while the kernel is down.
 */

// ------------------------------------------------------ server diagnostics

/** How many recent server output lines (already redacted) to keep. */
const SERVER_LOG_RING_MAX = 40

/** Ring of the most recent server output lines, for failure classification. */
const serverLogRing: string[] = []

function recordServerLog(line: string): void {
  serverLogRing.push(line)
  if (serverLogRing.length > SERVER_LOG_RING_MAX) serverLogRing.shift()
}

type ServerFailureKind = 'plugin-tree' | 'module' | 'other'

/** The shell's own echo of how the host was started (same onLog channel). */
const HOST_ECHO_LOG = /^dsh host: /

/**
 * Classify a startup failure from the host's recent output lines. The shell's
 * own echo is excluded: it names the entry, the runtime and the profile, and a
 * path containing "patch" would poison the patch-conflict match on every
 * failure. Prescribed match order: a plugin-tree conflict is the one kind with
 * a first-class recovery action (safe mode), so it outranks the more specific
 * but action-less signatures.
 */
function classifyRecentServerFailure(): ServerFailureKind {
  const lines = serverLogRing.filter((line) => !HOST_ECHO_LOG.test(line))
  if (lines.some((line) => /fail the whole plugin tree|patch|insert|invalid config|duplicate/i.test(line))) return 'plugin-tree'
  if (lines.some((line) => /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(line))) return 'module'
  return 'other'
}

/**
 * Conclusion + one actionable suggestion per failure kind (user-facing, so
 * localized at call time — see {@link reportStartupFailureAndExit}).
 */
function serverFailureAdvice(kind: ServerFailureKind): string {
  switch (kind) {
    case 'plugin-tree':
      return t('serverFailure.pluginTree')
    case 'module':
      return t('serverFailure.module')
    default:
      return t('serverFailure.other')
  }
}

/**
 * Enter/leave safe mode and relaunch: the marker is consumed at the next
 * boot's server start, so a restart (not an in-place reload) is the only way
 * to apply it.
 */
async function restartWithSafeMode(enabled: boolean): Promise<void> {
  await setSafeMode(enabled)
  safeModeActive = enabled
  app.relaunch()
  app.quit()
}

/**
 * Give-up dialog after repeated startup failures: classify the collected
 * server output, show the conclusion plus one actionable suggestion, and —
 * when the failure looks like a suite patch conflict — offer the safe-mode
 * escape hatch (write the marker, relaunch without the overlay).
 */
async function reportStartupFailureAndExit(): Promise<void> {
  const kind = classifyRecentServerFailure()
  const message = t('serverFailure.summary', { advice: serverFailureAdvice(kind) })
  if (kind === 'plugin-tree') {
    const choice = await promptThemedConfirm<'safe' | 'quit'>(
      mainWindow,
      {
        title: 'DSH APP',
        message,
        detail: t('serverFailure.safeModeDetail'),
        buttons: [
          { label: t('tray.quit'), value: 'quit' },
          { label: t('tray.enterSafeMode'), value: 'safe', primary: true },
        ],
        cancelValue: 'quit',
        enterValue: 'safe',
      },
      {
        type: 'error',
        title: 'DSH APP',
        message,
        detail: t('serverFailure.safeModeDetail'),
        buttons: [t('tray.enterSafeMode'), t('tray.quit')],
        defaultId: 0,
        cancelId: 1,
      },
      (value, nativeResponse) => (value !== '' ? (value as 'safe' | 'quit') : nativeResponse === 0 ? 'safe' : 'quit'),
    )
    if (choice === 'safe') {
      await restartWithSafeMode(true)
      return
    }
  } else {
    await promptNoticeThemed(mainWindow, 'error', 'DSH APP', t('serverFailure.willExit', { message }))
  }
  app.quit()
}

// ------------------------------------------------------------- lifecycle

/**
 * Prompt a themed in-window confirmation (in-frame dialog script) with a
 * native showMessageBox fallback.
 *
 * @param win - the hosting window; null or destroyed skips injection.
 * @param config - the in-frame dialog config (title/message/detail/buttons).
 * @param native - native fallback options; invoked only when injection fails.
 * @param map - map the resulting value (or fallback response index) to the
 * caller's outcome.
 * @returns the mapped outcome.
 */
async function promptThemedConfirm<O>(
  win: BrowserWindow | null,
  config: Parameters<typeof inFrameDialogScript>[0],
  native: Electron.MessageBoxOptions,
  map: (value: string, nativeResponse?: number) => O,
): Promise<O> {
  return promptThemedDialog(win, inFrameDialogScript(config), native, map)
}

/**
 * Themed single-button notice (info/warning/error) with native fallback.
 * A notice is just a confirm with one button; the mapped outcome is unused.
 * @param win - the hosting window; null/destroyed falls back to native.
 * @param type - notice severity, used by the native fallback's icon only.
 * @param title - card title.
 * @param message - message line.
 * @returns settlement once dismissed (either channel).
 */
async function promptNoticeThemed(
  win: BrowserWindow | null,
  type: 'info' | 'warning' | 'error',
  title: string,
  message: string,
): Promise<void> {
  await noticeThemedDialog(
    win,
    type,
    title,
    message,
    inFrameDialogScript({ title, message, buttons: [{ label: t('common.ok'), value: 'ok', primary: true }], cancelValue: 'ok', enterValue: 'ok' }),
  )
}

/**
 * Prompt the close-choice dialog inside the loaded dsh page (themed modal via
 * close-dialog.ts closeDialogScript()) with a native showMessageBox fallback.
 * Returns the user's choice, or 'cancel' when neither channel can produce an
 * answer (e.g. the page never loaded) — the window then simply stays open.
 * The in-window script resolves to 'tray' | 'quit' | 'cancel'; the native
 * box maps its button indexes identically.
 */
async function promptCloseChoice(win: BrowserWindow | null): Promise<CloseDialogChoice> {
  return promptThemedDialog(
    win,
    closeDialogScript(),
    {
      type: 'question',
      title: t('closeDialog.title'),
      message: t('closeDialog.message'),
      buttons: [t('closeDialog.tray'), t('closeDialog.quit'), t('closeDialog.cancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    },
    (value, nativeResponse) => {
      if (value !== '') return value as CloseDialogChoice
      return nativeResponse === 0 ? 'tray' : nativeResponse === 1 ? 'quit' : 'cancel'
    },
  )
}

/** Argument-parsing facts for one launch; `cwd` is that launch's own. */
function workspaceArgContext(cwd: string): WorkspaceArgContext {
  return {
    cwd,
    appPath: app.getAppPath(),
    isDirectory: (candidate) => statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true,
  }
}

/**
 * Open the folder this app was launched with, if any: `dsh-app.exe <folder>`,
 * a folder dropped onto the icon, or an "open with" — all of them reach the
 * app as a plain argv entry.
 *
 * Delivery is the page's job (see workspace-launch.ts): the shell only passes
 * the path and maps the verdict. A refused folder is the one case the user
 * hears about — a launch that silently does nothing is worse than a dialog
 * naming the path and the reason. Everything else (a kernel without the brand
 * suite never installing the handler, a window that vanished mid-retry) is
 * logged and left alone.
 *
 * @returns settlement once the folder is open, refused, or the retry gave up.
 */
async function openQueuedWorkspace(): Promise<void> {
  const dir = takeQueuedWorkspace()
  const win = mainWindow
  if (dir === null || win === null) return
  const status = await deliverWorkspaceLaunch(win, dir, {
    attempts: WORKSPACE_LAUNCH_ATTEMPTS,
    intervalMs: WORKSPACE_LAUNCH_INTERVAL_MS,
    onError: (error) => logKernel(`[workspace] injection failed while opening ${dir}: ${String(error)}`),
  })
  logKernel(`[workspace] launch folder ${dir} → ${status}`)
  if (!status.startsWith('error:')) return
  const code = status.slice('error:'.length)
  await promptNoticeThemed(
    win,
    'error',
    t('workspace.openFailedTitle'),
    // The host's code decides which advice is true: a path that is not there
    // can be fixed by the user, anything else is ours to investigate.
    code === 'workspace/invalid-path'
      ? t('workspace.openFailedMissing', { path: dir })
      : t('workspace.openFailedOther', { path: dir, code }),
  )
}

/**
 * One-time lifecycle wiring for the main window.
 *
 * Called from wherever the window is created — boot() on the normal path, or
 * this file's restart branch when the window was destroyed while the server was
 * down. Idempotent by construction: it is called once per window instance, and
 * the window itself is created in exactly one place per boot.
 *
 * @param win - the freshly created main window.
 */
function attachMainWindowHandlers(win: BrowserWindow): void {
  win.on('close', (event) => {
    // Tray app: closing the window may either hide it (keep running in the
    // tray) or quit the app — the user picks once, per close. The dialog is
    // shown on every close so quitting is never a silent surprise; while the
    // dialog is open the close is prevented, and the choice decides.
    //
    // A close while the loading page is still up means the kernel never became
    // reachable: there is no page to host that dialog, and promptCloseChoice
    // falls back to a native box, so the choice is still the user's.
    if (quitting) return
    event.preventDefault()
    void promptCloseChoice(win).then((choice) => {
      if (choice === 'tray') {
        // The dialog outlives the window in rare races (window closed while
        // the prompt is open); hide only a live window.
        if (!win.isDestroyed()) win.hide()
      } else if (choice === 'quit') {
        quitting = true
        app.quit()
      }
      // 'cancel' (or the dialog being unanswerable): keep the window open.
    })
  })
  win.on('closed', () => {
    mainWindow = null
  })
}

/**
 * One log line for the profile-seeding outcome. Log-only (never rendered), so
 * it stays out of the locale tables and is written in English.
 */
function suiteProfileLogLine(outcome: MigrationOutcome): string {
  if (outcome.status === 'failed') {
    return `[suite-profile] could not seed "${SUITE_PROFILE}": ${outcome.detail ?? 'unknown error'}`
  }
  if (outcome.status === 'seeded') {
    const carried = outcome.carriedFiles.length === 0
      ? ''
      : `; carried with it ${outcome.carriedFiles.map((file) => `"${file}"`).join(', ')}`
    const unresolved = outcome.unresolvedFiles.length === 0
      ? ''
      : `; the patch names ${outcome.unresolvedFiles.map((file) => `"${file}"`).join(', ')}, whose file is not in the old profile — those rows stay out of the boot`
    const refused = outcome.refusedFiles.length === 0
      ? ''
      : `; the shell declined to carry ${outcome.refusedFiles.map((file) => `"${file}"`).join(', ')} (outside the old profile, behind a link that leaves it, the shell's own state, or over an allowance) — those rows stay out of the boot`
    return `[suite-profile] "${SUITE_PROFILE}" profile created${outcome.carriedPatch ? ' (your patch layer carried over)' : ''}`
      + `; the ${String(outcome.legacyPackages)} package(s) declared on "${LEGACY_PROFILE}" stay there — reinstall them from the plugin market`
      + carried + unresolved + refused
  }
  return `[suite-profile] "${SUITE_PROFILE}" profile already present`
}

/**
 * One log line for the profile-as-installed-tree step. Log-only (English), and
 * it names the version that asked for the work: without that, a profile holding
 * a copy of the kernel reads as something a user should be puzzled by.
 */
function kernelTreeLogLine(outcome: KernelTreeOutcome, version: string | undefined): string {
  const host = version === undefined ? 'the host' : `host ${version}`
  if (outcome.status === 'failed') {
    return `[suite-profile] ${host} resolves the profile as an installed tree, but its kernel packages could not be mirrored into the profile: ${outcome.detail ?? 'unknown error'}; the host start reports the consequence`
  }
  if (outcome.status === 'already') {
    return `[suite-profile] ${host} anchors the profile on its own node_modules (${String(outcome.entries)} kernel entries present, unchanged)`
  }
  return `[suite-profile] ${host} anchors the profile on its own node_modules; mirrored ${String(outcome.entries)} kernel entries (${String(outcome.files)} files) into it`
}

/**
 * One log line per name a mirror step declined to remove, because the runtime
 * the marker recorded could not witness the mirror having written it. Log-only
 * (English), and deliberately one line per name: the residue is a kernel package
 * that may shadow this line's copy, so the reason has to be readable, not
 * batched into a count (see {@link mirrorWitnessGap}).
 */
function logKeptEntries(outcome: KernelTreeOutcome): void {
  for (const kept of outcome.kept) {
    logKernel(`[suite-profile] left ${kept.name} in the profile: ${kept.reason}`)
  }
}

/**
 * Name of the Node binary inside a runtime tree (see `KERNEL_REQUIRED_ENTRIES`
 * for the entries a start verifies).
 */
const NODE_BINARY_NAME = KERNEL_NODE_NAME

/**
 * The machine's Node, for a dev checkout (which ships no binary of its own) and
 * as the fallback wherever the runtime's is not there.
 */
function machineNodeBinary(): string {
  return (process.env.DSH_APP_NODE_BINARY ?? '').trim() || 'node'
}

/**
 * The Node that must run anything from the active runtime — the host child, and
 * the kernel CLI this shell drives for profile work.
 *
 * Never `process.execPath`: the child is started by an Electron process, and
 * Electron's own Node refuses to run the harness (`unsupported Electron runtime
 * fingerprint`). A packaged install runs the runtime's own binary; dev runs the
 * machine's.
 */
function hostNodeBinary(): string {
  if (!isDev) {
    try {
      const executable = path.join(kernel.getCurrentDir(), 'node', NODE_BINARY_NAME)
      if (existsSync(executable)) return executable
    } catch {
      // No active kernel: fall through to the machine's node.
    }
  }
  return machineNodeBinary()
}

/**
 * Absolute path of the active kernel's CLI entry, or '' when there is none.
 *
 * Dev runs the checkout's built CLI; a packaged install has it inside the
 * active kernel. Both the environment handed to the kernel child
 * (`DSH_APP_DSH_BIN`, which the market and the shell's own repair step resolve)
 * and the repair step itself ask this question, so they answer it the same way.
 */
function kernelCliPath(): string {
  if (isDev && devCheckoutDir !== undefined) return path.join(devCheckoutDir, 'apps', 'cli', 'lib', 'bin.js')
  try {
    return path.join(kernel.getCurrentDir(), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  } catch {
    return ''
  }
}

/**
 * The profile's next host start is preceded by a repair step when the profile
 * itself cannot boot: a declared dependency that does not resolve makes the
 * host refuse the whole boot (`cannot resolve profile bundle …`), and the
 * failure card's actions all boot the same profile again. The step runs the
 * profile's own package manager through the kernel CLI — the same invocation
 * the market installs through — and is deliberately non-fatal: whatever it
 * answers, the host start below reports its own outcome.
 *
 * Silent when the profile declares everything it has, which is every normal
 * boot (see {@link healProfileDependencies}).
 */
async function healProfileBeforeStart(profileDir: string): Promise<void> {
  const bin = kernelCliPath()
  if (bin === '' || !existsSync(bin)) return
  const outcome = await healProfileDependencies({
    profileDir,
    profileName: SUITE_PROFILE,
    // The CLI resolves `--profile` through $DSH_HOME (never cwd), so it is the
    // home this profile lives under — the same one ensureSuiteProfile used.
    dshHome: resolveDshHome(),
    bin,
    // A real Node, never Electron's own — see hostNodeBinary.
    node: hostNodeBinary(),
  })
  const line = healLogLine(outcome, profileDir)
  if (line !== null) logKernel(line)
}
async function startServerAndOpenWindow(): Promise<void> {
  if (quitting) return
  // Ring reset: failure classification must reflect THIS startup attempt only.
  serverLogRing.length = 0
  broadcastStatus({ phase: 'starting', message: t('status.startingServer'), progress: null, step: 4 })
  // The profile has to exist before the host composes it, and the suite rows
  // are part of that profile's own patch layer now (the host takes no --patch
  // argument). Seeding an absent profile happens here, in front of the start:
  // the host refuses to boot without a manifest, so "not ready yet" is not a
  // state this boot can fall back from.
  const profile = await ensureSuiteProfile()
  if (profile.outcome !== null) logKernel(suiteProfileLogLine(profile.outcome))
  if (!profile.ready) logKernel('[suite-profile] the suite profile could not be seeded; the host start reports the reason below')
  // A profile whose own manifest declares a package that is not installed is a
  // profile the host refuses to boot, and nothing in the app could repair it:
  // the repair runs the profile's package manager before the start. Non-fatal
  // and silent in the normal case — see healProfileBeforeStart.
  await healProfileBeforeStart(profile.dir)
  // Brand suite wiring: profile-dir module links, and the suite rows plus the
  // user's home layer written into the profile's patch file. An older kernel
  // without the suite plugins boots vanilla. Safe mode drops the shipped rows
  // and keeps only what is the user's own.
  //
  // Which composer will read that file decides the home rows: the desktop host
  // (`profile-boot`) reads only this file, so they have to be copied in; the
  // kernel's own boot on the web transport also loads `$DSH_HOME` as a layer, and
  // a copy there is a second row with the same id — the whole tree then fails
  // with `duplicate loader entry id` (measured on 0.1.6-alpha.2, whose kernel
  // boot composes the home layer itself).
  const suiteHomeRows = homeRowsInProfilePatch({
    isDev,
    transport: hostTransport(hostPackageVersion(path.join(kernel.getCurrentDir(), 'app'))) ?? 'frames',
  })
  const suiteRows = await prepareBrandSuite(
    isDev ? devSuiteSources() : prodSuiteSources(kernel.getCurrentDir()),
    { profileDir: profile.dir, suite: !safeModeActive, homeRows: suiteHomeRows, report: logKernel },
  )
  if (!suiteRows.suite) logKernel('[brand-suite] booting without the suite rows')
  // Rows in the HOME layer this profile cannot load. The kernel composes that
  // file itself on this line, so the shell cannot keep them out of the boot —
  // what it can do is remember them and say so on the failure card, which is the
  // difference between "the app does not open" and a minute of work.
  homeUnloadable = suiteRows.homeUnloadable
  let host: ReturnType<typeof hostRuntime>
  try {
    host = hostRuntime()
  } catch (err) {
    await handleServerDown(t('status.serverStartFailed', { detail: (err as Error).message }))
    return
  }
  // The host line that reads the profile as an INSTALLED tree (0.1.5 and
  // earlier) resolves `@deepseek-ai/dsh` and every bundle out of the profile's
  // own node_modules, so that directory is given the runtime's kernel tree
  // before the start — the seeding above gives a manifest, and this gives the
  // packages the anchor resolves against, as files INSIDE the profile, so no
  // link of the profile's ever names the runtime tree. Idempotent, and
  // deliberately not fatal: a failure here leaves the host to fail with its own
  // message, which is what the failure card reports. A 0.1.6-and-later host
  // anchors on the runtime tree itself: it needs no mirror, and a leftover one
  // from an earlier line would shadow the plugins this kernel ships.
  const hostVersion = hostPackageVersion(host.runtimeDir)
  if (host.profileAnchor === 'profile') {
    const outcome = await mirrorRuntimeIntoProfile(host.runtimeDir, profile.dir)
    logKernel(kernelTreeLogLine(outcome, hostVersion))
    logKeptEntries(outcome)
  } else if (host.profileAnchor === 'runtime') {
    const dropped = await dropRuntimeMirror(profile.dir, host.runtimeDir)
    if (dropped.status === 'removed') {
      logKernel(`[suite-profile] dropped the kernel mirror of an earlier line (${String(dropped.entries)} entries)`)
    } else if (dropped.status === 'failed') {
      logKernel(`[suite-profile] the kernel mirror of an earlier line could not be dropped: ${dropped.detail ?? 'unknown error'}`)
    }
    logKeptEntries(dropped)
  } else {
    // A host package whose version cannot be read is NOT evidence that a
    // leftover mirror is safe to remove: the line that mirror was made for may be
    // the one that needs it (0.1.5 and earlier resolve the kernel out of the
    // profile). Keeping it costs a shadowed package; removing it costs the boot,
    // and only one of those is recoverable.
    logKernel('[suite-profile] the host package reports no readable version, so the profile keeps the mirror it has')
  }
  // The window's view state belongs to the client build of THIS line — see
  // client-state.ts. Aligned before the window is handed the UI, because the
  // client reads its storage as it boots.
  const clientState = await alignWindowStateWithLine({ session: session.defaultSession, userDataDir, version: hostVersion })
  if (clientState.status === 'cleared') {
    logKernel(`[window] kernel line moved ${clientState.previous ?? 'unknown'} → ${clientState.line ?? 'unknown'}; the window's stored client state was reset`)
  } else if (clientState.status === 'skipped' && clientState.detail !== undefined) {
    logKernel(`[window] the window's stored client state was left as it is: ${clientState.detail}`)
  }
  // Environment scrub (opt-in): a missing config removes nothing, so the
  // default boot spawns the kernel with an unchanged inherited env. Names
  // are logged, never values — the removed list cannot leak credentials.
  const scrub = await loadEnvScrubConfig(userDataDir)
  const scrubbed = scrubEnvironment(process.env, scrub.removePatterns)
  if (scrubbed.removed.length > 0) {
    logKernel(`[kernel] env scrubbed: ${scrubbed.removed.join(', ')}`)
  }
  // Proxy auto-detection: a VPN client in TUN/fake-IP mode makes every
  // hostname resolve into 198.18.0.0/15, which the kernel's fetch provider
  // refuses as a non-public address. Telling the kernel about a LISTENING
  // proxy lets it take the proxied branch (the proxy does the DNS, so the
  // check is skipped by design). Probing first is what keeps the other state
  // working: with the VPN off, injecting a dead proxy URL would send every
  // request to a closed port instead.
  //
  // Started HERE but awaited below, next to the start: the probe walks eight
  // ports on two hosts and answers in tens of milliseconds only when a proxy
  // is listening — with none running every port waits out its connect. On the
  // critical path that delay landed between the splash and the start, where
  // the user is already watching. Below, it overlaps the suite wiring and the
  // env scrub, which are themselves asynchronous file work.
  const proxyProbe = detectLocalProxy()
  // The log dir rides along because the diagnostics page reads the host log
  // tail through the plugin, and the child cannot derive that path: the default
  // is this app's userData, which only the shell knows. The versions ride along
  // for the same reason — the diagnostics EXPORT names which shell built which
  // kernel, and the child can derive neither (the shell version belongs to this
  // Electron app; the active manifest lives under userData). A value we cannot
  // read is OMITTED rather than sent empty, so the report can say "unknown"
  // instead of printing a blank version. `channel` is a literal union, so it
  // needs no empty check of its own.
  const detectedProxy = await proxyProbe
  const { env: proxyEnv, injected } = withDetectedProxy(scrubbed.env, detectedProxy)
  // Record what THIS shell injected so the watchdog can act on it later. A
  // proxy the user exported is deliberately not recorded: it is not ours to
  // re-evaluate, and restarting on its disappearance would fight their setup.
  injectedProxyUrl = injected ? detectedProxy : undefined
  if (injected) {
    logKernel(`[kernel] local proxy detected at ${detectedProxy ?? ''}; injecting proxy env`)
  } else if (detectedProxy === undefined) {
    logKernel('[kernel] no local proxy listening; kernel runs without proxy env')
  }

  const activeKernel = kernel.getCurrent()?.manifest
  const shellVersion = app.getVersion()
  // The profile that was actually booted, for the plugins that install into it
  // (the market, preset export) — they must never install into `web` while the
  // app runs another profile.
  // Absolute path of the kernel CLI (see DSH_APP_DSH_BIN below). Dev runs the
  // checkout's built CLI; a packaged install has it inside the active kernel.
  const dshBin = kernelCliPath()

  // The office payload directory the runtime's loader shim loads the engine
  // from. Published whether or not it is installed yet: the shim reads it per
  // conversion, so a payload downloaded while the kernel runs is picked up
  // without a restart — and a kernel that declares no payload sets nothing, so
  // the shim's own actionable refusal is what the user gets.
  const officePayloadDir = officePayload.expectedDir()
  // A payload that carries a Python set is what the host's own
  // `load_workspace_dependencies` tool installs; without one the child keeps the
  // fixed leaf beside the office skills (and the tool reports the path it
  // looked for, exactly as it always has).
  const officePrimaryRuntime = await officePayload.primaryRuntimeDir()
  const kernelEnv = {
    ...proxyEnv,
    DSH_APP_DESKTOP: '1',
    DSH_APP_PROFILE: SUITE_PROFILE,
    DSH_APP_LEGACY_PROFILE: LEGACY_PROFILE,
    // Absolute path of the kernel CLI the suite's own installers drive
    // (`dsh plugin --profile <p> add/remove …`). They resolve it from their own
    // location otherwise, which works in a packaged runtime (the CLI is a
    // sibling in `app/node_modules`) but not in dev, where the plugins live in
    // this repo and the CLI in the harness checkout.
    ...(existsSync(dshBin) ? { DSH_APP_DSH_BIN: dshBin } : {}),
    DSH_APP_LOG_DIR: resolveLogDir(),
    // Tells the kernel-side suite that this shell serves the desktop action
    // route, and where: the plugin hands the page that base URL, and a shell
    // that does not set it reports "no desktop actions" instead of a dead link.
    [SHELL_ACTIONS_ENV]: SHELL_ACTIONS_BASE,
    ...(officePayloadDir === null ? {} : { [OFFICE_PAYLOAD_ENV]: officePayloadDir }),
    ...(shellVersion === '' ? {} : { DSH_APP_SHELL_VERSION: shellVersion }),
    ...(activeKernel === undefined || activeKernel.dshVersion === ''
      ? {}
      : { DSH_APP_KERNEL_VERSION: activeKernel.dshVersion, DSH_APP_KERNEL_CHANNEL: activeKernel.channel }),
  }
  try {
    // `profileAnchor` is the shell's own reading of the host line; only the
    // transport's own options travel to the start. `userDataDir` is where the
    // web transport materializes the office skills it must hand the child, and
    // `officePrimaryRuntime` is where a Python-carrying office payload landed
    // (absent: the fixed leaf beside those skills).
    const { profileAnchor: _anchor, ...hostOptions } = host
    await server.start({
      ...hostOptions,
      userDataDir,
      officePrimaryRuntime: officePrimaryRuntime ?? undefined,
      projectDir: profile.dir,
      env: kernelEnv,
      proxyBootstrap: hasProxyEnv(kernelEnv),
    })
  } catch (err) {
    await handleServerDown(t('status.serverStartFailed', { detail: (err as Error).message }))
    return
  }
  if (!mainWindow) {
    // Only reachable when the window was destroyed while the host was down
    // (the tray's "restart server" path). The normal boot creates it far
    // earlier, with the loading page — see boot().
    mainWindow = createMainWindow()
    attachMainWindowHandlers(mainWindow)
  }
  // Both remaining cases end on the live UI: a window still on the loading page
  // is handed over, one already showing the UI (kernel update, crash recovery,
  // tray restart) is reloaded. The URL is the same in every case — the UI lives
  // at one fixed origin, so there is no port for a restart to change.
  if (isShowingLoadingPage(mainWindow)) loadAppIntoWindow(mainWindow)
  else void mainWindow.loadURL(APP_URL)
  mainWindow.show()
  // The loading page is gone now; the standalone splash (if one was ever
  // created) is closed and unhooked. Nothing else about mainWindow's lifecycle
  // — the close dialog, the 'closed' handler, reuse across restarts — changes.
  handoffToMainWindow(mainWindow)
  // A folder argument opens as a workspace once the page can answer; the
  // delivery retries while the client plugin is still loading, so calling it
  // here (rather than on a load event) loses nothing. Both branches above are
  // covered: the freshly created window and the reloaded one.
  void openQueuedWorkspace()
  restartAttempts = 0
  void kernel.cleanup()
  // State what was verified, in the shape this install actually used: the
  // tarball path records the artifact digest, the layered path records one per
  // layer. A record with neither claims nothing rather than showing a digest
  // this install never checked.
  const installed = kernel.getCurrent()
  setStartupDigest(installed?.sha512 !== undefined
    ? `sha512 ${installed.sha512.slice(0, 16)}…`
    : installed?.layers !== undefined && installed.layers.length > 0
      ? t('status.layersVerified', { count: installed.layers.length })
      : null)
  broadcastStatus({ phase: 'ready', message: t('status.ready'), progress: null })
  updateTrayMenu()
  // A healthy start is the only point where watching makes sense: the server
  // is up, the kernel has a dispatcher, and any proxy this shell injected is
  // now load-bearing. Starting the watchdog earlier would race the boot.
  startProxyWatchdog()
}

async function handleServerDown(reason: string): Promise<void> {
  if (quitting) return
  restartAttempts += 1
  console.error(`[server] down: ${reason} (attempt ${restartAttempts})`)
  broadcastStatus({ phase: 'error', message: t('status.serverDown', { reason }), progress: null, error: reason })

  if (restartAttempts >= 2 && !isDev) {
    const rolledBack = await kernel.rollback()
    if (rolledBack) {
      // No reset here: a recovery action that boots once can still crash on
      // the next start (e.g. a broken user patch layer). Only a genuinely
      // ready server (above) resets the counter, so persistent failures
      // terminate instead of looping forever.
      void promptNoticeThemed(mainWindow, 'warning', 'DSH APP', t('kernelUpdate.rollbackBootFailed', { version: rolledBack.manifest.dshVersion }))
      await startServerAndOpenWindow()
      return
    }
    // No previous version to roll back to (e.g. a broken first install from
    // an earlier release). Try reinstalling from the bundled tarball before
    // giving up — this recovers users who upgraded over a bad v0.1.1 kernel.
    // Tried at most once per run: if the reinstall still crashes we fall
    // through to the give-up branch below.
    const bundled = bundledTarball(bundledKernel)
    if (!bundledReinstallTried && bundled !== null) {
      bundledReinstallTried = true
      try {
        console.log('[kernel] server failed and no rollback available; reinstalling bundled kernel')
        await kernel.installFromLocalTarball(bundled.tarball, bundled.sha512)
        await startServerAndOpenWindow()
        return
      } catch (err) {
        console.error('[kernel] bundled reinstall failed:', (err as Error).message)
      }
    }
  }

  if (restartAttempts >= 3) {
    await reportStartupFailureAndExit()
    return
  }

  await delay(1000 * restartAttempts)
  await startServerAndOpenWindow()
}

// --------------------------------------------------------------- kernel

/** Report a kernel that could not be installed: status card plus a visible dialog. */
function reportInstallFailure(err: unknown): void {
  const detail = (err as Error).message
  broadcastStatus({ phase: 'error', message: t('status.installFailed'), progress: null, error: detail })
  // broadcastStatus only paints an update card and the tray tooltip. On a
  // first run there is no window to paint, so the user was left with a dead
  // app and no explanation; the themed dialog falls back to a native one
  // when the window is absent.
  void promptNoticeThemed(mainWindow, 'error', 'DSH APP', t('kernelUpdate.installFailed', { detail }))
}

async function installKernel(): Promise<void> {
  try {
    await kernel.installLatest('installing')
    await startServerAndOpenWindow()
  } catch (err) {
    reportInstallFailure(err)
  }
}

/**
 * Install the runtime bundled inside this build; the online install is the
 * fallback when the build ships none or the bundle cannot produce a kernel.
 */
async function installBundledKernel(): Promise<void> {
  const files = isDev ? null : bundledTarball(bundledKernel)
  if (files === null) {
    await installKernel()
    return
  }
  try {
    await kernel.installFromLocalTarball(files.tarball, files.sha512)
    await startServerAndOpenWindow()
  } catch (err) {
    // Activation can succeed and still throw afterwards (activateTarball's
    // staging cleanup loses a race with a file lock). Re-read the on-disk
    // state before calling this a failed install: a kernel that is already
    // active must never be replaced by a network reinstall — that both
    // discards a good install and fails outright on an offline machine.
    const installed = await kernel.load().catch(() => null)
    if (installed) {
      console.warn(`[kernel] bundled install threw but ${installed.active} is active; starting it`)
      await startServerAndOpenWindow()
    } else {
      console.error(`bundled kernel install failed: ${(err as Error).message}; falling back to online install`)
      await installKernel()
    }
  }
}

/**
 * First run (or a broken install): install the newer of the two kernels this
 * build could boot.
 *
 * The bundle used to win outright, which pinned a fresh install to the kernel
 * that shipped with the shell even when the followed line had moved on; and
 * when the bundle was absent the channel alone decided, which installed an
 * OLDER kernel than the one sitting in the app's own resources whenever the two
 * disagreed. preferredKernel answers the question once, and each branch falls
 * back to the other so a first run fails only when neither a download nor the
 * bundle can produce a kernel.
 */
async function installBootKernel(): Promise<void> {
  const bundledVersion = isDev ? null : bundledKernel?.manifest?.dshVersion ?? null
  if (bundledVersion !== null) {
    // The comparison needs the channel's answer, and on a first run the splash
    // is the only surface: say what the wait is for instead of leaving it blank.
    broadcastStatus({ phase: 'checking', message: t('kernel.status.checkKernelUpdate'), progress: null, step: 1 })
  }
  const resolved = bundledVersion === null ? null : await kernel.resolveChannelVersion()
  const preferred = preferredKernel({ bundled: bundledVersion, resolved })
  if (preferred !== null && preferred.source === 'resolved') {
    console.log(`[kernel] channel ${channel} resolves dsh ${preferred.version}, newer than the bundled ${bundledVersion ?? 'none'}; installing it`)
    try {
      await kernel.installVersion(preferred.version)
      await startServerAndOpenWindow()
      return
    } catch (err) {
      // Includes the "artifact not published yet" case: the release is on the
      // registry but its runtime has not been uploaded, so the bundled kernel
      // is what can actually boot — and the shell ships on purpose, so the
      // artifact being pending is never a first-run failure.
      console.error(`[kernel] dsh ${preferred.version} install failed: ${(err as Error).message}; using the bundled kernel instead`)
    }
  }
  await installBundledKernel()
}

/** Guards against overlapping checks: the 6 h timer and a tray click can land
 * together, and both would drive a registry probe for the same answer. */
let kernelCheckBusy = false

/** One installable kernel the update prompt (card or dialog) can offer. */
interface KernelUpdateOption {
  version: string
  channel: KernelChannel
  /** The line's own update: the default button, and Enter's answer. */
  primary?: boolean
  /** Install the runtime bundled into this build instead of downloading. */
  bundled?: boolean
}

/**
 * The bundled kernel as an installable option, or null when this build ships
 * none or the bundle is not newer than what is already installed (the only
 * reason to offer it).
 *
 * Installing it needs no network and no artifact probe — the tarball and its
 * sidecar are in this build — so it stays offerable exactly when the online
 * path cannot deliver: a release published on the registry whose runtime
 * artifact is still uploading.
 */
function bundledKernelOption(installedVersion: string | null): { version: string; channel: KernelChannel; bundled: true } | null {
  if (isDev || bundledTarball(bundledKernel) === null) return null
  const manifest = bundledKernel?.manifest ?? null
  const version = manifest?.dshVersion
  if (version === undefined || installedVersion === null) return null
  if (!isNewerKernel(version, installedVersion)) return null
  return { version, channel: bundledKernelChannel(manifest), bundled: true }
}

async function checkKernelUpdate(manual: boolean): Promise<void> {
  if (kernelCheckBusy) return
  kernelCheckBusy = true
  try {
    await checkKernelUpdateInner(manual)
  } finally {
    kernelCheckBusy = false
  }
}

async function checkKernelUpdateInner(manual: boolean): Promise<void> {
  try {
    const result = await kernel.checkForUpdate()
    // Nothing installed is not "up to date": there is no update to offer
    // because there is no kernel, and the message switch below would report
    // the reassuring-but-wrong "the kernel is already the newest version" while
    // blocking recovery.
    if (manual && result.reason === 'no kernel installed') {
      await installBootKernel()
      return
    }
    // Installable options: the primary line's update (if any) first, then
    // one button per other line carrying something newer. Every entry passed
    // the artifact probe in checkForUpdate, so all of them install directly.
    const options: KernelUpdateOption[] = []
    // The kernel bundled into this build is a third candidate, and it can be
    // the newest of them: the shell ships on its own schedule, so its bundle is
    // routinely ahead of the registry line AND ahead of the installed kernel —
    // which is exactly the state that used to leave the user with "artifact
    // pending" and no way to reach the runtime already sitting in their app.
    // It installs from disk, so it needs no probe.
    const bundledOption = bundledKernelOption(result.current)
    if (result.available && result.latest) {
      const pick = preferredKernel({ bundled: bundledOption?.version ?? null, resolved: result.latest })
      if (pick !== null && pick.source === 'bundled' && bundledOption !== null) {
        console.log(`[kernel] bundled dsh ${bundledOption.version} is newer than the offered ${result.latest}; offering the bundled kernel`)
        options.push({ ...bundledOption, primary: true })
      } else {
        options.push({ version: result.latest, channel: result.channel, primary: true })
      }
    } else if (bundledOption !== null) {
      options.push({ ...bundledOption, primary: true })
    }
    for (const alt of result.alternatives ?? []) {
      if (alt.version === result.latest) continue
      if (options.some((option) => option.version === alt.version)) continue
      options.push({ version: alt.version, channel: alt.channel })
    }
    if (options.length === 0) {
      if (manual) {
        // Dev mode can detect a newer version but cannot auto-install; tell
        // the user what's available rather than a flat "up to date".
        const current = result.current ?? t('common.unknown')
        const message = result.reason === 'dev mode update available'
          ? t('kernelUpdate.devAvailable', { current: result.current ?? t('common.unknown'), latest: result.latest ?? t('common.unknown') })
          : result.reason === 'dev mode'
            ? t('kernelUpdate.devUpToDate', { current })
            : result.reason === 'registry unreachable'
              ? t('kernelUpdate.registryUnreachable')
              : result.reason === 'artifact pending'
                ? t('kernelUpdate.artifactPending', { latest: result.latest ?? t('common.unknown'), current })
                : result.reason === 'github unreachable'
                  ? t('kernelUpdate.githubUnreachable')
                  : result.reason === 'install in progress'
                    ? t('kernelUpdate.busy')
                    : t('kernelUpdate.upToDate', { current })
        void promptNoticeThemed(mainWindow, 'info', 'DSH APP', message)
      }
      return
    }
    if (!manual) {
      // Background checks never pop a modal and never auto-install; they
      // surface the finding as a persistent bottom-right card (no auto-hide)
      // with one button per line when the user chooses. Unlike the old 5 s
      // toast this stays visible until acted on, so a quiet channel cannot be
      // missed mid-work; the user decides when to restart the server.
      const choice = await showKernelUpdateCard(mainWindow, result.current ?? t('common.unknown'), options)
      const option = options.find((o) => o.version === choice)
      if (option) await applyKernelUpdate(option)
      return
    }
    const primaryVersion = options.find((o) => o.primary)?.version ?? options[0].version
    const cardTitle = t('kernelUpdate.cardTitle')
    const cardMessage = options.length > 1
      ? t('kernelUpdate.cardMessageMulti', { current: result.current ?? t('common.unknown') })
      : `dsh ${result.current ?? t('common.unknown')} → ${options[0].version}`
    const cardDetail = t('kernelUpdate.cardDetail')
    const picked = await promptThemedConfirm(
      mainWindow,
      {
        title: cardTitle,
        message: cardMessage,
        detail: cardDetail,
        buttons: [
          { label: t('common.later'), value: 'later' },
          ...options.map((o) => ({ label: kernelUpdateOptionLabel(o.version, o.channel, options.length > 1), value: o.version, primary: o.primary })),
        ],
        cancelValue: 'later',
        enterValue: primaryVersion,
      },
      {
        type: 'info',
        title: cardTitle,
        message: cardMessage,
        detail: cardDetail,
        buttons: [t('common.later'), ...options.map((o) => kernelUpdateOptionLabel(o.version, o.channel, options.length > 1))],
        defaultId: 0,
        cancelId: 0,
      },
      (value, nativeResponse) => {
        if (value && value !== 'later') return value
        if (typeof nativeResponse === 'number' && nativeResponse > 0) {
          return options[nativeResponse - 1]?.version ?? null
        }
        return null
      },
    )
    if (picked) {
      const option = options.find((o) => o.version === picked)
      if (option) await applyKernelUpdate(option)
    }
  } catch (err) {
    if (manual) void promptNoticeThemed(mainWindow, 'error', 'DSH APP', t('kernelUpdate.checkFailed', { detail: (err as Error).message }))
  }
}

async function applyKernelUpdate(option: KernelUpdateOption): Promise<void> {
  try {
    const files = bundledTarball(bundledKernel)
    const installed = option.bundled && files !== null
      ? await kernel.installFromLocalTarball(files.tarball, files.sha512)
      : await kernel.installVersion(option.version)
    broadcastStatus({ phase: 'installing', message: t('status.kernelActivated', { version: installed.manifest.dshVersion }), progress: null })
    await startServerAndOpenWindow()
    // The server restart's own starting→ready cycle clears the card, so the
    // one-shot success toast lands afterwards and is visible for 3 s. Wait
    // for the reloaded page first — injecting mid-loadURL would wipe the
    // toast with the old document.
    void showToastWhenLoaded(mainWindow, t('status.kernelUpdated', { version: installed.manifest.dshVersion }), 'success', 3_000)
  } catch (err) {
    void promptNoticeThemed(mainWindow, 'error', 'DSH APP', t('kernelUpdate.updateFailed', { detail: (err as Error).message }))
  }
}

// ------------------------------------------------------------------ boot

/** Resolved kernel log file for this run (see {@link logKernel}). */
let kernelLogFile: string | null = null

/**
 * Kernel diagnostics sink. KernelManager reports through `log`, which the
 * shell wires to console.log — invisible in a packaged Windows app, so a
 * failed install or activation used to leave no trace at all. The same lines
 * also go to `<logs>/dsh-kernel.log` (same directory rule as the server logs,
 * including the DSH_APP_LOG_DIR override). Best effort by design: diagnostics
 * must never fail a boot.
 */
function logKernel(line: string): void {
  console.log(line)
  try {
    if (kernelLogFile === null) {
      const dir = resolveLogDir()
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'dsh-kernel.log')
      // Keep exactly one previous run: an unbounded log is worse than none.
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000) {
        // Windows refuses a rename onto an existing target.
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      }
      kernelLogFile = file
    }
    appendFileSync(kernelLogFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Never let diagnostics break the boot path.
  }
}

async function boot(): Promise<void> {
  // Language first: every string below (splash, tray, dialogs) is localized.
  // This is also the earliest moment the answer is trustworthy — before
  // Electron's app is ready, `app.getLocale()` reports nothing usable.
  initLocale()
  // A folder argument opens as a dsh workspace once the window is up. Parsed
  // here rather than at module scope so `app.getAppPath()` is settled and the
  // argv is the one this process was really started with.
  queueWorkspaceArg(process.argv, workspaceArgContext(process.cwd()))
  // Window FIRST, before any kernel work: it opens showing the local loading
  // page, and startServerAndOpenWindow() later navigates it to the live UI.
  // This is the shape the upstream desktop app uses, and it is why it feels
  // instant — the wait happens behind a window the user is already looking at,
  // instead of in front of one. Measured on this machine, the kernel is up in
  // ~8 s (bare node start 44 ms, CLI load 81 ms, the rest is plugin-tree
  // composition), so what the user perceives is decided here.
  mainWindow = createMainWindow()
  attachMainWindowHandlers(mainWindow)
  // The loading page lives in the main window now: bind the splash module to it
  // so status pushes, the pause control, the failure card and the digest all
  // land where they used to.
  attachSplashToWindow(mainWindow)
  // Read once per run: entering/leaving safe mode relaunches the app, so the
  // in-process flag cannot drift from the on-disk marker mid-session.
  safeModeActive = await isSafeModeEnabled()
  if (safeModeActive) console.log('[safe-mode] booting without the brand-suite overlay')
  kernel = new KernelManager({
    runtimeRoot: app.getPath('userData'),
    platform: process.platform,
    arch: process.arch,
    source: isDev ? 'dev' : 'artifact',
    channel,
    devCheckoutDir,
    artifactOwner,
    artifactRepo,
    onStatus: broadcastStatus,
    log: logKernel,
  })
  // The splash's pause control. A click that raced a fresh status is a no-op —
  // the manager reports false and the next status re-arms the control with the
  // truth, so a double click can never flip the download twice.
  setPauseToggleHandler((wantPaused) => {
    const changed = wantPaused ? kernel.pauseDownload() : kernel.resumeDownload()
    logKernel(`[kernel] ${wantPaused ? 'pause' : 'resume'} requested from the splash: ${changed ? 'applied' : 'ignored (state already matched)'}`)
  })

  // The office payload: which version is required comes from the ACTIVE kernel
  // manifest, read per call, so a kernel update (or a rollback) changes the
  // answer without a restart. A kernel that declares none — dev mode, or a
  // runtime built before the field existed — reports `supported: false`, and
  // nothing is ever fetched on its behalf.
  officePayload = new OfficePayloadManager({
    userDataDir,
    platform: process.platform,
    arch: process.arch,
    owner: artifactOwner,
    repo: artifactRepo,
    target: () => {
      const manifest = kernel.getCurrent()?.manifest
      const ref = manifest?.officePayload
      if (manifest === undefined || ref === undefined) return null
      return {
        dshVersion: manifest.dshVersion,
        payloadVersion: ref.version,
        platform: manifest.platform,
        arch: manifest.arch,
        engine: ref.engine,
      }
    },
    log: logKernel,
  })

  server = new DshServer({
    onExit: (code, signal) => void handleServerDown(t('status.serverExited', { code: code ?? '?', signal: signal ?? '?' })),
    onLog: (line) => {
      console.log('[host]', line)
      recordServerLog(line)
    },
  })
  // The window's `dsh-app://app/…` requests are served from whatever host is
  // running; with none running the page gets a 503 rather than an open socket
  // that answers to anything else on the machine. The shell's own action route
  // is registered with it: it answers in this process, before any forward, and
  // therefore keeps working while the kernel is down (see `shell-actions.ts`).
  const shellActions = createShellActionHandler({
    logDir: resolveLogDir,
    windowId: () => (mainWindow === null || mainWindow.isDestroyed() ? undefined : mainWindow.webContents.id),
    openPath: async (target) => {
      // The folder must exist before the file manager can reveal it: on a fresh
      // install the log directory may not have been written yet.
      try {
        mkdirSync(target, { recursive: true })
      } catch {
        // Best effort: openPath below reports its own failure.
      }
      return shell.openPath(target)
    },
    notify: (title, body) => { new Notification({ title, body }).show() },
    saveAs: async (suggestedName) => {
      // A bare name is joined to Documents by this shell: the dialog starts
      // somewhere predictable, and the path it RETURNS is the only write target.
      const options = { defaultPath: path.join(app.getPath('documents'), suggestedName) }
      const win = mainWindow
      const result = win === null || win.isDestroyed()
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(win, options)
      return result.canceled || result.filePath === '' ? null : result.filePath
    },
    writeFile: (file, text) => writeFile(file, text, 'utf8'),
    // The payload seam: three actions on the same route, no new origin and no
    // new port. The page reaches them the way it reaches every other shell
    // action — through plugin-brand's `/desktop/<action>` coordinates.
    officePayload,
    log: (line) => { logKernel(line) },
  })
  // BOTH session jobs go through ONE install. Electron keeps only the last
  // `onBeforeSendHeaders` listener per session (measured on 44.4.1), so two
  // independent registrations silently disable the earlier one — that is how the
  // stream/auth hook took every desktop action down to `no initiator stamp`.
  // The rules are ordered the way the jobs read: action requests first, then the
  // client's own stream handshakes.
  installSessionHeaderRules(session.defaultSession, [
    shellActionStampRule(),
    hostStreamAuthRule(
      () => server.webTarget(),
      () => (mainWindow === null || mainWindow.isDestroyed() ? undefined : mainWindow.webContents.id),
    ),
  ])
  installDshAppProtocol(() => (server.isRunning ? server : null), shellActions)

  // Create the tray before any server/kernel work so it persists even when
  // the server fails to start (reinstall/retry loops). Otherwise the user
  // has no way to interact with the app while the main window is absent.
  createTray({
    onOpen: () => {
      if (!mainWindow) void startServerAndOpenWindow()
      else mainWindow.show()
    },
    onCheckKernelUpdate: () => void checkKernelUpdate(true),
    onCheckAppUpdate: () => checkShellUpdate(true, mainWindow),
    onRestartServer: () => void startServerAndOpenWindow(),
    onToggleSafeMode: () => void restartWithSafeMode(!safeModeActive),
    isSafeMode: () => safeModeActive,
    onRollbackApp: () => void rollbackShellUpdate(mainWindow),
    getCurrentVersion: () => kernel.getCurrent()?.manifest.dshVersion ?? null,
  })

  // load() reads the on-disk kernel (or the dev checkout manifest) into
  // this.current — no network or install work. A null result means first run
  // or a broken install, handled below by bundled/online activation.
  const current = await kernel.load()
  if (current) {
    // Bundled-runtime adoption check: a NEW shell can ship a same-version
    // kernel whose content changed (the brand suite gained a plugin), and the
    // existing same-named directory would otherwise be reused verbatim,
    // silently booting the whole suite vanilla. The decision itself —
    // including why the tarball sha512 is deliberately not the comparison
    // key — lives in decideBundledAdoption.
    const bundled = bundledTarball(bundledKernel)
    const bundledManifest = bundledKernel?.manifest ?? null
    if (!isDev && bundled !== null && bundledManifest !== null) {
      try {
        if (decideBundledAdoption(bundledManifest, current).adopt) {
          console.log('[kernel] bundled runtime not adopted yet; activating')
          await kernel.installFromLocalTarball(bundled.tarball, bundled.sha512)
        }
      } catch (err) {
        console.error(`[kernel] bundled content check failed: ${(err as Error).message}`)
      }
    }
    await startServerAndOpenWindow()
  } else {
    // First run / broken install (see installBootKernel). The order of these
    // steps is unchanged: the main window still opens only once the server is
    // healthy — the splash created in boot() reports the wait and is closed by
    // the hand-off in startServerAndOpenWindow().
    await installBootKernel()
  }

  initShellUpdater()
  // Surface the previous silent-install result (if any) before the first
  // update-check runs, so an install failure is never silent.
  void consumeUpdaterInstallResult(mainWindow)
  setTimeout(() => checkShellUpdate(false, mainWindow), 10_000)
  setInterval(() => {
    if (!quitting && !isDev) void checkKernelUpdate(false)
  }, KERNEL_CHECK_INTERVAL_MS)
}

// ---------------------------------------------------------------- app

// Pin the userData directory to the DSH APP brand name, and migrate the old
// "DSH App" directory once. Without this the product rename would change the
// default userData path and orphan the installed kernel + settings. renameSync
// is same-volume on every platform, so it preserves the existing install.
const appDataDir = app.getPath('appData')
const userDataDir = path.join(appDataDir, 'DSH APP')
try {
  const legacyDir = path.join(appDataDir, 'DSH App')
  if (existsSync(legacyDir) && !existsSync(userDataDir)) {
    renameSync(legacyDir, userDataDir)
    console.log(`[userData] migrated ${legacyDir} → ${userDataDir}`)
  }
} catch (err) {
  // Best-effort: on failure the new (empty) dir just falls back to a fresh
  // first-run install, which handles itself.
  console.error('[userData] migration failed:', err)
}
app.setPath('userData', userDataDir)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // A second launch can carry a folder too (open-with, a folder dropped on
    // the icon after the app is already up). It is queued and opened in THIS
    // instance — the single-instance lock already decided which one runs — and
    // the running instance focuses instead of starting a second copy.
    queueWorkspaceArg(argv, workspaceArgContext(workingDirectory))
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      // Reuses the blank session the workspace already has, so launching the
      // same folder twice does not stack empty sessions.
      void openQueuedWorkspace()
    } else {
      // Window was closed (hidden/destroyed) — recreate it; the queued folder
      // is delivered when that window comes up.
      void startServerAndOpenWindow()
    }
  })

  void app.whenReady().then(boot)

  app.on('before-quit', () => {
    quitting = true
    stopProxyWatchdog()
  })

  app.on('will-quit', (event) => {
    if (server?.isRunning) {
      // The host must be gone before the process exits — a live child would
      // keep the piped request/response descriptors (and any process it spawned)
      // alive after the window is gone.
      event.preventDefault()
      void server!.stop().catch(() => undefined).finally(() => {
        destroyTray()
        app.exit(0)
      })
    }
  })

  app.on('window-all-closed', () => {
    // Tray app: keep running. Quit via the tray menu.
  })
}
