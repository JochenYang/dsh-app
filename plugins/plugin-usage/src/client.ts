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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { UsageSection } from './client/usage-section.tsx'
import { en as usageEn, NS as USAGE_NS, zh as usageZh } from './client/locales.ts'
import type { UsageKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the usage page: cards, heatmap, trend chart, model table. */
    [USAGE_NS]: UsageKey
  }
}

/** The client halves this plugin depends on (`locale` provides the copy seat). */
export const inject = ['slots', 'locale']

/** Nav identity of the usage settings page (its label is the `usage.title` key). */
const SECTION_ID = 'dsh-app-usage'
const SECTION_TITLE = 'usage.title' satisfies UsageKey

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
 * re-opens while staying cheap when no settings nav exists. The label is read
 * through the thunk on every pass, so the tag follows a language switch.
 * @param label - the nav row's current label text.
 * @returns disposer removing the style, the observer, and the tags.
 */
function mountNavIconPatch(label: () => string): () => void {
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
    const text = label()
    for (const node of document.querySelectorAll('span[class*="navLabel"]')) {
      if (node.textContent !== text) continue
      const cell = node.closest('button')
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
  // --- Dictionaries first: the nav label and the page below resolve through
  // this namespace, and the effect disposes the pair with this plugin's
  // fiber. ---
  ctx.effect(
    () => ctx.locale.register(USAGE_NS, { zh: usageZh, en: usageEn }),
    'dsh-app plugin-usage: dictionaries',
  )
  // Nav rows are read per render and the settings shell keys its row cache on
  // the locale revision, so a thunk over this binding follows a language
  // switch without re-registration — the same contract as the `t` seat.
  const t = ctx.locale.bind(USAGE_NS)

  adoptStyles()
  ctx.effect(() => mountNavIconPatch(() => t(SECTION_TITLE)), 'dsh-app plugin-usage: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // After the Plugins page (15) — usage is a read-only report, not a
    // frequently touched settings surface.
    order: 16,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: USAGE_NS,
    label: () => t(SECTION_TITLE),
  }, UsageSection))
}
