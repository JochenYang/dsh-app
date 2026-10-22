/**
 * DSH APP code graph — host half.
 *
 * One incrementally maintained knowledge graph per project, parsed with
 * tree-sitter and stored in the kernel's own `node:sqlite`, exposed as three
 * model tools. The design and its deferred parts:
 * `docs/plans/plugin-codegraph.md`.
 *
 * Why the graph exists. Two questions a coding agent asks constantly are
 * unanswerable from the file it is looking at: "what does this project consist
 * of" and "who is affected if I change this". Grep answers neither precisely —
 * a name search cannot tell a caller from a same-named unrelated function — and
 * reading every file to answer is exactly the cost the graph removes.
 *
 * Scope discipline, deliberate:
 *   - **Syntax, not types.** tree-sitter gives one grammar per language and no
 *     type resolution, so a reference is "this name appears here", not "this
 *     binding". That buys 36 languages for ~12 MB instead of one language and a
 *     compiler. Precision is the trade, and `codegraph_impact` reports the
 *     candidates rather than pretending to be a compiler.
 *   - **Calls, not data flow.** `references` edges come from call expressions
 *     only. Variable-level flow costs an order of magnitude more to compute and
 *     answers a question this plugin is not for.
 *   - **One database per project.** A corrupt graph cannot take another project
 *     with it, and deleting a project is one directory. Cross-project queries
 *     are impossible by construction — see the plan's out-of-scope list.
 *
 * Stability: no global side effects. A kernel without the services this needs
 * never mounts anything.
 *
 * @module @dsh-app/plugin-codegraph
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'plugin-codegraph'

/** Services this plugin cannot work without. */
export const inject = ['tools', 'connection']

export function apply(_ctx: Context): void {
  // Phase 1 mounts the storage layer (see store.ts); the tools, the indexer and
  // the routes arrive in later phases of docs/plans/plugin-codegraph.md.
}
