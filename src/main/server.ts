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

/**
 * Manages the local dsh web server child process: spawn, health-check,
 * crash detection, and graceful shutdown.
 */
export class DshServer {
  private child: ChildProcess | null = null
  private stopping = false
  private url = ''
  private logFile: string | null = null

  constructor(private readonly events: ServerEvents = {}) {}

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed
  }

  get serverUrl(): string {
    return this.url
  }

  async start(spec: ServerSpec, port: number, host: string = DEFAULT_HTTP_HOST): Promise<void> {
    await this.stop()
    this.stopping = false
    this.url = `http://${host}:${port}`

    const { command, args } = this.buildCommand(spec, port, host)
    this.logFile = await this.openLog()
    this.events.onLog?.(`spawn ${command} ${args.join(' ')}`)

    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: { ...process.env, DSH_APP_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout?.on('data', (d: Buffer) => void this.tee(d))
    child.stderr?.on('data', (d: Buffer) => void this.tee(d))
    child.on('error', (err) => this.events.onLog?.(`server error: ${err.message}`))
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (!this.stopping) this.events.onExit?.(code, signal)
    })

    await this.waitForHealth()
    this.events.onReady?.(this.url)
  }

  private buildCommand(spec: ServerSpec, port: number, host: string): { command: string; args: string[] } {
    if (spec.kind === 'pnpm') {
      // Dev mode: run the local checkout's dsh CLI via pnpm.
      return { command: 'pnpm', args: ['dsh', 'web', '--host', host, '--port', String(port)] }
    }
    return {
      command: spec.nodePath,
      args: [spec.scriptPath, '--profile', 'web', '--host', host, '--port', String(port)],
    }
  }

  private async openLog(): Promise<string> {
    const dir = path.join(process.env.DSH_APP_LOG_DIR ?? '', 'logs')
    const file = path.join(dir, `dsh-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    await fs.mkdir(dir, { recursive: true })
    return file
  }

  private async tee(chunk: Buffer): Promise<void> {
    const line = chunk.toString('utf8')
    this.events.onLog?.(line.trimEnd())
    if (this.logFile) {
      await fs.appendFile(this.logFile, line).catch(() => undefined)
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
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SERVER_SHUTDOWN_GRACE_MS)),
    ])
    if (!exited) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
    this.child = null
  }

  async kill(): Promise<void> {
    this.stopping = true
    this.child?.kill('SIGKILL')
    this.child = null
  }
}
