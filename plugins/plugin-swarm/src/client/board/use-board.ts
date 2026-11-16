/**
 * Polling source for the swarm board. One route, one session, no shared
 * mutable state: the header pill and the Sidebar tab may each mount a reader,
 * and both see the same host snapshot.
 *
 * The poll is recursive rather than an interval so a slow host cannot stack
 * requests. A failed read keeps the last successful snapshot and raises
 * `error`, which is what lets the UI say "stale" instead of blanking.
 *
 * @module @dsh-app/plugin-swarm/client/board/use-board
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SwarmBoardSnapshot } from '../../board-types.ts'

const ROUTE = '/api/plugins/dsh-app/plugin-swarm/board'

/** What a board reader exposes to its component. */
export interface BoardFeed {
  readonly snapshot: SwarmBoardSnapshot | null
  readonly error: boolean
  /** Force one read now; the recursive poll continues on its own cadence. */
  readonly refresh: () => void
}

/** The envelope the host's route answers with. */
interface BoardEnvelope {
  readonly ok: boolean
  readonly value?: SwarmBoardSnapshot
  readonly error?: { readonly message?: string }
}

/** Read one snapshot; throws on a non-OK envelope. */
async function readBoard(sessionId: string): Promise<SwarmBoardSnapshot> {
  const response = await fetch(`${ROUTE}?session=${encodeURIComponent(sessionId)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  const body = (await response.json()) as BoardEnvelope
  if (!response.ok || body.ok !== true || body.value === undefined) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value
}

/**
 * Subscribe to one session's board.
 * @param sessionId - the session whose batches to read.
 * @param intervalMs - delay between completed reads.
 * @returns the latest snapshot, the error flag, and a manual refresh.
 */
export function useBoardSnapshot(sessionId: string, intervalMs = 1500): BoardFeed {
  const [snapshot, setSnapshot] = useState<SwarmBoardSnapshot | null>(null)
  const [error, setError] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const current = generation.current
    try {
      const next = await readBoard(sessionId)
      if (current !== generation.current) return
      setSnapshot(next)
      setError(false)
    } catch {
      if (current !== generation.current) return
      // Keep the last good snapshot: a transient read failure must not turn a
      // live board into an empty one.
      setError(true)
    }
  }, [sessionId])

  const refresh = useCallback((): void => { void load() }, [load])

  useEffect(() => {
    // A session switch or a remount invalidates every in-flight read: without
    // this, a slow answer for the previous session lands on the new one.
    generation.current += 1
    const current = generation.current
    let timer = 0
    const tick = async (): Promise<void> => {
      await load()
      if (current === generation.current) timer = window.setTimeout(() => { void tick() }, intervalMs)
    }
    void tick()
    return () => {
      generation.current += 1
      window.clearTimeout(timer)
    }
  }, [load, intervalMs])

  return { snapshot, error, refresh }
}
