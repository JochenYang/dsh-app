import { BrowserWindow, ipcMain } from 'electron'
import type { KernelInfoPayload } from '../shared/types'
import { IPC } from '../shared/constants'
import type { KernelManager } from '../kernel/manager'

/**
 * The subset of app control the renderers (setup window, menus) can drive.
 * Implemented by the controller in src/main/index.ts to avoid circular imports.
 */
export interface AppController {
  kernel: KernelManager
  installKernel: () => Promise<void>
  applyKernelUpdate: () => Promise<void>
  checkKernelUpdate: (manual: boolean) => Promise<void>
  getKernelInfo: () => KernelInfoPayload
}

export function registerIpc(controller: AppController): void {
  ipcMain.handle(IPC.kernelInstall, async () => {
    await controller.installKernel()
  })
  ipcMain.handle(IPC.kernelInfo, () => controller.getKernelInfo())
  ipcMain.handle(IPC.kernelUpdateCheck, async () => {
    await controller.checkKernelUpdate(true)
  })
  ipcMain.handle(IPC.kernelApplyUpdate, async () => {
    await controller.applyKernelUpdate()
  })
  ipcMain.handle(IPC.kernelCancel, () => controller.kernel.requestCancel())
}

/** Send a payload to a window if it is still alive. */
export function broadcast(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
