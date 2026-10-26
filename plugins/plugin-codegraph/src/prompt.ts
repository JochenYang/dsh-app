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
/** The ceiling, so a huge project cannot spend the whole context budget on this. */
const MAX_ENTRIES_CAP = 12
const MAX_HUBS_CAP = 12

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
  /** What the last pass recorded about itself. */
  readonly truncated: boolean
  readonly removalSkipped: boolean
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
  const note = freshnessNote(freshness, inputs.truncated, inputs.removalSkipped)
  return renderOverviewContext(inputs.overview, freshness, note)
}

/**
 * Render the overview as one context block, or '' for nothing to say.
 *
 * @param overview - the project's shape, or undefined when it has no graph yet.
 * @param freshness - how current the graph is.
 * @param note - the freshness sentence to carry, when there is one.
 * @returns the text, or '' to contribute nothing.
 */
export function renderOverviewContext(
  overview: ProjectOverview | undefined,
  freshness: 'current' | 'stale' | 'indexing',
  note: string | undefined,
): string {
  // An indexing graph answers from an empty shape, and "0 files" would be a
  // statement about the project rather than about the pass. Saying nothing is
  // the honest choice, and the tools report `indexing` when they are called.
  if (overview === undefined || freshness === 'indexing' || overview.files === 0) return ''

  const lines: string[] = []
  const languages = overview.byLanguage.slice(0, MAX_LANGUAGES)
    .map(entry => `${entry.lang} ${String(entry.files)}`)
    .join(', ')
  lines.push(`Code graph for this project (${String(overview.files)} files, ${String(overview.symbols)} symbols, ${String(overview.edges)} edges${languages === '' ? '' : `; ${languages}`}).`)
  if (note !== undefined) lines.push(note)
  // WHAT THE COUNTS COVER, and where an answer stops. Two sentences, because both
  // halves are things a reader would otherwise assume wrongly in opposite
  // directions: a symbol count with no stated scope reads as "the whole project"
  // (it is the project's indexable files only), and a graph of names reads as a
  // type checker (it is name resolution — no types, no dynamic dispatch). Turns
  // that spend a whole block on neither still get this line, which is why it is
  // one line and not a section.
  lines.push('Covers the project\u2019s indexed files: imports, calls, extends/implements, signature type references, and the docs that name a symbol. Names are resolved statically (no type inference, no dynamic dispatch), so a dependency it cannot name may be missing — read the source and the tests before changing shared code.')

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
      const head = entry.symbol === undefined ? '' : ` (starts at ${entry.symbol.kind} ${entry.symbol.name})`
      lines.push(`- ${entry.path}${head}`)
    }
  }

  const hubs = overview.hubs.slice(0, Math.min(budget, MAX_HUBS_CAP))
  if (hubs.length > 0) {
    // The full symbol ID leads each row, so "expand one of these" is an instruction
    // a reader can follow by copying. It used to say "pass any id above" while the
    // row carried no id at all — only a name, which `resolveSymbol` refuses when
    // two declarations share it (and `projectOverview` admits names declared twice).
    // The id already contains kind, path and name, so it REPLACES that text rather
    // than being appended to it: copyable and no longer than what it replaces.
    lines.push('Most-referenced symbols \u2014 read these first to learn the vocabulary (each id is directly queryable):')
    for (const hub of hubs) {
      lines.push(`- ${hub.symbol.id} \u2014 ${String(hub.references)} call site(s)`)
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
