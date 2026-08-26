/**
 * DSH APP session archive manager — client half.
 *
 * Registers the settings-page section ("会话归档"): archived sessions grouped
 * by project, with per-session and per-project irreversible deletion. All
 * data comes from the host half's routes; every deletion is confirmed in-UI
 * and re-fenced server-side (see the host half's header).
 *
 * @module @dsh-app/plugin-archives/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section')
// and the slot utility prop faces into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ArchivesSection } from './client/archives-section.tsx'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the archive manager settings page. */
const SECTION_ID = 'dsh-app-archives'
const SECTION_LABEL = '会话归档'

/**
 * An archive-box glyph for the settings nav (the shell maps unknown section
 * ids to its generic gear; this overlay swaps ours in by label match). Drawn
 * on the same 16-grid with the shell's outline language — 1.4 stroke, round
 * caps/joins — so it sits at native size and weight next to Models/Plugins.
 * Rendered as a CSS mask over currentColor so it follows the nav's active
 * state.
 */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M2.2 3h11.6v2.6H2.2zM3.4 5.6v6.4a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V5.6M6.6 8.9h2.8"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

/**
 * Tag the archives nav cell and paint the box glyph. The nav has no per-id
 * DOM hook (CSS-module class names are stable in name only), so the label
 * text is the reliable selector: MutationObserver keeps the tag on across
 * modal re-opens while staying cheap when no settings nav exists.
 * @returns disposer removing the style, the observer, and the tags.
 */
function mountNavIconPatch(): () => void {
  const style = document.createElement('style')
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON_SVG)}")`
  style.textContent = [
    'button.dsharNav > svg:first-child { display: none; }',
    'button.dsharNav::before {',
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ].join('\n')
  document.head.append(style)
  const patch = (): void => {
    // Cheap gate first: without a settings nav in the DOM there is nothing
    // to tag, and chat-view mutations must not pay for a label scan.
    if (document.querySelector('[class*="navList"]') === null) return
    for (const label of document.querySelectorAll('span[class*="navLabel"]')) {
      if (label.textContent !== SECTION_LABEL) continue
      const cell = label.closest('button')
      if (cell !== null) cell.classList.add('dsharNav')
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll('button.dsharNav')) {
      cell.classList.remove('dsharNav')
    }
  }
}

/**
 * Client apply: adopt styles and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'plugin-archives: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // After the usage page (16) — a maintenance surface, read-mostly.
    order: 17,
    label: () => SECTION_LABEL,
  }, ArchivesSection))
}
