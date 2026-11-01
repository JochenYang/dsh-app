/**
 * The board, cached once for both surfaces.
 *
 * The card and the page are two views of one board, and they mount at different
 * times: the card when the workbench opens, the page when a card is pressed. A
 * fetch per mount is what made entering the page show its own spinner over data
 * the card had already loaded — so the read lives HERE, keyed by nothing, and
 * both surfaces subscribe through {@link useBoard}.
 *
 * A write answers the whole board (see `wire.ts` on why the routes replace rather
 * than patch), so {@link applyBoard} is the other half of the contract: the
 * write's answer becomes the cache, the card behind the panel updates with the
 * page, and neither keeps a second copy.
 *
 * Refresh is single-flight: two mounts racing produce one request, and the second
 * caller joins it. The prefetch in `client.ts` runs at plugin apply, before the
 * user has opened anything, so the card usually paints with data on its first
 * frame.
 *
 * @module @dsh-app/plugin-todo/client/board
 */

import { useSyncExternalStore } from 'react'
import { loadBoard, type TodoError } from './api.ts'
import type { TodoSnapshot } from '../wire.ts'

/** What both surfaces render from. */
export interface BoardState {
  /** The last board read or written; absent until the first answer. */
  readonly snapshot?: TodoSnapshot
  /** The last failure's detail, kept while a stale snapshot is still shown. */
  readonly error?: string
  /** A fetch is in flight with nothing cached yet (the only real spinner). */
  readonly loading: boolean
}

let state: BoardState = { loading: false }
let inFlight: Promise<void> | undefined
/** Bumped by every write, so a read that left earlier can tell it is stale. */
let revision = 0
const listeners = new Set<() => void>()

function publish(next: BoardState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read the cache without subscribing. */
export function boardState(): BoardState {
  return state
}

/** Read the cache, re-rendering when it changes. */
export function useBoard(): BoardState {
  return useSyncExternalStore(subscribe, boardState, boardState)
}

/**
 * Re-read the board.
 *
 * Single-flight and never rejecting: a failure lands in `error`, because the one
 * caller that would care is a render. A cached snapshot is NOT replaced while the
 * refresh is in flight — the stale board is the better thing to look at.
 *
 * @returns the settled promise, for a caller that wants to await the round trip.
 */
export function refreshBoard(): Promise<void> {
  if (inFlight !== undefined) return inFlight
  if (state.snapshot === undefined) publish({ ...state, loading: true })
  // The read left before the write may answer after it: a refresh that started
  // before the last write describes a board that no longer exists, so it must not
  // replace one a write has since published.
  const startedAt = revision
  inFlight = loadBoard().then(
    (snapshot) => {
      inFlight = undefined
      if (revision !== startedAt) return
      publish({ snapshot, loading: false })
    },
    (error: TodoError) => {
      inFlight = undefined
      publish({ snapshot: state.snapshot, loading: false, error: error.detail })
    },
  )
  return inFlight
}

/** Adopt a board a write just answered, so both surfaces show it at once. */
export function applyBoard(snapshot: TodoSnapshot): void {
  revision += 1
  publish({ snapshot, loading: false })
}
