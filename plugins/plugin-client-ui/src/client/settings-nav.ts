/**
 * Settings nav rail: one injected stylesheet for the two things the suite made
 * necessary there.
 *
 * 1. **The rail has to scroll.** Upstream sizes it for its own five sections
 *    and makes only the content column scrollable; the suite adds ten more
 *    rows, and the nav list has no overflow of its own. Measured in a real
 *    window: at 1280x620 the last four rows sit below the panel's bottom edge,
 *    clipped by its `overflow: hidden`, and the list cannot scroll
 *    (`overflow-y: visible`, `scrollHeight === clientHeight`) — unreachable
 *    rather than merely off-screen. `min-height: 0` is what lets the flex child
 *    shrink below its content so `overflow-y: auto` has something to do.
 * 2. **Two of our rows want a real glyph.** Upstream maps a few section ids to
 *    icons and falls back to a generic gear for everything else, so Advanced
 *    Models and Diagnostics would both wear that same gear.
 *
 * Rows carry no per-id DOM hook — the section id is not rendered and the
 * CSS-module class names are stable in name only — so a row is found by its
 * label text, read through the live locale binding: a language switch rewrites
 * the label in place, and re-running the match is what keeps the tag honest.
 *
 * @module @dsh-app/plugin-client-ui/client/settings-nav
 */

/** One nav row this plugin paints. */
export interface NavGlyph {
  /** Reads the row label of the active locale. */
  readonly label: () => string
  /** Plain class painted onto the matching row (the style rule targets it). */
  readonly cls: string
  /** 16-grid outline glyph, drawn as a CSS mask over `currentColor`. */
  readonly svg: string
}

/** The list that must scroll; scoped to the nav so no other list is touched. */
const SCROLL_RULE = 'nav [class*="navList"] { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 22px; }'

/** Mask declarations shared by every glyph. */
const glyphRules = (glyph: NavGlyph): string[] => {
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(glyph.svg)}")`
  return [
    `button.${glyph.cls} > svg:first-child { display: none; }`,
    `button.${glyph.cls}::before {`,
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ]
}

/**
 * Install the rail stylesheet and keep the glyph tags in sync.
 *
 * @param glyphs - the rows to paint, matched by their label of the moment.
 * @returns the disposer (observer, style rule, tags).
 */
export function mountSettingsNav(glyphs: readonly NavGlyph[]): () => void {
  const style = document.createElement('style')
  style.textContent = [SCROLL_RULE, ...glyphs.flatMap(glyphRules)].join('\n')
  document.head.append(style)

  const patch = (): void => {
    // Cheap gate first: without a settings nav in the DOM there is nothing to
    // tag, and chat-view mutations must not pay for a label scan.
    if (document.querySelector('[class*="navList"]') === null) return
    for (const glyph of glyphs) {
      const wanted = glyph.label()
      // Re-check the rows already tagged: a language switch rewrites the label
      // in place (characterData), so a stale tag has to come off.
      for (const cell of document.querySelectorAll(`button.${glyph.cls}`)) {
        if (cell.querySelector('span[class*="navLabel"]')?.textContent !== wanted) {
          cell.classList.remove(glyph.cls)
        }
      }
      for (const span of document.querySelectorAll('span[class*="navLabel"]')) {
        if (span.textContent !== wanted) continue
        span.closest('button')?.classList.add(glyph.cls)
      }
    }
  }
  patch()

  const observer = new MutationObserver(patch)
  // characterData is part of the observation because React rewrites a lone
  // text child in place, which emits no childList record.
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    observer.disconnect()
    style.remove()
    for (const glyph of glyphs) {
      for (const cell of document.querySelectorAll(`button.${glyph.cls}`)) {
        cell.classList.remove(glyph.cls)
      }
    }
  }
}
