import { Menu, Tray, app } from 'electron'
import path from 'node:path'
import { APP_NAME } from '../shared/constants'

export interface TrayCallbacks {
  onOpen: () => void
  onCheckKernelUpdate: () => void
  onCheckAppUpdate: () => void
  onRestartServer: () => void
}

let tray: Tray | null = null

/** System tray with the essential lifecycle actions. */
export function createTray(callbacks: TrayCallbacks): Tray {
  if (tray) return tray
  const icon = path.join(__dirname, '..', '..', 'resources', 'icon.png')
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)
  const menu = Menu.buildFromTemplate([
    { label: 'Open DSH App', click: callbacks.onOpen },
    { type: 'separator' },
    { label: 'Check for kernel update…', click: callbacks.onCheckKernelUpdate },
    { label: 'Check for app update…', click: callbacks.onCheckAppUpdate },
    { type: 'separator' },
    { label: 'Restart server', click: callbacks.onRestartServer },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
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
