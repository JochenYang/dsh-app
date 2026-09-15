/**
 * Launch-folder support: a directory named on the command line — or dropped
 * onto the app icon, which the OS passes as a plain argument — becomes an
 * opened dsh workspace.
 *
 * The shell cannot create a workspace itself. Workspaces live in the kernel's
 * client UI, and the renderer is a remote-origin page with no preload and no
 * IPC (see the security invariants in docs/ARCHITECTURE.md §6), so the path
 * leaves this process through the one seam the desktop adaptation may use —
 * `executeJavaScript` — and is handled in the page by the brand client plugin,
 * which owns the workspace services.
 *
 * The in-page handler answers with a STATUS TOKEN, never a sentence: the shell
 * is a different process in a possibly different language, so copy for a
 * refused folder is built here (see the `workspace.*` locale keys) and the
 * token only selects it. Matching on a localized string is the failure mode
 * the kernel-side failure classifier already hit once.
 *
 * Everything degrades quietly: a kernel without the brand suite (a rollback
 * target) never installs the handler, the retry loop gives up, and the app
 * opens its normal window.
 */

import path from 'node:path'

/** The window face this module needs; `BrowserWindow` satisfies it. */
export interface LaunchTarget {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    executeJavaScript(code: string): Promise<unknown>
  }
}

/**
 * Facts the argument parser needs, injected so it stays pure and testable
 * without Electron.
 */
export interface WorkspaceArgContext {
  /** Directory a relative argument resolves against. */
  readonly cwd: string
  /** `app.getAppPath()` — the app's own directory is never an open request. */
  readonly appPath: string
  /** Directory probe: `statSync(...).isDirectory()` in production. */
  readonly isDirectory: (candidate: string) => boolean
}

/**
 * What the page reported, or what the delivery loop concluded. `pending` means
 * the handler is not on the page yet and the loop will retry; it is never
 * returned to the caller.
 */
export type WorkspaceLaunchStatus = 'pending' | 'ok' | 'gone' | 'timeout' | `error:${string}`

/** Attempts before giving up: 80 × 250 ms ≈ 20 s. */
export const WORKSPACE_LAUNCH_ATTEMPTS = 80

/** Delay between attempts; see {@link WORKSPACE_LAUNCH_ATTEMPTS}. */
export const WORKSPACE_LAUNCH_INTERVAL_MS = 250

/**
 * Folder queued for the next window load. It is consumed when delivered, so a
 * later reload (a server restart) does not reopen anything on its own — the
 * client strips the argument it handled, but only this queue knows whether the
 * user asked at all.
 */
let pending: string | null = null

/**
 * Parse the folder out of an argv and queue it. Every launch path calls this
 * (`boot` for the first launch, `second-instance` for the ones that arrive
 * while the app is already up).
 *
 * A launch that names no folder leaves the queue alone: an argv without a path
 * is not a request to cancel one, and clearing the queue there would drop the
 * folder of a first launch that is still installing its kernel when the second
 * process appears.
 *
 * @param argv - the argv of that launch.
 * @param ctx - resolution and probing facts; see {@link WorkspaceArgContext}.
 * @returns the queued folder, or null when the argv named none.
 */
export function queueWorkspaceArg(argv: readonly string[], ctx: WorkspaceArgContext): string | null {
  const dir = pickWorkspaceArg(argv, ctx)
  if (dir !== null) pending = dir
  return dir
}

/**
 * Consume the queued folder.
 * @returns the folder to open now, or null when nothing is queued.
 */
export function takeQueuedWorkspace(): string | null {
  const dir = pending
  pending = null
  return dir
}

/**
 * The global the page exposes for this seam. Duplicated in
 * `plugins/plugin-client-ui/src/client/workspace-launch.ts` (two builds, no
 * shared module); `test/workspace-launch.test.mjs` fails if the two spellings
 * drift apart, because a drift is silent — the shell would retry a handler
 * that exists under another name and give up.
 */
export const WORKSPACE_LAUNCH_GLOBAL = '__dshAppOpenWorkspace'

/**
 * The first directory argument, as an absolute path, or null.
 *
 * Switches are skipped (Electron, Chromium and macOS all add their own), a
 * miss argument is skipped, and the app's own directory is skipped so that
 * `electron .` — every development launch — is not mistaken for a request to
 * open the checkout. Only an existing directory counts: a file argument is
 * not this seam's business, and a path that does not exist would only produce
 * a dialog at startup.
 *
 * @param argv - a process argv (index 0 is the executable).
 * @param ctx - resolution and probing facts; see {@link WorkspaceArgContext}.
 * @returns the absolute directory to open, or null when there is none.
 */
export function pickWorkspaceArg(argv: readonly string[], ctx: WorkspaceArgContext): string | null {
  const ownDir = path.resolve(ctx.appPath)
  for (const raw of argv.slice(1)) {
    if (raw === '' || raw.startsWith('-')) continue
    const resolved = path.resolve(ctx.cwd, raw)
    if (resolved === ownDir) continue
    if (ctx.isDirectory(resolved)) return resolved
  }
  return null
}

/**
 * The injected call. The in-page guard doubles as the readiness probe: a page
 * whose client plugin has not applied yet answers 'pending' and the delivery
 * loop retries, so no separate readiness handshake is needed. A rejected or
 * throwing handler is reported as an error token rather than an exception, so
 * the loop can tell "not ready" from "refused".
 *
 * @param dir - absolute directory to open, embedded as a JS string literal.
 * @returns the script source for `executeJavaScript`.
 */
export const workspaceLaunchScript = (dir: string): string => `(function () {
  if (typeof window.${WORKSPACE_LAUNCH_GLOBAL} !== 'function') return 'pending';
  try {
    return Promise.resolve(window.${WORKSPACE_LAUNCH_GLOBAL}(${JSON.stringify(dir)}))
      .then(function (status) { return status; }, function () { return 'error:rejected'; });
  } catch (err) {
    return 'error:threw';
  }
})()`

/** Narrow whatever the page answered to a status this shell understands. */
function launchStatusOf(raw: unknown): WorkspaceLaunchStatus {
  if (raw === 'ok' || raw === 'pending') return raw
  if (typeof raw === 'string' && raw.startsWith('error:')) return raw as `error:${string}`
  // Any other shape means the page answered a contract this shell does not
  // know (a newer or older plugin). Reporting it beats polling for 20 s.
  return 'error:unexpected'
}

/** Delivery tuning; the defaults suit a real boot, tests override both. */
export interface DeliverOptions {
  /** Attempts before giving up. */
  readonly attempts?: number
  /** Delay between attempts, ms. */
  readonly intervalMs?: number
  /** Sleep seam, so tests need no wall clock. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Called once per failed injection (the page may be mid-navigation). */
  readonly onError?: (error: unknown) => void
}

/**
 * Deliver the folder to the page and wait for a verdict.
 *
 * Retries while the page answers 'pending': the window may still be loading,
 * the client plugin applies later, and an injection issued into the document
 * before it commits lands in whichever document commits next (measured; see
 * the readiness note in startup-window.ts). Bounded, so a kernel without the
 * brand suite costs a quiet give-up rather than a stuck launch.
 *
 * @param win - the window hosting the dsh UI.
 * @param dir - absolute directory to open.
 * @param options - retry/sleep seams; see {@link DeliverOptions}.
 * @returns the page's verdict, 'timeout', or 'gone' when the window vanished.
 */
export async function deliverWorkspaceLaunch(
  win: LaunchTarget,
  dir: string,
  options: DeliverOptions = {},
): Promise<WorkspaceLaunchStatus> {
  const attempts = options.attempts ?? WORKSPACE_LAUNCH_ATTEMPTS
  const intervalMs = options.intervalMs ?? WORKSPACE_LAUNCH_INTERVAL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const script = workspaceLaunchScript(dir)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return 'gone'
    let raw: unknown
    try {
      raw = await win.webContents.executeJavaScript(script)
    } catch (error) {
      // A page mid-navigation rejects the injection; the retry lands in
      // whichever document is there by then.
      options.onError?.(error)
      if (attempt + 1 < attempts) await sleep(intervalMs)
      continue
    }
    const status = launchStatusOf(raw)
    if (status !== 'pending') return status
    if (attempt + 1 < attempts) await sleep(intervalMs)
  }
  return 'timeout'
}
