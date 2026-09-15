/**
 * DSH APP PPT suite — client half.
 *
 * Contributes one capsule to the shared office bar (the row of format
 * capsules under the composer card — see client/office-bar for the container
 * convention other suite formats follow). The bar is DOM-injected rather than
 * a seat occupant because the seats it could take are unavailable: the hero
 * seats are all singles the shipped UI already fills, and the session-scoped
 * seats require a session the new-session hero does not have. One injected
 * capsule therefore serves both phases and reads the current session from the
 * ui-session selection observable; the workflow constraint itself lives on the
 * host side (system-prompt sections), not in the wording.
 *
 * With no session selected the capsule parks its pick in the shared pending
 * slot (see client/pending-template) and enables the mode once a session
 * exists, so a toggle in the hero is not a dead end.
 *
 * @module @dsh-app/plugin-ppt/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale runtime's Context merge (ctx.locale), its
// LocaleFace shape, and the LocaleNamespaceMap merge point this plugin's
// namespace is declared into.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot utility faces and the ui-session service
// (ctx.uiSession.adapter, the live session selection this client subscribes
// to) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { mountPptOfficeBar } from './client/office-entry.tsx'
import type { CapsuleSeat } from './client/ppt-entry.tsx'
import { en as pptEn, NS as PPT_NS, zh as pptZh } from './client/locales.ts'
import type { PptKey } from './client/locales.ts'
import { createSkillReferenceSource } from './client/skill-reference.ts'
import type { ReferenceSourceRegistry } from './client/skill-reference.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the seat built below.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the PPT capsule and its template panel. */
    [PPT_NS]: PptKey
  }
}

/** The client halves this plugin depends on (`locale` provides the copy seat). */
export const inject = ['locale', 'uiSession']

/**
 * Client apply: adopt styles and mount the office-bar capsule.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()

  // --- Dictionary first: the seat below resolves the capsule's copy through
  // this namespace, and the effect disposes the pair with this plugin's fiber. ---
  ctx.effect(
    () => ctx.locale.register(PPT_NS, { zh: pptZh, en: pptEn }),
    'dsh-app plugin-ppt: dictionaries',
  )
  // The capsule is a DOM injection rather than a slot occupant, so no renderer
  // hands it a `t` seat: the namespace binding (stable identity, reads the
  // active locale at call time) and the locale registry's revision observable
  // travel to the component by hand.
  const seat: CapsuleSeat = { t: ctx.locale.bind(PPT_NS), locale: ctx.locale }

  // The bar reconciles itself from the DOM (one observer pass per mutation
  // burst): the composer card belongs to a React root that re-renders on every
  // keystroke and disappears outside the conversation.
  ctx.effect(
    () => mountPptOfficeBar(ctx.uiSession.adapter.current, seat),
    'dsh-app plugin-ppt: office-bar capsule',
  )

  // The skill reference rides a kernel chip: the registered source owns the
  // codec the submit attempt routes through, and the insert-reference scoped
  // event lands the chip in the draft. Both wait for the trigger pipeline;
  // without it the capsule keeps the literal-token fallback.
  ctx.inject(['inputTriggers'], (scope) => {
    const registry = scope.get('inputTriggers') as ReferenceSourceRegistry | undefined
    if (registry === undefined) return
    scope.effect(
      () => registry.registerSource(createSkillReferenceSource()),
      'dsh-app plugin-ppt: skill reference source',
    )
  })
}
