/**
 * Two-level persistence for cross-session memory, TOPIC-CARD model:
 *
 *   <root>/topics/<key>.md                 — one GLOBAL card per topic (user
 *                                            preferences, habits; injected into
 *                                            every session)
 *   <root>/index.md                        — GLOBAL index, one line per card,
 *                                            REBUILT BY THE HOST after every
 *                                            write (hand edits are overwritten)
 *   <root>/projects/<slug>/topics/<key>.md — one PROJECT card per topic
 *                                            (decisions, conventions, lessons;
 *                                            injected only into sessions of
 *                                            that workspace)
 *   <root>/projects/<slug>/index.md        — PROJECT index
 *   <root>/projects/<slug>/project.json    — {cwd} stamp written on first save
 *   <root>/config.json                     — master toggle + distill toggle +
 *                                            pinned topic keys + storeVersion
 *   <root>/distill-state.json              — per-session distill progress +
 *                                            run traces + curated hashes +
 *                                            similarity-suspect log
 *   <root>/llm-audit.json                  — background LLM cost rows
 *
 * A card is the unit of identity: saving the same topic key again REWRITES the
 * card (upsert), so knowledge converges instead of piling up a dated timeline.
 * Dates live in the frontmatter (created/updated), never in the body — the
 * body carries no "when", only "what holds".
 *
 * Legacy layout: a pre-card `memory.md` (append-only `- [category] date` lines)
 * is converted by {@link MemoryStore.migrateLegacy} at boot and kept as
 * `memory.legacy.md` (read-only archive, never deleted implicitly).
 *
 * Project identity: slug = sanitized basename + '-' + 8 hex of the full cwd
 * (same basename in two parents never collides). Sessions with no cwd see
 * only the global scope — hard isolation, not prompt-level discipline.
 *
 * Reads are existsSync-guarded and constructors do NO I/O (a project store
 * is instantiated per prompt assembly), so the dirs appear only on first
 * write. All writes are crash-safe (tmp + rename).
 *
 * @module @dsh-app/plugin-memory/memory-store
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { removeTree } from './remove-tree.ts'
import type { MemoryCategory, MemoryDistillActivity, MemoryLlmAuditRun, MemoryProjectSummary } from './types.ts'
import { ARCHIVE_MAX_FILES, ARCHIVE_RETENTION_DAYS, MEMORY_CATEGORIES } from './types.ts'

/** One card body gets at most this many characters: room for a consolidated
 *  fact (roughly two legacy lines) without bloating every session's re-read. */
export const MAX_TOPIC_BODY_CHARS = 400

/** Index hook length ceiling: the summary is what future saves route by, so
 *  it must state coverage in one glance. */
export const MAX_SUMMARY_CHARS = 40

/** Topic-key shape: ASCII kebab-case, also the card filename. Chinese topic
 *  words slugify to '' and are rejected — the model must translate. */
export const TOPIC_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u

/** Similarity thresholds for the write-time gate (char-bigram Jaccard over
 *  normalized text). τ_dup hard-rejects/redirects (near-verbatim only, by
 *  design); [τ_rel, τ_dup) is reported as "related" so the MODEL arbitrates.
 *  Calibration evidence (2026-09-15 probe on realistic Chinese entries):
 *  reworded statements of the SAME fact score 0.35–0.45, so a τ_rel of 0.6
 *  would never fire — 0.3 catches the rewording band; disjoint topics about
 *  the same tool score ≤0.2 and stay below the floor. */
export const SIM_DUPLICATE = 0.8
export const SIM_RELATED = 0.3

/** Archive bounds — declared in `types.ts` (shared with the browser half) and
 *  re-exported here so the store's callers keep one import site. */
export { ARCHIVE_MAX_FILES, ARCHIVE_RETENTION_DAYS } from './types.ts'

/** Why a card was removed — diagnostics only, never stored with the copy. */
export type ArchiveReason = 'forget' | 'curate-delete' | 'curate-merge' | 'curate-rename' | 'light-sweep-dup' | 'unspecified'

/** One parsed topic card. */
export interface TopicCard {
  /** Topic key = filename stem (authoritative, even if frontmatter disagrees). */
  name: string
  category: MemoryCategory
  summary: string
  /** `YYYY-MM-DD` of first save. */
  created: string
  /** `YYYY-MM-DD` of last content change. */
  updated: string
  /** Card text (no dates, no prefixes). */
  body: string
  /** Hand-edited file whose frontmatter failed to parse: the body is carried
   *  verbatim (like the old hand-note lines) and the card is injectable but
   *  not upsertable until rewritten. */
  malformed: boolean
}

/** Normalize a model-proposed topic into a key: lowercase, non [a-z0-9]
 *  runs collapse to '-', trimmed, capped at 48 chars. '' means the proposal
 *  carried no ASCII letters/digits at all (e.g. pure Chinese) — reject it. */
export function slugifyTopic(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '')
  return slug
}

/** Whether a topic key is well-formed (also the traversal fence for card paths). */
export function isValidTopic(name: string): boolean {
  return TOPIC_KEY_PATTERN.test(name)
}

/** Local-date stamp for frontmatter fields. */
export function todayStamp(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Normalize text for matching: lowercase, keep every Unicode letter/digit
 *  (Latin, CJK, kana, Hangul, Cyrillic, ...), drop the rest. Shared by dedupe,
 *  similarity, forget matching and search so all of them agree on what counts
 *  as "the same text". */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Character bigrams of the normalized text (a single char is its own set). */
function bigrams(normalized: string): Set<string> {
  if (normalized.length === 0) return new Set()
  if (normalized.length === 1) return new Set([normalized])
  const out = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2))
  return out
}

/** Jaccard similarity over character bigrams of the normalized inputs.
 *  0 when either side normalizes to nothing. Chinese-native: CJK text has no
 *  spaces to tokenize by, and bigrams catch rewording that substring tests miss. */
export function contentSimilarity(a: string, b: string): number {
  const setA = bigrams(normalizeForMatch(a))
  const setB = bigrams(normalizeForMatch(b))
  if (setA.size === 0 || setB.size === 0) return 0
  let shared = 0
  for (const gram of setA) { if (setB.has(gram)) shared += 1 }
  return shared / (setA.size + setB.size - shared)
}

/**
 * Strip commit-id-shaped tokens from MODEL-PROPOSED content. A candidate is
 * a 7-12 hex-char run that stands alone — not part of a longer word or a
 * hyphenated slug like `agent-comm-hub-cf86ffc4` — and mixes letters and
 * digits: pure digits are counts/timestamps (1048576, unix seconds), pure
 * letters are ordinary words, and neither is a commit id. The NEVER lists
 * already forbid work-log entries; this is the mechanical backstop so a
 * cited id never lands in a card that is re-injected into every future
 * session. Collapses the double space a strip can leave behind.
 */
const COMMIT_ID_CANDIDATE = /(?<![\w-])[0-9a-f]{7,12}(?![\w-])/giu

export function stripCommitIds(content: string): string {
  const stripped = content.replace(COMMIT_ID_CANDIDATE, (token) =>
    /[a-f]/iu.test(token) && /\d/u.test(token) ? '' : token)
  return stripped.replace(/\s{2,}/gu, ' ').trim()
}

/**
 * Credential-looking fragments that must never be persisted. Every pattern
 * needs either a key NAME with a `:`/`=` separator or a known token PREFIX:
 * bare words alone never match, so legitimate entries about token budgets or
 * model limits ("token 上限导致失败") pass through. No `g` flag — these run
 * through RegExp.test, where `g` would make lastIndex stateful.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /api[_-]?key\s*[:=：]/iu,
  /\bsecret\s*[:=：]/iu,
  /passw(or)?d\s*[:=：]/iu,
  /\btoken\s*[:=：]/iu,
  /\bauthorization\s*[:=：]/iu,
  /\bbearer\s+[A-Za-z0-9]/iu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/u,
  /xox[bpas]-[A-Za-z0-9-]+/u,
  /密[码钥]\s*[是为:：=]/u,
  /口令\s*[是为:：=]/u,
]

/**
 * Whether `text` looks like it carries a credential (key/token/password).
 * Checked before every persist path (tool save, distill apply, curator merge)
 * so a pasted secret never lands in a card that is re-injected into every
 * future session.
 */
export function containsCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
}

// ---------------------------------------------------------------------------
// Legacy timeline helpers (migration only — the card model has no prefixes)
// ---------------------------------------------------------------------------

/** Legacy entry-line prefix shape: `- [category] YYYY-MM-DD `. */
const ENTRY_PREFIX = /^- \[[a-z]+\] \d{4}-\d{2}-\d{2} /u
/** Capturing variant: category and date of a legacy entry line. */
const FULL_ENTRY_PREFIX = /^- \[([a-z]+)\] (\d{4}-\d{2}-\d{2}) /u

/** One parsed line of a LEGACY memory file. */
export interface LegacyEntry {
  raw: string
  category: string | undefined
  date: string | undefined
  content: string
}

/** Split a legacy timeline file into entries (empty lines dropped). */
export function parseEntries(text: string): LegacyEntry[] {
  const out: LegacyEntry[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const match = FULL_ENTRY_PREFIX.exec(line)
    if (match !== null) {
      out.push({ raw: line, category: match[1], date: match[2], content: line.slice(match[0].length) })
    } else {
      out.push({ raw: line, category: undefined, date: undefined, content: line })
    }
  }
  return out
}

/** Strip a legacy `- [category] YYYY-MM-DD ` prefix from model- or
 *  migration-facing content. Idempotent: plain content passes through. */
export function stripEntryPrefix(content: string): string {
  const trimmed = content.trim()
  return ENTRY_PREFIX.test(trimmed) ? trimmed.replace(ENTRY_PREFIX, '').trim() : content
}

/**
 * Repair double-prefixed legacy lines (pre-guard era). Two shapes collapse to
 * one prefix, keeping the OUTER category/date; a bare-date echo whose value
 * DIFFERS is content and left alone. Idempotent. Migration input hygiene only.
 */
export function repairDoublePrefix(text: string): { fixed: string, count: number } {
  let count = 0
  const lines = text.split('\n').map(line => {
    const outer = ENTRY_PREFIX.exec(line)
    if (outer === null) return line
    const date = /\d{4}-\d{2}-\d{2}/u.exec(outer[0])?.[0]
    const rest = line.slice(outer[0].length)
    if (ENTRY_PREFIX.test(rest)) {
      count += 1
      return `${outer[0]}${rest.replace(ENTRY_PREFIX, '')}`
    }
    if (date !== undefined && rest.startsWith(`${date} `)) {
      count += 1
      return `${outer[0]}${rest.slice(date.length + 1)}`
    }
    return line
  })
  return { fixed: lines.join('\n'), count }
}

// ---------------------------------------------------------------------------
// Card (de)serialization
// ---------------------------------------------------------------------------

/** Render one card to its file text (frontmatter + blank line + body). */
export function renderCard(card: TopicCard): string {
  return [
    '---',
    `name: ${card.name}`,
    `category: ${card.category}`,
    `summary: ${card.summary}`,
    `created: ${card.created}`,
    `updated: ${card.updated}`,
    '---',
    '',
    card.body,
    '',
  ].join('\n')
}

/**
 * Clock-independent content fingerprint of one card: everything a reader
 * would call its CONTENT, with the dates left out.
 *
 * Used as the read-before-edit witness, so it must not move on its own. The
 * dates CAN: a card whose frontmatter lost `created`/`updated` falls back to
 * `todayStamp()` on every parse, so a pass serialized at 23:59 and validated
 * after midnight would see a different hash for byte-identical content and
 * reject a legitimate edit as stale. A summary-only rewrite does NOT bump
 * `updated` either, yet it changes what the next reader sees — leaving the
 * dates out is what makes this both stable and sufficient.
 */
export function cardFingerprint(card: TopicCard): string {
  return [card.name, card.category, card.summary, card.body, card.malformed ? 'malformed' : ''].join('\u0000')
}

/**
 * Parse a card file tolerantly. The filename stem is the authoritative key.
 * A file whose frontmatter is missing/broken (hand edits) still yields a card
 * with `malformed: true` and the WHOLE raw text as body — injectable verbatim,
 * excluded from upsert targeting until rewritten, never silently dropped.
 */
export function parseCard(name: string, text: string): TopicCard {
  const today = todayStamp()
  const fail = (): TopicCard => ({
    name, category: 'fact', summary: '(hand-edited)', created: today, updated: today,
    body: text.trim(), malformed: true,
  })
  // Hand-edited files arrive with CRLF endings on Windows hosts; normalize
  // before the fence search or the whole card silently degrades to malformed.
  const normalized = text.replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---\n')) return fail()
  const close = normalized.indexOf('\n---\n', 4)
  if (close === -1) return fail()
  const header = normalized.slice(4, close)
  const body = normalized.slice(close + 5).trim()
  const fields: Record<string, string> = {}
  for (const line of header.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  const category = fields.category
  if (body === '') return fail()
  if (!MEMORY_CATEGORIES.includes(category as MemoryCategory)) return fail()
  return {
    name,
    category: category as MemoryCategory,
    summary: (fields.summary ?? '').slice(0, MAX_SUMMARY_CHARS) || '(no summary)',
    created: fields.created ?? today,
    updated: fields.updated ?? today,
    body,
    malformed: false,
  }
}

/** Crash-safe replace: write a sibling temp file, then rename over. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** Category display order for the index and injection (stable, greppable). */
const CATEGORY_ORDER: Record<MemoryCategory, number> = {
  preference: 0, convention: 1, decision: 2, lesson: 3, fact: 4,
}

/** Index line for one card: `- [category] name — summary (updated date)`. */
function indexLine(card: TopicCard, pinned: Set<string>): string {
  const pin = pinned.has(card.name) ? '📌 ' : ''
  const summary = card.malformed ? '(hand-edited file)' : card.summary
  return `- ${pin}[${card.category}] ${card.name} — ${summary} (updated ${card.updated})`
}

/** Validate an upsert payload; returns an error string or undefined. Exported
 *  so the tool and the distiller share one rule set. The summary rides the
 *  index into every session's prompt, so it is credential-checked alongside
 *  the body — a secret is not safer at 40 characters. */
export function validateCardInput(input: { name: string, category: string, summary: string, body: string }): string | undefined {
  if (!isValidTopic(input.name)) return `invalid topic key "${input.name}"; must match ${TOPIC_KEY_PATTERN.source} (ASCII kebab-case)`
  if (!MEMORY_CATEGORIES.includes(input.category as MemoryCategory)) {
    return `unknown category "${input.category}"; must be one of: ${MEMORY_CATEGORIES.join(', ')}`
  }
  if (input.summary === '') return 'summary is required (≤40 chars, states what the card covers)'
  if (input.summary.length > MAX_SUMMARY_CHARS) return `summary too long (${String(input.summary.length)}/${String(MAX_SUMMARY_CHARS)} chars)`
  if (input.body === '') return 'empty content'
  if (input.body.length > MAX_TOPIC_BODY_CHARS) return `content too long (${String(input.body.length)}/${String(MAX_TOPIC_BODY_CHARS)} chars)`
  if (containsCredential(input.summary) || containsCredential(input.body)) return 'content looks like it carries a credential; refusing to persist'
  return undefined
}

/**
 * Card-backed memory store over one scope directory. Writes are asynchronous —
 * each returns a promise that rejects on I/O failure, which the callers (tool
 * execute / route handlers) translate into user-facing errors.
 */
export class MemoryStore {
  readonly dir: string
  private readonly topicsDirPath: string
  private readonly indexPath: string
  private readonly legacyPath: string
  private readonly legacyMdPath: string
  private readonly configPath: string
  /** `<scope>/archive/` — deleted cards, kept for ARCHIVE_RETENTION_DAYS. */
  private readonly archiveDirPath: string
  /** Last archive-write failure (settings page: is the undo actually there?). */
  private lastArchiveFailure: string | undefined
  /** Owner of the shared state files, when this store belongs to a root.
   *  Set by {@link MemoryRoot}; a bare store (tests, ad-hoc probes) has none
   *  and simply records no ledger. */
  private ledgerOwner: MemoryRoot | undefined
  /** This store's label inside the ledger ('global' or the project slug). */
  private ledgerScope = 'global'
  /** Project cwd stamped into project.json on the first write. */
  private readonly sourceCwd: string | undefined

  constructor(dir: string, sourceCwd?: string) {
    this.dir = dir
    this.sourceCwd = sourceCwd
    this.topicsDirPath = join(dir, 'topics')
    this.indexPath = join(dir, 'index.md')
    this.legacyPath = join(dir, 'memory.md')
    this.legacyMdPath = join(dir, 'memory.legacy.md')
    this.configPath = join(dir, 'config.json')
    this.archiveDirPath = join(dir, 'archive')
  }

  // --- cards ---------------------------------------------------------------

  /** All cards, sorted by category order then updated-desc then name. */
  list(): TopicCard[] {
    if (!existsSync(this.topicsDirPath)) return []
    const cards: TopicCard[] = []
    for (const entry of readdirSync(this.topicsDirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -3)
      if (!isValidTopic(name)) continue
      let text = ''
      try {
        text = readFileSync(join(this.topicsDirPath, entry.name), 'utf8')
      } catch {
        continue
      }
      cards.push(parseCard(name, text))
    }
    cards.sort((a, b) =>
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
      || b.updated.localeCompare(a.updated)
      || a.name.localeCompare(b.name))
    return cards
  }

  /** One card by topic key (undefined when absent or the key is malformed). */
  get(name: string): TopicCard | undefined {
    if (!isValidTopic(name)) return undefined
    const path = join(this.topicsDirPath, `${name}.md`)
    if (!existsSync(path)) return undefined
    try {
      return parseCard(name, readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  }

  /**
   * Create or rewrite one card (the ONLY write path besides migration).
   * `op` reports what happened: created | updated | unchanged. `updated` is
   * bumped only when the BODY changed — a summary-only rewrite changes what
   * the index and the injection carry, but it does not make the card's text
   * newer, and `cardFingerprint` (the read-before-edit witness) covers the
   * summary independently of the date. Rejects on invalid input — callers
   * pre-validate with {@link validateCardInput} for friendly errors.
   */
  async upsert(input: { name: string, category: MemoryCategory, summary?: string, body: string }): Promise<{ op: 'created' | 'updated' | 'unchanged', card: TopicCard }> {
    const existing = this.get(input.name)
    const summary = input.summary !== undefined && input.summary !== '' ? input.summary : existing?.summary ?? ''
    const invalid = validateCardInput({ name: input.name, category: input.category, summary, body: input.body })
    if (invalid !== undefined) throw new Error(invalid)
    const today = todayStamp()
    if (existing !== undefined && !existing.malformed
      && existing.body === input.body && existing.summary === summary && existing.category === input.category) {
      return { op: 'unchanged', card: existing }
    }
    const card: TopicCard = {
      name: input.name,
      category: input.category,
      summary,
      created: existing?.created ?? today,
      updated: existing === undefined || existing.body !== input.body ? today : existing.updated,
      body: input.body,
      malformed: false,
    }
    mkdirSync(this.topicsDirPath, { recursive: true })
    atomicWrite(join(this.topicsDirPath, `${input.name}.md`), renderCard(card))
    this.stampProject()
    await this.reindex()
    return { op: existing === undefined ? 'created' : 'updated', card }
  }

  /** Delete one card and its pin; rebuilds the index. False when absent.
   *
   *  The card is ARCHIVED first (see {@link archiveCard}): the removal is
   *  irreversible on disk, but the content stays recoverable for
   *  {@link ARCHIVE_RETENTION_DAYS}. `reason` is not stored with the copy —
   *  an archived file is byte-identical to what `topics/<key>.md` held, so it
   *  can be copied straight back.
   */
  async remove(name: string, reason: ArchiveReason = 'unspecified'): Promise<boolean> {
    if (!isValidTopic(name)) return false
    const path = join(this.topicsDirPath, `${name}.md`)
    if (!existsSync(path)) return false
    const card = this.get(name)
    if (card !== undefined) await this.archiveCard(card, reason)
    await removeTree(path)
    // Drop the pin BEFORE the index rebuild: a crash may leave a card without
    // its pin (visible, harmless), never an index/pin pointing at a ghost.
    await this.removePin(name)
    await this.reindex()
    return true
  }

  /** Drop every card, the index, the legacy archive and every pin (full reset).
   *  The card ARCHIVE goes too: this is the user asking for a clean slate, and
   *  keeping deleted cards behind a reset would contradict what the button
   *  says. */
  async clear(): Promise<void> {
    // Record BEFORE the wipe: this is the most destructive action available
    // (it takes the archive with it), so the ledger entry is the only record
    // left of what was there. Keys are read first because `topics/` is about
    // to go.
    const doomed = this.list().map(card => card.name)
    if (doomed.length > 0) {
      this.ledgerOwner?.recordLedgerBatch([{ scope: this.ledgerScope, pass: 'forget', op: 'delete', keys: doomed }])
    }
    if (existsSync(this.topicsDirPath)) await removeTree(this.topicsDirPath)
    if (existsSync(this.indexPath)) await removeTree(this.indexPath)
    if (existsSync(this.legacyPath)) await removeTree(this.legacyPath)
    if (existsSync(this.legacyMdPath)) await removeTree(this.legacyMdPath)
    if (existsSync(this.archiveDirPath)) await removeTree(this.archiveDirPath)
    this.writeConfig({ pinned: [] })
  }

  // --- archive (undo for every automated deletion) ----------------------------

  /**
   * Copy one card into `<scope>/archive/<YYYY-MM-DD>/<key>.md` before it is
   * removed. Never throws: a failed archive must not block the removal the
   * caller asked for, and a card that is gone is worse than one that is
   * un-undoable.
   *
   * A same-day re-deletion of the same key does NOT overwrite the earlier
   * copy: it lands beside it as `<key>~<HHMMSS>.md`. Overwriting would keep
   * the OLDER text and lose the version that was just deleted — the opposite
   * of what an undo is for, and reachable in one curator pass (delete a key,
   * then merge another card onto that same key). `~` cannot appear in a
   * valid topic key, so the suffix is unambiguous.
   */
  private async archiveCard(card: TopicCard, reason: ArchiveReason): Promise<void> {
    try {
      const dir = join(this.archiveDirPath, todayStamp())
      mkdirSync(dir, { recursive: true })
      let target = join(dir, `${card.name}.md`)
      if (existsSync(target)) {
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/gu, '')
        target = join(dir, `${card.name}~${stamp}.md`)
      }
      atomicWrite(target, renderCard(card))
    } catch (error) {
      // Diagnostics only — the caller's removal proceeds regardless, but the
      // failure is remembered so the settings page can say the undo is not
      // available rather than promising one that is not there.
      console.warn(`memory archive: could not archive "${card.name}" (${reason}): ${String(error)}`)
      this.lastArchiveFailure = String(error)
      return
    }
    // Pruning runs OUTSIDE the archive write's try: a prune failure is not an
    // archive failure, and reporting it as one sends a reader looking at the
    // wrong thing. It must also never undo a copy that already landed.
    try {
      await this.pruneArchive()
    } catch (error) {
      console.warn(`memory archive: prune failed (the archive itself is intact): ${String(error)}`)
    }
  }

  /** Last archive failure, for the settings page (undefined = healthy). */
  lastArchiveError(): string | undefined {
    return this.lastArchiveFailure
  }

  /**
   * Point this store at the root that owns the shared state files, and name
   * the scope it logs under. Called by {@link MemoryRoot}; a store created
   * bare (tests, ad-hoc probes) records no ledger rather than failing.
   */
  attachLedger(owner: MemoryRoot, scope: string): void {
    this.ledgerOwner = owner
    this.ledgerScope = scope
  }

  /**
   * Enforce the archive's age and count bounds (oldest first). Every removal
   * goes through {@link removeTree}: these are FILES and (for an emptied day)
   * an empty real directory, but the walker is the repository's one sanctioned
   * remover — it unlinks a link instead of reading through it, so a junction
   * placed inside `archive/` can never be followed into someone else's tree.
   */
  private async pruneArchive(): Promise<void> {
    if (!existsSync(this.archiveDirPath)) return
    const cutoff = Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files: Array<{ path: string, mtimeMs: number }> = []
    for (const entry of readdirSync(this.archiveDirPath, { withFileTypes: true })) {
      // isDirectory() is FALSE for a junction (a reparse point is reported as
      // a link), so a linked day directory is skipped rather than walked.
      if (!entry.isDirectory()) continue
      const dayDir = join(this.archiveDirPath, entry.name)
      for (const file of readdirSync(dayDir)) {
        const full = join(dayDir, file)
        try {
          files.push({ path: full, mtimeMs: statSync(full).mtimeMs })
        } catch {
          // vanished mid-scan — nothing to prune
        }
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const doomed: string[] = []
    const fresh = files.filter(file => file.mtimeMs >= cutoff)
    for (const file of files) if (file.mtimeMs < cutoff) doomed.push(file.path)
    for (const file of fresh.slice(0, Math.max(0, fresh.length - ARCHIVE_MAX_FILES))) doomed.push(file.path)
    for (const path of doomed) {
      try {
        await removeTree(path)
      } catch {
        // a failed prune is retried on the next archive write
      }
    }
    // Drop day directories the prune emptied, so the tree stays readable.
    for (const entry of readdirSync(this.archiveDirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dayDir = join(this.archiveDirPath, entry.name)
      try {
        // Emptiness is checked first: a non-empty day is left for a later
        // prune, not swept here.
        if (readdirSync(dayDir).length === 0) await removeTree(dayDir)
      } catch {
        // non-empty or busy — leave it
      }
    }
  }

  /** Archived cards, newest day first then key order, for the settings page.
   *  `file` is the archive file's stem (the restore handle — two same-day
   *  copies of one topic differ only by their suffix). Only entries that can
   *  actually be restored are listed: the key must be a valid topic, so a
   *  stray `README.md` in the archive is skipped rather than offered as a
   *  button that would always fail. */
  archivedCards(): Array<{ day: string, file: string, topic: string, bytes: number }> {
    if (!existsSync(this.archiveDirPath)) return []
    const out: Array<{ day: string, file: string, topic: string, bytes: number }> = []
    for (const entry of readdirSync(this.archiveDirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dayDir = join(this.archiveDirPath, entry.name)
      for (const name of readdirSync(dayDir)) {
        if (!name.endsWith('.md')) continue
        const file = name.slice(0, -3)
        const topic = file.split('~')[0]!
        if (!isValidTopic(topic)) continue
        try {
          out.push({ day: entry.name, file, topic, bytes: statSync(join(dayDir, name)).size })
        } catch {
          // vanished mid-scan
        }
      }
    }
    out.sort((a, b) => b.day.localeCompare(a.day) || a.topic.localeCompare(b.topic))
    return out
  }

  /**
   * Put one archived card back into `topics/`. `file` is the archive file's
   * stem from {@link archivedCards} (which may carry a same-day suffix);
   * `topic` is the key it restores to. Refuses when the key is taken
   * (restoring would overwrite a live card) or when the copy is not a valid
   * card file. Returns the outcome for the caller to report.
   */
  async restoreArchived(day: string, file: string, topic: string): Promise<'restored' | 'missing' | 'occupied' | 'invalid'> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !isValidTopic(topic)) return 'invalid'
    // The stem is a topic key optionally followed by `~HHMMSS`; anything else
    // (a path separator, a dot, an over-long name) is refused outright.
    if (!/^[a-z0-9][a-z0-9-]{0,47}(?:~\d{6})?$/u.test(file)) return 'invalid'
    const source = join(this.archiveDirPath, day, `${file}.md`)
    if (!existsSync(source)) return 'missing'
    if (existsSync(join(this.topicsDirPath, `${topic}.md`))) return 'occupied'
    let text: string
    try {
      text = readFileSync(source, 'utf8')
    } catch {
      return 'missing'
    }
    if (parseCard(topic, text).malformed) return 'invalid'
    mkdirSync(this.topicsDirPath, { recursive: true })
    atomicWrite(join(this.topicsDirPath, `${topic}.md`), text)
    await this.reindex()
    return 'restored'
  }

  /** How many cards the archive holds (settings page). */
  archiveCount(): number {
    return this.archivedCards().length
  }

  /**
   * Drop ONE archived copy for good. The undo is still available until the
   * user says otherwise; after that the copy is gone (not archived again —
   * that would make this button a no-op).
   *
   * @returns whether a copy was actually removed.
   */
  async deleteArchived(day: string, file: string): Promise<boolean> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return false
    // Same fence as restoreArchived: the stem is a topic key optionally
    // followed by `~HHMMSS`, so no separator or dot can reach the filesystem.
    if (!/^[a-z0-9][a-z0-9-]{0,47}(?:~\d{6})?$/u.test(file)) return false
    const target = join(this.archiveDirPath, day, `${file}.md`)
    if (!existsSync(target)) return false
    await removeTree(target)
    await this.dropEmptyDay(day)
    return true
  }

  /**
   * Drop EVERY archived copy in this scope, and return how many went. This is
   * the "recycle bin" the archive was missing: without it the only ways to
   * shed a copy were waiting out {@link ARCHIVE_RETENTION_DAYS} or deleting the
   * whole scope (which takes the live cards with it).
   */
  async clearArchive(): Promise<number> {
    const count = this.archiveCount()
    if (existsSync(this.archiveDirPath)) await removeTree(this.archiveDirPath)
    return count
  }

  /** Remove a day directory once its last copy is gone (keeps the tree tidy). */
  private async dropEmptyDay(day: string): Promise<void> {
    const dayDir = join(this.archiveDirPath, day)
    try {
      if (existsSync(dayDir) && readdirSync(dayDir).length === 0) await removeTree(dayDir)
    } catch {
      // non-empty or busy — the prune's day cleanup will get it
    }
  }

  // --- queries ---------------------------------------------------------------

  /** Whether a card body EQUIVALENT to `content` exists (exact normalized
   *  match — the distiller's cheap pre-dedupe before similarity runs). */
  hasContent(content: string): boolean {
    const needle = normalizeForMatch(content)
    if (needle === '') return false
    return this.list().some(card => !card.malformed && normalizeForMatch(card.body) === needle)
  }

  /** Cards similar to `content` (bigram Jaccard over summary+body), best
   *  first, scores above the noise floor only. The write-time gate's input. */
  findSimilar(content: string, floor = 0.3, limit = 5): Array<{ name: string, score: number }> {
    const scored: Array<{ name: string, score: number }> = []
    for (const card of this.list()) {
      if (card.malformed) continue
      const score = contentSimilarity(content, `${card.summary} ${card.body}`)
      if (score >= floor) scored.push({ name: card.name, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** Substring search over name+summary+body (the recall/forget matcher). */
  search(query: string): TopicCard[] {
    const needle = normalizeForMatch(query)
    if (needle === '') return this.list()
    return this.list().filter(card =>
      normalizeForMatch(`${card.name} ${card.summary} ${card.body}`).includes(needle))
  }

  /**
   * Remove cards by topic key (exact) or content/summary substring; returns
   * the removed keys. Rebuilds the index once at the end.
   */
  async forget(match: string): Promise<{ removed: string[], remaining: number }> {
    const direct = this.get(match)
    let doomed: TopicCard[] = []
    if (direct !== undefined) {
      doomed = [direct]
    } else {
      const needle = normalizeForMatch(match)
      if (needle !== '') {
        doomed = this.list().filter(card =>
          normalizeForMatch(`${card.summary} ${card.body}`).includes(needle))
      }
    }
    for (const card of doomed) {
      await this.archiveCard(card, 'forget')
      await removeTree(join(this.topicsDirPath, `${card.name}.md`))
      await this.removePin(card.name)
    }
    if (doomed.length > 0) await this.reindex()
    const removed = doomed.map(card => card.name)
    // Written HERE rather than by each caller so every path that deletes —
    // the tool, the settings route, any future caller — is covered by
    // construction instead of by remembering to.
    if (removed.length > 0) {
      this.ledgerOwner?.recordLedger({ scope: this.ledgerScope, pass: 'forget', op: 'delete', keys: removed })
    }
    return { removed, remaining: this.list().length }
  }

  // --- pins (keyed by topic name) -------------------------------------------

  /** Topic keys pinned to always inject. Pin persists in config.json and
   *  survives content rewrites — that is the point of keying by topic. */
  pinnedSet(): Set<string> {
    const pins = this.readConfigJson().pinned
    return new Set(Array.isArray(pins) ? pins.filter((p): p is string => typeof p === 'string' && isValidTopic(p)) : [])
  }

  /** Pin a card by topic key; false when already pinned or the card is absent. */
  async addPin(name: string): Promise<boolean> {
    if (!isValidTopic(name) || this.get(name) === undefined) return false
    const pins = [...this.pinnedSet()]
    if (pins.includes(name)) return false
    this.writeConfig({ pinned: [...pins, name] })
    await this.reindex()
    return true
  }

  /** Unpin a card by topic key; false when it was not pinned. */
  async removePin(name: string): Promise<boolean> {
    const pins = [...this.pinnedSet()]
    if (!pins.includes(name)) return false
    this.writeConfig({ pinned: pins.filter(p => p !== name) })
    if (existsSync(this.indexPath)) await this.reindex()
    return true
  }

  // --- index -----------------------------------------------------------------

  /** Rebuild index.md from the live cards (host-owned; hand edits overwritten). */
  async reindex(): Promise<void> {
    const cards = this.list()
    const pinned = this.pinnedSet()
    if (cards.length === 0) {
      if (existsSync(this.indexPath)) await removeTree(this.indexPath)
      return
    }
    const text = [
      '# Memory index (auto-generated from topics/; edits are overwritten)',
      '',
      ...cards.map(card => indexLine(card, pinned)),
      '',
    ].join('\n')
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.indexPath, text)
  }

  /** Current index text ('' when no cards). */
  indexText(): string {
    return existsSync(this.indexPath) ? readFileSync(this.indexPath, 'utf8').trim() : ''
  }

  /** Content fingerprint over all cards (curator change detection). */
  fingerprint(): string {
    return contentHash(this.list().map(card => renderCard(card)).join('\n'))
  }

  /** Card count + total size of topics/ (settings page). */
  stats(): { cards: number, sizeBytes: number } {
    const cards = this.list()
    let sizeBytes = 0
    if (existsSync(this.topicsDirPath)) {
      for (const entry of readdirSync(this.topicsDirPath)) {
        try {
          sizeBytes += statSync(join(this.topicsDirPath, entry)).size
        } catch {
          // a card vanished mid-stat — skip it
        }
      }
    }
    return { cards: cards.length, sizeBytes }
  }

  /** Topics directory path (the settings "edit by hand" affordance). */
  get storePath(): string {
    return this.topicsDirPath
  }

  // --- migration (legacy timeline → topic cards) -------------------------------

  /** Whether the legacy append-only file still awaits conversion. */
  needsMigration(): boolean {
    return existsSync(this.legacyPath)
  }

  /**
   * Convert the legacy `memory.md` timeline into topic cards, deterministically
   * (no model): each surviving entry becomes one `legacy-<hash8>` card, legacy
   * pins (content-keyed) are remapped onto the card carrying that content, and
   * the old file is renamed to `memory.legacy.md` (archive, never deleted).
   * Identical entries converge on one card (same hash key). Idempotent in
   * effect: a crash mid-way re-runs cleanly since upsert overwrites by key.
   */
  async migrateLegacy(): Promise<{ migrated: number, pinsRemapped: number, pinsDropped: string[] }> {
    if (!this.needsMigration()) return { migrated: 0, pinsRemapped: 0, pinsDropped: [] }
    const raw = readFileSync(this.legacyPath, 'utf8')
    const { fixed } = repairDoublePrefix(raw)
    const entries = parseEntries(fixed)
    const today = todayStamp()
    const oldPins = this.readConfigJson().pinned
    const oldPinSet = new Set(Array.isArray(oldPins) ? oldPins.filter((p): p is string => typeof p === 'string') : [])
    /** Normalized body → card name, for remapping legacy content-keyed pins. */
    const bodyKeys = new Map<string, string>()
    let migrated = 0
    for (const entry of entries) {
      const body = stripCommitIds(entry.content).replace(/\s+/gu, ' ').trim()
      if (body === '' || containsCredential(body)) continue
      const name = `legacy-${createHash('sha256').update(normalizeForMatch(body)).digest('hex').slice(0, 8)}`
      const category = MEMORY_CATEGORIES.includes(entry.category as MemoryCategory)
        ? entry.category as MemoryCategory
        : 'fact'
      const summary = body.length <= MAX_SUMMARY_CHARS ? body : `${body.slice(0, MAX_SUMMARY_CHARS - 1)}…`
      const card: TopicCard = {
        name, category, summary,
        created: entry.date ?? today,
        updated: entry.date ?? today,
        body: body.slice(0, MAX_TOPIC_BODY_CHARS),
        malformed: false,
      }
      mkdirSync(this.topicsDirPath, { recursive: true })
      atomicWrite(join(this.topicsDirPath, `${name}.md`), renderCard(card))
      bodyKeys.set(normalizeForMatch(card.body), name)
      migrated += 1
    }
    // Pin remap, in preference order: content match → the migrated card; an
    // ALREADY-remapped topic key (a prior run crashed between writeConfig and
    // the rename) → carried over, so the window loses nothing; anything else
    // is reported as dropped instead of vanishing silently.
    const newPins = new Set<string>()
    const pinsDropped: string[] = []
    for (const pin of oldPinSet) {
      const mapped = bodyKeys.get(pin)
      if (mapped !== undefined) {
        newPins.add(mapped)
      } else if (isValidTopic(pin) && this.get(pin) !== undefined) {
        newPins.add(pin)
      } else {
        pinsDropped.push(pin)
      }
    }
    if (this.sourceCwd !== undefined) this.stampProject()
    this.writeConfig({ pinned: [...newPins], storeVersion: 2 })
    await this.reindex()
    if (existsSync(this.legacyMdPath)) await removeTree(this.legacyMdPath)
    renameSync(this.legacyPath, this.legacyMdPath)
    return { migrated, pinsRemapped: newPins.size, pinsDropped }
  }

  /** Stamp the project cwd on first write (recovers the full path for the UI). */
  private stampProject(): void {
    if (this.sourceCwd === undefined) return
    const metaPath = join(this.dir, 'project.json')
    if (!existsSync(metaPath)) {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(metaPath, `${JSON.stringify({ cwd: this.sourceCwd }, null, 2)}\n`, 'utf8')
    }
  }

  // --- config (toggles + pins + storeVersion) ----------------------------------

  /** Master toggle; a missing or malformed config means ENABLED — the plugin
   * must not silently vanish from a half-written config. */
  isEnabled(): boolean {
    return this.readConfigField('enabled', true)
  }

  /** Persist the master toggle atomically (preserving the sibling fields). */
  setEnabled(value: boolean): void {
    this.writeConfig({ enabled: value })
  }

  /** Background-distill sub-toggle (the async safety net); defaults ON —
   *  the whole point is that it needs no user attention. */
  isDistillEnabled(): boolean {
    return this.readConfigField('distill', true)
  }

  /** Persist the distill toggle atomically (preserving the master field). */
  setDistillEnabled(value: boolean): void {
    this.writeConfig({ distill: value })
  }

  /** One boolean field out of config.json with a default. */
  private readConfigField(field: string, fallback: boolean): boolean {
    const value = this.readConfigJson()[field]
    return typeof value === 'boolean' ? value : fallback
  }

  /** Merge-write fields into config.json (keeps the sibling fields). */
  private writeConfig(patch: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.configPath, `${JSON.stringify({ ...this.readConfigJson(), ...patch }, null, 2)}\n`)
  }

  /** Raw config.json as a plain object (absent/unreadable → empty). */
  private readConfigJson(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
}

/** Deterministic project directory slug: sanitized basename + 8-hex of the
 * full cwd. Two projects sharing a basename never collide. */
export function projectSlug(cwd: string): string {
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project'
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

/** Generic content fingerprint. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Slug shape the clear route accepts — also the traversal fence. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Whether a slug is well-formed (used to fence the clear route). */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/** One project's summary for the settings page (store view of the wire shape). */
export type ProjectSummary = Pick<MemoryProjectSummary, 'slug' | 'cwd' | 'cards' | 'sizeBytes'>
/** Summarize every project directory, busiest first. */
export function listProjects(rootDir: string): ProjectSummary[] {
  const projectsDir = join(rootDir, 'projects')
  if (!existsSync(projectsDir)) return []
  const out: ProjectSummary[] = []
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(rootDir, 'projects', entry.name)
    let cwd = ''
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
      if (typeof meta === 'object' && meta !== null) {
        const value = (meta as { cwd?: unknown }).cwd
        if (typeof value === 'string') cwd = value
      }
    } catch {
      // missing/stale metadata → keep empty, the slug still identifies it
    }
    const { cards, sizeBytes } = new MemoryStore(dir).stats()
    out.push({ slug: entry.name, cwd, cards, sizeBytes })
  }
  out.sort((a, b) => b.sizeBytes - a.sizeBytes || b.cards - a.cards)
  return out
}

/** Remove one project directory entirely (scoped clear). Rejects malformed
 * slugs before touching the filesystem (traversal fence, defense in depth
 * behind the route's own check). */
export async function removeProject(rootDir: string, slug: string): Promise<void> {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${slug}`)
  // Leave a trace before the directory (and its archive) goes: this is the
  // most destructive per-project action, and a watcher reading the ledger
  // should see the scope emptied rather than silently disappear.
  const root = new MemoryRoot(rootDir)
  const store = root.projectBySlug(slug)
  const doomed = store === undefined ? [] : store.list().map(card => card.name)
  if (doomed.length > 0) {
    root.recordLedgerBatch([{ scope: slug, pass: 'forget', op: 'delete', keys: doomed }])
  }
  await removeTree(join(rootDir, 'projects', slug))
}

/** How many sessions the distill-progress map keeps before the oldest
 * entries are pruned (the map is a cache, not a ledger — a dropped session
 * simply re-distills its full log on next activation). */
const MAX_TRACKED_SESSIONS = 300

/** How many distill-run traces distill-state.json retains (FIFO). */
const MAX_ACTIVITY = 20

/** How many similarity-suspect pairs distill-state.json retains (FIFO). The
 *  write-time gate's tuning data: every ≥τ_dup pair the light sweep notices. */
const MAX_SUSPECTS = 50

/** One session's background-distill progress. */
export interface DistillProgress {
  /** Last session-event seq already consumed by a distill run. */
  seq: number
  /** Unix epoch ms of the last distill run for this session. */
  at: number
  /**
   * Event seq at which this session last saved a card itself through the
   * memory_save tool (absent/0 = never). The distiller consumes only events
   * PAST this point: material up to the save was already judged by the
   * agent, while everything after it has had no second opinion yet.
   */
  savedAtSeq?: number
}

/** Short display id: the uuid segment's first 8 chars (`session-` prefix
 * dropped), e.g. `session-49ce2455-...` → `49ce2455`. */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/u, '').slice(0, 8)
}

/** One background-distill run's trace entry (store view of the wire shape). */
export type DistillActivity = Pick<MemoryDistillActivity, 'at' | 'session' | 'saved' | 'backend' | 'tokens'>
/** One background LLM call's audit record (store view of the wire shape). */
export type LlmAuditRun = Pick<MemoryLlmAuditRun, 'at' | 'source' | 'session' | 'status' | 'inputTokens' | 'outputTokens' | 'durationMs' | 'error'>
/** One similarity-suspect pair noticed by the light sweep. */
export interface SimSuspect {
  at: number
  scope: string
  a: string
  b: string
  score: number
}
/** How many audit rows llm-audit.json retains (FIFO). */
const MAX_AUDIT_RUNS = 100

/**
 * One consolidation event: what a pass (or a tool call) DID to the store.
 * `recordDistill`/`recordLlmAudit` count calls and tokens; this records the
 * OBJECTS, which is what answers "why is that card gone?" — pair it with the
 * archive (`archivedCards`) to also answer "and can I get it back?".
 */
export interface LedgerEntry {
  at: number
  /** Which scope it happened in ('global' or a project slug). */
  scope: string
  /** Which writer: the curator pass, the light sweep, or a tool call. */
  pass: 'curate' | 'light-sweep' | 'forget'
  op: 'merge' | 'delete' | 'rewrite' | 'rename'
  /** The topic keys the operation touched. */
  keys: string[]
  /** Merge/rewrite destination, when it differs from the single cited key. */
  target?: string
  /** Why an edit was REJECTED instead of applied (no write happened).
   *  `over-limit` is a well-formed edit refused by policy (it would cite more
   *  keys than one pass may touch), which the model gets no other signal for. */
  rejected?: 'unseen' | 'stale' | 'over-limit'
  /** Short session id, when the event rode a session (curate only). */
  session?: string
}

/** How many ledger entries distill-state.json retains (FIFO). The archive
 *  files themselves carry the content; this is the index over them. */
export const MAX_LEDGER_ENTRIES = 200

/**
 * Whether a parsed value is a usable ledger entry. The settings page is the
 * only consumer that dereferences every field, so a hand-edited or truncated
 * state file must not be able to crash it (`entry.keys.join` on a non-array,
 * `fmtTime(undefined)`). Entries that fail this are DROPPED, not repaired:
 * an event nobody can render is worth less than a clean list.
 */
function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return false
  if (typeof entry.scope !== 'string') return false
  if (entry.pass !== 'curate' && entry.pass !== 'light-sweep' && entry.pass !== 'forget') return false
  if (entry.op !== 'merge' && entry.op !== 'delete' && entry.op !== 'rewrite' && entry.op !== 'rename') return false
  if (!Array.isArray(entry.keys) || !entry.keys.every(key => typeof key === 'string')) return false
  if (entry.rejected !== undefined && entry.rejected !== 'unseen' && entry.rejected !== 'stale' && entry.rejected !== 'over-limit') return false
  return true
}

/** Persisted shape of llm-audit.json. */
interface LlmAuditState {
  version: 1
  runs: LlmAuditRun[]
}

/** Persisted shape of distill-state.json. */
interface DistillState {
  version: 1
  sessions: Record<string, DistillProgress>
  activity: DistillActivity[]
  /**
   * Content hash of each scope ('global' or a project slug) at its last
   * completed curation pass; a scope whose current fingerprint differs is due
   * again. Absent for state written before curation tracking — the scope
   * then counts as due, never skipped.
   */
  curated?: Record<string, string>
  /** Recent similarity suspects (light-sweep tuning data), bounded FIFO. */
  suspects?: SimSuspect[]
  /**
   * Rotation offset into the card list where the next curation pass starts
   * serializing, per scope. Written only by a TRUNCATED pass (the card list
   * did not fit the input cap): the tail that pass could not carry becomes
   * the HEAD of the next one. Absent means "start at the top".
   *
   * Holds the topic KEY of the first omitted card, not an offset — see
   * `curateCursorOf` for why an offset cannot survive a pass that deletes.
   */
  curateCursor?: Record<string, string>
  /**
   * Consecutive truncated curation passes that produced no edit, per scope.
   * Bounds the burn loop a stalled truncated store would otherwise create:
   * such a store stays due forever (most of it was never reviewed) while
   * every pass costs a model call and changes nothing.
   */
  curateStalls?: Record<string, number>
  /**
   * What recent passes actually did to the cards (bounded FIFO). Answers
   * "why is this card gone" — the archive answers "and how do I get it back".
   */
  ledger?: LedgerEntry[]
}

/**
 * The two-level root: one global store plus per-workspace project stores.
 * The global store's config.json holds the master + distill toggles.
 */
export class MemoryRoot {
  readonly dir: string
  readonly global: MemoryStore
  private readonly distillStatePath: string
  private readonly llmAuditPath: string

  constructor(dir: string) {
    this.dir = dir
    this.global = new MemoryStore(dir)
    this.global.attachLedger(this, 'global')
    this.distillStatePath = join(dir, 'distill-state.json')
    this.llmAuditPath = join(dir, 'llm-audit.json')
  }

  /** Project store for a workspace cwd (cheap: no I/O until a write). */
  projectFor(cwd: string): MemoryStore {
    const store = new MemoryStore(join(this.dir, 'projects', projectSlug(cwd)), cwd)
    store.attachLedger(this, projectSlug(cwd))
    return store
  }

  /** Project store by slug (the settings routes resolve projects by slug,
   *  not cwd; undefined for an unknown or malformed slug). */
  projectBySlug(slug: string): MemoryStore | undefined {
    if (!isValidSlug(slug)) return undefined
    const dir = join(this.dir, 'projects', slug)
    if (!existsSync(dir)) return undefined
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
      const cwd = (meta as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && cwd !== '') return this.projectFor(cwd)
    } catch {
      // missing/stale metadata → operate on the directory as-is
    }
    const store = new MemoryStore(dir)
    store.attachLedger(this, slug)
    return store
  }

  /** Migrate every store whose legacy timeline file is still present (boot). */
  async migrateAll(log?: { info(msg: string): void }): Promise<void> {
    const stores: Array<[string, MemoryStore]> = [['global', this.global]]
    for (const project of listProjects(this.dir)) {
      // projectBySlug (not projectFor) so projects with a missing/stale
      // project.json still migrate — their cards work without the cwd stamp.
      const store = this.projectBySlug(project.slug)
      if (store !== undefined) stores.push([project.slug, store])
    }
    for (const [label, store] of stores) {
      if (!store.needsMigration()) continue
      try {
        const { migrated, pinsRemapped, pinsDropped } = await store.migrateLegacy()
        log?.info(`memory migration: ${label} → ${String(migrated)} topic cards (${String(pinsRemapped)} pins remapped)`)
        if (pinsDropped.length > 0) {
          log?.info(`memory migration: ${label} dropped ${String(pinsDropped.length)} unmatched legacy pin(s)`)
        }
      } catch (error) {
        // Migration must never block the plugin mount; the legacy file stays
        // put and the next boot retries.
        log?.info(`memory migration for ${label} failed (will retry next boot): ${String(error)}`)
      }
    }
  }

  /** Last-consumed event seq for one session (0 when never distilled). */
  distillSeqOf(sessionId: string): number {
    return this.readDistillState().sessions[sessionId]?.seq ?? 0
  }

  /** Advance one session's distill progress and persist (with pruning). */
  advanceDistill(sessionId: string, seq: number): void {
    const state = this.readDistillState()
    state.sessions[sessionId] = { seq, at: Date.now(), savedAtSeq: 0 }
    const ids = Object.keys(state.sessions)
    if (ids.length > MAX_TRACKED_SESSIONS) {
      ids.sort((a, b) => state.sessions[a]!.at - state.sessions[b]!.at)
      for (const id of ids.slice(0, ids.length - MAX_TRACKED_SESSIONS)) {
        delete state.sessions[id]
      }
    }
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** The event seq at which this session last saved a card itself, 0 when
   *  it never did (see DistillProgress.savedAtSeq). */
  ownSaveSeqOf(sessionId: string): number {
    const progress = this.readDistillState().sessions[sessionId]
    return Math.max(0, Math.floor(progress?.savedAtSeq ?? 0))
  }

  /** Record that the session wrote a card itself at the given event seq (the
   *  highest seq keeps winning across repeated saves). */
  recordDirectSave(sessionId: string, seq: number): void {
    const state = this.readDistillState()
    const previous = state.sessions[sessionId]
    state.sessions[sessionId] = {
      seq: previous?.seq ?? 0,
      at: previous?.at ?? 0,
      savedAtSeq: Math.max(previous?.savedAtSeq ?? 0, Math.max(0, Math.floor(seq))),
    }
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Recent distill-run traces, newest first (bounded FIFO). */
  distillActivity(): DistillActivity[] {
    return [...this.readDistillState().activity].sort((a, b) => b.at - a.at)
  }

  /** Content hash recorded at a target's last completed curation pass. */
  curatedHashOf(key: string): string | undefined {
    return this.readDistillState().curated?.[key]
  }

  /** Record a target's post-curation content hash and persist. */
  recordCurated(key: string, hash: string): void {
    const state = this.readDistillState()
    state.curated = { ...state.curated, [key]: hash }
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /**
   * The topic key where a scope's next curation pass starts serializing.
   * `undefined` means the top of the card list — the state a pass that saw
   * the WHOLE list always leaves behind.
   *
   * A KEY, not an offset: a truncated pass deletes cards as it goes, and an
   * offset taken before those deletions would skip exactly as many
   * unreviewed cards as were removed. The key always names a card no edit of
   * that pass could touch (it was omitted, hence never claimable).
   */
  curateCursorOf(key: string): string | undefined {
    const anchor = this.readDistillState().curateCursor?.[key]
    return typeof anchor === 'string' && anchor !== '' ? anchor : undefined
  }

  /**
   * Record where a scope's next pass starts. Only a TRUNCATED pass writes an
   * anchor: the first card it could not carry becomes the next pass's head.
   * A pass that saw the whole list clears the entry.
   */
  recordCurateCursor(key: string, anchor: string | undefined): void {
    const state = this.readDistillState()
    const cursor = { ...state.curateCursor }
    if (anchor !== undefined && anchor !== '') cursor[key] = anchor
    else delete cursor[key]
    state.curateCursor = cursor
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /**
   * Count one more consecutive truncated pass that changed nothing, and
   * return the running total. The curator uses it to bound the burn loop a
   * stalled truncated store would otherwise create (it stays due forever
   * because most of it was never reviewed, while each pass costs a full
   * model call and produces no edit).
   */
  recordCurateStall(key: string): number {
    const state = this.readDistillState()
    const stalls = { ...state.curateStalls }
    const next = (typeof stalls[key] === 'number' ? stalls[key] : 0) + 1
    stalls[key] = next
    state.curateStalls = stalls
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
    return next
  }

  /** Clear a scope's no-progress counter (progress resumed, or it backed off). */
  clearCurateStall(key: string): void {
    const state = this.readDistillState()
    const stalls = { ...state.curateStalls }
    if (!(key in stalls)) return
    delete stalls[key]
    state.curateStalls = stalls
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Record one similarity suspect the light sweep noticed (bounded FIFO). */
  recordSuspect(scope: string, a: string, b: string, score: number): void {
    const state = this.readDistillState()
    const suspects = state.suspects ?? []
    suspects.push({ at: Date.now(), scope, a, b, score: Math.round(score * 1000) / 1000 })
    state.suspects = suspects.slice(-MAX_SUSPECTS)
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Recent similarity suspects, newest first. */
  simSuspects(): SimSuspect[] {
    return [...(this.readDistillState().suspects ?? [])].sort((a, b) => b.at - a.at)
  }

  /**
   * Append consolidation events (bounded FIFO) and persist — ONE read/write
   * for the whole batch. A curator pass can produce dozens of events, and the
   * per-entry form would read and rewrite the entire state file (which also
   * carries every session cursor) once per event.
   *
   * Never throws: this is DIAGNOSTIC data. A failure to record why a card was
   * deleted must not turn a completed deletion into an error for the caller,
   * so the write is best-effort and the caller's operation stands.
   */
  recordLedgerBatch(entries: ReadonlyArray<Omit<LedgerEntry, 'at'> & { at?: number }>): void {
    if (entries.length === 0) return
    try {
      const state = this.readDistillState()
      const ledger = state.ledger ?? []
      for (const entry of entries) ledger.push({ ...entry, at: entry.at ?? Date.now() })
      state.ledger = ledger.slice(-MAX_LEDGER_ENTRIES)
      mkdirSync(this.dir, { recursive: true })
      atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch (error) {
      console.warn(`memory ledger: could not record ${String(entries.length)} event(s): ${String(error)}`)
    }
  }

  /** Append one consolidation event and persist (see recordLedgerBatch). */
  recordLedger(entry: Omit<LedgerEntry, 'at'> & { at?: number }): void {
    this.recordLedgerBatch([entry])
  }

  /**
   * Recent consolidation events, newest first.
   *
   * Ties on `at` are broken by INSERTION order, reversed: a pass writes its
   * events in one batch, so several can share a millisecond, and a stable
   * sort alone would return them oldest-first — contradicting the contract
   * every caller (and the settings page's rendering order) relies on.
   */
  ledgerEntries(): LedgerEntry[] {
    const stored = this.readDistillState().ledger ?? []
    return stored
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
      .map(item => item.entry)
  }

  /** Append one distill trace and persist (bounded, survives restarts). */
  recordDistill(sessionId: string, saved: number, backend?: 'direct' | 'subagent', tokens?: number): void {
    const state = this.readDistillState()
    state.activity.push({ at: Date.now(), session: shortSessionId(sessionId), saved, backend, tokens })
    if (state.activity.length > MAX_ACTIVITY) {
      state.activity = state.activity.slice(-MAX_ACTIVITY)
    }
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Append one background-LLM audit row and persist (bounded FIFO). */
  recordLlmAudit(run: Omit<LlmAuditRun, 'at'> & { at?: number }): void {
    let runs: LlmAuditRun[] = []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.llmAuditPath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { runs?: unknown }).runs)) {
        runs = (parsed as { runs: LlmAuditRun[] }).runs
      }
    } catch {
      // absent or unreadable → fresh list
    }
    runs.push({ ...run, at: run.at ?? Date.now() })
    if (runs.length > MAX_AUDIT_RUNS) runs = runs.slice(-MAX_AUDIT_RUNS)
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.llmAuditPath, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`)
  }

  /** Recent audit rows, newest first (bounded FIFO). */
  llmAudit(): LlmAuditRun[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.llmAuditPath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { runs?: unknown }).runs)) {
        return [...(parsed as { runs: LlmAuditRun[] }).runs].sort((a, b) => b.at - a.at)
      }
    } catch {
      // absent or unreadable → empty
    }
    return []
  }

  /** Read (and repair) distill-state.json; missing/malformed → empty. */
  private readDistillState(): DistillState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.distillStatePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const sessions = (parsed as { sessions?: unknown }).sessions
        const activity = (parsed as { activity?: unknown }).activity
        const curated = (parsed as { curated?: unknown }).curated
        const suspects = (parsed as { suspects?: unknown }).suspects
        const curateCursor = (parsed as { curateCursor?: unknown }).curateCursor
        const curateStalls = (parsed as { curateStalls?: unknown }).curateStalls
        const ledger = (parsed as { ledger?: unknown }).ledger
        return {
          version: 1,
          sessions: typeof sessions === 'object' && sessions !== null
            ? sessions as Record<string, DistillProgress>
            : {},
          activity: Array.isArray(activity) ? activity as DistillActivity[] : [],
          curated: typeof curated === 'object' && curated !== null
            ? curated as Record<string, string>
            : undefined,
          suspects: Array.isArray(suspects) ? suspects as SimSuspect[] : [],
          curateCursor: typeof curateCursor === 'object' && curateCursor !== null
            ? curateCursor as Record<string, string>
            : undefined,
          curateStalls: typeof curateStalls === 'object' && curateStalls !== null
            ? curateStalls as Record<string, number>
            : undefined,
          ledger: Array.isArray(ledger) ? ledger.filter(isLedgerEntry) : [],
        }
      }
    } catch {
      // absent or unreadable → fresh state
    }
    return { version: 1, sessions: {}, activity: [] }
  }
}
