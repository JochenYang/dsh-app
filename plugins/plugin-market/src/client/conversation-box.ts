/**
 * The conversation-anchored page box: the market panel covers the
 * conversation column exactly, the way a full-page view replaces the
 * workspace while the sidebar stays visible beside it.
 *
 * The anchor is the conversation root's own phase element — the kernel
 * renders `[data-phase]` (hero | active | settling) on the root of every
 * conversation view, hashed classes change under us, but the attribute is
 * stable. The box is read on open, on window resize, on capture-phase
 * scroll, and via ResizeObserver on the root itself; the panel subscribes
 * through {@link useConversationBox} and repositions between frames.
 *
 * @module @dsh-app/plugin-market/client/conversation-box
 */

import { useEffect, useState } from 'react'

/** The conversation area's viewport rectangle. */
export interface ConversationBox {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/** The conversation root element, or null outside the conversation view. */
export function conversationRoot(): Element | null {
  if (typeof document === 'undefined') return null
  return document.querySelector('[data-phase]')
}

/** The conversation area's box, or null when no conversation root exists. */
export function conversationBox(): ConversationBox | null {
  const el = conversationRoot()
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

/**
 * Track the conversation box while `active`. Re-renders the subscriber on
 * every geometry change (window resize, conversation resize, any scroll —
 * capture phase, because the scroll containers are nested inside the root)
 * and whenever the root itself leaves the document. Returns the live box,
 * or null whenever the conversation is not on screen.
 * @param active - whether the caller currently needs the box.
 * @returns the live box, or null.
 */
export function useConversationBox(active: boolean): ConversationBox | null {
  const [box, setBox] = useState<ConversationBox | null>(null)

  useEffect(() => {
    if (!active) {
      setBox(null)
      return
    }
    const update = (): void => { setBox(conversationBox()) }
    update()
    const root = conversationRoot()
    const observer = root !== null && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(update)
      : null
    if (root !== null && observer !== null) observer.observe(root)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    // The root can leave the document entirely (settings open over the
    // conversation); a document-wide childList observer re-runs update so the
    // subscriber sees box === null the moment the anchor is gone.
    const mutation = new MutationObserver(update)
    mutation.observe(document.documentElement, { childList: true, subtree: true })
    return () => {
      if (observer !== null) observer.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [active])

  return box
}
