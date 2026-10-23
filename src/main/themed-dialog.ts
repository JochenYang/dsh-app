import { BrowserWindow, dialog } from 'electron'
import { t } from '../shared/locale'

/**
 * Shared themed-dialog fallback (used by the shell boot flow and the shell
 * updater): try the in-window themed script first, fall back to a native
 * message box when the page cannot answer (crashed, mid-navigation, or
 * before first load). Callers build the in-page script with
 * in-frame-dialog.ts and only share the injection/fallback mechanics here.
 */

/** Pick the window a dialog should attach to. */
export function resolveDialogWindow(preferred: BrowserWindow | null): BrowserWindow | null {
  if (preferred !== null && answersScripts(preferred)) return preferred
  const focused = BrowserWindow.getFocusedWindow()
  if (focused !== null && answersScripts(focused)) return focused
  const first = BrowserWindow.getAllWindows()[0]
  return first !== undefined && answersScripts(first) ? first : null
}

/**
 * Whether a window can answer an injected script right now.
 *
 * `isDestroyed()` is not enough, and that is measured: closing a window destroys
 * its render frame FIRST and the window object later, so a window that is on its
 * way out passes `isDestroyed()` and then throws `Render frame was disposed
 * before WebFrameMain could be accessed` on `executeJavaScript`. The result was a
 * stack trace per dialog during shutdown — the native fallback still answered, so
 * nothing broke visibly, but the log filled with errors from a case this function
 * exists to avoid.
 *
 * `webContents.isDestroyed()` plus a live frame is the pair that actually decides
 * it: `mainFrame` throws once the contents are gone, and `isLoadingMainFrame()`
 * stays true while a navigation has no document to answer from.
 *
 * @param win - the candidate window.
 * @returns true when an injected script has somewhere to run.
 */
function answersScripts(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const contents = win.webContents
  if (contents.isDestroyed() || contents.isCrashed()) return false
  try {
    // Accessing `mainFrame` throws once the render frame is gone, which is the
    // exact failure the caller was logging.
    const frame = contents.mainFrame
    return frame !== undefined && !frame.detached
  } catch {
    return false
  }
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
    { type, title, message, buttons: [t('common.ok')], defaultId: 0, cancelId: 0, noLink: true },
    () => undefined,
  )
}
