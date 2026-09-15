/**
 * DSH APP preset packages — client half.
 *
 * Registers the settings-page section ("预设包", order 21): the list of
 * locally authored presets with one-click export to a downloaded
 * `.dshpreset` file, and a file-picker import that validates server-side and
 * asks for explicit confirmation before overwriting an existing preset. The
 * nav cell swaps the shell's generic gear for a sliders glyph via the same
 * label-matching patch the other suite sections use (the section slot
 * contract has no icon field).
 *
 * @module @dsh-app/plugin-presets/client
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
import { PresetsSection } from './client/presets-section.tsx'
import { en as presetsEn, NS as PRESETS_NS, zh as presetsZh } from './client/locales.ts'
import type { PresetsKey } from './client/locales.ts'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Preset-packages page copy (the nav row and the whole settings page). */
    [PRESETS_NS]: PresetsKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Nav identity of the preset-packages settings page (its label is `presets.nav`). */
const SECTION_ID = 'dsh-app-presets'

/**
 * Client apply: adopt styles, swap the nav's generic gear for the sliders
 * glyph, and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: every seat below resolves through this namespace,
  // and the effect disposes the pair with this plugin's fiber. ---
  ctx.effect(
    () => ctx.locale.register(PRESETS_NS, { zh: presetsZh, en: presetsEn }),
    'dsh-app plugin-presets: dictionaries',
  )
  // The nav row follows the active locale through this thunk, and the icon
  // patch below matches the same label, so a language switch re-tags the cell
  // with the shell's re-render — the same contract as the `t` seat.
  const t = ctx.locale.bind(PRESETS_NS)

  adoptStyles()
  ctx.effect(() => mountNavIconPatch(() => t('presets.nav')), 'dsh-app plugin-presets: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 21 = directly after upstream's agent-presets (20): a preset IS an agent
    // profile, and the two pages read as one block. See the order table in
    // docs/desktop-optimization-plan.md.
    order: 21,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: PRESETS_NS,
    label: () => t('presets.nav'),
  }, PresetsSection))
}
