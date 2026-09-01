/**
 * DSH APP sidebar dock — client half apply.
 *
 * The dock IS the conversation view ring: 文件 and Git register as native
 * `conversation.view` tabs (same ring as 对话/审查/轨迹), each rendering a
 * full page in the conversation area. No floating chrome — the tab row is
 * the rail, so there is nothing to mis-position, nothing a drag strip can
 * swallow, and the panel can never cover the chat.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) and the conversation
// view-tab SlotMap merges ('conversation.view') into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { registerDockViews } from './views.tsx'

/** The client halves this plugin depends on. */
export const inject = ['slots', 'connection', 'sessions']

/**
 * Client apply: register the two native views.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  registerDockViews(ctx)
}
