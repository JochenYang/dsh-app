/**
 * Settings-nav icon patch for the preset-packages section.
 *
 * The settings shell maps unknown section ids to a generic gear icon, and
 * the section slot contract carries only id/order/label — no icon option —
 * so the nav cell is found by its label text (the same stable-copy contract
 * the shell itself renders) and tagged with a plain class a style rule
 * targets, exactly the seam the MCP section's nav icon uses. When the
 * contract grows an icon field, this patch retires in favor of it.
 *
 * The glyph is a three-track slider: a preset package is a set of
 * adjustments the user tunes once and reuses, and staggered knobs read
 * cleanly at the nav's 16px cell while staying in the shell's linear stroke
 * language (24 grid, 1.7 stroke, round caps/joins).
 *
 * @module @dsh-app/plugin-presets/client/nav-icon
 */

/** 24-grid stroke icon, painted via CSS mask over currentColor. */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
  '<path d="M4 6.5h3.4M11.6 6.5H20M4 12h8.9M17.1 12H20M4 17.5h1.9M10.1 17.5H20" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  '<circle cx="9.5" cy="6.5" r="2.1" fill="none" stroke="#000" stroke-width="1.7"/>',
  '<circle cx="15" cy="12" r="2.1" fill="none" stroke="#000" stroke-width="1.7"/>',
  '<circle cx="8" cy="17.5" r="2.1" fill="none" stroke="#000" stroke-width="1.7"/>',
  '</svg>',
].join('')

/** Class tagged onto the nav cell this patch owns. */
const NAV_CELL_CLASS = 'dshPresetsNav'

/**
 * Tag the preset-packages nav cell and paint the sliders glyph. The label is
 * read through the caller's thunk, so the match follows the active locale: the
 * section's own label is a dictionary key (`presets.nav`, see client.ts) and
 * the shell re-renders the row on a language switch. Cheap gate first:
 * without a settings nav in the DOM there is nothing to tag, and chat-view
 * mutations must not pay for a label scan.
 * @param labelOf - current label of the section this patch tags.
 * @returns disposer removing the style, the observer, and the tag.
 */
export function mountNavIconPatch(labelOf: () => string): () => void {
  const style = document.createElement('style')
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON_SVG)}")`
  style.textContent = [
    `button.${NAV_CELL_CLASS} > svg:first-child { display: none; }`,
    `button.${NAV_CELL_CLASS}::before {`,
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ].join('\n')
  document.head.append(style)

  const patch = (): void => {
    if (document.querySelector('[class*="navList"]') === null) return
    for (const label of document.querySelectorAll('span[class*="navLabel"]')) {
      if (label.textContent !== labelOf()) continue
      const cell = label.closest('button')
      if (cell !== null) cell.classList.add(NAV_CELL_CLASS)
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll(`button.${NAV_CELL_CLASS}`)) {
      cell.classList.remove(NAV_CELL_CLASS)
    }
  }
}
