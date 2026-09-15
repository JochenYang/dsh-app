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
 *      kernel version, desktop bridge availability. Still TODO as a service,
 *      but those three facts now DO reach this process: the shell injects them
 *      as environment variables and the diagnostics export writes them out
 *      (`diagnostics-report.ts`).
 *   3. The desktop bridge remotes — DONE: the trust-fenced routes under
 *      `/plugins/@dsh-app/plugin-brand/api` (see routes.ts) forward
 *      open-in-folder / notify / save-text-as / pick-directory / open-logs to
 *      the shell's own loopback bridge over the URL and bearer token the shell
 *      injects into this process's environment. That hop is an HTTP call, not
 *      the `@deepseek-ai/dsh-api-remotes` facade: the shell cannot register a
 *      remotes service, and every other suite plugin already exposes host
 *      capabilities this way. Environment-less runs (dev, older shell) answer
 *      `unsupported` instead of failing.
 *   4. The diagnostics reads — DONE: the same route table serves
 *      `GET /diagnostics/log-tail` (the newest server log in the directory the
 *      shell publishes as `DSH_APP_LOG_DIR`, see log-tail.ts) and
 *      `POST /diagnostics/export`, which assembles the plain-text package and
 *      saves it through the bridge. The restart counter still has no source
 *      here.
 *
 * The remaining two items still follow the dsh host plugin conventions
 * (see packages/settings and packages/api in the upstream repo).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerDesktopRoutes } from './routes.js'

export const name = 'dsh-app-brand'

// The web server owns route registration; without it the routes have no host.
export const inject = ['webServer']

export function apply(ctx: Context): void {
  // TODO(dev loop): ctx.settings.register('brand', BrandSettingsSchema) with
  // a settings provider so the client can read/write it through the settings
  // API (pattern: packages/settings + ui-theme's settingsScope usage).

  // TODO(dev loop): provide 'appInfo' service exposing shell version,
  // kernel version, update state — consumed by plugin-client-ui via the
  // host remotes facade.

  // Desktop bridge routes: fence + forward, removed with the plugin's fiber.
  const disposeRoutes = registerDesktopRoutes(ctx.webServer)
  ctx.effect(() => disposeRoutes, 'plugin-brand: dispose desktop bridge routes')
}
