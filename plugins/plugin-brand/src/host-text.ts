/**
 * The coded wire message this plugin's routes answer with.
 *
 * The module exists so both halves of the contract have one definition to
 * point at: the routes BUILD these, and the consuming client (the 诊断 settings
 * page of plugin-client-ui) renders them. Nothing here imports node builtins or
 * framework types — it is the shape alone.
 *
 * @module @dsh-app/plugin-brand/host-text
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
