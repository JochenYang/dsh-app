import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { APP_NAME } from '../shared/constants'

let initialized = false

/**
 * Shell update channel (electron-updater → GitHub Releases).
 * This updates ONLY the Electron shell — the dsh kernel is updated by the
 * KernelManager (see src/kernel/manager.ts). The two channels are decoupled
 * so upstream dsh releases never require a new shell build.
 */
export function initShellUpdater(): void {
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} update available`,
      message: `A new version of ${APP_NAME} is available (${info.version}).`,
      detail: 'Download and install now? The app will restart afterwards.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} update ready`,
      message: 'The update has been downloaded and will be installed on quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (err) => {
    console.error('[shell-updater]', err.message)
  })
}

export function checkShellUpdate(manual = false): void {
  if (!initialized) initShellUpdater()
  void autoUpdater.checkForUpdates().catch((err) => {
    if (manual) {
      void dialog.showMessageBox({ type: 'error', title: APP_NAME, message: `Update check failed: ${err.message}` })
    }
  })
}
