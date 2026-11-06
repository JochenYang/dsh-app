/**
 * Settings-nav icon patch for the usage section.
 *
 * The settings shell uses a gear for section ids it does not know. Usage is a
 * plugin-owned row, so it paints its own activity glyph by matching the row's
 * localized label, following the pattern used by the other suite plugins.
 *
 * @module @dsh-app/plugin-usage/client/nav-icon
 */

/** 16-grid activity-bars glyph, painted as a CSS mask over currentColor. */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M2.2 13.5h11.6M4.2 11V8.1M8 11V5.2m3.8 5.8V2.5"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

const NAV_CELL_CLASS = 'dshUsageNav'

/**
 * Paint the custom glyph and track settings-nav rerenders and locale changes.
 * @param label - the current localized section label.
 * @returns disposer for the observer, style, and row class.
 */
export function mountUsageNavIcon(label: () => string): () => void {
  const style = document.createElement('style')
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON_SVG)}")`
  style.textContent = [
    `button.${NAV_CELL_CLASS} [class*="navIcon"], button.${NAV_CELL_CLASS} svg { display: none; }`,
    `button.${NAV_CELL_CLASS}::before {`,
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ].join('\n')
  document.head.append(style)

  const patch = (): void => {
    if (document.querySelector('[class*="navList"]') === null) return
    const wanted = label()
    for (const cell of document.querySelectorAll(`button.${NAV_CELL_CLASS}`)) {
      if (cell.querySelector('span[class*="navLabel"]')?.textContent !== wanted) {
        cell.classList.remove(NAV_CELL_CLASS)
      }
    }
    for (const span of document.querySelectorAll('span[class*="navLabel"]')) {
      if (span.textContent === wanted) span.closest('button')?.classList.add(NAV_CELL_CLASS)
    }
  }
  patch()

  let frame = 0
  const schedule = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      patch()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame)
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll(`button.${NAV_CELL_CLASS}`)) {
      cell.classList.remove(NAV_CELL_CLASS)
    }
  }
}
