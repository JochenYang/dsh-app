import { app, BrowserWindow, Notification, dialog, shell } from 'electron'
import net from 'node:net'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { KernelManager } from '../kernel/manager'
import { decideBundledAdoption, type BundledManifestFields } from '../kernel/bundled'
import { DshServer, resolveLogDir } from './server'
import { isSafeModeEnabled, setSafeMode } from './safe-mode'
import { loadEnvScrubConfig, scrubEnvironment } from './env-scrub'
import { detectLocalProxy, isProxyAlive, withDetectedProxy } from './proxy-detect'
import { devSuiteSources, prepareBrandSuite, prodSuiteSources } from './brand-suite'
import { createMainWindow, showKernelProgress, showKernelUpdateCard, showToastWhenLoaded, clearStaleAuthCookies, updateServerOrigin } from './window'
import { createStartupWindow, handoffToMainWindow, setPauseToggleHandler, setStartupDigest, showStartupFailure, updateStartupWindow } from './startup-window'
import { startDesktopBridge, type DesktopBridge } from './desktop-bridge'
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
import { KERNEL_CHECK_INTERVAL_MS, DEFAULT_HTTP_HOST, resolveArtifactOwner, resolveArtifactRepo } from '../shared/constants'
import { initLocale, kernelChannelLabel, kernelUpdateOptionLabel, t } from '../shared/locale'
import type { KernelChannel, KernelStatusPayload } from '../shared/types'

// ---------------------------------------------------------------- config

const isDev = process.env.DSH_APP_DEV === '1'
const devCheckoutDir =
  process.env.DSH_APP_DEV_RUNTIME ??
  (isDev ? path.resolve(process.cwd(), '..', 'deepseek-harness') : undefined)
const channel =
  process.env.DSH_APP_CHANNEL === 'alpha' ? 'alpha'
  : process.env.DSH_APP_CHANNEL === 'beta' ? 'beta'
  : 'stable'
const artifactOwner = resolveArtifactOwner()
const artifactRepo = resolveArtifactRepo()

// ------------------------------------------------------------------ state

let kernel: KernelManager
let server: DshServer
let mainWindow: BrowserWindow | null = null
let quitting = false
let restartAttempts = 0
let bundledReinstallTried = false
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address() as net.AddressInfo
      srv.close(() => resolve(address.port))
    })
  })
}

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
  showKernelProgress(mainWindow, status.phase === 'ready' && safeModeActive ? { ...status, message: `${status.message}${tag}` } : status)
  // Splash mirror: during boot there is no main window and no in-window card,
  // so the splash is the only surface that can show this status. It is a no-op
  // once the main window is up (the splash is closed by then).
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

/** The desktop bridge; started lazily on the first server start, one per run. */
let desktopBridge: DesktopBridge | null = null

/**
 * Start the desktop bridge: the channel kernel-side plugins use to ask the shell
 * for NATIVE actions (reveal a folder, notify, save-as, pick a directory). Those
 * capabilities exist only in this process, while the plugins run in the kernel
 * child — see desktop-bridge.ts for the fences that keep a listening socket on
 * loopback from being a way in.
 *
 * A bridge that cannot bind is deliberately not a boot failure: the environment
 * variables stay unset, the plugin's actions report the bridge as unsupported,
 * and every
 * other behaviour is exactly as before.
 */
async function ensureDesktopBridge(): Promise<void> {
  if (desktopBridge !== null) return
  desktopBridge = await startDesktopBridge({
    openInFolder: async (target) => {
      const failure = await shell.openPath(target)
      if (failure !== '') throw new Error(t('bridge.openFailed', { detail: failure }))
    },
    notify: async (title, body) => {
      new Notification({ title, body }).show()
    },
    saveTextAs: async (name, content) => {
      const result = await dialog.showSaveDialog({ defaultPath: name })
      if (result.canceled || result.filePath === undefined) return null
      await writeFile(result.filePath, content, 'utf8')
      return result.filePath
    },
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    openLogs: async () => {
      try {
        mkdirSync(resolveLogDir(), { recursive: true })
      } catch {
        // Best effort; openPath below reports its own failure.
      }
      const failure = await shell.openPath(resolveLogDir())
      if (failure !== '') throw new Error(t('bridge.openLogsFailed', { detail: failure }))
    },
  })
  // The URL is loopback and safe to log; the token never is.
  logKernel(desktopBridge === null
    ? '[bridge] desktop bridge unavailable; native actions will report unsupported'
    : `[bridge] desktop bridge listening on ${desktopBridge.url}`)
}

// ------------------------------------------------------ server diagnostics

/** How many recent server output lines (already redacted) to keep. */
const SERVER_LOG_RING_MAX = 40

/** Ring of the most recent server output lines, for failure classification. */
const serverLogRing: string[] = []

function recordServerLog(line: string): void {
  serverLogRing.push(line)
  if (serverLogRing.length > SERVER_LOG_RING_MAX) serverLogRing.shift()
}

type ServerFailureKind = 'plugin-tree' | 'port' | 'module' | 'other'

/** The shell's own command echo (emitted through the same onLog channel). */
const SPAWN_ECHO_LOG = /^spawn /

/**
 * Classify a startup failure from the server's recent output lines. The
 * command echo is excluded: it always contains "--patch" and would poison
 * the patch-conflict match on every failure. Prescribed match order: a
 * plugin-tree conflict is the one kind with a first-class recovery action
 * (safe mode), so it outranks the more specific but action-less signatures.
 */
function classifyRecentServerFailure(): ServerFailureKind {
  const lines = serverLogRing.filter((line) => !SPAWN_ECHO_LOG.test(line))
  if (lines.some((line) => /fail the whole plugin tree|patch|insert|invalid config/i.test(line))) return 'plugin-tree'
  if (lines.some((line) => /EADDRINUSE/i.test(line))) return 'port'
  if (lines.some((line) => /Cannot find module/i.test(line))) return 'module'
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
    case 'port':
      return t('serverFailure.port')
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

async function startServerAndOpenWindow(): Promise<void> {
  if (quitting) return
  // Ring reset: failure classification must reflect THIS startup attempt only.
  serverLogRing.length = 0
  broadcastStatus({ phase: 'starting', message: t('status.startingServer'), progress: null, step: 4 })
  const port = await findFreePort()
  // Brand suite wiring: profile-dir module links + the loader overlay that
  // inserts the brand rows. An older kernel without the suite plugins boots
  // vanilla (empty array). Safe mode skips the suite overlay entirely — the
  // kernel boots the official bundle plus the user's own profile layers only.
  const overlays = safeModeActive
    ? []
    : await prepareBrandSuite(isDev ? devSuiteSources() : prodSuiteSources(kernel.getCurrentDir()))
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
  const detectedProxy = await detectLocalProxy()
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
  // Native actions (reveal a folder, notify, save-as, pick a directory) live in
  // this process, and the kernel child reaches them through the bridge's
  // endpoint + token. Started here so a server that crashed and restarted finds
  // a bridge already listening; a bridge that could not bind simply contributes
  // no variables and the plugin reports the bridge as unsupported.
  await ensureDesktopBridge()
  // The log dir rides along because the diagnostics page reads the server log
  // tail through the plugin, and the child cannot derive that path: the default
  // is this app's userData, which only the shell knows. The versions ride along
  // for the same reason — the diagnostics EXPORT names which shell built which
  // kernel, and the child can derive neither (the shell version belongs to this
  // Electron app; the active manifest lives under userData). A value we cannot
  // read is OMITTED rather than sent empty, so the report can say "unknown"
  // instead of printing a blank version. `channel` is a literal union, so it
  // needs no empty check of its own.
  const activeKernel = kernel.getCurrent()?.manifest
  const shellVersion = app.getVersion()
  const kernelEnv = {
    ...(desktopBridge === null ? proxyEnv : { ...proxyEnv, ...desktopBridge.env }),
    DSH_APP_LOG_DIR: resolveLogDir(),
    ...(shellVersion === '' ? {} : { DSH_APP_SHELL_VERSION: shellVersion }),
    ...(activeKernel === undefined || activeKernel.dshVersion === ''
      ? {}
      : { DSH_APP_KERNEL_VERSION: activeKernel.dshVersion, DSH_APP_KERNEL_CHANNEL: activeKernel.channel }),
  }
  try {
    await server.start(kernel.getServerSpec(), port, DEFAULT_HTTP_HOST, overlays, kernelEnv)
  } catch (err) {
    await handleServerDown(t('status.serverStartFailed', { detail: (err as Error).message }))
    return
  }
  const url = server.serverUrl
  // dsh seeds a fresh auth cookie per start; the persistent session otherwise
  // accumulates them until the Cookie header trips the server's 16 KB cap
  // (431 → white screen). Clear stale ones before the window loads.
  await clearStaleAuthCookies()
  if (!mainWindow) {
    mainWindow = createMainWindow(url)
    mainWindow.on('close', (event) => {
      // Tray app: closing the window may either hide it (keep running in the
      // tray) or quit the app — the user picks once, per close. The dialog is
      // shown on every close so quitting is never a silent surprise; while the
      // dialog is open the close is prevented, and the choice decides.
      if (quitting) return
      event.preventDefault()
      const win = mainWindow
      void promptCloseChoice(win).then((choice) => {
        if (choice === 'tray') {
          // The dialog outlives the window in rare races (window closed while
          // the prompt is open); hide only a live window.
          if (win !== null && !win.isDestroyed()) win.hide()
        } else if (choice === 'quit') {
          quitting = true
          app.quit()
        }
        // 'cancel' (or the dialog being unanswerable): keep the window open.
      })
    })
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  } else {
    // The server may have restarted on a fresh port (kernel update or crash
    // recovery); retarget the navigation guard before reloading, otherwise
    // every same-origin link in the reloaded page is pushed to the browser.
    updateServerOrigin(mainWindow, url)
    void mainWindow.loadURL(url)
    mainWindow.show()
  }
  // Splash → main window. Only the splash created by this shell is closed, and
  // only once the real window is on screen; mainWindow's own lifecycle (close
  // dialog, 'closed' handler, reuse across server restarts) is untouched.
  if (mainWindow !== null) handoffToMainWindow(mainWindow)
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
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    if (!bundledReinstallTried && existsSync(bundledTgz) && existsSync(bundledSha)) {
      bundledReinstallTried = true
      try {
        console.log('[kernel] server failed and no rollback available; reinstalling bundled kernel')
        await kernel.installFromLocalTarball(bundledTgz, bundledSha)
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

async function installKernel(): Promise<void> {
  try {
    await kernel.installLatest('installing')
    await startServerAndOpenWindow()
  } catch (err) {
    const detail = (err as Error).message
    broadcastStatus({ phase: 'error', message: t('status.installFailed'), progress: null, error: detail })
    // broadcastStatus only paints an update card and the tray tooltip. On a
    // first run there is no window to paint, so the user was left with a dead
    // app and no explanation; the themed dialog falls back to a native one
    // when the window is absent.
    void promptNoticeThemed(mainWindow, 'error', 'DSH APP', t('kernelUpdate.installFailed', { detail }))
  }
}

/** Guards against overlapping checks: the 6 h timer and a tray click can land
 * together, and both would drive a registry probe for the same answer. */
let kernelCheckBusy = false

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
      await installKernel()
      return
    }
    // Installable options: the primary line's update (if any) first, then
    // one button per other line carrying something newer. Every entry passed
    // the artifact probe in checkForUpdate, so all of them install directly.
    const options: Array<{ version: string; channel: KernelChannel; primary?: boolean }> = []
    if (result.available && result.latest) {
      options.push({ version: result.latest, channel: result.channel, primary: true })
    }
    for (const alt of result.alternatives ?? []) {
      if (alt.version === result.latest) continue
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
      if (choice !== 'later') await applyKernelUpdate(choice)
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
    if (picked) await applyKernelUpdate(picked)
  } catch (err) {
    if (manual) void promptNoticeThemed(mainWindow, 'error', 'DSH APP', t('kernelUpdate.checkFailed', { detail: (err as Error).message }))
  }
}

async function applyKernelUpdate(version: string): Promise<void> {
  try {
    const installed = await kernel.installVersion(version)
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
  // First-launch visibility, first thing: everything below (kernel adoption,
  // first install, server spawn) is unchanged, but on a cold start it runs for
  // tens of seconds before any other window exists — the splash is the only
  // feedback the user gets until the main window opens.
  createStartupWindow()
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

  server = new DshServer({
    onExit: (code, signal) => void handleServerDown(t('status.serverExited', { code: code ?? '?', signal: signal ?? '?' })),
    onLog: (line) => {
      console.log('[server]', line)
      recordServerLog(line)
    },
  })

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
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    const bundledManifestPath = path.join(process.resourcesPath, 'kernel', 'manifest.json')
    if (!isDev && existsSync(bundledTgz) && existsSync(bundledSha) && existsSync(bundledManifestPath)) {
      try {
        const bundledManifest = JSON.parse(readFileSync(bundledManifestPath, 'utf8')) as BundledManifestFields
        if (decideBundledAdoption(bundledManifest, current).adopt) {
          console.log('[kernel] bundled runtime not adopted yet; activating')
          await kernel.installFromLocalTarball(bundledTgz, bundledSha)
        }
      } catch (err) {
        console.error(`[kernel] bundled content check failed: ${(err as Error).message}`)
      }
    }
    await startServerAndOpenWindow()
  } else {
    // First run / broken install. Prefer the tarball bundled inside the app's
    // resources (shipped with the installer) so the user need not download the
    // kernel; only fall back to the online install when no bundle is present.
    // The order of these steps is unchanged: the main window still opens only
    // once the server is healthy — the splash created in boot() reports the
    // wait and is closed by the hand-off in startServerAndOpenWindow().
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    if (!isDev && existsSync(bundledTgz) && existsSync(bundledSha)) {
      try {
        await kernel.installFromLocalTarball(bundledTgz, bundledSha)
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
    } else {
      await installKernel()
    }
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
    // Drop the bridge first: it is a listening socket, and a quit path that
    // keeps it open while the server drains would leave the port bound.
    const stopBridge = async (): Promise<void> => {
      const bridge = desktopBridge
      desktopBridge = null
      await bridge?.close()
    }
    if (server?.isRunning) {
      event.preventDefault()
      void stopBridge().then(() => server!.stop()).finally(() => {
        destroyTray()
        app.exit(0)
      })
    } else {
      void stopBridge()
    }
  })

  app.on('window-all-closed', () => {
    // Tray app: keep running. Quit via the tray menu.
  })
}
