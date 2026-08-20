import { Menu, Tray, app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { APP_NAME } from '../shared/constants'

export interface TrayCallbacks {
  onOpen: () => void
  onCheckKernelUpdate: () => void
  onCheckAppUpdate: () => void
  onRestartServer: () => void
  /** Current kernel version for the tray menu label, or null when unknown. */
  getCurrentVersion: () => string | null
}

let tray: Tray | null = null

/** System tray with the essential lifecycle actions. */
export function createTray(callbacks: TrayCallbacks): Tray {
  if (tray) return tray
  // In dev: resources/icon.png (project root buildResources).
  // In production: the icon is bundled inside app.asar at dist/icon.png
  // (copied by scripts/copy-static.mjs), so __dirname/../icon.png resolves it.
  const devIcon = path.join(__dirname, '..', '..', 'resources', 'icon.png')
  const prodIcon = path.join(__dirname, '..', 'icon.png')
  const icon = existsSync(prodIcon) ? prodIcon : devIcon
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)

  // Double-click to restore/show the main window
  tray.on('double-click', callbacks.onOpen)

  const version = callbacks.getCurrentVersion()
  const kernelLabel = version ? `检查内核更新…（当前 dsh ${version}）` : '检查内核更新…'
  const menu = Menu.buildFromTemplate([
    { label: `打开 ${APP_NAME}`, click: callbacks.onOpen },
    { type: 'separator' },
    { label: kernelLabel, click: callbacks.onCheckKernelUpdate },
    { label: '检查应用更新…', click: callbacks.onCheckAppUpdate },
    { type: 'separator' },
    { label: '重启服务', click: callbacks.onRestartServer },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text)
}
