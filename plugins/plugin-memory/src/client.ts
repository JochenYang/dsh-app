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
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MemorySection } from './client/memory-section.tsx'
import { en, NS, zh } from './client/locales.ts'
import type { MemoryKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory settings-page copy. */
    [NS]: MemoryKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Nav identity of the memory settings page. */
const SECTION_ID = 'dsh-app-memory'

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
 * @param labelOf - the section label for the active locale, read at patch
 * time so a language switch re-tags the cell instead of losing it.
 * @returns disposer removing the style, the observer, and the tags.
 */
function mountNavIconPatch(labelOf: () => string): () => void {
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
    const label = labelOf()
    for (const span of document.querySelectorAll('span[class*="navLabel"]')) {
      if (span.textContent !== label) continue
      const cell = span.closest('button')
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
 * Client apply: adopt styles, register the section dictionaries, and register
 * the settings section.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-memory: dictionaries')
  // Read per render, so the nav row follows a language switch without
  // re-registration — the same contract as the component's `t` seat.
  const t = ctx.locale.bind(NS)
  // The nav-icon patch finds its cell by label text, so it must read the
  // label at patch time rather than capture one language's copy.
  ctx.effect(() => mountNavIconPatch(() => t('memory.nav')), 'plugin-memory: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 22 = the head of the session-data block: this page and the archive page
    // are the session-data surfaces, and upstream's "archived sessions" is
    // pinned at 25 — so the pair reads in order (memory → archives) and the
    // suite's upkeep row (维护设置, 24) closes the block rather than splitting
    // it. Usage owns 21; the agent pages 19-20. See the order table in
    // docs/desktop-optimization-plan.md.
    order: 22,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: NS,
    label: () => t('memory.nav'),
  }, MemorySection))
}
