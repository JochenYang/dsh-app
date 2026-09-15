/**
 * Mounts the PPT capsule into the shared office bar.
 *
 * The bar is a DOM-injected row under the composer card rather than a seat:
 * the hero seats are all singles the shipped UI already fills, and the
 * session-scoped seats need a session the hero does not have. One injected
 * capsule therefore covers both the new-session hero and every session it
 * hands over to, which is why the session selection arrives as an observable
 * (the capsule subscribes to it) instead of as a mount-time prop.
 *
 * The React root is created once per bar host and survives detachment, so
 * leaving the composer and coming back costs no remount. The container
 * convention itself lives in client/office-bar (see its module docs).
 *
 * @module @dsh-app/plugin-ppt/client/office-entry
 */

import { createRoot } from 'react-dom/client'
import { PPT_FORMAT } from './capsule-state.ts'
import { contributeOfficeCapsule } from './office-bar.ts'
import { PptOfficeEntry } from './ppt-entry.tsx'
import type { CapsuleSeat, SessionSource } from './ppt-entry.tsx'

/**
 * Contribute the PPT capsule to the office bar and keep it anchored under the
 * composer card.
 * @param sessionSource - observable of the current session selection.
 * @param seat - the capsule's translate function and locale revision source.
 * @returns the disposer that unmounts the capsule and stops reconciling.
 */
export function mountPptOfficeBar(sessionSource: SessionSource, seat: CapsuleSeat): () => void {
  return contributeOfficeCapsule(PPT_FORMAT, (slot) => {
    const root = createRoot(slot)
    root.render(<PptOfficeEntry sessionSource={sessionSource} seat={seat} />)
    return () => { root.unmount() }
  })
}
