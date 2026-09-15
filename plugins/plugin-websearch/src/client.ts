/**
 * DSH APP web search manager — client half.
 *
 * Registers the settings-page section ("网络搜索", order 14): the provider
 * switch (品牌引擎链 / DeepSeek 官方), the engine chain with per-engine
 * enable/priority/key/probe, and the chain behavior knobs — all over the host
 * half's routes.
 *
 * @module @dsh-app/plugin-websearch/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { adoptStyles } from './client/styles.ts'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { WebSearchSection } from './client/websearch-section.tsx'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the web search settings page. */
const SECTION_ID = 'dsh-app-websearch'
const SECTION_LABEL = '网络搜索'

/**
 * Client apply: adopt styles, swap the nav's generic gear for a lens glyph,
 * and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'dsh-app plugin-websearch: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // Free slot between the brand pages: 12 = MCP 服务器, 13 = 钩子,
    // 16 = 用量, 17 = 归档; upstream owns 10/15/20.
    order: 14,
    label: () => SECTION_LABEL,
  }, WebSearchSection))
}
