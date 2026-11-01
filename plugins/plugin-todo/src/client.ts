/**
 * DSH APP todo board — client half.
 *
 * Contributes exactly two entries to the workbench container: one card into
 * `workbench.item`, and the page that card opens into `workbench.view`. The
 * container owns the frame, the back button, Escape and the grid's card border
 * (`plugin-workbench/src/client/page.tsx`); this plugin owns what the card says
 * and everything inside the view.
 *
 * The two seats are addressed by ONE constant, {@link VIEW_ID}: the card
 * registers with `id`, the view with `key`, and the container's `openView` only
 * reads `key`. Nothing in the type system relates the two, so a mismatch is
 * silent — it surfaces as a card whose press does nothing, because `openView`
 * refuses a key nothing registered.
 *
 * @module @dsh-app/plugin-todo/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { TodoCard, VIEW_ID } from './client/card.tsx'
import type { WorkbenchCardOwnerProps } from './client/card.tsx'
import { refreshBoard } from './client/board.ts'
import { mountReminderToastHost } from './client/reminder-toast-host.tsx'
import { startReminderWatch } from './client/reminders.ts'
import { en as todoEn, NS as TODO_NS, zh as todoZh } from './client/locales.ts'
import type { TodoKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'
import { TodoView } from './client/view.tsx'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register` key-checked against both dictionaries.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Todo board copy, in this plugin's namespace. */
    [TODO_NS]: TodoKey
  }

  /**
   * The container's two domain seats, repeated VERBATIM from
   * `plugin-workbench/src/client.ts` (the `BEGIN workbench-card-slot` block).
   *
   * The suite ships no shared package and the container publishes no types, so a
   * domain card has nothing to import: the declaration and the owner-props
   * interface are copied by hand. A misspelt field would leave both sides
   * compiling while the card disappears into the outlet's error boundary at run
   * time.
   */
  // BEGIN workbench-card-slot — a domain card repeats this block VERBATIM.
  interface SlotMap {
    /** One card per domain workbench, ordered by the registration's `order`. */
    'workbench.item': {
      kind: 'list'
      scope: 'root'
      owner: WorkbenchCardOwnerProps
    }
    /** A domain's own page, addressed by the card's registered `id`. */
    'workbench.view': {
      kind: 'keyed'
      scope: 'root'
    }
  }
  // END workbench-card-slot
}

/**
 * The client halves this plugin declares a dependency on.
 *
 * Both are hard waits and both are honest ones: the dictionaries are registered
 * into `locale`, and every entry here is a `slots` contribution. Nothing else is
 * named — the workspace services the container itself exposes are the
 * container's business, and a card that needed them would call them through the
 * owner props instead of injecting a second copy.
 */
export const inject = ['slots', 'locale']

/**
 * Apply: dictionaries, then the stylesheet, then the two seat contributions.
 *
 * `ctx.slots.inject` (rather than a bare `register`) is what makes this work
 * whichever order the workbench and this plugin activate in: it waits for the
 * seat declaration, removes the contribution if the declaration folds, and
 * re-registers when it returns.
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(TODO_NS, { zh: todoZh, en: todoEn }),
    'dsh-app plugin-todo: dictionaries',
  )

  // Id-guarded, so a re-apply is a no-op rather than a second stylesheet.
  adoptStyles()

  // Warm the board before any surface exists. The card is normally the first
  // thing a user opens, and a fetch started here has usually answered by then,
  // so the card paints with numbers instead of a placeholder. A failure is not
  // reported here: the card and the page each decide what to say about it.
  void refreshBoard()

  // The page. `key` — not `id`: the seat is keyed, and the container's
  // `openView` reads `options.key`, so an `id` here would be a silent no-op.
  ctx.slots.inject('workbench.view', () => ctx.slots.register({
    name: 'workbench.view',
    key: VIEW_ID,
    locale: TODO_NS,
  }, TodoView))

  // The card. `order: 10` is a plain "after the first card a domain ships";
  // the grid sorts ascending and this plugin has no opinion beyond being
  // reachable, so a later card with a lower order may sit above it.
  ctx.slots.inject('workbench.item', () => ctx.slots.register({
    name: 'workbench.item',
    id: VIEW_ID,
    order: 10,
    locale: TODO_NS,
  }, TodoCard))

  // --- The reminder notice. Plugin level, not page level: a reminder is meant to
  // interrupt whatever the user is doing, and the container unmounts a domain page
  // as soon as they leave the panel. Both halves are disposed with this plugin's
  // fiber. ---
  const t = ctx.locale.bind(TODO_NS)
  ctx.effect(() => mountReminderToastHost(t), 'dsh-app plugin-todo: reminder host')
  ctx.effect(() => startReminderWatch(), 'dsh-app plugin-todo: reminder watch')
}
