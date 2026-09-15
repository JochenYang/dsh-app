/**
 * The `t` seat of the PDF capsule.
 *
 * A slot occupant receives a namespace-bound translate through its props (the
 * renderer synthesizes `PropsLocale<N>` from the registration's `locale:`); this
 * capsule is mounted into DOM the plugin owns instead (see client/office-bar),
 * so the plugin binds the namespace itself and hands the seat down. The face is
 * the structural slice of the client locale runtime the capsule needs — not the
 * runtime class — so the capsule renders against a test double.
 *
 * A bound translate reads the active locale at call time, so the words never go
 * stale; {@link useTranslate} subscribes to the runtime revision, which is what
 * re-renders an already-visible capsule after a language switch.
 *
 * @module @dsh-app/plugin-pdf/client/locale-seat
 */

import { useSyncExternalStore } from 'react'
import type { LocaleNamespaceMap, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** The locale-runtime slice the capsule needs. */
export interface LocaleSeat {
  /**
   * Bind a translate function to a declared namespace (stable per namespace,
   * so it may ride props without breaking memoization).
   */
  bind<N extends keyof LocaleNamespaceMap & string>(ns: N): TranslateNS<N>
  /** Current snapshot; every locale switch and dictionary registration bumps `revision`. */
  getSnapshot(): { readonly revision: number }
  /** Subscribe to snapshot changes. */
  subscribe(listener: () => void): () => void
}

/**
 * The capsule's namespace-bound translate, re-rendered on every revision.
 * @param locale - the injected locale runtime, or a test double.
 * @returns the translate function of this plugin's namespace.
 */
export function useTranslate(locale: LocaleSeat): TranslateNS<typeof NS> {
  useSyncExternalStore(
    listener => locale.subscribe(listener),
    () => locale.getSnapshot().revision,
  )
  return locale.bind(NS)
}
