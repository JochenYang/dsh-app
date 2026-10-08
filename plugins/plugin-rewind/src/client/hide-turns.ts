/**
 * The stylesheet that hides the turns a recall removed.
 *
 * The transcript deliberately renders the append-origin log, so a landed
 * replacement does NOT remove the old bubbles (compaction behaves the same way).
 * The host's `rewindAnchors` projection publishes which turns a recall already
 * cut, and this module turns that list into CSS: one `display:none` rule per
 * turn, keyed on the `data-chat-turn` attribute the chat flow wrapper puts on
 * every node. Turns are the right unit — a recall always cuts at a turn head,
 * so the whole turn goes away together and no half-turn is left behind.
 *
 * ## Why the element is process-wide, not component-owned
 *
 * The hook is called by the per-message wrapper, which is mounted once per user
 * bubble — so SEVERAL instances run at once. A component-owned element cannot
 * work here: React runs an effect's cleanup before the next effect, so the
 * second bubble's mount would blank the stylesheet the first had just written,
 * and unmounting any one bubble (a virtualized row scrolling away) would blank it
 * for the whole transcript.
 *
 * The element is therefore created once per document and only ever written, never
 * emptied — the rules are a pure function of the projected hidden-turn list, so
 * the last writer is always the right one. It is left in place for the document's
 * lifetime, which is what a stylesheet keyed on a stable id is for; `recall-note`
 * follows the same pattern for the same reason.
 *
 * @module @dsh-app/plugin-rewind/client/hide-turns
 */

import { useEffect, useMemo } from 'react'

/** Id of the stylesheet element that hides recalled turns. */
const HIDE_STYLE_ID = 'dsh-app-plugin-rewind-hide'

/**
 * Turn the hidden-turn list into CSS.
 *
 * @param turns - the turns the host reports as already cut.
 * @returns one rule per valid turn, newline-separated.
 */
export function hideCss(turns: readonly number[]): string {
  return turns
    .filter((turn) => Number.isSafeInteger(turn) && turn >= 0)
    .map((turn) => `[data-chat-turn="${turn}"]{display:none !important}`)
    .join('\n')
}

/**
 * Keep the hiding stylesheet in step with the hidden-turn list.
 *
 * This MUST be called by a component that is mounted whenever a session has any
 * user message. It was first written inside the composer-dock control; when that
 * control was removed the stylesheet went with it, and every recall then left
 * the recalled bubbles fully visible while the host reported success. A hook with
 * no guaranteed mount point is a hook that silently stops running.
 *
 * @param turns - the turns the host reports as already cut.
 */
export function useHiddenTurns(turns: readonly number[] | undefined): void {
  const css = useMemo(() => hideCss(turns ?? []), [turns])
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let el = document.querySelector<HTMLStyleElement>(`style[data-plugin-css=${JSON.stringify(HIDE_STYLE_ID)}]`)
    if (el === null) {
      el = document.createElement('style')
      el.dataset.plugin = '@dsh-app/plugin-rewind'
      el.dataset.pluginCss = HIDE_STYLE_ID
      document.head.appendChild(el)
    }
    el.textContent = css
    // No cleanup on purpose: see the module header. Emptying here would let one
    // bubble's unmount un-hide every recalled turn.
    return undefined
  }, [css])
}
