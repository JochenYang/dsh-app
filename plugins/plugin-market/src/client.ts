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
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MarketFooterAction } from './client/panel.tsx'
import { en as marketEn, NS as MARKET_NS, zh as marketZh } from './client/locales.ts'
import type { MarketKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the panel's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Market entry + drawer copy (every string the panel renders). */
    [MARKET_NS]: MarketKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** List identity of the market entry (its label is the `mkt.nav` key). */
const ENTRY_ID = 'dsh-app-market'

/**
 * Client apply: adopt styles and register the market entry.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: every seat below resolves through this namespace,
  // and the effect disposes the pair with this plugin's fiber. ---
  ctx.effect(
    () => ctx.locale.register(MARKET_NS, { zh: marketZh, en: marketEn }),
    'dsh-app plugin-market: dictionaries',
  )
  // The sidebar reads the label per render, so a thunk over this binding
  // follows a language switch without re-registration — the same contract as
  // the panel's `t` seat.
  const t = ctx.locale.bind(MARKET_NS)

  adoptStyles()
  // Order 10 places the entry before ui-settings' row renders into the same
  // foot area (the settings seat is a separate slot below the action row;
  // order only ranks entries inside this list).
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: ENTRY_ID,
    order: 10,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: MARKET_NS,
    label: () => t('mkt.nav'),
  }, MarketFooterAction))
}
