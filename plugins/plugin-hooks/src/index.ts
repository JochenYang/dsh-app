/**
 * DSH APP hooks bridge — host half.
 *
 * Mounts two things over one store
 * (`$DSH_HOME/storages/dsh-app-plugin-hooks/config.json`):
 *
 * 1. Dynamic hooks-bridge instances — one loader entry per enabled bridge
 *    (see mount.ts). The kernel's hooks engine reads the user's existing
 *    Claude Code / Codex hooks.json and fires command hooks at the
 *    corresponding interception points (SessionStart, prompt/tool pre/post,
 *    Stop). configPath is read once at load; updates remount the entry.
 * 2. Settings-page routes (list/create/update/delete) for the client half.
 *
 * Stability discipline: a kernel without the loader seam degrades to
 * `unavailable` status; a missing shell/sessionProjections service makes
 * the bridge fail per-entry (reported in status, never a boot failure).
 *
 * @module @dsh-app/plugin-hooks
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HooksMountManager } from './mount.ts'
import { NativeHookRuntime } from './native.ts'
import { registerHooksRoutes } from './routes.ts'
import { HooksStore } from './store.ts'

export const name = 'plugin-hooks'
export const inject = ['webServer']

export interface Config { storePath: string }
export const Config: z<Config> = z.object({ storePath: z.string().default('') })

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-hooks')
  const store = new HooksStore(dir, (message) => log.warn(message))
  const loader = (ctx as unknown as { loader?: unknown }).loader
  const manager = new HooksMountManager((message) => log.warn(message), loader)
  const native = new NativeHookRuntime((message) => log.warn(message))

  // Native-format rules: typed interception handlers registered once on the
  // plugin context (host listeners receive agent-scoped events); the handler
  // bodies dispatch against the live rule set refreshed by native.sync().
  ctx.effect(() => native.register(ctx), 'plugin-hooks: native handlers')

  ctx.effect(() => {
    const file = store.load()
    if (!file.enabled) {
      log.info(`hooks plugin: disabled by user config (${store.filePath})`)
      return () => undefined
    }
    if (!manager.available) log.warn('hooks plugin: loader seam unavailable on this kernel; compatibility bridges stay unmounted')
    const nativeEntries = file.bridges.filter(bridge => bridge.dialect === 'native')
    const bridges = file.bridges.filter(bridge => bridge.dialect !== 'native')
    native.sync(nativeEntries)
    void manager.syncAll(bridges).catch((error: unknown) => {
      log.warn(`hooks plugin: bridge sync failed: ${(error as Error).message}`)
    })
    return () => { void manager.disposeAll().catch(() => undefined) }
  }, 'plugin-hooks: dynamic mounts')

  ctx.effect(() => registerHooksRoutes(ctx.webServer, store, manager, native), 'plugin-hooks: api routes')
  log.info(`hooks store: ${store.filePath}`)
}
