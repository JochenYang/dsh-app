/**
 * DSH APP MCP manager — client half.
 *
 * Registers the settings-page section ("MCP 服务器", order 12): the server
 * list with live mount status, the add/edit form (transport-switched field
 * groups), enable toggles and delete — all over the host half's routes.
 *
 * @module @dsh-app/plugin-mcp/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { McpSection } from './client/mcp-section.tsx'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the MCP settings page. */
const SECTION_ID = 'dsh-app-mcp'
const SECTION_LABEL = 'MCP 服务器'

/**
 * Client apply: adopt styles, swap the nav's generic gear for the MCP plug
 * glyph, and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'dsh-app plugin-mcp: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // Free slot between the brand pages: 11 = 模型高级设置, 16 = 用量,
    // 17 = 归档, 18 = 记忆, 19 = 并行子代理; upstream owns 10/15/20.
    order: 12,
    label: () => SECTION_LABEL,
  }, McpSection))
}
