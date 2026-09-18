/**
 * The kernel child as the shell sees it: the desktop host transport
 * (desktop-host.ts) plus the diagnostics the shell owns around it.
 *
 * There is no listening socket any more — "server" here means the host process
 * the window's `dsh-app://app/…` requests are forwarded to. What this module
 * keeps is everything the shell needs to report about that process: one log
 * file per run under `<DSH_APP_LOG_DIR or userData>/logs`, credential-redacted
 * lines, and the exit event the crash/restart path listens to. Readiness is the
 * child's own `ready` message rather than a health probe, so a half-composed
 * plugin tree can no longer look healthy from the outside.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DshHost, type DshHostOptions } from './desktop-host'
import { redact } from './redact'

export interface ServerEvents {
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onLog?: (line: string) => void
}

/** One start's inputs: where the host lives and which profile it boots. */
export type DshServerSpec = Omit<DshHostOptions, 'onLog' | 'onExit'>

/** How many recent host log files to keep on disk. */
const MAX_KEPT_LOG_FILES = 10

/**
 * Directory holding this run's logs: `<DSH_APP_LOG_DIR or userData>/logs`.
 * One definition, because the host log, the kernel log and the shell's
 * "open logs folder" action must all name the same place.
 */
export function resolveLogDir(): string {
  return path.join(process.env.DSH_APP_LOG_DIR ?? app.getPath('userData'), 'logs')
}

/**
 * Manages the desktop host child: start, crash detection, log capture, and
 * graceful shutdown.
 */
export class DshServer {
  private host: DshHost | null = null
  private stopping = false
  private logFile: string | null = null

  constructor(private readonly events: ServerEvents = {}) {}

  get isRunning(): boolean {
    return this.host?.isRunning === true
  }

  /**
   * Start the host for the active kernel and profile.
   *
   * A start that never reaches readiness rejects with the child's own last
   * words; the shell's failure path (rollback, bundled reinstall, give-up
   * dialog) is driven by that rejection and by `onExit` afterwards — never both
   * for the same crash.
   *
   * @param spec - entry, runtime tree, profile, environment, dev linkage.
   */
  async start(spec: DshServerSpec): Promise<void> {
    await this.stop()
    this.stopping = false
    this.logFile = await this.openLog()
    const host = new DshHost({
      ...spec,
      onLog: (line) => { this.handleLine(line) },
      onExit: (code, signal) => {
        if (this.stopping) return
        this.events.onExit?.(code, signal)
      },
    })
    this.host = host
    this.handleLine(`dsh host: ${spec.entry} (runtime ${spec.runtimeDir}, profile ${spec.projectDir})`)
    try {
      await host.start()
    } catch (error) {
      this.host = null
      await host.stop().catch(() => undefined)
      throw error
    }
    // A host that reported no dsh version is the web transport's: its `ready`
    // carries the URL and the boot rows instead, and the version that belongs in
    // this log is the active kernel's, which the shell names separately.
    const version = host.dshVersion
    this.handleLine(version === undefined ? 'dsh host ready (web transport)' : `dsh host dsh ${version} ready`)
  }

  /** Forward one `dsh-app://app/…` request to the running host. */
  fetch(request: Request): Promise<Response> {
    const host = this.host
    if (host === null) return Promise.reject(new Error('dsh host is not running'))
    return host.fetch(request)
  }

  /**
   * The web transport's origin and cookie, once the host reported them.
   * @returns see {@link DshHost.webTarget}; undefined for the frames transport.
   */
  webTarget(): { origin: string; cookie: string } | undefined {
    return this.host?.webTarget()
  }

  /** Stop the host: shutdown message, then signals, then the tree kill. */
  async stop(): Promise<void> {
    const host = this.host
    if (host === null) return
    this.stopping = true
    try {
      await host.stop()
    } finally {
      this.host = null
      this.stopping = false
    }
  }

  /** Open a new host log file under the log dir, pruning older ones. */
  private async openLog(): Promise<string> {
    const dir = resolveLogDir()
    const file = path.join(dir, `dsh-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    await fs.mkdir(dir, { recursive: true })
    await this.pruneOldLogs(dir)
    return file
  }

  /**
   * Keep only the most recent host log files so a long-lived install cannot
   * grow the log dir unbounded. Best-effort: never fail the start over logs.
   */
  private async pruneOldLogs(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir)
      const logs = entries.filter((name) => name.startsWith('dsh-server-') && name.endsWith('.log')).sort()
      const stale = logs.slice(0, Math.max(0, logs.length - MAX_KEPT_LOG_FILES))
      await Promise.all(stale.map((name) => fs.rm(path.join(dir, name), { force: true })))
    } catch {
      // Best-effort pruning; the new log file is already usable.
    }
  }

  /** One complete child-output line: redact, forward, append to this run's log. */
  private handleLine(line: string): void {
    const safe = redact(line)
    this.events.onLog?.(safe)
    if (this.logFile) {
      void fs.appendFile(this.logFile, `${safe}\n`).catch(() => undefined)
    }
  }
}
