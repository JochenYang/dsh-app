/**
 * DSH APP brand host plugin (server side).
 *
 * Runs inside the dsh host process (the desktop host the Electron shell spawns).
 * It should provide:
 *
 *   1. A `brand` settings namespace (dsh-settings provider) carrying
 *      app-level options: update channel preference, telemetry opt-in,
 *      onboarding flags.
 *   2. An `app` info service consumed by the client side: shell version,
 *      kernel version, desktop action availability. Still TODO as a service,
 *      but those three facts now DO reach this process: the shell injects them
 *      as environment variables and the diagnostics export writes them out
 *      (`diagnostics-facts.ts`).
 *   3. The desktop actions — DONE, on two transports. The routes under
 *      `/api/plugins/dsh-app/plugin-brand` (see routes.ts) ride the Connection
 *      exact-Fetch registry, which is the ONLY seam a desktop-host composition
 *      offers: it disables the `webserver` row, so a plugin that waits for
 *      `ctx.webServer` never activates. `open-in-folder` and `pick-directory`
 *      are performed by the kernel itself (`native-actions.ts`: the session
 *      controller's native opener and the directory-picker seam);
 *      notify / save-text-as / open-logs are performed by the SHELL, whose
 *      route lives on the `dsh-app` scheme — unreachable from this process, so
 *      these routes hand the CLIENT the exact coordinates and the page calls
 *      them from the origin they belong to (`shell-actions.ts`).
 *   4. The diagnostics reads — DONE: the same route table serves
 *      `GET /diagnostics/log-tail` (the newest server log in the directory the
 *      shell publishes as `DSH_APP_LOG_DIR`, see log-tail.ts) and
 *      `POST /diagnostics/export`, which publishes the facts the page writes the
 *      package from. The restart counter still has no source here.
 *
 * The remaining two items still follow the dsh host plugin conventions
 * (see packages/settings and packages/api in the upstream repo).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { DirectoryPicker, NativeSeams, SessionOpener } from './native-actions.js'
import { registerDesktopRoutes } from './routes.js'

export const name = 'dsh-app-brand'

/**
 * The routes ride the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * The web server is deliberately NOT injected: the desktop host disables its
 * `webserver` row, so a plugin that waits for it never activates at all.
 */
export const inject = ['connection']

export function apply(ctx: Context): void {
  // TODO(dev loop): ctx.settings.register('brand', BrandSettingsSchema) with
  // a settings provider so the client can read/write it through the settings
  // API (pattern: packages/settings + ui-theme's settingsScope usage).

  // TODO(dev loop): provide 'appInfo' service exposing shell version,
  // kernel version, update state — consumed by plugin-client-ui via the
  // host remotes facade.

  // The kernel seams the desktop actions ride. Resolved per request rather than
  // injected: a composition without a picker (or a kernel that predates the
  // service) degrades that one action instead of keeping the whole plugin —
  // diagnostics included — from activating. `ctx.get` returns `any` for a name
  // outside the typed Context surface, hence the structural narrowing here.
  const seams: NativeSeams = {
    opener: () => ctx.get('sessionController') as SessionOpener | undefined,
    picker: () => ctx.get('directoryPicker') as DirectoryPicker | undefined,
  }

  // Desktop routes: connection transport, removed with the plugin's fiber.
  ctx.effect(() => registerDesktopRoutes(ctx.connection.fetch, seams), 'plugin-brand: dispose desktop routes')
}
