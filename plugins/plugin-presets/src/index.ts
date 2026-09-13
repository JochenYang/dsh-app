/**
 * DSH APP preset packages — host half.
 *
 * Exports locally authored agent presets (the kernel's default user preset
 * root, `<dshHome>/.agent-presets`) as shareable `.dshpreset` archives and
 * imports archives back into that same root. Built-in shipped presets and
 * deployment-configured preset roots live outside this root and are never
 * touched: a package can only ever carry a locally authored preset, and the
 * imported preset appears in the session preset picker exactly like a
 * hand-authored copy would.
 *
 * The settings section also carries the config backup (`dsh-config-backup`
 * zip, see backup.ts): the profile patch layer and manifest, the market
 * source list, and whitelisted suite-plugin store files — never credential
 * files.
 *
 * All archive-level safety (manifest shape, entry whitelist, path
 * containment, size/count caps) is enforced in wire/pack/backup before the
 * store writes anything; the routes only add HTTP framing. A missing root or
 * an empty roster is the normal first-run state — the boot never fails
 * because of this plugin.
 *
 * @module @dsh-app/plugin-presets
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { effectiveBackupProfile } from './backup.ts'
import { registerBackupRoutes, registerPresetRoutes } from './routes.ts'
import { PresetStore } from './store.ts'

export const name = 'plugin-presets'
export const inject = ['webServer']

/** Config: managed preset root override. */
export interface Config {
  /** Absolute preset root; empty → <dshHome>/.agent-presets. */
  presetPath: string
}

export const Config: z<Config> = z.object({
  presetPath: z.string().default(''),
})

/**
 * Host apply: register the preset-package routes.
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const overridden = config.presetPath !== ''
  const root = overridden ? config.presetPath : join(resolveDshHome(), '.agent-presets')
  // The client only ever gets the symbolic home display, never the path.
  const rootDisplay = overridden ? '' : `${dshHomeDisplay(resolveDshHome())}/.agent-presets`
  const store = new PresetStore(root)
  // The backup applies to the same profile the desktop shell boots (DSH_APP_PROFILE,
  // default `web`); an unusable name degrades to that default — the boot never
  // fails over a backup route.
  const profile = effectiveBackupProfile(process.env.DSH_APP_PROFILE)

  ctx.effect(() => registerPresetRoutes(ctx.webServer, store, rootDisplay), 'plugin-presets: api routes')
  ctx.effect(() => registerBackupRoutes(ctx.webServer, { home: resolveDshHome(), profile }), 'plugin-presets: config-backup routes')

  log.info(`preset packages root: ${rootDisplay !== '' ? rootDisplay : root}; config backup profile: ${profile}`)
}
