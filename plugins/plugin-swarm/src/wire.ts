/**
 * Pure wiring shared by both halves of the swarm plugin: the coded
 * host-message shape the settings routes answer with and the settings page
 * renders. Zero node builtins — the browser bundle imports this module for
 * its types.
 *
 * @module @dsh-app/plugin-swarm/wire
 */

/**
 * A user-visible message the host cannot localize — and deliberately does not
 * try to.
 *
 * The host is a long-lived child process: its language would be decided at
 * boot, so switching the UI language would require restarting the kernel. It
 * therefore never sends prose. It sends a stable code plus the values the
 * sentence interpolates, and the client — which owns the locale namespace —
 * renders it. `text` is an ENGLISH diagnostic used only for a code this client
 * does not know (an older UI beside a newer kernel); it is never a localized
 * sentence, because matching on one across a boundary is how the kernel-side
 * failure classifier once misread "tampered" as "network error".
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}
