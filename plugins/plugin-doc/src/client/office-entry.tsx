/**
 * Mounts the Word capsule into the shared office bar.
 *
 * The bar is a DOM-injected row under the composer card rather than a seat: the
 * hero seats are all singles the shipped UI already fills, and the
 * session-scoped seats need a session the hero does not have. One injected
 * capsule therefore covers both the new-session hero and every session it hands
 * over to, which is why the session selection arrives as an observable (the
 * capsule subscribes to it) instead of as a mount-time prop.
 *
 * The React root is created once per bar host and survives detachment, so
 * leaving the composer and coming back costs no remount. The container
 * convention itself lives in client/office-bar (see its module docs).
 *
 * @module @dsh-app/plugin-doc/client/office-entry
 */

import { createRoot } from 'react-dom/client'
import { contributeOfficeCapsule, WORD_FORMAT } from './office-bar.ts'
import { WordOfficeEntry } from './word-entry.tsx'
import type { SessionSource } from './word-entry.tsx'

/**
 * Contribute the Word capsule to the office bar and keep it anchored under the
 * composer card.
 * @param sessionSource - observable of the current session selection.
 * @returns the disposer that unmounts the capsule and stops reconciling.
 */
export function mountWordOfficeBar(sessionSource: SessionSource): () => void {
  return contributeOfficeCapsule(WORD_FORMAT, (slot) => {
    const root = createRoot(slot)
    root.render(<WordOfficeEntry sessionSource={sessionSource} />)
    return () => { root.unmount() }
  })
}
