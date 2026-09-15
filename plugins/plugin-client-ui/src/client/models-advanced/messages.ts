/**
 * The message currency of the Advanced Models page.
 *
 * No layer below the components composes a sentence: the field validators,
 * the models.dev feed client and the wire helpers all return a
 * {@link PageMessage} — a key of this plugin's dictionary with its `{name}`
 * template params, or text another layer already localized (a host route
 * error, a browser transport message). The component renders it through
 * {@link messageText} with its `t` seat, so a language switch re-words every
 * message the page is holding, including a failure it is still showing.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/messages
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../namespace.ts'
import type { AdvancedModelsKey } from './locales.ts'

/** The page's namespace-bound translate seat (the type of the framework `t`). */
export type Translate = TranslateNS<typeof NS>

/** One message the page shows, resolved against the active locale at render. */
export type PageMessage =
  | { readonly source: 'key'; readonly key: AdvancedModelsKey; readonly params?: Record<string, string | number> }
  | { readonly source: 'text'; readonly text: string }

/** Build a dictionary-backed message. */
export function message(key: AdvancedModelsKey, params?: Record<string, string | number>): PageMessage {
  return params === undefined ? { source: 'key', key } : { source: 'key', key, params }
}

/** Wrap text a lower layer already localized (shown verbatim). */
export function wireText(text: string): PageMessage {
  return { source: 'text', text }
}

/**
 * Render a message in the active locale.
 * @param notice - the classified message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
export function messageText(notice: PageMessage, t: Translate): string {
  return notice.source === 'text' ? notice.text : t(notice.key, notice.params)
}
