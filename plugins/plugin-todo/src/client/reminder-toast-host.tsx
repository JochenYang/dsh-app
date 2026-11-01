/**
 * The reminder notice, mounted once onto the document body.
 *
 * It cannot live in the todo page: the workbench container unmounts a domain page when
 * the user leaves the panel, so a notice rendered there is invisible exactly when a
 * reminder is most useful — while the user is in a conversation. This host owns its own
 * React root on `document.body`, the same shape `plugin-rewind`'s recall note and the
 * office capsules use, and the watcher in `reminders.ts` decides what it shows.
 *
 * `key={seq}` on the card: two reminders in a row must remount it, or the second one
 * would keep the first one's entrance animation and any local state.
 *
 * @module @dsh-app/plugin-todo/client/reminder-toast-host
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReminderToast } from './reminder.tsx'
import {
  completeReminder,
  dismissReminder,
  shownReminder,
  snoozeReminder,
  subscribeReminder,
} from './reminders.ts'
import type { Translate } from './translate.ts'

/**
 * Report a failed reminder action without breaking the notice.
 *
 * The actions are fire-and-forget from a click handler, so a rejection has nowhere to
 * go; the console line is what makes it reproducible after the notice closed.
 *
 * @param error - whatever the request threw.
 */
function report(error: unknown): void {
  console.warn('[plugin-todo] reminder action failed:', error)
}

/**
 * Render the notice, or nothing when none is due.
 * @param props.t - the dictionary seat.
 */
export function ReminderToastHost({ t }: { t: Translate }): ReactNode {
  const shown = useSyncExternalStore(subscribeReminder, shownReminder, shownReminder)
  if (shown === undefined) return null
  const id = shown.item.id
  return (
    <ReminderToast
      key={shown.seq}
      item={shown.item}
      t={t}
      onDone={() => { void completeReminder(id).catch(report) }}
      onSnooze={() => { void snoozeReminder(id).catch(report) }}
      onDismiss={() => { void dismissReminder(id).catch(report) }}
    />
  )
}

/**
 * Mount the notice host once, onto the document body.
 *
 * @param t - the dictionary seat, resolved per render so a language switch applies to
 *   the next notice without remounting this root.
 * @returns the disposer that unmounts the host.
 */
export function mountReminderToastHost(t: Translate): () => void {
  if (typeof document === 'undefined') return () => {}
  const container = document.createElement('div')
  container.dataset.plugin = '@dsh-app/plugin-todo'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<ReminderToastHost t={t} />)
  return () => {
    root.unmount()
    container.remove()
  }
}
