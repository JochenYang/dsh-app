/**
 * DSH APP sidebar dock — client half apply.
 *
 * The dock IS the conversation view ring: Git registers as a native
 * `conversation.view` tab (same ring as 对话/审查/轨迹), rendering a full
 * page in the conversation area. No floating chrome — the tab row is
 * the rail, so there is nothing to mis-position, nothing a drag strip can
 * swallow, and the panel can never cover the chat.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) and the conversation
// view-tab SlotMap merges ('conversation.view') into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as sidebarEn, NS as SIDEBAR_NS, zh as sidebarZh } from './locales.ts'
import type { SidebarKey } from './locales.ts'
import { registerDockViews } from './views.tsx'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the Git tab's `t` seat below.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the Git view tab: status list, diff, graph, sync actions. */
    [SIDEBAR_NS]: SidebarKey
  }
}

/** The client halves this plugin depends on (`locale` provides the copy seat). */
export const inject = ['slots', 'connection', 'sessions', 'locale']

/**
 * Client apply: register the dictionaries and the native view.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionary first: the tab body's `t` seat resolves through this
  // namespace, and the effect disposes the pair with this plugin's fiber. ---
  ctx.effect(
    () => ctx.locale.register(SIDEBAR_NS, { zh: sidebarZh, en: sidebarEn }),
    'dsh-app plugin-sidebar: dictionaries',
  )
  registerDockViews(ctx)
}
