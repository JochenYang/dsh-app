import { app, BrowserWindow, dialog } from 'electron'
import net from 'node:net'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { KernelManager } from '../kernel/manager'
import { DshServer } from './server'
import { devSuiteSources, prepareBrandSuite, prodSuiteSources } from './brand-suite'
import { createMainWindow, showKernelProgress, showToastWhenLoaded, showUpdateToast } from './window'
import { inFrameDialogScript } from './in-frame-dialog'
import { createTray, destroyTray, setTrayTooltip } from './tray'
import { initShellUpdater, checkShellUpdate, consumeUpdaterInstallResult } from './updater'
import { KERNEL_CHECK_INTERVAL_MS, DEFAULT_HTTP_HOST } from '../shared/constants'
import type { KernelStatusPayload } from '../shared/types'

// ---------------------------------------------------------------- config

const isDev = process.env.DSH_APP_DEV === '1'
const devCheckoutDir =
  process.env.DSH_APP_DEV_RUNTIME ??
  (isDev ? path.resolve(process.cwd(), '..', 'deepseek-harness') : undefined)
const channel =
  process.env.DSH_APP_CHANNEL === 'alpha' ? 'alpha'
  : process.env.DSH_APP_CHANNEL === 'beta' ? 'beta'
  : 'stable'
const artifactOwner = process.env.DSH_APP_ARTIFACT_OWNER ?? 'JochenYang'
const artifactRepo = process.env.DSH_APP_ARTIFACT_REPO ?? 'dsh-app'

// ------------------------------------------------------------------ state

let kernel: KernelManager
let server: DshServer
let mainWindow: BrowserWindow | null = null
let quitting = false
let restartAttempts = 0
let bundledReinstallTried = false

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

function broadcastStatus(status: KernelStatusPayload): void {
  setTrayTooltip(status.phase === 'ready' ? `DSH APP — dsh ${kernel.getCurrent()?.manifest.dshVersion ?? ''}` : `DSH APP — ${status.message}`)
  showKernelProgress(mainWindow, status)
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
  if (win !== null && !win.isDestroyed()) {
    try {
      const choice: unknown = await win.webContents.executeJavaScript(inFrameDialogScript(config))
      if (typeof choice === 'string') return map(choice)
    } catch {
      // Page not answerable (crashed, mid-navigation, or before first load):
      // fall through to the native dialog.
    }
  }
  const prompt = win === null
    ? dialog.showMessageBox(native)
    : dialog.showMessageBox(win, native)
  const { response } = await prompt
  return map('', response)
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
  await promptThemedConfirm(
    win,
    { title, message, buttons: [{ label: '确定', value: 'ok', primary: true }], cancelValue: 'ok', enterValue: 'ok' },
    { type, title, message, buttons: ['确定'], defaultId: 0, cancelId: 0, noLink: true },
    () => undefined,
  )
}

/**
 * Prompt the close-choice dialog inside the loaded dsh page (themed modal via
 * CLOSE_DIALOG_SCRIPT) with a native showMessageBox fallback. Returns the
 * user's choice, or 'cancel' when neither channel can produce an answer
 * (e.g. the page never loaded) — the window then simply stays open.
 * The in-window script resolves to 'tray' | 'quit' | 'cancel'; the native
 * box maps its button indexes identically.
 */
async function promptCloseChoice(win: BrowserWindow | null): Promise<'tray' | 'quit' | 'cancel'> {
  return promptThemedConfirm(
    win,
    {
      title: '关闭 DSH APP',
      message: '关闭窗口后要如何运行？',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '退出程序', value: 'quit' },
        { label: '最小化到托盘', value: 'tray', primary: true },
      ],
      cancelValue: 'cancel',
      enterValue: 'tray',
    },
    {
      type: 'question',
      title: '关闭 DSH APP',
      message: '关闭窗口后要如何运行？',
      buttons: ['最小化到托盘', '退出程序', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    },
    (value, nativeResponse) => {
      if (value !== '') return value as 'tray' | 'quit' | 'cancel'
      return nativeResponse === 0 ? 'tray' : nativeResponse === 1 ? 'quit' : 'cancel'
    },
  )
}

async function startServerAndOpenWindow(): Promise<void> {
  if (quitting) return
  broadcastStatus({ phase: 'starting', message: '正在启动 dsh 服务…', progress: null })
  const port = await findFreePort()
  // Brand suite wiring: profile-dir module links + the loader overlay that
  // inserts the brand rows. An older kernel without the suite plugins boots
  // vanilla (empty array).
  const suiteSources = isDev ? devSuiteSources() : prodSuiteSources(kernel.getCurrentDir())
  const overlays = await prepareBrandSuite(suiteSources)
  try {
    await server.start(kernel.getServerSpec(), port, DEFAULT_HTTP_HOST, overlays)
  } catch (err) {
    await handleServerDown(`启动失败：${(err as Error).message}`)
    return
  }
  const url = server.serverUrl
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
    void mainWindow.loadURL(url)
    mainWindow.show()
  }
  restartAttempts = 0
  void kernel.cleanup()
  broadcastStatus({ phase: 'ready', message: '就绪', progress: null })
}

async function handleServerDown(reason: string): Promise<void> {
  if (quitting) return
  restartAttempts += 1
  console.error(`[server] down: ${reason} (attempt ${restartAttempts})`)
  broadcastStatus({ phase: 'error', message: `服务${reason}`, progress: null, error: reason })

  if (restartAttempts >= 2 && !isDev) {
    const rolledBack = await kernel.rollback()
    if (rolledBack) {
      // No reset here: a recovery action that boots once can still crash on
      // the next start (e.g. a broken user patch layer). Only a genuinely
      // ready server (above) resets the counter, so persistent failures
      // terminate instead of looping forever.
      void promptNoticeThemed(mainWindow, 'warning', 'DSH APP', `内核更新启动失败，已回滚到 dsh ${rolledBack.manifest.dshVersion}。`)
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
    void promptNoticeThemed(mainWindow, 'error', 'DSH APP', 'dsh 服务无法启动，应用即将退出。可查看安装目录 logs 文件夹中最新的 dsh-server 日志定位原因。')
    app.quit()
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
    broadcastStatus({ phase: 'error', message: '安装失败', progress: null, error: (err as Error).message })
  }
}

async function checkKernelUpdate(manual: boolean): Promise<void> {
  try {
    const result = await kernel.checkForUpdate()
    if (!result.available) {
      if (manual) {
        // Dev mode can detect a newer version but cannot auto-install; tell
        // the user what's available rather than a flat "up to date".
        const message = result.reason === 'dev mode update available'
          ? `开发模式下内核固定为本地源码，不支持自动更新。\n检测到新版本：dsh ${result.current} → ${result.latest}。\n请以正式安装方式启动后更新，或手动拉取源码。`
          : result.reason === 'dev mode'
            ? `开发模式下内核固定为本地源码，不支持在线更新。\n当前版本：dsh ${result.current ?? '未知'}（已是最新）。`
            : result.reason === 'registry unreachable'
              ? '无法连接更新源，请检查网络后重试。'
              : result.reason === 'artifact pending'
                ? `检测到新版本 dsh ${result.latest}，但安装包尚未发布。\n将保持当前版本（dsh ${result.current ?? '未知'}），请稍后再试。`
                : result.reason === 'github unreachable'
                  ? '无法连接更新源（GitHub），请检查网络或稍后重试。'
                  : result.reason === 'install in progress'
                    ? '内核更新或安装正在进行中，请稍候再检查。'
                    : `内核已是最新版本（dsh ${result.current ?? '未知'}）。`
        void promptNoticeThemed(mainWindow, 'info', 'DSH APP', message)
      }
      return
    }
    if (!manual) {
      // Background checks never pop a modal; a non-intrusive in-window toast
      // surfaces the finding (the user installs from the tray menu).
      showUpdateToast(mainWindow, `发现新版本 dsh ${result.latest}，可在托盘菜单中更新`, 'progress', 5_000)
      return
    }
    const proceed = await promptThemedConfirm(
      mainWindow,
      {
        title: '内核更新可用',
        message: `dsh ${result.current} → ${result.latest}`,
        detail: '现在下载并激活？服务将会重启。',
        buttons: [
          { label: '稍后', value: 'later' },
          { label: '立即更新', value: 'update', primary: true },
        ],
        cancelValue: 'later',
        enterValue: 'update',
      },
      {
        type: 'info',
        title: '内核更新可用',
        message: `dsh ${result.current} → ${result.latest}`,
        detail: '现在下载并激活？服务将会重启。',
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      },
      (value, nativeResponse) => {
        if (value === 'update') return true
        if (value === 'later') return false
        return nativeResponse === 0
      },
    )
    if (proceed && result.latest) await applyKernelUpdate(result.latest)
  } catch (err) {
    if (manual) void promptNoticeThemed(mainWindow, 'error', 'DSH APP', `更新检查失败：${(err as Error).message}`)
  }
}

async function applyKernelUpdate(version: string): Promise<void> {
  try {
    const installed = await kernel.installVersion(version)
    broadcastStatus({ phase: 'installing', message: `已激活 dsh ${installed.manifest.dshVersion}`, progress: null })
    await startServerAndOpenWindow()
    // The server restart's own starting→ready cycle clears the card, so the
    // one-shot success toast lands afterwards and is visible for 3 s. Wait
    // for the reloaded page first — injecting mid-loadURL would wipe the
    // toast with the old document.
    void showToastWhenLoaded(mainWindow, `内核已更新到 dsh ${installed.manifest.dshVersion}`, 'success', 3_000)
  } catch (err) {
    void promptNoticeThemed(mainWindow, 'error', 'DSH APP', `内核更新失败：${(err as Error).message}`)
  }
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
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
    log: (message) => console.log(message),
  })

  server = new DshServer({
    onExit: (code, signal) => void handleServerDown(`已退出（code ${code ?? '?'}, signal ${signal ?? '?'})`),
    onLog: (line) => console.log('[server]', line),
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
    getCurrentVersion: () => kernel.getCurrent()?.manifest.dshVersion ?? null,
  })

  // load() reads the on-disk kernel (or the dev checkout manifest) into
  // this.current — no network or install work. A null result means first run
  // or a broken install, handled below by bundled/online activation.
  const current = await kernel.load()
  if (current) {
    // Bundled-runtime drift check. The versioned kernel dir name is
    // dsh-<v>+suite-<v>; when a NEW shell ships a same-version kernel whose
    // content changed (the brand suite gained a plugin), an existing
    // same-named directory is reused verbatim and the new content never
    // lands — linkSuitePlugins then bails on the missing member and the whole
    // suite silently boots vanilla. Re-activate the bundled tarball whenever
    // its verified hash differs from the recorded one and its version is not
    // older than the installed kernel (a newer-dsh install stays online).
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    const bundledManifestPath = path.join(process.resourcesPath, 'kernel', 'manifest.json')
    if (!isDev && existsSync(bundledTgz) && existsSync(bundledSha) && existsSync(bundledManifestPath)) {
      try {
        const bundledManifest = JSON.parse(readFileSync(bundledManifestPath, 'utf8')) as {
          dshVersion?: string
          platform?: string
          arch?: string
        }
        const samePlatform = bundledManifest.platform === current.manifest.platform
          && bundledManifest.arch === current.manifest.arch
        const sameVersion = bundledManifest.dshVersion === current.manifest.dshVersion
        const newerVersion = bundledManifest.dshVersion !== undefined
          && semver.gt(bundledManifest.dshVersion, current.manifest.dshVersion)
        const contentDiffers = current.sha512 !== readFileSync(bundledSha, 'utf8').trim().toLowerCase()
        if (samePlatform && contentDiffers && (sameVersion || newerVersion)) {
          console.log('[kernel] bundled content differs from active install; re-activating')
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
    // All of this runs silently in the background — the main window opens once
    // the server is healthy, with no intermediate setup window.
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    if (!isDev && existsSync(bundledTgz) && existsSync(bundledSha)) {
      try {
        await kernel.installFromLocalTarball(bundledTgz, bundledSha)
        await startServerAndOpenWindow()
      } catch (err) {
        console.error(`bundled kernel install failed: ${(err as Error).message}; falling back to online install`)
        await installKernel()
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      // Window was closed (hidden/destroyed) — recreate it
      void startServerAndOpenWindow()
    }
  })

  void app.whenReady().then(boot)

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', (event) => {
    if (server?.isRunning) {
      event.preventDefault()
      void server.stop().finally(() => {
        destroyTray()
        app.exit(0)
      })
    }
  })

  app.on('window-all-closed', () => {
    // Tray app: keep running. Quit via the tray menu.
  })
}
