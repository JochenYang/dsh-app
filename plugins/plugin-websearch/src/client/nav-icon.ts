/**
 * Settings-nav icon patch for the web search section.
 *
 * The settings shell maps unknown section ids to a generic gear icon, and the
 * nav has no per-id DOM hook (CSS-module class names are stable in name only)
 * — so the cell is found by its label text (the same stable-copy contract the
 * shell itself renders) and tagged with a plain class a style rule targets.
 * Same mechanism as plugin-mcp's and plugin-client-ui's nav icons.
 *
 * The glyph is a magnifying glass: the section is about searching the web,
 * and a lens reads cleanly at the nav's 16px grid (circle plus a short
 * handle — stroke style matched to the shell's icon set: 1.4 stroke on the 16
 * grid, round caps/joins, ~84% grid fill).
 *
 * @module @dsh-app/plugin-websearch/client/nav-icon
 */

/** 16-grid stroke icon, painted via CSS mask over currentColor. */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<circle cx="6.9" cy="6.9" r="4.3"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M10.2 10.2 13.5 13.5"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

/** Class tagged onto the nav cell this patch owns. */
const NAV_CELL_CLASS = 'dshWsNav'

/** The section label this plugin registers (client.ts). */
const NAV_LABEL = '网络搜索'

/**
 * Tag the web search nav cell and paint the lens glyph. Cheap gate first:
 * without a settings nav in the DOM there is nothing to tag, and chat-view
 * mutations must not pay for a label scan.
 * @returns disposer removing the style, the observer, and the tag.
 */
export function mountNavIconPatch(): () => void {
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
      if (label.textContent !== NAV_LABEL) continue
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
