/**
 * The background distiller — the code-guaranteed half of proactive memory.
 *
 * While the in-session `memory_save` tool relies on the model noticing
 * durable facts, this pass makes persistence deterministic: after a session
 * goes quiet for {@link QUIET_MS}, a ONE-SHOT read-only subagent reviews the
 * conversation delta since the last distill plus the current memory files
 * and proposes NEW entries as structured JSON. The HOST validates every
 * entry (category, length, dedup against existing lines) before it ever
 * reaches a memory file — the child cannot write anything itself.
 *
 * Design points:
 *   - Debounce: every `turn/end` re-arms the quiet timer, so an active
 *     conversation never pays for a distill; a cold session at timer fire is
 *     skipped (its progress stays, the next activation re-distills the gap).
 *   - Incremental: `distill-state.json` records the last-consumed event seq
 *     per session, so repeat distills cost only the delta.
 *   - Self-exclusion: subagent sessions (`origin: 'subagent'`) never trigger
 *     distills — the distiller must not distill itself.
 *   - Fail-soft: any failure logs a warning and leaves progress unchanged,
 *     so the next quiet window retries the same delta.
 *
 * @module @dsh-app/plugin-memory/distiller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the subagents Context merge (ctx.subagents) into scope.
import type {} from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { MAX_ENTRY_CHARS, normalizeForMatch, parseEntries, shortSessionId, type MemoryRoot, type MemoryStore } from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/**
 * Quiet window after the last turn before a distill fires (60 s).
 *
 * Deliberately short: a distill can only run while the session's agent is
 * still alive (the in-process subagent driver creates children through
 * `parent.ctx`, so a session closed right after its last turn — agent
 * already disposed — can never distill). A 60 s pause means most
 * "conversation done, walk away" endings distill before the close; active
 * back-and-forth still debounces (every turn/end re-arms the timer), and
 * the MIN_NEW_MESSAGES gate skips the LLM call on tiny deltas.
 */
const QUIET_MS = 60_000

/** The `ctx.subagents` provider name (same default as the swarm plugin). */
const PROVIDER = 'spawn'

/** Cap on the conversation excerpt handed to the child (characters). */
const MAX_TRANSCRIPT_CHARS = 24_000

/** Cap on a single message's text inside the excerpt (characters). */
const MAX_MESSAGE_CHARS = 2_000

/** Fewer new surface messages than this → skip the LLM call entirely. */
const MIN_NEW_MESSAGES = 2

/** Hard cap on entries accepted from one distill run (quality over spam). */
const MAX_DISTILL_ENTRIES = 5

/** Structured-output contract: the child must answer via the capture tool. */
const DISTILL_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      description: 'New memory entries worth persisting; empty array when nothing qualifies.',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [...MEMORY_CATEGORIES],
            description: 'preference (user taste/habit) | convention (project rule) | decision (settled choice) | lesson (root cause/pitfall) | fact (durable context)',
          },
          content: {
            type: 'string',
            description: `One concise line in the user's language, at most ${String(MAX_ENTRY_CHARS)} characters.`,
          },
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description: 'project (default) = this workspace only; global = a cross-project user preference',
          },
        },
        required: ['category', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['entries'],
  additionalProperties: false,
} as unknown as ObjectJsonSchema

/** One candidate entry as proposed by the child (pre-validation). */
interface ProposedEntry {
  category?: unknown
  content?: unknown
  scope?: unknown
}

/** Structural slice of a Session (the event feed the distiller reads). */
interface SessionLike {
  readonly id: SessionId
  readonly events: ReadonlyArray<{ type: string, seq: number, data: unknown }>
  readonly header: { readonly cwd?: string, readonly origin?: string }
}

/** Extract the text blocks of one user/assistant message's content. */
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Render one surface event's message text ('' when it carries none). */
function messageText(event: { type: string, data: unknown }): string {
  if (event.type === 'user/message') return blockText((event.data as { content?: unknown })?.content)
  if (event.type === 'assistant/message') {
    return blockText((event.data as { message?: { content?: unknown } })?.message?.content)
  }
  return ''
}

/** Exact-content set of one store's standard entries. Same dedupe rule as
 *  memory_save's hasContent — never a substring test: "用户用 pnpm" must
 *  survive a stored "用户用 pnpm 跑 typecheck", only identical wording is a
 *  duplicate (near-duplicates in different words are the CURATOR's job). */
export function existingNeedles(store: MemoryStore): Set<string> {
  const set = new Set<string>()
  for (const entry of parseEntries(store.read())) {
    if (entry.category !== undefined) set.add(normalizeForMatch(entry.content))
  }
  return set
}

/**
 * The background distiller. {@link attach} subscribes to session events and
 * owns the per-session quiet timers; everything below the timer is fail-soft
 * and disposed cleanly with the host context.
 */
export class MemoryDistiller {
  private readonly ctx: Context
  private readonly root: MemoryRoot
  private readonly log: ReturnType<Context['logger']>
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Set<SessionId>()
  private readonly abort = new AbortController()

  constructor(
    ctx: Context,
    root: MemoryRoot,
    log: ReturnType<Context['logger']>,
    /**
     * Called (and awaited) after a run persisted ≥1 entry — the curator's
     * trigger seam. Runs in the SAME background window, while the parent
     * agent this distill used is still alive; it must not keep the agent
     * reference past this call.
     */
    private readonly onSaved?: (parent: NonNullable<ReturnType<Context['agents']['get']>>) => void | Promise<void>,
  ) {
    this.ctx = ctx
    this.root = root
    this.log = log
  }

  /** Subscribe to the event feed; returns the disposer. */
  attach(): () => void {
    const disposeFeed = this.ctx.on('session/event', (session: Session, event) => {
      if (event.type !== 'turn/end') return
      // Subagent sessions (including our own distill children) never distill.
      if (session.header.origin === 'subagent') return
      this.arm(session.id)
    })
    this.ctx.effect(() => () => {
      this.abort.abort()
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
    }, 'plugin-memory: distill timers')
    return disposeFeed
  }

  /** (Re)start one session's quiet timer. */
  private arm(sessionId: SessionId): void {
    const old = this.timers.get(sessionId)
    if (old !== undefined) clearTimeout(old)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      void this.distill(sessionId)
    }, QUIET_MS)
    // A pending quiet window must never hold the server process open.
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  /** One distill attempt; never throws. */
  private async distill(sessionId: SessionId): Promise<void> {
    try {
      if (!this.root.global.isEnabled() || !this.root.global.isDistillEnabled()) return
      if (this.inFlight.has(sessionId)) return
      // The session must still be live (its agent resolvable) — a cold
      // session is skipped and the retained progress re-covers it later.
      const agent = this.ctx.agents.get(sessionId)
      if (agent === undefined) return
      const session = agent.session as unknown as SessionLike
      if (session.header.origin === 'subagent') return
      // No workspace → the session still distills, but only the GLOBAL
      // channel applies: a user preference is never lost just because the
      // session was started without a cwd.
      const cwd = session.header.cwd === '' ? undefined : session.header.cwd

      this.inFlight.add(sessionId)
      try {
        await this.runDistill(agent, session, cwd)
      } finally {
        this.inFlight.delete(sessionId)
      }
    } catch (error) {
      this.log.warn(`memory distill for "${sessionId}" failed (progress kept, will retry): ${String(error)}`)
    }
  }

  /** The distill body: gather the delta, consult the child, apply entries. */
  private async runDistill(parent: NonNullable<ReturnType<Context['agents']['get']>>, session: SessionLike, cwd: string | undefined): Promise<void> {
    const sessionId = session.id
    const lastSeq = this.root.distillSeqOf(sessionId)
    const fresh: Array<{ type: string, seq: number, text: string }> = []
    for (const event of session.events) {
      if (event.seq <= lastSeq) continue
      const text = messageText(event)
      if (text !== '') fresh.push({ type: event.type, seq: event.seq, text })
    }
    const lastEventSeq = session.events.length > 0
      ? session.events[session.events.length - 1]!.seq
      : lastSeq

    // Too little new material: advance progress and skip the LLM call.
    if (fresh.length < MIN_NEW_MESSAGES) {
      this.root.advanceDistill(sessionId, lastEventSeq)
      return
    }

    // Render the excerpt under both caps.
    const lines: string[] = []
    let used = 0
    for (const message of fresh) {
      const role = message.type === 'user/message' ? 'user' : 'assistant'
      let text = message.text.length > MAX_MESSAGE_CHARS
        ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}…`
        : message.text
      if (used + text.length > MAX_TRANSCRIPT_CHARS) {
        text = text.slice(0, Math.max(0, MAX_TRANSCRIPT_CHARS - used))
        if (text !== '') lines.push(`[${role}] ${text}`)
        break
      }
      used += text.length
      lines.push(`[${role}] ${text}`)
    }
    const transcript = lines.join('\n')

    const globalText = this.root.global.read().trim()
    const projectText = cwd === undefined ? '' : this.root.projectFor(cwd).read().trim()
    const projectSection = cwd === undefined
      ? ['--- No workspace for this session: propose scope "global" entries ONLY (project entries have nowhere to land and are dropped) ---']
      : ['--- Current PROJECT memory (this workspace only) ---', projectText === '' ? '(empty)' : projectText]
    const prompt = [
      'You are the memory distiller of an AI coding assistant. Review the conversation excerpt below',
      '(everything said since the last distill) and the current memory files, then propose NEW entries',
      'worth persisting for future sessions.',
      '',
      'Rules:',
      '- Only durable facts: settled decisions, conventions, user preferences/habits, root causes, pitfalls.',
      '- NEVER propose credentials (API keys, tokens, passwords) — not even if the user shared one.',
      '- Skip anything already covered by an existing entry (the files below are the source of truth).',
      '- Skip ephemeral state: search results, temporary paths, tool errors, work derivable from the repo.',
      '- An empty entries array is a VALID answer — prefer it over marginal proposals.',
      `- At most ${String(MAX_DISTILL_ENTRIES)} entries; each is ONE concise line in the user's language.`,
      '',
      '--- Current GLOBAL memory (user preferences, all projects) ---',
      globalText === '' ? '(empty)' : globalText,
      '',
      ...projectSection,
      '',
      '--- Conversation excerpt (since the last distill) ---',
      transcript,
    ].join('\n')

    const run = await this.ctx.subagents.start(PROVIDER, {
      // Short target-session id in the label so the workflow view shows WHO
      // this distill reviewed — the node is visible by design (transparency,
      // the same way swarm children are), not a hidden worker.
      label: `memory-distill:${shortSessionId(sessionId)}`,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: this.abort.signal,
      // Read-only child: no global tool stays visible, so it cannot touch
      // anything — it answers purely through the structured capture tool.
      toolFilter: { allow: [] },
      maxDepth: 1,
      outputSchema: DISTILL_SCHEMA,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed' || result.structured === undefined) {
        this.log.warn(`memory distill for "${sessionId}" ended ${result.stopReason} without structured output; progress kept`)
        return
      }
      const applied = this.applyEntries(result.structured, cwd)
      this.root.advanceDistill(sessionId, lastEventSeq)
      // Leave a durable trace (time, target session, saved count) so the
      // settings page can show what the background pass actually did.
      this.root.recordDistill(sessionId, applied)
      if (applied > 0) {
        this.log.info(`memory distill: saved ${String(applied)} entr${applied === 1 ? 'y' : 'ies'} from "${sessionId}"`)
        await this.onSaved?.(parent)
      }
    } finally {
      await run.dispose().catch(() => undefined)
    }
  }

  /** Validate proposals against the store; returns how many were appended. */
  private applyEntries(structured: unknown, cwd: string | undefined): number {
    if (typeof structured !== 'object' || structured === null) return 0
    const proposals = (structured as { entries?: unknown }).entries
    if (!Array.isArray(proposals)) return 0

    // Dedupe basis: exact-content sets of both stores, plus entries accepted
    // within THIS run (an accepted entry instantly becomes "existing").
    const globalSeen = existingNeedles(this.root.global)
    const projectSeen = cwd === undefined ? new Set<string>() : existingNeedles(this.root.projectFor(cwd))
    let applied = 0
    for (const raw of proposals) {
      if (applied >= MAX_DISTILL_ENTRIES) break
      const proposal = raw as ProposedEntry
      const content = typeof proposal.content === 'string' ? proposal.content.trim() : ''
      const category = MEMORY_CATEGORIES.includes(proposal.category as MemoryCategory)
        ? proposal.category as MemoryCategory
        : undefined
      if (content === '' || content.length > MAX_ENTRY_CHARS || category === undefined) continue
      // No workspace: a project-scoped proposal has nowhere to land — drop it
      // rather than promote a project fact into the global file by mistake.
      if (proposal.scope !== 'global' && cwd === undefined) continue
      const scope = proposal.scope === 'global' ? 'global' : 'project'
      const needle = normalizeForMatch(content)
      if (needle === '' || globalSeen.has(needle) || projectSeen.has(needle)) continue
      const store = scope === 'global' ? this.root.global : this.root.projectFor(cwd as string)
      store.append(category, content)
      ;(scope === 'global' ? globalSeen : projectSeen).add(needle)
      applied += 1
    }
    return applied
  }
}
