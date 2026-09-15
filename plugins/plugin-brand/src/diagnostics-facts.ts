/**
 * Facts for the diagnostics export.
 *
 * The export is ONE human-readable plain-text file a user attaches to a problem
 * report — and **this process does not assemble it**. The file's wording belongs
 * to the page that offers the button (its dictionary, its language), so the host
 * publishes the facts only it can read and the client renders them, the same
 * contract as every other host → client message in the suite (see
 * `src/host-text.ts`). Before that split the host baked zh-CN sentences into the
 * file, so a user running the UI in English exported a Chinese document.
 *
 * What travels is an explicit ALLOWLIST — the three version variables the shell
 * publishes, the log directory it published, and the tail of the newest server
 * log. Nothing is enumerated from `process.env`, so the bridge token and every
 * other value in this process's environment are structurally unable to appear:
 * this module never sees them. The log lines were redacted by the shell at
 * write time (see `log-tail.ts`), and the tail is handed in as an argument for
 * the same reason — nothing here reads a file or an environment variable.
 *
 * @module @dsh-app/plugin-brand/diagnostics-facts
 */

import { LOG_DIR_ENV } from './log-tail.js'

/** Injected by the shell: this Electron app's version (`app.getVersion()`). */
export const SHELL_VERSION_ENV = 'DSH_APP_SHELL_VERSION'

/** Injected by the shell: the active kernel's `manifest.dshVersion`. */
export const KERNEL_VERSION_ENV = 'DSH_APP_KERNEL_VERSION'

/** Injected by the shell: the active kernel's `manifest.channel`. */
export const KERNEL_CHANNEL_ENV = 'DSH_APP_KERNEL_CHANNEL'

/**
 * Log lines carried in one export. Deeper than the page's own view (200): the
 * file is read later, by someone else, and the interesting lines are often the
 * ones just before whatever the user last looked at.
 */
export const EXPORT_TAIL_LINES = 500

/**
 * The log section of an export: the tail, or why there is none. A missing log
 * must NOT fail the export — the export is most valuable exactly when the
 * environment is broken — so the reason travels with the facts and the client
 * prints it in the reader's language.
 */
export type LogSection =
  | { readonly kind: 'ok'; readonly file: string; readonly lines: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: 'unsupported' | 'missing' | 'unreadable' }

/** Everything one export states, as an explicit snapshot rather than live state. */
export interface DiagnosticsFacts {
  /**
   * Values read from {@link SHELL_VERSION_ENV} and friends. An empty string
   * means the shell did not say — the client renders its own word for that,
   * rather than the host inventing one.
   */
  readonly shellVersion: string
  readonly kernelVersion: string
  readonly kernelChannel: string
  /** The log directory the shell published, or '' when it published none. */
  readonly logDir: string
  /**
   * The variable that directory arrives in (`DSH_APP_LOG_DIR`). Published so the
   * page can say WHY there is no directory without hard-coding a shell contract
   * name into client copy.
   */
  readonly logDirEnv: string
  readonly log: LogSection
}

/**
 * Name for one export, `dsh-app-diagnostics-<yyyyMMdd-HHmm>.txt`.
 *
 * Language-neutral on purpose (it is a file name, not copy), and built here
 * because the save dialog's default name is the host's to offer.
 *
 * @param now - the moment the export was requested.
 * @returns a file name with no directory part, so the save dialog stays in
 * charge of where it lands. Sorts chronologically, like the log names.
 */
export function exportFileName(now: Date): string {
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `dsh-app-diagnostics-${date}-${time}.txt`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
