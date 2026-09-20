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
 * **Progress invariant — do not reorder.** `recordCurated` is the claim "this
 * store has been reviewed"; it runs ONLY after the edits landed AND the pass
 * saw the WHOLE card list. Two conditions, both load-bearing:
 *   - after the edits: a pass that threw mid-way (a failed `remove`) must not
 *     record, or the cards it never got to would never be looked at again;
 *   - whole list: with the input cap active the omitted cards were never read,
 *     so recording would mark unreviewed cards as done. A truncated store
 *     therefore STAYS due, and {@link CURATE_STALL_LIMIT} is what stops that
 *     from becoming an unbounded re-sweep loop.
 *
 * TWO deliberate escapes from "whole list", both buying a bounded cost with an
 * explicitly weaker guarantee. Do not read a recorded hash as proof the store
 * was fully reviewed:
 *   - an over-budget store whose pass changed NOTHING is recorded, so a store
 *     the model cannot shrink does not buy a full-price call every cooldown;
 *   - a truncated store that produced no edit for {@link CURATE_STALL_LIMIT}
 *     consecutive passes is recorded for the same reason — the burn-loop
 *     bound. Both log a warning and want a human.
 *
 * @module @dsh-app/plugin-memory/curator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CARD_TEXT_DISCIPLINE } from './card-discipline.ts'
import { directRouteOf, type SessionLike } from './distiller.ts'
import { resolveLlm, streamJson, type DirectRoute } from './llm-direct.ts'
import {
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  cardFingerprint,
  containsCredential,
  contentHash,
  isValidTopic,
  listProjects,
  normalizeForMatch,
  shortSessionId,
  slugifyTopic,
  stripCommitIds,
  validateCardInput,
  type LedgerEntry,
  type MemoryRoot,
  type MemoryStore,
} from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/** A store below this many cards is not worth an LLM pass. */
// 8 was the original floor, and measured against the real stores it made the
// curator unreachable: the stores it was meant to clean hold 4-13 cards, and
// over the plugin's whole history the distiller wrote 41 cards while curation
// applied exactly ONE edit — "write fast, clean slow" with the cleaning end
// switched off. 4 is the smallest floor that still skips a brand-new store.
const CURATE_MIN_ENTRIES = 4

/** Minimum spacing between sweeps. Distill saves arrive one quiet window
 * apart (60 s), so without this gate an active session re-sweeps every
 * untouched store each minute; requests inside the window coalesce into one
 * trailing sweep. Three minutes, not ten: with the floor above, a store that
 * just crossed it should get its first pass in the same sitting rather than
 * after three more distill windows have added to it. */
const CURATE_COOLDOWN_MS = 3 * 60_000

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

/**
 * Consecutive truncated passes that changed nothing before the sweep backs
 * off. A truncated store stays due on purpose (most of it was never
 * reviewed), but "due" plus "no progress" is an unbounded burn loop: each
 * cooldown buys a full-price model call for the same nothing. Two passes is
 * enough to tell a one-off (a model that happened to return nothing) from a
 * store that cannot be curated as it stands.
 */
const CURATE_STALL_LIMIT = 2

/**
 * Refused edits recorded in the ledger per pass. A model that cites dozens of
 * keys it was never shown produces one refusal each, and the ledger is a
 * bounded FIFO — an unbounded flood would evict the applied merge/delete
 * records that explain where the cards actually went. The full counts still
 * reach the log.
 */
const MAX_LEDGER_REJECTED_PER_PASS = 3

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
 *
 * The INDEX is deliberately sent whole even when card bodies are dropped: it
 * is the write-side routing map and the model needs every key to avoid
 * inventing a near-synonym. That asymmetry is exactly why `seen` matters —
 * the model can NAME a card whose body it was never shown, so the edit
 * validator has to check what was actually READ, not what was nameable.
 * `omitted` names those keys so the prompt can fence them off explicitly.
 *
 * `start` rotates the list so the cards a previous truncated pass could not
 * carry become this pass's head; the card list order is deterministic, so
 * without rotation the same tail would be dropped forever.
 */
export function serializeStore(store: MemoryStore, start = 0): {
  text: string
  truncated: boolean
  /** Cards whose BODY made it into the prompt, keyed by topic → content hash. */
  seen: Map<string, string>
  /** Keys the input cap dropped: nameable from the index, never read. */
  omitted: string[]
  /**
   * The first card the cap dropped. The next pass rotates to it.
   *
   * Anchored to a KEY, never to an offset: the offset is read before the
   * edits land, and a pass that deletes the cards it just reviewed shifts
   * every later card forward — an offset would then skip exactly as many
   * unreviewed cards as were deleted, which is the one outcome rotation
   * exists to prevent. The anchor is never in `seen`, so no edit this pass
   * can remove it, and it stays findable after the edits.
   *
   * `undefined` with `truncated: true` means the pass could carry NOTHING (a
   * single card bigger than the whole input budget, or an index that already
   * fills it). There is no anchor to rotate to in that case — see
   * {@link blockedBy} for how the caller learns to stop retrying.
   */
  nextAnchor?: string
  /**
   * Set when the pass carried nothing at all because ONE card would not fit.
   * The key names that card: retrying the same rotation cannot help, so the
   * caller must not treat this as ordinary "more work next time".
   */
  blockedBy?: string
} {
  const cards = store.list()
  const offset = cards.length === 0 ? 0 : ((start % cards.length) + cards.length) % cards.length
  const rotated = offset === 0 ? cards : [...cards.slice(offset), ...cards.slice(0, offset)]
  const sections = rotated.map(card => `### ${card.name} [${card.category}] (updated ${card.updated})\n${card.body}`)
  const index = store.indexText()
  let text = index === '' ? '' : `${index}\n\n`
  const seen = new Map<string, string>()
  let included = 0
  for (const [i, section] of sections.entries()) {
    if (text.length + section.length + 1 > MAX_INPUT_CHARS) break
    text += `${section}\n\n`
    const card = rotated[i]!
    seen.set(card.name, contentHash(cardFingerprint(card)))
    included += 1
  }
  const trimmed = text.trim()
  if (included === sections.length) return { text: trimmed, truncated: false, seen, omitted: [] }
  const omitted = rotated.slice(included).map(card => card.name)
  // Carried nothing: the head card alone exceeds the budget (a hand-edited
  // file is never length-checked on READ, only on write). Reporting it as an
  // anchor would point the next pass at the very same card forever.
  const blockedBy = included === 0 ? rotated[0]?.name : undefined
  return {
    text: `${trimmed}\n[note: ${String(omitted.length)} card(s) beyond ${String(MAX_INPUT_CHARS)} chars omitted from this pass]`,
    truncated: true,
    seen,
    omitted,
    ...(blockedBy === undefined ? { nextAnchor: omitted[0] } : { blockedBy }),
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
  opts?: { restructure?: boolean, omitted?: readonly string[] },
): { system: string, user: string } {
  const omitted = opts?.omitted ?? []
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
    '- delete: cards whose own text NARRATES the remembering instead of stating the fact',
    '  ("I saved a note that…", "according to the memory index…") — that narration gets',
    '  re-injected into every future session. Do NOT delete a card merely for MENTIONING this',
    '  memory system: cards about its keys, index or limits are legitimate knowledge.',
    '- rewrite: one card whose content needs tightening or correcting in place.',
    '- rename: ONE card whose topic KEY is wrong for its content (an auto-migrated',
    '  legacy-* key, a typo, a key that no longer matches the subject). Cite that one key',
    '  and give the target a NEW well-named key — this is the ONLY way a lone card can',
    '  change its key; rewrite keeps it.',
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
      ? ['- Cards named legacy-* were auto-migrated from the old timeline and their keys are',
         '  placeholder hashes, not topics. Give each a proper key: RENAME it (see the rename',
         '  rule) when it stands alone, or MERGE it into a well-named target when other cards',
         '  cover the same subject. A legacy key should not survive this pass unless nothing',
         '  relates to it AND no better key suggests itself.']
      : []),
    ...(omitted.length > 0
      ? ['- Some cards could not be included in full: their keys are listed under "Cards omitted',
         '  from this pass" and they appear in the index, but their TEXT was not shown to you.',
         '  You may NOT cite those keys in any edit — the whole edit is rejected when you do,',
         '  because no one has read the card. Leave them for a later pass, which will start there.']
      : []),
    '- Each cited key must exist below. The same key may be cited at most once across all edits.',
    '- A merge/rewrite body is concise card TEXT in the user\'s language, at most 400 characters —',
    '  no dates, no bullets, no markdown headers.',
    CARD_TEXT_DISCIPLINE,
    '- A merge target topic is either one of the cited keys or a NEW well-named kebab-case key;',
    '  its summary (≤40 chars) is required when the target is a new key.',
    '- An empty edits array is a VALID answer — prefer it over marginal edits.',
    `- At most ${String(MAX_CURATE_EDITS)} edits total.`,
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"edits": [{"op": "merge", "topics": ["<key-a>", "<key-b>"], "target": {"topic": "<key-a or new key>", "summary": "<≤40 chars>", "category": "<' + MEMORY_CATEGORIES.join('|') + '>", "content": "<merged text>"}},',
    '           {"op": "delete", "topics": ["<key-c>"]},',
    '           {"op": "rewrite", "topic": "<key-d>", "content": "<new text>", "summary": "<optional new summary>"},',
    '           {"op": "rename", "topics": ["<old-key>"], "target": {"topic": "<new-key>", "summary": "<≤40 chars>", "category": "<same as before>", "content": "<same text>"}}]}',
    'A rename is a merge with exactly ONE cited key and a NEW target topic.',
  ].join('\n')
  const user = [
    '--- Memory store (index + cards) ---',
    input,
    ...(pinnedKeys.length > 0 ? ['', '--- Pinned cards (user-fixed, never edited) ---', ...pinnedKeys.map(key => `- ${key}`)] : []),
    ...(omitted.length > 0 ? ['', '--- Cards omitted from this pass (never cite these keys) ---', ...omitted.map(key => `- ${key}`)] : []),
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

/**
 * The keys a REJECTED edit named, for the ledger. Validation refused the edit
 * before it could be trusted, so these are read defensively: only strings that
 * look like topic keys survive, and a non-array yields nothing.
 */
function citedKeysOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((key): key is string => typeof key === 'string' && isValidTopic(key))
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
   * at all, and the sweep is skipped without burning the cooldown.
   *
   * Never throws. Both the enumeration and each target are guarded, because
   * the callers are `void`-ed fire-and-forget (see `index.ts`) and an escaping
   * rejection would surface as an unhandled rejection rather than a retry.
   */
  private async sweep(session: CurateSession): Promise<void> {
    const route = directRouteOf(session)
    if (route === undefined) {
      this.log.warn(`memory curate skipped: no model route on session "${session.id}"`)
      return
    }
    this.lastSweepAt = Date.now()
    let targets: CurateTarget[]
    try {
      // selectTargets walks the projects directory: an EACCES/EPERM there is
      // transient on Windows (a scanner holding `topics/`) and must not take
      // the sweep down before it starts.
      targets = this.selectTargets()
    } catch (error) {
      this.log.warn(`memory curate: could not enumerate stores (will retry on next distill): ${String(error)}`)
      return
    }
    for (const target of targets) {
      try {
        await this.curate(target, route, session.id)
      } catch (error) {
        this.log.warn(`memory curate for "${target.label}" failed (will retry on next distill): ${String(error)}`)
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
    // The stored cursor is a topic KEY; turn it into the list offset this pass
    // starts at. A key that no longer exists (the card was deleted between
    // passes) means the anchor is gone — start at the top rather than guess.
    const anchor = this.root.curateCursorOf(target.label)
    const start = anchor === undefined ? 0 : Math.max(0, target.store.list().findIndex(card => card.name === anchor))
    const { text, truncated, seen, omitted, nextAnchor, blockedBy } = serializeStore(target.store, start)

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
      { restructure, omitted },
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
    const { merged, deleted, rewritten, skippedUnseen, skippedStale, skippedOverLimit, events } = await this.applyEdits(target.store, result.parsed, seen)
    const touched = merged + deleted + rewritten
    // Persist what this pass did and refused — ONE batch write, tagged with the
    // scope label and session so the settings page can answer "why is that card
    // gone" without a debugger.
    //
    // APPLIED events are all kept (each is a real change to explain), but
    // REFUSED events are capped: a model that cites dozens of unreadable keys
    // produces one refusal per edit, and the ledger is a bounded FIFO — an
    // unbounded flood of "refused" rows would evict exactly the merge/delete
    // records the panel exists for. The counts still reach the log, so the
    // noise stays observable without displacing the signal.
    if (events.length > 0) {
      const session = shortSessionId(sessionId)
      const appliedEvents: typeof events = []
      const rejectedEvents: typeof events = []
      for (const event of events) {
        (event.rejected === undefined ? appliedEvents : rejectedEvents).push(event)
      }
      const kept = [...appliedEvents, ...rejectedEvents.slice(0, MAX_LEDGER_REJECTED_PER_PASS)]
      this.root.recordLedgerBatch(kept.map(event => ({ ...event, scope: target.label, pass: 'curate' as const, session })))
      if (rejectedEvents.length > kept.length - appliedEvents.length) {
        this.log.info(`memory curate: "${target.label}" recorded ${String(kept.length - appliedEvents.length)} of ${String(rejectedEvents.length)} refused edit(s)`)
      }
    }
    if (skippedUnseen > 0) {
      // The model named cards whose BODY it was never shown (the index is
      // always whole, card bodies are not). Rejecting those is what keeps a
      // truncated pass from deleting a card it never read.
      this.log.warn(`memory curate: "${target.label}" skipped ${String(skippedUnseen)} edit(s) citing cards beyond the input cap`)
    }
    if (skippedStale > 0) {
      // The card was shown, then changed during the model call: the edit was
      // decided on a view that no longer exists.
      this.log.info(`memory curate: "${target.label}" skipped ${String(skippedStale)} edit(s) whose cards changed during the pass`)
    }
    if (skippedOverLimit > 0) {
      // Well-formed edits refused by the cited-keys ceiling. Counted, because
      // the model otherwise gets no signal that it asked for too much at once.
      this.log.warn(`memory curate: "${target.label}" skipped ${String(skippedOverLimit)} edit(s) over the ${String(MAX_CURATE_CITED_KEYS)}-cited-keys ceiling`)
    }
    if (touched > 0) {
      const parts = [
        merged > 0 ? `${String(merged)} merged` : '',
        deleted > 0 ? `${String(deleted)} deleted` : '',
        rewritten > 0 ? `${String(rewritten)} rewritten` : '',
      ].filter(part => part !== '')
      this.log.info(`memory curate: ${parts.join(', ')} in "${target.label}"`)
      // Progress: the no-progress counter starts over.
      this.root.clearCurateStall(target.label)
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
        // A completed whole-store pass clears the no-progress counter too:
        // leaving a stale count would let ONE later no-op truncated pass push
        // the store straight to the back-off limit.
        this.root.clearCurateStall(target.label)
      } else if (touched === 0) {
        this.log.warn(`memory curate: "${target.label}" still over budget after a no-op pass; recording to avoid a burn loop (manual review suggested)`)
        this.root.recordCurated(target.label, target.store.fingerprint())
      }
    } else if (touched === 0) {
      // A truncated pass that changed NOTHING. The store stays due (correct —
      // most of it was never reviewed), but "due" plus "no progress" is a burn
      // loop: every cooldown buys a full-price call for the same nothing. The
      // prompt fences off the omitted keys, yet a model may still cite them,
      // return an empty edit list, or have every edit rejected by a guard.
      // Bound the loop the same way the over-budget branch above does: count
      // consecutive no-progress truncated passes and, past the limit, record
      // the store so the sweep backs off and says so out loud.
      const stalled = this.root.recordCurateStall(target.label)
      if (stalled >= CURATE_STALL_LIMIT) {
        this.log.warn(`memory curate: "${target.label}" produced no edits in ${String(stalled)} truncated passes; backing off (manual review suggested)`)
        this.root.recordCurated(target.label, target.store.fingerprint())
        this.root.clearCurateStall(target.label)
      }
    }
    // Rotation: the card list order is deterministic, so a truncated pass that
    // always restarted at the top would drop the SAME tail forever and those
    // cards would never be reviewed by anyone. The next pass starts at the
    // first card THIS one could not carry; a pass that saw everything clears
    // the entry. The anchor is a key rather than an offset precisely because
    // the edits above delete cards: an offset read before them would skip one
    // unreviewed card per deletion. The anchor was omitted, so no edit could
    // have claimed it — it is still there to be found.
    if (blockedBy !== undefined) {
      // Nothing fit: rotating to this card would land on it again every pass.
      // Clear the rotation (so a shrink from any other writer re-opens the
      // store from the top) and say why — a card too big to ever be reviewed
      // needs a human, not another sweep.
      this.log.warn(`memory curate: "${target.label}" card "${blockedBy}" alone exceeds the ${String(MAX_INPUT_CHARS)}-char input budget; it blocks review of the whole store (manual review suggested)`)
      this.root.recordCurateCursor(target.label, undefined)
    } else {
      this.root.recordCurateCursor(target.label, truncated ? nextAnchor : undefined)
    }
  }

  /**
   * Validate every proposed edit against the store and apply the survivors.
   * The edit protocol cites cards BY KEY: a cited key must exist, must have
   * been READ by this pass (its body was in the prompt — see `seen`), must
   * not be pinned (a pin is the user's explicit "always inject this" intent,
   * so no edit may rewrite or drop one), and may be cited at most once per
   * pass — violating any of these rejects the whole edit. Deletes land first,
   * then merges/rewrites dedupe against what actually SURVIVES (never against
   * cards this very pass removes). Writes hit the disk-backed store
   * immediately, so "surviving" is simply the store's current state minus
   * the keys the edit itself cites.
   *
   * @param seen - topic → content hash of every card whose BODY reached the
   *   prompt. The index travels whole, so the model can NAME a card it was
   *   never shown; without this check a truncated pass could delete one.
   */
  private async applyEdits(
    store: MemoryStore,
    structured: unknown,
    seen: ReadonlyMap<string, string>,
  ): Promise<{
    merged: number
    deleted: number
    rewritten: number
    skippedUnseen: number
    skippedStale: number
    /** Well-formed edits refused by the cited-keys ceiling. */
    skippedOverLimit: number
    /** What this pass did and refused, for the caller to persist with its
     *  scope label and session id (see MemoryRoot.recordLedger). */
    events: Array<Omit<LedgerEntry, 'at' | 'scope' | 'pass' | 'session'>>
  }> {
    const nothing = { merged: 0, deleted: 0, rewritten: 0, skippedUnseen: 0, skippedStale: 0, skippedOverLimit: 0, events: [] }
    if (typeof structured !== 'object' || structured === null) return nothing
    const edits = (structured as { edits?: unknown }).edits
    if (!Array.isArray(edits)) return nothing

    const pinned = store.pinnedSet()
    const cited = new Set<string>()
    let applied = 0
    let merged = 0
    let deleted = 0
    let rewritten = 0
    let skippedUnseen = 0
    let skippedStale = 0
    let skippedOverLimit = 0
    const events: Array<Omit<LedgerEntry, 'at' | 'scope' | 'pass' | 'session'>> = []

    /** Why one edit was rejected whole (see {@link claim}).
     *  - `unseen`: a cited card's body never reached the prompt (input cap).
     *  - `stale`: the body WAS sent, but the card changed since — the model's
     *    decision was made on a view that no longer exists (a concurrent
     *    memory_save / distill write during the model call).
     *  - `invalid`: shape, existence, pin, or the cited-keys ceiling. */
    type ClaimFailure = 'unseen' | 'stale' | 'over-limit' | 'invalid'

    /** The edit's cited keys, or a rejection reason. Enforces the cited-keys
     *  ceiling (an edit that would push the pass past MAX_CURATE_CITED_KEYS is
     *  skipped, not fatal to other edits) and the read-before-edit rule. */
    const claim = (keys: unknown): { ok: true, keys: string[] } | { ok: false, reason: ClaimFailure } => {
      if (!Array.isArray(keys) || keys.length === 0) return { ok: false, reason: 'invalid' }
      // A well-formed edit that would push the pass past the ceiling: a POLICY
      // refusal, not malformed input, so it is counted and recorded rather
      // than dropped silently (the model gets no other signal that it asked
      // for too much in one edit).
      if (cited.size + keys.length > MAX_CURATE_CITED_KEYS) return { ok: false, reason: 'over-limit' }
      const out: string[] = []
      for (const key of keys) {
        if (typeof key !== 'string' || !isValidTopic(key)) return { ok: false, reason: 'invalid' }
        if (cited.has(key) || pinned.has(key)) return { ok: false, reason: 'invalid' }
        const card = store.get(key)
        if (card === undefined) return { ok: false, reason: 'invalid' }
        // Read-before-edit, both halves of it. The INDEX travels whole while
        // card bodies do not, so the model can name a card it was never shown
        // (unseen); and because the model call is awaited for up to three
        // minutes, a card it WAS shown can be rewritten underneath it by
        // memory_save / the distiller (stale). Either way the edit's premise
        // is gone and applying it would silently lose the newer content.
        const shown = seen.get(key)
        if (shown === undefined) return { ok: false, reason: 'unseen' }
        if (shown !== contentHash(cardFingerprint(card))) return { ok: false, reason: 'stale' }
        out.push(key)
      }
      return { ok: true, keys: out }
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
      const claimResult = claim(edit.topics)
      if (!claimResult.ok) {
        if (claimResult.reason === 'unseen') skippedUnseen += 1
        else if (claimResult.reason === 'stale') skippedStale += 1
        else if (claimResult.reason === 'over-limit') skippedOverLimit += 1
        if (claimResult.reason !== 'invalid') {
          events.push({ op: 'delete', keys: citedKeysOf(edit.topics), rejected: claimResult.reason })
        }
        continue
      }
      const keys = claimResult.keys
      keys.forEach(key => cited.add(key))
      for (const key of keys) {
        if (await store.remove(key, 'curate-delete')) deleted += 1
      }
      events.push({ op: 'delete', keys })
      applied += 1
    }

    // Stage 2: merges and rewrites, in the model's order.
    for (const raw of edits) {
      if (applied >= MAX_CURATE_EDITS) break
      const edit = raw as ProposedEdit
      if (edit.op === 'rewrite') {
        const claimResult = claim(edit.topic === undefined ? undefined : [edit.topic])
        if (!claimResult.ok) {
          if (claimResult.reason === 'unseen') skippedUnseen += 1
          else if (claimResult.reason === 'stale') skippedStale += 1
          else if (claimResult.reason === 'over-limit') skippedOverLimit += 1
          if (claimResult.reason !== 'invalid') {
            events.push({ op: 'rewrite', keys: citedKeysOf(edit.topic === undefined ? undefined : [edit.topic]), rejected: claimResult.reason })
          }
          continue
        }
        const keys = claimResult.keys
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
        events.push({ op: 'rewrite', keys: [card.name] })
        applied += 1
        rewritten += 1
        continue
      }
      if (edit.op !== 'merge') continue
      const claimResult = claim(edit.topics)
      if (!claimResult.ok) {
        if (claimResult.reason === 'unseen') skippedUnseen += 1
        else if (claimResult.reason === 'stale') skippedStale += 1
        else if (claimResult.reason === 'over-limit') skippedOverLimit += 1
        if (claimResult.reason !== 'invalid') {
          events.push({ op: 'merge', keys: citedKeysOf(edit.topics), rejected: claimResult.reason })
        }
        continue
      }
      const keys = claimResult.keys
      const target = edit.target as { topic?: unknown, summary?: unknown, category?: unknown, content?: unknown } | undefined
      if (typeof target !== 'object' || target === null) continue
      // The target is either one of the cited keys (that card is rewritten in
      // place) or a fresh key the survivors converge onto.
      const rawTargetKey = typeof target.topic === 'string' ? target.topic : ''
      const targetKey = keys.includes(rawTargetKey) ? rawTargetKey : slugifyTopic(rawTargetKey)
      if (!isValidTopic(targetKey)) continue
      // A merge consolidates TWO OR MORE sources. The one exception is a
      // RENAME — a single card moved onto a new key — because no other op can
      // express it: `rewrite` keeps the key, and there is no create op. The
      // restructure directive asks for exactly this ("a legacy key should not
      // survive this pass"), and before this exception a lone legacy card
      // could never satisfy it.
      const isRename = keys.length === 1 && !keys.includes(targetKey)
      if (keys.length < 2 && !isRename) continue
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
        if (key !== targetKey) await store.remove(key, isRename ? 'curate-rename' : 'curate-merge')
      }
      events.push({ op: isRename ? 'rename' : 'merge', keys, target: targetKey })
      applied += 1
      merged += 1
    }

    return { merged, deleted, rewritten, skippedUnseen, skippedStale, skippedOverLimit, events }
  }
}
