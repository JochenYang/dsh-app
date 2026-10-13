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
 *   4. **The control's box does not depend on its shape.** The note line under the
 *      track is drawn in every state — with an empty sentence when there is nothing
 *      to explain — and every pointer sample of a gesture is mapped through the box
 *      the gesture started on ({@link createGestureMap}). Both exist for the same
 *      reason: the official menu places itself from its own height and re-lays out
 *      from its own content, so a control whose box changed shape would move the
 *      card AND move the scale under a pointer that never moved. The sheet's
 *      `contain: inline-size` is the third leg of that (see `styles.ts`).
 *
 * The container this file portals into is the SECOND LINE of the official row's
 * capsule, and the capsule's edge and the row's value cell carry the current
 * level's colour. All of that is the bridge's writes and the bridge's restores;
 * all this file decides is which colours, from the position it is already showing.
 *
 * @module @dsh-app/plugin-effort/client/slider
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { createEffortBridge, type EffortBridge, type EffortBridgeHost, type EffortRowLabels, type LevelColors } from './bridge.ts'
import { createGestureMap, fillClip, headEdgeExpr, indexFromPct, offsetExpr, pctFromIndex } from './geometry.ts'
import { commitIndexFor, levelKey, resolveEffort, trackModeOf } from './levels.ts'
import {
  ENERGY_END,
  driftDelayMsFor,
  energyFor,
  mosaicTiles,
  sweepDurationMsFor,
  sweepPctFor,
  tileDelayMsFor,
  tileLayerOpacityFor,
  tileStateFor,
} from './mosaic.ts'
import { NS, type EffortKey } from './locales.ts'
import { controlShapeFor, type EffortFailure } from './shape.ts'
import { isDarkTheme, ringColorAt, textColorAt } from './value-color.ts'

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
  /**
   * The track box one GESTURE is mapped through, read when the gesture opens and
   * held until it ends — see `createGestureMap`. Re-reading it per sample is what
   * let a re-layout in the middle of a drag (the note line, an error arriving)
   * re-map the same pointer position onto a different level.
   */
  const gesture = useMemo(() => createGestureMap(() => {
    const node = trackRef.current
    return node === null ? null : node.getBoundingClientRect()
  }), [])
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
  /**
   * The position the capsule's colours are read from, refreshed on every render.
   * The bridge asks for them at PAINT time, which can be later than the render
   * that moved the level, so the callback reads this pair rather than colours
   * captured here. The level's own id travels with the pair: the composer's level
   * text is marked with it, so the DOM says which level its colour belongs to.
   */
  const tintRef = useRef<{ index: number, count: number, level: string }>({ index: -1, count: 0, level: '' })
  /**
   * The position the mosaic's sweep timing was last read at. Held across a gesture
   * so the animation is not re-timed under the pointer; see `sweepPctFor`.
   */
  const settledSweepRef = useRef(0)

  const tiles = useMemo(() => mosaicTiles(), [])

  /**
   * The colours the official surfaces should carry right now: the level name's text
   * colour and the capsule ring's.
   *
   * Both come from the track's own ramp at this position — the name lifted to text
   * contrast, the ring the same colour at its alpha — so the capsule's edge and
   * the name move with the track instead of being a fixed theme accent. The name's
   * colour is ALSO what the composer capsule's own level text takes (the bridge
   * writes it there too), which is what keeps the two readings of one level the
   * same colour.
   *
   * Null when there is no position to speak for: the bridge then puts the cell's
   * own colour back, gives the capsule a neutral edge, and takes its mark off the
   * composer's text. The theme is read here rather than captured, so a paint that
   * follows a theme switch carries the right ramp.
   *
   * @returns the colours, or null when the session has no position on this scale.
   */
  const levelColorsOf = useCallback((): LevelColors | null => {
    const { index, count: total, level } = tintRef.current
    if (index < 0 || level === '') return null
    const dark = isDarkTheme(typeof document === 'undefined' ? null : document)
    const pct = pctFromIndex(index, total)
    return { level, text: textColorAt(pct, dark), ring: ringColorAt(pct, dark) }
  }, [])

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
      levelColors: levelColorsOf,
      onHost: setHost,
    })
    if (bridge === null) return undefined
    bridgeRef.current = bridge
    bridge.start()
    return () => {
      bridgeRef.current = null
      bridge.dispose()
    }
  }, [levelColorsOf])

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
  tintRef.current = { index: shownIndex, count, level: shownIndex >= 0 ? levels[shownIndex]?.id ?? '' : '' }

  // The sweep's timing is frozen while the display is ahead of the session; see
  // `sweepPctFor` for why reading it off the displayed position made the squares
  // jump on every node a drag crossed. The ref is written with the value just
  // used, so it tracks the position while the two are level and holds still while
  // they are not.
  const ahead = draft !== null || pending !== null
  const sweepPct = sweepPctFor(shownPct, ahead, settledSweepRef.current)
  settledSweepRef.current = sweepPct

  // The level's colours follow the position, on both official surfaces — the menu
  // row's capsule and the composer capsule's own level text. A level change inserts
  // nothing into the DOM, so the observer never sees it: this is the direct path,
  // and the scan-time re-assert covers the other direction (something else clearing
  // the inline style).
  useEffect(() => {
    bridgeRef.current?.paint()
  }, [shownIndex, count])

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

  const moveTo = useCallback((clientX: number): void => {
    // The gesture's own box, not the track's right now: see `createGestureMap`.
    const pct = gesture.pctAt(clientX)
    if (pct === null) return
    const index = indexFromPct(pct, count)
    // Only a crossing is news: the same band means the same level.
    if (index === draftRef.current) return
    draftRef.current = index
    setDraft(index)
    // Rule 1: the row above renders the SESSION's value, not this draft, so the
    // write rides the crossing instead of waiting for the release.
    commit(index)
  }, [commit, count, gesture])

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
    // Freeze the box BEFORE the first sample: this position may itself be what
    // re-lays the card out (the note line going away), and the samples that follow
    // have to be read against the same scale the user pressed on.
    gesture.begin()
    moveTo(event.clientX)
  }, [gesture, mode, moveTo])

  /**
   * End the gesture. The release records the level the pointer stopped on, which
   * is the retry when a crossing's write was refused, and the whole of the work
   * when the drag never left the band it started in.
   */
  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    event.stopPropagation()
    draggingRef.current = false
    gesture.end()
    const index = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (index !== null) commit(index)
  }, [commit, gesture])

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

  /**
   * Swallow the `click` the browser fires after a press-and-release on the track.
   *
   * The track's own handling is `pointer*`, so a drag is entirely ours — but the
   * browser also emits a `click` for a down-and-up on the same element, and that
   * click bubbles out of the container into the official row, whose own `onClick`
   * drills into the level list. Without this, letting go of the knob opens the
   * picker over the capsule.
   *
   * `stopPropagation` is enough HERE, and only here: React's delegated listener
   * sits on the portal container (this track's parent), so a click stopped at the
   * track never reaches that container, the row, or the kernel's own listener on
   * the body. A listener on the container itself could not do this — React's
   * listener shares that node, and every listener on one node runs.
   *
   * A click anywhere else in the capsule is deliberately left alone: the row keeps
   * its own behaviour there, which is what the official row does.
   */
  const onTrackClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
  }, [])

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

  const shape = controlShapeFor(state, failure, t, shownIndex)
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
            data-drift={shownPct > ENERGY_END ? '1' : '0'}
            data-dragging={draft !== null ? '1' : '0'}
            title={t('effort.hint.keys')}
            style={{ '--dshAppEffort-energy': String(energy) } as React.CSSProperties}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={onTrackClick}
            onKeyDown={onKeyDown}
          >
            <div className="dshAppEffort-fill" style={{ clipPath: fillClip(shownPct) }} />
            {/* The leading edge's bloom. It fades in with the mosaic's own energy,
                so the low end of the scale stays calm, and it is anchored on the
                knob's rim rather than on the clip's edge — see `headEdgeExpr`. */}
            <div
              className="dshAppEffort-bloom"
              style={{
                '--dshAppEffort-head': headEdgeExpr(shownPct),
                clipPath: fillClip(shownPct),
                opacity: energy,
              } as React.CSSProperties}
            />
            <div
              className="dshAppEffort-mosaic"
              style={{ clipPath: fillClip(shownPct), opacity: tileLayerOpacityFor(shownPct) }}
            >
              {/* Every tile is always rendered: the ones outside the count are faded
                  out and paused rather than unmounted, which is what stopped them
                  appearing and vanishing in the middle of the track. */}
              {tiles.map((tile, index) => {
                const state = tileStateFor(tile, index, shownPct)
                const duration = sweepDurationMsFor(sweepPct, tile.tone)
                return (
                  <span
                    key={index}
                    className="dshAppEffort-tile"
                    data-on={state.on ? '1' : '0'}
                    style={{
                      top: `${(tile.top * 100).toFixed(2)}%`,
                      animationDuration: `${duration.toFixed(0)}ms`,
                      animationDelay: `${tileDelayMsFor(tile, duration).toFixed(0)}ms`,
                    }}
                  >
                    <span
                      className="dshAppEffort-square"
                      style={{
                        width: tile.size,
                        height: tile.size,
                        opacity: state.opacity,
                        animationDelay: `${driftDelayMsFor(tile).toFixed(0)}ms`,
                      }}
                    />
                  </span>
                )
              })}
            </div>
            {shape.ticks ? levels.map((level, index) => (
              <span
                key={level.id}
                className="dshAppEffort-tick"
                data-on={index <= shownIndex ? '1' : '0'}
                style={{ left: offsetExpr(pctFromIndex(index, count)) }}
              />
            )) : null}
            {/* The knob marks a position, so it is absent while there is none —
                an unset track with a knob parked at the left end would claim the
                session is running at the lowest level. It is the ONLY layer that
                tells an unset track from a ready one; see `controlShapeFor`. */}
            {shape.knob ? <div className="dshAppEffort-knob" style={{ left: offsetExpr(shownPct) }} /> : null}
          </div>
          {/* The line is drawn in EVERY shape — an empty one included. Its box is
              what keeps the container the same height, and the container's height is
              what decides where the official menu places itself; unmounting the line
              moves the whole card by 20px the moment a drag turns "following the
              provider default" into a level. `controlShapeFor` says which sentence,
              never whether there is one. */}
          <p className="dshAppEffort-note" data-tone={shape.noteError ? 'error' : undefined}>{shape.note}</p>
        </>,
        host.container,
      )}
    </>
  )
}
