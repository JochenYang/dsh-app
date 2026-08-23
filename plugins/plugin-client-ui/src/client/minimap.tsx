/**
 * DSH APP conversation minimap — a slim rail on the right edge of the chat
 * scrollport. Each user / steering message becomes one tick;
 * hovering a tick shows a text preview of that message, clicking it scrolls
 * the conversation to the message.
 *
 * Data comes from the session's live ChatSnapshot (ordered node keys + node
 * store). DOM anchoring reuses the transcript's stable hooks: every message
 * row carries `data-chat-anchor-key` (= the snapshot node key) inside the
 * `[data-conversation-scroll]` scrollport — the same attributes the upstream
 * chat view itself uses for paging anchors.
 *
 * Mounted into `conversation.session.header.utilities` (session scope), so it
 * follows session switches and unmounts with the hidden blank-session header.
 * Degrades silently: fewer than two messages, a missing scrollport, or a
 * non-chat view (no row DOM) renders nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

export type MinimapProps = PropsRuntime<'conversation.session.header.utilities'>

/** Chat node kinds the minimap tracks: user-side turns only. Assistant
 * replies are deliberately NOT tracked (too many ticks, no user intent) and
 * system-injected context nodes are excluded as well. */
type TrackedKind = 'user' | 'steering'

const KIND_LABEL: Record<TrackedKind, string> = {
  user: '消息',
  steering: '追问',
}

/** Empty-image-fallback copy (zh-CN product copy). */
const IMAGE_ONLY_LABEL = '（图片消息）'
const OTHER_ONLY_LABEL = '（特殊消息）'

interface MinimapEntry {
  /** ChatConversationViewNode key, equal to the row's `data-chat-anchor-key`. */
  key: string
  kind: TrackedKind
  /** Plain text preview; null when the message carries no text blocks. */
  text: string | null
  /** Unix epoch ms from the source session event. */
  time: number | null
}

/** Runtime-narrowed view of a content block (no dependency on host types). */
interface ContentBlockLike {
  type?: unknown
  text?: unknown
}

/** Extract joined plain text from ContentBlock-like payloads; null when empty. */
function previewText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const hasContent = content.length > 0
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const seen = block as ContentBlockLike
    if (seen.type === 'text' && typeof seen.text === 'string' && seen.text.length > 0) {
      parts.push(seen.text)
    }
  }
  if (parts.length === 0) return hasContent ? null : null
  const text = parts.join(' ').replace(/\s+/gu, ' ').trim()
  return text === '' ? null : text
}

/** Collect tracked entries in transcript order from the ChatSnapshot. */
function collectEntries(chat: {
  readonly order: readonly string[]
  readonly nodes: {
    get(key: string): { readonly key: string; readonly kind: string; readonly data: unknown } | undefined
  }
}): MinimapEntry[] {
  const entries: MinimapEntry[] = []
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined) continue
    if (node.kind !== 'user' && node.kind !== 'steering') continue
    const data = node.data as { content?: unknown; time?: unknown } | null
    entries.push({
      key,
      kind: node.kind,
      text: previewText(data?.content),
      time: data !== null && typeof data.time === 'number' ? data.time : null,
    })
  }
  return entries
}

/** Measured row geometry relative to the scrollport's visible box. */
interface RowGeometry {
  top: number
  height: number
}

/** Snapshot of the scrollport box + row placement used to paint the rail. */
interface LayoutState {
  hostTop: number
  hostLeft: number
  hostHeight: number
  scrollTop: number
  scrollHeight: number
  positions: Map<string, RowGeometry>
}

const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'
const ANCHOR_SELECTOR = '[data-chat-anchor-key]'
/** Row height below which the rail is pointless (matches upstream toolbars). */
const MIN_HOST_HEIGHT = 240
/** Minimum tracked messages before the rail appears. */
const MIN_ENTRIES = 2
/** Jump offset so the targeted message sits just below the viewport top. */
const JUMP_PAD = 12
/** Nominal slot pitch of the node list (bar + gap; icons never move while scrolling). */
const TICK_SPACING = 14
/** Shortest slot pitch when a long chat must compress the track. */
const MIN_TICK_SPACING = 8
/** Thin tick-mark line height, matching the reference rail's 0.5rem line. */
const TICK_HEIGHT = 2
/** Re-measure de-bounce while a chat is streaming. */
const MEASURE_THROTTLE_MS = 120
/** The hover pyramid used by the beUI/Codex-style preview rail. */
const PYRAMID_SCALE = 1
const PYRAMID_NEAR_SCALE = 0.68
const PYRAMID_FAR_SCALE = 0.44
const PYRAMID_REST_SCALE = 0.25

function pyramidScaleFor(index: number, hoveredIndex: number | null): number {
  // Resting state is intentionally uniform and compact. The reading anchor
  // remains available to assistive technology, but does not create a second
  // visual emphasis before the pointer enters the rail.
  if (hoveredIndex === null) return PYRAMID_REST_SCALE
  const distance = Math.abs(index - hoveredIndex)
  if (distance === 0) return PYRAMID_SCALE
  if (distance === 1) return PYRAMID_NEAR_SCALE
  if (distance === 2) return PYRAMID_FAR_SCALE
  return PYRAMID_REST_SCALE
}

/** hh:mm for today, `M-D hh:mm` for older dates. */
function formatClock(time: number | null): string | null {
  if (time === null) return null
  const date = new Date(time)
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  ) {
    return clock
  }
  return `${date.getMonth() + 1}-${date.getDate()} ${clock}`
}

/** Tracked-entry DOM ruler */
function measureLayout(host: HTMLElement, keys: readonly string[]): LayoutState {
  const hostRect = host.getBoundingClientRect()
  const rows = host.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)
  const positions = new Map<string, RowGeometry>()
  for (const row of rows) {
    const key = row.getAttribute('data-chat-anchor-key')
    if (key === null || key === '') continue
    const rect = row.getBoundingClientRect()
    positions.set(key, { top: rect.top - hostRect.top, height: rect.height })
  }
  // Unmeasured keys (still rendering, or the chat view is not active) keep a
  // stale entry only if we have nothing fresher — drop them: a missing row
  // means the tick would point nowhere.
  const positionsMap = new Map<string, RowGeometry>()
  for (const key of keys) {
    const pos = positions.get(key)
    if (pos !== undefined) positionsMap.set(key, pos)
  }
  return {
    hostTop: hostRect.top,
    hostLeft: hostRect.left,
    hostHeight: hostRect.height,
    scrollTop: host.scrollTop,
    scrollHeight: host.scrollHeight,
    positions: positionsMap,
  }
}

/** MINIMAP_CSS: class-prefixed styles injected beside the rail (no css pipeline in the brand bundle). */
const MINIMAP_CSS = `
.dshapp-mm-track {
  position: fixed;
  width: 24px;
  z-index: 20;
  pointer-events: auto;
}
.dshapp-mm-item {
  position: absolute;
  left: 2px;
  width: 24px;
  height: 14px;
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.dshapp-mm-tick {
  display: block;
  flex: none;
  width: 24px;
  height: 2px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
  transform-origin: left center;
  transform: scaleX(0.667);
  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.dshapp-mm-tick.is-active {
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 8px color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
}
/* The hit area is the full slot; only the inner tick receives the color. */
.dshapp-mm-item:hover .dshapp-mm-tick {
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 8px color-mix(in srgb, var(--dsw-alias-brand-primary) 60%, transparent);
}
.dshapp-mm-preview {
  position: fixed;
  width: 252px;
  max-width: 252px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 8px 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  color: var(--dsw-alias-label-primary);
  transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
}
.dshapp-mm-preview-head {
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshapp-mm-preview-text {
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dshapp-mm-preview-text.is-empty {
  color: var(--dsw-alias-label-secondary);
}
@media (prefers-reduced-motion: reduce) {
  .dshapp-mm-tick,
  .dshapp-mm-preview {
    transition: none;
  }
}
`

export function MinimapUtility({ useSession }: MinimapProps): JSX.Element | null {
  const chat = useSession(snapshot => snapshot.chat)
  const entries = useMemo(() => collectEntries(chat), [chat])
  const entryKeys = useMemo(() => entries.map(entry => entry.key), [entries])
  const [layout, setLayout] = useState<LayoutState | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const scrollTopRef = useRef(0)
  const [hover, setHover] = useState<{ key: string; y: number } | null>(null)
  // Hover mirrored into a ref: the measure scheduler (effect closure) reads it
  // without depending on render cycles.
  const hoverRef = useRef<{ key: string; y: number } | null>(null)
  // Manual jump target: while the jumped-to message is still on screen, its
  // bar stays highlighted no matter how the virtualized list jitters; only a
  // new jump or scrolling it fully off-screen yields to position tracking.
  const [lastJumpKey, setLastJumpKey] = useState<string | null>(null)
  const hostRef = useRef<HTMLElement | null>(null)
  const measureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleMeasureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const lastMeasure = useRef(0)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** Index-centered hover state; the rail uses a discrete pyramid, not a
   * pixel-distance heatmap. */
  const hoverIndexRef = useRef<number | null>(null)
  const gaugePaintedValuesRef = useRef<number[]>([])
  const gaugeTicksRef = useRef<HTMLElement[]>([])
  const lastPaintedActiveIndexRef = useRef(-1)
  const lastPaintedHoverIndexRef = useRef<number | null>(null)
  const activeIndexRef = useRef(-1)

  /** Set target transforms only when the pyramid center changes. The browser's
   * compositor owns the 180ms interruptible transition between these values.
   * Hovering one slot only affects that slot and its two neighbors on either
   * side; avoid touching every tick on each pointer transition. */
  const paintGaugeTargets = (activeIndex: number, forceAll = false): void => {
    const count = gaugeTicksRef.current.length > 0 ? gaugeTicksRef.current.length : entries.length
    const hoveredIndex = hoverIndexRef.current
    const previousActiveIndex = lastPaintedActiveIndexRef.current
    const previousHoveredIndex = lastPaintedHoverIndexRef.current
    const indexes = new Set<number>()
    const addNeighborhood = (index: number | null): void => {
      if (index === null || index < 0) return
      for (let offset = -2; offset <= 2; offset += 1) indexes.add(index + offset)
    }
    if (forceAll || gaugePaintedValuesRef.current.length !== count) {
      for (let index = 0; index < count; index += 1) indexes.add(index)
    } else {
      addNeighborhood(previousHoveredIndex)
      addNeighborhood(hoveredIndex)
      if (previousActiveIndex >= 0) indexes.add(previousActiveIndex)
      if (activeIndex >= 0) indexes.add(activeIndex)
    }
    for (const index of indexes) {
      if (index < 0 || index >= count) continue
      const target = pyramidScaleFor(index, hoveredIndex)
      const tick = gaugeTicksRef.current[index]
      const painted = gaugePaintedValuesRef.current[index]
      if (tick !== undefined && (painted === undefined || Math.abs(painted - target) > 0.0005)) {
        tick.style.transform = `scaleX(${target.toFixed(3)})`
        gaugePaintedValuesRef.current[index] = target
      }
    }
    gaugePaintedValuesRef.current.length = count
    lastPaintedActiveIndexRef.current = activeIndex
    lastPaintedHoverIndexRef.current = hoveredIndex
  }

  const cancelHoverClear = (): void => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }

  /** Keep the preview and pyramid alive across the small gaps inside the rail;
   * only leaving the whole rail starts the delayed reset. */
  const scheduleHoverClear = (): void => {
    cancelHoverClear()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      hoverIndexRef.current = null
      hoverRef.current = null
      setHover(null)
      paintGaugeTargets(activeIndexRef.current)
    }, 200)
  }

  useEffect(() => {
    // (Re)bind the scrollport: session switch keeps the same element, view
    // switch swaps the rows inside it. A missing port (no conversation yet)
    // parks the rail.
    const host = document.querySelector<HTMLElement>(SCROLLPORT_SELECTOR)
    hostRef.current = host
    hoverRef.current = null
    hoverIndexRef.current = null
    gaugePaintedValuesRef.current = []
    gaugeTicksRef.current = []
    lastPaintedActiveIndexRef.current = -1
    lastPaintedHoverIndexRef.current = null
    setHover(null)
    if (host === null) {
      setLayout(null)
      return
    }

    const scheduleMeasure = (): void => {
      if (measureTimer.current !== null) return
      const now = Date.now()
      const delay = Math.max(0, MEASURE_THROTTLE_MS - (now - lastMeasure.current))
      measureTimer.current = setTimeout(() => {
        measureTimer.current = null
        lastMeasure.current = Date.now()
        const current = hostRef.current
        if (current === null || !current.isConnected) {
          setLayout(null)
          return
        }
        // Freeze the rail while a preview is open: a streaming remeasure
        // changes trackH/trackTop, the ticks move out from under the cursor
        // and the hover dies — the blinking preview the user reported. The
        // next measure after the hover ends catches the rail up.
        if (hoverRef.current !== null) return
        setLayout(measureLayout(current, entryKeys))
      }, delay)
    }

    const scheduleSettleMeasure = (): void => {
      if (settleMeasureTimer.current !== null) clearTimeout(settleMeasureTimer.current)
      settleMeasureTimer.current = setTimeout(() => {
        settleMeasureTimer.current = null
        scheduleMeasure()
      }, 160)
    }

    const onScroll = (): void => {
      scrollTopRef.current = host.scrollTop
      // Coalesce scroll events to one lightweight React update per frame. The
      // expensive DOM measurement is deferred until scrolling settles below.
      if (scrollFrame.current === null) {
        scrollFrame.current = requestAnimationFrame(() => {
          scrollFrame.current = null
          setScrollTop(scrollTopRef.current)
        })
      }
      scheduleSettleMeasure()
    }

    // Layout changes (details column, sidebar collapse) move the port.
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(host)
    host.addEventListener('scroll', onScroll, { passive: true })
    scheduleMeasure()
    scrollTopRef.current = host.scrollTop
    setScrollTop(host.scrollTop)

    return () => {
      resizeObserver.disconnect()
      host.removeEventListener('scroll', onScroll)
      if (settleMeasureTimer.current !== null) {
        clearTimeout(settleMeasureTimer.current)
        settleMeasureTimer.current = null
      }
      if (scrollFrame.current !== null) {
        cancelAnimationFrame(scrollFrame.current)
        scrollFrame.current = null
      }
      if (measureTimer.current !== null) {
        clearTimeout(measureTimer.current)
        measureTimer.current = null
      }
    }
  }, [entryKeys])

  // Hover preview can never outlive the hovered tick — but judge against the
  // MEASURED positions, not the live snapshot: streaming rewrites the
  // snapshot tree constantly and an entry can vanish for a frame, which would
  // blink the preview. A real disappearance (message gone) shows up in the
  // next layout and clears the hover then.
  useEffect(() => {
    if (hover !== null && layout !== null && !layout.positions.has(hover.key)) {
      setHover(null)
    }
  }, [hover, layout])

  // Clean up the hover-debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
    }
  }, [])

  // The minimap belongs to the CHAT view only. The header utilities seat
  // keeps this component mounted across view switches (文件/Git), so the
  // active view-tab is observed and anything but 对话 renders nothing.
  const [viewIsChat, setViewIsChat] = useState(true)
  useEffect(() => {
    const check = (): void => {
      const tabs = [...document.querySelectorAll('[role="tablist"]')]
        .find(candidate => (candidate.textContent ?? '').includes('对话'))
      if (tabs === undefined) {
        setViewIsChat(true)
        return
      }
      const label = (tabs.querySelector('[aria-selected="true"]')?.textContent ?? '').trim()
      setViewIsChat(label === '' || label === '对话')
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] })
    return () => { observer.disconnect() }
  }, [])

  const jump = (key: string): void => {
    const host = hostRef.current
    if (host === null || layout === null) return
    // Measure fresh instead of trusting the (possibly hover-frozen) layout:
    // a click can land while the rail geometry is outdated by streaming.
    const pos = measureLayout(host, entryKeys).positions.get(key)
    if (pos === undefined) return
    const maxTop = Math.max(0, host.scrollHeight - host.clientHeight)
    const target = Math.min(maxTop, Math.max(0, host.scrollTop + pos.top - JUMP_PAD))
    setLastJumpKey(key)
    host.scrollTo({ top: target, behavior: 'smooth' })
  }

  const canRender = viewIsChat && layout !== null && layout.hostHeight >= MIN_HOST_HEIGHT
    // Only genuine user turns count toward the minimum: a system context
    // reminder on an otherwise empty chat must not raise the rail.
    && entries.length >= MIN_ENTRIES
  const vh = layout?.hostHeight ?? 0

  // Fixed node list (iconic navigator, not a scrollbar): every tracked message
  // maps to one fixed slot in a vertically centered track; scrolling only
  // moves the active highlight, never the nodes themselves. The active node
  // is the first row whose top edge is at or below the viewport's top edge —
  // the "reading anchor": jump to message #3 and #3's bar is the highlighted
  // one (its row top sits just under the viewport top), never a straggler.
  const activeIndex = layout === null ? -1 : (() => {
    const scrollDelta = scrollTop - layout.scrollTop
    const byPosition = () => {
      // `pos.top` is the row's offset in the *visible* scrollport (rect minus
      // host rect) at the last measurement. Scrolling changes every row by
      // the same delta, so the active anchor can be calculated without a
      // layout read on every scroll frame.
      let found = -1
      for (let i = 0; i < entries.length; i += 1) {
        const pos = layout.positions.get(entries[i].key)
        if (pos === undefined) continue
        if (pos.top - scrollDelta >= 0) {
          found = i
          break
        }
      }
      return found === -1 ? entries.length - 1 : found
    }
    if (lastJumpKey !== null) {
      const i = entries.findIndex(entry => entry.key === lastJumpKey)
      const pos = i >= 0 ? layout.positions.get(lastJumpKey) : undefined
      // A virtualized list may temporarily drop the row's DOM while it
      // streams into view — as long as we know it is at/below the fold (or on
      // screen) keep it highlighted; once fully scrolled away, let the
      // position-based anchor take over again.
      if (pos !== undefined && pos.top - scrollDelta + pos.height >= 0) return i
    }
    return byPosition()
  })()

  // Long chats compress the slot pitch (never below MIN_TICK_SPACING) so the
  // whole rail still fits the viewport; short chats breathe at TICK_SPACING.
  const spacing = layout === null
    ? TICK_SPACING
    : Math.max(MIN_TICK_SPACING, Math.min(TICK_SPACING, (vh - 16 - TICK_HEIGHT) / Math.max(1, entries.length - 1)))
  const trackH = (entries.length - 1) * spacing + TICK_HEIGHT
  const trackTop = layout === null ? 0 : layout.hostTop + Math.max(8, (vh - trackH) / 2)

  // Hover payload: position + the hovered entry; null when the hovered key
  // disappeared (session switch / stream rewrite).
  const preview = hover === null
    ? null
    : { y: hover.y, entry: entries.find(entry => entry.key === hover.key) ?? null }
  const previewIndex = preview === null || preview.entry === null
    ? -1
    : entries.findIndex(entry => entry.key === preview.entry?.key)
  // The pointer target temporarily owns the visual highlight. The reading
  // anchor is only highlighted while the rail is at rest; otherwise the
  // anchor and hovered tick compete as two equally bright targets.
  const highlightedIndex = previewIndex
  const previewRawTop = previewIndex < 0 ? trackTop : trackTop + previewIndex * spacing - 24
  const previewTop = Math.min(window.innerHeight - 88, Math.max(12, previewRawTop))

  // Cache the small set of tick nodes after React commits. Pointer changes then
  // only update target transforms; CSS owns the compositor transition.
  useEffect(() => {
    activeIndexRef.current = activeIndex
    if (!canRender || layout === null) {
      gaugePaintedValuesRef.current = []
      gaugeTicksRef.current = []
      lastPaintedActiveIndexRef.current = -1
      lastPaintedHoverIndexRef.current = null
      return
    }
    const track = trackRef.current
    gaugeTicksRef.current = track === null
      ? []
      : Array.from(track.querySelectorAll<HTMLElement>('[data-dshapp-mm-tick-index]'))
    gaugePaintedValuesRef.current = []
    paintGaugeTargets(activeIndex)
  }, [canRender, layout, entryKeys, trackTop, spacing, activeIndex])

  if (!viewIsChat || layout === null || layout.hostHeight < MIN_HOST_HEIGHT
    || entries.length < MIN_ENTRIES) {
    return null
  }

  return (
    <>
      <style>{MINIMAP_CSS}</style>
      <div
        className="dshapp-mm-track"
        ref={trackRef}
        style={{
          left: layout.hostLeft + 12,
          top: trackTop,
          height: trackH,
        }}
        onPointerLeave={() => { scheduleHoverClear() }}
      >
        {entries.map((entry, index) => (
          <button
            key={entry.key}
            type="button"
            className="dshapp-mm-item"
            style={{
              top: index * spacing,
              height: spacing,
            }}
            title={formatClock(entry.time) ?? undefined}
            aria-label={`跳转到${KIND_LABEL[entry.kind]}: ${entry.text ?? ''}`}
            aria-current={index === activeIndex ? 'true' : undefined}
            data-dshapp-mm-key={entry.key}
            onClick={() => { jump(entry.key) }}
            onPointerEnter={(event) => {
              cancelHoverClear()
              hoverIndexRef.current = index
              const next = { key: entry.key, y: event.clientY }
              hoverRef.current = next
              setHover(next)
              paintGaugeTargets(activeIndexRef.current)
            }}
            onFocus={() => {
              cancelHoverClear()
              hoverIndexRef.current = index
              hoverRef.current = { key: entry.key, y: 0 }
              setHover({ key: entry.key, y: 0 })
              paintGaugeTargets(activeIndexRef.current)
            }}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) scheduleHoverClear()
            }}
          >
            <span
              className={index === highlightedIndex ? 'dshapp-mm-tick is-active' : 'dshapp-mm-tick'}
              aria-hidden="true"
              data-dshapp-mm-tick-index={index}
            />
          </button>
        ))}
        {preview !== null && preview.entry !== null && (
          <div
            className="dshapp-mm-preview"
            style={{
              // Slot-aligned like PreviewRail: the card follows the selected
              // item, not the last mouse pixel inside its hit area.
              left: layout.hostLeft + 12 + 24 + 10,
              top: previewTop,
              transform: `translateY(${previewRawTop - previewTop}px)`,
            }}
          >
            <div className="dshapp-mm-preview-head">
              {KIND_LABEL[preview.entry.kind]} · {formatClock(preview.entry.time) ?? '--:--'}
            </div>
            <div className={preview.entry.text === null ? 'dshapp-mm-preview-text is-empty' : 'dshapp-mm-preview-text'}>
              {preview.entry.text ?? IMAGE_ONLY_LABEL}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
