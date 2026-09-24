/**
 * DSH APP usage statistics — client half.
 *
 * Contributes the 用量统计 tab (order 1) to the merged 维护 settings section:
 * `plugin-client-ui` owns that section and declares its tab slot; this half
 * only registers into it. Third-party usage plugins coexist by design (each
 * renders its own page over its own data — see the host half's header), so
 * this half always registers. A user who prefers their own plugin disables
 * this one through the plugin's declarative `enabled` config field (see the
 * host half's header), and the tab then shows the disabled notice from the
 * host's /status signal instead of data.
 *
 * @module @dsh-app/plugin-usage/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) into this compilation
// unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls this tab's SlotMap entry (declared by the section owner)
// and the slot utility prop faces into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { UsageSection } from './client/usage-section.tsx'
import { en as usageEn, NS as USAGE_NS, zh as usageZh } from './client/locales.ts'
import type { UsageKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the usage page: cards, heatmap, trend chart, model table. */
    [USAGE_NS]: UsageKey
  }
}

/** The client halves this plugin depends on (`locale` provides the copy seat). */
export const inject = ['slots', 'locale']

/** Tab identity of the usage page inside 维护 (its label is the `usage.title` key). */
const SECTION_ID = 'dsh-app-usage'
const SECTION_TITLE = 'usage.title' satisfies UsageKey

// This half no longer declares the 维护 tab slot: the usage page is its own rail
// section (see `apply`), so it is not a tab contributor any more. The slot stays
// declared and rendered by plugin-client-ui (its owner) for the two contributors
// that DO remain — plugin-presets and plugin-client-ui's own diagnostics page.

/**
 * Client apply: adopt styles and register the usage section in the rail.
 *
 * This page used to be a TAB inside 维护 (order 22). It is its own rail row now:
 * 维护 collects SYSTEM-level pages (preset packages, diagnostics — "is the
 * install healthy?"), while usage is the user's own DATA view ("what did I
 * spend?"), and burying it behind a tab made it hard to find — reported after a
 * search for 用量统计 in the rail came up empty. The two usage views also read
 * better side by side: the account section shows the SERVER's balance, this page
 * the LOCAL session logs.
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: the rail label and the page below resolve through
  // this namespace, and the effect disposes the pair with this plugin's
  // fiber. ---
  ctx.effect(
    () => ctx.locale.register(USAGE_NS, { zh: usageZh, en: usageEn }),
    'dsh-app plugin-usage: dictionaries',
  )
  // Labels are read per render, so a thunk over this binding follows a language
  // switch without re-registration — the same contract as the `t` seat.
  const t = ctx.locale.bind(USAGE_NS)

  adoptStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 21 = right after the agent band (19-20) and directly ABOVE 维护 (22): the
    // user's own usage sits with the other data views, not at the tail with the
    // system pages it used to be tabbed into. 16-18 are free but kept as the
    // band boundary between the integration rows (11-14) and the ecosystem ones.
    order: 21,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: USAGE_NS,
    label: () => t(SECTION_TITLE),
  }, UsageSection))
}
