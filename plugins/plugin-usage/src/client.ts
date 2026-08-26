/**
 * DSH APP usage statistics — client half.
 *
 * Registers the settings-page section ("用量统计"). Third-party usage
 * plugins coexist by design (each renders its own page over its own data —
 * see the host half's header), so this half always registers. A user who
 * prefers their own plugin disables this one through the user config file
 * (`<storeDir>/config.json`, `enabled: false`), and the section then shows
 * the disabled notice from the host's /status signal instead of data.
 *
 * @module @dsh-app/plugin-usage/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section')
// and the slot utility prop faces into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { UsageSection } from './client/usage-section.tsx'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the usage settings page. */
const SECTION_ID = 'dsh-app-usage'
const SECTION_LABEL = '用量统计'

/**
 * Client apply: adopt styles and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // After the Plugins page (15) — usage is a read-only report, not a
    // frequently touched settings surface.
    order: 16,
    label: () => SECTION_LABEL,
  }, UsageSection))
}
