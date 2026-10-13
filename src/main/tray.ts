import { Menu, Tray, app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { APP_NAME } from '../shared/constants'
import { t } from '../shared/locale'

export interface TrayCallbacks {
  onOpen: () => void
  onCheckKernelUpdate: () => void
  onCheckAppUpdate: () => void
  onRestartServer: () => void
  /**
   * Open the user's own terminal with the shell's private `dsh`/`pnpm`/`node`
   * shim in front of its `PATH` (see `terminal.ts`). Main-process work: no
   * renderer channel is involved.
   */
  onOpenTerminal: () => void
  /**
   * Whether that terminal could open at all right now — the shell's answer to
   * `kernelCliUsable(kernelCliPath())`, the same question the click's plan asks.
   * `false` greys the row out; it is read when the menu is BUILT, so a state
   * change needs a rebuild (see `updateTrayMenu`).
   */
  canOpenTerminal: () => boolean
  /** Write/clear the safe-mode marker, then relaunch the app. */
  onToggleSafeMode: () => void
  /**
   * Put the newest configuration checkpoint back and relaunch (see
   * `config-checkpoint.ts`). The escape hatch for a configuration that fails the
   * boot, reachable while the failure card is not on screen.
   */
  onRestoreConfig: () => void
  /** True while the shell runs in safe mode; picks the toggle's menu label. */
  isSafeMode: () => boolean
  /** Roll the shell app back to the previous recorded version. */
  onRollbackApp: () => void
  /** Current kernel version for the tray menu label, or null when unknown. */
  getCurrentVersion: () => string | null
}

let tray: Tray | null = null
let savedCallbacks: TrayCallbacks | null = null
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

  savedCallbacks = callbacks
  tray.setContextMenu(buildTrayMenu(callbacks))
  return tray
}

/** Build the tray menu, stamping the current kernel version into its label. */
function buildTrayMenu(callbacks: TrayCallbacks): Electron.Menu {
  return Menu.buildFromTemplate(trayMenuTemplate(callbacks))
}

/**
 * The menu's template: labels, order and which rows are clickable.
 *
 * Pure and exported for the test suite — it reads the callbacks and the locale
 * table and nothing else, builds no `Menu` and holds no state, so a menu whose
 * rows depend on the machine (the kernel version, the terminal's availability)
 * can be asserted without an Electron process. {@link buildTrayMenu} is the
 * half that needs Electron.
 *
 * @param callbacks - the shell's answers, read NOW (the template is a snapshot).
 * @returns the template `Menu.buildFromTemplate` consumes.
 */
export function trayMenuTemplate(callbacks: TrayCallbacks): Electron.MenuItemConstructorOptions[] {
  const version = callbacks.getCurrentVersion()
  const kernelLabel = version
    ? t('tray.checkKernelUpdateWithVersion', { version })
    : t('tray.checkKernelUpdate')
  return [
    { label: t('tray.openApp', { app: APP_NAME }), click: callbacks.onOpen },
    { type: 'separator' },
    { label: kernelLabel, click: callbacks.onCheckKernelUpdate },
    { label: t('tray.checkAppUpdate'), click: callbacks.onCheckAppUpdate },
    { type: 'separator' },
    { label: t('tray.restartServer'), click: callbacks.onRestartServer },
    // Same group as the restart/rollback rows: this is the "work on the running
    // installation" set, and the terminal it opens is the CLI fallback for a
    // plugin operation the market could not complete.
    {
      label: t('tray.openTerminal'),
      click: callbacks.onOpenTerminal,
      // Greyed while there is no kernel CLI to hand the terminal: the click's
      // own plan refuses that state (see `kernelCliUsable`), so a clickable row
      // would only be a sentence in a dialog. Every other failure — no Node, no
      // console, an unwritable shim directory — is decided later and still
      // reports itself.
      enabled: callbacks.canOpenTerminal(),
    },
    // Windows-only: rollback drives the custom shell-update chain (tagged
    // release assets + latest.yml + NSIS wizard); macOS/Linux update through
    // electron-updater, which has no per-release asset contract to lean on.
    ...(process.platform === 'win32'
      ? [{ label: t('tray.rollbackApp'), click: callbacks.onRollbackApp }]
      : []),
    { type: 'separator' },
    // Mutually exclusive by state: toggling safe mode relaunches the app, so
    // the label never needs live-refreshing within one session.
    callbacks.isSafeMode()
      ? { label: t('tray.exitSafeMode'), click: callbacks.onToggleSafeMode }
      : { label: t('tray.enterSafeMode'), click: callbacks.onToggleSafeMode },
    // The other configuration-level escape hatch, in the group that owns the
    // running installation: safe mode skips the suite overlay, this puts the
    // user's own files back. Always present — whether a checkpoint exists is a
    // question the click answers, with a sentence rather than a dead row.
    { label: t('tray.restoreConfig'), click: callbacks.onRestoreConfig },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() },
  ]
}

/**
 * Rebuild the tray menu (e.g. after a kernel update changed the version
 * stamped into the menu label, or after the active kernel appeared — which is
 * what decides whether the terminal row is clickable). No-op before createTray.
 */
export function updateTrayMenu(): void {
  if (!tray || !savedCallbacks) return
  tray.setContextMenu(buildTrayMenu(savedCallbacks))
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  savedCallbacks = null
}

export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text)
}
