/**
 * Raise one operating-system notification through the shell.
 *
 * The notification is the SHELL's to show (Electron's `Notification`), and its
 * route lives on the app's own origin — a custom scheme the kernel child cannot
 * resolve — so the call is two hops, the shape plugin-client-ui's diagnostics and
 * About pages use: ask plugin-brand's host route where the action lives, then POST
 * to that URL from the page. The transport is repeated here rather than imported
 * because a suite plugin bundles standalone (no cross-plugin imports); the shape
 * is kept identical on purpose, the delegate's origin included in the re-check.
 *
 * Never throws, and `false` is a normal answer: on the `dsh web` line the host
 * route answers `unsupported`, and a shell that refuses the call answers a code.
 * A reminder that cannot reach the desktop still rang inside the app.
 *
 * WHAT LEAVES THE APP: the title and body this module is handed, and the caller
 * hands it a COUNT, never a task's text — an operating-system notification lands
 * in the desktop's own store (the notification centre's history, a lock screen),
 * outside everything this app controls, so the user's task wording stays in the
 * in-app notice.
 *
 * @module @dsh-app/plugin-todo/client/desktop-notify
 */

/** plugin-brand's route prefix (its host half owns these paths). */
const BRAND_API = '/api/plugins/dsh-app/plugin-brand'

/**
 * The exact URL of the shell's notify action — the one address this module may
 * POST to. The base is a protocol constant the shell publishes to the kernel
 * (`src/main/shell-actions.ts`: `dsh-app://app/__dsh-app/action`), and an answer
 * that names any other action — a same-origin `restart-server`, say — is refused
 * as firmly as one that names another origin: a tampered first hop must not be
 * able to turn a reminder into a different shell gesture.
 */
export const NOTIFY_ACTION_URL = 'dsh-app://app/__dsh-app/action/notify'

/** The shell's own cap for the title; a longer value is trimmed here so the call is not refused a hop later. */
export const NOTIFY_TITLE_MAX = 200

/** The shell's own cap for the body. */
export const NOTIFY_BODY_MAX = 1_000

/**
 * Trim a notification field to the shell's cap, with an ellipsis when cut.
 * @param text - the field as composed.
 * @param max - the cap in characters.
 */
export function clampNotifyText(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(max - 1, 0)).trimEnd()}…`
}

/**
 * Ask the shell to show `title` / `body` as a system notification.
 * @param title - the notice's title line.
 * @param body - the notice's text.
 * @returns whether the shell took it; `false` for every refusal and failure.
 */
export async function notifyDesktop(title: string, body: string): Promise<boolean> {
  const fields = { title: clampNotifyText(title, NOTIFY_TITLE_MAX), body: clampNotifyText(body, NOTIFY_BODY_MAX) }
  let url: string | undefined
  try {
    const answer = await fetch(`${BRAND_API}/desktop/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(response => response.json() as Promise<{ ok?: boolean, delegate?: { url?: string } }>)
    if (answer.ok !== true || typeof answer.delegate?.url !== 'string') return false
    url = answer.delegate.url
  } catch {
    return false
  }
  if (url !== NOTIFY_ACTION_URL) return false
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
      cache: 'no-store',
    })
    if (!response.ok) return false
    return (await response.json() as { ok?: boolean }).ok === true
  } catch {
    return false
  }
}
