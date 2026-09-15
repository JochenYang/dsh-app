/**
 * Error types shared by the market's host modules.
 *
 * `MarketValidationError` marks caller-fixable input problems (routes map it
 * to 400); `MarketExecutionError` marks failed side-effecting work (registry
 * lookups, CLI runs) whose message is meant for the market panel's error
 * strip. Neither carries credentials; CLI output tails are the user-relevant
 * diagnostic and ride a message's params verbatim.
 *
 * Every failure carries a coded message ({@link HostText}) rather than prose:
 * the host is a long-lived child process whose language was fixed at boot, so
 * the panel — which owns the locale namespace — renders the sentence.
 *
 * @module @dsh-app/plugin-market/errors
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
 *
 * A composed sentence may put another code of the client's dictionary in a
 * `params` slot: a nested rejection's reason (the outer copy wraps an inner
 * one), a side that has no provable repo key, or a missing OS error code. The
 * client resolves such a value with the same fallback chain, one level deep;
 * nested codes carry no params of their own.
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

/** One coded message as a log line (logs are English diagnostics, never prose). */
export function hostDiagnostic(host: HostText): string {
  return host.text ?? host.code
}

/** Invalid request input (bad package name, bad URL, bad version spec). */
export class MarketValidationError extends Error {
  /**
   * @param host - the coded message; its `text` doubles as this error's
   *   developer-facing `message`, so a log or a test never sees a sentence.
   */
  constructor(readonly host: HostText) {
    super(host.text ?? host.code)
    this.name = 'MarketValidationError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.host
  }
}

/** A side-effecting step failed after validation passed. */
export class MarketExecutionError extends Error {
  constructor(readonly host: HostText, readonly code: string) {
    super(host.text ?? host.code)
    this.name = 'MarketExecutionError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.host
  }
}

/**
 * A CLI run failed while its output carried pnpm's build-scripts-blocked
 * signal. The blocked package names ride on the error so the panel can offer
 * the allow-and-retry path instead of a dead end — the dependencies may be
 * installed already, with only their build scripts (native binaries) skipped.
 */
export class MarketBlockedBuildError extends MarketExecutionError {
  constructor(host: HostText, readonly blockedBuilds: readonly string[]) {
    super(host, 'blocked-builds')
    this.name = 'MarketBlockedBuildError'
  }
}
