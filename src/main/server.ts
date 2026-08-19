import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServerSpec } from '../shared/types'
import { DEFAULT_HTTP_HOST, SERVER_HEALTH_POLL_MS, SERVER_HEALTH_TIMEOUT_MS, SERVER_SHUTDOWN_GRACE_MS } from '../shared/constants'

export interface ServerEvents {
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onReady?: (url: string) => void
  onLog?: (line: string) => void
}

/** Cap a diagnostic line so a runaway child cannot grow logs unbounded. */
const MAX_LOG_LINE = 2_000

/** Redact credential-looking fragments before a line reaches logs or events. */
function redact(line: string): string {
  return line
    .replace(/(api[_-]?key|authorization|token)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .slice(0, MAX_LOG_LINE)
}

/**
 * Accept only a loopback HTTP URL: the settled server address must be the
 * harness's own local web UI, never an external origin.
 */
function isLocalServerUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && url.username === ''
      && url.password === ''
      && url.port !== ''
  } catch {
    return false
  }
}

/** Extract the settled server URL from a line emitted by `dsh web`. */
function extractServerUrl(line: string): string | undefined {
  const match = /(?:^|\s)dsh web:\s+(http:\/\/[^\s]+)/.exec(line)
  if (match?.[1] === undefined || !isLocalServerUrl(match[1])) return undefined
  return match[1]
}

/**
 * Manages the local dsh web server child process: spawn, health-check,
 * crash detection, and graceful shutdown.
 */
export class DshServer {
  private child: ChildProcess | null = null
  private stopping = false
  private shellMode = false
  private url = ''
  private logFile: string | null = null
  /** Incremental line-split buffers (one per child stream). */
  private lineBuffers = new Map<NodeJS.ReadableStream, string>()

  constructor(private readonly events: ServerEvents = {}) {}

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed
  }

  get serverUrl(): string {
    return this.url
  }

  async start(spec: ServerSpec, port: number, host: string = DEFAULT_HTTP_HOST, extraPatches: readonly string[] = []): Promise<void> {
    await this.stop()
    this.stopping = false
    this.url = `http://${host}:${port}`

    const { command, args, shell } = this.buildCommand(spec, port, host, extraPatches)
    this.shellMode = shell === true
    this.logFile = await this.openLog()
    this.events.onLog?.(`spawn ${shell ? command : `${command} ${args.join(' ')}`}`)

    const child = shell
      ? spawn(command, {
          shell: true,
          cwd: spec.cwd,
          env: { ...process.env, DSH_APP_DESKTOP: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd: spec.cwd,
          env: { ...process.env, DSH_APP_DESKTOP: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
    this.child = child

    const onChunk = (stream: NodeJS.ReadableStream) => (d: Buffer) => {
      const pending = `${this.lineBuffers.get(stream) ?? ''}${d.toString('utf8')}`
      const parts = pending.split(/\r?\n/)
      this.lineBuffers.set(stream, parts.pop() ?? '')
      for (const line of parts) this.handleLine(line)
    }
    child.stdout?.on('data', onChunk(child.stdout))
    child.stderr?.on('data', onChunk(child.stderr))
    child.on('error', (err) => this.events.onLog?.(`server error: ${err.message}`))
    child.on('exit', (code, signal) => {
      for (const [stream, rest] of this.lineBuffers) {
        if (rest !== '') this.handleLine(rest)
        this.lineBuffers.delete(stream)
      }
      if (this.child === child) this.child = null
      if (!this.stopping) this.events.onExit?.(code, signal)
    })

    await this.waitForHealth()
    this.events.onReady?.(this.url)
  }

  /** Quote a shell fragment for cmd.exe when it carries whitespace or quotes. */
  private quoteForShell(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
  }

  private buildCommand(spec: ServerSpec, port: number, host: string, extraPatches: readonly string[]): { command: string; args: string[]; shell?: boolean } {
    // Brand-suite loader overlays (plugins/dsh-app.patch.yml): applied after
    // every bundle layer, last write wins per row. Host/port are controlled
    // values; overlay paths come from userData (see brand-suite.ts).
    const patchArgs = extraPatches.flatMap((overlay) => ['--patch', overlay])
    if (spec.kind === 'pnpm') {
      // Dev mode: run the local checkout's dsh CLI via pnpm.
      // On Windows, pnpm is a .cmd shim that cannot be spawned without a
      // shell, so build one command line and let Node run it through the
      // system shell (host/port are controlled values: no injection surface).
      if (process.platform === 'win32') {
        const patchFragment = patchArgs.map((token) => this.quoteForShell(token)).join(' ')
        const overlays = patchFragment !== '' ? `${patchFragment} ` : ''
        return { command: `pnpm dsh web ${overlays}--host ${host} --port ${port}`, args: [], shell: true }
      }
      return { command: 'pnpm', args: ['dsh', 'web', ...patchArgs, '--host', host, '--port', String(port)] }
    }
    return {
      command: spec.nodePath,
      args: [spec.scriptPath, '--profile', 'web', ...patchArgs, '--host', host, '--port', String(port)],
    }
  }

  private async openLog(): Promise<string> {
    const dir = path.join(process.env.DSH_APP_LOG_DIR ?? '', 'logs')
    const file = path.join(dir, `dsh-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    await fs.mkdir(dir, { recursive: true })
    return file
  }

  /**
   * One complete child-output line: redact, forward, and harvest the settled
   * server URL when `dsh web` prints it (trusts the child's own report over
   * the pre-allocated port, closing the find-free-port race).
   */
  private handleLine(line: string): void {
    const safe = redact(line)
    this.events.onLog?.(safe)
    if (this.logFile) {
      void fs.appendFile(this.logFile, `${safe}\n`).catch(() => undefined)
    }
    const url = extractServerUrl(line)
    if (url && !this.stopping && url !== this.url) {
      this.url = url
      this.events.onLog?.(`server url settled: ${url}`)
    }
  }

  /** Poll the web server root until it answers 200 or the timeout elapses. */
  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + SERVER_HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.stopping || !this.child) throw new Error('server process exited during startup')
      try {
        const res = await fetch(this.url, { signal: AbortSignal.timeout(2_000) })
        if (res.ok) return
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, SERVER_HEALTH_POLL_MS))
    }
    throw new Error(`dsh server did not become healthy within ${SERVER_HEALTH_TIMEOUT_MS / 1000}s`)
  }

  /** Graceful stop: SIGTERM, then SIGKILL after the grace period. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    if (process.platform === 'win32' && this.shellMode) {
      // The shell (cmd.exe) does not forward signals; kill the whole tree.
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.on('exit', () => resolve())
      })
    } else {
      child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SERVER_SHUTDOWN_GRACE_MS)),
      ])
      if (!exited) {
        child.kill('SIGKILL')
        await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
    }
    this.child = null
  }

  async kill(): Promise<void> {
    this.stopping = true
    this.child?.kill('SIGKILL')
    this.child = null
  }
}
