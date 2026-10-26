/**
 * Settings-nav icon patch for the code graph section.
 *
 * The settings shell maps a few section ids to icons and falls back to a
 * generic gear for everything else, and the nav carries no per-id DOM hook
 * (the section id is not rendered, and the CSS-module class names are stable in
 * name only) — so the cell is found by its label text and tagged with a plain
 * class a style rule targets. Same mechanism as `plugin-client-ui`'s Advanced
 * Models row and the MCP / Hooks / Swarm / Web-search / Memory / Archives rows.
 *
 * The label is read through a provider because the section's copy is localized:
 * the caller passes the namespace-bound translate, so the match follows the
 * active language, and the observer watches text updates too — a language
 * switch rewrites the label node in place.
 *
 * The glyph is the same three-node graph the sidebar panel row already draws
 * (`CodegraphPanelIcon`): one shape for one concept, and it reads at the nav's
 * 16px grid. Stroke weight and caps follow the shell's own icon set.
 *
 * @module @dsh-app/plugin-codegraph/client/nav-icon
 */

/** 16-grid stroke icon, painted via CSS mask over currentColor. */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<circle cx="4" cy="4" r="1.6"/>',
  '<circle cx="12" cy="5" r="1.6"/>',
  '<circle cx="8" cy="12" r="1.6"/>',
  '<path d="M5.4 4.3 10.4 4.8M4.7 5.5 7.4 10.6M11.3 6.4 8.7 10.6"/>',
  '</svg>',
].join('')

/** Class tagged onto the nav cell this patch owns. */
const NAV_CELL_CLASS = 'dshCgNav'

/**
 * Tag the code graph nav cell and paint the graph glyph.
 *
 * Cheap gate first: without a settings nav in the DOM there is nothing to tag,
 * and chat-view mutations must not pay for a label scan.
 *
 * @param labels - the section label as currently rendered (read per pass, so
 * the match follows a language switch).
 * @returns disposer removing the style, the observer, and the tag.
 */
export function mountNavIconPatch(labels: () => readonly string[]): () => void {
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
    const wanted = new Set(labels())
    for (const label of document.querySelectorAll('span[class*="navLabel"]')) {
      const text = label.textContent
      if (text === null || !wanted.has(text)) continue
      const cell = label.closest('button')
      if (cell !== null) cell.classList.add(NAV_CELL_CLASS)
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll(`button.${NAV_CELL_CLASS}`)) {
      cell.classList.remove(NAV_CELL_CLASS)
    }
  }
}
