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

// --- 维护 tab slot (`settings.dsh-app-maintenance.tab`). The section owner —
// plugin-client-ui — DECLARES it in the same register() call that contributes
// the section (its `children` table); every tab contributor registers into it.
// The suite ships no shared package, so this block is repeated in three client
// entries — plugin-client-ui/src/client.ts, plugin-usage/src/client.ts and
// plugin-presets/src/client.ts — and the three copies must stay identical line
// for line. A checkout may give each file a different line ending (this tree
// mixes CRLF and LF), so plugin-client-ui/tests/settings-merge.test.ts compares
// them modulo line endings and fails if one drifts.
// BEGIN maintenance-tab-slot
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.dsh-app-maintenance.tab': {
      kind: 'list'
      scope: 'root'
      owner: MaintenanceTabOwnerProps
    }
  }
}
/** Owner share of one maintenance tab (the section supplies nothing). */
interface MaintenanceTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}
// END maintenance-tab-slot

/**
 * Client apply: adopt styles and register the usage tab in 维护.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: the tab label and the page below resolve through
  // this namespace, and the effect disposes the pair with this plugin's
  // fiber. ---
  ctx.effect(
    () => ctx.locale.register(USAGE_NS, { zh: usageZh, en: usageEn }),
    'dsh-app plugin-usage: dictionaries',
  )
  // Tab labels are read per render and the section owner keys its ledger cache
  // on the locale revision, so a thunk over this binding follows a language
  // switch without re-registration — the same contract as the `t` seat.
  const t = ctx.locale.bind(USAGE_NS)

  adoptStyles()
  ctx.slots.inject('settings.dsh-app-maintenance.tab', () => ctx.slots.register({
    name: 'settings.dsh-app-maintenance.tab',
    id: SECTION_ID,
    // 1 = first: usage is the page a support question starts from (what ran,
    // and how much), ahead of the preset packages and the diagnostics readout.
    order: 1,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: USAGE_NS,
    label: () => t(SECTION_TITLE),
  }, UsageSection))
}
