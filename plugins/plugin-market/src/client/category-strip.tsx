/**
 * The market's category filter: one wrapping strip with a single sliding
 * highlight, shared by the plugin catalog and the skills catalog so the two
 * tabs filter the same way.
 *
 * Why not the kernel SegmentedControl: its indicator is arithmetic over ONE
 * row of equal tracks (`--dsh-segment-count` / `--dsh-segment-index`), so a
 * long label set overflows the panel and any flex override breaks the
 * geometry; splitting it into two controls leaves each row highlighting its
 * own first segment, which reads as two selections at once. Both were
 * measured in the running app. This component keeps that control's look and
 * motion (the same track fill, the same white indicator with `--dsw-elevation-soft`,
 * the same 160ms ease) over boxes measured from the live DOM, which is what
 * lets the strip wrap.
 *
 * @module @dsh-app/plugin-market/client/category-strip
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** One selectable category: a stable value plus its display text. */
interface CategoryStripItem {
  readonly key: string
  readonly label: string
}

/**
 * A wrapping row of category segments with one sliding highlight.
 * @param props.items - the choices, in display order.
 * @param props.value - the selected key; must be one of `items`.
 * @param props.onChange - the requested key.
 * @param props.label - the accessible name for the group.
 * @returns the strip.
 */
export function CategoryStrip({ items, value, onChange, label }: {
  items: readonly CategoryStripItem[]
  value: string
  onChange: (key: string) => void
  label: string
}): ReactNode {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLSpanElement | null>(null)
  // The FIRST placement is instant: the indicator starts with no size, so
  // animating to the measured box would read as an entrance effect every time
  // the tab mounts. Later placements slide, which is the point of the motion.
  const placed = useRef(false)

  // The highlight follows the selected label's measured box. Re-measured on a
  // selection change AND on resize: a re-wrap moves every box after the first
  // line, so a stale measurement would leave the highlight on the wrong row.
  //
  // The placement and the flag are written straight to the DOM rather than
  // through state, because suppressing the first transition needs the browser
  // to compute that placement while the transition is still off — a re-render
  // would put the flag and the position in the same commit with nothing
  // forcing the computation in between. The forced reflow below is what makes
  // it deterministic; a rAF or a timer would depend on the frame clock, and a
  // background window throttles those (measured: the flag then stayed on).
  useEffect(() => {
    const track = trackRef.current
    const indicator = indicatorRef.current
    if (track === null || indicator === null) return undefined
    const measure = (): void => {
      const active = track.querySelector<HTMLElement>('[data-active="true"]')
      if (active === null) return
      const box = active.getBoundingClientRect()
      const base = track.getBoundingClientRect()
      const first = !placed.current
      if (first) track.dataset.instant = 'true'
      indicator.style.setProperty('--dshMkt-catOnX', `${String(box.left - base.left)}px`)
      indicator.style.setProperty('--dshMkt-catOnY', `${String(box.top - base.top)}px`)
      indicator.style.setProperty('--dshMkt-catOnW', `${String(box.width)}px`)
      indicator.style.setProperty('--dshMkt-catOnH', `${String(box.height)}px`)
      if (!first) return
      placed.current = true
      // Compute this one placement with motion off, then re-enable it.
      void track.offsetWidth
      track.dataset.instant = 'false'
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => { observer.disconnect() }
  }, [value])

  return (
    <div className="dshMkt-catStrip" ref={trackRef} role="group" aria-label={label}>
      <span className="dshMkt-catIndicator" aria-hidden="true" ref={indicatorRef} />
      {items.map(item => {
        const active = item.key === value
        return (
          <button
            key={item.key === '' ? '@all' : item.key}
            type="button"
            aria-pressed={active}
            data-active={active ? 'true' : 'false'}
            className="dshMkt-catSegment"
            onClick={() => { if (!active) onChange(item.key) }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
