/**
 * DSH APP plugin market — host half.
 *
 * Registers the market API routes over two collaborators:
 *
 * 1. The sources store (`$DSH_HOME/storages/dsh-app-plugin-market/
 *    sources.json`) — the user's catalog source URL list.
 * 2. The install executor — a serialized wrapper around the kernel's own
 *    `plugin` CLI, which forwards to the profile's package manager and
 *    reconciles the profile's bundle (mount) layer, so installing a package
 *    that declares `dsh.bundle` mounts it without any patch-file editing
 *    here. The CLI is pinned to the RUNNING kernel's bin (see npm.ts).
 *
 * The profile is `DSH_APP_PROFILE` (default `web`) — the same profile the
 * desktop shell boots, so what the panel installs is what the app loads on
 * its next start.
 *
 * It also mounts ONE model-facing tool, `market_search` (see bridge.ts), so a
 * user asking for "a skill that does X" gets real catalog hits. That half needs
 * the `tools` + `systemPrompt` services and is attached through an optional
 * injection: a kernel without them still gets the whole panel.
 *
 * @module @dsh-app/plugin-market
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the tools (ctx.tools) and systemPrompt (ctx.systemPrompt)
// Context merges into scope for the market bridge.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerMarketBridge } from './bridge.ts'
import { registerMarketInstallTools } from './bridge-install.ts'
import { PluginInstaller } from './installer.ts'
import { validateProfileName } from './npm.ts'
import { registerMarketRoutes } from './routes.ts'

export const name = 'plugin-market'

export const inject = ['connection']

/** Config: storage location + profile override. */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-market. */
  storePath: string
  /** Profile the market installs into; empty → $DSH_APP_PROFILE or `web`. */
  profile: string
}

export const Config: z<Config> = z.object({
  storePath: z.string().default(''),
  profile: z.string().default(''),
})

/** The effective profile for install operations. */
export function effectiveProfile(configProfile: string): string {
  const raw = configProfile !== '' ? configProfile : (process.env.DSH_APP_PROFILE ?? 'web')
  return validateProfileName(raw)
}

/**
 * Host apply: register the market routes on the Connection transport. A route
 * registration failure is the plugin's own and never fails the boot.
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== ''
    ? config.storePath
    : join(resolveDshHome(), 'storages', 'dsh-app-plugin-market')
  const profile = effectiveProfile(config.profile)
  const installer = new PluginInstaller(profile, process.argv[1], spawn, (message) => log.warn(message))

  ctx.effect(() => registerMarketRoutes(ctx.connection.fetch, {
    sourcesPath: join(dir, 'sources.json'),
    catalogCachePath: join(dir, 'catalog-cache.json'),
    installer,
    profile,
  }, (message) => log.warn(message)), 'plugin-market: api routes')

  // The model-facing bridge needs the tools + systemPrompt services, which a
  // rollback target may not carry; the panel is the market's main surface and
  // mounts either way, so the bridge is attached through an optional injection
  // rather than added to `inject` (which would gate the whole plugin).
  ctx.inject(['tools', 'systemPrompt'], bridgeCtx => {
    bridgeCtx.effect(() => registerMarketBridge(bridgeCtx, {
      sourcesPath: join(dir, 'sources.json'),
      catalogCachePath: join(dir, 'catalog-cache.json'),
      profile,
      log: (message) => log.warn(message),
    }), 'plugin-market: model bridge')
    // The write half rides the SAME serialized installer the panel drives, so
    // a conversational install and a drawer click can never run at once.
    bridgeCtx.effect(() => registerMarketInstallTools(bridgeCtx, { installer, profile }), 'plugin-market: model install tools')
  })

  log.info(`plugin market: sources at ${join(dir, 'sources.json')} (profile ${profile})`)
}
