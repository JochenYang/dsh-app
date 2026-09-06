/**
 * DSH APP MCP manager — host half.
 *
 * Mounts two things over one store
 * (`$DSH_HOME/storages/dsh-app-plugin-mcp/servers.json`):
 *
 * 1. Dynamic `@deepseek-ai/dsh-mcp-client` instances — one loader entry per
 *    enabled server (see mount.ts). The kernel's MCP bridge turns each
 *    server's tools into native `mcp__<serverName>__<tool>` tools; this
 *    plugin owns the user-facing CRUD around it, because the loader overlay
 *    is rewritten by the shell on every start and can never hold user state.
 *    The profile root the loader writes back to is reset by the harness each
 *    boot, so instances are process-scoped and the file is the only durable
 *    truth.
 * 2. Settings-page routes (list/create/update/delete) for the client half.
 *    Reads mask literal env/header values; writes are validated against the
 *    upstream contract (serverName pattern, transport fields, unique live
 *    namespaces) and applied to the running process inline.
 *
 * Stability discipline: a kernel without the loader seam or the tools
 * registry degrades (status `unavailable` / no tool counts) — the routes
 * still work against the file, and the boot never fails because of this
 * plugin. The master `enabled: false` in the file stops all mounts and makes
 * the write routes answer 409.
 *
 * @module @dsh-app/plugin-mcp
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { McpMountManager } from './mount.ts'
import { registerMcpRoutes } from './routes.ts'
import { McpStore } from './store.ts'

export const name = 'plugin-mcp'
export const inject = ['webServer']

/** Config: storage location. */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-mcp. */
  storePath: string
}

export const Config: z<Config> = z.object({
  storePath: z.string().default(''),
})

/**
 * Host apply: mount the dynamic mounts + routes. Mount failures and missing
 * kernel seams degrade to per-entry status instead of failing the boot.
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-mcp')
  const store = new McpStore(dir, (message) => log.warn(message))

  // The loader face is a process service on the context, not an injectable;
  // read it structurally so a kernel without it degrades instead of throwing.
  const loader = (ctx as unknown as { loader?: unknown }).loader
  const tools = ctx.get('tools')
  const manager = new McpMountManager((message) => log.warn(message), loader, tools)

  ctx.effect(() => {
    const file = store.load()
    if (!file.enabled) {
      log.info(`mcp manager: disabled by user config (${store.filePath})`)
      return () => undefined
    }
    if (!manager.available) {
      log.warn('mcp manager: loader seam unavailable on this kernel; servers stay unmounted')
    }
    void manager.syncAll(file.servers).catch((error: unknown) => {
      log.warn(`mcp manager: initial sync failed: ${(error as Error).message}`)
    })
    return () => {
      void manager.disposeAll().catch(() => undefined)
    }
  }, 'plugin-mcp: dynamic mounts')

  ctx.effect(() => registerMcpRoutes(ctx.webServer, store, manager), 'plugin-mcp: api routes')

  log.info(`mcp store: ${store.filePath}`)
}
