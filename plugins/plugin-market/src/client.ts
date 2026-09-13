/**
 * DSH APP plugin market — client half.
 *
 * Registers one entry in `sidebar.footer.action` (the additive action row at
 * the sidebar foot, directly above the settings seat): the market entry. The
 * panel itself is a drawer rendered by the entry component — no floating
 * chrome of its own, no other slot is touched.
 *
 * @module @dsh-app/plugin-market/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) and the sidebar
// contract's SlotMap merge ('sidebar.footer.action' + its owner props) into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MarketFooterAction } from './client/panel.tsx'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** List identity of the market entry. */
const ENTRY_ID = 'dsh-app-market'
const ENTRY_LABEL = '插件市场'

/**
 * Client apply: adopt styles and register the market entry.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  // Order 10 places the entry before ui-settings' row renders into the same
  // foot area (the settings seat is a separate slot below the action row;
  // order only ranks entries inside this list).
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: ENTRY_ID,
    order: 10,
    label: () => ENTRY_LABEL,
  }, MarketFooterAction))
}
