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
 * zip, see backup.ts): the host settings file, the profile patch layer and
 * manifest, the market source list, and whitelisted suite-plugin store files
 * — never credential files.
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
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import { effectiveBackupProfile } from './backup.ts'
import { migrateLegacyPresets } from './legacy-migration.ts'
import { registerBackupRoutes, registerPresetRoutes } from './routes.ts'
import { PresetStore } from './store.ts'

export const name = 'plugin-presets'

/**
 * The presets page rides the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['connection']

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

  ctx.effect(() => registerPresetRoutes(ctx.connection.fetch, store, rootDisplay), 'plugin-presets: api routes')
  ctx.effect(() => registerBackupRoutes(ctx.connection.fetch, { home: resolveDshHome(), profile }), 'plugin-presets: config-backup routes')

  // Declare any preset still in the pre-0.1.7 DIRECTORY shape: 0.1.7 removed the
  // loader that mounted `.agent-presets/<id>/agent.cordis.yml`, so such a preset
  // is simply absent from the registry until it is restated as a
  // `@deepseek-ai/dsh-agent-preset` row. The row is appended to the HOME layer
  // (the user's own patch file, and where the shell's own header says user rows
  // belong) so it applies to every profile; one boot later the kernel reads it.
  //
  // Best-effort by construction: this never fails the mount, never moves or
  // deletes the user's files, and skips anything it cannot read.
  try {
    const outcome = migrateLegacyPresets({ presetRoot: root, patchPath: join(resolveDshHome(), 'cordis.patch.yml') })
    if (outcome.added.length > 0) {
      log.info(`declared legacy presets in the home layer: ${outcome.added.join(', ')} (they appear after the next start)${outcome.backup === undefined ? '' : `; previous layer copied to ${outcome.backup}`}`)
    }
    for (const entry of outcome.skipped) {
      // "Already declared" is the normal state of every boot after the first;
      // anything else is worth a line.
      if (entry.reason !== 'already declared') log.warn(`legacy preset ${entry.id}: ${entry.reason}`)
    }
  } catch (error) {
    log.warn(`legacy preset migration failed: ${(error as Error).message}`)
  }

  log.info(`preset packages root: ${rootDisplay !== '' ? rootDisplay : root}; config backup profile: ${profile}`)
}
