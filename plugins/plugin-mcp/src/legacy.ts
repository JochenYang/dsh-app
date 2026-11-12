/**
 * One-time import of `$DSH_HOME/storages/dsh-app-plugin-mcp/servers.json`.
 *
 * That file was this plugin's store until 0.2.2-rc.2 gave the fleet to the
 * kernel's `mcp-manager`. A user who configured servers before the move must
 * not lose them, so the first activation reads the file, converts it and writes
 * it into the manager row — then renames the file aside instead of deleting it,
 * because an uninstall/rollback path may want it and a silent delete of user
 * data is not this plugin's call.
 *
 * Three conversions are real, not cosmetic:
 *
 * - `$ENV:NAME` (this plugin's own reference syntax) becomes `${credential:NAME}`,
 *   the template the manager's instances resolve. A literal value stays literal:
 *   it is a local, user-owned file, and rewriting an inline token into a
 *   reference would invent a credential the user never made.
 * - An entry's `id` (`mcp-1`…) is dropped. The key IS the identity now: the
 *   manager derives the model-facing namespace `mcp__<key>__<tool>` from it, so
 *   keeping a separate id would leave two names for one server.
 * - The retired file's GLOBAL `enabled: false` becomes per-entry `enabled: false`
 *   on every imported entry. That switch meant "mount nothing"; carrying the
 *   fleet in with `enabled: true` would start every one of those servers — and
 *   the file is renamed aside after the write, so the intent would be lost with
 *   it. The manager has no global switch, so per-entry is the faithful mapping.
 *
 * @module @dsh-app/plugin-mcp/legacy
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { validateEntry, type McpServerEntry } from './wire.ts'
import type { McpStore } from './store.ts'

/** This plugin's old reference syntax: the whole value, never a substring. */
const ENV_REFERENCE = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * Convert one value to the manager's credential template.
 * @param value - a stored env/header value.
 * @returns the template form, or the value unchanged.
 */
function toCredentialTemplate(value: string): string {
  const match = ENV_REFERENCE.exec(value)
  return match === null ? value : `\${credential:${match[1]}}`
}

function convertMap(map: unknown): Record<string, string> | undefined {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string') out[key] = toCredentialTemplate(value)
  }
  return out
}

/**
 * Read the old file, if it is still there.
 *
 * Invalid entries are skipped individually — one hand-edited mistake must not
 * cost the user the rest of the fleet.
 *
 * @param file - absolute path of the old `servers.json`.
 * @param log - warning sink (the caller passes its logger).
 * @returns the entries that survived, the raw count that did not, and whether
 *   the retired file's own master switch was off.
 */
export function readLegacyServers(file: string, log: (message: string) => void): { entries: McpServerEntry[], skipped: number, disabledGlobally: boolean } {
  if (!existsSync(file)) return { entries: [], skipped: 0, disabledGlobally: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    log(`legacy servers file: unreadable, left in place: ${(error as Error).message}`)
    return { entries: [], skipped: 0, disabledGlobally: false }
  }
  const servers = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as { servers?: unknown }).servers
    : undefined
  if (!Array.isArray(servers)) {
    log('legacy servers file: no `servers` array, left in place')
    return { entries: [], skipped: 0, disabledGlobally: false }
  }
  // The retired global switch: false meant "mount nothing". See the module docs
  // for why that becomes per-entry `enabled: false` rather than being dropped.
  const disabledGlobally = (parsed as { enabled?: unknown }).enabled === false
  const entries: McpServerEntry[] = []
  const taken = new Set<string>()
  let skipped = 0
  for (const candidate of servers) {
    try {
      const raw = typeof candidate === 'object' && candidate !== null ? { ...candidate as Record<string, unknown> } : {}
      const name = typeof raw.serverName === 'string' ? raw.serverName : ''
      const converted = {
        ...raw,
        id: name,
        serverName: name,
        ...(convertMap(raw.env) !== undefined ? { env: convertMap(raw.env) } : {}),
        ...(convertMap(raw.headers) !== undefined ? { headers: convertMap(raw.headers) } : {}),
      }
      const entry = validateEntry(converted, taken)
      taken.add(entry.serverName)
      entries.push(entry)
    } catch (error) {
      skipped += 1
      log(`legacy servers file: skipped one entry: ${(error as Error).message}`)
    }
  }
  return { entries, skipped, disabledGlobally }
}

/**
 * Import the old fleet into the manager row, once.
 *
 * A no-op when the file is absent, when it holds nothing usable, or when the row
 * already knows every one of those keys (`McpStore.importAll` merges). The file
 * is renamed to `<name>.migrated` only after a write actually happened, so a
 * failed write leaves the source where the next start can retry it.
 *
 * @param store - the fleet store.
 * @param file - absolute path of the old `servers.json`.
 * @param log - warning/info sink.
 */
export async function importLegacyServers(store: McpStore, file: string, log: (message: string) => void): Promise<void> {
  const { entries: read, skipped, disabledGlobally } = readLegacyServers(file, log)
  const entries = disabledGlobally ? read.map((entry) => ({ ...entry, enabled: false })) : read
  if (entries.length === 0) {
    if (skipped > 0) log(`legacy servers file: nothing importable (${skipped} skipped); left in place`)
    return
  }
  const written = await store.importAll(entries)
  // Retire the source whenever the row now holds EVERY key — including the case
  // where it already did. Leaving it behind (the old behaviour) resurrects a
  // server the user deletes from the page on the next start, because this import
  // runs before the page exists.
  if (written === 0) log('legacy servers file: every entry is already configured; retiring the source')
  const aside = `${file}.migrated`
  try {
    renameSync(file, existsSync(aside) ? `${aside}-${Date.now()}` : aside)
  } catch (error) {
    // Never silent: this file will be re-read on the next start, so a failed
    // rename is a resurrection risk the log has to name.
    log(`legacy servers file: could not retire it (${(error as Error).message}); it will be read again on the next start`)
    return
  }
  log(`legacy servers file: imported ${written} entry/entries into the mcp-manager row`
    + `${disabledGlobally ? ' as disabled (the old file had its global switch off)' : ''}`
    + `${skipped > 0 ? `, ${skipped} skipped` : ''}`)
}
