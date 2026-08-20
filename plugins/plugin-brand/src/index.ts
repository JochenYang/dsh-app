/**
 * DSH APP brand host plugin (server side).
 *
 * Runs inside the dsh host process (the local dsh server the desktop shell
 * spawns). It should provide:
 *
 *   1. A `brand` settings namespace (dsh-settings provider) carrying
 *      app-level options: update channel preference, telemetry opt-in,
 *      onboarding flags.
 *   2. An `app` info service consumed by the client side: shell version,
 *      kernel version, desktop bridge availability.
 *   3. The desktop bridge: expose shell capabilities (git info for the
 *      workspace panel, native save dialogs, open-in-folder) over the host
 *      remotes facade (@deepseek-ai/dsh-api) so client plugins can call
 *      them through the normal dsh API seam instead of bespoke IPC.
 *
 * The exact service/namespace wiring follows the dsh host plugin conventions
 * (see packages/settings and packages/api in the upstream repo). This file is
 * the scaffold — wire the services in the dev loop, then remove this note.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-app-brand'

export const inject = ['settings']

export function apply(ctx: Context): void {
  // TODO(dev loop): ctx.settings.register('brand', BrandSettingsSchema) with
  // a settings provider so the client can read/write it through the settings
  // API (pattern: packages/settings + ui-theme's settingsScope usage).

  // TODO(dev loop): provide 'appInfo' service exposing shell version,
  // kernel version, update state — consumed by plugin-client-ui via the
  // host remotes facade.

  // TODO(dev loop): register desktop bridge remotes (git info, native
  // dialogs, open-in-folder) guarded by the trusted-host fence.

  // No host-side behavior yet; the loader entry only needs to be loadable.
}
