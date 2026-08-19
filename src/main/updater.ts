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
      title: `${APP_NAME} 更新可用`,
      message: `发现新版本 ${APP_NAME}（${info.version}）。`,
      detail: '现在下载并安装？应用将在完成后重启。',
      buttons: ['下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} 更新就绪`,
      message: '更新已下载完成，将在退出时安装。',
      buttons: ['立即重启', '稍后'],
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
      void dialog.showMessageBox({ type: 'error', title: APP_NAME, message: `更新检查失败：${err.message}` })
    }
  })
}
