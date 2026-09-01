/**
 * The three LLM tools over the two-level store:
 *   `memory_save`   — append one entry, routed by scope (project default,
 *                     global explicit); the project is resolved from the
 *                     executing agent's session cwd, never from model input.
 *   `memory_recall` — read the files in full (all/global/project scope).
 *   `memory_forget` — remove entries by content match, so a corrected or
 *                     retracted fact REPLACES its stale entry instead of
 *                     piling up contradicting ones.
 *
 * Model-driven proactive saving — the model observes durable facts and
 * records them without waiting to be asked — with the store as the
 * single source of truth and the master toggle honored at execute time (a
 * disabled plugin answers "disabled" instead of throwing, so the model can
 * tell the user instead of retrying).
 *
 * @module @dsh-app/plugin-memory/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_ENTRY_CHARS, type MemoryRoot, type MemoryStore } from './memory-store.ts'
import { MEMORY_CATEGORIES } from './types.ts'

/** Hard ceiling for recall output; a runaway file must not flood the
 * context either. */
const MAX_RECALL_CHARS = 50_000

/** Where a save lands / what a recall reads. */
const SCOPES = ['project', 'global'] as const
const RECALL_SCOPES = ['all', 'global', 'project'] as const

/** The executing agent's workspace path, when an agent is attached. */
function execCwd(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Register both memory tools on the context.
 * @param ctx - host plugin context (tools service).
 * @param root - the two-level memory root.
 * @returns disposer removing both registrations.
 */
export function registerMemoryTools(ctx: Context, root: MemoryRoot): () => void {
  const disposeSave = ctx.tools.register(defineTool({
    name: 'memory_save',
    description:
      'Append one entry to the persistent cross-session memory. Scope "project" (default) saves to the '
      + 'current workspace\'s memory — decisions, conventions, lessons seen only by sessions of this '
      + 'project; scope "global" saves a cross-project user preference or habit. One concise line, in '
      + 'the user\'s language. NEVER save API keys, tokens, passwords, or credentials. These files are '
      + 're-injected into future sessions; keep entries lean.',
    parameters: {
      category: {
        type: 'string',
        required: true,
        enum: [...MEMORY_CATEGORIES],
        description: 'preference (user taste/habit) | convention (project rule) | decision (settled choice) | lesson (root cause/pitfall) | fact (durable context)',
      },
      content: {
        type: 'string',
        required: true,
        description: `One line, at most ${String(MAX_ENTRY_CHARS)} characters; the date is stamped automatically.`,
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        description: 'project (default) = current workspace only; global = every project',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    execute(args, exec: ToolRunContext): Promise<JsonValue> {
      if (!root.global.isEnabled()) {
        return Promise.resolve({ saved: false, reason: 'disabled' } as unknown as JsonValue)
      }
      const content = String(args.content ?? '').trim()
      if (content === '') {
        return Promise.resolve({ saved: false, reason: 'empty content' } as unknown as JsonValue)
      }
      if (content.length > MAX_ENTRY_CHARS) {
        return Promise.resolve({
          saved: false,
          reason: `content too long (${String(content.length)}/${String(MAX_ENTRY_CHARS)} chars); rewrite it as one lean line`,
        } as unknown as JsonValue)
      }
      const scope = args.scope === 'global' ? 'global' : 'project'
      const cwd = execCwd(exec)
      if (scope === 'project' && cwd === undefined) {
        return Promise.resolve({
          saved: false,
          reason: 'no active workspace for a project-scoped save; retry with scope "global" if this is a cross-project preference',
        } as unknown as JsonValue)
      }
      const store = scope === 'global' ? root.global : root.projectFor(cwd as string)
      if (store.hasContent(content)) {
        return Promise.resolve({
          saved: false,
          reason: 'duplicate: an entry with this content is already saved; if the user CORRECTED it, remove the old one with memory_forget first',
        } as unknown as JsonValue)
      }
      const line = store.append(args.category as (typeof MEMORY_CATEGORIES)[number], content)
      return Promise.resolve({ saved: true, scope, entry: line } as unknown as JsonValue)
    },
  }))

  const disposeRecall = ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Read the persistent memory files in full (the injected copy of each is truncated when the file '
      + 'grows large). Default scope "all" returns the global file plus the current project\'s file, '
      + 'clearly separated — use it to review saved entries before saving a near-duplicate.',
    parameters: {
      scope: {
        type: 'string',
        enum: [...RECALL_SCOPES],
        description: 'all (default) | global | project',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    execute(args, exec: ToolRunContext): Promise<JsonValue> {
      if (!root.global.isEnabled()) {
        return Promise.resolve({ reason: 'disabled' } as unknown as JsonValue)
      }
      const scope = args.scope === 'global' || args.scope === 'project' ? args.scope : 'all'
      const cwd = execCwd(exec)
      if (scope === 'project' && cwd === undefined) {
        return Promise.resolve({ reason: 'no active workspace' } as unknown as JsonValue)
      }
      const cap = (text: string): { truncated: boolean, content: string } => ({
        truncated: text.length > MAX_RECALL_CHARS,
        content: text.length > MAX_RECALL_CHARS ? text.slice(0, MAX_RECALL_CHARS) : text,
      })
      if (scope === 'global') {
        return Promise.resolve({ global: cap(root.global.read()) } as unknown as JsonValue)
      }
      if (scope === 'project') {
        return Promise.resolve({ project: cap(root.projectFor(cwd as string).read()) } as unknown as JsonValue)
      }
      return Promise.resolve({
        global: cap(root.global.read()),
        project: cwd === undefined ? undefined : cap(root.projectFor(cwd).read()),
      } as unknown as JsonValue)
    },
  }))

  const disposeForget = ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Remove saved memory entries whose content matches the given text (case-insensitive substring after '
      + 'normalization; Chinese is matched natively). Use it when the user corrects or retracts a fact that '
      + 'is already saved: remove the stale entry, then save the corrected fact with memory_save — never '
      + 'leave contradicting entries side by side. Returns the exact lines removed.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'Text matched against the CONTENT of saved entries (not their category/date): pass the '
          + 'fact itself or a distinctive keyword of it, e.g. "pnpm". Empty or category-only matches are rejected.',
      },
      scope: {
        type: 'string',
        enum: ['all', 'global', 'project'],
        description: 'all (default) = global + current project; global; project',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    execute(args, exec: ToolRunContext): Promise<JsonValue> {
      if (!root.global.isEnabled()) {
        return Promise.resolve({ forgotten: 0, reason: 'disabled' } as unknown as JsonValue)
      }
      const match = String(args.match ?? '').trim()
      if (match === '') {
        return Promise.resolve({ forgotten: 0, reason: 'empty match' } as unknown as JsonValue)
      }
      const scope = args.scope === 'global' || args.scope === 'project' ? args.scope : 'all'
      const cwd = execCwd(exec)
      if (scope !== 'global' && cwd === undefined) {
        return Promise.resolve({
          forgotten: 0,
          reason: 'no active workspace for a project-scoped forget; retry with scope "global"',
        } as unknown as JsonValue)
      }
      const targets: Array<['global' | 'project', MemoryStore]> = scope === 'global'
        ? [['global', root.global]]
        : scope === 'project'
          ? [['project', root.projectFor(cwd as string)]]
          : [['global', root.global], ['project', root.projectFor(cwd as string)]]
      const perScope: Record<string, { forgotten: number, remaining: number, removed: string[] }> = {}
      for (const [label, store] of targets) {
        const { removed, remaining } = store.forget(match)
        perScope[label] = { forgotten: removed.length, remaining, removed }
      }
      return Promise.resolve({ forgotten: targets.reduce((sum, [label]) => sum + perScope[label]!.forgotten, 0), scopes: perScope } as unknown as JsonValue)
    },
  }))

  return () => {
    disposeSave()
    disposeRecall()
    disposeForget()
  }
}
