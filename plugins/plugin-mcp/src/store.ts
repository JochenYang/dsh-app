/**
 * The persisted store: `$DSH_HOME/storages/dsh-app-plugin-mcp/servers.json`.
 *
 * The desktop shell rewrites the loader overlay on every server start, so
 * this file is the single durable source of truth for the user's MCP server
 * set; every boot re-mounts from it. Reads validate entry-by-entry and
 * DEGRADE (drop the bad entry with a warning) instead of failing the boot —
 * the same discipline as plugin-swarm's user config. Writes come from the
 * settings-page routes and are atomic (tmp + rename).
 *
 * Secret hygiene: `env` / `headers` values may be `$ENV:NAME` references
 * (resolved only at mount time, never persisted as resolved values); literal
 * values are allowed (the file is a local, user-owned file) but are never
 * returned to the client — routes mask them (see routes.ts).
 *
 * Pure entry logic (validation, external JSON wiring) lives in wire.ts;
 * this module owns only the on-disk store.
 *
 * @module @dsh-app/plugin-mcp/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { McpValidationError, assertUniqueServerName, nextEntryId, validateEntry, type McpServerEntry, type McpServersFile } from './wire.ts'

// Re-exported so existing import sites (routes, tests) keep one surface.
export { McpValidationError, SERVER_NAME_PATTERN, nextEntryId, validateEntry } from './wire.ts'

type Raw = Record<string, unknown>

/** Parse the raw file content, or undefined when absent/unusable. */
function readRawFile(path: string, log: (message: string) => void): Raw | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined // missing file: the common first-run case
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    return parsed as Raw
  } catch (error) {
    log(`mcp servers file: unreadable, starting empty: ${(error as Error).message}`)
    return undefined
  }
}

/**
 * The servers.json store. All reads validate and degrade; writes are atomic
 * and full-file (the routes own merge semantics).
 *
 * Invalid-entry preservation: entries that fail validation are dropped from
 * the mounted set BUT kept verbatim in memory and re-attached on every save,
 * so a user's hand-edited file can never be silently rewritten without the
 * offending entry — it stays on disk until the user fixes (or removes) it.
 */
export class McpStore {
  readonly filePath: string

  /** Raw JSON of entries dropped by the last load(); re-attached on save. */
  private invalidRaw: unknown[] = []

  constructor(dir: string, private readonly log: (message: string) => void) {
    this.filePath = `${dir}/servers.json`
  }

  /**
   * Read the validated file. Invalid entries are dropped from the mounted
   * set (with a warning) and preserved for the next save. Never throws.
   */
  load(): McpServersFile {
    const raw = readRawFile(this.filePath, this.log)
    if (raw === undefined) return { version: 1, enabled: true, servers: [] }
    this.invalidRaw = []
    const enabled = raw.enabled !== false
    const servers: McpServerEntry[] = []
    const seenIds = new Set<string>()
    if (Array.isArray(raw.servers)) {
      for (const candidate of raw.servers) {
        try {
          const entry = validateEntry(candidate, seenIds)
          seenIds.add(entry.id)
          servers.push(entry)
        } catch (error) {
          this.log(`mcp servers file: keeping an invalid entry aside: ${(error as Error).message}`)
          this.invalidRaw.push(candidate)
        }
      }
    }
    return { version: 1, enabled, servers }
  }

  /** Atomically persist a full file. The caller owns validation. */
  save(file: McpServersFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const merged: McpServersFile = this.invalidRaw.length > 0
      ? { ...file, servers: [...file.servers, ...this.invalidRaw as McpServerEntry[]] }
      : file
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** Validate + insert one new entry (id assigned here). */
  create(raw: unknown): McpServerEntry {
    const file = this.load()
    const id = nextEntryId(file.servers)
    const entry = validateEntry({ ...(raw as Raw), id }, new Set(file.servers.map(server => server.id)))
    assertUniqueServerName(entry, file.servers)
    this.save({ ...file, servers: [...file.servers, entry] })
    return entry
  }

  /** Validate + replace one entry by id. */
  update(id: string, raw: unknown): McpServerEntry {
    const file = this.load()
    if (!file.servers.some(server => server.id === id)) {
      throw new McpValidationError(`服务器 ${id} 不存在`)
    }
    // validateEntry's existing-id check means OTHER entries: the entry keeps
    // its own id through the edit.
    const otherIds = new Set(file.servers.filter(server => server.id !== id).map(server => server.id))
    const entry = validateEntry({ ...(raw as Raw), id }, otherIds)
    assertUniqueServerName(entry, file.servers.filter(server => server.id !== id))
    this.save({ ...file, servers: file.servers.map(server => (server.id === id ? entry : server)) })
    return entry
  }

  /** Remove one entry by id; a missing id is a no-op. */
  remove(id: string): void {
    const file = this.load()
    this.save({ ...file, servers: file.servers.filter(server => server.id !== id) })
  }
}
