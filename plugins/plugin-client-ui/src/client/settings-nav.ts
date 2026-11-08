/**
 * Settings nav rail: one injected stylesheet, for the one thing the suite still
 * needs there.
 *
 * **Two of our rows want a real glyph.** Upstream maps a few section ids to
 * icons and falls back to a generic gear for everything else, so the provider
 * manager (供应商管理) and 维护 (the merged upkeep section) would both wear that
 * same gear.
 *
 * The rail's own scrolling is NOT ours any more. It used to be: upstream sized
 * the rail for its own five sections and made only the content column
 * scrollable, so with ten more rows the last ones sat below the panel's clipped
 * bottom edge and could not be reached (`overflow-y: visible`,
 * `scrollHeight === clientHeight`). The stylesheet this module prepended —
 * `min-height: 0; overflow-y: auto` plus a bottom pad — is now gone, because
 * upstream's own `.navList` carries `overflow-y: auto` (`SettingsRoot.module.css`,
 * 0.1.7): a second answer for the same element would only fight the first.
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

/** Mask declarations shared by every glyph. */
const glyphRules = (glyph: NavGlyph): string[] => {
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(glyph.svg)}")`
  return [
    // The shell's glyph sits in a `.navIcon` cell whose class carries a build
    // hash, as of 0.2.2-rc.1; without this rule the default gear shows beside
    // our painted glyph. The bare `svg` half covers a row with no such wrapper.
    `button.${glyph.cls} [class*="navIcon"], button.${glyph.cls} svg { display: none; }`,
    `button.${glyph.cls}::before {`,
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ]
}

/**
 * Open every settings page at its top.
 *
 * The shell keeps ONE scroller for whatever section the rail points at, so a
 * newly selected page inherits the previous page's scroll offset — a tall page
 * (or the one just left) can leave the next one showing its bottom half. Rows are
 * matched the same way the glyphs are (a button inside the nav list, no per-id
 * hook), and the pane is reset one frame later, after React has mounted it.
 *
 * Only the pane is touched: the nav list itself keeps its own scroll so the row
 * the user just clicked stays where their pointer is.
 *
 * @returns the disposer (click listener).
 */
export function resetSettingsPaneOnNav(): () => void {
  const frames = new Set<number>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const reset = (dialog: Element): void => {
    for (const node of dialog.querySelectorAll<HTMLElement>('*')) {
      // Skip the nav column and every wrapper that contains it (the dialog root),
      // so only the settings CONTENT scroller is moved.
      if (node.closest('[class*="navList"]') !== null) continue
      if (node.querySelector('[class*="navList"]') !== null) continue
      if (!/(auto|scroll)/u.test(getComputedStyle(node).overflowY)) continue
      if (node.scrollHeight <= node.clientHeight) continue
      node.scrollTop = 0
    }
  }
  const onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    const nav = target === null ? null : target.closest('[class*="navList"]')
    if (target === null || nav === null) return
    // The dialog that OWNS this rail, not whichever dialog happens to come
    // first in the document (a settings dialog can sit under another one).
    const dialog = nav.closest('[role="dialog"]')
    if (dialog === null) return
    // One frame for React to mount the new pane, then a second read for a
    // layout that finished after that frame (a lazy list, a font swap). Both
    // are tracked so unmounting cancels them instead of leaking a later scroll.
    const frame = requestAnimationFrame(() => {
      frames.delete(frame)
      reset(dialog)
      const timer = setTimeout(() => {
        timers.delete(timer)
        reset(dialog)
      }, 80)
      timers.add(timer)
    })
    frames.add(frame)
  }
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('click', onClick, true)
    for (const frame of frames) cancelAnimationFrame(frame)
    for (const timer of timers) clearTimeout(timer)
    frames.clear()
    timers.clear()
  }
}

/**
 * Install the glyph stylesheet and keep the glyph tags in sync.
 *
 * @param glyphs - the rows to paint, matched by their label of the moment.
 * @returns the disposer (observer, style rule, tags).
 */
export function mountSettingsNav(glyphs: readonly NavGlyph[]): () => void {
  const style = document.createElement('style')
  style.textContent = glyphs.flatMap(glyphRules).join('\n')
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

  // Coalesced to one pass per frame. The observer sees `characterData` too (React
  // rewrites a label in place on a language switch), so a streaming answer fired it
  // once per character — and each `patch()` runs a `querySelector` plus two
  // `querySelectorAll` sweeps over the whole document.
  let frame = 0
  const schedule = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      patch()
    })
  }
  const observer = new MutationObserver(schedule)
  // characterData is part of the observation because React rewrites a lone
  // text child in place, which emits no childList record.
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame)
    observer.disconnect()
    style.remove()
    for (const glyph of glyphs) {
      for (const cell of document.querySelectorAll(`button.${glyph.cls}`)) {
        cell.classList.remove(glyph.cls)
      }
    }
  }
}
