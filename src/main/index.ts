import { app, BrowserWindow, dialog } from 'electron'
import net from 'node:net'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { KernelManager } from '../kernel/manager'
import { DshServer } from './server'
import { devSuiteSources, prepareBrandSuite, prodSuiteSources } from './brand-suite'
import { createMainWindow, createSetupWindow } from './window'
import { createTray, destroyTray, setTrayTooltip } from './tray'
import { initShellUpdater, checkShellUpdate } from './updater'
import { broadcast, registerIpc, type AppController } from './ipc'
import { IPC, KERNEL_CHECK_INTERVAL_MS, DEFAULT_HTTP_HOST } from '../shared/constants'
import type { KernelInfoPayload, KernelStatusPayload } from '../shared/types'

// ---------------------------------------------------------------- config

const isDev = process.env.DSH_APP_DEV === '1'
const devCheckoutDir =
  process.env.DSH_APP_DEV_RUNTIME ??
  (isDev ? path.resolve(process.cwd(), '..', 'deepseek-harness') : undefined)
const channel = process.env.DSH_APP_CHANNEL === 'beta' ? 'beta' : 'stable'
const artifactOwner = process.env.DSH_APP_ARTIFACT_OWNER ?? 'YOUR_GITHUB_OWNER'
const artifactRepo = process.env.DSH_APP_ARTIFACT_REPO ?? 'dsh-app'

// ------------------------------------------------------------------ state

let kernel: KernelManager
let server: DshServer
let mainWindow: BrowserWindow | null = null
let setupWindow: BrowserWindow | null = null
let quitting = false
let restartAttempts = 0

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
  broadcast(setupWindow, IPC.kernelStatus, status)
  broadcast(mainWindow, IPC.kernelStatus, status)
  setTrayTooltip(status.phase === 'ready' ? `DSH App — dsh ${kernel.getCurrent()?.manifest.dshVersion ?? ''}` : `DSH App — ${status.message}`)
}

// ------------------------------------------------------------- lifecycle

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
      // Tray app: closing the window hides it instead of quitting.
      if (!quitting) {
        event.preventDefault()
        mainWindow?.hide()
      }
    })
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  } else {
    void mainWindow.loadURL(url)
    mainWindow.show()
  }
  setupWindow?.close()
  setupWindow = null
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
      restartAttempts = 0
      void dialog.showMessageBox({
        type: 'warning',
        title: 'DSH App',
        message: `内核更新启动失败，已回滚到 dsh ${rolledBack.manifest.dshVersion}。`,
      })
      await startServerAndOpenWindow()
      return
    }
    // No previous version to roll back to (e.g. a broken first install from
    // an earlier release). Try reinstalling from the bundled tarball before
    // giving up — this recovers users who upgraded over a bad v0.1.1 kernel.
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    if (existsSync(bundledTgz) && existsSync(bundledSha)) {
      try {
        console.log('[kernel] server failed and no rollback available; reinstalling bundled kernel')
        await kernel.installFromLocalTarball(bundledTgz, bundledSha)
        restartAttempts = 0
        await startServerAndOpenWindow()
        return
      } catch (err) {
        console.error('[kernel] bundled reinstall failed:', (err as Error).message)
      }
    }
  }

  if (restartAttempts >= 3) {
    void dialog.showMessageBox({
      type: 'error',
      title: 'DSH App',
      message: 'dsh 服务无法启动，应用即将退出。',
    })
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
              : `内核已是最新版本（dsh ${result.current ?? '未知'}）。`
        void dialog.showMessageBox({ type: 'info', title: 'DSH App', message })
      }
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '内核更新可用',
      message: `dsh ${result.current} → ${result.latest}`,
      detail: '现在下载并激活？服务将会重启。',
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0 && result.latest) await applyKernelUpdate(result.latest)
  } catch (err) {
    if (manual) void dialog.showMessageBox({ type: 'error', title: 'DSH App', message: `更新检查失败：${(err as Error).message}` })
  }
}

async function applyKernelUpdate(version: string): Promise<void> {
  try {
    const installed = await kernel.installVersion(version)
    broadcastStatus({ phase: 'installing', message: `已激活 dsh ${installed.manifest.dshVersion}`, progress: null })
    await startServerAndOpenWindow()
  } catch (err) {
    void dialog.showMessageBox({ type: 'error', title: 'DSH App', message: `内核更新失败：${(err as Error).message}` })
  }
}

function getKernelInfo(): KernelInfoPayload {
  return {
    current: kernel.getCurrent(),
    available: null,
    phase: 'idle',
  }
}

const controller: AppController = {
  kernel: undefined as unknown as KernelManager,
  installKernel,
  applyKernelUpdate: () => applyKernelUpdate(''),
  checkKernelUpdate,
  getKernelInfo,
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
  controller.kernel = kernel

  server = new DshServer({
    onExit: (code, signal) => void handleServerDown(`已退出（code ${code ?? '?'}, signal ${signal ?? '?'})`),
    onLog: (line) => console.log('[server]', line),
  })

  registerIpc(controller)

  // Create the tray before any server/kernel work so it persists even when
  // the server fails to start (reinstall/retry loops). Otherwise the user
  // has no way to interact with the app while the main window is absent.
  createTray({
    onOpen: () => {
      if (!mainWindow) void startServerAndOpenWindow()
      else mainWindow.show()
    },
    onCheckKernelUpdate: () => void checkKernelUpdate(true),
    onCheckAppUpdate: () => checkShellUpdate(true),
    onRestartServer: () => void startServerAndOpenWindow(),
    getCurrentVersion: () => kernel.getCurrent()?.manifest.dshVersion ?? null,
  })

  const installed = isDev || (await kernel.isInstalled())
  if (installed) {
    // Initialize this.current so checkForUpdate / getCurrentVersion work.
    // In dev mode this reads the checkout manifest; in artifact mode it
    // loads the on-disk kernel. init() reuses the existing install and only
    // reinstalls when the active dir is missing (isInstalled already ruled
    // that out), so this is a local read, not a network fetch.
    await kernel.init()
    await startServerAndOpenWindow()
  } else {
    // First run. Prefer a kernel tarball bundled inside the app's resources
    // (shipped with the installer) so the user need not download it; only
    // fall back to the online setup wizard when no bundle is present.
    const bundledTgz = path.join(process.resourcesPath, 'kernel', 'kernel.tgz')
    const bundledSha = `${bundledTgz}.sha512`
    if (!isDev && existsSync(bundledTgz) && existsSync(bundledSha)) {
      // Defer showing the window: a fast local activation may finish before
      // the grace period, so the user sees the main window directly with no
      // intermediate "install" flash.
      setupWindow = createSetupWindow(true)
      try {
        await kernel.installFromLocalTarball(bundledTgz, bundledSha)
        await startServerAndOpenWindow()
      } catch (err) {
        // Bundled activation failed — make sure the window is visible for the
        // online fallback, then fall through to online install.
        setupWindow?.show()
        broadcastStatus({ phase: 'error', message: '内置内核初始化失败，改为在线安装', progress: null, error: (err as Error).message })
        await installKernel()
      }
    } else {
      // No bundled kernel: online setup wizard, driven by the user.
      setupWindow = createSetupWindow()
      broadcastStatus({ phase: 'idle', message: 'DSH App 尚未安装。', progress: null })
    }
  }

  initShellUpdater()
  setTimeout(() => checkShellUpdate(false), 10_000)
  setInterval(() => {
    if (!quitting && !isDev) void checkKernelUpdate(false)
  }, KERNEL_CHECK_INTERVAL_MS)
}

// ---------------------------------------------------------------- app

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
