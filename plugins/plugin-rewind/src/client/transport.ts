/**
 * A refused transport call, mapped to what this plugin's components render.
 *
 * The transport answers a refused call with the kernel's own message and NO
 * command outcome, so there is no coded host answer to render. Two sentences had
 * been collapsed into one: "the request never reached the kernel" and "this
 * kernel lacks the capability". Measured on a real machine, a released session
 * reference made a click report 「缺少必要的内核能力」 — a sentence that sends the
 * user looking for a kernel feature instead of reopening the session.
 *
 * This module is React-free so the suite can exercise it: a `.tsx` cannot be
 * bundled by the plugin's test harness.
 *
 * @module @dsh-app/plugin-rewind/client/transport
 */

import type { Translate } from './messages.ts'
import type { RecallOutcome } from './outcome.ts'

/**
 * The kernel's own sentence for a refused call, when it sends one.
 *
 * @param error - the transport envelope.
 * @returns the trimmed message, or undefined when it carried none.
 */
export function transportDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return undefined
  const trimmed = message.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * A refused transport call, as the outcome the components render.
 *
 * The kernel's message is the honest diagnostic — a session whose write handle
 * is held, a released session reference, a malformed envelope — and the
 * "capability missing" sentence stays reserved for the case where nothing
 * explained itself.
 *
 * @param error - the transport envelope, when it carried a message.
 * @returns the outcome to render.
 */
export function transportFailure(error: unknown): RecallOutcome {
  const detail = transportDetail(error)
  return detail === undefined
    ? { ok: false, code: 'rewind.error.unavailable' }
    : { ok: false, code: 'rewind.error.transport', params: { detail } }
}

/**
 * {@link transportFailure}'s prose-shaped twin, for the preview path that
 * reports a finished sentence instead of an outcome.
 *
 * @param t - this plugin's locale-bound `t`.
 * @param error - the transport envelope, when it carried a message.
 * @returns the sentence to show.
 */
export function transportNote(t: Translate, error: unknown): string {
  const detail = transportDetail(error)
  return detail === undefined
    ? t('rewind.error.unavailable')
    : t('rewind.error.transport', { detail })
}
