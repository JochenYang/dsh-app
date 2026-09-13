/**
 * DSH APP preset packages — client half.
 *
 * Registers the settings-page section ("预设包", order 21): the list of
 * locally authored presets with one-click export to a downloaded
 * `.dshpreset` file, and a file-picker import that validates server-side and
 * asks for explicit confirmation before overwriting an existing preset. The
 * nav cell swaps the shell's generic gear for a sliders glyph via the same
 * label-matching patch the other suite sections use (the section slot
 * contract has no icon field).
 *
 * @module @dsh-app/plugin-presets/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PresetsSection } from './client/presets-section.tsx'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the preset-packages settings page. */
const SECTION_ID = 'dsh-app-presets'
const SECTION_LABEL = '预设包'

/**
 * Client apply: adopt styles, swap the nav's generic gear for the sliders
 * glyph, and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'dsh-app plugin-presets: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // Free slot after the suite pages: 12 = MCP, 16 = 用量, 17 = 归档,
    // 18 = 记忆, 19 = 并行子代理; upstream owns 10/15/20.
    order: 21,
    label: () => SECTION_LABEL,
  }, PresetsSection))
}
