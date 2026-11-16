import { Menu, Tray, app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { APP_NAME } from '../shared/constants'
import { t } from '../shared/locale'

export interface TrayCallbacks {
  onOpen: () => void
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
  /**
   * Whether a verified configuration checkpoint exists right now. The row is
   * only offered when the click would act — the same principle the failure
   * card applies to its own restore button (see `offerStartupRecovery`).
   */
  canRestoreConfig: () => boolean
  /** True while the shell runs in safe mode; picks the toggle's menu label. */
  isSafeMode: () => boolean
  /** Roll the shell app back to the previous recorded version. */
  onRollbackApp: () => void
  /**
   * Whether a rollback target exists right now (the updater's own rule, read
   * synchronously at menu build). Like `canRestoreConfig`, keeps a row whose
   * only outcome would be a refusal sentence out of the menu.
   */
  canRollbackApp: () => boolean
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
  return [
    { label: t('tray.openApp', { app: APP_NAME }), click: callbacks.onOpen },
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
    { label: t('tray.restartServer'), click: callbacks.onRestartServer },
    { type: 'separator' },
    // The low-frequency escape hatches live one level down: the top level is
    // the daily set, and three similar-looking "go back" rows side by side
    // asked the user to tell app rollback, config restore and safe mode apart
    // at a glance. The tray still carries them all — it is the only surface
    // left when the window never opened.
    { label: t('tray.recovery'), submenu: recoverySubmenu(callbacks) },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() },
  ]
}

/**
 * The recovery submenu: safe mode always (so the submenu is never empty), the
 * two restores only while the shell can perform them. Update checks are NOT
 * here: their progress and confirm dialogs draw in the window, the About page
 * carries the same buttons, and both channels check on their own schedule.
 */
function recoverySubmenu(callbacks: TrayCallbacks): Electron.MenuItemConstructorOptions[] {
  const rows: Electron.MenuItemConstructorOptions[] = [
    // Mutually exclusive by state: toggling safe mode relaunches the app, so
    // the label never needs live-refreshing within one session.
    callbacks.isSafeMode()
      ? { label: t('tray.exitSafeMode'), click: callbacks.onToggleSafeMode }
      : { label: t('tray.enterSafeMode'), click: callbacks.onToggleSafeMode },
  ]
  if (callbacks.canRestoreConfig()) {
    rows.push({ label: t('tray.restoreConfig'), click: callbacks.onRestoreConfig })
  }
  // The predicate owns the platform and dev refusals (see `syncRollbackTarget`
  // in the updater, which mirrors the click), so the template stays pure.
  if (callbacks.canRollbackApp()) {
    rows.push({ label: t('tray.rollbackApp'), click: callbacks.onRollbackApp })
  }
  return rows
}

/**
 * Rebuild the tray menu (e.g. after the active kernel appeared — which is what
 * decides whether the terminal row is clickable — or after a recovery
 * predicate changed: a checkpoint capture, a version-history write). No-op
 * before createTray.
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
