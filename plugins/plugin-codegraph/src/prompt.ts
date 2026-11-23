/**
 * The project overview, as the text the model reads before it plans.
 *
 * Why this exists at all. The three tools were reachable and correctly
 * described, and a real session still answered "where does this project start"
 * with `glob` + `read` × 8 — the model WROTE "I should use codegraph_find /
 * codegraph_context" in its reasoning and then dropped it when it listed the
 * plan. A tool description is an INSTRUCTION, and an instruction loses to the
 * "explore = list directories, read files" prior at exactly that step.
 *
 * This is the answer instead of the instruction. It arrives as runtime context
 * before the first plan is made, so the question "what is this project, where
 * does it start" is already answered — there is nothing left to explore, and the
 * glob→read chain loses its reason to exist.
 *
 * Deliberately bounded to ~15 lines. Context is budget spent on every turn, and
 * a full symbol list would cost more than the reading it saves. Five entry
 * candidates and five hubs are enough to name the shape; every line is queryable
 * as printed — an entry row's path goes to `codegraph_context("<path>")` and a hub
 * row's symbol id goes to `codegraph_context(symbol)`. A name would not do for the
 * hub rows: two declarations can share one, and the selector then refuses it.
 *
 * STABLE UNDER EDITS is the third property, after bounded and complete enough. The
 * kernel appends a snapshot whenever the whole text changes and retires nothing
 * (`magnitude` carries the measurement), so every row here is built to stay
 * byte-identical across an edit that does not change the project's SHAPE: counts
 * snap to a rung, hubs are ordered by rung rather than by count, entry rows carry
 * no line number, and the directory layout is another rung. What does move is
 * worth re-reading — a symbol crossing a rung, a file entering the entry list.
 *
 * @module @dsh-app/plugin-codegraph/prompt
 */

import type { ProjectOverview } from './query.ts'
import { freshnessNote, type Freshness } from './query.ts'

/** How many entry candidates a SMALL project's context names. */
const MIN_ENTRIES = 5
/** How many hubs a small project's context names. */
const MIN_HUBS = 5
/** How many languages the context names, whatever the size. */
const MAX_LANGUAGES = 3
/** How many top-level directories the layout line names, whatever the size. */
const MAX_LAYOUT = 5
/** The ceiling, so a huge project cannot spend the whole context budget on this. */
const MAX_ENTRIES_CAP = 12
const MAX_HUBS_CAP = 12

/** One top-level directory and how many indexed files it holds, as `projectLayout` counts them. */
export interface LayoutEntry {
  readonly dir: string
  readonly files: number
}

/**
 * How many rows this project's shape is worth.
 *
 * A fixed five was wrong in both directions. Measured on a 1771-file monorepo: five
 * entry candidates named only the `evals` CLI and two script files, while the real
 * front door (`coding-agent/src/cli.ts`) sat below them — a reader learned the shape
 * of a tenth of the project. On a 20-file library five is already more than it has.
 *
 * The scale is logarithmic because the useful number of "places to start" grows far
 * slower than the file count: 20 files need 3, 200 need 5, 2000 need 8, and past
 * about a dozen a list stops being an orientation and becomes a directory dump.
 *
 * @param files - how many files the graph holds.
 * @returns the row budget for each list.
 */
function rowBudget(files: number): number {
  if (files <= 0) return MIN_ENTRIES
  // log10(files) * 3, rounded: 10 → 3, 100 → 6, 1000 → 9, 10000 → 12.
  const scaled = Math.round(Math.log10(files) * 3)
  return Math.max(MIN_ENTRIES, Math.min(MAX_ENTRIES_CAP, scaled))
}

/**
 * The 1–2–5 ladder a {@link magnitude} snaps to: three points per decade, from 5 up.
 *
 * A closed list, not a formula, so the table IS the spec a test can read: a value is
 * rounded to whichever rung is nearest in LOG distance, and a value exactly between
 * two rungs (their geometric mean) takes the LOWER one, so a boundary value never
 * flips to the larger rung on one side of an edit and back on the other.
 */
const LADDER: readonly number[] = [
  5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
  100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000,
  50_000_000, 100_000_000, 200_000_000, 500_000_000, 1_000_000_000, 2_000_000_000,
]

/**
 * Which ladder rung a count belongs to: the bucket every magnitude in this block
 * is built from.
 *
 * One function for the headline, the hub rows and the layout line, deliberately —
 * one rounding rule for the whole block, so two counts cannot disagree about what
 * "~50" means, and so a hub can be ORDERED by the same bucket its row prints.
 * Non-positive and non-finite values are their own bucket, 0.
 */
function ladderRung(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  // Below 5 the value IS its rung, exactly as `magnitude` prints it: a hub with 3
  // call sites sorts below one with 4, and neither shares a rung with `~5`.
  if (value < 5) return value
  // Nearest in log space. For an adjacent pair (a, b) the geometric mean is
  // sqrt(a*b); a value at or below it belongs to a, above it to b — "at" takes
  // the LOWER rung, so a value sitting on the boundary cannot flip upward on one
  // side of an edit and back on the other. Compared as squares (v*v <= a*b)
  // because the mean of two integers is usually not an integer, and sqrt would
  // make "exactly at" a floating-point question.
  const last = LADDER[LADDER.length - 1]!
  for (let index = 0; index < LADDER.length - 1; index++) {
    const lower = LADDER[index]!
    const upper = LADDER[index + 1]!
    if (value < upper) {
      return value * value <= lower * upper ? lower : upper
    }
  }
  return last
}

/**
 * A count snapped to a 1–2–5 rung (`~500`, `~20k`), or the exact value below 5.
 *
 * NOT COSMETIC — this is what keeps the block from being re-pushed on every edit.
 *
 * The kernel's runtime-context snapshot is append-only: `dsh-agent-loop` commits a
 * changed snapshot as a NEW user message (`surfaceOp: "append"`) and retires
 * nothing, and the only mitigation upstream applies is a framing line declaring
 * that a later snapshot supersedes earlier ones (`dsh-system-prompt`,
 * `joinContextSections`) — so every earlier copy still occupies context. Its
 * `RuntimeContextProjection` de-duplicates on the WHOLE joined text, which means
 * one changed digit re-pushes every section: this block, the cwd, the policy, the
 * task state.
 *
 * Measured on this repository's own sessions before this function existed: one
 * session carried 438 snapshots (1.37 MB of text, 66% of everything in it) and 435
 * of those carried this block with 351 DIFFERENT versions, differing only in
 * `304 files, 4881 symbols, 17046 edges` becoming `305 files, 4893 symbols, 17081
 * edges` after a single edit.
 *
 * Two significant digits was the first fix (`356` → `~360`, `5750` → `~5.8k`) and it
 * was not enough. Measured on 234 real sessions afterwards: 35 sessions re-pushed
 * the block 354 times, 280 of them because THIS text changed, and the headline's
 * counts account for 229 of the 274 recoverable diffs — `~440 edges` became `~450`
 * after one edit, because at the tens scale two significant digits move on every
 * unit. The hub rows cost 138 more (`~34` → `~35`, `9` → `10`, or a re-order when
 * two counts swapped), for roughly 51 million tokens re-read in total.
 *
 * So a rung, not a precision: `430` → `~500`, `7700` → `~10k`, `27000` → `~20k`.
 * Between 5 and 10 there is no rung but the endpoints, so an edge count at that
 * size is read as `5` or `10`; and the only counts that still move per edit are the
 * ones a reader cannot act on anyway. The cost is a coarser reading, and the exact
 * number is one `codegraph_context` call away — the call this block exists to
 * encourage — so a bucket costs a reader nothing and saves a full snapshot per edit.
 *
 * Below 5 the exact value IS the bucket: a project with 3 files is not
 * approximated, and a hub with 0–4 call sites is a statement the ladder cannot make.
 *
 * @param value - a non-negative count.
 * @returns the rendered magnitude.
 */
function magnitude(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value)
  if (value < 5) return String(value)
  const rung = ladderRung(value)
  const [unit, suffix] = rung >= 1_000_000 ? [1_000_000, 'M'] : rung >= 1_000 ? [1_000, 'k'] : [1, '']
  return `~${String(rung / unit)}${suffix}`
}

/** The queue states this block answers to. `unindexed` never reaches it. */
export type OverviewState = 'indexing' | 'failed' | 'stale' | 'current'

/** What the block needs to know about a project, all of it synchronous. */
export interface OverviewInputs {
  /** The queue's state for this project. */
  readonly state: OverviewState
  /** Why the last pass failed, when it did. */
  readonly failure: string | undefined
  /** The shape, when a graph could be read. */
  readonly overview: ProjectOverview | undefined
  /**
   * The top-level directories and their file counts, from `projectLayout(graph)`.
   *
   * Separate from `overview` rather than a field on it: `ProjectOverview` is also
   * what `codegraph_context` returns to the model, and a directory histogram is a
   * sentence for the prompt, not a tool-output row. Optional so a caller that has
   * not read the graph yet contributes no layout line instead of failing.
   */
  readonly layout?: readonly LayoutEntry[] | undefined
  /** What the last pass recorded about itself. */
  readonly truncated: boolean
  readonly removalSkipped: boolean
  /**
   * Files the last pass skipped as generated output. Optional only for callers
   * built before it existed; the provider passes what the graph recorded.
   */
  readonly generatedSkipped?: number | undefined
}

/**
 * Decide what the overview block says, given the queue's state and the graph.
 *
 * Extracted from the provider so the DECISION is testable without a Context, a
 * queue or a database: `apply` now only reads cwd/status/meta/overview and calls
 * this. Before the split the only assertion available was "a text function was
 * registered", which proves none of the five states are mapped correctly.
 *
 * The five states, each for a reason:
 *   - `indexing` — no shape to report yet, and "0 files" would read as a fact
 *     about the project rather than about the pass. It says THAT instead of
 *     returning nothing: a silent block reads as "this project has no graph", and
 *     the first index of a real repository is exactly when a session asks.
 *   - `failed` — the last pass is terminal until a human retries, so any shape it
 *     left has no bounded age. It says the failure and its reason instead of
 *     asserting a shape; silence would drop the only surface that can explain it.
 *   - `stale` — a shape worth reporting, plus the sentence that says it is behind.
 *     This lags the tools by one observation: the queue flips only after a tool
 *     call or a pass noticed HEAD moved or a tool result reported a change, because
 *     deciding staleness is async and this provider must return synchronously.
 *   - `current` — the shape, plus whatever the last pass recorded about its own
 *     completeness.
 *
 * @param inputs - the state, the failure reason and the graph.
 * @returns the block's text, or '' to contribute nothing.
 */
export function overviewContextText(inputs: OverviewInputs): string {
  if (inputs.state === 'indexing') {
    // The pass is building the graph right now, so there is no shape to report and
    // no symbol to look up — and saying NOTHING was the wrong silence: a model that
    // sees no block at all concludes this project has no graph (or no structure) and
    // falls back to listing directories. Measured need: the first index of a real
    // repository takes tens of seconds, which is exactly the window in which a
    // session asks its first orientation question.
    //
    // The text is bounded and carries no numbers, deliberately. "0 files" would be
    // a fact about the pass; any other count would be a fact about a half-filled
    // graph. What a reader can act on is that the answer is coming and that an empty
    // tool answer right now means "not yet", not "nothing here".
    return 'Code graph: the index for this project is being built right now, so no project shape is reported here and `codegraph_*` answers are incomplete until it finishes. An empty or partial answer in the meantime means the pass has not reached that part of the tree yet — not that the project lacks it. Ask again after a file read or two, or proceed by reading files.'
  }
  if (inputs.state === 'failed') {
    // The recorded reason goes INTO the sentence: "failed: EPERM ..." lets a reader
    // tell an unreadable root from a corrupt database without opening anything,
    // which is the difference between "fix the path" and "re-index".
    const reason = inputs.failure === undefined ? '' : ` Reason: ${inputs.failure}`
    return `Code graph: the last index pass for this project FAILED, so no shape is reported here.${reason} Treat any answer from \`codegraph_*\` with suspicion until the code graph settings page re-indexes it.`
  }
  const freshness: Freshness = inputs.state === 'stale' ? 'stale' : 'current'
  const note = freshnessNote(freshness, inputs.truncated, inputs.removalSkipped, inputs.generatedSkipped ?? 0)
  return renderOverviewContext(inputs.overview, freshness, note, inputs.layout ?? [])
}

/**
 * Render the overview as one context block, or '' for nothing to say.
 *
 * @param overview - the project's shape, or undefined when it has no graph yet.
 * @param freshness - how current the graph is.
 * @param note - the freshness sentence to carry, when there is one.
 * @param layout - the top-level directories (`projectLayout`), already counted
 *   per directory; bucketing, ordering and the cut happen here. Defaults to none.
 * @returns the text, or '' to contribute nothing.
 */
export function renderOverviewContext(
  overview: ProjectOverview | undefined,
  freshness: 'current' | 'stale' | 'indexing',
  note: string | undefined,
  layoutRows: readonly LayoutEntry[] = [],
): string {
  // An indexing graph answers from an empty shape, and "0 files" would be a
  // statement about the project rather than about the pass. Saying nothing is
  // the honest choice, and the tools report `indexing` when they are called.
  if (overview === undefined || freshness === 'indexing' || overview.files === 0) return ''

  const lines: string[] = []
  const languages = overview.byLanguage.slice(0, MAX_LANGUAGES)
    .map(entry => `${entry.lang} ${magnitude(entry.files)}`)
    .join(', ')
  lines.push(`Code graph for this project (${magnitude(overview.files)} files, ${magnitude(overview.symbols)} symbols, ${magnitude(overview.edges)} edges${languages === '' ? '' : `; ${languages}`}).`)
  if (note !== undefined) lines.push(note)
  // WHAT THE COUNTS COVER, and where an answer stops. Two sentences, because both
  // halves are things a reader would otherwise assume wrongly in opposite
  // directions: a symbol count with no stated scope reads as "the whole project"
  // (it is the project's indexable files only), and a graph of names reads as a
  // type checker (it is name resolution — no types, no dynamic dispatch). Turns
  // that spend a whole block on neither still get this line, which is why it is
  // one line and not a section.
  lines.push('Covers the project\u2019s indexed files: imports, calls, extends/implements, signature type references, and the docs that name a symbol. Names are resolved statically (no type inference, no dynamic dispatch), so a dependency it cannot name may be missing — read the source and the tests before changing shared code.')

  // WHERE IT LIVES, in one line. The entry list names files and the hub list names
  // symbols, and neither says which directories hold the project — so "is this a
  // `src/` with a `plugins/` beside it, or a flat repo" was still a listing
  // question. Counts are rungs for the same reason the headline's are: `plugins
  // ~500, test ~100` survives the edit that adds a file, and the order is rung
  // descending then name ascending, so two directories in one rung never swap on
  // a count. Sorted and cut HERE rather than in `projectLayout`, so the rule has
  // exactly one home and the query stays a plain count per directory.
  const layout = layoutRows
    .map(entry => ({ dir: entry.dir, rung: ladderRung(entry.files) }))
    .sort((a, b) => (b.rung - a.rung) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
    .slice(0, MAX_LAYOUT)
  if (layout.length >= 2) {
    lines.push(`Top-level layout (indexed files): ${layout.map(entry => `${entry.dir} ${magnitude(entry.rung)}`).join(', ')}.`)
  }

  // Sized to the project, not fixed: five named a tenth of a monorepo and more
  // than a small library has. See `rowBudget`.
  const budget = rowBudget(overview.files)
  const entries = overview.entryCandidates.slice(0, budget)
  if (entries.length > 0) {
    // A PATH, not an id: `codegraph_context("<path>")` answers a file outline, and
    // the path is already the row's own first column — so this list is queryable
    // without spending a single extra token on a selector.
    lines.push('Files nothing else imports \u2014 where a project starts, or a library\u2019s public surface (query one with `codegraph_context("<path>")`):')
    for (const entry of entries) {
      // NO LINE NUMBER, by a decision that reversed an earlier one. The line used
      // to be here for a measured reason: a model that read `(starts at function
      // bootstrap)` ran glob plus four reads anyway and cited `main.ts:34` — it
      // wanted the number, and five tool calls for it is the cost this block exists
      // to remove. But the line moves whenever a line is inserted ABOVE it, and
      // that moved the whole snapshot: measured on 234 real sessions, the entry
      // rows accounted for 82 of the 274 re-pushed diffs, most of them a line
      // shift and nothing else. One `codegraph_context("<path>")` returns the
      // outline with every line in it, so the number is one call away rather
      // than five — and the block stops re-sending itself every time someone
      // adds an import.
      const head = entry.symbol === undefined ? '' : ` (starts at ${entry.symbol.kind} ${entry.symbol.name})`
      lines.push(`- ${entry.path}${head}`)
    }
  }

  // HUBS BY RUNG, not by count. `overview.hubs` arrives ordered by references from
  // source files descending (query.ts `projectOverview`: the total is dominated by
  // tests on a real project, which ranked a fake-message builder first), which is
  // exactly what must NOT reach the text: two symbols at 34 and 35 swap places when
  // one gains a call site, and under two significant digits a count crossing a ten
  // (`~34` → `~35`, `9` → `10`) changed the row itself. Measured on 234 real
  // sessions: 138 of the 274 re-pushed diffs were hub rows, most of them a reorder
  // or a one-digit change. Snapping every candidate to the same ladder the headline
  // uses, then ordering by rung descending and id ascending, makes the set move only
  // when a symbol CROSSES a rung — and makes the order independent of the counts
  // within one. The candidates are still the most-referenced ones the query found;
  // this only decides which of them are named, and in what order.
  //
  // The count on the row is the SOURCE one, labelled: it is what the list is ranked
  // by, and `codegraph_impact` on the same id answers with the total, so the two
  // numbers a reader may see are each named for what they count.
  const hubs = overview.hubs
    .map(hub => ({ hub, rung: ladderRung(hub.sourceReferences) }))
    .sort((a, b) => (b.rung - a.rung) || (a.hub.symbol.id < b.hub.symbol.id ? -1 : a.hub.symbol.id > b.hub.symbol.id ? 1 : 0))
    .slice(0, Math.min(budget, MAX_HUBS_CAP))
    .map(entry => entry.hub)
  if (hubs.length > 0) {
    // The full symbol ID leads each row, so "expand one of these" is an instruction
    // a reader can follow by copying. It used to say "pass any id above" while the
    // row carried no id at all — only a name, which `resolveSymbol` refuses when
    // two declarations share it (and `projectOverview` admits names declared twice).
    // The id already contains kind, path and name, so it REPLACES that text rather
    // than being appended to it: copyable and no longer than what it replaces.
    //
    // A hub nothing in source references prints its TOTAL, said to be tests only:
    // "0 source call site(s)" on a row headed "most referenced" contradicts itself,
    // and in a project made of tests every row would say it.
    const anySource = hubs.some(hub => hub.sourceReferences > 0)
    lines.push(anySource
      ? 'Most-referenced symbols in source files \u2014 read these first to learn the vocabulary (each id is directly queryable):'
      : 'Most-referenced symbols, referenced from tests only \u2014 read these first all the same (each id is directly queryable):')
    for (const hub of hubs) {
      lines.push(hub.sourceReferences > 0
        ? `- ${hub.symbol.id} \u2014 ${magnitude(hub.sourceReferences)} source call site(s)`
        : `- ${hub.symbol.id} \u2014 ${magnitude(hub.references)} call site(s), tests only`)
    }
  }

  // WHEN to reach for each tool, at the END of the block.
  //
  // Placement is the point: the CodeCompass study (arXiv 2602.20048) raised graph
  // tool adoption from 0/30 to 31/31 on structural tasks by moving its checklist to
  // the END of the prompt, away from the lost-in-the-middle region. Concrete
  // triggers, not "consider using" — a sentence that names the question is one the
  // model can match against the task in front of it.
  lines.push(
    'Reach for these before reading files when the question is about dependencies or structure:',
    '- "who calls this / what breaks if I change it" → `codegraph_impact(symbol)` (a keyword search cannot tell a call from a definition or a comment)',
    '- "what does this file define / what are the methods of this class" → `codegraph_context("<file path>")` (no keyword search can answer this: definitions do not name their class)',
    '- "what is this symbol\u2019s neighbourhood" → `codegraph_context(symbol)`, passing one of the ids above.',
  )
  return lines.join('\n')
}
