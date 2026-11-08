/**
 * The active theme's lightness, read off the page rather than guessed.
 *
 * The logo set carries plates for two kinds of mark — a near-black glyph needs a
 * light plate only on a dark panel, a near-white one the reverse — so the page
 * has to know which panel it is on. The theme is a token swap with no reliable
 * attribute of its own, so the one honest signal is the rendered text colour:
 * a light text colour means the dark theme. A theme switch that only rewrites
 * variables fires no DOM mutation, which is why a slow visibility-aware poll
 * backs up the attribute observer.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/use-color-scheme
 */

import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Read one computed colour channel, tolerant of `rgb()` and `color(srgb …)`. */
function luminanceOf(color: string): number | undefined {
  const parts = color.match(/-?\d*\.?\d+/gu)
  if (parts === null || parts.length < 3) return undefined
  const channels = parts.slice(0, 3).map(Number)
  const scale = Math.max(...channels) <= 1.0001 ? 255 : 1
  return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) * scale / 255
}

/**
 * Track whether the panel behind `ref` is dark.
 * @param ref - the page's root element (its computed text colour is the signal).
 * @returns `'dark'` or `'light'`.
 */
export function useColorScheme(ref: RefObject<HTMLElement | null>): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>('light')
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const read = (): void => {
      const node = ref.current
      if (node === null) return
      const luminance = luminanceOf(window.getComputedStyle(node).color || '')
      if (luminance === undefined) return
      const next = luminance > 0.5 ? 'dark' : 'light'
      setScheme(previous => (previous === next ? previous : next))
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-dsw-theme', 'data-scheme'],
    })
    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
    media?.addEventListener('change', read)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') read()
    }, 2000)
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', read)
      clearInterval(poll)
    }
  }, [ref])
  return scheme
}
