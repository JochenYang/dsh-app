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
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as mcpEn, NS as MCP_NS, zh as mcpZh } from './client/locales.ts'
import type { McpKey } from './client/locales.ts'
import { McpSection } from './client/mcp-section.tsx'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of this plugin's settings page. */
    [MCP_NS]: McpKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Nav identity of the MCP settings page. */
const SECTION_ID = 'dsh-app-mcp'

/**
 * Client apply: adopt styles, swap the nav's generic gear for the MCP plug
 * glyph, and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: every seat below resolves through this namespace, and
  // the effect disposes the pair with this plugin's fiber.
  ctx.effect(
    () => ctx.locale.register(MCP_NS, { zh: mcpZh, en: mcpEn }),
    'dsh-app plugin-mcp: dictionaries',
  )
  // Nav rows are read per render, so a thunk over this binding follows a
  // language switch without re-registration — the same contract as the page's
  // `t` seat, and what lets the icon patch match the label in either language.
  const t = ctx.locale.bind(MCP_NS)

  adoptStyles()
  ctx.effect(
    () => mountNavIconPatch(() => [t('mcp.nav')]),
    'dsh-app plugin-mcp: nav icon patch',
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 12 = the integration band between the model pages (10-11) and the
    // ecosystem pages (15+); 13 = Hooks and 14 = Web search follow. The full
    // order table lives in docs/desktop-optimization-plan.md.
    order: 12,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: MCP_NS,
    label: () => t('mcp.nav'),
  }, McpSection))
}
