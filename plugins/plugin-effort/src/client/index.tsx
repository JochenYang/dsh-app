/**
 * DSH APP effort slider — client half apply.
 *
 * ## What this half is
 *
 * One invisible slot entry and one stylesheet. The entry exists because
 * `conversation.input.right` is the only seat the composer offers that carries a
 * per-session `sessionId` and a real DOM node in the composer — it is the anchor
 * the bridge walks up from to find THIS session's composer, and the hook that
 * resolves this session's shared model directory. It renders nothing visible:
 * the control belongs on the official model menu's 推理等级 row, which the bridge
 * reaches from that anchor.
 *
 * ## Why the official menu and not a control of our own
 *
 * The row the user actually reads a reasoning level from is the menu's. A second
 * control in the tool row would be a second place to look and a second thing to
 * keep in sync, and the level list is the same store either way. Putting the
 * track on that row keeps one surface and one source of truth.
 *
 * ## What carries the value
 *
 * `ctx.modelDirectories` is the kernel's own per-session directory — the same
 * instance the official seat and the `/model` popup read and write, so a level
 * picked on the track shows up in both of them without any reconciliation here.
 * Nothing in this plugin folds session events or invents a selection: it submits
 * a complete `{provider, model, reasoningEffort}` read from the snapshot at the
 * moment of the write, and the store reports what the host did with it.
 *
 * @module @dsh-app/plugin-effort/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the composer's SlotMap row ('conversation.input.right') into
// this unit, so a misspelled slot name is a compile error rather than a runtime
// registration failure.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.modelDirectories merge and the directory snapshot type.
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { en as effortEn, NS as EFFORT_NS, zh as effortZh, type EffortKey } from './locales.ts'
import { indexOfLevel, levelsOf } from './levels.ts'
import { adoptStyles } from './styles.ts'
import { EffortEntry, type EffortOutcome } from './slider.tsx'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the track's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the effort track: its accessible name and its state notes. */
    [EFFORT_NS]: EffortKey
  }
}

/**
 * The client halves this plugin depends on.
 *
 * `modelDirectories` is load-bearing: cordis answers a service property access
 * only when the service is declared here, and reading an undeclared one throws
 * `cannot get property "modelDirectories" without inject` — a registration that
 * looks healthy and a track that never appears. The locale namespace the row
 * labels are read from is registered by the model-selection package, which is
 * why it is also listed in this package's `dsh.client.inject`.
 *
 * `remote` and `remote.session` are here for a call this plugin does not make
 * itself: `directoryFor` builds a session's directory from `ctx.remote.session`,
 * and cordis attributes that access to the CALLER — so without these two the
 * first call for a session throws `cannot get property "remote.session" without
 * inject` and the track is missing until some other consumer has created that
 * directory. The official seat declares the same pair for the same reason.
 */
export const inject = ['slots', 'locale', 'modelDirectories', 'remote', 'remote.session']

/** Locale namespace of the OFFICIAL model menu, whose row labels we match against. */
const OFFICIAL_NS = 'model'

/**
 * Client apply: register the dictionary, the stylesheet, and the anchor entry.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: the track's copy resolves through this namespace, and the
  // effect disposes the pair with this plugin's fiber.
  ctx.effect(
    () => ctx.locale.register(EFFORT_NS, { zh: effortZh, en: effortEn }),
    'dsh-app plugin-effort: dictionaries',
  )

  adoptStyles()
  registerEffortRow(ctx)
}

/**
 * Contribute the anchor entry that drives the track.
 *
 * The row labels are read through the OFFICIAL namespace rather than copied into
 * this plugin's dictionary: the row we are looking for is the official one, so the
 * only string that identifies it reliably is the string that same component
 * rendered. A language switch changes both sides together, and a kernel that
 * rewords the row changes the label we match — which resolves to "no track"
 * rather than to a track on the wrong row.
 *
 * @param ctx - the client root context.
 */
function registerEffortRow(ctx: ClientContext): void {
  const official = ctx.locale.bind(OFFICIAL_NS)
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dsh-app-effort-anchor',
    order: 30,
    locale: EFFORT_NS,
    inject: (sessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      return {
        hooks: { effort: directory.store },
        load: () => {
          // Shared and deduped by the catalog itself; a failure is the store's to
          // report and the official seat's to retry.
          void directory.load().catch(() => { /* surfaced on the store */ })
        },
        select: async (levelId: string): Promise<EffortOutcome> => {
          // The selection is read HERE, not taken from the render that produced the
          // click: the model may have changed under the pointer, and writing a
          // level onto a model that does not advertise it would be refused by the
          // host after a round trip. One read, one write.
          const snapshot = directory.store.getSnapshot()
          const current = snapshot.current
          if (current === null) return { ok: false, code: 'effort.error.unavailable' }
          if (indexOfLevel(levelsOf(snapshot), levelId) < 0) return { ok: false, code: 'effort.error.unavailable' }
          try {
            const result = await directory.select({
              provider: current.provider,
              model: current.model,
              reasoningEffort: levelId,
            })
            if (result.ok) return { ok: true }
            // The host's own code plus its diagnostic: the same shape the official
            // seat reports, and the only actionable part of a refusal.
            return {
              ok: false,
              code: 'effort.error.rejected',
              params: { detail: `${result.error.code}: ${result.error.message}` },
            }
          } catch {
            return { ok: false, code: 'effort.error.unavailable' }
          }
        },
        officialLabels: () => ({
          model: official('menu.model'),
          effort: official('menu.effort'),
        }),
      }
    },
  }, EffortEntry))
}
