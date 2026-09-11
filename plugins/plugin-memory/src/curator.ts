/**
 * The background curator — the consolidation pass that keeps a memory file
 * lean over time. Where the distiller only APPENDS new entries, the curator
 * reviews a file that has grown past a threshold and proposes edits: merge
 * near-duplicates, delete stale entries, re-categorize.
 *
 * Identical safety model to the distiller: a direct LLM call proposes (the
 * JSON contract lives in the prompt, see {@link buildCuratePrompt}) and the
 * HOST validates every edit before the file is rewritten atomically —
 * referenced lines must exist verbatim and be cited at most once; a merge
 * must produce one lean standard entry that duplicates nothing that remains.
 * User-pinned lines are additionally off limits: any edit citing one is
 * rejected whole, so a pin never survives its line as a dangling record.
 * Any failure leaves the file untouched and retries on the next trigger.
 *
 * Trigger: the distiller hands us the triggering session right after it
 * persisted entries. Two gates keep the pass cheap and rare:
 *   - Cooldown: at most one sweep per {@link CURATE_COOLDOWN_MS}; requests
 *     inside the window coalesce into a single trailing sweep whose session
 *     is re-resolved by id at fire time (the original agent may be disposed
 *     by then — a dead session drops the pass and every due file simply
 *     waits for the next distill save).
 *   - Change detection: a file whose content hash is unchanged since its
 *     last completed pass is skipped, so a sweep only pays for files a
 *     writer actually touched.
 * Files below {@link CURATE_MIN_ENTRIES} are left alone: the distiller keeps
 * them healthy on its own and the injection budget still fits.
 *
 * @module @dsh-app/plugin-memory/curator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { directRouteOf, type SessionLike } from './distiller.ts'
import { resolveLlm, streamJson, type DirectRoute } from './llm-direct.ts'
import {
  containsCredential,
  contentHash,
  listProjects,
  MAX_ENTRY_CHARS,
  normalizeForMatch,
  parseEntries,
  shortSessionId,
  stripEntryPrefix,
  todayStamp,
  type MemoryRoot,
  type MemoryStore,
} from './memory-store.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/** A file below this many lines is not worth an LLM pass. */
const CURATE_MIN_ENTRIES = 8

/** Minimum spacing between sweeps. Distill saves arrive one quiet window
 * apart (60 s), so without this gate an active session re-sweeps every
 * untouched file each minute; requests inside the window coalesce into one
 * trailing sweep. */
const CURATE_COOLDOWN_MS = 10 * 60_000

/** Cap on the input file text handed to the model (characters); anything
 *  older than this tail is left for a future pass. */
const MAX_INPUT_CHARS = 40_000

/** Hard cap on edits accepted from one run (a big file is handled over
 *  several passes, not one destructive sweep). */
const MAX_CURATE_EDITS = 20

/** Output allowance for one curate answer. Every edit quotes its cited lines
 *  VERBATIM (a Chinese entry runs 300+ characters) on top of the merged text,
 *  so a legitimate multi-edit answer blows past the shared 2k default and gets
 *  truncated into unparseable JSON — which fails soft and would retry forever
 *  without ever curating. The limit is an allowance, not a spend. */
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
 * Build the curate prompt as system (task + rules + output contract) and
 * user (the memory file) halves — the same split the distiller uses.
 * Pinned entries are listed in a separate section and called out as
 * untouchable: the host rejects any edit citing one, so telling the model
 * up front saves a wasted proposal.
 */
export function buildCuratePrompt(input: string, pinned: readonly string[] = []): { system: string, user: string } {
  const system = [
    'You are the memory curator of an AI coding assistant. Review the memory file below',
    'and propose EDITS that keep it lean and accurate over time.',
    '',
    'Rules:',
    '- merge: two or more entries that now say the same thing (near-duplicates, the same fact',
    '  restated on different dates, or one superseding the other). One refreshed entry replaces them all.',
    '- delete: entries that are stale (already superseded), wrong, or no longer relevant.',
    '- delete: entries that are work logs rather than reusable knowledge — reports of what a',
    '  session did ("X 已完成", "修复全落地", "审查后…"), file-by-file change lists, commit',
    '  ids, task summaries. Keep only what a future session could act on.',
    '- Prefer keeping the SURVIVING entry when one strictly supersedes another: delete the stale one.',
    '- NEVER mention credentials (API keys, tokens, passwords) — not even in a rewrite.',
    ...(pinned.length > 0
      ? ['- Entries listed under "Pinned entries" were pinned by the user and are NEVER edited:',
         '  don\'t cite those lines in a merge or delete — the whole edit is rejected when you do.']
      : []),
    '- Each cited line must appear EXACTLY as written below (verbatim, including the bullet and',
    '  the "- [category] YYYY-MM-DD" prefix). The same line may be cited at most once across all edits.',
    '- A merge result is ONE concise line in the user\'s language, at most 500 characters,',
    '  content TEXT only — no "- [category] date" prefix, no bullets (the host stamps the prefix).',
    '- An empty edits array is a VALID answer — prefer it over marginal edits.',
    `- At most ${String(MAX_CURATE_EDITS)} edits total.`,
    '',
    'Reply with ONE JSON object and nothing else:',
    `{"edits": [{"op": "merge", "lines": ["<verbatim line>"], "category": "<${MEMORY_CATEGORIES.join('|')}>", "content": "<merged text, no prefix>"},`,
    '           {"op": "delete", "lines": ["<verbatim line>"]}]}',
    '"category" and "content" apply to merge edits only.',
  ].join('\n')
  const user = [
    '--- Memory file ---',
    input,
    ...(pinned.length > 0 ? ['', '--- Pinned entries (user-fixed, never edited) ---', ...pinned] : []),
  ].join('\n')
  return { system, user }
}

/** A possibly-malformed edit as proposed by the model (pre-validation). */
interface ProposedEdit {
  op?: unknown
  lines?: unknown
  category?: unknown
  content?: unknown
}

/** One consolidation target. */
interface CurateTarget {
  label: string
  store: MemoryStore
}

/**
 * The background curator. {@link attach} provides the cleanup seam; the
 * trigger arrives through {@link runAfterDistill} (called by the host when
 * a distill run persisted entries). Everything below the trigger is
 * fail-soft: a bad model answer or a dead session just logs and retries on
 * the next distill.
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
   * session drops the pass — every due file waits for the next save, which
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
   * One full pass over every due file. The model route comes from the
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
        this.log.warn(`memory curate for "${target.label}" failed (file untouched, will retry on next distill): ${String(error)}`)
      }
    }
  }

  /**
   * Every DUE store (global + projects with a resolvable cwd): at or above
   * the entry threshold AND changed since its last completed pass — a file
   * whose hash still matches the recorded one was already consolidated, and
   * re-reading the same text would only propose the same nothing.
   */
  private selectTargets(): CurateTarget[] {
    const targets: CurateTarget[] = []
    const consider = (key: string, store: MemoryStore): void => {
      const text = store.read()
      if (parseEntries(text).length < CURATE_MIN_ENTRIES) return
      if (this.root.curatedHashOf(key) === contentHash(text)) return
      targets.push({ label: key, store })
    }
    consider('global', this.root.global)
    for (const project of listProjects(this.root.dir)) {
      if (project.cwd === '') continue
      consider(project.slug, this.root.projectFor(project.cwd))
    }
    return targets
  }

  /** The pass body for one file: one direct call, then the validated edits. */
  private async curate(target: CurateTarget, route: DirectRoute, sessionId: SessionId): Promise<void> {
    const text = target.store.read()
    const input = text.length > MAX_INPUT_CHARS
      ? `${text.slice(0, MAX_INPUT_CHARS)}\n[note: file tail beyond ${String(MAX_INPUT_CHARS)} chars was omitted in this pass]`
      : text

    // The pinned lines go to the model verbatim so it can leave them alone;
    // applyEdits enforces the same rule regardless of what the model proposes.
    const pinnedKeys = target.store.pinnedSet()
    const pinnedLines = parseEntries(text)
      .filter(entry => pinnedKeys.has(normalizeForMatch(entry.content)))
      .map(entry => entry.raw)

    const { system, user } = buildCuratePrompt(input, pinnedLines)
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
    const { merged, deleted } = this.applyEdits(target.store, result.parsed)
    if (merged + deleted > 0) {
      this.log.info(`memory curate: ${merged > 0 ? `${String(merged)} merged` : ''}${merged > 0 && deleted > 0 ? ', ' : ''}${deleted > 0 ? `${String(deleted)} deleted` : ''} from "${target.label}"`)
    }
    // Mark the pass done so unchanged files stop re-sweeping. Only a pass
    // that saw the WHOLE file may mark it: with the input cap active the
    // omitted head was never reviewed and stays due. The hash is of the
    // post-edit file — the content this pass actually leaves behind.
    if (text.length <= MAX_INPUT_CHARS) {
      this.root.recordCurated(target.label, contentHash(target.store.read()))
    }
  }

  /** Validate every proposed edit against the file; rewrites once on any hit. */
  private applyEdits(store: MemoryStore, structured: unknown): { merged: number, deleted: number } {
    if (typeof structured !== 'object' || structured === null) return { merged: 0, deleted: 0 }
    const edits = (structured as { edits?: unknown }).edits
    if (!Array.isArray(edits)) return { merged: 0, deleted: 0 }

    const entries = parseEntries(store.read())
    if (entries.length === 0) return { merged: 0, deleted: 0 }
    const lines = entries.map(entry => entry.raw)
    const lineIndex = new Map<string, number>()
    lines.forEach((line, index) => { if (!lineIndex.has(line)) lineIndex.set(line, index) })
    const referenced = new Set<number>()

    // Pinned lines are the user's explicit "always inject this" intent, so no
    // edit may rewrite or drop one: an edit citing a pinned line is rejected
    // whole (the model is told which lines those are, but the guarantee is
    // enforced here). Skipping the edit — rather than re-pinning a merge — is
    // what keeps config.json free of pins that no longer match a line.
    const pinned = store.pinnedSet()
    const isPinned = (index: number): boolean =>
      pinned.has(normalizeForMatch(entries[index]!.content))

    // Two stages: deletes claim their lines first, then merges dedupe against
    // what actually SURVIVES (kept lines plus merges already accepted) —
    // never against lines this very pass removes, otherwise "merge A+B back
    // to A's own wording" would collide with the line it replaces.
    interface AcceptedMerge { indices: number[], category: MemoryCategory, oneLine: string }
    const merges: AcceptedMerge[] = []
    let merged = 0
    let deleted = 0

    const claim = (edit: ProposedEdit): number[] | undefined => {
      const cited = edit.lines
      if (!Array.isArray(cited) || cited.length === 0) return undefined
      const indices: number[] = []
      for (const line of cited) {
        if (typeof line !== 'string') return undefined
        const index = lineIndex.get(line)
        if (index === undefined || referenced.has(index) || isPinned(index)) return undefined
        indices.push(index)
      }
      return indices
    }

    for (const raw of edits) {
      if (merged + deleted >= MAX_CURATE_EDITS) break
      const edit = raw as ProposedEdit
      if (edit.op !== 'merge' && edit.op !== 'delete') continue
      const category = edit.category
      const content = typeof edit.content === 'string' ? edit.content.trim() : ''
      if (edit.op === 'delete') {
        const indices = claim(edit)
        if (indices === undefined) continue
        indices.forEach(index => referenced.add(index))
        deleted += indices.length
        continue
      }
      if (!MEMORY_CATEGORIES.includes(category as MemoryCategory) || content === '') continue
      // Same prefix-echo hazard as distill proposals (see stripEntryPrefix):
      // the cited lines carry the prefix, so models copy it into the rewrite.
      const oneLine = stripEntryPrefix(content).replace(/\s+/gu, ' ').trim()
      if (oneLine.length === 0 || oneLine.length > MAX_ENTRY_CHARS || containsCredential(oneLine)) continue
      const indices = claim(edit)
      if (indices === undefined) continue
      merges.push({ indices, category: category as MemoryCategory, oneLine })
    }

    // Exact-content dedupe (same rule as memory_save's hasContent): a merge
    // must duplicate nothing that survives — its own cited lines are exempt
    // (they are being replaced), other accepted merges are not. Comparison
    // is on the prefix-stripped CONTENT, never the raw line (the bullet and
    // `- [category] date` prefix would otherwise make equality impossible).
    const survives = (index: number): boolean => !referenced.has(index) && !merges.some(m => m.indices.includes(index))
    const additions: string[] = []
    const accepted: string[] = []
    for (const merge of merges) {
      // The cap applies to BOTH stages (the first loop only counts deletes —
      // a run of pure merges would otherwise sail past MAX_CURATE_EDITS).
      if (merged + deleted >= MAX_CURATE_EDITS) break
      const needle = normalizeForMatch(merge.oneLine)
      if (needle === '') continue
      const duplicates =
        entries.some((entry, index) => survives(index) && normalizeForMatch(entry.content) === needle)
        || accepted.some(other => other === needle)
      if (duplicates) continue
      merge.indices.forEach(index => referenced.add(index))
      additions.push(`- [${merge.category}] ${todayStamp()} ${merge.oneLine}`)
      accepted.push(needle)
      merged += 1
    }

    if (referenced.size === 0) return { merged: 0, deleted: 0 }
    const kept = lines.filter((_, index) => !referenced.has(index))
    store.replace([...kept, ...additions].join('\n'))
    return { merged, deleted }
  }
}