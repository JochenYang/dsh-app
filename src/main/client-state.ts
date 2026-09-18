/**
 * The window's own browser state, and the kernel line it belongs to.
 *
 * The harness UI keeps some view state in the window's own storage — the open
 * session, expanded groups, a half-typed draft — and that state belongs to the
 * client BUILD that wrote it. Two kernel lines are supported and they are not
 * the same build: a store the newer one writes is not always one the older one
 * can read, and reading it fails the UI rather than the request (the v0.12.0
 * release lost its session list this way, `slot entry crashed in
 * 'sidebar.workspaces'`).
 *
 * So lines do not share a window's state: {@link CLIENT_STATE_MARKER} records
 * the line that wrote it, and a start on another line clears the storage first.
 * The clear is scoped to local storage — the one place the client keeps view
 * state, and nothing durable lives there (sessions, settings and credentials are
 * under `$DSH_HOME`), so a line change costs the user the window's view state
 * and nothing else.
 *
 * A browser partition per line was declined: Electron fixes a window's partition
 * at creation, and the window is created BEFORE the kernel is resolved (it opens
 * on the loading page), so the partition would need its own early copy of "which
 * line is this" — a second derivation of a fact the shell already derives once.
 *
 * A first start under this rule ADOPTS whatever state is there rather than
 * clearing it: on an upgrade nothing yet says which line wrote it, and the state
 * a shipped release left behind is readable by that same release.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Session } from 'electron'

/** Where the line that last wrote the window's state is remembered. */
export const CLIENT_STATE_MARKER = 'dsh-app-window-line.json'

/**
 * The compatibility unit of a kernel version: `0.1.5-rc.2` and `0.1.5` are one
 * line, `0.1.6-alpha.1` is another. Only the prerelease part is dropped — dsh's
 * third component is the feature line (`0.1.5` and `0.1.6` are different
 * clients), and patch/prerelease steps inside one are the upgrades upstream
 * keeps its own state compatible across.
 *
 * @returns the line, or undefined for a version that does not name one.
 */
export function kernelLine(version: string | undefined): string | undefined {
  const match = /^(\d+\.\d+\.\d+)/.exec(version ?? '')
  return match === null ? undefined : match[1]
}

/** What one call did, for the caller's log line. */
export interface ClientStateOutcome {
  /**
   * `kept` — the state belongs to this line; `cleared` — it was written by
   * another line and storage was reset; `adopted` — first start under this rule,
   * the state is left as it is; `skipped` — see detail, nothing was guaranteed.
   */
  status: 'kept' | 'cleared' | 'adopted' | 'skipped'
  /** The line this start belongs to, when the version named one. */
  line?: string
  /** The line the marker remembered before this call. */
  previous?: string
  /** Failure detail, for the log. */
  detail?: string
}

/** Read the marker's line; undefined when it is absent or unusable. */
async function readMarkerLine(markerPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const line = (parsed as { line?: unknown }).line
    return typeof line === 'string' && line !== '' ? line : undefined
  } catch {
    return undefined
  }
}

/**
 * Give the window storage that the client of THIS kernel line can read.
 *
 * Idempotent and self-healing: a marker that cannot be written leaves the next
 * start free to clear again, and a clear that fails is reported rather than
 * swallowed — the caller logs it and the start continues either way, because a
 * window whose state is the other line's is a broken UI, not a broken app.
 *
 * @param options.session - the session the main window is created in.
 * @param options.userDataDir - where the marker lives.
 * @param options.version - the host package's version (its line decides).
 * @returns what happened, for the caller's log line. Never throws.
 */
export async function alignWindowStateWithLine(options: {
  session: Pick<Session, 'clearStorageData'>
  userDataDir: string
  version: string | undefined
}): Promise<ClientStateOutcome> {
  const line = kernelLine(options.version)
  if (line === undefined) {
    return { status: 'skipped', detail: `the host version (${options.version ?? 'none'}) does not name a kernel line` }
  }
  const markerPath = path.join(options.userDataDir, CLIENT_STATE_MARKER)
  const previous = await readMarkerLine(markerPath)
  if (previous === line) return { status: 'kept', line, previous }
  try {
    // Local storage only: it is where the client keeps its view state, and
    // nothing durable of this app lives there (the loading page is a file://
    // document that stores nothing at all).
    if (previous !== undefined) await options.session.clearStorageData({ storages: ['localstorage'] })
    await fs.writeFile(markerPath, `${JSON.stringify({ line, at: new Date().toISOString() }, undefined, 2)}\n`, 'utf8')
    return previous === undefined ? { status: 'adopted', line } : { status: 'cleared', line, previous }
  } catch (error) {
    return { status: 'skipped', line, previous, detail: (error as Error).message }
  }
}
