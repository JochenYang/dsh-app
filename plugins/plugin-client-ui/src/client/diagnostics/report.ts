/**
 * The diagnostics package's text, assembled in the PAGE'S language.
 *
 * The host publishes facts (versions, log directory, log tail) and this page
 * renders them: a support file has to be readable by whoever opens it, and that
 * reader's language is the one the UI is running in — not the language the
 * kernel child process happens to speak. Before that split the host baked zh-CN
 * sentences into the file, so an English UI exported a Chinese document. This is
 * the same host-code → client-copy contract the rest of the suite uses (see
 * `api.ts`), applied to a file instead of a badge.
 *
 * Kept free of React so the suite can exercise it directly: the shapes it reads
 * are the ones a future host may get wrong (a missing fact, an unknown log
 * reason, an empty tail), and a wrong-looking support file is expensive to
 * notice.
 *
 * @module @dsh-app/plugin-client-ui/client/diagnostics/report
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** A log tail, or the reason there is none (mirrors the host's `LogSection`). */
export interface ReportLog {
  readonly kind?: string
  readonly file?: string
  readonly lines?: readonly string[]
  readonly reason?: string
}

/** The facts the host publishes for one export. Absent fields are tolerated. */
export interface ReportFacts {
  readonly name?: string
  readonly generatedAt?: string
  readonly shellVersion?: string
  readonly kernelVersion?: string
  readonly kernelChannel?: string
  readonly logDir?: string
  /** The variable the log directory arrives in; see the host's facts module. */
  readonly logDirEnv?: string
  readonly log?: ReportLog
}

/** How many tail lines the export asks for when the host said nothing. */
const DEFAULT_TAIL_LINES = 500

/**
 * File name for this export: the host's, so one place decides the convention;
 * a local stamp is the fallback for a host that predates the field.
 * @param facts - the facts the host published.
 * @param now - the moment of the fallback stamp.
 * @returns a name with no directory part.
 */
export function reportFileName(facts: ReportFacts, now: Date = new Date()): string {
  const given = facts.name
  if (typeof given === 'string' && given !== '') return given
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `dsh-app-diagnostics-${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}.txt`
}

/**
 * Assemble the file body.
 * @param facts - the facts the host published.
 * @param t - the page's namespace-bound translate seat.
 * @param tailLines - the tail size the export requested (for the limit line).
 * @returns the complete file, newline-terminated.
 */
export function buildReportText(
  facts: ReportFacts,
  t: TranslateNS<typeof NS>,
  tailLines: number = DEFAULT_TAIL_LINES,
): string {
  const lines: string[] = [
    t('diag.report.title'),
    t('diag.report.generatedAt', { at: localStamp(facts.generatedAt) }),
    '',
    t('diag.report.intro'),
    t('diag.report.noSecrets'),
    '',
    t('diag.report.sectionVersions'),
    t('diag.report.shellVersion', { value: orUnknown(facts.shellVersion, t) }),
    t('diag.report.kernelVersion', { value: orUnknown(facts.kernelVersion, t) }),
    t('diag.report.kernelChannel', { value: orUnknown(facts.kernelChannel, t) }),
    '',
    t('diag.report.sectionLog'),
    t('diag.report.logDir', { value: orUnknown(facts.logDir, t) }),
    ...logBlock(facts.log, t, tailLines, facts.logDirEnv),
    '',
    t('diag.report.end'),
  ]
  return `${lines.join('\n')}\n`
}

/** The `[日志]` block: either the tail itself or the reason it is absent. */
function logBlock(
  log: ReportLog | undefined,
  t: TranslateNS<typeof NS>,
  tailLines: number,
  logDirEnv: string | undefined,
): string[] {
  if (log === undefined || log.kind !== 'ok') {
    return [t('diag.report.logUnavailable', { reason: unavailableReason(log?.reason, t, logDirEnv) })]
  }
  const lines = log.lines ?? []
  return [
    t('diag.report.logFile', { file: orUnknown(log.file, t) }),
    t('diag.report.logTail', { limit: String(tailLines), count: String(lines.length) }),
    '',
    t('diag.report.logStart'),
    ...(lines.length === 0 ? [t('diag.report.logEmpty')] : lines),
    t('diag.report.logEnd'),
  ]
}

/**
 * One sentence per way the tail can be missing; an unknown reason still speaks.
 * @param reason - the host's coded reason.
 * @param t - the page's translate seat.
 * @param logDirEnv - the variable the directory arrives in, for the one sentence
 * that names it; the shell's contract name is the fallback, never a blank.
 */
function unavailableReason(
  reason: string | undefined,
  t: TranslateNS<typeof NS>,
  logDirEnv: string | undefined,
): string {
  switch (reason) {
    case 'unsupported':
      return t('diag.report.reason.unsupported', { env: fallbackEnv(logDirEnv) })
    case 'missing':
      return t('diag.report.reason.missing')
    case 'unreadable':
      return t('diag.report.reason.unreadable')
    default:
      return t('diag.report.reason.unknown')
  }
}

/**
 * The log-directory variable's name.
 * @param value - what the host published.
 * @returns the name, or the shell's contract name when the host said nothing.
 */
function fallbackEnv(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? 'DSH_APP_LOG_DIR' : value
}

/** A value, or this page's word for "the host did not say". */
function orUnknown(value: string | undefined, t: TranslateNS<typeof NS>): string {
  return value === undefined || value.trim() === '' ? t('diag.report.unknown') : value
}

/**
 * Local wall-clock stamp, `yyyy-MM-dd HH:mm:ss`.
 * @param iso - the host's `generatedAt`, or undefined when it sent none.
 * @returns the local rendering, or the raw value when it is not a date.
 */
function localStamp(iso: string | undefined): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const at = iso === undefined ? new Date() : new Date(iso)
  if (Number.isNaN(at.getTime())) return iso ?? ''
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}
