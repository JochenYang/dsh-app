/**
 * The effort track, rendered into the container the bridge placed inside the
 * official model menu.
 *
 * The component itself owns no DOM contract: the bridge decides where it lives,
 * and this file renders through a portal into that container. What it does own is
 * the interaction and the three rules that keep the position honest:
 *
 *   1. **A crossing is one write, and one write at a time.** The pointer moves
 *      the knob, and the level is asked for when it crosses into another level's
 *      band — not on every pointer sample, and not only on release. Both extremes
 *      are wrong for the same reason: the official directory has no
 *      change-detection of its own (every `select` is an RPC), so a write per
 *      sample would put a request on the wire every few milliseconds; and the row
 *      above this track renders the SESSION's value rather than our draft, so a
 *      slider that wrote only on release left that row naming the old level for
 *      the whole gesture. Crossings that arrive while one write is in flight are
 *      collapsed into the next one (see `write`), which is what keeps the row in
 *      step without a burst of host selections behind a fast drag.
 *   2. **The position shown is the position that will be used.** A committed
 *      level stays on screen until the host's own frame reports a value, and a
 *      frame that never arrives rolls the display back with a reason instead of
 *      leaving the user looking at a level the session is not running.
 *   3. **A different model clears the position.** The draft, the pending commit
 *      and the error all belong to one level list, identified by
 *      {@link levelKey}; when that identity changes they are dropped, so an index
 *      that meant `max` a moment ago is never drawn against a list where it means
 *      something else.
 *
 * @module @dsh-app/plugin-effort/client/slider
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { createEffortBridge, type EffortBridge, type EffortBridgeHost, type EffortRowLabels } from './bridge.ts'
import { fillClip, indexFromPct, offsetExpr, pctAt, pctFromIndex } from './geometry.ts'
import { commitIndexFor, levelKey, resolveEffort, trackModeOf } from './levels.ts'
import {
  mosaicTiles,
  sweepDurationMsFor,
  tileCountFor,
  tileDelayMsFor,
  tileLayerOpacityFor,
  energyFor,
} from './mosaic.ts'
import { NS, type EffortKey } from './locales.ts'

/** How long a committed level may stay unconfirmed before the display rolls back. */
const COMMIT_TIMEOUT_MS = 10_000

/** What a commit reports back. Coded, never prose: the copy lives in the dictionary. */
export type EffortOutcome =
  | { readonly ok: true }
  | { readonly ok: false, readonly code: EffortKey, readonly params?: Readonly<Record<string, unknown>> }

/** Props the slot hands this entry: the locale seat plus the injected face. */
export type EffortEntryProps = PropsLocale<typeof NS> & {
  /** The session's shared model directory, bound as `useEffort`. */
  readonly useEffort: SnapshotSelectorHook<ModelDirectoryState>
  /** Load the shared catalog (deduped by the store itself). */
  readonly load: () => void
  /** Write one level, resolving with a coded outcome rather than rejecting. */
  readonly select: (levelId: string) => Promise<EffortOutcome>
  /** The OFFICIAL row labels, read from the kernel's own dictionary at call time. */
  readonly officialLabels: () => EffortRowLabels
}

/** The error state, kept coded so the dictionary stays the only place with copy. */
interface EffortFailure {
  readonly code: EffortKey
  readonly params?: Readonly<Record<string, unknown>>
}

/**
 * The slot entry: an invisible anchor plus the track portaled into the menu.
 * @param props - locale seat and injected face.
 * @returns the anchor and (once the bridge has a container) the track.
 */
export function EffortEntry(props: EffortEntryProps): ReactNode {
  const { t, useEffort, load, select, officialLabels } = props
  const snapshot = useEffort(state => state)
  const state = useMemo(() => resolveEffort(snapshot), [snapshot])
  const identity = levelKey(snapshot)
  const mode = trackModeOf(state)
  const levels = state.kind === 'absent' ? [] : state.levels
  const count = levels.length
  const committedIndex = state.kind === 'ready' ? state.index : -1

  const [host, setHost] = useState<EffortBridgeHost | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [failure, setFailure] = useState<EffortFailure | null>(null)

  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const bridgeRef = useRef<EffortBridge | null>(null)
  const draggingRef = useRef(false)
  const draftRef = useRef<number | null>(null)
  /** The level the pointer last landed on: what the next write should ask for. */
  const wantedRef = useRef<number | null>(null)
  /**
   * The level the last write asked for, held until the session's own value
   * catches up with it. It is what stops a release that lands between the
   * response and the frame from asking for the same level twice — `committedIndex`
   * cannot answer that, because it lags a whole frame behind the request.
   */
  const requestedRef = useRef<number | null>(null)
  /** One write at a time; see `write` for why two in flight is the thing to avoid. */
  const inFlightRef = useRef(false)
  /** The current `write`, so a settled one can start the next without recursing by name. */
  const writeRef = useRef<(index: number) => void>(() => {})
  /** Read by the bridge on every scan, so a locale switch re-labels without a remount. */
  const labelsRef = useRef(officialLabels)
  const activeRef = useRef(false)
  labelsRef.current = officialLabels
  activeRef.current = state.kind !== 'absent'

  const tiles = useMemo(() => mosaicTiles(), [])

  // The catalog is shared with the official seat, whose load may not have run for
  // a session this entry mounted into first. Asking again is cheap: the store
  // returns the in-flight promise or the loaded value.
  useEffect(() => {
    if (state.kind === 'absent') load()
  }, [state.kind, identity, load])

  // One level list, one set of transient values. See rule 3 in the header.
  useEffect(() => {
    draftRef.current = null
    wantedRef.current = null
    draggingRef.current = false
    requestedRef.current = null
    inFlightRef.current = false
    setDraft(null)
    setPending(null)
    setFailure(null)
  }, [identity])

  // Rule 2: the host's own frame ends the pending commit. What ends it is the
  // session reporting the level this request ASKED FOR — not merely a value that
  // changed: a frame belonging to an earlier write can arrive after this one was
  // sent, and treating that as the answer drops the display back a level while the
  // request it belongs to is still outstanding. It also retires the request, so a
  // later ask for the same level is a real ask rather than a duplicate.
  useEffect(() => {
    if (pending === null) return
    const requested = requestedRef.current
    if (requested === null) return
    if (snapshot.current?.reasoningEffort !== levels[requested]?.id) return
    requestedRef.current = null
    setPending(null)
  }, [levels, pending, snapshot])

  // Rule 2's backstop: a commit nothing ever answers is reported, not left standing.
  // The slot is freed so the control is not wedged, but the level is not re-asked:
  // a host that has stopped answering is not one to retry into.
  useEffect(() => {
    if (pending === null) return undefined
    const handle = window.setTimeout(() => {
      inFlightRef.current = false
      requestedRef.current = null
      setPending(null)
      setFailure({ code: 'effort.error.timeout' })
    }, COMMIT_TIMEOUT_MS)
    return () => { window.clearTimeout(handle) }
  }, [pending])

  useEffect(() => {
    const bridge = createEffortBridge({
      doc: typeof document === 'undefined' ? null : document,
      win: typeof window === 'undefined' ? null : window,
      anchor: () => anchorRef.current,
      labels: () => labelsRef.current(),
      active: () => activeRef.current,
      onHost: setHost,
    })
    if (bridge === null) return undefined
    bridgeRef.current = bridge
    bridge.start()
    return () => {
      bridgeRef.current = null
      bridge.dispose()
    }
  }, [])

  // The levels arrive AFTER the menu is already open (the catalog loads late), and
  // that changes no DOM the observer watches. Re-scan on the two facts that decide
  // whether there is anything to inject.
  useEffect(() => {
    bridgeRef.current?.scan()
  }, [mode, state.kind])

  const shownIndex = draft ?? pending ?? committedIndex
  const shownPct = shownIndex >= 0 ? pctFromIndex(shownIndex, count) : 0
  const energy = energyFor(shownPct)
  const shownName = shownIndex >= 0 ? levels[shownIndex]?.name : undefined
  const visibleTiles = tileCountFor(shownPct)

  /**
   * Ask the host for one level. At most ONE write is on the wire: a crossing that
   * arrives while one is in flight only moves `wantedRef`, and the response that
   * finishes starts the next one. Two in flight is what this shape exists to
   * prevent — the earlier answer clears the `pending` the later one set, and the
   * display then falls back to a level the user has already left.
   *
   * @param index - the level to ask for.
   */
  const write = useCallback((index: number): void => {
    if (inFlightRef.current) return
    const level = levels[index]
    if (level === undefined) return
    // Nothing to ask for: this is the level the last request asked for, or the
    // session is already on it AND nothing else is on its way. The directory's
    // `select` has no change-detection of its own, so these two checks are the
    // whole distance between a crossing and a duplicate RPC. The second is
    // conditioned on the request being clear because a write in flight means the
    // session is heading somewhere else — dragging back to where it started is a
    // change of mind, not a no-op.
    if (index === requestedRef.current) return
    if (requestedRef.current === null && index === committedIndex) return
    inFlightRef.current = true
    requestedRef.current = index
    setFailure(null)
    setPending(index)
    void select(level.id).then((outcome) => {
      inFlightRef.current = false
      if (!outcome.ok) {
        // A refusal frees the level again, so releasing over it retries.
        requestedRef.current = null
        setPending(null)
        setFailure({ code: outcome.code, ...outcome.params === undefined ? {} : { params: outcome.params } })
      }
      // The pointer may have crossed on while this one was on the wire; that
      // crossing is the next write, and the only one. Consuming it here rather
      // than waiting for the host's frame is what keeps a crossing from being
      // dropped when the frame is slow to arrive.
      const next = wantedRef.current
      if (next !== null && next !== index) writeRef.current(next)
    })
  }, [committedIndex, levels, select])
  writeRef.current = write

  /**
   * Record where the pointer wants to be, and write it unless one is already on
   * the wire — in which case that write's response picks this up.
   *
   * @param index - the level the pointer is on.
   */
  const commit = useCallback((index: number): void => {
    wantedRef.current = index
    writeRef.current(index)
  }, [])

  const pctAtEvent = useCallback((clientX: number): number | null => {
    const node = trackRef.current
    if (node === null) return null
    return pctAt(clientX, node.getBoundingClientRect())
  }, [])

  const moveTo = useCallback((clientX: number): void => {
    const pct = pctAtEvent(clientX)
    if (pct === null) return
    const index = indexFromPct(pct, count)
    // Only a crossing is news: the same band means the same level.
    if (index === draftRef.current) return
    draftRef.current = index
    setDraft(index)
    // Rule 1: the row above renders the SESSION's value, not this draft, so the
    // write rides the crossing instead of waiting for the release.
    commit(index)
  }, [commit, count, pctAtEvent])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (mode !== 'interactive') return
    // The track lives inside the official menu: a bubbled pointer event would
    // reach the row's own handlers, and the row's click drills into the level list.
    event.stopPropagation()
    draggingRef.current = true
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is an optimisation: without it the drag still ends on
      // pointerup, it just does not survive leaving the element.
    }
    // A drag must leave the keyboard where the user left it: the official card
    // closes on a focus change that lands OUTSIDE its own menu, and this node is
    // inside it, so taking focus here is safe and makes the arrows work next.
    trackRef.current?.focus({ preventScroll: true })
    moveTo(event.clientX)
  }, [mode, moveTo])

  /**
   * End the gesture. The release records the level the pointer stopped on, which
   * is the retry when a crossing's write was refused, and the whole of the work
   * when the drag never left the band it started in.
   */
  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    event.stopPropagation()
    draggingRef.current = false
    const index = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (index !== null) commit(index)
  }, [commit])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    event.stopPropagation()
    // A release we never saw — the pointer left the window, the capture was
    // refused, or the button came up over another app — leaves the drag flag set,
    // and a flag stuck true turns the next hover into a drag. The button state is
    // the ground truth, so a move with no buttons pressed ends the gesture.
    if (event.buttons === 0) {
      endDrag(event)
      return
    }
    moveTo(event.clientX)
  }, [endDrag, moveTo])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Escape belongs to the menu (it closes, or backs out of a drilled pane).
    if (event.key === 'Escape') return
    if (event.key === 'Tab') {
      // Hand focus to the official row inside the same card instead of letting the
      // browser walk out of a portaled menu, which would land focus somewhere the
      // user cannot see.
      event.preventDefault()
      event.stopPropagation()
      host?.row.focus()
      return
    }
    if (mode !== 'interactive') return
    const from = shownIndex >= 0 ? shownIndex : 0
    let next: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, from - 1)
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(count - 1, from + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    event.stopPropagation()
    const target = commitIndexFor(mode, next, count)
    if (target !== null) commit(target)
  }, [commit, count, host, mode, shownIndex])

  const note = noteFor(state, failure, t)
  const ariaLabel = shownName === undefined ? t('effort.ariaUnset') : t('effort.aria', { name: shownName })

  return (
    <>
      <span ref={anchorRef} className="dshAppEffortAnchor" aria-hidden="true" />
      {host === null ? null : createPortal(
        <>
          <div
            ref={trackRef}
            className="dshAppEffort-track"
            role="slider"
            tabIndex={mode === 'interactive' ? 0 : -1}
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, count - 1)}
            aria-valuenow={shownIndex >= 0 ? shownIndex : 0}
            aria-valuetext={shownName ?? ''}
            aria-disabled={mode !== 'interactive'}
            data-mode={mode}
            data-energy={energy > 0 ? '1' : '0'}
            data-dragging={draft !== null ? '1' : '0'}
            title={t('effort.hint.keys')}
            style={{ '--dshAppEffort-energy': String(energy) } as React.CSSProperties}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
          >
            <div className="dshAppEffort-fill" style={{ clipPath: fillClip(shownPct) }} />
            <div
              className="dshAppEffort-mosaic"
              style={{ clipPath: fillClip(shownPct), opacity: tileLayerOpacityFor(shownPct) }}
            >
              {tiles.map((tile, index) => {
                if (index >= visibleTiles) return null
                const duration = sweepDurationMsFor(shownPct, tile.tone)
                return (
                  <span
                    key={index}
                    className="dshAppEffort-tile"
                    style={{
                      top: `${(tile.top * 100).toFixed(2)}%`,
                      animationDuration: `${duration.toFixed(0)}ms`,
                      animationDelay: `${tileDelayMsFor(tile, duration).toFixed(0)}ms`,
                    }}
                  >
                    <span
                      className="dshAppEffort-square"
                      style={{ width: tile.size, height: tile.size, opacity: tile.tone }}
                    />
                  </span>
                )
              })}
            </div>
            {mode === 'interactive' ? levels.map((level, index) => (
              <span
                key={level.id}
                className="dshAppEffort-tick"
                data-on={index <= shownIndex ? '1' : '0'}
                style={{ left: offsetExpr(pctFromIndex(index, count)) }}
              />
            )) : null}
            {/* The knob marks a position, so it is absent while there is none —
                an unset track with a knob parked at the left end would claim the
                session is running at the lowest level. */}
            {shownIndex >= 0 && mode !== 'static' ? <div className="dshAppEffort-knob" style={{ left: offsetExpr(shownPct) }} /> : null}
          </div>
          {note === null ? null : (
            <p className="dshAppEffort-note" data-tone={failure === null ? undefined : 'error'}>{note}</p>
          )}
        </>,
        host.container,
      )}
    </>
  )
}

/**
 * The one line under the track, when there is something to say.
 *
 * A failure always wins: it is the only case where what the user sees is not what
 * the session will use. Otherwise the track speaks for itself — a full track with
 * one level, or an empty one following the provider default, is already visible,
 * and the line only names the reason.
 *
 * @param state - the resolved state.
 * @param failure - the coded failure, if any.
 * @param t - this plugin's namespace-bound translate.
 * @returns the sentence, or null when the track needs no explanation.
 */
function noteFor(
  state: ReturnType<typeof resolveEffort>,
  failure: EffortFailure | null,
  t: EffortEntryProps['t'],
): string | null {
  if (failure !== null) return t(failure.code, failure.params)
  if (state.kind === 'unset') return t('effort.noteUnset')
  if (state.kind === 'unknown') return t('effort.noteUnknown', { id: state.raw })
  if (state.kind === 'ready' && state.levels.length <= 1) return t('effort.noteSingle')
  return null
}
