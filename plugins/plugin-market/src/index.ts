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
 * @module @dsh-app/plugin-market
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import { PluginInstaller } from './installer.ts'
import { validateProfileName } from './npm.ts'
import { registerMarketRoutes } from './routes.ts'

export const name = 'plugin-market'

/**
 * The market rides the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * The web server is deliberately NOT injected: the desktop host disables its
 * `webserver` row, so a plugin that waits for it never activates at all.
 */
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
 * Profile a package can be inherited from: the one the shell booted before it
 * had a profile of its own, exported as `DSH_APP_LEGACY_PROFILE`. A kernel
 * started without that variable (a user running `dsh` by hand) falls back to
 * `web`, which is also where it would have installed its own plugins.
 */
export function effectiveLegacyProfile(): string {
  const raw = (process.env.DSH_APP_LEGACY_PROFILE ?? '').trim()
  return raw === '' ? 'web' : validateProfileName(raw)
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
  const legacyProfile = effectiveLegacyProfile()
  const installer = new PluginInstaller(profile, process.argv[1], spawn, (message) => log.warn(message))

  ctx.effect(() => registerMarketRoutes(ctx.connection.fetch, {
    sourcesPath: join(dir, 'sources.json'),
    catalogCachePath: join(dir, 'catalog-cache.json'),
    installer,
    profile,
    legacyProfile,
  }, (message) => log.warn(message)), 'plugin-market: api routes')

  log.info(`plugin market: sources at ${join(dir, 'sources.json')} (profile ${profile}, inheriting from ${legacyProfile})`)
}
