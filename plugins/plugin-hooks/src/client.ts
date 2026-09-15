/**
 * DSH APP hooks bridge — client half.
 * Registers the "Hooks" settings section (order 13) + nav icon.
 * @module @dsh-app/plugin-hooks/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { HooksSection } from './client/hooks-section.tsx'
import { en, NS, zh } from './client/locales.ts'
import type { HooksKey } from './client/locales.ts'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Hooks settings-page copy. */
    [NS]: HooksKey
  }
}

export const inject = ['slots', 'locale']
const SECTION_ID = 'dsh-app-hooks'

export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-app plugin-hooks: dictionaries')
  // Read per render, so the nav row follows a language switch without
  // re-registration — the same contract as the component's `t` seat.
  const t = ctx.locale.bind(NS)
  // The nav-icon patch finds its cell by label text, so it must read the
  // label at patch time rather than capture one language's copy.
  ctx.effect(() => mountNavIconPatch(() => t('hooks.nav')), 'dsh-app plugin-hooks: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 13,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: NS,
    label: () => t('hooks.nav'),
  }, HooksSection))
}
