/**
 * How much one answer may carry: a source slice, and a list.
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
 * The list budget below answers a different question. A file outline with a
 * signature per row is the first list this plugin renders whose size depends on
 * the FILE rather than on a row limit, and the cost of a list is not paid once:
 * measured on 234 real sessions, every character a tool result appends is re-read
 * 166 times by the steps after it. So the list has a size, and when the rows do
 * not fit, the answer says LESS per row rather than fewer rows unannounced.
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

/**
 * Characters one answer's list part may carry by default.
 *
 * The number behind the first line's `~N/1200 tokens`: a list is the part of an
 * answer the model re-reads on every later turn, and 4,800 characters is about
 * what a 25-row outline with signatures and summaries, or a 60-row one with
 * signatures alone, takes on this repository. Past it the plan steps the detail
 * down one level rather than hand back a list the conversation pays for until
 * the session ends.
 */
export const ANSWER_LIST_CHARS = 4_800

/** The same budget in tokens, as the first line reports it. */
export const ANSWER_LIST_TOKENS = 1_200

/**
 * The most rows a file outline reads before the budget decides how many survive.
 *
 * Not the old `MAX_ROWS` (40): a 200-symbol file at `names` is ~80 rows within
 * the budget, so reading 40 would have made the row limit, not the budget, the
 * thing that cut the list — and a row limit says nothing about size.
 */
export const MAX_OUTLINE_ROWS = 200

/**
 * Tokens for a character count, at the ~4 characters per token the budget assumes.
 *
 * Rounded UP so a list that is exactly at the budget reads as the budget, never
 * as under it. A count that is not a finite number reads as zero: an estimate
 * must not turn into `NaN tokens` on the first line of an answer.
 */
export function estimateTokens(chars: number): number {
  return Number.isFinite(chars) ? Math.ceil(Math.max(0, chars) / 4) : 0
}

/** How much one outline row says. */
export type OutlineDetail = 'names' | 'signatures' | 'full'

/** What a caller may ask for: a level, or `auto` — the level the row count picks. */
export type DetailRequest = OutlineDetail | 'auto'

/** The levels, least detail first. A budget step is one place down this list. */
const DETAIL_LEVELS: readonly OutlineDetail[] = ['names', 'signatures', 'full']

/** What the tool does with one file's rows, decided before anything is rendered. */
export interface OutlinePlan {
  /** The level the rows are rendered at, and the one the answer's first line names. */
  readonly detail: OutlineDetail
  /** How many of the rows survive, in the order given. */
  readonly rows: number
  /** The surviving rows' rendered length at `detail`, newlines included. */
  readonly chars: number
  /**
   * How many rows the budget dropped. Zero unless `detail` is `names` and the
   * list is still over budget — the one case where saying less per row is no
   * longer possible and fewer rows is the only step left.
   */
  readonly cut: number
}

/**
 * The level a row count asks for, before the budget has its say.
 *
 * Measured on this repository: a signature is p50 409 characters unnormalised
 * and ~60 once `normalizeSignature` folds it to one line, and 41% of declarations
 * carry a doc sentence of p50 152 characters. So 25 rows with both, or 60 with
 * the signature alone, sit near the budget; past that, names.
 */
function levelForRows(count: number): OutlineDetail {
  if (count <= 25) return 'full'
  if (count <= 60) return 'signatures'
  return 'names'
}

/** `rows.join('\n').length` at one level — the list as the renderer emits it. */
function listChars<T>(rows: readonly T[], measure: (row: T, level: OutlineDetail) => string, level: OutlineDetail): number {
  let chars = 0
  for (const row of rows) chars += measure(row, level).length + 1
  return Math.max(0, chars - 1)
}

/**
 * Decide the detail level and the row count for one file outline.
 *
 * Pure, and decided in `execute` rather than in the renderer on purpose: the
 * level is written into the result (`file.detail`) and the renderer reads it
 * back, so the JSON a tool-calling model's code sees and the text the model
 * reads can never disagree about how much the rows say.
 *
 * The ladder, from the requested level (or the one the row count picks):
 *
 *   - while the list rendered at this level is over {@link ANSWER_LIST_CHARS}
 *     and a lower level exists, step down one;
 *   - at `names` and still over, keep the longest prefix that fits — the rows
 *     are ordered most-important first (exported, then most referenced), so the
 *     ones dropped are the ones a reader least needs. At least one row always
 *     survives, whatever it costs.
 *
 * An explicit level is where the ladder STARTS, never a promise: `detail: full`
 * on a 200-row file steps down to whatever fits, exactly as `auto` would have.
 *
 * @param requested - the caller's `detail`, or `auto`.
 * @param rows - the outline rows, most-important first.
 * @param measure - how one row renders at a level; the same function the
 *   renderer uses, so the budget is spent on the text that is actually sent.
 * @returns the level, the surviving row count and the rendered size.
 */
export function planOutline<T>(
  requested: DetailRequest,
  rows: readonly T[],
  measure: (row: T, level: OutlineDetail) => string,
): OutlinePlan {
  let index = DETAIL_LEVELS.indexOf(requested === 'auto' ? levelForRows(rows.length) : requested)
  let chars = listChars(rows, measure, DETAIL_LEVELS[index]!)
  while (index > 0 && chars > ANSWER_LIST_CHARS) {
    index -= 1
    chars = listChars(rows, measure, DETAIL_LEVELS[index]!)
  }
  const detail = DETAIL_LEVELS[index]!
  if (chars <= ANSWER_LIST_CHARS) return { detail, rows: rows.length, chars, cut: 0 }

  let keep = 0
  let keptChars = 0
  for (const row of rows) {
    const length = measure(row, detail).length + (keep === 0 ? 0 : 1)
    if (keep > 0 && keptChars + length > ANSWER_LIST_CHARS) break
    keep += 1
    keptChars += length
  }
  return { detail, rows: keep, chars: keptChars, cut: rows.length - keep }
}
