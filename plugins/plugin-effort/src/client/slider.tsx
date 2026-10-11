/**
 * The effort track, rendered into the container the bridge placed inside the
 * official model menu.
 *
 * The component itself owns no DOM contract: the bridge decides where it lives,
 * and this file renders through a portal into that container. What it does own is
 * the interaction and the three rules that keep the position honest:
 *
 *   1. **Nothing is committed while dragging.** The pointer moves the knob and
 *      nothing else; the level is written once, on release. The official
 *      directory has no change-detection of its own (every `select` is an RPC),
 *      so a slider that wrote continuously would put one request per pointer
 *      sample on the wire for a single gesture.
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
  /** The effort id in place when the last commit was sent; a change means the host answered. */
  const beforeRef = useRef<string | undefined>(undefined)
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
    draggingRef.current = false
    setDraft(null)
    setPending(null)
    setFailure(null)
  }, [identity])

  // Rule 2: the host's own frame ends the pending commit, whichever level it names.
  useEffect(() => {
    if (pending === null) return
    if (snapshot.current?.reasoningEffort !== beforeRef.current) setPending(null)
  }, [snapshot, pending])

  // Rule 2's backstop: a commit nothing ever answers is reported, not left standing.
  useEffect(() => {
    if (pending === null) return undefined
    const handle = window.setTimeout(() => {
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

  const commit = useCallback((index: number): void => {
    const level = levels[index]
    if (level === undefined) return
    // Nothing to write: the session is already on this level. The directory's
    // `select` has no change-detection of its own, so this check is the only thing
    // between a re-selected level and a pointless RPC.
    if (index === committedIndex) return
    beforeRef.current = snapshot.current?.reasoningEffort
    setFailure(null)
    setPending(index)
    void select(level.id).then((outcome) => {
      if (outcome.ok) return
      setPending(null)
      setFailure({ code: outcome.code, ...outcome.params === undefined ? {} : { params: outcome.params } })
    })
  }, [committedIndex, levels, select, snapshot])

  const pctAtEvent = useCallback((clientX: number): number | null => {
    const node = trackRef.current
    if (node === null) return null
    return pctAt(clientX, node.getBoundingClientRect())
  }, [])

  const moveTo = useCallback((clientX: number): void => {
    const pct = pctAtEvent(clientX)
    if (pct === null) return
    const index = indexFromPct(pct, count)
    draftRef.current = index
    setDraft(index)
  }, [count, pctAtEvent])

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

  /** End the gesture and write the level the pointer settled on. */
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
