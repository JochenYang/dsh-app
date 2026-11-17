/**
 * The update progress window: a small, kernel-less Electron process that shows
 * the themed page while the silent installer replaces the app.
 *
 * Why a second process exists at all: the installer cannot replace binaries a
 * running app holds open, so the main process must quit before the install
 * starts — and a quit window is exactly where users lose sight of what is
 * happening. The installer itself is silent (`/S`), so the only progress UI
 * available is one we draw. NSIS cannot render our design (it is Win32 pages),
 * and a custom NSIS page would have to re-implement the install itself. So this
 * process does one narrow job: show the page, run the installer, exit.
 *
 * It deliberately boots NOTHING else: no kernel child, no tray, no single
 * instance lock, and a throwaway userData directory (the main app still holds
 * the real one while it exits).
 *
 * @module dsh-app/main/update-progress
 */
import { app, BrowserWindow } from 'electron'
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** argv flag that turns this process into the progress window. */
export const UPDATE_PROGRESS_ARGV = '--update-progress'

/** How long the page stays on screen after the installer exits (a flash reads
 * as a glitch, not as completion). */
const MIN_VISIBLE_MS = 1_500

/** How long to wait for the main app to let go of its binaries. */
const PARENT_EXIT_TIMEOUT_MS = 15_000

export interface UpdateProgressArgs {
  /** Absolute path of the downloaded installer. */
  readonly installer: string
  /** Version the user is leaving. */
  readonly from: string
  /** Version being installed. */
  readonly to: string
  readonly theme: 'light' | 'dark'
}

/**
 * Parse this mode's argv, or null when the process is a normal launch.
 *
 * Pure and exported so the rule is testable without starting Electron: the
 * flag only counts when the installer path is present and absolute.
 *
 * @param argv - `process.argv`.
 * @returns the parsed arguments, or null for a normal launch.
 */
export function parseUpdateProgressArgs(argv: readonly string[]): UpdateProgressArgs | null {
  if (!argv.includes(UPDATE_PROGRESS_ARGV)) return null
  const value = (name: string): string => {
    const prefix = `${name}=`
    const hit = argv.find((argument) => argument.startsWith(prefix))
    return hit === undefined ? '' : hit.slice(prefix.length)
  }
  const installer = value('--installer')
  if (installer === '' || !path.isAbsolute(installer)) return null
  return {
    installer,
    from: value('--from'),
    to: value('--to'),
    theme: value('--theme') === 'dark' ? 'dark' : 'light',
  }
}

/** Whether a pid is still alive (EPERM counts as alive). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Run the progress window for one updater pass.
 *
 * Sequence: show the page, wait for the parent process to exit (it spawned this
 * one and quits right after), run the installer silently, keep the page up for
 * a moment, close. A failed install leaves the error state on the page for a
 * few seconds; the pending-install record reports it again on the next launch.
 *
 * @param args - this mode's parsed arguments.
 */
export async function runUpdateProgress(args: UpdateProgressArgs): Promise<void> {
  const opened = Date.now()
  const win = new BrowserWindow({
    width: 560,
    height: 430,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    center: true,
    backgroundColor: args.theme === 'dark' ? '#151517' : '#f0f5fd',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.on('closed', () => app.quit())
  try {
    await win.loadFile(path.join(__dirname, '..', 'static', 'update-progress.html'), {
      query: { from: args.from, to: args.to, theme: args.theme },
    })
  } catch (error) {
    // A packaged build has no console; the shell's log is the only place this
    // can be seen, and a blank progress window must never be silent.
    console.error('[update-progress] page load failed:', error)
    app.quit()
    return
  }
  win.show()
  win.focus()

  const parent = Number(process.env.DSH_UPDATE_PARENT_PID ?? '')
  if (Number.isInteger(parent) && parent > 0) {
    const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS
    while (alive(parent) && Date.now() < deadline) await delay(120)
  }
  // The installer refuses to run while the old binaries are open; a short grace
  // covers the last handles even after the process is gone.
  await delay(400)

  const failure = await runInstaller(args.installer)
  if (failure !== null) {
    await win.webContents.executeJavaScript(
      `window.dshProgress && window.dshProgress.fail(${JSON.stringify(failure)})`,
    ).catch(() => undefined)
    await delay(6_000)
  }
  const remaining = MIN_VISIBLE_MS - (Date.now() - opened)
  if (remaining > 0) await delay(remaining)
  if (!win.isDestroyed()) win.close()
  app.quit()
}

/**
 * A packaged build has no console, and this process exists only for the length
 * of an install — so it keeps one small log the next boot (or a support report)
 * can read.
 */
function progressLog(line: string): void {
  try {
    appendFileSync(path.join(app.getPath('temp'), 'dsh-update-progress.log'), `${new Date().toISOString()} ${line}
`)
  } catch {
    // Logging must never fail the install.
  }
}

/** Run the installer silently; resolves with an error message or null. */
async function runInstaller(installer: string): Promise<string | null> {
  progressLog(`spawn ${installer}`)
  return await new Promise<string | null>((resolve) => {
    let settled = false
    const child = spawn(installer, ['/S', '--updated', '--force-run'], { stdio: 'ignore' })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      progressLog(`spawn failed: ${error.message}`)
      resolve(error.message)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      progressLog(`exit ${String(code)}`)
      resolve(code === 0 ? null : `installer exit ${String(code)}`)
    })
  })
}

/**
 * Remove this process's throwaway profile.
 *
 * The real userData is still owned by the main app, so the helper runs on a
 * temp directory of its own (see index.ts) — it must not be left behind.
 *
 * @param dir - the directory index.ts pointed userData at.
 */
export async function disposeProgressProfile(dir: string): Promise<void> {
  // Async, and best effort: Chromium may still hold files in the profile for a
  // moment after the window closes, and a temp directory the OS collects is a
  // better outcome than a quit that waits on an antivirus scan.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

/** Create the throwaway profile directory (index.ts calls this before ready). */
export function prepareProgressProfile(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Chromium creates it too; a failure here is not fatal.
  }
}
