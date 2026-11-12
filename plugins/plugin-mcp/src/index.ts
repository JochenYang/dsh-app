/**
 * DSH APP MCP manager — host half.
 *
 * 0.2.2-rc.2 moved the fleet to the kernel: `@deepseek-ai/dsh-mcp-manager`
 * mounts one `@deepseek-ai/dsh-mcp-client` per configured server, reconciles
 * them as the row's config changes, and reports status over one view. This
 * plugin keeps the settings page and gives it that manager instead of a fleet of
 * its own — one store (`mcp-manager`'s `config.servers`), one set of instances,
 * so the same tool name is never registered twice.
 *
 * What it still owns:
 *
 * 1. Settings-page routes (list/create/update/delete/import) for the client
 *    half, written through the kernel's config editor — the same path its own
 *    pages take, including the revision check that refuses a stale write.
 * 2. The one-time import of `$DSH_HOME/storages/dsh-app-plugin-mcp/servers.json`,
 *    the store this plugin had before the move (see legacy.ts).
 *
 * Stability discipline: a kernel without `ctx.configEditor` or `ctx.mcpManager`
 * degrades — the page reports it cannot manage, and the boot never fails because
 * of this plugin. `enabled: false` in this plugin's own config makes the page
 * read-only (409 on writes) and reports every entry as disabled, without
 * touching what the user configured.
 *
 * @module @dsh-app/plugin-mcp
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import { importLegacyServers } from './legacy.ts'
import { registerMcpRoutes } from './routes.ts'
import { McpStore, type ConfigEditorLike } from './store.ts'
import { McpFleetStatus, type McpFleetLike } from './status.ts'

export const name = 'plugin-mcp'

/**
 * The manager rides the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['connection']

/** Config: this plugin's own switch, plus where the pre-0.2.2 file lived. */
export interface Config {
  /** Master switch: false makes the page read-only and reports every entry as disabled. */
  enabled: boolean
  /** Absolute directory of the legacy store; empty → $DSH_HOME/storages/dsh-app-plugin-mcp. */
  storePath: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  storePath: z.string().default(''),
})

/**
 * Host apply: register the routes over the kernel manager's fleet.
 *
 * Both kernel services are read structurally: the config editor and the manager
 * are resolved by name, so a line without them starts this plugin with a
 * read-only page instead of failing.
 *
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-mcp')
  const legacyFile = join(dir, 'servers.json')

  // Resolved per call, not captured: the editor and the manager are services the
  // composition may mount after this plugin activates (or replace on a reload),
  // and a captured `undefined` would leave the page read-only forever while the
  // kernel mounts the fleet fine.
  const editorOf = (): ConfigEditorLike | undefined => ctx.get('configEditor') as ConfigEditorLike | undefined
  const fleetOf = (): McpFleetLike | undefined => ctx.get('mcpManager') as McpFleetLike | undefined
  const store = new McpStore(editorOf, config.enabled)
  const status = new McpFleetStatus(fleetOf)

  const editor = editorOf()
  if (editor === undefined) {
    log.warn('mcp: this kernel mounts no config editor; the page is read-only and nothing is imported')
  } else if (fleetOf() === undefined) {
    log.warn('mcp: this kernel mounts no mcp-manager; servers configured here cannot be mounted')
  }

  ctx.effect(() => {
    if (editor === undefined) return () => undefined
    // The switch off means "this page is read-only"; importing into the user's
    // row would be a write they asked us not to make. It runs on the first
    // enabled start instead.
    if (!config.enabled) {
      log.info('mcp: plugin disabled by config; the legacy import waits for an enabled start')
      return () => undefined
    }
    void importLegacyServers(store, legacyFile, (message) => {
      if (message.includes('imported')) log.info(message)
      else log.warn(message)
    }).catch((error: unknown) => {
      log.warn(`mcp: legacy import failed: ${(error as Error).message}`)
    })
    return () => undefined
  }, 'plugin-mcp: legacy store import')

  ctx.effect(() => registerMcpRoutes(ctx.connection.fetch, store, status), 'plugin-mcp: api routes')

  log.info(`mcp store: ${store.filePath}${config.enabled ? '' : ' (disabled by config)'}`)
}
