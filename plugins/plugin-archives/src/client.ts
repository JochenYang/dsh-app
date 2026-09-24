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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ArchivesSection } from './client/archives-section.tsx'
import { en as archivesEn, NS as ARCHIVES_NS, zh as archivesZh } from './client/locales.ts'
import type { ArchivesKey } from './client/locales.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the archive manager page: groups, search, confirm banner. */
    [ARCHIVES_NS]: ArchivesKey
  }
}

/** The client halves this plugin depends on (`locale` provides the copy seat). */
export const inject = ['slots', 'locale']

/** Nav identity of the archive manager settings page (its label is the `archives.title` key). */
const SECTION_ID = 'dsh-app-archives'
const SECTION_TITLE = 'archives.title' satisfies ArchivesKey

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
 * modal re-opens while staying cheap when no settings nav exists. The label
 * is read through the thunk on every pass, so the tag follows a language
 * switch.
 * @param label - the nav row's current label text.
 * @returns disposer removing the style, the observer, and the tags.
 */
function mountNavIconPatch(label: () => string): () => void {
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
    const text = label()
    for (const node of document.querySelectorAll('span[class*="navLabel"]')) {
      if (node.textContent !== text) continue
      const cell = node.closest('button')
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
  // --- Dictionaries first: the nav label and the page below resolve through
  // this namespace, and the effect disposes the pair with this plugin's
  // fiber. ---
  ctx.effect(
    () => ctx.locale.register(ARCHIVES_NS, { zh: archivesZh, en: archivesEn }),
    'dsh-app plugin-archives: dictionaries',
  )
  // Nav rows are read per render and the settings shell keys its row cache on
  // the locale revision, so a thunk over this binding follows a language
  // switch without re-registration — the same contract as the `t` seat.
  const t = ctx.locale.bind(ARCHIVES_NS)

  adoptStyles()
  ctx.effect(() => mountNavIconPatch(() => t(SECTION_TITLE)), 'dsh-app plugin-archives: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 23 = immediately before the suite's upkeep row (维护设置, 24) and two
    // below upstream's "archived sessions" (pinned at 25): session memory is at
    // 22 right above this page, and the two are the same story (this one prunes,
    // memory keeps). See the order table in docs/desktop-optimization-plan.md.
    order: 23,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: ARCHIVES_NS,
    label: () => t(SECTION_TITLE),
  }, ArchivesSection))
}
