/**
 * DSH APP usage statistics — client half.
 *
 * Registers the settings-page section ("用量统计"). Third-party usage
 * plugins coexist by design (each renders its own page over its own data —
 * see the host half's header), so this half always registers. A user who
 * prefers their own plugin disables this one through the user config file
 * (`<storeDir>/config.json`, `enabled: false`), and the section then shows
 * the disabled notice from the host's /status signal instead of data.
 *
 * @module @dsh-app/plugin-usage/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section')
// and the slot utility prop faces into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { UsageSection } from './client/usage-section.tsx'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the usage settings page. */
const SECTION_ID = 'dsh-app-usage'
const SECTION_LABEL = '用量统计'

/**
 * A three-bar glyph for the settings nav (the shell maps unknown section ids
 * to its generic gear; this overlay swaps ours in by label match). Drawn on
 * the same 16-grid with the shell's outline language — 1.4 stroke, round
 * caps/joins — so it sits at native size and weight next to Models/Plugins.
 * Rendered as a CSS mask over currentColor so it follows the nav's active
 * state.
 */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M2.2 13.8h11.6M4.8 13.8V8.6M8 13.8V5.6M11.2 13.8V2.2"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

/**
 * Tag the usage nav cell and paint the bar glyph. The nav has no per-id DOM
 * hook (CSS-module class names are stable in name only), so the label text
 * is the reliable selector: MutationObserver keeps the tag on across modal
 * re-opens while staying cheap when no settings nav exists.
 * @returns disposer removing the style, the observer, and the tags.
 */
function mountNavIconPatch(): () => void {
  const style = document.createElement('style')
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON_SVG)}")`
  style.textContent = [
    'button.dshauNav > svg:first-child { display: none; }',
    'button.dshauNav::before {',
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
      if (cell !== null) cell.classList.add('dshauNav')
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll('button.dshauNav')) {
      cell.classList.remove('dshauNav')
    }
  }
}

/**
 * Client apply: adopt styles and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'plugin-usage: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // After the Plugins page (15) — usage is a read-only report, not a
    // frequently touched settings surface.
    order: 16,
    label: () => SECTION_LABEL,
  }, UsageSection))
}
