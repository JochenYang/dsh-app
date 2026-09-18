/**
 * The market's busy indicator: a ring with a gap, drawn as an SVG arc.
 *
 * Why an arc and not a bordered box: the CSS shorthand this replaced
 * (`border: 2px solid currentColor; border-top-color: transparent`) can only
 * make a gap of a whole border side — a quarter of the ring — and the corner
 * miter makes the arc ends wedge-shaped. At the 12-16 px an inline button
 * spinner lives at, that reads as a letter "C" rather than a ring. A stroked
 * circle with round caps keeps the ends tapered and the gap proportional at any
 * size, which is the shape the rest of the world uses for "working".
 *
 * The ring is 12 px — the label's own size — so it sits in a 12 px button line
 * without growing it; `currentColor` keeps it the button's own colour (the red
 * of an uninstall is the button's, not the spinner's choice).
 */
import type { ReactNode } from 'react'

/** Circumference of the `r=9` circle in the 24-unit viewBox: 2πr. */
const CIRCUMFERENCE = 56.55

/** Fraction of the ring that is drawn; the rest is the gap. */
const ARC = 0.75

/**
 * Render the busy ring.
 * @returns the animated `<svg>`; `aria-hidden` — the label beside it carries the state.
 */
export function Spinner(): ReactNode {
  return (
    <svg className="dshMkt-spinner" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${String(CIRCUMFERENCE * ARC)} ${String(CIRCUMFERENCE)}`}
      />
    </svg>
  )
}
