/**
 * DSH APP conversation minimap — a slim rail on the right edge of the chat
 * scrollport. Each user / steering / context message becomes one tick;
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

/** Chat node kinds the minimap tracks. */
type TrackedKind = 'user' | 'steering' | 'context'

const KIND_LABEL: Record<TrackedKind, string> = {
  user: '消息',
  steering: '追问',
  context: '上下文',
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
    if (node.kind !== 'user' && node.kind !== 'steering' && node.kind !== 'context') continue
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
/** Node bar height. */
const TICK_HEIGHT = 6
/** Re-measure de-bounce while a chat is streaming. */
const MEASURE_THROTTLE_MS = 120

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
  pointer-events: none;
}
.dshapp-mm-tick {
  position: absolute;
  left: 4px;
  width: 16px;
  height: 6px;
  border: none;
  padding: 0;
  margin: 0;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.12s ease, width 0.12s ease, left 0.12s ease;
}
.dshapp-mm-tick.is-active {
  width: 20px;
  left: 2px;
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 8px color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
}
/* Hover wins over the reading-anchor highlight: the bar under the cursor
   becomes the brightest one (the gauge width already grows it to 24px via
   inline style); the anchor keeps its shadow only while not hovered. */
.dshapp-mm-tick:hover {
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
`

export function MinimapUtility({ useSession }: MinimapProps): JSX.Element | null {
  const chat = useSession(snapshot => snapshot.chat)
  const entries = useMemo(() => collectEntries(chat), [chat])
  const entryKeys = useMemo(() => entries.map(entry => entry.key), [entries])
  const [layout, setLayout] = useState<LayoutState | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [hover, setHover] = useState<{ key: string; y: number } | null>(null)
  // The tick currently under the cursor; drives the gauge width taper.
  const [tickHover, setTickHover] = useState<number | null>(null)
  /** Gauge width for one tick: base 16, active 20, hovered 24, neighbors taper. */
  const tickGaugeWidth = (index: number): number => {
    if (tickHover === null || Math.abs(index - tickHover) > 2) return index === activeIndex ? 20 : 16
    const distance = Math.abs(index - tickHover)
    return distance === 0 ? 24 : distance === 1 ? 19 : 14
  }
  /** Left offset keeps the tick centered on its 16px track as it grows. */
  const tickGaugeLeft = (index: number): number => {
    const width = tickGaugeWidth(index)
    return width === 16 ? 4 : 4 - (width - 16) / 2
  }
  // Manual jump target: while the jumped-to message is still on screen, its
  // bar stays highlighted no matter how the virtualized list jitters; only a
  // new jump or scrolling it fully off-screen yields to position tracking.
  const [lastJumpKey, setLastJumpKey] = useState<string | null>(null)
  const hostRef = useRef<HTMLElement | null>(null)
  const measureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMeasure = useRef(0)

  useEffect(() => {
    // (Re)bind the scrollport: session switch keeps the same element, view
    // switch swaps the rows inside it. A missing port (no conversation yet)
    // parks the rail.
    const host = document.querySelector<HTMLElement>(SCROLLPORT_SELECTOR)
    hostRef.current = host
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
        setLayout(measureLayout(current, entryKeys))
      }, delay)
    }

    const onScroll = (): void => {
      setScrollTop(host.scrollTop)
      // Streaming grows the port: keep the rail's denominator fresh.
      scheduleMeasure()
    }

    // Layout changes (details column, sidebar collapse) move the port.
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(host)
    host.addEventListener('scroll', onScroll, { passive: true })
    scheduleMeasure()
    setScrollTop(host.scrollTop)

    return () => {
      resizeObserver.disconnect()
      host.removeEventListener('scroll', onScroll)
      if (measureTimer.current !== null) {
        clearTimeout(measureTimer.current)
        measureTimer.current = null
      }
    }
  }, [entryKeys])

  // Hover preview can never outlive the hovered message.
  useEffect(() => {
    if (hover !== null && !entries.some(entry => entry.key === hover.key)) setHover(null)
  }, [entries, hover])

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
    const pos = layout.positions.get(key)
    if (pos === undefined) return
    const maxTop = Math.max(0, host.scrollHeight - host.clientHeight)
    const target = Math.min(maxTop, Math.max(0, host.scrollTop + pos.top - JUMP_PAD))
    setLastJumpKey(key)
    host.scrollTo({ top: target, behavior: 'smooth' })
  }

  if (!viewIsChat || layout === null || layout.hostHeight < MIN_HOST_HEIGHT
    // Only genuine user turns count toward the minimum: a system context
    // reminder on an otherwise empty chat must not raise the rail.
    || entries.filter(entry => entry.kind !== 'context').length < MIN_ENTRIES) {
    return null
  }

  const ratio = (top: number): number => layout.scrollHeight <= 0
    ? 0
    : Math.min(1, Math.max(0, top / layout.scrollHeight))
  const vh = layout.hostHeight

  // Fixed node list (iconic navigator, not a scrollbar): every tracked message
  // maps to one fixed slot in a vertically centered track; scrolling only
  // moves the active highlight, never the nodes themselves. The active node
  // is the first row whose top edge is at or below the viewport's top edge —
  // the "reading anchor": jump to message #3 and #3's bar is the highlighted
  // one (its row top sits just under the viewport top), never a straggler.
  const activeIndex = (() => {
    const byPosition = () => {
      // `pos.top` is the row's offset in the *visible* scrollport (rect minus
      // host rect): rows above the fold are negative, the first row at or
      // below the fold is the reading anchor.
      let found = -1
      for (let i = 0; i < entries.length; i += 1) {
        const pos = layout.positions.get(entries[i].key)
        if (pos === undefined) continue
        if (pos.top >= 0) {
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
      if (pos !== undefined && pos.top + pos.height >= 0) return i
    }
    return byPosition()
  })()

  // Long chats compress the slot pitch (never below MIN_TICK_SPACING) so the
  // whole rail still fits the viewport; short chats breathe at TICK_SPACING.
  const spacing = Math.max(MIN_TICK_SPACING, Math.min(TICK_SPACING, (vh - 16 - TICK_HEIGHT) / Math.max(1, entries.length - 1)))
  const trackH = (entries.length - 1) * spacing + TICK_HEIGHT
  const trackTop = layout.hostTop + Math.max(8, (vh - trackH) / 2)

  // Hover payload: position + the hovered entry; null when the hovered key
  // disappeared (session switch / stream rewrite).
  const preview = hover === null
    ? null
    : { y: hover.y, entry: entries.find(entry => entry.key === hover.key) ?? null }

  return (
    <>
      <style>{MINIMAP_CSS}</style>
      <div
        className="dshapp-mm-track"
        style={{
          left: layout.hostLeft + 12,
          top: trackTop,
          height: trackH,
        }}
      >
        {entries.map((entry, index) => (
          <button
            key={entry.key}
            type="button"
            className={index === activeIndex ? 'dshapp-mm-tick is-active' : 'dshapp-mm-tick'}
            style={{
              top: index * spacing,
              // Gauge-hover effect: the tick under the cursor grows, its
              // neighbors taper by distance, others rest at base.
              width: tickGaugeWidth(index),
              left: tickGaugeLeft(index),
            }}
            title={formatClock(entry.time) ?? undefined}
            aria-label={`跳转到${KIND_LABEL[entry.kind]}: ${entry.text ?? ''}`}
            aria-current={index === activeIndex ? 'true' : undefined}
            data-dshapp-mm-key={entry.key}
            onClick={() => { jump(entry.key) }}
            onMouseEnter={(event) => { setTickHover(index); setHover({ key: entry.key, y: event.clientY }) }}
            onMouseMove={(event) => {
              setHover(current => (
                current !== null && current.key === entry.key
                  ? { ...current, y: event.clientY }
                  : current
              ))
            }}
            onMouseLeave={() => {
              setTickHover(null)
              setHover(current => current?.key === entry.key ? null : current)
            }}
          />
        ))}
        {preview !== null && preview.entry !== null && (
          <div
            className="dshapp-mm-preview"
            style={{
              // Fixed to the viewport: stays next to the cursor (right of the
              // node rail) instead of leaking to the bottom-left corner when
              // the rail sits mid-column (the rail is vertically centered).
              left: layout.hostLeft + 12 + 24 + 10,
              top: Math.min(window.innerHeight - 88, Math.max(12, preview.y - 24)),
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