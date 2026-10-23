/**
 * DSH APP code graph — browser half.
 *
 * Registers one settings-page section ("代码图谱"): a tab per indexed project with
 * its live index state, and the language packs. All data comes from the host
 * half's routes, so the page and the model's tools read the same graph.
 *
 * @module @dsh-app/plugin-codegraph/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'), the
// slots service face (ctx.slots), and the slot utility prop faces into this
// compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CodegraphSection } from './client/section.tsx'
import { en as codegraphEn, NS as CODEGRAPH_NS, zh as codegraphZh } from './client/locales.ts'
import type { CodegraphKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the section's `t` seat below.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the code graph page: project states, outcomes, language packs. */
    [CODEGRAPH_NS]: CodegraphKey
  }
}

/** The client halves this plugin depends on (`locale` provides the copy seat). */
export const inject = ['slots', 'locale']

/** The settings nav id and its label key. */
const SECTION_ID = 'dsh-app-codegraph'
const SECTION_TITLE = 'codegraph.title' satisfies CodegraphKey

/**
 * Client apply: register the dictionaries and the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: the nav label and the page below resolve through this
  // namespace, and the effect disposes the pair with this plugin's fiber.
  ctx.effect(
    () => ctx.locale.register(CODEGRAPH_NS, { zh: codegraphZh, en: codegraphEn }),
    'dsh-app plugin-codegraph: dictionaries',
  )
  const t = ctx.locale.bind(CODEGRAPH_NS)

  adoptStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 27: after 关于 DSH-APP (26), the last row the suite owns. A graph is a
    // reference surface rather than a control, so it belongs at the tail where
    // it is not in the way of the settings a user changes. See
    // docs/agents/settings-rail-order.md — that table moves in this same commit.
    order: 27,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: CODEGRAPH_NS,
    label: () => t(SECTION_TITLE),
  }, CodegraphSection))
}
