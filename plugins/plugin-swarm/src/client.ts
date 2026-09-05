/**
 * DSH APP swarm — client half.
 *
 * Registers the settings-page section ("并行子代理"): enable toggle,
 * adaptive toggle, and the scheduling knobs backed by the host half's
 * config routes. See the host half's header for the full feature contract.
 *
 * @module @dsh-app/plugin-swarm/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SwarmSection } from './client/swarm-section.tsx'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the swarm settings page. */
const SECTION_ID = 'dsh-app-swarm'
const SECTION_LABEL = '并行子代理'

/**
 * Client apply: adopt styles and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // After the memory page (18) — a tuning surface for the swarm batch tool.
    order: 19,
    label: () => SECTION_LABEL,
  }, SwarmSection))
}
