/**
 * DSH APP swarm — client half.
 *
 * Registers the settings-page section ("并行子代理"): enable toggle,
 * adaptive toggle, and the scheduling knobs backed by the host half's
 * config routes. See the host half's header for the full feature contract.
 *
 * @module @dsh-app/plugin-swarm/client
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
import { en, NS, zh } from './client/locales.ts'
import type { SwarmKey } from './client/locales.ts'
import { SwarmSection } from './client/swarm-section.tsx'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Swarm settings-page copy. */
    [NS]: SwarmKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Nav identity of the swarm settings page. */
const SECTION_ID = 'dsh-app-swarm'

/**
 * Client apply: adopt styles, register the section dictionaries, register the
 * settings section, and patch the nav icon (the shell only ships a generic
 * gear for unknown section ids).
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-swarm: dictionaries')
  // Read per render, so the nav row follows a language switch without
  // re-registration — the same contract as the component's `t` seat.
  const t = ctx.locale.bind(NS)
  // The nav-icon patch finds its cell by label text, so it must read the
  // label at patch time rather than capture one language's copy.
  ctx.effect(() => mountNavIconPatch(() => t('swarm.nav')), 'plugin-swarm: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 19 = the agent band: this page sits directly before upstream's
    // agent-presets (20), the surface it tunes. See the order table in
    // docs/desktop-optimization-plan.md.
    order: 19,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: NS,
    label: () => t('swarm.nav'),
  }, SwarmSection))
}
