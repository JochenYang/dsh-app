/**
 * Swarm batch expansion: validates a swarm call's business rules and expands
 * it into one runnable task per fresh item and per resume entry. Kept free of
 * runtime framework imports so the unit tests can bundle it standalone.
 *
 * @module @dsh-app/plugin-swarm/expand
 */

import type { SwarmTask } from './orchestrator.ts'

/** Minimum batch size — a single item has nothing to parallelize. */
export const MIN_ITEMS = 2

/** The `{{item}}` placeholder the template must contain. */
const ITEM_PLACEHOLDER = /\{\{\s*item\s*\}\}/gu

/** Typed view of the tool arguments after the framework's schema validation. */
export interface SwarmToolArgs {
  readonly description: string
  readonly items?: readonly string[]
  readonly prompt_template?: string
  readonly shared_context?: string
  readonly resume_entries?: readonly { readonly child_id: string; readonly followup: string }[]
  readonly max_concurrency?: number
  readonly tool_filter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
  readonly dry_run?: boolean
  readonly token_budget?: number
}

/** One flattened resume entry, keyed by its durable child id. */
interface ResumeEntry {
  readonly childId: string
  readonly followup: string
}

/** Display preview of one resume follow-up, bounded like the fresh item text. */
function followupPreview(followup: string): string {
  const flat = followup.trim().replace(/\s+/g, ' ')
  return `resume: ${flat.length > 48 ? `${flat.slice(0, 45)}...` : flat}`
}

/**
 * An item shorter than this almost certainly names a topic instead of a
 * self-contained, actionable subtask — a child receiving it has to guess the
 * input, the expected output, and the completion criterion.
 */
const MIN_ITEM_HINT_LENGTH = 10

/**
 * A template shorter than this rarely carries shared instructions plus a
 * completion criterion; it is usually just a restatement of the batch label.
 */
const MIN_TEMPLATE_HINT_LENGTH = 80

/** expandTasks result: the runnable tasks plus non-blocking quality hints. */
export interface ExpandedBatch {
  readonly tasks: SwarmTask[]
  /**
   * Heuristic split-quality hints. They never block the batch — they ride the
   * result back to the model so it can self-correct the NEXT split.
   */
  readonly warnings: string[]
}

/**
 * Validate the business rules the schema cannot express (batch composition,
 * bounds, placeholder presence, distinct items and child ids) and expand the
 * call into one runnable task per fresh item and per resume entry. Throws
 * with actionable text so the model can correct its next call.
 *
 * Composition rules: fresh items require `prompt_template`; a batch with any
 * fresh item needs at least MIN_ITEMS tasks total (fresh + resume) since a
 * lone fresh item has nothing to parallelize; a resume-only batch may be a
 * single entry because resuming keeps prior context and has no cheaper
 * alternative in this tool family.
 *
 * `shared_context` is prepended to every fresh child's prompt (resume
 * follow-ups keep their child's existing context instead). Split-quality
 * heuristics (stub items, bare templates) produce warnings, never errors.
 */
export function expandTasks(args: SwarmToolArgs, maxItems: number): ExpandedBatch {
  const items = args.items ?? []
  const resumes: ResumeEntry[] = (args.resume_entries ?? []).map((entry) => ({
    childId: entry.child_id.trim(),
    followup: entry.followup,
  }))
  if (items.length === 0 && resumes.length === 0) {
    throw new Error('swarm: provide `items` (with `prompt_template`) and/or `resume_entries` — an empty batch has nothing to run')
  }
  if (items.length === 0 && args.prompt_template !== undefined) {
    throw new Error('swarm: `prompt_template` applies only to `items`; a resume-only batch needs no template')
  }
  if (items.length > 0 && args.prompt_template === undefined) {
    throw new Error('swarm: `prompt_template` is required when `items` is present')
  }
  if (items.length > 0 && items.length + resumes.length < MIN_ITEMS) {
    throw new Error(`swarm: a batch with fresh items needs at least ${MIN_ITEMS} tasks total (items + resume_entries) — a single fresh subtask should use the subagent tool instead`)
  }
  if (items.length + resumes.length > maxItems) {
    throw new Error(`swarm: batch has ${items.length + resumes.length} tasks (items + resume_entries) but the configured maximum is ${maxItems}`)
  }
  if (args.prompt_template !== undefined && !ITEM_PLACEHOLDER.test(args.prompt_template)) {
    throw new Error('swarm: `prompt_template` must contain the {{item}} placeholder')
  }
  ITEM_PLACEHOLDER.lastIndex = 0
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.trim()
    if (key.length === 0) throw new Error('swarm: `items` contains an empty entry')
    if (seen.has(key)) throw new Error(`swarm: duplicate \`items\` entry "${key.slice(0, 60)}" — items must be distinct`)
    seen.add(key)
  }
  const seenChildren = new Set<string>()
  for (const entry of resumes) {
    if (entry.childId.length === 0) throw new Error('swarm: `resume_entries` contains an empty child_id')
    if (entry.followup.trim().length === 0) throw new Error('swarm: `resume_entries` contains an empty followup')
    if (seenChildren.has(entry.childId)) {
      throw new Error(`swarm: duplicate resume child_id "${entry.childId.slice(0, 24)}" — deliver one combined followup per child instead`)
    }
    seenChildren.add(entry.childId)
  }
  const sharedPrefix = args.shared_context === undefined || args.shared_context.trim().length === 0
    ? ''
    : `${args.shared_context.trim()}\n\n---\n\n`
  const fresh: SwarmTask[] = items.map((item, index) => ({
    index,
    item,
    // Function form: a string replacement would interpret `$&`/`$'`/`` $` ``/
    // `$n` sequences inside the item as replace-pattern tokens.
    prompt: sharedPrefix + args.prompt_template!.replace(ITEM_PLACEHOLDER, () => item),
  }))
  const resumed: SwarmTask[] = resumes.map((entry, offset) => ({
    index: fresh.length + offset,
    item: followupPreview(entry.followup),
    prompt: entry.followup,
    resumeChildId: entry.childId,
  }))
  const warnings: string[] = []
  for (const [index, item] of items.entries()) {
    if (item.trim().length < MIN_ITEM_HINT_LENGTH) {
      warnings.push(`item [${index}] "${item.trim()}" is very short — each item should name the input, the expected output, and the completion criterion of its subtask`)
    }
  }
  if (args.prompt_template !== undefined && args.prompt_template.trim().length < MIN_TEMPLATE_HINT_LENGTH) {
    warnings.push('prompt_template is very short — a child sees only its expanded prompt, so include the shared instructions and an explicit completion criterion')
  }
  if (items.length > 0 && sharedPrefix.length === 0 && args.prompt_template!.length < 200) {
    // Not a rule — a nudge toward shared_context when the whole prompt is thin.
    warnings.push('consider `shared_context` for background every subtask needs (project conventions, file inventory) instead of relying on the template alone')
  }
  return { tasks: [...fresh, ...resumed], warnings }
}
