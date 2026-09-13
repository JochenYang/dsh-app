/**
 * Error types shared by the market's host modules.
 *
 * `MarketValidationError` marks caller-fixable input problems (routes map it
 * to 400); `MarketExecutionError` marks failed side-effecting work (registry
 * lookups, CLI runs) whose message is meant for the market panel's error
 * strip. Neither message may embed credentials; CLI output tails are the
 * user-relevant diagnostic and are carried verbatim.
 *
 * @module @dsh-app/plugin-market/errors
 */

/** Invalid request input (bad package name, bad URL, bad version spec). */
export class MarketValidationError extends Error {}

/** A side-effecting step failed after validation passed. */
export class MarketExecutionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/**
 * A CLI run failed while its output carried pnpm's build-scripts-blocked
 * signal. The blocked package names ride on the error so the panel can offer
 * the allow-and-retry path instead of a dead end — the dependencies may be
 * installed already, with only their build scripts (native binaries) skipped.
 */
export class MarketBlockedBuildError extends MarketExecutionError {
  constructor(message: string, readonly blockedBuilds: readonly string[]) {
    super(message, 'blocked-builds')
  }
}
