/**
 * DSH APP swarm — host half.
 *
 * Batch parallel delegation over the platform's `ctx.subagents` seam. The
 * plugin contributes three things, all bound to the configured provider's
 * lifecycle so nothing model-facing exists while the provider is absent:
 *
 *   1. A `swarm` tool — the model fans out one prompt template across an item
 *      list; a bounded worker pool runs each expanded task as a child agent
 *      and the tool returns the aggregated per-item outcomes. On providers
 *      with continuable support each child is durable and the result carries
 *      its `childId`, so a later call may resume failed or partial items
 *      with follow-up instructions instead of restarting them from scratch.
 *      The tool is permanently model-visible, which is also the autonomous
 *      path: the model can choose it whenever a request decomposes into
 *      independent parallel subtasks.
 *   2. A `/swarm` command — the explicit path: wraps the user's task in a
 *      decomposition preamble and submits it as an ordinary user turn.
 *   3. A system-prompt section — short standing guidance on when batching
 *      beats repeated single delegation.
 *
 * Stability discipline: no global side effects beyond these registrations —
 * no context prototype mutation, no process-wide state. A kernel without the
 * subagent provider simply never mounts the tool or the command.
 *
 * @module @dsh-app/plugin-swarm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: pulls the ctx merges (tools / subagents / commands /
// systemPrompt) into scope without runtime imports.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { runSwarmBatch } from './orchestrator.ts'
import type { SwarmBatchOutcome } from './orchestrator.ts'
import { MIN_ITEMS, expandTasks } from './expand.ts'
import type { SwarmToolArgs } from './expand.ts'

export const name = 'plugin-swarm'
export const inject = ['tools', 'subagents', 'commands', 'systemPrompt']

/** Prompt order directly after the single-delegation policy section. */
const SWARM_SECTION_ORDER = 116.6

/** Config: provider, scheduling bounds, and child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (default `spawn`). */
  provider: string
  /** Hard cap on batch size (default 8). */
  maxItems: number
  /** Worker-pool size when the model does not request one (default 4). */
  defaultConcurrency: number
  /** Hard cap on worker-pool size (default 8). */
  maxConcurrency: number
  /**
   * Adaptive scheduling: item failures halve the live pool (floor 1) and
   * double the start stagger (cap 30s); a streak of clean completions grows
   * the pool back toward maxConcurrency and eases the stagger to base
   * (default true).
   */
  adaptive: boolean
  /**
   * Automatic retries per item after an error settle (continuable backend
   * only; the child continues from its preserved context). 0 disables
   * (default 2).
   */
  itemMaxRetries: number
  /** Base backoff before the first item retry, doubling per attempt (default 15000). */
  itemRetryDelayMs: number
  /** Per-item output truncation limit in characters (default 4000). */
  perItemOutputLimit: number
  /**
   * Batch token budget (default 0 = disabled). Once the summed usage of
   * settled children reaches this, the batch stops launching work; in-flight
   * children settle normally. Best-effort: children whose sessions are
   * unreadable contribute no accounting.
   */
  tokenBudget: number
  /** Delay between consecutive child starts in ms; smooths provider rate limits (default 800). */
  startStaggerMs: number
  /** Agent options applied to every child; omitted fields use child-loop defaults. */
  agentOptions?: AgentOptions
  /**
   * Absolute delegation-depth cap (harness-enforced). 1 = every child is a
   * leaf worker: children are created at depth 1 and their own delegation
   * attempts are refused, so all LLM load stays inside the batch's
   * concurrency gate. 0 would refuse child creation entirely (depth 1 > 0).
   */
  maxDepth: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  maxItems: z.natural().max(Number.MAX_SAFE_INTEGER).default(8),
  defaultConcurrency: z.natural().max(Number.MAX_SAFE_INTEGER).default(4),
  maxConcurrency: z.natural().max(Number.MAX_SAFE_INTEGER).default(8),
  adaptive: z.boolean().default(true),
  itemMaxRetries: z.natural().max(Number.MAX_SAFE_INTEGER).default(2),
  itemRetryDelayMs: z.natural().max(Number.MAX_SAFE_INTEGER).default(15000),
  perItemOutputLimit: z.natural().max(Number.MAX_SAFE_INTEGER).default(4000),
  tokenBudget: z.natural().max(Number.MAX_SAFE_INTEGER).default(0),
  startStaggerMs: z.natural().max(Number.MAX_SAFE_INTEGER).default(800),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string; model: string; maxTokens: number }),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(1),
})

/**
 * Standing guidance for the autonomous (tool-choice) path.
 *
 * Section text is interpolated by the platform's prompt renderer (every
 * double-brace group must be a registered variable), so this text must not
 * contain the tool's literal placeholder token — the exact syntax stays
 * documented in the tool's parameter descriptions, which are not interpolated.
 */
const SWARM_SECTION_TEXT =
  'When a request decomposes into multiple independent, non-overlapping subtasks that could run in parallel '
  + '(separate analyses, per-module edits in disjoint areas, batch lookups), prefer the swarm tool over repeated '
  + 'subagent calls: state the shared instructions once in prompt_template using the item placeholder token '
  + 'documented in the tool\'s parameter descriptions, list the varying part of each subtask in items, and '
  + 'synthesize the returned per-item results into one answer. '
  + 'Split quality decides batch quality. Each item must be self-contained: a child sees only its own expanded '
  + 'prompt, so spell out the input, the expected output, and the completion criterion of every subtask — write '
  + 'items a stranger could execute without asking questions. Good split for "add test coverage": one item per '
  + 'top-level module, each naming the module path, the test framework in use, and "new tests pass" as the '
  + 'criterion. Bad split: "write tests", "fix bugs", "clean up" — vague items produce vague, overlapping work. '
  + 'Never fan out subtasks that depend on each other or share mutable state; run those sequentially yourself or '
  + 'in a later batch. When every subtask needs the same background (project conventions, a file inventory), pass '
  + 'it once via shared_context instead of repeating it per item. For a large or unfamiliar split, call with '
  + 'dry_run first to inspect the expanded per-child prompts before spending the batch. '
  + 'Items that die from transient provider errors '
  + '(network, rate limit) are retried automatically and only report failure when the retries are exhausted. '
  + 'When a result item carries a childId, a later '
  + 'swarm call can resume that child with follow-up instructions via resume_entries — it keeps its prior context.'

/**
 * Decomposition directive used by the explicit /swarm command path. Submitted
 * as injected model-facing context (plugin source, notice form), so the chat
 * shows only a collapsed context row — the user's own message stays the plain
 * task text. The placeholder token stays literal here: injected context is
 * not run through the system-prompt variable interpolator.
 *
 * Wording note: models tend to start implementing directly, so the directive
 * must make the swarm call the FIRST action and explicitly forbid doing the
 * parallelizable work inline.
 */
const SWARM_COMMAND_DIRECTIVE =
  '[swarm 模式] 用户已明确要求用并行子代理执行以下任务。在采取任何其他行动（包括阅读文件、加载技能、'
  + '编写代码）之前，你必须先调用 swarm 工具：将任务拆分为相互独立、互不重叠的子任务，'
  + '在 prompt_template 中用 {{item}} 占位符书写共享指令，items 列出各子任务的差异部分；'
  + '等待全部子任务完成后，将结果汇总为最终答案。禁止自己逐个完成本可并行的子任务。'
  + '只有当任务本质上是串行的、确实无法安全并行化时，才简要说明原因并按普通方式执行。'

const SWARM_COMMAND_USAGE =
  '用法：/swarm <任务描述>\n将任务拆分为多个并行子代理执行，完成后自动汇总结果。\n示例：/swarm 为 src/api、src/ui、src/store 三个目录分别补充单元测试'


/** Clamp a requested pool size into the configured bounds. */
function resolveConcurrency(requested: number | undefined, config: Config): number {
  const value = requested !== undefined && Number.isFinite(requested) ? Math.floor(requested) : config.defaultConcurrency
  return Math.max(1, Math.min(value, config.maxConcurrency))
}

/** Render the batch outcome as the model-facing text form of the tool result. */
function renderBatch(outcome: SwarmBatchOutcome, warnings: readonly string[]): string {
  // peakConcurrency appears only on adaptive batches, where the live pool
  // legitimately differs from the requested steady-state size.
  const concurrencyNote = outcome.peakConcurrency === undefined
    ? `concurrency ${outcome.concurrency}`
    : `concurrency ${outcome.concurrency}, peak ${outcome.peakConcurrency}`
  const budgetNote = outcome.budgetExhausted === true ? ', TOKEN BUDGET EXHAUSTED — launch stopped early' : ''
  const usageNote = outcome.usage === undefined
    ? ''
    : `, tokens ${outcome.usage.totalTokens ?? outcome.usage.inputTokens + outcome.usage.outputTokens} (in ${outcome.usage.inputTokens} / out ${outcome.usage.outputTokens})`
  const header = `swarm "${outcome.label}": ${outcome.completed} completed, ${outcome.failed} failed, ${outcome.aborted} aborted (${concurrencyNote}, ${outcome.durationMs}ms${usageNote}${budgetNote})`
  const entries = outcome.items.map((item) => {
    const lines = [`[${item.index}] ${item.item}`, `status: ${item.status}`]
    // The child id is the handle a later resume_entries call needs; surface
    // it explicitly so the model does not have to infer it from elsewhere.
    if (item.childId !== undefined) lines.push(`childId: ${item.childId}`)
    if (item.failureKind !== undefined) lines.push(`failureKind: ${item.failureKind}`)
    if (item.failureCode !== undefined) lines.push(`failureCode: ${item.failureCode}`)
    if (item.durationMs !== undefined) lines.push(`durationMs: ${item.durationMs}`)
    if (item.usage !== undefined) lines.push(`tokens: ${item.usage.totalTokens ?? item.usage.inputTokens + item.usage.outputTokens}`)
    if (item.retries !== undefined && item.retries > 0) lines.push(`retries: ${item.retries}`)
    if (item.output !== undefined) lines.push(`output:\n${item.output}`)
    if (item.error !== undefined) lines.push(`error: ${item.error}`)
    return lines.join('\n')
  })
  const sections = [header]
  if (warnings.length > 0) sections.push(`split hints:\n${warnings.map(w => `- ${w}`).join('\n')}`)
  if (entries.length > 0) sections.push(entries.join('\n\n'))
  return sections.join('\n\n')
}

/** Render a dry-run preview: what WOULD run, nothing executed. */
function renderDryRun(output: SwarmToolOutput): string {
  const header = `swarm "${output.label}" (dry run, nothing executed): ${output.total} children would start (concurrency ${output.concurrency})`
  const previews = output.items.map(item => `[${item.index}] ${item.item}\nprompt:\n${item.prompt ?? ''}`)
  const sections = [header]
  if (output.warnings !== undefined && output.warnings.length > 0) {
    sections.push(`split hints:\n${output.warnings.map(w => `- ${w}`).join('\n')}`)
  }
  sections.push(previews.join('\n\n'))
  return sections.join('\n\n')
}

/** Render either tool output flavor to its model-facing text. */
function renderToolOutput(value: SwarmToolOutput): string {
  if (value.kind === 'swarm-dry-run') return renderDryRun(value)
  // Executed batches always carry durationMs (execute maps the outcome
  // verbatim); the fallback keeps a hand-shaped value renderable.
  return renderBatch({ ...value, durationMs: value.durationMs ?? 0 }, value.warnings ?? [])
}

/** Structured tool output: the batch outcome with the schema's field names. */
interface SwarmToolOutput {
  readonly kind: 'swarm' | 'swarm-dry-run'
  readonly label: string
  readonly concurrency: number
  readonly peakConcurrency?: number
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly aborted: number
  readonly durationMs?: number
  readonly budgetExhausted?: boolean
  readonly usage?: TokenUsage
  readonly warnings?: readonly string[]
  readonly items: readonly SwarmItemOutput[]
}

/** One item row of the tool output; a dry-run row carries `prompt` instead. */
interface SwarmItemOutput {
  readonly index: number
  readonly item: string
  readonly status: 'completed' | 'failed' | 'aborted'
  readonly childId?: string
  readonly output?: string
  readonly error?: string
  readonly failureKind?: 'transport' | 'content' | 'structural'
  readonly failureCode?: string
  readonly durationMs?: number
  readonly usage?: TokenUsage
  readonly retries?: number
  readonly prompt?: string
}

export function apply(ctx: Context, config: Config): void {
  assertSubagentMaxDepth(config.maxDepth)
  if (config.maxItems < MIN_ITEMS) {
    throw new Error(`plugin-swarm: maxItems must be at least ${MIN_ITEMS}`)
  }
  if (config.defaultConcurrency < 1 || config.maxConcurrency < 1) {
    throw new Error('plugin-swarm: defaultConcurrency and maxConcurrency must be at least 1')
  }

  // The tool, the command, and the prompt section all follow the provider's
  // lifecycle: sibling load order and HMR replacement can change provider
  // availability while this fiber remains active.
  let disposeMounted: (() => void) | undefined

  const mount = (): void => {
    const disposers: (() => void)[] = []

    disposers.push(ctx.tools.register(defineTool({
      name: 'swarm',
      description:
        'Fan a batch of parallel subagents over a list of items: one shared prompt template (containing an '
        + '{{item}} placeholder) is expanded once per item, every expanded task runs as an independent subagent '
        + '(its own context, no parent conversation), and the tool returns each item\'s terminal outcome and '
        + 'final output. When the configured provider supports continuable children, each child is durable: its '
        + 'result item carries a childId, and a later swarm call can resume that child with follow-up '
        + 'instructions through resume_entries — it keeps its full prior context instead of restarting from '
        + 'scratch (e.g. retry a failed item, ask for refinements). Use this when a request decomposes into '
        + 'multiple independent, non-overlapping subtasks that are worth running at once — batch analyses, '
        + 'per-module edits in disjoint areas, parallel lookups. Prefer it over calling the subagent tool '
        + 'repeatedly: one call, one aggregated result. Items must be self-contained (each child sees only its '
        + 'expanded prompt) and must not depend on each other: write each item with its input, expected output, '
        + 'and completion criterion, and pass background every subtask shares via shared_context. Unsure about a '
        + 'split? Call with dry_run to preview the expanded per-child prompts before running them. Children run '
        + 'with the full tool set by default; '
        + 'for read-only batches (analysis, review, lookups) pass tool_filter to scope every child to read/search '
        + 'tools only.',
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-6 word) label for the batch, for display.',
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'The varying part of each fresh subtask, one entry per new child. Required (with prompt_template) unless resume_entries alone forms the batch. Entries must be distinct.',
        },
        prompt_template: {
          type: 'string',
          description: 'The complete, self-contained instructions shared by every fresh child, with an {{item}} placeholder where each entry of `items` is substituted. Required when `items` is present. Include everything a child needs — it sees no other context. State the expected output and the completion criterion explicitly.',
        },
        shared_context: {
          type: 'string',
          description: 'Optional background text prepended to every FRESH child\'s prompt (project conventions, file inventory, constraints every subtask shares). Pass shared background once here instead of repeating it inside the template or every item. Ignored for resume_entries — a resumed child keeps its existing context.',
        },
        resume_entries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              child_id: {
                type: 'string',
                required: true,
                description: 'The childId of a prior swarm result item.',
              },
              followup: {
                type: 'string',
                required: true,
                description: 'The complete follow-up message the child receives as its next turn; it retains all prior context.',
              },
            },
          },
          description: 'Optional entries resuming prior swarm children by their childId. Each followup becomes the child\'s next turn with its full prior context — the natural way to retry failed items or request refinements. Requires a provider with continuable support (the previous result indicated it by including childId); may be combined with fresh items.',
        },
        max_concurrency: {
          type: 'number',
          description: 'Optional worker-pool size (how many children run simultaneously). Pins the batch pool: adaptive scheduling may run below it after failures and recover back to it, but never above it. Values outside the configured bounds are clamped; omit to use the deployment default.',
        },
        tool_filter: {
          type: 'object',
          additionalProperties: false,
          properties: {
            allow: {
              type: 'array',
              items: { type: 'string' },
              description: 'Global tool names that stay visible to every child; everything else is removed. Omit to keep all tools.',
            },
            deny: {
              type: 'array',
              items: { type: 'string' },
              description: 'Global tool names removed from every child. Omit to remove none.',
            },
          },
          description: 'Optional tool scoping applied to EVERY child in the batch. Children otherwise run with the full tool set — for read-only batches (analysis, review, lookups) pass an allow-list of read/search tools so no child can write files the parent never audits. Applies to fresh children at creation; resumed children keep the tool set they were created with.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, validate the batch and return each child\'s fully expanded prompt WITHOUT running anything. Use it to inspect a large or unfamiliar split before spending the batch; fix the split from the preview, then call again without dry_run.',
        },
        token_budget: {
          type: 'number',
          description: 'Optional batch token budget: once the summed usage of settled children reaches this, the batch stops launching new work (in-flight children settle normally; unstarted items report aborted with budgetExhausted set). Omit to use the deployment default (0 = no budget).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 'swarm' = executed batch; 'swarm-dry-run' = validated preview only.
            kind: { type: 'string', required: true, enum: ['swarm', 'swarm-dry-run'] },
            label: { type: 'string', required: true },
            concurrency: { type: 'number', required: true },
            // Present only on adaptive batches: the highest simultaneous
            // live children actually observed.
            peakConcurrency: { type: 'number' },
            total: { type: 'number', required: true },
            completed: { type: 'number', required: true },
            failed: { type: 'number', required: true },
            aborted: { type: 'number', required: true },
            // Whole-batch wall time in ms (executed batches only).
            durationMs: { type: 'number' },
            // True when the token budget stopped the batch early.
            budgetExhausted: { type: 'boolean' },
            // Batch-wide token accounting (absent when no child reported usage).
            usage: {
              type: 'object',
              additionalProperties: false,
              properties: {
                inputTokens: { type: 'number', required: true },
                outputTokens: { type: 'number', required: true },
                totalTokens: { type: 'number' },
              },
            },
            // Non-blocking split-quality hints from expansion.
            warnings: { type: 'array', items: { type: 'string' } },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'number', required: true },
                  item: { type: 'string', required: true },
                  status: { type: 'string', required: true, enum: ['completed', 'failed', 'aborted'] },
                  // Present only when the child is durable (continuable
                  // backend): the handle resume_entries addresses.
                  childId: { type: 'string' },
                  output: { type: 'string' },
                  error: { type: 'string' },
                  // Why a failed item failed: transport (provider/network;
                  // throttles the pool, auto-retried unless terminal like
                  // QUOTA), content (the task itself), structural (the call
                  // was unsound).
                  failureKind: { type: 'string', enum: ['transport', 'content', 'structural'] },
                  // The provider-neutral failure code (e.g. RATE_LIMIT).
                  failureCode: { type: 'string' },
                  // Wall time of this item's settled attempt(s) in ms.
                  durationMs: { type: 'number' },
                  // Token accounting recovered from the child session.
                  usage: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      inputTokens: { type: 'number', required: true },
                      outputTokens: { type: 'number', required: true },
                      totalTokens: { type: 'number' },
                    },
                  },
                  // Present when the item needed automatic retries to settle.
                  retries: { type: 'number' },
                  // Dry-run only: the fully expanded prompt the child WOULD
                  // receive (status is always 'aborted' on a dry run).
                  prompt: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderToolOutput(value as SwarmToolOutput) }],
        // Project the structured outcome so presentResult (and any future UI
        // bridge) reads typed data instead of re-parsing the rendered text.
        presentationMeta: (_args, value) => value,
      },
      // Children never mutate the parent session; the only parent-owned write
      // (task bookkeeping) is a synchronous commutative insertion, so sibling
      // swarm calls in one assistant message may overlap. Resume-carrying
      // calls are excluded: two batches following up the same child
      // concurrently would each settle on the child's first epoch end and
      // misattribute its output.
      isConcurrencySafe: (args) => args.resume_entries === undefined,
      // Pending card: batch scale at a glance while the children run. Live
      // per-child progress is the subagent UI's own surface; this card owns
      // the batch-level summary.
      presentCall(args) {
        return {
          card: 'generic',
          title: `swarm · ${args.description}`,
          kind: 'other',
          rawInput: {
            items: args.items?.length ?? 0,
            resumes: args.resume_entries?.length ?? 0,
            concurrency: resolveConcurrency(args.max_concurrency, config),
            template: args.prompt_template,
            ...args.shared_context !== undefined ? { sharedContext: true } : {},
            ...args.dry_run === true ? { dryRun: true } : {},
          },
        }
      },
      // Completed card: the aggregated outcome, one status line per item.
      presentResult(args, result) {
        const value = result.meta as unknown as SwarmToolOutput | undefined
        if (value === undefined || typeof value !== 'object' || value.kind !== 'swarm') return undefined
        const lines = value.items.map((item) => {
          const mark = item.status === 'completed' ? '✓' : item.status === 'failed' ? '✗' : '−'
          return `${mark} [${item.index}] ${item.item}`
        })
        return {
          card: 'generic',
          title: `swarm · ${args.description} — ${value.completed}/${value.total} 完成`,
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          throw new Error('swarm tool requires a calling agent (exec.agent was undefined)')
        }
        // Fail a resume batch up front when the provider cannot back it: the
        // alternative (fresh items succeed, resume items fail mid-batch) wastes
        // the whole call and reports a confusing half-outcome.
        if (args.resume_entries !== undefined && args.resume_entries.length > 0) {
          const provider = ctx.subagents.getProvider(config.provider)
          if (provider?.prepareContinuable === undefined) {
            throw new Error(`swarm: resume_entries need a provider with continuable children, but provider "${config.provider}" does not support them — restart the failed work as fresh items instead`)
          }
        }
        const expanded = expandTasks(args, config.maxItems)
        const concurrency = resolveConcurrency(args.max_concurrency, config)
        const label = args.description.trim().length > 0 ? args.description : 'swarm batch'
        if (args.dry_run === true) {
          // Validation + expansion only: the model inspects what WOULD run.
          return {
            kind: 'swarm-dry-run' as const,
            label,
            concurrency,
            total: expanded.tasks.length,
            completed: 0,
            failed: 0,
            aborted: expanded.tasks.length,
            ...expanded.warnings.length > 0 ? { warnings: expanded.warnings } : {},
            items: expanded.tasks.map(task => ({
              index: task.index,
              item: task.item,
              status: 'aborted' as const,
              prompt: task.prompt,
            })),
          }
        }
        const outcome = await runSwarmBatch(ctx, {
          provider: config.provider,
          parent,
          signal: exec.signal,
          label,
          tasks: expanded.tasks,
          concurrency,
          // An explicit max_concurrency pins the pool: adaptive feedback may
          // shrink below it and recover back to it, but never exceed it.
          maxConcurrency: config.maxConcurrency,
          adaptive: config.adaptive,
          itemMaxRetries: config.itemMaxRetries,
          itemRetryDelayMs: config.itemRetryDelayMs,
          outputLimit: config.perItemOutputLimit,
          startStaggerMs: config.startStaggerMs,
          tokenBudget: args.token_budget !== undefined && Number.isFinite(args.token_budget)
            ? Math.max(0, Math.floor(args.token_budget))
            : config.tokenBudget,
          ...config.agentOptions !== undefined ? { agentOptions: config.agentOptions } : {},
          ...args.tool_filter !== undefined ? { toolFilter: args.tool_filter } : {},
          maxDepth: config.maxDepth,
        })
        if (exec.signal.aborted) {
          throw new Error('swarm batch was cancelled')
        }
        if (outcome.completed === 0 && outcome.failed > 0) {
          // Every child failed: surface the batch as a tool error so the model
          // retries or escalates instead of treating the batch as a success.
          // The dominant failure class decides the advice: transport outages
          // are worth a wholesale resume, content failures need better items.
          const failures = outcome.items.filter(item => item.status === 'failed')
          const transportCount = failures.filter(item => item.failureKind === 'transport').length
          const advice = failures.every(item => item.failureCode === 'QUOTA')
            ? 'the account quota/balance is exhausted — top up or switch provider, then resume the failed children via resume_entries'
            : transportCount === failures.length
              ? 'all failures look transient (provider/network); wait a moment, then resume the failed children via resume_entries'
              : 'failures are content/structural, not transient — revise the failing items instead of retrying them unchanged'
          const detail = failures
            .map(item => `[${item.index}] ${item.item}: ${item.error ?? 'unknown failure'}`)
            .join('\n')
          throw new Error(`swarm batch "${outcome.label}" failed on every item (${advice}):\n${detail}`)
        }
        return {
          kind: 'swarm' as const,
          label: outcome.label,
          concurrency: outcome.concurrency,
          ...outcome.peakConcurrency !== undefined ? { peakConcurrency: outcome.peakConcurrency } : {},
          total: outcome.total,
          completed: outcome.completed,
          failed: outcome.failed,
          aborted: outcome.aborted,
          durationMs: outcome.durationMs,
          ...outcome.budgetExhausted === true ? { budgetExhausted: true } : {},
          ...outcome.usage !== undefined ? { usage: outcome.usage } : {},
          ...expanded.warnings.length > 0 ? { warnings: expanded.warnings } : {},
          items: [...outcome.items],
        }
      },
    })))

    disposers.push(ctx.commands.register({
      name: 'swarm',
      description: '并行子代理：将任务拆分为多个并行子代理执行，完成后自动汇总',
      input: { hint: '描述要并行执行的任务，例如：为这三个模块分别补充单元测试' },
      handler: (invocation): CommandResult => {
        const task = invocation.rawInput.trim()
        if (task.length === 0) {
          return { kind: 'error', text: SWARM_COMMAND_USAGE }
        }
        // Two-part submission: the decomposition directive rides as injected
        // model-facing context (rendered as a collapsed context row, not a
        // user bubble), and the plain task text becomes the visible user turn
        // that wakes the driver. The injected batch is claimed by the same
        // turn's pre-step, so the model sees directive + task together.
        const agent = invocation.agent
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: SWARM_COMMAND_DIRECTIVE }],
          source: { kind: 'plugin', plugin: 'swarm', form: 'notice', summary: 'swarm 模式：任务将拆分为并行子代理执行' },
        }))
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: task }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: '任务已按并行子代理模式发送，正在拆分执行…' }
      },
    }))

    disposers.push(ctx.systemPrompt.section({
      name: 'tool:swarm',
      order: SWARM_SECTION_ORDER,
      // The section's lifetime is exactly the tool's, so the guidance never
      // outlives the tool it advertises.
      text: SWARM_SECTION_TEXT,
    }))

    disposeMounted = () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }

  // Register listeners before checking presence so no synchronous change is missed.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeMounted === undefined) mount()
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeMounted === undefined) return
    disposeMounted()
    disposeMounted = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount()
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the swarm tool and /swarm command will register when it appears`)
  }
}
