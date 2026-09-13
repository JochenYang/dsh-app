/**
 * Cross-format stand-down for one office capsule.
 *
 * The suite is mutually exclusive, but each format plugin writes its own mode
 * and the browser shares no memory between the separately bundled halves: the
 * only shared truth is the active.json claim, read back through this plugin's
 * own route. The capsule therefore re-checks the claim on mount, whenever a
 * claim changes in this window (client/office-active-event), every ten
 * seconds, and whenever the page becomes visible again, and closes itself when
 * a later foreign claim exists. The change event is what makes a format switch
 * feel immediate; the poll and the visibility check stay as the fallback for a
 * write this window never announced. The arbitration rule itself lives in
 * office-active.ts and stays DOM-free and unit-tested.
 *
 * Polling stops while the mode is off or the hero has no session: with nothing
 * to stand down there is nothing to ask the host.
 *
 * @module @dsh-app/plugin-sheet/client/office-supersede
 */

import { useEffect, useRef } from 'react'
import { shouldSelfDisable } from '../office-active.ts'
import type { OfficeActive, OfficeActiveFormat } from '../office-active.ts'
import { isForeignOfficeActiveChange, subscribeOfficeActiveChanged } from './office-active-event.ts'
import type { OfficeActiveChangedDetail } from './office-active-event.ts'

/** How often an active capsule re-reads the shared claim as a fallback. */
export const OFFICE_ACTIVE_POLL_MS = 10_000

/** Everything the stand-down check reads from the live capsule. */
export interface OfficeSupersedeCheck {
  /** This plugin's format id in the shared claim. */
  readonly format: OfficeActiveFormat
  /** Whether the local mode is currently on. */
  readonly enabled: boolean
  /** Whether a session exists to hold a mode at all. */
  readonly sessionBound: boolean
  /** The local entry's write time (`null` while off or unknown). */
  readonly ownUpdatedAt: number | null
  /** Read the shared claim through this plugin's route. */
  readonly readActive: () => Promise<OfficeActive | null>
  /** Close the local mode because another format superseded it. */
  readonly onSuperseded: () => void
}

/**
 * Watch the shared claim and invoke `onSuperseded` when a later foreign claim
 * appears. The watch is identity-stable across renders; its lifetime follows
 * whether there is a local mode that could lose.
 */
export function useOfficeSupersede(check: OfficeSupersedeCheck): void {
  const latest = useRef(check)
  latest.current = check
  const watching = check.enabled && check.sessionBound
  useEffect(() => {
    if (!watching) return
    let cancelled = false
    const run = (): void => {
      const current = latest.current
      if (!current.enabled || !current.sessionBound) return
      void current.readActive().then(
        (claim) => {
          if (cancelled) return
          if (shouldSelfDisable(claim, current.format, current.ownUpdatedAt)) current.onSuperseded()
        },
        () => { /* a failed read is not evidence of a supersede */ },
      )
    }
    run()
    const timer = setInterval(run, OFFICE_ACTIVE_POLL_MS)
    const onChanged = (detail: OfficeActiveChangedDetail): void => {
      // Our own write cannot have superseded us, so skip the round trip it
      // would only confirm; every other format's change is checked at once.
      if (isForeignOfficeActiveChange(detail, latest.current.format)) run()
    }
    const unsubscribe = subscribeOfficeActiveChanged(onChanged)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [watching])
}
