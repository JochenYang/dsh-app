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
// Type-only: the session-scoped SlotMap merges, which declare `sessionId` on
// every `conversation.view` inject face and the view's own SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CodegraphSection } from './client/section.tsx'
import { GraphTab } from './client/graph-tab.tsx'
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

/** The conversation view tab's id and its label key (`Files`). */
const VIEW_ID = 'codegraph'
const VIEW_TITLE = 'codegraph.view.title' satisfies CodegraphKey

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
    // 24: right after the session-data rows (21-23) and BEFORE 维护设置 (26) and
    // 关于 DSH-APP (27). A graph of this project's source is a data view of the
    // project, not a system page about the install, so it belongs with the data
    // rows rather than at the tail. Upstream's pinned 已归档会话 row holds 25.
    // See docs/agents/settings-rail-order.md — that table moves in this commit.
    order: 24,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: CODEGRAPH_NS,
    label: () => t(SECTION_TITLE),
  }, CodegraphSection))

  // The conversation-page view (W10c): the same ring 对话 / 审查 / 轨迹 and the
  // Git view register into, so the graph is a TAB rather than floating chrome —
  // there is nothing to mis-position and nothing that can cover the chat.
  //
  // NO `inject` here. The session's project directory comes from the framework's
  // own `useSessions` prop inside the component, because reading the service in
  // `apply` was both undeclared (`sessions` is not in this plugin's `inject`, and
  // an undeclared read of the traced proxy throws) and unnecessary — every slot
  // component already receives `useSessions` as a standard prop. The first version
  // did `ctx.get('sessions')` and the view rendered nothing.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    // 105: after every official view (which order at 10 and 20) and BEFORE the
    // Git view (110). The graph is about the code the conversation is working on,
    // so it sits with the conversation's own views; Git is about the repository's
    // state and belongs after them.
    order: 105,
    locale: CODEGRAPH_NS,
    label: () => t(VIEW_TITLE),
  }, GraphTab))
}
