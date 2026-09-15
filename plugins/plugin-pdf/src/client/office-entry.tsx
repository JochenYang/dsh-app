/**
 * Mounts the PDF capsule into the shared office bar.
 *
 * The bar is a DOM-injected row under the composer card rather than a seat: the
 * hero seats are all singles the shipped UI already fills, and the
 * session-scoped seats need a session the hero does not have. One injected
 * capsule therefore covers both the new-session hero and every session it hands
 * over to, which is why the session selection arrives as an observable (the
 * capsule subscribes to it) instead of as a mount-time prop.
 *
 * The locale seat arrives the same way and for the same reason: a seat occupant
 * would get its namespace-bound `t` from the renderer, an injected capsule gets
 * it from client.ts.
 *
 * The React root is created once per bar host and survives detachment, so
 * leaving the composer and coming back costs no remount. The container
 * convention itself lives in client/office-bar (see its module docs).
 *
 * @module @dsh-app/plugin-pdf/client/office-entry
 */

import { createRoot } from 'react-dom/client'
import { PDF_FORMAT, contributeOfficeCapsule } from './office-bar.ts'
import type { LocaleSeat } from './locale-seat.ts'
import { PdfOfficeEntry } from './pdf-entry.tsx'
import type { SessionSource } from './pdf-entry.tsx'

/**
 * Contribute the PDF capsule to the office bar and keep it anchored under the
 * composer card.
 * @param sessionSource - observable of the current session selection.
 * @param locale - the client locale runtime, binding this plugin's namespace.
 * @returns the disposer that unmounts the capsule and stops reconciling.
 */
export function mountPdfOfficeBar(sessionSource: SessionSource, locale: LocaleSeat): () => void {
  return contributeOfficeCapsule(PDF_FORMAT, (slot) => {
    const root = createRoot(slot)
    root.render(<PdfOfficeEntry sessionSource={sessionSource} locale={locale} />)
    return () => { root.unmount() }
  })
}
