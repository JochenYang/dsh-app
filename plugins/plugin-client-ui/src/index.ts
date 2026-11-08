/**
 * Host loader entry for the browser implementation exported from `./client`.
 *
 * The brand client plugin's only host-side behaviour is the model connectivity
 * probe: a browser cannot send a provider's credential (the key never leaves the
 * host), so the check runs here and answers over one authenticated Connection
 * route. Everything else the settings page does travels on the kernel's own
 * remotes.
 *
 * @module @dsh-app/plugin-client-ui
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the host connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import { registerProbeRoute } from './probe.ts'

export const name = 'plugin-client-ui'

/** The probe rides the Connection exact-Fetch registry; no other host service is needed. */
export const inject = ['connection']

/**
 * Host plugin body: register the probe route with this plugin's fiber.
 * @param ctx - the host context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerProbeRoute(ctx.connection.fetch, ctx), 'dsh-app plugin-client-ui: probe route')
}
