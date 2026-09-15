/**
 * Settings-nav icon patch for the swarm section ("并行子代理").
 *
 * The settings shell maps unknown section ids to a generic gear icon, and the
 * nav has no per-id DOM hook — so the cell is found by its label text (the
 * same stable-copy contract the shell itself renders) and tagged with a plain
 * class a style rule targets. Same mechanism as plugin-websearch's and
 * plugin-memory's nav icons; the label string is the contract, keep it in
 * sync with SECTION_LABEL in client.ts.
 *
 * The glyph is a hub-and-spoke trio — one orchestrator node linked to three
 * worker nodes, the shape of what the section tunes — drawn to the shell's
 * icon conventions: 1.4 stroke on the 16 grid, round caps/joins, ~80% grid
 * fill.
 *
 * @module @dsh-app/plugin-swarm/client/nav-icon
 */

/** 16-grid stroke icon, painted via CSS mask over currentColor. */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M8 8 3.6 3.6M8 8l4.4-4.4M8 8v4.8"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>',
  '<circle cx="8" cy="8" r="2.2" fill="none" stroke="#000" stroke-width="1.4"/>',
  '<circle cx="3.4" cy="3.4" r="1.7" fill="none" stroke="#000" stroke-width="1.4"/>',
  '<circle cx="12.6" cy="3.4" r="1.7" fill="none" stroke="#000" stroke-width="1.4"/>',
  '<circle cx="8" cy="12.6" r="1.7" fill="none" stroke="#000" stroke-width="1.4"/>',
  '</svg>',
].join('')

/** Class tagged onto the nav cell this patch owns. */
const NAV_CELL_CLASS = 'dshSwarmNav'

/** The section label this plugin registers (client.ts SECTION_LABEL). */
const NAV_LABEL = '并行子代理'

/**
 * Tag the swarm nav cell and paint the hub glyph. Cheap gate first: without a
 * settings nav in the DOM there is nothing to tag, and chat-view mutations
 * must not pay for a label scan.
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
