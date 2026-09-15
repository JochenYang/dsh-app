/**
 * DSH APP PDF suite — client half.
 *
 * Contributes one capsule to the shared office bar (the row of format capsules
 * under the composer card — see client/office-bar for the container convention).
 * The bar is DOM-injected rather than a seat occupant because the seats it could
 * take are unavailable: the hero seats are all singles the shipped UI already
 * fills, and the session-scoped seats require a session the new-session hero
 * does not have. One injected capsule therefore serves both phases and reads the
 * current session from the ui-session selection observable; the workflow
 * constraint itself lives on the host side (system-prompt sections), not in the
 * wording.
 *
 * With no session selected the capsule parks its toggle in the shared pending
 * slot (see client/pending-mode) and applies the mode once a session exists, so
 * a toggle in the hero is not a dead end.
 *
 * @module @dsh-app/plugin-pdf/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale runtime's Context merge (ctx.locale, which also
// carries this plugin's namespace keys through the LocaleNamespaceMap merge
// below) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot utility faces and the ui-session service
// (ctx.uiSession.adapter, the live session selection this client subscribes to)
// into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { mountPdfOfficeBar } from './client/office-entry.tsx'
import { createSkillReferenceSource } from './client/skill-reference.ts'
import type { ReferenceSourceRegistry } from './client/skill-reference.ts'
import { en as pdfEn, NS as PDF_NS, zh as pdfZh } from './client/locales.ts'
import type { PdfKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the capsule's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The PDF capsule's copy (one namespace per plugin, one owner per namespace). */
    [PDF_NS]: PdfKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['locale', 'uiSession']

/**
 * Client apply: adopt styles and mount the office-bar capsule.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()

  // The capsule's copy resolves through this namespace; the effect disposes the
  // dictionary pair with this plugin's fiber.
  ctx.effect(
    () => ctx.locale.register(PDF_NS, { zh: pdfZh, en: pdfEn }),
    'dsh-app plugin-pdf: dictionaries',
  )

  // The bar reconciles itself from the DOM (one observer pass per mutation
  // burst): the composer card belongs to a React root that re-renders on every
  // keystroke and disappears outside the conversation. The capsule is not a seat
  // occupant, so it binds the namespace itself from the runtime handed in here.
  ctx.effect(
    () => mountPdfOfficeBar(ctx.uiSession.adapter.current, ctx.locale),
    'dsh-app plugin-pdf: office-bar capsule',
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
      'dsh-app plugin-pdf: skill reference source',
    )
  })
}
