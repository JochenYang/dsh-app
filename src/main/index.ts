import { app, BrowserWindow, dialog } from 'electron'
import net from 'node:net'
import path from 'node:path'
import { KernelManager } from '../kernel/manager'
import { DshServer } from './server'
import { createMainWindow, createSetupWindow } from './window'
import { createTray, destroyTray, setTrayTooltip } from './tray'
import { initShellUpdater, checkShellUpdate } from './updater'
import { broadcast, registerIpc, type AppController } from './ipc'
import { IPC, KERNEL_CHECK_INTERVAL_MS } from '../shared/constants'
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
  broadcastStatus({ phase: 'starting', message: 'Starting dsh server…', progress: null })
  const port = await findFreePort()
  try {
    await server.start(kernel.getServerSpec(), port)
  } catch (err) {
    await handleServerDown(`failed to start: ${(err as Error).message}`)
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
  broadcastStatus({ phase: 'ready', message: 'Ready', progress: null })
}

async function handleServerDown(reason: string): Promise<void> {
  if (quitting) return
  restartAttempts += 1
  console.error(`[server] down: ${reason} (attempt ${restartAttempts})`)
  broadcastStatus({ phase: 'error', message: `Server ${reason}`, progress: null, error: reason })

  if (restartAttempts >= 2 && !isDev) {
    const rolledBack = await kernel.rollback()
    if (rolledBack) {
      restartAttempts = 0
      void dialog.showMessageBox({
        type: 'warning',
        title: 'DSH App',
        message: `The kernel update failed to start. Rolled back to dsh ${rolledBack.manifest.dshVersion}.`,
      })
      await startServerAndOpenWindow()
      return
    }
  }

  if (restartAttempts >= 3) {
    void dialog.showMessageBox({
      type: 'error',
      title: 'DSH App',
      message: 'The dsh server could not be started. The app will quit.',
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
    broadcastStatus({ phase: 'error', message: 'Install failed', progress: null, error: (err as Error).message })
  }
}

async function checkKernelUpdate(manual: boolean): Promise<void> {
  try {
    const result = await kernel.checkForUpdate()
    if (!result.available) {
      if (manual) {
        void dialog.showMessageBox({
          type: 'info',
          title: 'DSH App',
          message: `The kernel is up to date (dsh ${result.current ?? 'unknown'}).`,
        })
      }
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Kernel update available',
      message: `dsh ${result.current} → ${result.latest}`,
      detail: 'Download and activate now? The server will restart.',
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0 && result.latest) await applyKernelUpdate(result.latest)
  } catch (err) {
    if (manual) void dialog.showMessageBox({ type: 'error', title: 'DSH App', message: `Update check failed: ${(err as Error).message}` })
  }
}

async function applyKernelUpdate(version: string): Promise<void> {
  try {
    const installed = await kernel.installVersion(version)
    broadcastStatus({ phase: 'installing', message: `Activated dsh ${installed.manifest.dshVersion}`, progress: null })
    await startServerAndOpenWindow()
  } catch (err) {
    void dialog.showMessageBox({ type: 'error', title: 'DSH App', message: `Kernel update failed: ${(err as Error).message}` })
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
    onExit: (code, signal) => void handleServerDown(`exited (code ${code ?? '?'}, signal ${signal ?? '?'})`),
    onLog: (line) => console.log('[server]', line),
  })

  registerIpc(controller)

  const installed = isDev || (await kernel.isInstalled())
  if (installed) {
    await startServerAndOpenWindow()
  } else {
    // First run: show the setup window; it drives install through IPC.
    setupWindow = createSetupWindow()
    broadcastStatus({ phase: 'idle', message: 'DSH App is not installed yet.', progress: null })
  }

  createTray({
    onOpen: () => {
      if (!mainWindow) void startServerAndOpenWindow()
      else mainWindow.show()
    },
    onCheckKernelUpdate: () => void checkKernelUpdate(true),
    onCheckAppUpdate: () => checkShellUpdate(true),
    onRestartServer: () => void startServerAndOpenWindow(),
  })

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
      mainWindow.show()
      mainWindow.focus()
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
