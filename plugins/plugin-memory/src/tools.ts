/**
 * The three LLM tools over the two-level topic-card store:
 *   `memory_save`   — UPSERT one card by topic key (create or rewrite in
 *                     place; a correction is the same key saved again, never
 *                     a second card), routed by scope (project default,
 *                     global explicit); the project is resolved from the
 *                     executing agent's session cwd, never from model input.
 *   `memory_recall` — read cards (all/global/project scope), one card by
 *                     exact topic, or a keyword filter over key+summary+body.
 *   `memory_forget` — DELETE cards by exact topic key or content match, so a
 *                     retracted fact disappears instead of contradicting its
 *                     replacement.
 *
 * Write-time anti-redundancy gate (the topic model's boundary-overlap
 * defense): a NEW key whose content is ≥ SIM_DUPLICATE similar to an existing
 * card is rejected with a pointer to that card (save the same topic again to
 * update it); a [SIM_RELATED, SIM_DUPLICATE) hit is accepted but reported so
 * the model can consolidate or link.
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
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the agents Context merge (ctx.agents) into scope.
import type {} from '@deepseek-ai/dsh-agent'
import {
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  SIM_DUPLICATE,
  SIM_RELATED,
  containsCredential,
  slugifyTopic,
  stripCommitIds,
  validateCardInput,
  type MemoryRoot,
  type MemoryStore,
  type TopicCard,
} from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'
import { CARD_TEXT_DISCIPLINE } from './card-discipline.ts'

/** Hard ceiling for recall output; a runaway scope must not flood the
 * context either. */
const MAX_RECALL_CHARS = 50_000

/**
 * The `memory_save` tool description. Exported because it is a PROMPT SURFACE
 * — the model reads it at every call site — so it carries the shared
 * card-text discipline like the other three surfaces (see the
 * `card-discipline` module, which lists them for the tests to walk).
 */
export const SAVE_TOOL_DESCRIPTION =
  'Save one topic card to the persistent cross-session memory. The topic key is the card\'s '
  + 'identity: saving the SAME topic again rewrites the card (use that to correct or extend a '
  + 'fact — never create a second card for one subject). Check the injected index BEFORE saving: '
  + 'if a card already covers the subject, update that topic instead. Scope "project" (default) '
  + 'saves to the current workspace\'s memory — decisions, conventions, lessons seen only by '
  + 'sessions of this project. Scope "global" saves a cross-project user preference or habit, '
  + 'and is the ONLY path by which the global scope grows from work like this: the background '
  + 'pass writes project memory only, so a genuinely cross-workspace fact has to be saved here '
  + 'or it will not be remembered. NEVER save API keys, tokens, passwords, or credentials. '
  + 'These cards are re-injected into future sessions; keep them lean.\n'
  + CARD_TEXT_DISCIPLINE

/** Where a save lands / what a recall reads. */
const SCOPES = ['project', 'global'] as const
const RECALL_SCOPES = ['all', 'global', 'project'] as const

/** The executing agent's workspace path, when an agent is attached. */
function execCwd(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** The recall/export view of one card. */
function cardView(card: TopicCard, pinned: ReadonlySet<string>): Record<string, unknown> {
  return {
    topic: card.name,
    category: card.category,
    summary: card.summary,
    updated: card.updated,
    pinned: pinned.has(card.name),
    body: card.body,
    ...(card.malformed ? { malformed: true } : {}),
  }
}

/**
 * Register the memory tools on the context.
 * @param ctx - host plugin context (tools service).
 * @param root - the two-level memory root.
 * @param onSaved - called after a save actually persisted (created/updated —
 *   an unchanged no-op does not re-arm the background passes); receives the
 *   executing agent, its session id, and the affected store for the light
 *   sweep.
 * @returns disposer removing all registrations.
 */
export function registerMemoryTools(
  ctx: Context,
  root: MemoryRoot,
  onSaved?: (
    parent: NonNullable<ReturnType<Context['agents']['get']>>,
    sessionId: SessionId,
    store: MemoryStore,
  ) => void | Promise<void>,
): () => void {
  const disposeSave = ctx.tools.register(defineTool({
    name: 'memory_save',
    description: SAVE_TOOL_DESCRIPTION,
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Stable ASCII kebab-case key naming the SUBJECT (e.g. "pnpm11-allowscripts"). '
          + 'Translate Chinese subjects into English keys. The same subject always uses the same key.',
      },
      category: {
        type: 'string',
        required: true,
        enum: [...MEMORY_CATEGORIES],
        description: 'preference (user taste/habit) | convention (project rule) | decision (settled choice) | lesson (root cause/pitfall) | fact (durable context)',
      },
      summary: {
        type: 'string',
        description: `Index hook, at most ${String(MAX_SUMMARY_CHARS)} characters: what the card covers, `
          + 'so future saves route by it. Required when CREATING a topic; omit when updating to keep the old one.',
      },
      content: {
        type: 'string',
        required: true,
        description: `One concise paragraph in the user's language, at most ${String(MAX_TOPIC_BODY_CHARS)} characters; `
          + 'no dates and no "- [category]" prefix (the host stamps the metadata).',
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
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      if (!root.global.isEnabled()) {
        return Promise.resolve({ saved: false, reason: 'disabled' } as unknown as JsonValue)
      }
      const topic = slugifyTopic(String(args.topic ?? ''))
      if (topic === '') {
        return Promise.resolve({
          saved: false,
          reason: 'topic must contain at least one ASCII letter or digit (use kebab-case English, e.g. "pnpm11-allowscripts")',
        } as unknown as JsonValue)
      }
      const content = stripCommitIds(String(args.content ?? '').trim())
      if (content === '') {
        return Promise.resolve({ saved: false, reason: 'empty content' } as unknown as JsonValue)
      }
      const category = args.category
      if (typeof category !== 'string' || !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        return Promise.resolve({
          saved: false,
          reason: `unknown category "${String(args.category ?? '')}"; must be one of: ${MEMORY_CATEGORIES.join(', ')}`,
        } as unknown as JsonValue)
      }
      if (containsCredential(content)) {
        return Promise.resolve({
          saved: false,
          reason: '内容可能包含密钥或凭据，拒绝保存；如确需记录请先脱敏再保存',
        } as unknown as JsonValue)
      }
      const summary = typeof args.summary === 'string' ? stripCommitIds(args.summary.trim()) : ''
      if (containsCredential(summary)) {
        return Promise.resolve({
          saved: false,
          reason: 'summary 可能包含密钥或凭据，拒绝保存；索引行会注入每个会话，敏感信息一律不落盘',
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
      const existing = store.get(topic)
      if (existing === undefined) {
        // Write-time gate: a new key must not be a near-duplicate of a card
        // the index already covers under another name.
        const invalid = validateCardInput({ name: topic, category, summary, body: content })
        if (invalid !== undefined) {
          return Promise.resolve({ saved: false, reason: invalid } as unknown as JsonValue)
        }
        const similar = store.findSimilar(content)
        const dup = similar.find(hit => hit.score >= SIM_DUPLICATE)
        if (dup !== undefined) {
          return Promise.resolve({
            saved: false,
            reason: `duplicate-of: topic "${dup.name}" already covers this (similarity ${dup.score.toFixed(2)}); save THAT topic again with the revised content instead`,
            existing: dup.name,
          } as unknown as JsonValue)
        }
        const related = similar.filter(hit => hit.score >= SIM_RELATED && hit.score < SIM_DUPLICATE).map(hit => hit.name)
        const { op } = await store.upsert({ name: topic, category: category as MemoryCategory, summary, body: content })
        return Promise.resolve(finishSave({ saved: true, op, topic, scope, ...(related.length > 0 ? { related } : {}) } as Record<string, unknown>, store, exec) as unknown as JsonValue)
      }
      // Update path: same key rewrites the card; the summary is inherited
      // when omitted so an update cannot accidentally blank the index hook.
      // Pre-validate with the MERGED summary: the store throws on invalid
      // input, but the model deserves a structured, correctable reason.
      const invalid = validateCardInput({
        name: topic,
        category,
        summary: summary !== '' ? summary : existing.summary,
        body: content,
      })
      if (invalid !== undefined) {
        return Promise.resolve({ saved: false, reason: invalid } as unknown as JsonValue)
      }
      const { op } = await store.upsert({
        name: topic,
        category: category as MemoryCategory,
        ...(summary !== '' ? { summary } : {}),
        body: content,
      })
      return Promise.resolve(finishSave({ saved: true, op, topic, scope } as Record<string, unknown>, store, exec) as unknown as JsonValue)
    },
  }))

  /** Shared tail of the save paths: own-save marker + background trigger
   *  only when the store actually changed. */
  async function finishSave(result: Record<string, unknown>, store: MemoryStore, exec: ToolRunContext): Promise<Record<string, unknown>> {
    if (result.op === 'unchanged') return result
    // The direct path consolidates too: without this, a project whose cards
    // all arrive through memory_save (never through a distill run) could grow
    // forever with the curator never receiving a trigger. `ctx.get` (not
    // `ctx.agents`): the tools mount without declaring the agents service,
    // and property access would throw on an undeclared key.
    const agent = exec.agent
    if (agent !== undefined) {
      const events = (agent.session as { snapshotEvents?: () => ReadonlyArray<{ seq: number }> })
        .snapshotEvents?.()
      const seq = events !== undefined && events.length > 0 ? events[events.length - 1]!.seq : 0
      root.recordDirectSave(agent.id, seq)
    }
    const agents = ctx.get('agents') as { get(id: SessionId): unknown } | undefined
    const parent = agent === undefined ? undefined : agents?.get(agent.id)
    if (parent !== undefined && agent !== undefined) {
      await onSaved?.(parent as NonNullable<ReturnType<Context['agents']['get']>>, agent.id, store)
    }
    return result
  }

  const disposeRecall = ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Read the persistent memory. Default scope "all" returns the global cards plus the current '
      + 'project\'s cards, clearly separated. Pass topic to fetch ONE card by its exact key from the '
      + 'index (the full body, even when it was not injected); pass query to filter by keyword over '
      + 'topic+summary+body. Prefer those targeted forms over reading everything.',
    parameters: {
      scope: {
        type: 'string',
        enum: [...RECALL_SCOPES],
        description: 'all (default) | global | project',
      },
      topic: {
        type: 'string',
        description: 'Exact topic key from the index; returns just that card (with a found flag).',
      },
      query: {
        type: 'string',
        description: 'Optional keyword filter (normalized, Chinese-native substring) over '
          + 'topic+summary+body, with the scope\'s total card count so a filtered view is never '
          + 'mistaken for the whole memory.',
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
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const topic = typeof args.topic === 'string' && args.topic.trim() !== '' ? slugifyTopic(args.topic) : ''
      const cwd = execCwd(exec)
      if (scope === 'project' && cwd === undefined) {
        return Promise.resolve({ reason: 'no active workspace' } as unknown as JsonValue)
      }
      const view = (store: MemoryStore): Record<string, unknown> => {
        const pinned = store.pinnedSet()
        if (topic !== '') {
          const card = store.get(topic)
          return card === undefined
            ? { found: false, topic }
            : { found: true, card: cardView(card, pinned) }
        }
        const cards = query === '' ? store.list() : store.search(query)
        // Cap by dropping the tail (oldest-updated cards first), never by
        // slicing the JSON text — a truncated card array must stay valid.
        const views = cards.map(card => cardView(card, pinned))
        let truncated = false
        while (views.length > 0 && JSON.stringify(views).length > MAX_RECALL_CHARS) {
          views.pop()
          truncated = true
        }
        return {
          cards: views,
          truncated,
          total: store.list().length,
          ...(query === '' ? {} : { matched: cards.length }),
        }
      }
      if (scope === 'global') {
        return Promise.resolve({ global: view(root.global) } as unknown as JsonValue)
      }
      if (scope === 'project') {
        return Promise.resolve({ project: view(root.projectFor(cwd as string)) } as unknown as JsonValue)
      }
      return Promise.resolve({
        global: view(root.global),
        project: cwd === undefined ? undefined : view(root.projectFor(cwd)),
      } as unknown as JsonValue)
    },
  }))

  const disposeForget = ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'DELETE saved memory cards: pass a topic key from the index to drop exactly that card, or any '
      + 'text to delete every card whose summary/body matches it (case-insensitive substring after '
      + 'normalization; Chinese is matched natively). Use it when the user retracts a fact entirely '
      + '— to CORRECT a fact, save the same topic again with the revised content instead. Returns '
      + 'the topic keys removed.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'A topic key (exact card delete) or free text matched against summary+body of '
          + 'saved cards. Empty matches are rejected.',
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
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
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
        // The store records the ledger entry itself (see MemoryStore.forget),
        // so every delete path is covered by construction.
        const { removed, remaining } = await store.forget(match)
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
