/**
 * The recall note, rendered through the host's own `Toast`.
 *
 * `showRecallNote` is imperative — it is called from a promise handler, not from
 * render — so the message is pushed into a tiny store and this component renders
 * the `Toast` for it. A React tree is required because `Toast` is a component and
 * owns its own hold timer; a bare DOM node could not drive that.
 *
 * The store is module-level and single-slot on purpose: two recall outcomes are
 * never worth showing at once, and the newer one is always the relevant one. Each
 * note carries a `seq` so the `Toast` remounts for a repeat of the same sentence
 * (a `key` on the text alone would not re-trigger the timer).
 *
 * @module @dsh-app/plugin-rewind/client/recall-note-host
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { NOTE_HOLD_MS, noteAnchor, type RecallNote } from './recall-note.ts'

/** The note currently on screen, with the sequence that makes it re-mount. */
interface ShownNote extends RecallNote {
  readonly seq: number
}

/** The one pending note, and its listeners. */
let current: ShownNote | undefined
let seq = 0
const listeners = new Set<() => void>()

/** Subscribe to note changes (the `useSyncExternalStore` contract). */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The current note (the `useSyncExternalStore` contract). */
function getSnapshot(): ShownNote | undefined {
  return current
}

/**
 * Show one recall outcome.
 *
 * Also written to the console: the toast clears itself, and a report made after
 * it cleared would otherwise be unreproducible.
 *
 * @param text - the finished, already-localized sentence.
 * @param tone - how it should read; a refusal is the default because that is the
 *   case worth reporting at all.
 */
export function showRecallNote(text: string, tone: RecallNote['tone'] = 'error'): void {
  if (text === '') return
  console.warn(`[plugin-rewind] ${text}`)
  seq += 1
  current = { text, tone, seq }
  for (const listener of listeners) listener()
}

/**
 * Mount the note host once, onto the document body.
 *
 * Called once from the client entry, not per bubble: the wrapper runs for every
 * user message, so a component mounted there would render one toast per message
 * on screen. The host owns its own React root — the same shape the office capsules
 * use (`plugin-doc/src/client/office-entry.tsx`) — and the disposer unmounts it
 * with the plugin's fiber.
 *
 * @returns the disposer that unmounts the host.
 */
export function mountRecallNoteHost(): () => void {
  if (typeof document === 'undefined') return () => {}
  const container = document.createElement('div')
  container.dataset.plugin = '@dsh-app/plugin-rewind'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<RecallNoteHost />)
  return () => {
    root.unmount()
    container.remove()
  }
}

/** Clear the note after its hold elapsed. */
function clearNote(shown: number): void {
  if (current?.seq !== shown) return
  current = undefined
  for (const listener of listeners) listener()
}

/**
 * Render the note, or nothing when there is none.
 *
 * @returns the toast element, or null.
 */
export function RecallNoteHost(): ReactNode {
  const [note, setNote] = useState<ShownNote | undefined>(current)

  useEffect(() => {
    // Seeded from the module store, then kept in step: a note raised before this
    // mounted must still appear.
    setNote(current)
    return subscribe(() => { setNote(current) })
  }, [])

  if (note === undefined) return null
  return (
    <Toast
      // The seq is the key: a repeated sentence must remount, or the hold timer
      // would not restart for it.
      key={note.seq}
      text={note.text}
      // `tone` on this primitive is only ever `success` — it swaps in a check
      // glyph. A refusal is the `icon` prop instead, which is how the kernel's own
      // refusal banner does it too.
      {...(note.tone === 'success'
        ? { tone: 'success' as const }
        : { icon: <IconWarningOutlineRegular /> })}
      holdMs={NOTE_HOLD_MS}
      // Anchored under the composer card, the way the kernel's own refusal is —
      // the message is about what did not reach the input box, so it belongs
      // beside it. With no composer on screen `Toast` falls back to top-centre.
      anchor={noteAnchor()}
      onDone={() => { clearNote(note.seq) }}
    />
  )
}
