/**
 * The background distiller — the code-guaranteed half of proactive memory.
 *
 * While the in-session `memory_save` tool relies on the model noticing
 * durable facts, this pass makes persistence deterministic: after a session
 * goes quiet for {@link QUIET_MS}, one direct LLM call reviews the
 * conversation delta since the last distill plus the current topic cards and
 * proposes card writes as structured JSON. The HOST validates every proposal
 * (topic key shape, category, length, credentials, the similarity write gate)
 * before it ever reaches the store — the model cannot write anything itself.
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
 *   - Convergence: proposals address cards by their topic KEY. Reusing an
 *     existing key rewrites that card (upsert), so knowledge about one topic
 *     converges instead of piling up near-duplicate cards; the write-time
 *     similarity gate blocks a near-duplicate under a NEW key.
 *   - Fail-soft: any failure logs a warning and leaves progress unchanged,
 *     so the next quiet window retries the same delta.
 *
 * **Progress invariant — do not reorder.** {@link MemoryDistiller.runDirect}
 * calls `advanceDistill` ONLY after `applyEntries` has returned. The cursor
 * IS the claim "everything up to here has been judged"; moving it before the
 * writes would make a failed write permanently invisible — the delta is
 * never re-read, so the material is silently lost instead of retried. The
 * same rule holds on the curator side: `recordCurated` runs only after the
 * edits landed AND the pass saw the whole store.
 *
 * There is no exception for a missing model route either: `runDirect` is
 * reached only once the gates found enough new material, and a session can
 * hold surface material BEFORE its first `request/header` (a turn may close
 * with no step). The only place that advances without a call is
 * {@link MemoryDistiller.runDistill}'s too-little-material branch, which
 * advances precisely because there is nothing to lose.
 *
 * @module @dsh-app/plugin-memory/distiller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveLlm, streamJson, type DirectRoute } from './llm-direct.ts'
import {
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  SIM_DUPLICATE,
  containsCredential,
  contentSimilarity,
  isValidTopic,
  shortSessionId,
  slugifyTopic,
  stripCommitIds,
  type MemoryRoot,
  type MemoryStore,
} from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'
import { CARD_TEXT_DISCIPLINE } from './card-discipline.ts'

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

/** Cap on the memory input (index + card bodies) per scope handed to the
 *  model (characters). Without a cap a grown store overflows the model's
 *  context on every call; the run fails, progress is never advanced, and the
 *  next quiet window pays again for the same doomed call. */
const MAX_MEMORY_INPUT_CHARS = 12_000

/**
 * Serialize one store for the distill prompt: the index (what future saves
 * route by) followed by every card body, so the model can both reuse an
 * existing topic key and skip already-covered facts. Over the cap the TAIL
 * of the card list is dropped — the list is sorted least-recently-updated
 * last per category, and the curator is what consolidates the aging half.
 */
function memoryInput(store: MemoryStore): string {
  const cards = store.list()
  if (cards.length === 0) return '(empty)'
  const sections: string[] = []
  for (const card of cards) {
    sections.push(`### ${card.name} [${card.category}] (updated ${card.updated})\n${card.body}`)
  }
  const index = store.indexText()
  const head = index === '' ? '' : `${index}\n\n`
  let text = head
  let included = 0
  for (const section of sections) {
    if (text.length + section.length + 1 > MAX_MEMORY_INPUT_CHARS) break
    text += `${section}\n\n`
    included += 1
  }
  const trimmed = text.trim()
  if (included === sections.length) return trimmed
  return `[note: ${String(sections.length - included)} card(s) beyond ${String(MAX_MEMORY_INPUT_CHARS)} chars omitted]\n${trimmed}`
}

/** Cap on a single message's text inside the excerpt (characters). */
const MAX_MESSAGE_CHARS = 2_000

/** Head prefix kept when the transcript exceeds its budget (characters). */
const EXCERPT_HEAD_CHARS = 2_000

/** Omission marker between the kept head prefix and the kept tail. */
const EXCERPT_OMISSION = '[… earlier messages omitted …]'

/**
 * Fit rendered message lines under a character budget keeping BOTH ends: the
 * newest tail in full (decisions, corrections and outcomes live at the END
 * of a delta — dropping the tail is dropping exactly the material worth
 * distilling), a short head prefix for session-opening context, and an
 * omission marker where the middle went. The head is capped at a quarter
 * of the budget as well as EXCERPT_HEAD_CHARS, so a small budget can never
 * be eaten by the prefix before the tail gets its share. Under budget →
 * everything, in order. Exported for tests.
 */
export function renderExcerpt(lines: readonly string[], budget: number): string {
  if (lines.length === 0) return ''
  const widths = lines.map(line => line.length + 1)
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= budget) return lines.join('\n')
  const headCap = Math.min(EXCERPT_HEAD_CHARS, Math.floor(budget / 4))
  let headEnd = 0
  let headUsed = 0
  while (headEnd < lines.length && headUsed + widths[headEnd]! <= headCap) {
    headUsed += widths[headEnd]!
    headEnd += 1
  }
  const tailBudget = Math.max(0, budget - headUsed - (EXCERPT_OMISSION.length + 1))
  let tailStart = lines.length
  let tailUsed = 0
  while (tailStart > headEnd && tailUsed + widths[tailStart - 1]! <= tailBudget) {
    tailStart -= 1
    tailUsed += widths[tailStart]!
  }
  // Degenerate budget (below any single line): the newest message outranks
  // the head, so keep it alone. Unreachable with the real caps (a message is
  // capped at 2k, the budget is 24k) but safe against a future cap change.
  if (tailStart === lines.length) return lines[lines.length - 1] ?? ''
  const head = lines.slice(0, headEnd)
  return [...head, ...(head.length > 0 ? [EXCERPT_OMISSION] : []), ...lines.slice(tailStart)].join('\n')
}

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

/** Hard cap on card writes accepted from one distill run (updates + creates;
 *  quality over spam). */
const MAX_DISTILL_ENTRIES = 5

/** One candidate card write as proposed by the model (pre-validation). There
 *  is no scope field: the host decides where a card lands (see resolveScope). */
interface ProposedEntry {
  topic?: unknown
  summary?: unknown
  category?: unknown
  content?: unknown
}

/**
 * Where one proposal lands. The host decides, not the model: a proposer that
 * sees one conversation has no way to know whether a fact holds in EVERY
 * workspace, and asking it to guess is exactly what scattered one session's
 * project learning into the global store. Scope is derived from the one fact
 * the host actually has — whether the session had a workspace — and the
 * prompt no longer offers a scope field for the model to fill in.
 * memory_save remains the deliberate path for cross-workspace knowledge.
 */
export function resolveScope(cwd: string | undefined): 'global' | 'project' {
  return cwd === undefined ? 'global' : 'project'
}

/**
 * Build the distill prompt as system (task + rules + output contract) and
 * user (memory index + cards + transcript) halves: the direct call maps them
 * to system/user messages.
 */
export function buildDistillPrompt(transcript: string, cwd: string | undefined, root: MemoryRoot): { system: string, user: string } {
  const globalText = memoryInput(root.global)
  const projectText = cwd === undefined ? '' : memoryInput(root.projectFor(cwd))
  const projectSection = cwd === undefined
    ? ['--- No workspace for this session: cards land in the GLOBAL memory ---']
    : ['--- Current PROJECT memory (this workspace only) ---', projectText]
  const system = [
    'You are the memory distiller of an AI coding assistant. Review the conversation excerpt below',
    '(everything said since the last distill) and the current memory cards, then propose card writes',
    'worth persisting for future sessions.',
    '',
    'The test for every candidate: would a future session in a DIFFERENT conversation act better',
    'because this card exists? A card that only restates what this conversation did fails it.',
    '',
    'Memory is stored as TOPIC CARDS. Each card has a fixed kebab-case "topic" key naming its subject,',
    'a ≤40-char "summary" hook for the index, a category, and the card text in "content". Saving the',
    'same topic key again REWRITES that card: when the index below already names the topic your fact',
    'belongs to, reuse that exact key (the host rewrites the card in place) — do NOT invent a',
    'near-synonym key for a topic that already has one.',
    '',
    'Where cards land (the host decides, not you):',
    '- A session WITH a workspace stores every card in that workspace\'s project memory. That is',
    '  where its pitfalls, tool quirks, debugging recipes and decisions about its code belong,',
    '  even when the project cards below look unrelated.',
    '- Cross-workspace knowledge (reply language and tone, evidence discipline, commit format)',
    '  is recorded through a different path — do not try to address it from here.',
    '',
    'Rules:',
    '- Only durable facts: settled decisions, conventions, user preferences/habits, root causes, pitfalls.',
    '- NEVER propose credentials (API keys, tokens, passwords) — not even if the user shared one.',
    '- Skip anything already covered by an existing card (the cards below are the source of truth).',
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
    'Rejected examples (a proposal like these fails the test):',
    '- {"topic": "chatpanel-streaming-fix", "summary": "ChatPanel 集成与竞态修复", "category": "fact",',
    '  "content": "ChatPanel 集成完成：面板放入中间列，修复 streamingIdRef 竞态，fb8b001 已提交"}',
    '  — work log + commit id; the repo and git history carry all of it.',
    '- {"topic": "protobuf-field-map", "summary": "protobuf 字段编号表", "category": "fact",',
    '  "content": "protobuf 字段：1=correlationId 2=clientName 3=method 4=params"}',
    '  — protocol internals a future session reads from the repo in one tool call.',
    'Accepted examples (durable, a DIFFERENT session would act better):',
    '- {"topic": "user-consult-style", "summary": "方案征询期望一次性给综合方案", "category": "preference",',
    '  "content": "用户在方案征询时期望一次性给出综合方案确认，不要逐个提问"} — collaboration preference.',
    '- {"topic": "pnpm-11-workspace-yaml", "summary": "pnpm 11 白名单须写进 workspace yaml", "category": "lesson",',
    '  "content": "pnpm 11 不再从 package.json 读 pnpm 配置，构建白名单必须写进 pnpm-workspace.yaml"}',
    '  — a pitfall no repo doc states.',
    '',
    '- An empty entries array is a VALID answer — prefer it over marginal proposals.',
    `- At most ${String(MAX_DISTILL_ENTRIES)} entries; each entry is ONE card write.`,
    '- "topic" is ASCII kebab-case (a-z, 0-9, -): translate non-ASCII topic words into English.',
    '- "summary" states what the card covers in ≤40 chars; it is REQUIRED for a new topic key.',
    '- "content" holds the card TEXT only (≤400 chars): no dates, no bullets, no markdown headers.',
    CARD_TEXT_DISCIPLINE,
    '',
    'Answer with JSON ONLY, no prose or fences:',
    '{"entries": [{"topic": "<kebab-case-key>", "summary": "<≤40 chars>", "category": "<preference|convention|decision|lesson|fact>", "content": "<card text>"}]}',
  ].join('\n')
  const user = [
    '--- Current GLOBAL memory (index + cards; user preferences, all projects) ---',
    globalText,
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
     * Called (and awaited) after a run persisted ≥1 card — the maintenance
     * trigger seam. Runs in the distill's own background window while the
     * parent agent is still alive and receives the store the cards landed in;
     * the curator may defer its sweep into a cooldown and re-resolve the
     * parent by sessionId at fire time, so the session id — not just the
     * agent — must cross this seam.
     */
    private readonly onSaved?: (
      parent: NonNullable<ReturnType<Context['agents']['get']>>,
      sessionId: SessionId,
      store: MemoryStore,
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
    // Start from whichever cursor is further: the last consumed distill OR
    // the point where the session last saved its own card. Material up to
    // an own-save was already judged by the agent and needs no second,
    // inferential pass; everything AFTER it has had no opinion yet.
    const lastSeq = Math.max(this.root.distillSeqOf(sessionId), this.root.ownSaveSeqOf(sessionId))
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

    // Too little new material: advance progress and skip the LLM call. Both
    // gates must pass — see MIN_NEW_CHARS for why the message count alone is
    // not enough of a filter.
    const newChars = fresh.reduce((total, message) => total + message.text.length, 0)
    if (fresh.length < MIN_NEW_MESSAGES || newChars < MIN_NEW_CHARS) {
      this.root.advanceDistill(sessionId, lastEventSeq)
      return
    }

    // Per-message cap first, then the transcript budget keeping both ends
    // (see renderExcerpt for why the tail is the part that must survive).
    const rendered: string[] = []
    for (const message of fresh) {
      const role = message.type === 'user/message' ? 'user' : 'assistant'
      const text = message.text.length > MAX_MESSAGE_CHARS
        ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}…`
        : message.text
      rendered.push(`[${role}] ${text}`)
    }
    const transcript = renderExcerpt(rendered, MAX_TRANSCRIPT_CHARS)
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
      // Reached only when the gates above found enough NEW material to be
      // worth a call — so the delta is real, and the cursor must NOT move.
      // A route can still APPEAR later: `request/header` is appended inside a
      // step, and a turn may close with no step at all, so a session can hold
      // surface material before its first header. Advancing here would retire
      // that material for good. Retrying costs one prompt assembly and this
      // log line, and is bounded by the next `turn/end`.
      this.log.warn(`memory distill for "${sessionId}" skipped: no model route yet (delta kept for the next window)`)
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
    const applied = await this.applyEntries(result.parsed, cwd)
    // INVARIANT (see the module JSDoc): the cursor moves only AFTER the writes
    // land. Reversing these two lines would make a failed write permanently
    // invisible — the delta would never be re-read and the material silently
    // lost instead of retried on the next quiet window.
    this.root.advanceDistill(sessionId, lastEventSeq)
    // PAST THE POINT OF NO RETURN: the delta is consumed and the cards are on
    // disk. A failure from here is NOT a retry, so it must not be reported as
    // one — the outer catch's "progress kept, will retry" would send a reader
    // hunting for material that was in fact processed.
    try {
      // Leave a durable trace (time, target session, saved count) so the
      // settings page can show what the background pass actually did.
      this.root.recordDistill(sessionId, applied, 'direct', result.inputTokens + result.outputTokens)
      if (applied > 0) {
        this.log.info(`memory distill: saved ${String(applied)} card${applied === 1 ? '' : 's'} from "${sessionId}"`)
        const store = resolveScope(cwd) === 'global' ? this.root.global : this.root.projectFor(cwd as string)
        await this.onSaved?.(parent, sessionId, store)
      }
    } catch (error) {
      // Data stays consistent: the cards are written and the cursor has moved,
      // so the delta is not re-read. What is lost is a trace row and this
      // round's maintenance trigger — the next successful save re-arms the
      // curator from the store fingerprint.
      this.log.warn(`memory distill for "${sessionId}": delta consumed and ${String(applied)} card(s) written, but the trace/maintenance step failed: ${String(error)}`)
    }
  }

  /**
   * Validate proposals against the store; returns how many cards were written
   * (created OR updated). The write gate replaces the old exact-line dedupe:
   *   - the topic key already exists: near-identical content (≥ SIM_DUPLICATE)
   *     is already covered → skip; otherwise upsert REWRITES the card (the
   *     knowledge converged, the key stays).
   *   - a new key: an exact body match or any existing card at ≥ SIM_DUPLICATE
   *     means the fact is already stored under another key → skip, so a
   *     reworded duplicate never lands under a fresh name.
   * Writes hit the disk-backed store immediately, so a card accepted earlier
   * in THIS run is what later proposals in the same run dedupe against.
   */
  private async applyEntries(structured: unknown, cwd: string | undefined): Promise<number> {
    if (typeof structured !== 'object' || structured === null) return 0
    const proposals = (structured as { entries?: unknown }).entries
    if (!Array.isArray(proposals)) return 0

    // The host decides the address (see resolveScope): no workspace means the
    // only store available is the global one.
    const store = resolveScope(cwd) === 'global' ? this.root.global : this.root.projectFor(cwd as string)
    let applied = 0
    for (const raw of proposals) {
      if (applied >= MAX_DISTILL_ENTRIES) break
      const proposal = raw as ProposedEntry
      // A non-ASCII topic word (e.g. pure Chinese) slugifies to '' — reject:
      // the model was asked to translate, and an unkeyed card has no identity.
      const topic = typeof proposal.topic === 'string' ? slugifyTopic(proposal.topic) : ''
      if (!isValidTopic(topic)) continue
      const category = MEMORY_CATEGORIES.includes(proposal.category as MemoryCategory)
        ? proposal.category as MemoryCategory
        : undefined
      // Commit ids ride along when the model quotes a work log; strip them
      // before validating so a cited hash never lands in a re-injected card.
      const content = typeof proposal.content === 'string' ? stripCommitIds(proposal.content) : ''
      if (content === '' || content.length > MAX_TOPIC_BODY_CHARS || category === undefined) continue
      // A leaked secret must never reach the store, even from the background
      // pass (the transcript may contain a pasted key the user shared).
      if (containsCredential(content)) continue
      // Overlong summaries are truncated, not rejected: the hook is routing
      // metadata, the body carries the fact. The summary rides the index into
      // every session's prompt, so it gets the same commit-id strip and
      // credential fence as the body.
      const summary = typeof proposal.summary === 'string'
        ? stripCommitIds(proposal.summary.trim()).slice(0, MAX_SUMMARY_CHARS)
        : ''
      if (containsCredential(summary)) continue

      const existing = store.get(topic)
      if (existing !== undefined) {
        // Same key: near-identical content is already covered.
        if (contentSimilarity(content, existing.body) >= SIM_DUPLICATE) continue
        // Evolved content rewrites the card; a provided summary replaces the
        // hook, an omitted one keeps the existing (see MemoryStore.upsert).
        await store.upsert({ name: topic, category, ...(summary === '' ? {} : { summary }), body: content })
        applied += 1
        continue
      }
      // New key: the summary is the index hook future saves route by, so a
      // keyless-summary proposal would create an unroutable card.
      if (summary === '') continue
      // Cross-key duplicate guard: the same fact under a fresh name.
      if (store.hasContent(content)) continue
      if (store.findSimilar(content, SIM_DUPLICATE, 1).length > 0) continue
      await store.upsert({ name: topic, category, summary, body: content })
      applied += 1
    }
    return applied
  }
}
