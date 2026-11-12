/**
 * The MCP server set, stored where the kernel keeps it: the `mcp-manager`
 * row's `config.servers`.
 *
 * Why this replaced a file of our own: 0.2.2-rc.2 ships `@deepseek-ai/dsh-mcp-manager`,
 * which mounts one `dsh-mcp-client` instance per enabled entry and reconciles
 * them as that config changes. Keeping a second store would have meant two
 * fleets — two mounters, the same tool names registered twice — so this module
 * is now a thin CRUD adapter over the row, and the manager owns mounting.
 *
 * Writes go through the kernel's own config editor (`ctx.configEditor`), the
 * same path its settings pages take: the row lands in the profile patch, values
 * are validated by the manager's own schema before they are stored, and a
 * concurrent edit is refused rather than silently overwritten.
 *
 * Reads keep the raw map: our own validation only decides what the PAGE shows,
 * and a write merges into the raw map, so an entry this version does not
 * understand survives an edit made in this version. The `id` of an entry IS its
 * key — the manager derives the tool namespace (`mcp__<name>__<tool>`) from the
 * key, so a separate id would only be a second name for the same thing.
 *
 * @module @dsh-app/plugin-mcp/store
 */

import {
  McpValidationError,
  validateEntry,
  type McpServerEntry,
  type McpTransport,
  type McpServersFile,
} from './wire.ts'

export { McpValidationError, SERVER_NAME_PATTERN, nextEntryId, validateEntry } from './wire.ts'

/** The loader row whose `config.servers` holds the fleet. */
export const MANAGER_ROW_ID = 'mcp-manager'

/** One addressable loader row, as much of it as this plugin reads. */
export interface ConfigRow {
  readonly options?: { readonly id?: unknown, readonly name?: unknown }
}

/**
 * Structural slice of the kernel's config editor.
 *
 * Read structurally rather than imported: the service is resolved by name from
 * the shared context, and a kernel without it degrades (the page reports that
 * it cannot manage) instead of failing this plugin's activation.
 */
export interface ConfigEditorLike {
  entries(): readonly ConfigRow[]
  configuration(): readonly {
    readonly entry: ConfigRow
    readonly inherited: Record<string, unknown>
    readonly override: Record<string, unknown>
  }[]
  edit(
    entry: ConfigRow,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** One configured server as the manager's schema accepts it. */
type RawServer = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project one raw config entry onto the shape the settings page shows.
 *
 * The key is the identity, so it is also the entry's `id`; an entry naming a
 * different `serverName` would address a tool namespace the manager does not
 * mount under it, so the key wins.
 */
function toEntry(key: string, raw: RawServer): McpServerEntry {
  const transport: McpTransport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const candidate = {
    ...raw,
    id: key,
    serverName: key,
    transport,
    enabled: raw.enabled !== false,
  }
  return validateEntry(candidate, new Set())
}

/** One entry as the manager's config stores it (no `id`, no duplicated name). */
function toRawServer(entry: McpServerEntry): RawServer {
  const raw: RawServer = {
    transport: entry.transport,
    enabled: entry.enabled,
  }
  if (entry.transport === 'stdio') {
    if (entry.command !== undefined) raw.command = entry.command
    if (entry.args !== undefined) raw.args = [...entry.args]
    if (entry.env !== undefined) raw.env = { ...entry.env }
    if (entry.cwd !== undefined) raw.cwd = entry.cwd
  } else {
    if (entry.url !== undefined) raw.url = entry.url
    if (entry.headers !== undefined) raw.headers = { ...entry.headers }
  }
  if (entry.toolCallTimeoutMs !== undefined) raw.toolCallTimeoutMs = entry.toolCallTimeoutMs
  return raw
}

/**
 * The fleet, over the runner's `config.servers`.
 *
 * Every method is synchronous on the read side (the config document is already
 * in memory) and asynchronous on the write side (the editor persists, then the
 * loader reconciles). `enabled` is this plugin's own switch, carried by its own
 * config: turning it off stops the page from writing and reports every entry as
 * disabled, without touching the servers the user configured.
 */
export class McpStore {
  /** What the settings page shows as the store's location. */
  readonly filePath = `row "${MANAGER_ROW_ID}" → config.servers`

  constructor(
    private readonly editor: ConfigEditorLike | undefined,
    private readonly enabled: boolean,
    private readonly log: (message: string) => void,
  ) {}

  /** Whether the config editor is available at all. */
  get available(): boolean {
    return this.editor !== undefined
  }

  /** The row this store addresses, or undefined when the composition has none. */
  private row(): ConfigRow | undefined {
    return this.editor?.entries().find((entry) => entry.options?.id === MANAGER_ROW_ID)
  }

  /** The effective `servers` map: the profile override wins over the composed layer. */
  private rawServers(): Record<string, unknown> {
    const editor = this.editor
    const row = this.row()
    if (editor === undefined || row === undefined) return {}
    const configuration = editor.configuration().find((candidate) => candidate.entry === row)
    if (configuration === undefined) return {}
    const override = configuration.override.servers
    if (isRecord(override)) return override
    const inherited = configuration.inherited.servers
    return isRecord(inherited) ? inherited : {}
  }

  /**
   * Read the fleet for display.
   *
   * An entry this version cannot validate is skipped with a warning and left in
   * the document (see {@link rawServers}: a write merges into the raw map).
   */
  load(): McpServersFile {
    const servers: McpServerEntry[] = []
    for (const [key, value] of Object.entries(this.rawServers())) {
      if (!isRecord(value)) {
        this.log(`mcp: entry "${key}" is not an object; ignored`)
        continue
      }
      try {
        servers.push(toEntry(key, value))
      } catch (error) {
        this.log(`mcp: entry "${key}" is invalid and stays untouched: ${(error as Error).message}`)
      }
    }
    return { version: 1, enabled: this.enabled, servers }
  }

  /** Persist one whole map through the config editor. */
  private async write(next: Record<string, unknown>): Promise<void> {
    const editor = this.editor
    const row = this.row()
    if (editor === undefined || row === undefined) {
      throw new McpValidationError('store.unavailable', { row: MANAGER_ROW_ID })
    }
    await editor.edit(row, (current) => ({ ...current, servers: next }))
  }

  /** Validate + insert one entry, keyed by its server name. */
  async create(raw: unknown): Promise<McpServerEntry> {
    const servers = this.rawServers()
    const draft = isRecord(raw) ? raw : {}
    const name = typeof draft.serverName === 'string' ? draft.serverName : undefined
    if (name === undefined) throw new McpValidationError('serverName.invalid', { name: String(draft.serverName ?? '') })
    if (Object.hasOwn(servers, name)) throw new McpValidationError('serverName.taken', { name })
    const entry = validateEntry({ ...draft, id: name, serverName: name }, new Set(Object.keys(servers)))
    await this.write({ ...servers, [name]: toRawServer(entry) })
    return entry
  }

  /** Validate + replace the entry stored under one key. */
  async update(id: string, raw: unknown): Promise<McpServerEntry> {
    const servers = this.rawServers()
    if (!Object.hasOwn(servers, id)) throw new McpValidationError('server.notFound', { id })
    const draft = isRecord(raw) ? raw : {}
    const requested = typeof draft.serverName === 'string' ? draft.serverName : id
    // The key is the identity: a rename here would move the tool namespace out
    // from under a model that was told the old one, so it is refused instead.
    if (requested !== id) throw new McpValidationError('serverName.immutable', { from: id, to: requested })
    const entry = validateEntry({ ...draft, id, serverName: id }, new Set(Object.keys(servers).filter((key) => key !== id)))
    await this.write({ ...servers, [id]: toRawServer(entry) })
    return entry
  }

  /**
   * Merge a batch (the one-time migration of the old file) into the row.
   *
   * Keys already configured are left alone: the row is what this version reads
   * and a user may have edited it in the kernel's own page since. One write for
   * the whole batch, so a half-migrated fleet never lands in the document.
   *
   * @param entries - validated entries to add.
   * @returns how many entries were written (0 when every key already existed).
   */
  async importAll(entries: readonly McpServerEntry[]): Promise<number> {
    const servers = this.rawServers()
    const next = { ...servers }
    let written = 0
    for (const entry of entries) {
      if (Object.hasOwn(next, entry.serverName)) continue
      next[entry.serverName] = toRawServer(entry)
      written += 1
    }
    if (written > 0) await this.write(next)
    return written
  }

  /** Remove one entry by key; a missing key is a no-op. */
  async remove(id: string): Promise<void> {
    const servers = this.rawServers()
    if (!Object.hasOwn(servers, id)) return
    const next = { ...servers }
    delete next[id]
    await this.write(next)
  }
}
