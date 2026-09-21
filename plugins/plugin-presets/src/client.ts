/**
 * DSH APP preset packages — client half.
 *
 * Contributes the 预设包 tab (order 2) to the merged 维护 settings section:
 * `plugin-client-ui` owns that section and declares its tab slot; this half
 * only registers into it. The page it holds is the list of locally authored
 * presets with one-click export to a downloaded `.dshpreset` file, and a
 * file-picker import that validates server-side and asks for explicit
 * confirmation before overwriting an existing preset. The rail row's icon
 * (and the rail glyph for 维护) belongs to the section owner, not to this
 * half.
 *
 * @module @dsh-app/plugin-presets/client
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
import { PresetsSection } from './client/presets-section.tsx'
import { en as presetsEn, NS as PRESETS_NS, zh as presetsZh } from './client/locales.ts'
import type { PresetsKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Preset-packages page copy (the tab label and the whole page). */
    [PRESETS_NS]: PresetsKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Tab identity of the preset-packages page inside 维护 (its label is `presets.nav`). */
const SECTION_ID = 'dsh-app-presets'

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
 * Client apply: adopt styles and register the preset-packages tab in 维护.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: every seat below resolves through this namespace,
  // and the effect disposes the pair with this plugin's fiber. ---
  ctx.effect(
    () => ctx.locale.register(PRESETS_NS, { zh: presetsZh, en: presetsEn }),
    'dsh-app plugin-presets: dictionaries',
  )
  // The tab label follows the active locale through this thunk, and the
  // section owner re-reads it on every ledger pass — the same contract as the
  // `t` seat.
  const t = ctx.locale.bind(PRESETS_NS)

  adoptStyles()
  ctx.slots.inject('settings.dsh-app-maintenance.tab', () => ctx.slots.register({
    name: 'settings.dsh-app-maintenance.tab',
    id: SECTION_ID,
    // 2 = between the two report pages: usage says what ran, presets is what
    // the user carries between installs, diagnostics says what is broken.
    order: 2,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: PRESETS_NS,
    label: () => t('presets.nav'),
  }, PresetsSection))
}
