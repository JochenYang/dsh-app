/**
 * The injection ledger's bounded home: one sample per prompt assembly, kept in
 * memory only.
 *
 * Why memory and not a file: this is written on EVERY assembly — several times
 * per turn, in every session — and a JSON rewrite per turn would put disk I/O on
 * the prompt path to answer a diagnostic question. The samples exist to make
 * "the injection is over budget" measurable, not to survive a restart; the
 * durable numbers (cards, sizes) already live in each store.
 *
 * Why bounded: an unbounded list on the prompt path is the same class of bug the
 * store's own MAX_INDEX_LINES guards against — a session that runs for a week
 * would grow it forever. {@link MAX_INJECTION_SAMPLES} is the ring; the mean is
 * over exactly those samples.
 *
 * @module @dsh-app/plugin-memory/injection-metrics
 */

import type { InjectionMetrics } from './prompt.ts'

/** How many assemblies the ring keeps (latest + mean over these). */
export const MAX_INJECTION_SAMPLES = 20

/** One assembly's ledger, stamped. */
export interface InjectionSample extends InjectionMetrics {
  /** Epoch ms of the assembly. */
  at: number
  /** Project slug the assembly was for (the store it read). */
  project: string
}

/** The average of the ring's samples (the "typical turn" figures). */
export interface InjectionMean {
  guidelinesChars: number
  indexChars: number
  bodyChars: number
  totalChars: number
  cardCount: number
  indexLines: number
  /** Cards left out, on average per assembly. */
  droppedCards: number
  /** Index lines the ceiling cut, on average per assembly. */
  indexOverflowLines: number
}

/** What `/status` serves: the latest assembly + the ring's averages. */
export interface InjectionSummary {
  latest: InjectionSample
  /** How many samples the mean covers (≤ {@link MAX_INJECTION_SAMPLES}). */
  samples: number
  mean: InjectionMean
  /** How many of those samples had cards left out (budget or quota). */
  truncatedSamples: number
}

/** Round to one decimal: the page shows characters, not floats. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Fixed-size FIFO of assembly ledgers.
 *
 * One instance per mounted plugin, fed by the system-prompt provider — the only
 * place an assembly exists — and read by the settings route.
 */
export class InjectionMetricsRing {
  private readonly samples: InjectionSample[] = []

  /**
   * Record one assembly.
   * @param metrics - the ledger {@link assembleMemoryText} produced.
   * @param project - the assembled session's project slug.
   * @param at - epoch ms (injectable for tests).
   */
  record(metrics: InjectionMetrics, project: string, at: number = Date.now()): void {
    this.samples.push({ ...metrics, at, project })
    if (this.samples.length > MAX_INJECTION_SAMPLES) this.samples.shift()
  }

  /** The ring's newest sample (undefined before the first assembly). */
  latest(): InjectionSample | undefined {
    return this.samples[this.samples.length - 1]
  }

  /** Count of retained samples. */
  size(): number {
    return this.samples.length
  }

  /** The `/status` payload, or undefined when nothing has been assembled yet —
   *  a fresh kernel must answer "no data", not four zeroes that read like an
   *  empty prompt. */
  summary(): InjectionSummary | undefined {
    const latest = this.latest()
    if (latest === undefined) return undefined
    const n = this.samples.length
    const sum = (pick: (sample: InjectionSample) => number): number =>
      oneDecimal(this.samples.reduce((total, sample) => total + pick(sample), 0) / n)
    return {
      latest,
      samples: n,
      mean: {
        guidelinesChars: sum(sample => sample.guidelinesChars),
        indexChars: sum(sample => sample.indexChars),
        bodyChars: sum(sample => sample.bodyChars),
        totalChars: sum(sample => sample.totalChars),
        cardCount: sum(sample => sample.cardCount),
        indexLines: sum(sample => sample.indexLines),
        // Means, not sums: one huge assembly would otherwise dominate every
        // reading of "how much is typically dropped".
        droppedCards: sum(sample => sample.droppedCards),
        indexOverflowLines: sum(sample => sample.indexOverflowLines),
      },
      truncatedSamples: this.samples.filter(sample => sample.truncated).length,
    }
  }
}
