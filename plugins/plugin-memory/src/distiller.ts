/**
 * The background distiller — the code-guaranteed half of proactive memory.
 *
 * While the in-session `memory_save` tool relies on the model noticing
 * durable facts, this pass makes persistence deterministic: after a session
 * goes quiet for {@link QUIET_MS}, one direct LLM call reviews the
 * conversation delta since the last distill plus the current memory files
 * and proposes NEW entries as structured JSON. The HOST validates every
 * entry (category, length, dedup against existing lines) before it ever
 * reaches a memory file — the model cannot write anything itself.
 *
 * Design points:
 *   - Debounce: every `turn/end` re-arms the quiet timer, so an active
 *     conversation never pays for a distill; a cold session at timer fire is
 *     skipped (its progress stays, the next activation re-distills the gap).
 *   - Incremental: `distill-state.json` records the last-consumed event seq
 *     per session, so repeat distills cost only the delta.
 *   - Self-exclusion: subagent sessions (`origin: 'subagent'`, i.e. another
 *     plugin's worker) never trigger distills — background maintenance must
 *     not run off work that is not the user's own conversation.
 *   - Fail-soft: any failure logs a warning and leaves progress unchanged,
 *     so the next quiet window retries the same delta.
 *
 * @module @dsh-app/plugin-memory/distiller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveLlm, streamJson, type DirectRoute } from './llm-direct.ts'
import { MAX_ENTRY_CHARS, containsCredential, normalizeForMatch, parseEntries, shortSessionId, stripEntryPrefix, type MemoryRoot, type MemoryStore } from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/**
 * Quiet window after the last turn before a distill fires (60 s).
 *
 * Deliberately short: a distill can only run while the session's agent is
 * still alive (the event feed and the model route are read off the live
 * session — see {@link MemoryDistiller.distill}), so a session closed right
 * after its last turn could never distill. A 60 s pause means most
 * "conversation done, walk away" endings distill before the close; active
 * back-and-forth still debounces (every turn/end re-arms the timer), and
 * the MIN_NEW_MESSAGES gate skips the LLM call on tiny deltas.
 */
const QUIET_MS = 60_000

/** Cap on the conversation excerpt handed to the model (characters). */
const MAX_TRANSCRIPT_CHARS = 24_000

/** Cap on each memory file handed to the model (characters). */
const MAX_MEMORY_INPUT_CHARS = 12_000

/**
 * Trim one memory file for the prompt, keeping the TAIL — the newest entries
 * are the ones a distill must not miss, since the curator is what prunes the
 * old ones. Without a cap a grown file overflows the model's context on every
 * call; the run fails, progress is never advanced, and the next quiet window
 * pays again for the same doomed call. That is the feedback loop the curator
 * exists to prevent, made permanent.
 */
function cappedMemoryText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_MEMORY_INPUT_CHARS) return trimmed
  return `[note: older entries beyond ${String(MAX_MEMORY_INPUT_CHARS)} chars omitted]\n${trimmed.slice(-MAX_MEMORY_INPUT_CHARS)}`
}

/** Cap on a single message's text inside the excerpt (characters). */
const MAX_MESSAGE_CHARS = 2_000

/** Fewer new surface messages than this → skip the LLM call entirely. */
const MIN_NEW_MESSAGES = 2

/**
 * Fewer new characters than this → skip the LLM call entirely. The message
 * count alone is a weak gate: two short exchanges can clear it while carrying
 * nothing durable, and every pass over such a delta pays a full model call for
 * an answer that should have been "nothing to save". Paired with
 * {@link MIN_NEW_MESSAGES} this reads as "enough material to be worth a look",
 * measured in characters because that is how the transcript is capped.
 */
const MIN_NEW_CHARS = 4_000

/** Hard cap on entries accepted from one distill run (quality over spam). */
const MAX_DISTILL_ENTRIES = 5

/** One candidate entry as proposed by the model (pre-validation). There is no
 *  scope field: the host decides where an entry lands (see resolveScope). */
interface ProposedEntry {
  category?: unknown
  content?: unknown
}

/**
 * Where one proposal lands. The host decides, not the model: a proposer that
 * sees one conversation has no way to know whether a line holds in EVERY
 * workspace, and asking it to guess is exactly what scattered one session's
 * project learning into the global file. Scope is derived from the one fact
 * the host actually has — whether the session had a workspace — and the
 * prompt no longer offers a scope field for the model to fill in.
 * memory_save remains the deliberate path for cross-workspace knowledge.
 */
export function resolveScope(cwd: string | undefined): 'global' | 'project' {
  return cwd === undefined ? 'global' : 'project'
}

/**
 * Build the distill prompt as system (task + rules + output contract) and
 * user (memory files + transcript) halves: the direct call maps them to
 * system/user messages.
 */
export function buildDistillPrompt(transcript: string, cwd: string | undefined, root: MemoryRoot): { system: string, user: string } {
  const globalText = cappedMemoryText(root.global.read())
  const projectText = cwd === undefined ? '' : cappedMemoryText(root.projectFor(cwd).read())
  const projectSection = cwd === undefined
    ? ['--- No workspace for this session: entries land in the GLOBAL memory file ---']
    : ['--- Current PROJECT memory (this workspace only) ---', projectText === '' ? '(empty)' : projectText]
  const system = [
    'You are the memory distiller of an AI coding assistant. Review the conversation excerpt below',
    '(everything said since the last distill) and the current memory files, then propose NEW entries',
    'worth persisting for future sessions.',
    '',
    'The test for every candidate: would a future session in a DIFFERENT conversation act better',
    'because this line exists? A line that only restates what this conversation did fails it.',
    '',
    'Where entries land (the host decides, not you):',
    '- A session WITH a workspace stores every entry in that workspace\'s project memory. That is',
    '  where its pitfalls, tool quirks, debugging recipes and decisions about its code belong,',
    '  even when the project file below looks unrelated.',
    '- Cross-workspace knowledge (reply language and tone, evidence discipline, commit format)',
    '  is recorded through a different path — do not try to address it from here.',
    '',
    'Rules:',
    '- Only durable facts: settled decisions, conventions, user preferences/habits, root causes, pitfalls.',
    '- NEVER propose credentials (API keys, tokens, passwords) — not even if the user shared one.',
    '- Skip anything already covered by an existing entry (the files below are the source of truth).',
    '- Skip ephemeral state: search results, temporary paths, tool errors, work derivable from the repo.',
    '',
    'NEVER propose (these are the most common false positives):',
    '- a work log: what was implemented/fixed/committed in this conversation, commit ids,',
    '  "已完成/已落地/已修复" progress reports, file-by-file change lists, task status —',
    '  the repo, git log, and commit messages already carry all of it;',
    '- a summary of the current task or the session\'s plan;',
    '- restating project code or docs: file paths, API signatures, config values, build commands,',
    '  directory layouts that a future session reads from the repo in one tool call.',
    '',
    '- An empty entries array is a VALID answer — prefer it over marginal proposals.',
    `- At most ${String(MAX_DISTILL_ENTRIES)} entries; each is ONE concise line in the user's language.`,
    '- content holds the entry TEXT only: no "- [category] date" prefix (the host stamps it), no markdown bullets.',
    '',
    'Answer with JSON ONLY, no prose or fences:',
    '{"entries": [{"category": "<preference|convention|decision|lesson|fact>", "content": "<one line>"}]}',
  ].join('\n')
  const user = [
    '--- Current GLOBAL memory (user preferences, all projects) ---',
    globalText === '' ? '(empty)' : globalText,
    '',
    ...projectSection,
    '',
    '--- Conversation excerpt (since the last distill) ---',
    transcript,
  ].join('\n')
  return { system, user }
}

/** Structural slice of a Session (the event feed the distiller reads). */
export interface SessionLike {
  readonly id: SessionId
  /** All events including any fork-inherited prefix (seq-ordered). */
  snapshotEvents(): ReadonlyArray<{ type: string, seq: number, data: unknown }>
  /** Latest assembled call config (provider/model route for direct calls). */
  requestHeader?: () => { config?: { provider?: unknown, model?: unknown } } | undefined
  readonly header: { readonly cwd?: string, readonly origin?: string }
}

/**
 * Model route for a direct call, from the session's latest request header.
 * Shared with the curator: both background passes call the model on the
 * route of the session that triggered them.
 */
export function directRouteOf(session: Pick<SessionLike, 'requestHeader'>): DirectRoute | undefined {
  const config = session.requestHeader?.()?.config
  const provider = config?.provider
  const model = config?.model
  return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
    ? { provider, model }
    : undefined
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
     * trigger seam. Runs in the distill's own background window while the
     * parent agent is still alive; the curator may defer its sweep into a
     * cooldown and re-resolve the parent by sessionId at fire time, so the
     * session id — not just the agent — must cross this seam.
     */
    private readonly onSaved?: (
      parent: NonNullable<ReturnType<Context['agents']['get']>>,
      sessionId: SessionId,
    ) => void | Promise<void>,
  ) {
    this.ctx = ctx
    this.root = root
    this.log = log
  }

  /** Subscribe to the event feed; returns the disposer. */
  attach(): () => void {
    const disposeFeed = this.ctx.on('session/event', (session: Session, event) => {
      if (event.type !== 'turn/end') return
      // Subagent sessions (another plugin's worker) never distill.
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
      if (this.inFlight.has(sessionId)) {
        // A run is already in flight for this session, and it can be long: the
        // curator sweep it triggers is awaited inside it. Dropping this timer
        // would lose the turn/end that armed it — its delta never distilled,
        // and no later event may arrive to retry. Re-arm instead.
        this.arm(sessionId)
        return
      }
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

  /** The distill body: gather the delta, consult the model, apply entries. */
  private async runDistill(parent: NonNullable<ReturnType<Context['agents']['get']>>, session: SessionLike, cwd: string | undefined): Promise<void> {
    const sessionId = session.id
    const lastSeq = this.root.distillSeqOf(sessionId)
    const events = session.snapshotEvents()
    const fresh: Array<{ type: string, seq: number, text: string }> = []
    for (const event of events) {
      if (event.seq <= lastSeq) continue
      const text = messageText(event)
      if (text !== '') fresh.push({ type: event.type, seq: event.seq, text })
    }
    const lastEventSeq = events.length > 0
      ? events[events.length - 1]!.seq
      : lastSeq

    // The session wrote its own entries after the last background pass: stand
    // down and advance. An agent that has already judged this material worth
    // keeping does not need a second, inferential opinion on it.
    if (this.root.savedSinceDistill(sessionId)) {
      this.log.info(`memory distill for "${sessionId}" skipped: the session already saved its own entries`)
      this.root.advanceDistill(sessionId, lastEventSeq)
      return
    }

    // Too little new material: advance progress and skip the LLM call. Both
    // gates must pass — see MIN_NEW_CHARS for why the message count alone is
    // not enough of a filter.
    const newChars = fresh.reduce((total, message) => total + message.text.length, 0)
    if (fresh.length < MIN_NEW_MESSAGES || newChars < MIN_NEW_CHARS) {
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
    const { system, user } = buildDistillPrompt(transcript, cwd, this.root)
    await this.runDirect(sessionId, session, cwd, lastEventSeq, system, user, parent)
  }

  /**
   * The model call: one `ctx.llm.stream` request on the session's own
   * provider/model route, JSON parsed by the host. No route (a session that
   * never assembled a request) skips the run but still advances progress.
   */
  private async runDirect(
    sessionId: SessionId,
    session: SessionLike,
    cwd: string | undefined,
    lastEventSeq: number,
    system: string,
    user: string,
    parent: NonNullable<ReturnType<Context['agents']['get']>>,
  ): Promise<void> {
    const route = directRouteOf(session)
    if (route === undefined) {
      this.log.warn(`memory distill for "${sessionId}" skipped: no model route on the session`)
      this.root.advanceDistill(sessionId, lastEventSeq)
      return
    }
    const result = await streamJson(resolveLlm(this.ctx), {
      route,
      system,
      user,
      signal: this.abort.signal,
    })
    this.root.recordLlmAudit({
      at: Date.now(),
      source: 'distill',
      session: shortSessionId(sessionId),
      status: result.status,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      error: result.error,
    })
    if (result.status !== 'ok') {
      this.log.warn(`memory distill for "${sessionId}" direct call ${result.status} (${result.error ?? 'no detail'}); progress kept`)
      return
    }
    const applied = this.applyEntries(result.parsed, cwd)
    this.root.advanceDistill(sessionId, lastEventSeq)
    // Leave a durable trace (time, target session, saved count) so the
    // settings page can show what the background pass actually did.
    this.root.recordDistill(sessionId, applied, 'direct', result.inputTokens + result.outputTokens)
    if (applied > 0) {
      this.log.info(`memory distill: saved ${String(applied)} entr${applied === 1 ? 'y' : 'ies'} from "${sessionId}"`)
      await this.onSaved?.(parent, sessionId)
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
      // Models echo the file format they see (prefix included); strip it
      // before validating so one logical entry never lands double-prefixed.
      const content = typeof proposal.content === 'string' ? stripEntryPrefix(proposal.content) : ''
      const category = MEMORY_CATEGORIES.includes(proposal.category as MemoryCategory)
        ? proposal.category as MemoryCategory
        : undefined
      if (content === '' || content.length > MAX_ENTRY_CHARS || category === undefined) continue
      // A leaked secret must never reach the file, even from the background
      // pass (the transcript may contain a pasted key the user shared).
      if (containsCredential(content)) continue
      // The host decides the address (see resolveScope): no workspace means
      // the only file available is the global one.
      const scope = resolveScope(cwd)
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
