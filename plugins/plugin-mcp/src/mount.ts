/**
 * Dynamic mount manager over the cordis loader seam.
 *
 * The kernel's `@deepseek-ai/dsh-mcp-client` is a loader plugin: one instance
 * per server, configured at load time. This manager is the suite-side bridge:
 * it keeps one live loader entry per ENABLED entry in servers.json, creating
 * (`loader.create`), reconfiguring (`loader.update`) and destroying
 * (`loader.remove`) them as the file changes. The profile root the loader
 * writes back to is rewritten empty by the harness on every boot
 * (profile-boot's prepareProfile), so these entries are process-scoped by
 * construction — the file stays the only durable state.
 *
 * The loader/tools faces are STRUCTURAL SLICES (suite stability discipline):
 * a kernel without them degrades to `unavailable` status, never a boot
 * failure. Mount failures are captured per entry — an unreachable MCP server
 * (failOnStartupError is always false) must never break the harness boot.
 *
 * Concurrency: every entry's transitions run through a per-id promise chain,
 * so concurrent route writes to the same entry serialize instead of racing
 * two loader.create calls into an orphaned instance.
 *
 * @module @dsh-app/plugin-mcp/mount
 */

import type { McpMountStatus, McpServerEntry } from './wire.ts'

/** The kernel plugin every entry mounts as. */
const KERNEL_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Bound any surfaced error text (loader errors may echo config fragments). */
const MAX_ERROR_CHARS = 200

/** Structural slice of the cordis loader service (create/remove/update only). */
interface LoaderLike {
  create(options: { name: string, config?: unknown }): Promise<string>
  remove(id: string): Promise<void>
  update(id: string, options: { name: string, config?: unknown }): Promise<unknown>
}

/** Structural slice of the tools registry: enough to count a server's tools. */
interface ToolsLike {
  schemas(): ReadonlyArray<{ name: string }>
}

/** `$ENV:NAME` reference syntax accepted in env/headers values. */
const ENV_REF = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/

/** Contain an unknown error to a bounded, log/UI-safe string. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
}

/**
 * Resolve `$ENV:NAME` references at mount time. A missing variable resolves
 * to '' and is reported in the entry's status message (the server will fail
 * to authenticate/connect downstream — failOnStartupError stays false). An
 * INLINE `$ENV:` mention (e.g. `Bearer $ENV:TOKEN`) is NOT a reference; it is
 * kept literal and warned about, because that is almost always a mistake.
 */
function resolveValue(value: string, warnings: string[]): string {
  const match = ENV_REF.exec(value)
  if (match === null) {
    if (value.includes('$ENV:')) {
      warnings.push(`仅支持整值 $ENV:VAR 引用，「${value.slice(0, 40)}」已按字面值处理`)
    }
    return value
  }
  const name = match[1]
  const resolved = process.env[name]
  if (resolved === undefined || resolved === '') {
    warnings.push(`环境变量 ${name} 未设置`)
    return ''
  }
  return resolved
}

function resolveMap(map: Readonly<Record<string, string>> | undefined, warnings: string[]): Record<string, string> | undefined {
  if (map === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) out[key] = resolveValue(value, warnings)
  return out
}

/** Build the wire config for one entry (upstream StdioConfig/StreamableHttpConfig shape). */
function toClientConfig(entry: McpServerEntry, warnings: string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {
    serverName: entry.serverName,
    transport: entry.transport,
    // A failed initial connection must never fail plugin activation: the
    // harness boots, the server just contributes no tools until it recovers.
    failOnStartupError: false,
  }
  if (entry.transport === 'stdio') {
    config.command = entry.command
    if (entry.args !== undefined) config.args = [...entry.args]
    const env = resolveMap(entry.env, warnings)
    if (env !== undefined) config.env = env
    if (entry.cwd !== undefined) config.cwd = entry.cwd
  } else {
    config.url = entry.url
    const headers = resolveMap(entry.headers, warnings)
    if (headers !== undefined) config.headers = headers
  }
  if (entry.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = entry.toolCallTimeoutMs
  return config
}

interface MountRecord {
  /** Live loader entry id, when created. */
  loaderId?: string
  /** Config snapshot of the live entry (skip no-op updates). */
  configKey?: string
  /** Last mount error, cleared on a successful (re)mount. */
  error?: string
  /** `$ENV:` resolution warnings of the last mount. */
  warnings?: string[]
}

/**
 * The per-process mount state. All methods are safe to call with an absent
 * loader seam (they degrade to `unavailable` status instead of throwing).
 */
export class McpMountManager {
  private readonly records = new Map<string, MountRecord>()
  /** Per-entry transition chains: same-id mutations never interleave. */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly log: (message: string) => void,
    loader: unknown,
    private readonly tools: unknown,
  ) {
    this.loader = typeof loader === 'object' && loader !== null && typeof (loader as LoaderLike).create === 'function'
      ? loader as LoaderLike
      : undefined
  }

  private readonly loader: LoaderLike | undefined

  /** Whether any dynamic mount happened (drives the settings-page banner). */
  get available(): boolean {
    return this.loader !== undefined
  }

  private toolsLike(): ToolsLike | undefined {
    const tools = this.tools
    return typeof tools === 'object' && tools !== null && typeof (tools as ToolsLike).schemas === 'function'
      ? tools as ToolsLike
      : undefined
  }

  /** Serialize one entry's transition after everything queued before it. */
  private enqueue(id: string, op: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => undefined).then(op)
    this.chains.set(id, next)
    return next
  }

  /** Live `mcp__<serverName>__*` tool count, when the registry is readable. */
  private countTools(serverName: string): number | undefined {
    const tools = this.toolsLike()
    if (tools === undefined) return undefined
    try {
      const prefix = `mcp__${serverName}__`
      return tools.schemas().filter(schema => typeof schema.name === 'string' && schema.name.startsWith(prefix)).length
    } catch {
      return undefined
    }
  }

  /** Recompute every entry to match the desired state. Never throws. */
  async syncAll(entries: readonly McpServerEntry[]): Promise<void> {
    if (this.loader === undefined) return
    const desired = new Set(entries.map(entry => entry.id))
    for (const id of [...this.records.keys()]) {
      if (!desired.has(id)) await this.unmount(id)
    }
    // Mark everything as starting up front so the settings page renders a
    // truthful "挂载中" instead of a momentary "已停用" while awaiting.
    for (const entry of entries) {
      if (entry.enabled && !this.records.has(entry.id)) this.records.set(entry.id, {})
    }
    await Promise.all(entries.map(entry => this.enqueue(entry.id, () => this.syncOneNow(entry))))
  }

  /**
   * Bring one entry to its desired state: disabled → unmounted; enabled →
   * mounted with the current config (created, or updated when changed).
   * Serialized per entry via {@link enqueue}; call sites use syncOne.
   */
  private async syncOneNow(entry: McpServerEntry): Promise<void> {
    if (!entry.enabled || this.loader === undefined) {
      await this.unmountNow(entry.id)
      return
    }
    const record = this.records.get(entry.id) ?? {}
    const warnings: string[] = []
    const config = toClientConfig(entry, warnings)
    const configKey = JSON.stringify(config)
    const unchanged = record.loaderId !== undefined && record.configKey === configKey && record.error === undefined
    if (unchanged) {
      this.records.set(entry.id, { ...record, warnings: warnings.length > 0 ? warnings : undefined })
      return
    }
    try {
      if (record.loaderId !== undefined) {
        // Reconfigure in place: loader.update keeps the same instance (and its
        // tools registered) instead of churning remove+create. A stale loaderId
        // (e.g. the kernel restarted underneath us) fails the update, and the
        // create path below remounts from scratch.
        try {
          await this.loader.update(record.loaderId, { name: KERNEL_PLUGIN, config })
          record.configKey = configKey
          record.error = undefined
          record.warnings = warnings.length > 0 ? warnings : undefined
          this.log(`mcp mount: ${entry.serverName} updated (${record.loaderId})`)
          this.records.set(entry.id, { ...record })
          return
        } catch {
          await this.loader.remove(record.loaderId).catch(() => undefined)
          record.loaderId = undefined
        }
      }
      const loaderId = await this.loader.create({ name: KERNEL_PLUGIN, config })
      record.loaderId = loaderId
      record.configKey = configKey
      record.error = undefined
      record.warnings = warnings.length > 0 ? warnings : undefined
      this.log(`mcp mount: ${entry.serverName} mounted (${loaderId})`)
    } catch (error) {
      record.loaderId = undefined
      record.configKey = undefined
      record.error = describeError(error)
      this.log(`mcp mount: ${entry.serverName} failed: ${record.error}`)
    }
    this.records.set(entry.id, { ...record })
  }

  /** Queue one entry's sync; resolves after the transition settles. */
  syncOne(entry: McpServerEntry): Promise<void> {
    return this.enqueue(entry.id, () => this.syncOneNow(entry))
  }

  /** Stop and forget one entry's loader instance. */
  async unmount(id: string): Promise<void> {
    return this.enqueue(id, () => this.unmountNow(id))
  }

  private async unmountNow(id: string): Promise<void> {
    const record = this.records.get(id)
    if (record?.loaderId !== undefined && this.loader !== undefined) {
      try {
        await this.loader.remove(record.loaderId)
      } catch (error) {
        this.log(`mcp unmount ${id}: ${describeError(error)}`)
      }
    }
    this.records.delete(id)
  }

  /** Dispose every live instance (plugin teardown / process shutdown). */
  async disposeAll(): Promise<void> {
    const ids = [...this.records.keys()]
    await Promise.all(ids.map(id => this.unmount(id)))
  }

  /** Current user-visible status of one entry. */
  statusFor(entry: McpServerEntry): McpMountStatus {
    if (!entry.enabled) return { state: 'disabled' }
    if (this.loader === undefined) {
      return { state: 'unavailable', message: '当前内核不支持 MCP 动态挂载，MCP 功能不可用' }
    }
    const record = this.records.get(entry.id)
    if (record === undefined) return { state: 'starting' }
    if (record.error !== undefined) return { state: 'error', message: record.error }
    if (record.loaderId === undefined) return { state: 'starting' }
    const warning = record.warnings !== undefined && record.warnings.length > 0 ? record.warnings.join('；') : undefined
    return {
      state: 'mounted',
      message: warning,
      toolCount: this.countTools(entry.serverName),
    }
  }
}
