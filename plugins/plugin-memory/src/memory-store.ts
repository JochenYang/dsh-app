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
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { MemoryCategory, MemoryDistillActivity, MemoryLlmAuditRun, MemoryProjectSummary } from './types.ts'
import { MEMORY_CATEGORIES } from './types.ts'

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
 * Card-backed memory store over one scope directory. All methods throw on I/O
 * failure; callers (tool execute / route handlers) translate that into
 * user-facing errors.
 */
export class MemoryStore {
  readonly dir: string
  private readonly topicsDirPath: string
  private readonly indexPath: string
  private readonly legacyPath: string
  private readonly legacyMdPath: string
  private readonly configPath: string
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
   * `op` reports what happened: created | updated (body/summary/category
   * changed, `updated` bumped) | unchanged (byte-identical, no bump, so a
   * no-op save does not re-arm the curator). Throws on invalid input —
   * callers pre-validate with {@link validateCardInput} for friendly errors.
   */
  upsert(input: { name: string, category: MemoryCategory, summary?: string, body: string }): { op: 'created' | 'updated' | 'unchanged', card: TopicCard } {
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
    this.reindex()
    return { op: existing === undefined ? 'created' : 'updated', card }
  }

  /** Delete one card and its pin; rebuilds the index. False when absent. */
  remove(name: string): boolean {
    if (!isValidTopic(name)) return false
    const path = join(this.topicsDirPath, `${name}.md`)
    if (!existsSync(path)) return false
    rmSync(path)
    // Drop the pin BEFORE the index rebuild: a crash may leave a card without
    // its pin (visible, harmless), never an index/pin pointing at a ghost.
    this.removePin(name)
    this.reindex()
    return true
  }

  /** Drop every card, the index, the legacy archive and every pin (full reset). */
  clear(): void {
    if (existsSync(this.topicsDirPath)) rmSync(this.topicsDirPath, { recursive: true, force: true })
    if (existsSync(this.indexPath)) rmSync(this.indexPath)
    if (existsSync(this.legacyPath)) rmSync(this.legacyPath)
    if (existsSync(this.legacyMdPath)) rmSync(this.legacyMdPath)
    this.writeConfig({ pinned: [] })
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
  forget(match: string): { removed: string[], remaining: number } {
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
      rmSync(join(this.topicsDirPath, `${card.name}.md`), { force: true })
      this.removePin(card.name)
    }
    if (doomed.length > 0) this.reindex()
    return { removed: doomed.map(card => card.name), remaining: this.list().length }
  }

  // --- pins (keyed by topic name) -------------------------------------------

  /** Topic keys pinned to always inject. Pin persists in config.json and
   *  survives content rewrites — that is the point of keying by topic. */
  pinnedSet(): Set<string> {
    const pins = this.readConfigJson().pinned
    return new Set(Array.isArray(pins) ? pins.filter((p): p is string => typeof p === 'string' && isValidTopic(p)) : [])
  }

  /** Pin a card by topic key; false when already pinned or the card is absent. */
  addPin(name: string): boolean {
    if (!isValidTopic(name) || this.get(name) === undefined) return false
    const pins = [...this.pinnedSet()]
    if (pins.includes(name)) return false
    this.writeConfig({ pinned: [...pins, name] })
    this.reindex()
    return true
  }

  /** Unpin a card by topic key; false when it was not pinned. */
  removePin(name: string): boolean {
    const pins = [...this.pinnedSet()]
    if (!pins.includes(name)) return false
    this.writeConfig({ pinned: pins.filter(p => p !== name) })
    if (existsSync(this.indexPath)) this.reindex()
    return true
  }

  // --- index -----------------------------------------------------------------

  /** Rebuild index.md from the live cards (host-owned; hand edits overwritten). */
  reindex(): void {
    const cards = this.list()
    const pinned = this.pinnedSet()
    if (cards.length === 0) {
      if (existsSync(this.indexPath)) rmSync(this.indexPath)
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
  migrateLegacy(): { migrated: number, pinsRemapped: number, pinsDropped: string[] } {
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
    this.reindex()
    if (existsSync(this.legacyMdPath)) rmSync(this.legacyMdPath)
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
export function removeProject(rootDir: string, slug: string): void {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${slug}`)
  rmSync(join(rootDir, 'projects', slug), { recursive: true, force: true })
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
    this.distillStatePath = join(dir, 'distill-state.json')
    this.llmAuditPath = join(dir, 'llm-audit.json')
  }

  /** Project store for a workspace cwd (cheap: no I/O until a write). */
  projectFor(cwd: string): MemoryStore {
    return new MemoryStore(join(this.dir, 'projects', projectSlug(cwd)), cwd)
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
    return new MemoryStore(dir)
  }

  /** Migrate every store whose legacy timeline file is still present (boot). */
  migrateAll(log?: { info(msg: string): void }): void {
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
        const { migrated, pinsRemapped, pinsDropped } = store.migrateLegacy()
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
        }
      }
    } catch {
      // absent or unreadable → fresh state
    }
    return { version: 1, sessions: {}, activity: [] }
  }
}
