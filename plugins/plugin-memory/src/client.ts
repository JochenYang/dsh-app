/**
 * DSH APP cross-session memory — client half.
 *
 * Registers the settings-page section ("会话记忆"): enable toggle, stats,
 * file path, and the confirmed clear action. See the host half's header
 * for the full feature contract.
 *
 * @module @dsh-app/plugin-memory/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MemorySection } from './client/memory-section.tsx'
import { adoptStyles } from './client/styles.ts'

/** The client halves this plugin depends on. */
export const inject = ['slots']

/** Nav identity of the memory settings page. */
const SECTION_ID = 'dsh-app-memory'
const SECTION_LABEL = '会话记忆'

/**
 * A brain glyph for the settings nav (the shell maps unknown section ids
 * to its generic gear; this overlay swaps ours in by label match). Same
 * 16-grid outline language as the shell — 1.4 stroke, round caps — so it
 * sits at native size and weight next to Models/Plugins.
 */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M8 2.3c-1.3 0-2.4.8-2.8 1.9C4 4.5 3.1 5.5 3.1 6.8c0 .7.3 1.4.7 1.9-.4.5-.7 1.1-.7 1.8 0 1.3.9 2.4 2.1 2.6.4 1.2 1.5 2 2.8 2s2.4-.8 2.8-2c1.2-.2 2.1-1.3 2.1-2.6 0-.7-.3-1.3-.7-1.8.4-.5.7-1.2.7-1.9 0-1.3-.9-2.3-2.1-2.6C10.4 3.1 9.3 2.3 8 2.3z"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M8 2.3v12.9"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>',
  '</svg>',
].join('')

/**
 * Tag the memory nav cell and paint the brain glyph. Label-text
 * selector + MutationObserver, same pattern as the archives/usage icons.
 * @returns disposer removing the style, the observer, and the tags.
 */
function mountNavIconPatch(): () => void {
  const style = document.createElement('style')
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON_SVG)}")`
  style.textContent = [
    'button.dshmNav > svg:first-child { display: none; }',
    'button.dshmNav::before {',
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ].join('\n')
  document.head.append(style)
  const patch = (): void => {
    if (document.querySelector('[class*="navList"]') === null) return
    for (const label of document.querySelectorAll('span[class*="navLabel"]')) {
      if (label.textContent !== SECTION_LABEL) continue
      const cell = label.closest('button')
      if (cell !== null) cell.classList.add('dshmNav')
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll('button.dshmNav')) {
      cell.classList.remove('dshmNav')
    }
  }
}

/**
 * Client apply: adopt styles and register the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'plugin-memory: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // After the archives page (17) — a maintenance surface, read-mostly.
    order: 18,
    label: () => SECTION_LABEL,
  }, MemorySection))
}
