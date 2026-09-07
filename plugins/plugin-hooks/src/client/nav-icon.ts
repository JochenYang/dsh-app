/**
 * Settings-nav icon patch for the Hooks section — a hook glyph (eye + shank +
 * J-bend + barb), same mechanism as plugin-mcp's plug icon: find the nav cell
 * by label text, tag it, paint via CSS mask over currentColor.
 * @module @dsh-app/plugin-hooks/client/nav-icon
 */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M10.2 2.4a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0',
  'M9.3 3.3v6.5',
  'M9.3 9.8a3.2 3.2 0 0 1-6.4 0v-1.4"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')
const NAV_CELL_CLASS = 'dshHkNav'
const NAV_LABEL = 'Hooks'
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
      label.closest('button')?.classList.add(NAV_CELL_CLASS)
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect(); style.remove(); document.querySelectorAll(`button.${NAV_CELL_CLASS}`).forEach(c => c.classList.remove(NAV_CELL_CLASS)) }
}
