/**
 * How much source one answer may carry.
 *
 * A source slice is the first thing this plugin returns that is not a summary, so
 * it is also the first thing that can crowd out the conversation it exists to
 * serve. The budget is therefore a table in one place, not a literal at the call
 * site — a literal is what grows a hundred lines at a time.
 *
 * Two properties the table must keep, both learned from failure:
 *
 *   - **Per-file depth never shrinks as the project grows.** The tempting shape is
 *     "bigger repo, more files, so less per file" — and it is backwards: a repo with
 *     a 4000-line module needs MORE of one file, not less. A tier that hands a large
 *     repository a shallower slice than a small one turns every answer about that
 *     module into a truncated one, and the model's response to truncation is to read
 *     the file itself, which is the cost this plugin exists to remove.
 *   - **Both numbers grow with the tier.** The total bounds the answer; the per-file
 *     depth decides whether the answer is usable. Growing only the total spends
 *     characters on more, shallower declarations.
 *
 * @module @dsh-app/plugin-codegraph/host/budget
 */

/** What one source slice may carry. */
export interface SourceBudget {
  /** Lines one declaration may show. */
  readonly maxLines: number
  /** Characters one declaration may show, line numbering included. */
  readonly maxChars: number
}

/**
 * The tiers, smallest project first: `below` is the exclusive upper bound of the
 * graph's indexed file count. 200 lines covers a function; 300 is where a class or
 * a module-level component starts paying; the totals keep one answer to a small
 * fraction of a context window.
 */
const TIERS: readonly (SourceBudget & { readonly below: number })[] = [
  { below: 150, maxLines: 200, maxChars: 14_000 },
  { below: 500, maxLines: 300, maxChars: 24_000 },
  { below: Number.POSITIVE_INFINITY, maxLines: 400, maxChars: 34_000 },
]

/**
 * The budget for a project of this size.
 *
 * A count that is not a finite number is read as zero rather than thrown on: a tool
 * answer must not fail because a caller read the wrong quantity, and the smallest
 * tier is the safe direction.
 *
 * @param indexedFiles - how many files the graph holds.
 * @returns the per-answer source budget.
 */
export function sourceBudget(indexedFiles: number): SourceBudget {
  const files = Number.isFinite(indexedFiles) ? Math.max(0, indexedFiles) : 0
  const tier = TIERS.find(entry => files < entry.below) ?? TIERS[TIERS.length - 1]!
  return { maxLines: tier.maxLines, maxChars: tier.maxChars }
}
