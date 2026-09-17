/**
 * The background curator — the consolidation pass that keeps a memory store
 * lean over time. Where the distiller only UPSERTS cards, the curator reviews
 * a store that has grown past a threshold and proposes edits BY TOPIC KEY:
 * merge near-duplicate topics into one card, delete stale cards, rewrite a
 * card in place.
 *
 * Identical safety model to the distiller: a direct LLM call proposes (the
 * JSON contract lives in the prompt, see {@link buildCuratePrompt}) and the
 * HOST validates every edit before anything is written — referenced keys
 * must exist and be cited at most once per pass; a merge target must be one
 * of the cited keys or a fresh valid key and must duplicate nothing that
 * survives. User-pinned cards are additionally off limits: any edit citing
 * one is rejected whole, so a pin never survives its card as a dangling
 * record. Any failure leaves the store untouched and retries on the next
 * trigger.
 *
 * Trigger: the distiller hands us the triggering session right after it
 * persisted cards. Two gates keep the pass cheap and rare:
 *   - Cooldown: at most one sweep per {@link CURATE_COOLDOWN_MS}; requests
 *     inside the window coalesce into a single trailing sweep whose session
 *     is re-resolved by id at fire time (the original agent may be disposed
 *     by then — a dead session drops the pass and every due store simply
 *     waits for the next distill save).
 *   - Change detection: a store whose card fingerprint is unchanged since its
 *     last completed pass is skipped, so a sweep only pays for stores a
 *     writer actually touched.
 * Stores below {@link CURATE_MIN_ENTRIES} cards are left alone: the distiller
 * keeps them healthy on its own and the injection budget still fits.
 *
 * @module @dsh-app/plugin-memory/curator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { directRouteOf, type SessionLike } from './distiller.ts'
import { resolveLlm, streamJson, type DirectRoute } from './llm-direct.ts'
import {
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  containsCredential,
  isValidTopic,
  listProjects,
  normalizeForMatch,
  shortSessionId,
  slugifyTopic,
  stripCommitIds,
  validateCardInput,
  type MemoryRoot,
  type MemoryStore,
} from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/** A store below this many cards is not worth an LLM pass. */
const CURATE_MIN_ENTRIES = 8

/** Minimum spacing between sweeps. Distill saves arrive one quiet window
 * apart (60 s), so without this gate an active session re-sweeps every
 * untouched store each minute; requests inside the window coalesce into one
 * trailing sweep. */
const CURATE_COOLDOWN_MS = 10 * 60_000

/** Cap on the serialized store handed to the model (characters); cards past
 *  the cap are left for a future pass. */
const MAX_INPUT_CHARS = 40_000

/**
 * Card-count target for one store. A store ABOVE this (or the char target
 * below) is over budget: its curate pass is instructed to shrink it, and a
 * pass that shrinks it without getting under the target does not count as
 * completed (the next sweep continues the diet). With bodies capped at
 * MAX_TOPIC_BODY_CHARS this holds a store to roughly what injection and
 * recall can actually use.
 */
const CURATE_MAX_CARDS = 30

/**
 * Character target for one serialized store (same over-budget rule). Derived
 * from the card target and measured on the real format: 30 cards × (400 body
 * + ~50 heading + ~70 index line + separators) ≈ 15.0k (probe: 15006 chars),
 * so 16k leaves margin while keeping the two targets reachable TOGETHER — a
 * lower value would make every healthy full store permanently over budget.
 */
const CURATE_MAX_CHARS = 16_000

/** The budget pair, exported for the calibration test (a change to either
 *  constant must keep them mutually reachable). */
export const CURATE_BUDGET = { cards: CURATE_MAX_CARDS, chars: CURATE_MAX_CHARS } as const

/** Hard cap on edits accepted from one run (a big store is handled over
 *  several passes, not one destructive sweep). */
const MAX_CURATE_EDITS = 20

/** Hard cap on KEYS cited by one run: the destructive bound. Without it a
 *  single `delete` edit naming 30 keys would sail under MAX_CURATE_EDITS while
 *  gutting the store in one pass — the opposite of the multi-pass diet the
 *  edit cap exists to enforce. */
const MAX_CURATE_CITED_KEYS = 30

/** Output allowance for one curate answer. Merge edits carry the full merged
 *  body plus a target summary on top of the cited keys, so a legitimate
 *  multi-edit answer blows past the shared 2k default and gets truncated into
 *  unparseable JSON — which fails soft and would retry forever without ever
 *  curating. The limit is an allowance, not a spend. */
const CURATE_MAX_TOKENS = 8_000

/** The parent-agent type the distill seam hands us (from the distiller). */
type ParentAgent = NonNullable<ReturnType<Context['agents']['get']>>

/** The slice of the triggering session a sweep needs: its id + model route. */
type CurateSession = Pick<SessionLike, 'id' | 'requestHeader'>

/** Derive the curator's session slice off the triggering agent. */
function sessionOf(parent: ParentAgent): CurateSession {
  return parent.session as unknown as CurateSession
}

/**
 * Serialize one store for the curate prompt: the index, then every card as a
 * keyed section the edit protocol can cite. Over the cap the TAIL of the
 * card list is dropped and the pass is not allowed to mark the store done
 * (the omitted cards were never reviewed).
 */
function serializeStore(store: MemoryStore): { text: string, truncated: boolean } {
  const cards = store.list()
  const sections = cards.map(card => `### ${card.name} [${card.category}] (updated ${card.updated})\n${card.body}`)
  const index = store.indexText()
  let text = index === '' ? '' : `${index}\n\n`
  let included = 0
  for (const section of sections) {
    if (text.length + section.length + 1 > MAX_INPUT_CHARS) break
    text += `${section}\n\n`
    included += 1
  }
  const trimmed = text.trim()
  if (included === sections.length) return { text: trimmed, truncated: false }
  return {
    text: `${trimmed}\n[note: ${String(sections.length - included)} card(s) beyond ${String(MAX_INPUT_CHARS)} chars omitted from this pass]`,
    truncated: true,
  }
}

/**
 * Build the curate prompt as system (task + rules + output contract) and
 * user (the serialized store) halves — the same split the distiller uses.
 * Pinned topic keys are named up front as untouchable: the host rejects any
 * edit citing one, so telling the model saves a wasted proposal. An
 * over-budget store additionally gets an explicit shrink directive with its
 * concrete numbers. `restructure` (a store still holding auto-migrated
 * `legacy-*` cards) adds the migration-cleanup directive.
 */
export function buildCuratePrompt(
  input: string,
  pinnedKeys: readonly string[] = [],
  overBudget?: { cards: number, chars: number },
  opts?: { restructure?: boolean },
): { system: string, user: string } {
  const system = [
    'You are the memory curator of an AI coding assistant. Review the memory store below',
    '(an index plus every topic card) and propose EDITS that keep it lean and accurate over time.',
    'Cards are addressed by their kebab-case topic key — cite keys, never quote card text.',
    '',
    'Rules:',
    '- merge: two or more cards that now say the same thing (near-duplicates, the same fact',
    '  restated under two keys, or one superseding the other). One refreshed target card replaces',
    '  them all; the other cited keys are deleted.',
    '- delete: cards that are stale (already superseded), wrong, or no longer relevant.',
    '- delete: cards that are work logs rather than reusable knowledge — reports of what a',
    '  session did ("X 已完成", "修复全落地", "审查后…"), file-by-file change lists, commit',
    '  ids, task summaries. Keep only what a future session could act on.',
    '- rewrite: one card whose content needs tightening or correcting in place.',
    '- Keep only cards a future session would ACT on. For a non-pinned card, when in doubt',
    '  between keeping and deleting, delete.',
    '- Prefer keeping the SURVIVING card when one strictly supersedes another: delete the stale one.',
    '- NEVER mention credentials (API keys, tokens, passwords) — not even in a rewrite.',
    ...(pinnedKeys.length > 0
      ? ['- The topic keys listed under "Pinned cards" were pinned by the user and are NEVER edited:',
         '  don\'t cite those keys in any edit — the whole edit is rejected when you do.']
      : []),
    ...(overBudget !== undefined
      ? ['- This store is OVER BUDGET: ' + String(overBudget.cards) + ' cards / '
         + String(overBudget.chars) + ' chars, targets: ' + String(CURATE_MAX_CARDS)
         + ' cards / ' + String(CURATE_MAX_CHARS) + ' chars. You MUST propose enough',
         '  delete/merge edits to bring it under both targets — start with the weakest cards.',
         '  An empty edits array is acceptable ONLY if every remaining card is pinned.']
      : []),
    ...(opts?.restructure === true
      ? ['- Cards named legacy-* were auto-migrated from the old timeline; prefer merging them into',
         '  well-named topics (merge into a proper new target topic key) or rewriting them in place;',
         '  a legacy key should not survive this pass unless nothing relates to it.']
      : []),
    '- Each cited key must exist below. The same key may be cited at most once across all edits.',
    '- A merge/rewrite body is concise card TEXT in the user\'s language, at most 400 characters —',
    '  no dates, no bullets, no markdown headers.',
    '- A merge target topic is either one of the cited keys or a NEW well-named kebab-case key;',
    '  its summary (≤40 chars) is required when the target is a new key.',
    '- An empty edits array is a VALID answer — prefer it over marginal edits.',
    `- At most ${String(MAX_CURATE_EDITS)} edits total.`,
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"edits": [{"op": "merge", "topics": ["<key-a>", "<key-b>"], "target": {"topic": "<key-a or new key>", "summary": "<≤40 chars>", "category": "<' + MEMORY_CATEGORIES.join('|') + '>", "content": "<merged text>"}},',
    '           {"op": "delete", "topics": ["<key-c>"]},',
    '           {"op": "rewrite", "topic": "<key-d>", "content": "<new text>", "summary": "<optional new summary>"}]}',
  ].join('\n')
  const user = [
    '--- Memory store (index + cards) ---',
    input,
    ...(pinnedKeys.length > 0 ? ['', '--- Pinned cards (user-fixed, never edited) ---', ...pinnedKeys.map(key => `- ${key}`)] : []),
  ].join('\n')
  return { system, user }
}

/** A possibly-malformed edit as proposed by the model (pre-validation). */
interface ProposedEdit {
  op?: unknown
  topics?: unknown
  topic?: unknown
  target?: unknown
  content?: unknown
  summary?: unknown
}

/** One consolidation target. */
interface CurateTarget {
  label: string
  store: MemoryStore
}

/**
 * The background curator. {@link attach} provides the cleanup seam; the
 * trigger arrives through {@link runAfterDistill} (called by the host when
 * a distill run persisted cards). Everything below the trigger is fail-soft:
 * a bad model answer or a dead session just logs and retries on the next
 * distill.
 */
export class MemoryCurator {
  private readonly ctx: Context
  private readonly root: MemoryRoot
  private readonly log: ReturnType<Context['logger']>
  private readonly abort = new AbortController()
  /** Start time of the last sweep — the anchor the cooldown measures from. */
  private lastSweepAt = 0
  /** The coalesced trailing sweep; further requests never push its deadline. */
  private pendingTimer: ReturnType<typeof setTimeout> | undefined
  private pendingSessionId: SessionId | undefined

  constructor(
    ctx: Context,
    root: MemoryRoot,
    log: ReturnType<Context['logger']>,
    /** Injectable so tests exercise the coalescing without real waiting. */
    private readonly cooldownMs: number = CURATE_COOLDOWN_MS,
  ) {
    this.ctx = ctx
    this.root = root
    this.log = log
  }

  /** Provide the disposal seam (effect cleanup, same pattern as the distiller). */
  attach(): () => void {
    this.ctx.effect(() => () => {
      this.abort.abort()
      if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer)
    }, 'plugin-memory: curator abort')
    return () => undefined
  }

  /**
   * The save trigger: sweep now when the cooldown has elapsed, otherwise
   * coalesce into the pending trailing sweep. Never throws.
   *
   * Gated by `isDistillEnabled()` — the user-facing 后台自动提炼 toggle
   * means "no background model work", so it stops the curator too, not just
   * the distiller. Keeping one gate for every background pass is what makes
   * flipping it cost-predictable; a save-triggered sweep slipping through
   * with the toggle off would spend tokens the user opted out of.
   */
  async runAfterDistill(parent: ParentAgent, sessionId: SessionId): Promise<void> {
    if (!this.root.global.isEnabled() || !this.root.global.isDistillEnabled()) return
    const dueAt = this.lastSweepAt + this.cooldownMs
    if (Date.now() >= dueAt) {
      await this.sweep(sessionOf(parent))
      return
    }
    // Inside the cooldown: one trailing sweep at the ORIGINAL deadline —
    // later requests re-point it at the newest triggering session (most
    // likely to still be alive) but never push the deadline back, so a
    // busy session cannot starve curation.
    this.pendingSessionId = sessionId
    if (this.pendingTimer !== undefined) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined
      const sessionId = this.pendingSessionId
      this.pendingSessionId = undefined
      void this.fireDeferredSweep(sessionId)
    }, dueAt - Date.now())
    this.pendingTimer.unref?.()
  }

  /**
   * The coalesced sweep: the triggering session is re-resolved at fire time
   * because the agent this request rode in on may be long gone. A dead
   * session drops the pass — every due store waits for the next save, which
   * re-arms a fresh sweep.
   */
  private async fireDeferredSweep(sessionId: SessionId | undefined): Promise<void> {
    if (!this.root.global.isEnabled() || !this.root.global.isDistillEnabled()) return
    if (sessionId === undefined) return
    const parent = this.ctx.agents.get(sessionId)
    if (parent === undefined) {
      this.log.info('memory curate: deferred sweep dropped, triggering session already closed')
      return
    }
    await this.sweep(sessionOf(parent))
  }

  /**
   * One full pass over every due store. The model route comes from the
   * triggering session (same rule as the distiller): no route means no call
   * at all, and the sweep is skipped without burning the cooldown. Never
   * throws per target.
   */
  private async sweep(session: CurateSession): Promise<void> {
    const route = directRouteOf(session)
    if (route === undefined) {
      this.log.warn(`memory curate skipped: no model route on session "${session.id}"`)
      return
    }
    this.lastSweepAt = Date.now()
    for (const target of this.selectTargets()) {
      try {
        await this.curate(target, route, session.id)
      } catch (error) {
        this.log.warn(`memory curate for "${target.label}" failed (store untouched, will retry on next distill): ${String(error)}`)
      }
    }
  }

  /**
   * Every DUE store (global + projects with a resolvable cwd): at or above
   * the card threshold AND changed since its last completed pass — a store
   * whose fingerprint still matches the recorded one was already
   * consolidated, and re-reading the same cards would only propose the same
   * nothing.
   */
  private selectTargets(): CurateTarget[] {
    const targets: CurateTarget[] = []
    const consider = (key: string, store: MemoryStore): void => {
      if (store.list().length < CURATE_MIN_ENTRIES) return
      if (this.root.curatedHashOf(key) === store.fingerprint()) return
      targets.push({ label: key, store })
    }
    consider('global', this.root.global)
    for (const project of listProjects(this.root.dir)) {
      if (project.cwd === '') continue
      consider(project.slug, this.root.projectFor(project.cwd))
    }
    return targets
  }

  /** The pass body for one store: one direct call, then the validated edits. */
  private async curate(target: CurateTarget, route: DirectRoute, sessionId: SessionId): Promise<void> {
    const { text, truncated } = serializeStore(target.store)

    // Over-budget detection drives the prompt's shrink directive and the
    // completion rule below (a still-over store only counts as done when the
    // pass could not shrink it at all).
    const cardCount = target.store.list().length
    const overBudget = cardCount > CURATE_MAX_CARDS || text.length > CURATE_MAX_CHARS

    // The pinned keys go to the model so it can leave those cards alone;
    // applyEdits enforces the same rule regardless of what the model proposes.
    const pinnedKeys = [...target.store.pinnedSet()]

    // A store still holding auto-migrated `legacy-*` cards gets the
    // restructure directive: those hash-named keys are placeholders, not
    // topics, and this pass is what folds them into well-named cards.
    const restructure = target.store.list().some(card => card.name.startsWith('legacy-'))

    const { system, user } = buildCuratePrompt(
      text,
      pinnedKeys,
      overBudget ? { cards: cardCount, chars: text.length } : undefined,
      { restructure },
    )
    const result = await streamJson(resolveLlm(this.ctx), {
      route,
      system,
      user,
      maxTokens: CURATE_MAX_TOKENS,
      signal: this.abort.signal,
    })
    this.root.recordLlmAudit({
      at: Date.now(),
      source: 'curate',
      session: shortSessionId(sessionId),
      status: result.status,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      error: result.error,
    })
    if (result.status !== 'ok') {
      this.log.warn(`memory curate for "${target.label}" direct call ${result.status} (${result.error ?? 'no detail'})`)
      return
    }
    const { merged, deleted, rewritten } = await this.applyEdits(target.store, result.parsed)
    const touched = merged + deleted + rewritten
    if (touched > 0) {
      const parts = [
        merged > 0 ? `${String(merged)} merged` : '',
        deleted > 0 ? `${String(deleted)} deleted` : '',
        rewritten > 0 ? `${String(rewritten)} rewritten` : '',
      ].filter(part => part !== '')
      this.log.info(`memory curate: ${parts.join(', ')} in "${target.label}"`)
    }
    // Mark the pass done so unchanged stores stop re-sweeping. Only a pass
    // that saw the WHOLE store may mark it: with the input cap active the
    // omitted cards were never reviewed and stay due. The fingerprint is of
    // the post-edit store — the content this pass actually leaves behind.
    // An over-budget store that shrank but is STILL over stays due too —
    // the next sweep continues the diet; only a no-op pass on an
    // over-budget store records (a pass that cannot shrink it further must
    // not burn every cooldown on the same nothing).
    if (!truncated) {
      const stillOver = target.store.list().length > CURATE_MAX_CARDS || serializeStore(target.store).text.length > CURATE_MAX_CHARS
      if (!overBudget || !stillOver) {
        this.root.recordCurated(target.label, target.store.fingerprint())
      } else if (touched === 0) {
        this.log.warn(`memory curate: "${target.label}" still over budget after a no-op pass; recording to avoid a burn loop (manual review suggested)`)
        this.root.recordCurated(target.label, target.store.fingerprint())
      }
    }
  }

  /**
   * Validate every proposed edit against the store and apply the survivors.
   * The edit protocol cites cards BY KEY: a cited key must exist, must not be
   * pinned (a pin is the user's explicit "always inject this" intent, so no
   * edit may rewrite or drop one), and may be cited at most once per pass —
   * violating any of these rejects the whole edit. Deletes land first, then
   * merges/rewrites dedupe against what actually SURVIVES (never against
   * cards this very pass removes). Writes hit the disk-backed store
   * immediately, so "surviving" is simply the store's current state minus
   * the keys the edit itself cites.
   */
  private async applyEdits(store: MemoryStore, structured: unknown): Promise<{ merged: number, deleted: number, rewritten: number }> {
    if (typeof structured !== 'object' || structured === null) return { merged: 0, deleted: 0, rewritten: 0 }
    const edits = (structured as { edits?: unknown }).edits
    if (!Array.isArray(edits)) return { merged: 0, deleted: 0, rewritten: 0 }

    const pinned = store.pinnedSet()
    const cited = new Set<string>()
    let applied = 0
    let merged = 0
    let deleted = 0
    let rewritten = 0

    /** The edit's cited keys, or undefined when the edit is rejected whole.
     *  Also enforces the cited-keys ceiling: an edit that would push the pass
     *  past MAX_CURATE_CITED_KEYS is skipped (not fatal to other edits). */
    const claim = (keys: unknown): string[] | undefined => {
      if (!Array.isArray(keys) || keys.length === 0) return undefined
      if (cited.size + keys.length > MAX_CURATE_CITED_KEYS) return undefined
      const out: string[] = []
      for (const key of keys) {
        if (typeof key !== 'string' || !isValidTopic(key)) return undefined
        if (cited.has(key) || pinned.has(key)) return undefined
        if (store.get(key) === undefined) return undefined
        out.push(key)
      }
      return out
    }

    /** Validate a card body the model proposes (merge target / rewrite). */
    const cleanBody = (content: unknown): string | undefined => {
      if (typeof content !== 'string') return undefined
      // Same commit-id hazard as distill proposals (see stripCommitIds): the
      // model copies cited ids into the rewrite.
      const body = stripCommitIds(content)
      if (body === '' || body.length > MAX_TOPIC_BODY_CHARS || containsCredential(body)) return undefined
      return body
    }

    /** Validate a model-proposed summary (the index hook): same fences as the
     *  body — it is injected with every session too. */
    const cleanSummary = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined
      const summary = stripCommitIds(value.trim()).slice(0, MAX_SUMMARY_CHARS)
      if (summary === '' || containsCredential(summary)) return undefined
      return summary
    }

    // Stage 1: deletes claim their keys first and land immediately.
    for (const raw of edits) {
      if (applied >= MAX_CURATE_EDITS) break
      const edit = raw as ProposedEdit
      if (edit.op !== 'delete') continue
      const keys = claim(edit.topics)
      if (keys === undefined) continue
      keys.forEach(key => cited.add(key))
      for (const key of keys) {
        if (await store.remove(key)) deleted += 1
      }
      applied += 1
    }

    // Stage 2: merges and rewrites, in the model's order.
    for (const raw of edits) {
      if (applied >= MAX_CURATE_EDITS) break
      const edit = raw as ProposedEdit
      if (edit.op === 'rewrite') {
        const keys = claim(edit.topic === undefined ? undefined : [edit.topic])
        if (keys === undefined) continue
        const body = cleanBody(edit.content)
        if (body === undefined) continue
        const card = store.get(keys[0]!)
        if (card === undefined) continue
        // Same survivor dedupe as merge (the rewritten card exempts itself):
        // a rewrite must not manufacture an exact duplicate pair.
        const rewriteNeedle = normalizeForMatch(body)
        const rewrittenKey = card.name
        if (rewriteNeedle !== '' && store.list().some(other =>
          !other.malformed && other.name !== rewrittenKey && normalizeForMatch(other.body) === rewriteNeedle)) continue
        // A provided summary replaces the hook; an omitted one keeps it. A
        // PROVIDED but invalid summary rejects the edit — silently keeping
        // the old hook would hide the model's intent drift.
        const summary = edit.summary === undefined ? undefined : cleanSummary(edit.summary)
        if (summary === undefined && edit.summary !== undefined) continue
        cited.add(keys[0]!)
        await store.upsert({ name: card.name, category: card.category, ...(summary === undefined ? {} : { summary }), body })
        applied += 1
        rewritten += 1
        continue
      }
      if (edit.op !== 'merge') continue
      const keys = claim(edit.topics)
      if (keys === undefined || keys.length < 2) continue
      const target = edit.target as { topic?: unknown, summary?: unknown, category?: unknown, content?: unknown } | undefined
      if (typeof target !== 'object' || target === null) continue
      // The target is either one of the cited keys (that card is rewritten in
      // place) or a fresh key the survivors converge onto.
      const rawTargetKey = typeof target.topic === 'string' ? target.topic : ''
      const targetKey = keys.includes(rawTargetKey) ? rawTargetKey : slugifyTopic(rawTargetKey)
      if (!isValidTopic(targetKey)) continue
      // Collision guard: a NEW target key must not name an EXISTING uncited
      // card — upsert would silently overwrite it, and since pins key by
      // topic, a pinned card's pin would even carry onto the merged content.
      // That is a prompt-injection-shaped bypass of the pinned protection.
      if (!keys.includes(targetKey) && store.get(targetKey) !== undefined) continue
      const category = MEMORY_CATEGORIES.includes(target.category as MemoryCategory)
        ? target.category as MemoryCategory
        : undefined
      if (category === undefined) continue
      const body = cleanBody(target.content)
      if (body === undefined) continue
      const summary = typeof target.summary === 'string' ? cleanSummary(target.summary) ?? '' : ''
      // A new target key needs its routing hook; reusing a cited key may omit
      // it (the surviving card's summary carries over).
      if (!keys.includes(targetKey) && summary === '') continue
      const invalid = validateCardInput({
        name: targetKey,
        category,
        summary: summary !== '' ? summary : store.get(targetKey)?.summary ?? '',
        body,
      })
      if (invalid !== undefined) continue
      // The merged body must duplicate nothing that survives this pass: every
      // card except the ones this merge replaces (they are being rewritten
      // or removed). Exact normalized match — near-duplicates are what the
      // NEXT pass is for, blocking them here would reject legitimate merges.
      const needle = normalizeForMatch(body)
      const absorbed = new Set(keys)
      const duplicates = needle !== '' && store.list().some(card =>
        !card.malformed && !absorbed.has(card.name) && normalizeForMatch(card.body) === needle)
      if (duplicates) continue
      keys.forEach(key => cited.add(key))
      await store.upsert({ name: targetKey, category, ...(summary === '' ? {} : { summary }), body })
      for (const key of keys) {
        if (key !== targetKey) await store.remove(key)
      }
      applied += 1
      merged += 1
    }

    return { merged, deleted, rewritten }
  }
}
