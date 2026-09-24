/**
 * Last-resort handling for errors that escape every other catch.
 *
 * Why this exists: Electron's main process turns an `uncaughtException` into a
 * native error box — a red X titled "A JavaScript error occurred in the main
 * process", with `Uncaught Exception:` and a raw stack, and one button. Measured
 * on 44.4.5 with the shape a user reported (`TypeError: terminated`, raised from
 * undici's `Fetch.onAborted` when a TLS connection dies mid-transfer): without a
 * handler the box appears and the process KEEPS RUNNING; with one, no box appears
 * and the error is ours to report. An unhandled rejection raises no box at all.
 * Neither kind is visible in a packaged build — there is no console — so a
 * reported dialog could not be traced to a line, which is the gap this closes.
 *
 * What this deliberately does NOT change: the process stays up in both cases.
 * Exiting would be a NEW failure mode (Electron's own behaviour is to continue),
 * and the recovery for the interesting case only works while the process lives —
 * the update and kernel download chains move to their next source after a reset
 * link, so quitting on the first one would turn a working mirror fallback into a
 * dead app. Every escaped error is written out with its full stack, so nothing is
 * swallowed; a genuine defect is marked in the log rather than hidden.
 *
 * @module dsh-app/main/crash-log
 */

/** Log writer, injected so this module owns no path or file handle. */
export type CrashLog = (line: string) => void

/**
 * Error codes and messages that mean "the transport failed", not "the code is
 * wrong". Matched against `code`, `name` and `message` because the same condition
 * arrives differently by path: undici reports an aborted fetch as
 * `TypeError: terminated`, a socket reset as `ECONNRESET`, a Node timer abort as
 * `TimeoutError`/`AbortError`, a killed pipe as `EPIPE`.
 */
const TRANSPORT_MARKERS = [
  'terminated',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
  'TimeoutError',
  'AbortError',
  'ERR_STREAM_PREMATURE_CLOSE',
] as const

/**
 * Whether an escaped error is a transport condition the shell already recovers
 * from, rather than a defect in this code.
 *
 * The answer decides only how the line READS (`TRANSPORT` vs `DEFECT`), never
 * whether the process survives — see the module note. Walking `cause` matters:
 * an aborted fetch carries the socket error there, and without it a reset link
 * reads as an unknown defect.
 *
 * @param error - the value an error listener was handed.
 * @returns true when the failure is about the network, not about this code.
 */
export function isTransportFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const parts: string[] = []
  if (typeof error === 'string') parts.push(error)
  if (error instanceof Error) {
    parts.push(error.name, error.message)
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') parts.push(code)
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined && cause !== error) {
      const nested = cause as { code?: unknown; message?: unknown; name?: unknown }
      if (typeof nested.code === 'string') parts.push(nested.code)
      if (typeof nested.name === 'string') parts.push(nested.name)
      if (typeof nested.message === 'string') parts.push(nested.message)
    }
  }
  const haystack = parts.join(' ')
  if (haystack === '') return false
  return TRANSPORT_MARKERS.some((marker) => haystack.includes(marker))
}

/** How the log labels one escaped error. */
export type CrashVerdict = 'transport' | 'defect'

/**
 * Write one escaped error to the log, labelled by what it looks like.
 *
 * @param error - the escaped value.
 * @param kind - which listener saw it.
 * @param log - the shell's log writer.
 * @returns the label, so a caller (or a test) can act on the classification.
 */
export function reportEscapedError(error: unknown, kind: 'uncaughtException' | 'unhandledRejection', log: CrashLog): CrashVerdict {
  const detail = error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : typeof error === 'object' ? JSON.stringify(error) : String(error)
  const verdict: CrashVerdict = isTransportFailure(error) ? 'transport' : 'defect'
  log(`[crash] ${kind} (${verdict === 'transport' ? 'TRANSPORT' : 'DEFECT'}): process stays up; full stack follows`)
  for (const line of detail.split('\n')) log(`[crash]   ${line}`)
  return verdict
}

/**
 * Install the last-resort listeners.
 *
 * Both are installed: the uncaught exception is the one that raises the native
 * box, and the unhandled rejection is the one that would otherwise vanish — in a
 * packaged build neither is observable without them.
 *
 * @param log - the shell's log writer (the kernel log, which rotates).
 */
export function installCrashLogging(log: CrashLog): void {
  process.on('uncaughtException', (error) => {
    reportEscapedError(error, 'uncaughtException', log)
  })
  process.on('unhandledRejection', (reason) => {
    reportEscapedError(reason, 'unhandledRejection', log)
  })
}
