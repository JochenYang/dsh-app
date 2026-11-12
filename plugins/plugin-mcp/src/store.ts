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
 * Three rules this module is built around, each paid for by a failure mode:
 *
 * 1. **Every write is computed from the document's LIVE state.** The mutation
 *    runs inside `editor.edit`'s callback and receives `current`/`inherited` as
 *    the editor reads them; a snapshot taken before the await would silently
 *    drop a server added by another writer (the kernel's own page edits this
 *    same row) in the window between read and write.
 * 2. **An entry is merged, never rebuilt.** The fields this version knows are
 *    written over the entry's previous raw object and everything else is kept,
 *    so a knob this version does not model (`reconnect`, or whatever the next
 *    manager adds) survives a toggle made here. Only a transport change drops
 *    the other transport's fields, because the manager's schema refuses a
 *    cross-transport entry.
 * 3. **The read path shows what is there, even when it cannot be managed.** An
 *    entry that fails this version's validation is still mounted by the manager
 *    and still serves tools; hiding it would leave the page under-reporting a
 *    live fleet with no row to delete it from. It is projected with an
 *    {@link McpServerEntry.invalid} marker and an `error` status instead.
 *
 * The `id` of an entry IS its key: the manager derives the tool namespace
 * (`mcp__<name>__<tool>`) from the key, so a rename would move a tool namespace
 * out from under a model that was told the old one — it is refused.
 *
 * @module @dsh-app/plugin-mcp/store
 */

import {
  McpValidationError,
  validateEntry,
  type HostText,
  type McpServerEntry,
  type McpServersFile,
  type McpTransport,
} from './wire.ts'

export { McpValidationError, SERVER_NAME_PATTERN, validateEntry } from './wire.ts'

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
 * it cannot manage) instead of failing this plugin's activation. `configuration`
 * is optional for the same reason `entries` is: a line that provides the editor
 * without it can still be told apart from one that has no editor at all.
 */
export interface ConfigEditorLike {
  entries(): readonly ConfigRow[]
  configuration?(): readonly {
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
/** The whole `servers` map. */
type RawServers = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * The effective `servers` map from one editor view.
 *
 * The profile override wins over the composed layer, and only a *missing* key
 * falls through — an explicit `{}` is a real value (the user emptied the map).
 * @param view - one `configuration()` row.
 */
function serversOf(view: { readonly inherited: Record<string, unknown>, readonly override: Record<string, unknown> }): RawServers {
  if (isRecord(view.override.servers)) return view.override.servers
  if (isRecord(view.inherited.servers)) return view.inherited.servers
  return {}
}

/**
 * Project one raw config entry onto the shape the page shows.
 *
 * Lenient on purpose: an entry the local validator refuses is returned with an
 * `invalid` marker instead of being dropped, because the manager may well have
 * mounted it and its tools are live.
 */
function projectEntry(key: string, raw: RawServer): McpServerEntry {
  const transport: McpTransport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const base = {
    ...raw,
    id: key,
    serverName: key,
    transport,
    enabled: raw.enabled !== false,
  }
  try {
    return validateEntry(base, new Set())
  } catch (error) {
    // The reason carries the validator's own code, so the client's existing
    // dictionary renders it instead of showing an English diagnostic.
    const invalid: HostText = error instanceof McpValidationError
      ? error.hostText()
      : { code: 'entry.invalid', text: error instanceof Error ? error.message : String(error) }
    // The WHOLE raw entry, not a hand-picked subset: the fields that made it
    // invalid are exactly the ones the form has to show so the user can fix
    // them. An allowlist here is the same mistake as rebuilding on write.
    return { ...raw, id: key, serverName: key, transport, enabled: raw.enabled !== false, invalid }
  }
}

/**
 * One entry as the manager's config stores it.
 *
 * Merged over the entry's previous raw object (see rule 2 in the module docs):
 * the fields this version models are written, everything else the entry already
 * carried is kept. A transport change drops the previous transport's fields,
 * because the manager refuses an entry that names both.
 *
 * @param entry - the validated entry to store.
 * @param previous - its raw form before this write, when it had one.
 * @returns the raw config object.
 */
function assign(target: RawServer, key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(target, key)
  else target[key] = value
}

function toRawServer(entry: McpServerEntry, previous: RawServer | undefined): RawServer {
  const raw: RawServer = { ...previous }
  // The other transport's fields ALWAYS go, not only on a switch: the manager
  // refuses an entry that names both, and such an entry stays broken forever if a
  // save keeps it (the form has no field to clear the foreign one by hand).
  for (const field of entry.transport === 'stdio' ? ['url', 'headers'] : ['command', 'args', 'env', 'cwd']) {
    Reflect.deleteProperty(raw, field)
  }
  raw.transport = entry.transport
  raw.enabled = entry.enabled
  // Modelled fields are AUTHORITATIVE: an absent value means the user cleared
  // it, so it is deleted rather than left over. Keeping the old value here would
  // make "delete the env line and save" silently keep sending the credential.
  if (entry.transport === 'stdio') {
    assign(raw, 'command', entry.command)
    assign(raw, 'args', entry.args === undefined ? undefined : [...entry.args])
    assign(raw, 'env', entry.env === undefined ? undefined : { ...entry.env })
    assign(raw, 'cwd', entry.cwd)
  } else {
    assign(raw, 'url', entry.url)
    assign(raw, 'headers', entry.headers === undefined ? undefined : { ...entry.headers })
  }
  assign(raw, 'toolCallTimeoutMs', entry.toolCallTimeoutMs)
  return raw
}

/**
 * The fleet, over the manager's `config.servers`.
 *
 * Reads are synchronous (the config document is already in memory); writes go
 * through the editor and are computed from its live view. `enabled` is this
 * plugin's own switch: it makes the page read-only and reports the fleet as
 * offline, and it does NOT stop the manager — the servers the user configured
 * keep running, which is why the page says "read-only" rather than "stopped".
 */
export class McpStore {
  /** What the settings page shows as the store's location. */
  readonly filePath = `row "${MANAGER_ROW_ID}" → config.servers`

  constructor(
    /** Resolved per call: the editor may be mounted after activation. */
    private readonly editorOf: () => ConfigEditorLike | undefined,
    private readonly enabled: boolean,
  ) {}

  /** The row this store addresses, or undefined when the composition has none. */
  private row(): ConfigRow | undefined {
    return this.editorOf()?.entries().find((entry) => entry.options?.id === MANAGER_ROW_ID)
  }

  /**
   * The effective map, read through the editor's own view.
   *
   * Matched STRUCTURALLY: `configuration()` may hand back row objects that are
   * not the same JS object `entries()` returned, and an identity match would
   * then read nothing — which the write path would turn into "replace the whole
   * map with this one entry".
   */
  private rawServers(): RawServers {
    const editor = this.editorOf()
    if (editor === undefined) return {}
    const view = editor.configuration?.().find((candidate) => candidate.entry.options?.id === MANAGER_ROW_ID)
    if (view === undefined) {
      // The row exists but its configuration cannot be read. Answering `{}` here
      // would report an empty fleet for a manager that is mounting servers, and
      // the delete path would then answer "deleted" without writing anything.
      throw new McpValidationError('store.unreadable', { row: MANAGER_ROW_ID })
    }
    return serversOf(view)
  }

  /**
   * Read the fleet for display: every configured key, valid or not.
   *
   * @returns the fleet as the page sees it; `enabled` mirrors this plugin's own
   *   switch, not the manager's state.
   */
  load(): McpServersFile {
    return {
      version: 1,
      enabled: this.enabled,
      servers: Object.entries(this.rawServers()).map(([key, value]) => (isRecord(value)
        ? projectEntry(key, value)
        : projectEntry(key, {}))),
    }
  }

  /**
   * Apply one mutation to the document's live `servers` map.
   *
   * The callback runs inside `editor.edit`, so it sees the current document
   * (rule 1) and its result is what gets persisted. A callback that returns
   * `undefined` leaves the document untouched — that is how a no-op delete
   * avoids writing at all.
   *
   * @param change - derives the next `servers` map, or undefined for no write.
   * @throws McpValidationError when the row or its configuration is unreadable.
   */
  private async mutate(change: (servers: RawServers, previous: (key: string) => RawServer | undefined) => RawServers | undefined): Promise<void> {
    const editor = this.editorOf()
    const row = this.row()
    if (editor === undefined || row === undefined) {
      throw new McpValidationError('store.unavailable', { row: MANAGER_ROW_ID })
    }
    if (editor.configuration === undefined) {
      // Without the view we cannot read what is there, and writing anyway would
      // replace the whole map with a guess. Refuse instead.
      throw new McpValidationError('store.unreadable', { row: MANAGER_ROW_ID })
    }
    await editor.edit(row, (current, inherited) => {
      const servers = serversOf({ inherited, override: current })
      const next = change(servers, (key) => (isRecord(servers[key]) ? servers[key] as RawServer : undefined))
      return next === undefined ? current : { ...current, servers: next }
    })
  }

  /** Validate + insert one entry, keyed by its server name. */
  async create(raw: unknown): Promise<McpServerEntry> {
    const draft = isRecord(raw) ? raw : {}
    const name = asString(draft.serverName)
    if (name === undefined) throw new McpValidationError('serverName.invalid', { name: String(draft.serverName ?? '') })
    const entry = validateEntry({ ...draft, id: name, serverName: name }, new Set())
    await this.mutate((servers, previous) => {
      if (Object.hasOwn(servers, name)) throw new McpValidationError('serverName.taken', { name })
      return { ...servers, [name]: toRawServer(entry, previous(name)) }
    })
    return entry
  }

  /**
   * Validate + replace the entry stored under one key.
   *
   * @param id - the entry's key.
   * @param raw - the incoming entry.
   * @param withLive - optional last step over the stored entry AS IT IS NOW;
   *   the settings route uses it to put the values behind a mask sentinel back,
   *   so a secret rotated by another writer is not overwritten with the older
   *   value the page happened to be showing.
   */
  async update(id: string, raw: unknown, withLive?: (live: RawServer | undefined) => unknown): Promise<McpServerEntry> {
    const draft = isRecord(raw) ? raw : {}
    const requested = asString(draft.serverName) ?? id
    // The key is the identity: a rename here would move the tool namespace out
    // from under a model that was told the old one, so it is refused instead.
    if (requested !== id) throw new McpValidationError('serverName.immutable', { from: id, to: requested })
    let entry: McpServerEntry | undefined
    await this.mutate((servers, previous) => {
      if (!Object.hasOwn(servers, id)) throw new McpValidationError('server.notFound', { id })
      const body = withLive === undefined ? draft : withLive(previous(id))
      entry = validateEntry({ ...(isRecord(body) ? body : {}), id, serverName: id }, new Set())
      return { ...servers, [id]: toRawServer(entry, previous(id)) }
    })
    if (entry === undefined) throw new McpValidationError('store.unreadable', { row: MANAGER_ROW_ID })
    return entry
  }

  /**
   * Flip one entry's switch, leaving every other field as the document has it.
   *
   * The page's toggle used to post the whole entry it had loaded; a full replace
   * from a stale snapshot reverts whatever another writer changed in between.
   *
   * @param id - the entry key.
   * @param enabled - the next value.
   * @throws McpValidationError when the key is not configured.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutate((servers, previous) => {
      const entry = previous(id)
      if (entry === undefined) throw new McpValidationError('server.notFound', { id })
      return { ...servers, [id]: { ...entry, enabled } }
    })
  }

  /**
   * Remove one entry by key; a missing key is a no-op.
   *
   * The pre-read only answers "is there anything to do" — a needless write
   * makes the loader reconcile for nothing. The write itself is still computed
   * from the live document, so a key that appeared after this check is simply
   * left for the next attempt.
   */
  async remove(id: string): Promise<void> {
    if (!Object.hasOwn(this.rawServers(), id)) return
    await this.mutate((servers) => {
      if (!Object.hasOwn(servers, id)) return undefined
      const next = { ...servers }
      Reflect.deleteProperty(next, id)
      return next
    })
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
    // Same rule as remove: this pre-read only decides whether a write is needed.
    const present = this.rawServers()
    if (entries.every((entry) => Object.hasOwn(present, entry.serverName))) return 0
    let written = 0
    await this.mutate((servers, previous) => {
      const next = { ...servers }
      for (const entry of entries) {
        if (Object.hasOwn(next, entry.serverName)) continue
        next[entry.serverName] = toRawServer(entry, previous(entry.serverName))
        written += 1
      }
      return written === 0 ? undefined : next
    })
    return written
  }
}
