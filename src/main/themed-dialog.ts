import { BrowserWindow, dialog } from 'electron'

/**
 * Shared themed-dialog fallback (used by the shell boot flow and the shell
 * updater): try the in-window themed script first, fall back to a native
 * message box when the page cannot answer (crashed, mid-navigation, or
 * before first load). Callers build the in-page script with
 * in-frame-dialog.ts and only share the injection/fallback mechanics here.
 */

/** Pick the window a dialog should attach to. */
export function resolveDialogWindow(preferred: BrowserWindow | null): BrowserWindow | null {
  if (preferred !== null && !preferred.isDestroyed()) return preferred
  const focused = BrowserWindow.getFocusedWindow()
  if (focused !== null && !focused.isDestroyed()) return focused
  const first = BrowserWindow.getAllWindows()[0]
  return first !== undefined && !first.isDestroyed() ? first : null
}

/**
 * Run a prebuilt in-page dialog script with a native fallback.
 * @param win - preferred host window (null falls back to focused/any window).
 * @param script - the in-page script source; must resolve to a string choice.
 * @param native - native fallback options; invoked only when injection fails.
 * @param map - map the resulting value (or fallback response index) to the outcome.
 * @returns the mapped outcome.
 */
export async function promptThemedDialog<O>(
  win: BrowserWindow | null,
  script: string,
  native: Electron.MessageBoxOptions,
  map: (value: string, nativeResponse?: number) => O,
): Promise<O> {
  const target = resolveDialogWindow(win)
  if (target !== null) {
    try {
      const choice: unknown = await target.webContents.executeJavaScript(script)
      if (typeof choice === 'string') return map(choice)
    } catch {
      // Page not answerable: fall through to the native dialog.
    }
  }
  const prompt = target === null
    ? dialog.showMessageBox(native)
    : dialog.showMessageBox(target, native)
  const { response } = await prompt
  return map('', response)
}

/**
 * Themed single-button notice with native fallback.
 * @param win - preferred host window (null falls back to focused/any window).
 * @param type - notice severity, used by the native fallback's icon only.
 * @param title - card title.
 * @param message - message line.
 * @param script - caller-built in-page notice script (resolves to 'ok').
 */
export async function noticeThemedDialog(
  win: BrowserWindow | null,
  type: 'info' | 'warning' | 'error',
  title: string,
  message: string,
  script: string,
): Promise<void> {
  await promptThemedDialog(
    win,
    script,
    { type, title, message, buttons: ['确定'], defaultId: 0, cancelId: 0, noLink: true },
    () => undefined,
  )
}
