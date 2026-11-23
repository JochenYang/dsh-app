/**
 * What the model-facing features of this plugin DID, counted per project, since
 * this process started.
 *
 * Why counters and not the session log: the log says what a tool answered, not
 * what the plugin decided. "The pushed overview changed 24 times in one session"
 * and "the starter pack was skipped because nothing resolved" are decisions that
 * leave no tool call behind, and they are exactly the numbers this round's work
 * is judged on — a threshold is tuned against them or it is tuned blind.
 *
 * Why in memory: a write per tool call would put disk I/O on the prompt path to
 * answer a diagnostic question. The numbers live until the process exits; the
 * durable record of what reached the model is the session log, which
 * `scripts/usage-replay.mjs` reads.
 *
 * @module @dsh-app/plugin-codegraph/usage
 */

/** The keys that can be counted. Kept as a list so every row starts complete. */
export const USAGE_KEYS = [
  'overviewChanges',
  'find',
  'impact',
  'context',
  'prefetchAttached',
  'prefetchSkipped',
  'grepNotes',
] as const

/** One key of {@link UsageRow}. */
export type UsageKey = (typeof USAGE_KEYS)[number]

/** One project's counters. Every key is always present, so a consumer never has
 *  to tell "zero" from "not reported". */
export type UsageRow = Readonly<Record<UsageKey, number>>

/** A fresh row, every counter at zero. */
export function emptyUsage(): UsageRow {
  return { overviewChanges: 0, find: 0, impact: 0, context: 0, prefetchAttached: 0, prefetchSkipped: 0, grepNotes: 0 }
}

/** Per-project counters, keyed by the project's working directory. */
export class UsageCounters {
  private readonly rows = new Map<string, Record<UsageKey, number>>()

  private writable(cwd: string): Record<UsageKey, number> {
    let row = this.rows.get(cwd)
    if (row === undefined) {
      row = { ...emptyUsage() }
      this.rows.set(cwd, row)
    }
    return row
  }

  /** Add `by` (1 by default) to one counter of one project. */
  bump(cwd: string, key: UsageKey, by = 1): void {
    if (!Number.isFinite(by) || by < 0) return
    this.writable(cwd)[key] += Math.floor(by)
  }

  /** One project's counters as a copy, zeros when nothing was counted. */
  row(cwd: string): UsageRow {
    return { ...emptyUsage(), ...this.rows.get(cwd) }
  }

  /** Every project that has a non-zero counter, as copies. */
  all(): ReadonlyMap<string, UsageRow> {
    return new Map([...this.rows].map(([cwd, row]) => [cwd, { ...row }]))
  }
}
