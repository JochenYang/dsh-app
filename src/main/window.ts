import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { DEFAULT_HTTP_HOST } from '../shared/constants'

const MAIN_WINDOW_OPTS = {
  width: 1280,
  height: 800,
  minWidth: 900,
  minHeight: 600,
  title: 'DSH App',
  autoHideMenuBar: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // No preload for the dsh web UI: it is a remote-origin page with its own
    // security model. All desktop capabilities flow through the local server.
  },
} as const

/**
 * Main window: loads the local dsh web UI. All navigation is confined to the
 * local server origin; everything else opens in the system browser.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({ ...MAIN_WINDOW_OPTS, show: false })
  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    const allowed = new URL(target)
    if (allowed.hostname !== DEFAULT_HTTP_HOST) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  void win.loadURL(url)
  return win
}

/**
 * Setup window: shown before the kernel is ready (first run, repair,
 * update install). A tiny static page wired through a contextBridge preload.
 */
export function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 380,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'DSH App — Setup',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'static', 'setup-preload.js'),
    },
  })
  void win.loadFile(path.join(__dirname, '..', 'static', 'setup.html'))
  return win
}
