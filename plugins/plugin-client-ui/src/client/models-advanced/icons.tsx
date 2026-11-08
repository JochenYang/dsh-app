/**
 * The page's own glyphs, on one 16px grid with one stroke weight.
 *
 * Only the marks the kernel's primitives do not carry: a disclosure chevron, the
 * list-row chevron, refresh, plus, pencil and trash. Everything else (buttons,
 * selects, checkboxes, tags, the modal frame) is a primitive.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/icons
 */

import type { ReactNode } from 'react'

/** Back arrow. */
export function IconArrowLeft(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A ring with a gap, shown while work is in flight. */
export function IconSpinner(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="dshAma-spin">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" opacity=".22" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** Pin, for a provider kept at the top of the list. */
export function IconPin({ filled = false }: { readonly filled?: boolean }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.2 2.2h3.6l-.5 3 2 2v1H4.7v-1l2-2-.5-3ZM8 8.2V14"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round"
      />
    </svg>
  )
}

/** Power plug, for the connectivity test. */
export function IconPlug(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.2 2v3.1M9.8 2v3.1M4.6 5.1h6.8v1.6a3.4 3.4 0 0 1-6.8 0V5.1ZM8 10.1V14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Ellipsis, for a secondary-actions trigger. */
export function IconMore(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.4" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.6" cy="8" r="1.1" />
    </svg>
  )
}


/** Info circle, for an empty state. */
export function IconInfo(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.2v3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r=".8" fill="currentColor" />
    </svg>
  )
}

/** Check mark, for a selected chip. */
export function IconCheck(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A disclosure chevron: points right when closed, down when open. */
export function IconChevron({ open }: { readonly open: boolean }): ReactNode {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The list row's chevron. */
export function IconChevronRight(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Refresh: a circular arrow. */
export function IconRefresh(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.9-3.9M13 2.5V5h-2.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** Plus. */
export function IconPlus(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Pencil. */
export function IconPencil(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.4 2.9a1.3 1.3 0 0 1 1.8 0l.9.9a1.3 1.3 0 0 1 0 1.8l-6.4 6.4-2.9.8.8-2.9 5.8-6.9Z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
    </svg>
  )
}

/** Trash. */
export function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}
