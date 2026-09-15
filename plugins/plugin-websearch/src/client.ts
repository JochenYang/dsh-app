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
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as webSearchEn, NS as WEBSEARCH_NS, zh as webSearchZh } from './client/locales.ts'
import type { WebSearchKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { WebSearchSection } from './client/websearch-section.tsx'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of this plugin's settings page. */
    [WEBSEARCH_NS]: WebSearchKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Nav identity of the web search settings page. */
const SECTION_ID = 'dsh-app-websearch'

/**
 * Client apply: adopt styles, swap the nav's generic gear for a lens glyph,
 * and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: every seat below resolves through this namespace, and
  // the effect disposes the pair with this plugin's fiber.
  ctx.effect(
    () => ctx.locale.register(WEBSEARCH_NS, { zh: webSearchZh, en: webSearchEn }),
    'dsh-app plugin-websearch: dictionaries',
  )
  // Nav rows are read per render, so a thunk over this binding follows a
  // language switch without re-registration — the same contract as the page's
  // `t` seat, and what lets the icon patch match the label in either language.
  const t = ctx.locale.bind(WEBSEARCH_NS)

  adoptStyles()
  ctx.effect(
    () => mountNavIconPatch(() => [t('ws.nav')]),
    'dsh-app plugin-websearch: nav icon patch',
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 14 = the tail of the integration band (12 = MCP, 13 = Hooks), right
    // before upstream's Plugins page (15). See the order table in
    // docs/desktop-optimization-plan.md.
    order: 14,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: WEBSEARCH_NS,
    label: () => t('ws.nav'),
  }, WebSearchSection))
}
