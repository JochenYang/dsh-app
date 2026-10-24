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
 * candidates and five hubs are enough to name the shape; each line carries an id
 * or a unique name, so `codegraph_context(symbol)` expands any one of them.
 *
 * @module @dsh-app/plugin-codegraph/prompt
 */

import type { ProjectOverview } from './query.ts'
import { freshnessNote, type Freshness } from './query.ts'

/** How many entry candidates the context names. */
const MAX_ENTRIES = 5
/** How many hubs the context names. */
const MAX_HUBS = 5
/** How many languages the context names. */
const MAX_LANGUAGES = 3

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
 *     about the project rather than about the pass.
 *   - `failed` — the last pass is terminal until a human retries, so any shape it
 *     left has no bounded age. It says the failure and its reason instead of
 *     asserting a shape; silence would drop the only surface that can explain it.
 *   - `stale` — a shape worth reporting, plus the sentence that says it is behind.
 *     This lags the tools by one observation: the queue flips only after a tool
 *     call or a pass noticed HEAD moved, because deciding staleness is async and
 *     this provider must return synchronously.
 *   - `current` — the shape, plus whatever the last pass recorded about its own
 *     completeness.
 *
 * @param inputs - the state, the failure reason and the graph.
 * @returns the block's text, or '' to contribute nothing.
 */
export function overviewContextText(inputs: OverviewInputs): string {
  if (inputs.state === 'indexing') return ''
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

  const entries = overview.entryCandidates.slice(0, MAX_ENTRIES)
  if (entries.length > 0) {
    lines.push('Files nothing else imports — where a project starts, or a library\u2019s public surface:')
    for (const entry of entries) {
      const head = entry.symbol === undefined ? '' : ` (starts at ${entry.symbol.kind} ${entry.symbol.name})`
      lines.push(`- ${entry.path}${head}`)
    }
  }

  const hubs = overview.hubs.slice(0, MAX_HUBS)
  if (hubs.length > 0) {
    lines.push('Most-referenced symbols — read these first to learn the vocabulary:')
    for (const hub of hubs) {
      lines.push(`- ${hub.symbol.kind} ${hub.symbol.name} \u2014 ${hub.symbol.path}:${String(hub.symbol.line)}, ${String(hub.references)} call site(s)`)
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
    '- "what is this symbol\u2019s neighbourhood" → `codegraph_context(symbol)`; pass any id above to expand it.',
  )
  return lines.join('\n')
}
