/**
 * Two-level persistence for cross-session memory, TOPIC-CARD model:
 *
 *   <root>/config.json                     — master toggle + background-
 *                                            maintenance toggle + pinned topic
 *                                            keys + storeVersion. It lives at
 *                                            the root (it is what is left of
 *                                            the old global store) and is NOT
 *                                            card storage.
 *   <root>/distill-state.json              — the curator's own bookkeeping:
 *                                            curated hashes, rotation anchors,
 *                                            stalls, similarity suspects and
 *                                            the consolidation ledger. The FILE
 *                                            NAME is historical, from the pass
 *                                            that once wrote per-session
 *                                            progress here; the reader ignores
 *                                            the keys it no longer defines
 *                                            (an old file is not an error)
 *   <root>/llm-audit.json                  — background LLM cost rows
 *   <root>/projects/<slug>/topics/<key>.md — one PROJECT card per topic
 *                                            (decisions, conventions, lessons;
 *                                            injected only into sessions of
 *                                            that workspace)
 *   <root>/projects/<slug>/index.md        — PROJECT index, one line per card,
 *                                            REBUILT BY THE HOST after every
 *                                            write (hand edits are overwritten)
 *   <root>/projects/<slug>/project.json    — {cwd} stamp written on first save
 *
 * The retired GLOBAL scope used to live at `<root>/topics/` and was injected
 * into every project's sessions. It is gone: {@link MemoryRoot.migrateLegacyGlobalScope}
 * moves any card still sitting there into `projects/legacy-global/` at boot, so
 * the cards survive as an ordinary, visible, deletable project instead of a
 * scope that silently rode every session.
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
 * (same basename in two parents never collides). Sessions with no cwd have no
 * scope at all — nothing is read for them and nothing can be saved from them.
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
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { removeTree } from './remove-tree.ts'
import type { MemoryCategory, MemoryLlmAuditRun, MemoryProjectSummary } from './types.ts'
import { ARCHIVE_MAX_FILES, ARCHIVE_RETENTION_DAYS, LEGACY_GLOBAL_SLUG, MEMORY_CATEGORIES } from './types.ts'
import {
  DOMAIN_KEY_PATTERN,
  MAX_SUMMARY_CHARS,
  TOPIC_KEY_PATTERN,
  cardFingerprint,
  domainOf,
  isValidDomain,
  isValidTopic,
  parseCard,
  probeCardFile as probeCardFileAt,
  probeOrThrow,
  readCardFile,
  renderCard,
  slugifyTopic,
  todayStamp,
  type CardDomain,
  type CardFileReader,
  type CardProbe,
  type CardState,
  type TopicCard,
} from './card-file.ts'
import { rotMarkerCount } from './card-rot.ts'
import {
  DEFAULT_ALIAS_GROUPS,
  mergeAliasGroups,
  parseAliasGroups,
  planAliases,
  queryTokens,
  separatedMemberPattern,
  type AliasGroup,
  type AliasPlan,
} from './recall-aliases.ts'
// The words of a query are a VOCABULARY question, so the splitter lives beside
// the alias table and is re-exported here: every existing caller imports it
// from this module, and a second copy would drift the moment one of them changes.
export { queryTokens } from './recall-aliases.ts'
// The card format and its three-state read live in card-file.ts: a move probes
// ANOTHER store's card and every delete path asks the same question, so neither
// may own its own copy. Re-exported here so the host half and the tests keep one
// import site — the arrangement LEGACY_GLOBAL_SLUG and the archive bounds use.
export {
  DOMAIN_KEY_PATTERN,
  MAX_SUMMARY_CHARS,
  TOPIC_KEY_PATTERN,
  cardFingerprint,
  domainOf,
  isValidDomain,
  isValidTopic,
  parseCard,
  renderCard,
  slugifyTopic,
  todayStamp,
} from './card-file.ts'
export type { CardDomain, CardFileReader, CardProbe, CardState, TopicCard } from './card-file.ts'
// The slug is DEFINED in types.ts so the browser half can recognise the row
// without importing host code; re-exported here because every host-side caller
// imports it from this module.
export { LEGACY_GLOBAL_SLUG }

/** One card body gets at most this many characters: room for a consolidated
 *  fact (roughly two legacy lines) without bloating every session's re-read. */
export const MAX_TOPIC_BODY_CHARS = 400

/** Similarity thresholds for the write-time gate (char-bigram Jaccard over
 *  normalized text). τ_dup hard-rejects/redirects (near-verbatim only, by
 *  design); [τ_rel, τ_dup) is reported as "related" so the MODEL arbitrates.
 *  Calibration evidence (2026-09-15 probe on realistic Chinese entries):
 *  reworded statements of the SAME fact score 0.35–0.45, so a τ_rel of 0.6
 *  would never fire — 0.3 catches the rewording band; disjoint topics about
 *  the same tool score ≤0.2 and stay below the floor. */
export const SIM_DUPLICATE = 0.8
export const SIM_RELATED = 0.3

/** How long a card may go unedited before `/status` counts it as STALE.
 *
 * NOT a gate: nothing is deleted, degraded or omitted because of this number —
 * it only feeds a count the settings payload and the health audit serve. The
 * library is younger than this bound today, so the count is 0 by construction;
 * that is the honest state, not a reason to lower it (see the plan's Q2). */
export const ROT_DAYS = 90

/** Archive bounds — declared in `types.ts` (shared with the browser half) and
 *  re-exported here so the store's callers keep one import site. */
export { ARCHIVE_MAX_FILES, ARCHIVE_RETENTION_DAYS } from './types.ts'

/** Why a card was removed — diagnostics only, never stored with the copy. */
export type ArchiveReason = 'forget' | 'curate-delete' | 'curate-merge' | 'curate-rename' | 'light-sweep-dup' | 'unspecified'

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
 * The words a query contributes to token-AND matching: the query split on
 * everything that is not a letter or a digit, lowercased, empties dropped.
 *
 * Splitting on separators (not on whitespace) is what makes a Chinese query
 * work: `memory 召回` and `memory召回` yield the same two tokens, and
 * `dsh-app-vs-stock` yields four, each matched on its own.
 */

/** Whether a token is pure ASCII letters/digits, the only shape that has a
 *  word boundary to respect. A token containing CJK has no such notion in the
 *  text (Chinese is written without spaces), so it is matched as a substring. */
const ASCII_TOKEN = /^[a-z0-9]+$/u

/**
 * Match one ASCII token on a WORD boundary.
 *
 * `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])` rather than `\b`: `\b` treats `_` as a
 * word character, so `_` would end a match that the text considers mid-word,
 * and this must line up with what an author would call a separate word. The
 * token itself contains only ASCII letters and digits ({@link queryTokens}
 * guarantees it), so it needs no regex escaping.
 */
function asciiTokenMatches(text: string, token: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${token}(?![A-Za-z0-9])`, 'iu')
  return pattern.test(text)
}

/**
 * Whether `text` mentions `query` — the ONE matcher behind `memory_recall`'s
 * keyword filter, `memory_forget`'s text sweep and the recall corpus.
 *
 * Two rules, in order, because the second is a strict widening of the first and
 * the first is a contract:
 *
 *   1. EXACT PHRASE (the historical rule): the normalized query appears in the
 *      normalized text. This is what a caller who pastes a phrase expects, and
 *      keeping it is what guarantees the switch cannot lose a hit it used to
 *      find — every card matched before is still matched.
 *   2. TOKEN AND: every token matches on its own — ASCII tokens on a word
 *      boundary, CJK tokens as a normalized substring.
 *
 * Rule 2 is what rule 1 could not do. Measured on a real 193-card store, a
 * two-word query hit 7 of 180 attempts (4%) because the words had to sit
 * adjacent in that exact order; token-AND doubles the yield on the recall
 * corpus (16/38 → 30/38). The superset is deliberate: recall is the feature
 * that must not regress, so the new rule only ever ADDS matches.
 *
 * @param mode - `full` (both rules, the default) or `phrase` (rule 1 only).
 *   The DESTRUCTIVE caller (`forget`) passes `phrase` for key-shaped input:
 *   adding matches is a gain when reading and a hazard when deleting, and the
 *   one-token-per-hyphen split would turn a mistyped topic key into a sweep.
 *   `words` is rule 2 only, and it is what alias VARIANTS are matched with: the
 *   phrase rule is a substring test, so a short alias would leak through it
 *   (`ws` inside `pwsh`, `pdf` inside `pdfjs`) — the very over-match the alias
 *   table is written to avoid. The original query keeps `full`, because its
 *   loose behaviour is a published contract (see the superset note above) while
 *   an expanded variant is new reach and owes nobody a substring match.
 */
export function textMatchesQuery(text: string, query: string, mode: 'full' | 'phrase' | 'words' = 'full'): boolean {
  const needle = normalizeForMatch(query)
  if (needle === '') return false
  const normalized = normalizeForMatch(text)
  if (mode !== 'words' && normalized.includes(needle)) return true
  if (mode === 'phrase') return false
  const tokens = queryTokens(query)
  if (tokens.length === 0) return false
  return tokens.every(token =>
    ASCII_TOKEN.test(token) ? asciiTokenMatches(text, token) : normalized.includes(normalizeForMatch(token)))
}

/**
 * Whether ONE word of a query is present in `text`.
 *
 * The strict counterpart to {@link textMatchesQuery}'s loose phrase rule, used
 * for alias alternatives and rewrites, where a substring test is wrong:
 *   - an ASCII word matches on its boundary (`ws` is not inside `pwsh`);
 *   - a member carrying a separator matches with the SAME anchored pattern the
 *     query side uses, which is what covers `hot-reload`, `hot reload` and
 *     `hotreload` without also matching `shot reload` — the normalised-substring
 *     version of this test was measured to hit exactly that;
 *   - everything else (a Chinese word) matches on the normalised text, because
 *     it has no boundary to anchor.
 */
function candidateMatchesText(text: string, candidate: string): boolean {
  if (ASCII_TOKEN.test(candidate)) return asciiTokenMatches(text, candidate)
  const anchored = separatedMemberPattern(candidate)
  if (anchored !== undefined) return anchored.test(text)
  const needle = normalizeForMatch(candidate)
  return needle !== '' && normalizeForMatch(text).includes(needle)
}

/**
 * Whether a card satisfies a whole {@link AliasPlan}: every word position has one
 * of its alternatives present, or a whole-query rewrite matches.
 *
 * This is the cartesian product's ANSWER without building the product — which is
 * what makes `powershell 工作区` find a card written `pwsh workspace`. The first
 * implementation enumerated rewritten sentences and could only change one member
 * at a time, so that card matched nothing.
 */
function matchesAliasPlan(text: string, plan: AliasPlan): boolean {
  const byPosition = plan.positions.length > 0
    && plan.positions.every(alternatives => alternatives.some(alternative => candidateMatchesText(text, alternative)))
  if (byPosition) return true
  return plan.variants.length > 1
    && plan.variants.slice(1).some(variant => textMatchesQuery(text, variant, 'words'))
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
 * Credential-looking fragments that must never be persisted.
 *
 * A name-with-separator list alone is not enough: it only catches the shapes whose
 * KEY NAME the user happened to type, and a pasted `postgres://user:pw@host` or a
 * raw `AKIA…` line carries no such name at all. The list therefore also recognises
 * the SHAPES a credential has — a known token prefix, a private-key banner, a JWT,
 * a URL with a password, a high-entropy base64 run, a bare hash-length hex string —
 * because a secret is a secret regardless of the sentence around it.
 *
 * The name rules are anchored with `(?<![A-Za-z0-9])`, not `\b`: `_` is a word
 * character, so `\b` fails between `_` and `P` and would let `DB_PASSWORD=…`,
 * `client_secret=…` and `access_token=…` — the `.env` shapes users paste most —
 * straight through. Requiring the word's own end (`token\s*[:=]`) already keeps
 * `tokenizer=bert` out, which is the only thing `\b` was ever argued for.
 *
 * Two deliberate non-catches, recorded in `.devflow/suite-review-backlog/verify-W7.md`:
 * a credential word buried inside a longer name (`mypass=hunter2`) is not matched,
 * because `(?<![A-Za-z0-9])passw` cannot start after a letter; and `\b`-free
 * sentences with no separator ("token 上限导致失败") stay out.
 *
 * Excluding 40 hex is deliberate too: a git sha is the one hex string that lands in
 * memories constantly and is not a secret. The base64 run excludes `/` for the same
 * reason — a long POSIX path is the other thing that looks like a random string.
 *
 * No `g` flag — these run through RegExp.test, where `g` would make lastIndex
 * stateful.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Name + separator. `(?<![A-Za-z0-9])` admits `_`/`-` prefixes so the
  // SCREAMING_SNAKE and snake_case spellings stay in scope.
  /(?<![A-Za-z0-9])api[_-]?key\s*[:=：]/iu,
  /(?<![A-Za-z0-9])secret\s*[:=：]/iu,
  /(?<![A-Za-z0-9])passw(or)?d\s*[:=：]/iu,
  /(?<![A-Za-z0-9])pwd\s*[:=：]/iu,
  /(?<![A-Za-z0-9])token\s*[:=：]/iu,
  /(?<![A-Za-z0-9])authorization\s*[:=：]/iu,
  /(?<![A-Za-z0-9])credential\s*[:=：]/iu,
  /\bbearer\s+[A-Za-z0-9]/iu,
  /密[码钥]\s*[是为:：=]/u,
  /口令\s*[是为:：=]/u,
  // Known token prefixes.
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/u,
  /xox[bpas]-[A-Za-z0-9-]+/u,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\bpypi-[A-Za-z0-9_-]{50,}\b/u,
  // A private-key banner, whatever the key type.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  // A JWT is three base64url segments and its first two both start with `eyJ`
  // (the base64 of `{"`), which is what makes this shape identifiable.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./u,
  // A URL that carries a password.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  // A database connection string, with or without a password: the host is
  // usually an internal address the user would not knowingly paste.
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|mssql):\/\/[^\s]+@/iu,
  // A base64 run long enough to be a key, with mixed case AND a digit — the
  // combination that separates a random secret from a word or a hash. `/` is out
  // of the character class on purpose: a long path is the other thing that looks
  // like one.
  /\b(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*\d)[A-Za-z0-9+]{32,}={0,2}\b/u,
  // Bare hex at the two lengths a generated key is written at.
  /\b[0-9a-f]{32}\b/u,
  /\b[0-9a-f]{64}\b/u,
]

/**
 * Whether `text` looks like it carries a credential (key/token/password).
 * Checked before every persist path (the tool's save, the curator's edits)
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

/** The index file's one fixed line. Exported because the drift check reads it
 *  BACK: the header is the only non-card line the host writes, so a line that is
 *  neither this nor a parseable card row means somebody (or something) edited
 *  the file, and `cappedIndex` would inject that line verbatim. */
export const INDEX_HEADER = '# Memory index (auto-generated from topics/; edits are overwritten)'

/**
 * The topic key an index line names, or undefined for a line that names none.
 *
 * The index is host-generated, so this reads back the shape `indexLine`
 * writes: `- [pin ]([category] )([domain] )<key> — <summary> (updated <date>)`.
 * Bracket segments are SKIPPED rather than counted, so the reader keeps
 * working across the domain prefix that was added later — one parser, two
 * formats, and a hand-edited line answers undefined instead of a wrong key.
 *
 * Exported because index/card reconciliation (W2) is the only thing that reads
 * the index back, and it has to be testable on its own.
 */
export function indexLineKey(line: string): string | undefined {
  if (!line.startsWith('- ')) return undefined
  let rest = line.slice(2).trim()
  if (rest.startsWith('📌 ')) rest = rest.slice(3)
  while (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) return undefined
    rest = rest.slice(close + 1).trim()
  }
  const dash = rest.indexOf(' — ')
  const key = (dash === -1 ? rest : rest.slice(0, dash)).trim()
  return isValidTopic(key) ? key : undefined
}

/** What one store looks like in numbers — `/status` per project, and the
 *  health audit's row. Every field is derived from a single `list()` (see
 *  {@link MemoryStore.metrics}). */
export interface StoreMetrics {
  cards: number
  sizeBytes: number
  pinned: number
  /** Lines in `index.md` that name a card. */
  indexLines: number
  /** Characters of `index.md` (the injected routing map's cost). */
  indexChars: number
  /** Summed card-body characters. */
  bodyChars: number
  /** Distinct domains (declared or derived). */
  domains: number
  /** Cards in the biggest single domain (the cap decision's raw number). */
  maxDomainCards: number
  /** Cards whose body names decay-prone external state (see card-rot.ts). */
  rotCards: number
  /** How many such mentions, across all cards. */
  rotMarkers: number
  /** Cards not edited for more than {@link ROT_DAYS} days (measured, never gated). */
  staleCards: number
}

/** How `index.md` and `topics/` disagree (see {@link MemoryStore.indexDrift}). */
export interface IndexDrift {
  /** Lines the index carries that name a card. */
  indexLines: number
  /** Cards on disk. */
  cards: number
  /** Named by the index, absent from disk — injected into every session. */
  ghostKeys: string[]
  /** On disk, named by no line — invisible to the write-side routing map. */
  unlistedKeys: string[]
  /** Named by MORE THAN ONE line — the duplicate rides every session too. */
  duplicatedKeys: string[]
  /** Lines the host would never write, injected verbatim by `cappedIndex`. */
  malformedLines: string[]
}

/**
 * Index line for one card: `- [category] ([domain] )name — summary (updated date)`.
 *
 * The domain prefix is emitted ONLY when it carries information the key does
 * not — a card that DECLARES a domain differing from its key's first segment.
 * An inferred domain IS that segment, so prefixing it repeats the key on every
 * line: measured on the real 193-card store, prefixing every line cost 1555
 * characters across 194 lines (8.3% of the whole index) and told a reader
 * nothing that the key plus the (domain-grouped) ordering did not already say.
 * `reindex` sorts by domain, so grouping stays visible; this is only the
 * redundant copy that goes away.
 *
 * That choice is also what keeps every existing LINE of an upgraded store
 * unchanged: nothing declares a domain yet, so no line gains or loses a
 * character. The index FILE is still rewritten on the first rebuild, because
 * `reindex` now sorts by domain — the lines are the same, their ORDER is not.
 * Injection length is unchanged; only the sequence a reader sees moves, and (as
 * measured: `droppedCards 107` of 193 cards) the bodies a session gets are
 * chosen by category quota, not by index order.
 */
function indexLine(card: TopicCard, pinned: Set<string>): string {
  const pin = pinned.has(card.name) ? '📌 ' : ''
  const summary = card.malformed ? '(hand-edited file)' : card.summary
  const declared = domainOf(card)
  const prefix = declared.src === 'declared' && declared.key !== domainOf({ name: card.name }).key
    ? `[${declared.key}] `
    : ''
  return `- ${pin}[${card.category}] ${prefix}${card.name} — ${summary} (updated ${card.updated})`
}

/** Validate an upsert payload; returns an error string or undefined. Exported
 *  so the tool and the curator share one rule set. The summary rides the
 *  index into every session's prompt, so it is credential-checked alongside
 *  the body — a secret is not safer at 40 characters. */
export function validateCardInput(input: { name: string, category: string, summary: string, body: string, domain?: string }): string | undefined {
  if (!isValidTopic(input.name)) return `invalid topic key "${input.name}"; must match ${TOPIC_KEY_PATTERN.source} (ASCII kebab-case)`
  if (!MEMORY_CATEGORIES.includes(input.category as MemoryCategory)) {
    return `unknown category "${input.category}"; must be one of: ${MEMORY_CATEGORIES.join(', ')}`
  }
  if (input.domain !== undefined && input.domain !== '' && !isValidDomain(input.domain)) {
    return `invalid domain "${input.domain}"; must match ${DOMAIN_KEY_PATTERN.source} (ASCII kebab-case, ≤16 chars)`
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
/** Move chains, keyed by `<source dir>::<topic>`.
 *
 * A move is two writes (target upsert, source remove) with an await between
 * them, so two concurrent calls for one card could both pass the existence
 * check and leave a copy in each destination. Chaining per card makes the
 * second caller observe the finished first one, which reports 'missing'.
 * The map entry is dropped once its chain drains, so it does not grow.
 */
const moveChains = new Map<string, Promise<unknown>>()

function withCardMoveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = moveChains.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  moveChains.set(key, settled)
  void settled.then(() => {
    if (moveChains.get(key) === settled) moveChains.delete(key)
  })
  return run
}

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

  /** One card by topic key (undefined for an invalid key, an absent file, or a
   *  read failure — NOT for malformed content: `parseCard` still returns a card
   *  and flags `malformed: true`).
   *
   *  Absent and unreadable are NOT the same answer, and this signature cannot
   *  tell them apart: a read failure and a missing file both come back as
   *  `undefined`.
   *  Anything that DESTROYS on the strength of this (a move compensates or
   *  deletes based on it) has to use {@link probeCardFile} instead. Kept as-is
   *  for the read-mostly callers that genuinely mean "the card I asked for". */
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

  /** How this store reads a card file: the production reader, replaced by the
   *  tests to drive the probe's 'unreadable' branch (an fs-level read failure
   *  cannot be reproduced in-process any other way). See `card-file.ts` for the
   *  classification itself — it is shared, not re-implemented here. */
  private cardFileReader: CardFileReader = readCardFile

  /** `card-file.ts`'s three-state probe over THIS store's `topics/`. {@link get}
   *  collapses `absent` and `unreadable` into `undefined`, which is fine for a
   *  page render and wrong for a decision that deletes or overwrites. */
  private probeCardFile(name: string): CardProbe {
    return probeCardFileAt(this.topicsDirPath, name, this.cardFileReader)
  }

  /** The state half of {@link probeCardFile}, for the calls that do not need
   *  the card itself. */
  private readCardState(name: string): CardState {
    return this.probeCardFile(name).state
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
  async upsert(input: { name: string, category: MemoryCategory, summary?: string, body: string, domain?: string | null }): Promise<{ op: 'created' | 'updated' | 'unchanged', card: TopicCard }> {
    // Three-state for the same reason the move probes are: `get()` folds "the
    // read failed" into `undefined`, and reading an UNREADABLE card as "new"
    // makes this write replace the very file it could not read. Only a genuinely
    // absent file means create; an unreadable one aborts before anything lands.
    const before = probeOrThrow(this.topicsDirPath, input.name, this.cardFileReader, 'the card was not saved')
    const existing = before.state === 'present' ? before.card : undefined
    const summary = input.summary !== undefined && input.summary !== '' ? input.summary : existing?.summary ?? ''
    // An OMITTED domain inherits (like the summary): a caller that only revises
    // the body must not silently drop the card's bucket. `null` means "no
    // declared domain" and is the only way to go back to the key-derived one —
    // it exists because a ROLLBACK has to restore a target that declared
    // nothing, and inheriting there would leave the failed move's domain
    // behind on a card nobody edited.
    const domain = input.domain === null
      ? undefined
      : input.domain !== undefined && input.domain !== '' ? input.domain : existing?.domain
    const invalid = validateCardInput({ name: input.name, category: input.category, summary, body: input.body, domain })
    if (invalid !== undefined) throw new Error(invalid)
    const today = todayStamp()
    // `domain` is part of the equality test: leaving it out makes a
    // domain-only change answer `unchanged` and get dropped without a trace —
    // the silent no-op the plan calls out by name.
    if (existing !== undefined && !existing.malformed
      && existing.body === input.body && existing.summary === summary && existing.category === input.category
      && existing.domain === domain) {
      return { op: 'unchanged', card: existing }
    }
    const card: TopicCard = {
      name: input.name,
      category: input.category,
      summary,
      ...(domain === undefined ? {} : { domain }),
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
   *
   *  A card that exists but cannot be READ is not deleted: it cannot be
   *  archived, so deleting it would be the one removal with no copy to undo from.
   *  That case THROWS instead of answering `false` — `false` means "there was
   *  nothing to delete", and a stat-level failure is not that. It is the same
   *  conflation the move's probe exists to remove ({@link probeCardFile}), one
   *  layer down: previously `existsSync` answered `false` for any failure, so a
   *  caller read "could not read it" as "nothing to do" and reported success on
   *  a delete that never happened.
   */
  async remove(name: string, reason: ArchiveReason = 'unspecified'): Promise<boolean> {
    if (!isValidTopic(name)) return false
    // 'absent' and 'present' are answers; 'unreadable' throws inside probeOrThrow
    // — a card that cannot be archived must not be deleted.
    const state = probeOrThrow(this.topicsDirPath, name, this.cardFileReader, 'it was not removed')
    if (state.state === 'absent') return false
    const path = join(this.topicsDirPath, `${name}.md`)
    await this.archiveCard(state.card, reason)
    await removeTree(path)
    // Drop the pin BEFORE the index rebuild: a crash may leave a card without
    // its pin (visible, harmless), never an index/pin pointing at a ghost.
    await this.removePin(name)
    await this.reindex()
    return true
  }

  /**
   * Move one card INTO another project store.
   *
   * A relocation, not a copy: the target gets the same topic, category, summary
   * and body, and the source no longer holds the card. The user's PIN follows it
   * — a pin is the "always inject this" intent, and a move that silently dropped
   * it would change what the next session sees.
   *
   * The source deletion runs through {@link remove}, so the card also lands in
   * the SOURCE project's archive (byte-identical, undoable there). That is
   * deliberate: a move is the one operation that makes a card disappear from a
   * project the user is looking at, and the archive is the undo for it (restore
   * puts it back).
   *
   * Never overwrites silently: an existing target topic answers 'occupied' and
   * the caller has to ask the user (then pass `overwrite`).
   *
   * @param target - the destination project store.
   * @param name - the topic key to move (the key is kept; a rename is not a move).
   * @param overwrite - replace an existing target card with the same topic.
   * @returns what happened; 'same-store' is a caller bug, refused rather than
   *   executed as a pointless delete-and-recreate.
   */
  async moveCardTo(
    target: MemoryStore,
    name: string,
    overwrite = false,
  ): Promise<'moved' | 'missing' | 'occupied' | 'same-store' | 'partial'> {
    // Serialized per (source store, topic): two concurrent moves of one card
    // used to both report success and leave a copy in each target. The second
    // caller now waits, then observes the card is gone.
    return withCardMoveLock(`${this.dir}::${name}`, () => this.moveCardToLocked(target, name, overwrite))
  }

  private async moveCardToLocked(
    target: MemoryStore,
    name: string,
    overwrite: boolean,
  ): Promise<'moved' | 'missing' | 'occupied' | 'same-store' | 'partial'> {
    // The ENTRY probe, in three states for the same reason the destination
    // probe below is: `get()` answers `undefined` for both "no such card" and
    // "the read failed", so an unreadable source used to fall through to
    // `return 'missing'` → 400 `route.topicUnknown`, telling the user the card
    // does not exist while it is sitting right there. Absent stays 'missing';
    // unreadable throws (500 `moveFailed` + detail — the shape every other
    // destructive path already reports). 'partial' would be wrong here: nothing
    // has been written yet, so there is no half-done move to describe.
    const source = probeOrThrow(this.topicsDirPath, name, this.cardFileReader, 'nothing was moved')
    if (source.state === 'absent') return 'missing'
    const card = source.card
    if (target.dir === this.dir) return 'same-store'
    // Probe the destination BEFORE any write, and in three states. `get()`
    // answers `undefined` both for "no such card" and for "the read failed",
    // and the difference decides two destructive things: whether an existing
    // card is overwritten, and what the compensation puts back. A failed read
    // is not an empty destination, so it aborts here — before anything is
    // written — and surfaces as a failed move with a reason instead of a
    // silent overwrite of, or a new copy beside, a card nobody could read.
    const before = probeOrThrow(target.topicsDirPath, name, target.cardFileReader, 'nothing was moved', 'destination card')
    if (before.state === 'present' && !overwrite) return 'occupied'
    const pinned = this.pinnedSet().has(name)
    // Snapshot the destination's injection state BEFORE touching it. A failed
    // move has to give the target back exactly what it had — text AND pin —
    // otherwise an operation that reported failure silently changes what every
    // later session injects from that project.
    const replacedPinned = target.pinnedSet().has(name)

    try {
      // Inside the try on purpose: upsert writes the card BEFORE it rebuilds the
      // index, so a throw after that write is precisely the case that needs
      // undoing. Leaving it outside is what made a reindex failure lose the
      // overwritten target card.
      // `domain` rides along: a declared domain is part of the card's identity,
      // and a move that dropped it would silently re-bucket the card under its
      // key's first segment — the same silent change the pin handling exists to
      // prevent, one field over. `null` when the source declares none, so an
      // `overwrite` onto a target that DID declare one lands the moved card's
      // state instead of inheriting the target's.
      await target.upsert({
        name: card.name,
        category: card.category,
        summary: card.summary,
        body: card.body,
        domain: card.domain ?? null,
      })
      if (pinned) await target.addPin(name)
      await this.remove(name, 'unspecified')
    } catch (error) {
      // Did the source card actually leave? remove() deletes the card file
      // before it rebuilds the index and drops the pin, so a throw can happen
      // AFTER the only live copy is gone. Compensating then would erase the
      // card from BOTH projects and leave nothing but two archives. Asked in
      // three states: `this.get(name) === undefined` could not tell the two.
      const sourceState = this.readCardState(name)
      if (sourceState === 'unreadable') {
        // Neither answer is available: the move may or may not have completed,
        // and compensating a completed move deletes the last copy while
        // claiming 'moved' would be a guess. Hand it back for a human look.
        return 'partial'
      }
      if (sourceState === 'absent') {
        // The file is gone, so the move landed — but only say so once the
        // destination has been READ back and provably carries this body. A
        // destination that cannot be read is not one we may call 'moved'.
        const landing = target.probeCardFile(name)
        if (landing.state === 'present' && landing.card.body === card.body) {
          await this.reindexQuietly()
          await target.reindexQuietly()
          return 'moved'
        }
        return 'partial'
      }
      try {
        // The snapshot taken before the write decides the undo: a destination
        // that was ABSENT is deleted again, one that was PRESENT gets its own
        // text back. `replaced !== undefined` was a second guess at what the
        // probe had already answered.
        if (before.state === 'absent') {
          await target.remove(name)
        } else {
          const replaced = before.card
          await target.upsert({
            name: replaced.name,
            category: replaced.category,
            summary: replaced.summary,
            body: replaced.body,
            // The snapshot's domain goes back too, and `null` is load-bearing:
            // the target declared nothing, so omitting the field would INHERIT
            // the domain the failed move just wrote and leave the rollback
            // looking like a success with a bucket nobody chose.
            domain: replaced.domain ?? null,
          })
          // Put the pin back too: an unpinned destination card that stays
          // pinned would keep injecting a card the user never pinned there.
          if (target.pinnedSet().has(name) !== replacedPinned) {
            if (replacedPinned) await target.addPin(name)
            else await target.removePin(name)
          }
        }
      } catch {
        // Compensation itself failed: the stores disagree and we cannot say
        // which copy is authoritative. 'partial' means "verify by hand", not
        // "both stores hold the card".
        return 'partial'
      }
      throw error
    }
    return 'moved'
  }

  /** Rebuild the index, but never turn a completed move into a failure: the
   *  card is already where the caller asked, and a stale `index.md` is only
   *  repaired by the next successful write to that store (or its next light
   *  sweep) — NOT at boot. `migrateAll` skips every store without a legacy
   *  `memory.md`, so a project that never migrates keeps the stale index until
   *  something writes again. Accepted: the index is derived data and the cards
   *  it summarizes are intact; rebuilding it at boot would cost a full read of
   *  every store on every start. */
  private async reindexQuietly(): Promise<void> {
    try {
      await this.reindex()
    } catch {
      // deliberately swallowed: bookkeeping, not payload
    }
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
      // Cleared on a LANDING write: the flag is what `/archive` reports, and a stale
      // one would keep warning about an undo the user has again by now.
      this.lastArchiveFailure = undefined
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
   * Put one archived card back into `topics/` and CONSUME the archived copy.
   *
   * `file` is the archive file's stem from {@link archivedCards} (which may
   * carry a same-day suffix); `topic` is the key it restores to. Refuses when
   * the key is taken (restoring would overwrite a live card) or when the copy is
   * not a valid card file.
   *
   * The move is what makes the panel tell the truth: "已删除的记忆（N）" lists
   * this directory, so a restore that left the copy behind kept showing the card
   * as deleted, kept counting it, and answered the second click with "the key is
   * taken" — the panel contradicting itself in three ways at once. Reverting the
   * restore is not lost: deleting the card again archives a fresh copy.
   *
   * @returns the outcome for the caller to report.
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
    // Only after the card is safely live: a failure here leaves a copy the user
    // can still restore (the file is re-read on the next click).
    await this.deleteArchived(day, file)
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
   *  match — the cheap pre-dedupe before similarity runs). */
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

  /**
   * Cards matching a query, EXACT HITS FIRST.
   *
   * Two layers, in this order:
   *   1. `textMatchesQuery` — phrase or token-AND (see that function);
   *   2. alias expansion — the query's words swapped for their other names (see
   *      recall-aliases.ts), which is the only layer that can find a card whose
   *      author used a different word for the same thing.
   *
   * The ordering is part of the contract, not a nicety: expansion can only ADD
   * cards, so a direct hit must never sit behind an indirect one — searching
   * `ppt` should open with the card that says `ppt`, not with four cards that
   * say `幻灯片`.
   *
   * @param query - the user's words.
   * @param groups - the alias table in force. `[]` (the default) means NO
   *   synonym expansion: a caller opts in explicitly, so a future reader or
   *   destructive caller cannot inherit it by accident. {@link forget} does not
   *   call this method at all.
   */
  search(query: string, groups: readonly AliasGroup[] = []): TopicCard[] {
    if (normalizeForMatch(query) === '') return this.list()
    // An EMPTY table is the default, so a caller opts into synonyms explicitly.
    // The read path is the only one that may pass a table, and making that
    // visible at every call site is what keeps a future destructive caller from
    // inheriting widened semantics by accident.
    const plan = groups.length === 0 ? undefined : planAliases(query, groups)
    const exact: TopicCard[] = []
    const viaAlias: TopicCard[] = []
    for (const card of this.list()) {
      const text = `${card.name} ${card.summary} ${card.body}`
      if (textMatchesQuery(text, query)) {
        exact.push(card)
      } else if (plan !== undefined && matchesAliasPlan(text, plan)) {
        viaAlias.push(card)
      }
    }
    return viaAlias.length === 0 ? exact : [...exact, ...viaAlias]
  }

  /**
   * Remove cards by topic key (exact) or by text (see {@link textMatchesQuery});
   * returns the removed keys. Rebuilds the index once at the end.
   *
   *  Like {@link remove}, a card that cannot be READ is never treated as a card
   *  that is not there: it cannot be archived, so deleting it would be
   *  irreversible, and a text sweep cannot even tell whether it matches. Both
   *  cases THROW with nothing deleted instead of reporting a confident
   *  `removed: []`.
   */
  async forget(match: string): Promise<{ removed: string[], remaining: number }> {
    // A key-shaped match is answered by the probe, not by get(): `get()` folds
    // "unreadable" into `undefined`, and the fall-through then matched by TEXT —
    // deleting whatever happened to mention that string while the card the
    // caller named survived untouched.
    const named = probeOrThrow(this.topicsDirPath, match, this.cardFileReader, 'nothing was forgotten')
    let doomed: TopicCard[] = []
    if (named.state === 'present') {
      doomed = [named.card]
    } else {
      // The sweep runs with the PHRASE half of the matcher when the text is
      // key-shaped, and the full matcher otherwise.
      //
      // Two deliberate narrowings on the destructive path, both because adding
      // matches is a gain when reading and a hazard when deleting.
      //
      // 1. ALIASES ARE NOT EXPANDED. This does not call {@link search} at all —
      //    it calls the matcher directly — so a user file or a built-in group
      //    cannot widen it. `memory_forget("幻灯片")` must not delete the `pptd`
      //    cards: the user named a word, not the set of cards that word might
      //    refer to.
      //
      // 2. KEY-SHAPED TEXT KEEPS THE EXACT-PHRASE RULE. A hyphen is what turns
      //    one written word into two tokens: `memory_forget("pnpm")` (a word)
      //    and `memory_forget("dsh-config")` (a topic key that may not exist)
      //    parse identically to the tokenizer, but the second is a TYPO far more
      //    often than it is a phrase — and under full token-AND it would delete
      //    every card mentioning both `dsh` and `config`. A phrase that is not
      //    key-shaped (spaces, Chinese) gets the full matcher, which is the case
      //    the widening was for.
      if (normalizeForMatch(match) !== '') {
        const mode = isValidTopic(match) ? 'phrase' : 'full'
        const cards = this.list()
        // `list()` drops a card whose read failed. Such a card can neither be
        // archived nor searched, so this sweep cannot know whether it matches:
        // refuse the whole call rather than delete a subset and call it done.
        const unreadable = this.unreadableKeys(cards)
        if (unreadable.length > 0) {
          throw new Error(`cannot read ${String(unreadable.length)} card(s) in ${this.dir} (${unreadable.join(', ')}); nothing was forgotten`)
        }
        doomed = cards.filter(card => textMatchesQuery(`${card.summary} ${card.body}`, match, mode))
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

  /** Topic keys whose `topics/<key>.md` entry exists but was not readable: exactly
   *  the keys {@link list} had to drop. Nothing but a failed read can put a key
   *  here — the name and the extension are filtered the same way `list` does.
   *  A `.md` DIRECTORY counts too: that is the shape of a card file nobody can
   *  read (`EISDIR`), not a card that is absent.
   *
   *  This is the probe's `unreadable` state seen through the reader the sweep
   *  actually uses (`list()`'s read — the same `readFileSync` the default
   *  {@link CardFileReader} is), so the set that was searched and the set that
   *  was checked come from one read, not two. */
  private unreadableKeys(listed: TopicCard[]): string[] {
    if (!existsSync(this.topicsDirPath)) return []
    const readable = new Set(listed.map(card => card.name))
    return readdirSync(this.topicsDirPath, { withFileTypes: true })
      .filter(entry => entry.name.endsWith('.md'))
      .map(entry => entry.name.slice(0, -3))
      .filter(key => isValidTopic(key) && !readable.has(key))
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

  /**
   * Rebuild index.md from the live cards (host-owned; hand edits overwritten).
   *
   * Ordered by DOMAIN first, then by category → updated-desc inside it: `list()`
   * keeps its own (category → updated) order for injection and for the
   * curator's rotation, while the index groups so that cards of one subject sit
   * next to each other. Adjacency is the point — a reader (or the model routing
   * a save) has to be able to see the whole bucket in one glance, and it is what
   * makes a growing domain visible before it becomes a cap problem.
   */
  async reindex(): Promise<void> {
    const cards = this.list()
    const pinned = this.pinnedSet()
    if (cards.length === 0) {
      if (existsSync(this.indexPath)) await removeTree(this.indexPath)
      return
    }
    const ordered = [...cards].sort((a, b) =>
      domainOf(a).key.localeCompare(domainOf(b).key)
      || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
      || b.updated.localeCompare(a.updated)
      || a.name.localeCompare(b.name))
    const text = [
      INDEX_HEADER,
      '',
      ...ordered.map(card => indexLine(card, pinned)),
      '',
    ].join('\n')
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.indexPath, text)
  }

  /** Current index text ('' when no cards). */
  indexText(): string {
    return existsSync(this.indexPath) ? readFileSync(this.indexPath, 'utf8').trim() : ''
  }

  /**
   * The index text for a MEASUREMENT, i.e. never throwing.
   *
   * `indexText()` is deliberately strict — injection must not quietly pretend an
   * index is empty. But two callers only COUNT with it (`metrics`, and the drift
   * probe above), and for them a damaged `index.md` (a directory, an EACCES, a
   * torn mount) must not take down `/status`, the health audit or the plugin
   * mount. `undefined` is "could not read it", which the callers report as
   * zero lines rather than as "no index": the distinction reaches the reader
   * through `indexDrift()`, which refuses to reconcile a store whose index it
   * could not read.
   */
  private indexTextForCount(): string | undefined {
    try {
      return this.indexText()
    } catch {
      return undefined
    }
  }

  /**
   * Does `index.md` still describe the cards on disk?
   *
   * The index is DERIVED data that rides into every session, so a stale copy is
   * not cosmetic: a ghost key is injected into every prompt of that project for
   * a card nobody can open (measured on a real store: 29 index lines beside 28
   * cards, one of them a topic that had vanished outside the plugin), and a
   * missing line hides a card from the only routing map the writer gets.
   *
   * Nothing used to check. "The index is rebuilt after every write" was a
   * convention, and a card lost any other way (a hand edit, an `rm`, a synced
   * folder, another machine) left the index lying indefinitely — `migrateAll`
   * only visits stores that still hold a legacy `memory.md`.
   *
   * Cheap enough to run at mount: two directory reads and one file read per
   * store, regardless of how many cards it holds.
   *
   * `undefined` means "in sync". Answers named so the caller can log or record
   * WHICH way it drifted, instead of "there was a problem".
   *
   * A scope holding a card it cannot READ answers `undefined` as well: `list()`
   * drops such a card, so it would look like a ghost, and reindexing would
   * erase its line — turning a read failure into a permanently invisible card.
   * The probe decides, not a guess.
   */
  indexDrift(): IndexDrift | undefined {
    // Card NAMES come from the directory, not from `list()`: the comparison is
    // about which keys exist, and parsing every card body to answer it would
    // make the mount-time check read every store in full — the cost that kept
    // index reconciliation out of the boot path before this existed (see §4.11
    // of docs/memory-topic-cards/OPTIMIZATION.md). Two readdirs and one file
    // read per store is what actually runs here.
    //
    // Nothing here may throw: the caller is the mount path and `/status`, and
    // an unreadable `index.md` must not fail either. A failure answers
    // `undefined` = "in step", i.e. "do not touch it"; `reindex` would
    // otherwise overwrite a file nobody could read.
    let names: Set<string>
    let listed: string[]
    let malformedLines: string[]
    try {
      names = new Set(this.diskCardKeys())
      listed = []
      malformedLines = []
      for (const line of this.indexText().split('\n')) {
        if (line.trim() === '') continue
        if (line === INDEX_HEADER) continue
        const key = indexLineKey(line)
        // A line the host did not write is drift, not noise: `cappedIndex()`
        // injects the index VERBATIM, so an unparseable row rides every session
        // of that project until somebody rebuilds the file.
        if (key === undefined) malformedLines.push(line)
        else listed.push(key)
      }
    } catch {
      return undefined
    }
    // MULTISET comparison, not set membership: an index that names one card
    // twice injects the duplicate into every session of that project for as
    // long as it stands, and a set comparison would call that "in step".
    const counts = new Map<string, number>()
    for (const key of listed) counts.set(key, (counts.get(key) ?? 0) + 1)
    const ghostKeys = [...counts.keys()].filter(key => !names.has(key))
    const duplicatedKeys = [...counts.entries()].filter(([key, count]) => names.has(key) && count > 1).map(([key]) => key)
    const unlistedKeys = [...names].filter(name => !counts.has(name))
    if (ghostKeys.length === 0 && unlistedKeys.length === 0 && duplicatedKeys.length === 0 && malformedLines.length === 0) return undefined
    // A drift WAS found, so pay for the read now: a scope holding a card it
    // cannot read must not be reconciled, because `reindex` rebuilds from
    // `list()` — which drops such a card, erasing its line for good. Only the
    // drifted stores (measured: 1 of 21) ever reach this.
    try {
      if (this.unreadableKeys(this.list()).length > 0) return undefined
    } catch {
      return undefined
    }
    return { indexLines: listed.length, cards: names.size, ghostKeys, unlistedKeys, duplicatedKeys, malformedLines }
  }

  /** The topic keys present in `topics/`, from the directory entries alone.
   *  A `.md` DIRECTORY counts: that is the shape of a card nobody can read
   *  (`EISDIR`), not of a card that is absent — the same rule {@link unreadableKeys}
   *  applies, so the two agree on what "a card is here" means. */
  private diskCardKeys(): string[] {
    if (!existsSync(this.topicsDirPath)) return []
    let entries: Array<{ name: string }>
    try {
      entries = readdirSync(this.topicsDirPath, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .map(entry => entry.name)
      .filter(name => name.endsWith('.md'))
      .map(name => name.slice(0, -3))
      .filter(key => isValidTopic(key))
  }

  /**
   * Structural metrics from ONE read of the cards — what `/status` serves per
   * project and what the health audit prints per store.
   *
   * One read, not six: `list()` parses every card file, so a metric set that
   * called it again per number (domains, rot, staleness) would multiply the
   * directory walk for a page that is opened on demand.
   */
  metrics(cards: readonly TopicCard[] = this.list()): StoreMetrics {
    const bodies = cards.map(card => card.body)
    const pinned = this.pinnedSet()
    const indexText = this.indexTextForCount() ?? ''
    const domains = new Map<string, number>()
    let rotCards = 0
    let rotMarkers = 0
    let staleCards = 0
    const cutoff = Date.now() - ROT_DAYS * 24 * 60 * 60 * 1000
    for (const card of cards) {
      const domain = domainOf(card).key
      domains.set(domain, (domains.get(domain) ?? 0) + 1)
      const markers = rotMarkerCount(card.body)
      if (markers > 0) {
        rotCards += 1
        rotMarkers += markers
      }
      // `updated` is a local-date stamp; a card that cannot be dated counts as
      // FRESH (never as stale) — a missing date must not raise an alarm.
      const stamp = Date.parse(`${card.updated}T00:00:00`)
      if (Number.isFinite(stamp) && stamp < cutoff) staleCards += 1
    }
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
    const indexLines = indexText.split('\n').filter(line => line.startsWith('- ')).length
    return {
      cards: cards.length,
      sizeBytes,
      pinned: pinned.size,
      indexLines,
      indexChars: indexText.length,
      bodyChars: bodies.reduce((sum, body) => sum + body.length, 0),
      domains: domains.size,
      maxDomainCards: Math.max(0, ...domains.values()),
      rotCards,
      rotMarkers,
      staleCards,
    }
  }

  /** Content fingerprint over all cards (curator change detection). */
  fingerprint(): string {
    return cardsFingerprint(this.list())
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
      } else if (isValidTopic(pin)) {
        // Three states, again: `get()` answers `undefined` both for "no such
        // card" and for "the read failed", and the next statement WRITES the pin
        // set. Only a confirmed absence may drop a pin. An unreadable card keeps
        // its pin: it costs nothing while the card is missing, and the pin applies
        // again the moment the file can be read.
        if (this.readCardState(pin) === 'absent') pinsDropped.push(pin)
        else newPins.add(pin)
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

  /** Background-maintenance sub-toggle (the curator's gate); defaults ON —
   *  the whole point is that it needs no user attention. The config FIELD
   *  keeps the name of the pass it used to gate, so an existing user setting
   *  survives. */
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

/**
 * Content fingerprint over a set of cards — what {@link MemoryStore.fingerprint}
 * and the health audit's snapshot line both anchor on.
 *
 * CONTENT, through `renderCard`, not counts: a snapshot that hashed card counts
 * and sizes would answer "unchanged" for a store whose card was rewritten to
 * the same length, which is exactly the edit a before/after comparison is
 * trying to notice.
 */
export function cardsFingerprint(cards: readonly TopicCard[]): string {
  return contentHash(cards.map(card => renderCard(card)).join('\n'))
}

/** Slug shape the clear route accepts — also the traversal fence. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Project directory that receives the retired global scope's cards (see
 * {@link MemoryRoot.migrateLegacyGlobalScope}). Also the placeholder `cwd`
 * stamped into its `project.json`: the settings page shows the basename, and
 * no session's real cwd ever equals this, so its cards are never injected —
 * they are listable, deletable and (since P0-1) movable, see
 * {@link MemoryStore.moveCardTo}.
 *
 * Defined in `types.ts` and re-exported above because the settings page has to
 * recognise this row too.
 */

/** Whether a slug is well-formed (used to fence the clear route). */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/** Card count at which a store is IN THE WARNING BAND: 80% of the curator's
 *  30-card target. Not a gate — nothing is trimmed or refused — the count rides
 *  in `/status` so the crossing is visible before the cap is hit. The pairing
 *  with `CURATE_BUDGET.cards` is asserted by a test rather than by an import:
 *  `curator.ts` imports this module, so reaching back would make a cycle. */
export const CARD_WARN_AT = 24

/** The curator's card target, restated here for the same reason as
 *  {@link CARD_WARN_AT} (no import cycle) and bound to it by a test. A store
 *  ABOVE this is over budget; the count reaches `/status`, nothing enforces it. */
export const CARD_CAP = 30

/** Cards per domain above which the light sweep RECORDS the bucket as over.
 *
 * Measurement only — nothing is trimmed, refused or split because of this
 * number (the plan's Q1: the real distribution is not known until declared
 * domains exist). It is set where a bucket stops being a bucket: the injected
 * index shows 50 lines, so a single domain claiming more than a sixth of it is
 * the shape that makes an index unreadable.
 */
export const DOMAIN_CAP = 8

/** Index lines at which a store is in the warning band: 80% of
 *  `MAX_INDEX_LINES` (50). Same rule as {@link CARD_WARN_AT} — measured, not
 *  enforced, and bound to the real cap by a test. */
export const INDEX_WARN_AT = 40

/** One project's summary for the settings page (store view of the wire shape). */
export type ProjectSummary = Pick<MemoryProjectSummary,
  | 'slug' | 'cwd' | 'cards' | 'sizeBytes' | 'movable'
  | 'indexLines' | 'domains' | 'maxDomainCards' | 'rotCards' | 'staleCards'
  | 'cardWarn' | 'indexWarn'>
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
    const metrics = new MemoryStore(dir).metrics()
    // A target is only usable when its stamp walks back to this very slug; a
    // bare directory or a stale stamp would swallow cards into a store no
    // session can resolve.
    const movable = cwd !== '' && projectSlug(cwd) === entry.name
    out.push({
      slug: entry.name,
      cwd,
      cards: metrics.cards,
      sizeBytes: metrics.sizeBytes,
      movable,
      indexLines: metrics.indexLines,
      domains: metrics.domains,
      maxDomainCards: metrics.maxDomainCards,
      rotCards: metrics.rotCards,
      staleCards: metrics.staleCards,
      cardWarn: metrics.cards >= CARD_WARN_AT,
      indexWarn: metrics.indexLines >= INDEX_WARN_AT,
    })
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

/** How many similarity-suspect pairs distill-state.json retains (FIFO). The
 *  write-time gate's tuning data: every ≥τ_dup pair the light sweep notices. */
const MAX_SUSPECTS = 50

/** Short display id: the uuid segment's first 8 chars (`session-` prefix
 * dropped), e.g. `session-49ce2455-...` → `49ce2455`. */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/u, '').slice(0, 8)
}

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
 * `recordLlmAudit` counts calls and tokens; this records the OBJECTS, which is
 * what answers "why is that card gone?" — pair it with the archive
 * (`archivedCards`) to also answer "and can I get it back?".
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
  /** Which domain the edit happened in (curate only, and only once the card's
   *  domain is known). Attribution: "three merges in `dsh`" is actionable,
   *  "three merges" is not. Absent on rows written before the field existed. */
  domain?: string
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
  if (entry.domain !== undefined && typeof entry.domain !== 'string') return false
  return true
}

/** Persisted shape of llm-audit.json. */
interface LlmAuditState {
  version: 1
  runs: LlmAuditRun[]
}

/** How many index/card reconciliation events distill-state.json retains (FIFO).
 *  These explain a silently rewritten `index.md`: the file is host-owned, so a
 *  hand edit is expected to be overwritten — but WHICH store drifted and by how
 *  much used to leave no trace at all. */
export const MAX_INDEX_DRIFT_EVENTS = 20

/** One reconciliation event (see {@link MemoryRoot.reconcileIndexes}). */
export interface IndexDriftEvent {
  at: number
  /** 'global' or a project slug. */
  scope: string
  indexLines: number
  cards: number
  ghostKeys: string[]
  unlistedKeys: string[]
  /** Named by more than one line. Absent in events written before this field
   *  existed; the reader answers `[]`. */
  duplicatedKeys: string[]
  /** Lines the host would never write (injected verbatim until rebuilt).
   *  Absent in older events; the reader answers `[]`. */
  malformedLines: string[]
  /** Whether the index was rebuilt in that same pass. */
  repaired: boolean
}

/** Whether a parsed value is a usable drift event (the file can be hand-edited). */
function isIndexDriftEvent(value: unknown): value is IndexDriftEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return false
  if (typeof event.scope !== 'string') return false
  if (typeof event.indexLines !== 'number' || typeof event.cards !== 'number') return false
  if (!Array.isArray(event.ghostKeys) || !event.ghostKeys.every(key => typeof key === 'string')) return false
  if (!Array.isArray(event.unlistedKeys) || !event.unlistedKeys.every(key => typeof key === 'string')) return false
  if (event.duplicatedKeys !== undefined
    && (!Array.isArray(event.duplicatedKeys) || !event.duplicatedKeys.every(key => typeof key === 'string'))) return false
  if (event.malformedLines !== undefined
    && (!Array.isArray(event.malformedLines) || !event.malformedLines.every(line => typeof line === 'string'))) return false
  return typeof event.repaired === 'boolean'
}

/** How many domain-over-cap events distill-state.json retains (FIFO). */
export const MAX_DOMAIN_OVER_EVENTS = 50

/** One measurement of a domain whose card count crossed {@link DOMAIN_CAP}. */
export interface DomainOverEvent {
  at: number
  /** 'global' or a project slug. */
  scope: string
  /** The domain key the cards were grouped by. */
  domain: string
  /** How many cards it held when measured. */
  cards: number
  /** The cap in force at that moment (so an old row stays interpretable after
   *  the constant is retuned). */
  cap: number
}

/** Whether a parsed value is a usable domain-over row. */
function isDomainOverEvent(value: unknown): value is DomainOverEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return false
  if (typeof event.scope !== 'string' || typeof event.domain !== 'string') return false
  if (typeof event.cards !== 'number' || typeof event.cap !== 'number') return false
  return true
}

/**
 * Persisted shape of distill-state.json. Keys an older file still carries —
 * `sessions` and `activity`, the retired extractor's per-session progress and
 * run traces — are simply not read: parsing ignores them and the next write
 * drops them. The FILE NAME itself stays (a rename would drop the live
 * bookkeeping below it).
 */
interface DistillState {
  version: 1
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
  /**
   * Recent index/card reconciliations (bounded FIFO). Absent in a file written
   * before this existed; the reader answers `[]` and the next write adds it.
   */
  indexDrift?: IndexDriftEvent[]
  /**
   * Recent domain-over-cap measurements (bounded FIFO). Absent in an older
   * file, read as `[]` — an old state file must never make the store throw.
   */
  domainOver?: DomainOverEvent[]
}

/**
 * The memory root: the per-workspace project stores, plus the root-level
 * store that now only carries the shared state files (`config.json`,
 * `distill-state.json`, `llm-audit.json`).
 *
 * `global` keeps its name because the root directory IS the old global
 * store's directory — moving `config.json` would drop the user's toggles and
 * pins. It is no longer a memory SCOPE: its cards are relocated into
 * `projects/legacy-global/` at boot, it is never injected, and no write path
 * targets it.
 */
export class MemoryRoot {
  readonly dir: string
  /** The root-level store: shared state files (see the class doc). */
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

  /**
   * Project store for a workspace cwd (cheap: no I/O until a write).
   */
  projectFor(cwd: string): MemoryStore {
    const store = new MemoryStore(join(this.dir, 'projects', projectSlug(cwd)), cwd)
    store.attachLedger(this, projectSlug(cwd))
    return store
  }

  /**
   * The alias table in force: the built-in groups, then whatever
   * `<root>/aliases.json` adds.
   *
   * Read on every call rather than cached at construction: the file is
   * hand-editable by design, and "edit the file, run recall again" has to work
   * without a restart. The cost is one small read per `memory_recall` with a
   * query — not per prompt assembly, which is what every other read on this path
   * is careful about.
   *
   * A broken or unreadable file answers the built-in table, never an error: an
   * alias file with a stray comma must not take recall down. The built-in groups
   * come FIRST, so a member a user re-declares keeps its shipped meaning. */
  aliasGroups(): AliasGroup[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, 'aliases.json'), 'utf8'))
    } catch {
      return mergeAliasGroups(DEFAULT_ALIAS_GROUPS)
    }
    const { groups } = parseAliasGroups(parsed)
    return mergeAliasGroups(DEFAULT_ALIAS_GROUPS, groups)
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
      // The stamp is reusable only when it round-trips to THIS directory:
      // projectFor() derives the path from the slug, so a stamp that does not
      // reproduce `slug` points at a directory that is not this one. The
      // legacy-global store records a display placeholder and is exactly that
      // case — following it would list (and curate) an empty directory beside
      // the real one.
      if (typeof cwd === 'string' && cwd !== '' && projectSlug(cwd) === slug) return this.projectFor(cwd)
    } catch {
      // missing/stale metadata → operate on the directory as-is
    }
    const store = new MemoryStore(dir)
    store.attachLedger(this, slug)
    return store
  }

  /**
   * Destination store for a card move.
   *
   * Deliberately stricter than {@link projectBySlug}: the bare fallback is what
   * makes the legacy holding pen readable, but using it as a MOVE TARGET would
   * rebuild the very dead end the move exists to drain — cards parked in a
   * directory no cwd can resolve. A destination therefore needs a usable stamp
   * that round-trips to its own slug, and never the holding pen itself.
   */
  moveTargetBySlug(slug: string): MemoryStore | undefined {
    if (!isValidSlug(slug) || slug === LEGACY_GLOBAL_SLUG) return undefined
    const dir = join(this.dir, 'projects', slug)
    if (!existsSync(dir)) return undefined
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
      const cwd = (meta as { cwd?: unknown }).cwd
      if (typeof cwd !== 'string' || cwd === '') return undefined
      if (projectSlug(cwd) !== slug) return undefined
      return this.projectFor(cwd)
    } catch {
      return undefined
    }
  }

  /**
   * Boot migration. Two passes, in this order:
   *   1. every store whose legacy `memory.md` timeline is still present is
   *      converted to topic cards ({@link MemoryStore.migrateLegacy});
   *   2. the retired root-level scope is relocated
   *      ({@link migrateLegacyGlobalScope}).
   *
   * The order is load-bearing: the root timeline converts into cards under
   * `<root>/topics/`, and step 2 is what carries them — along with everything
   * already there — into a real project directory. Running it the other way
   * round would leave the freshly migrated cards orphaned in a scope nothing
   * reads or injects.
   *
   * Neither pass can block the mount: a failure logs and leaves the input
   * where it is for the next boot.
   */
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
    await this.migrateLegacyGlobalScope(log)
  }

  /**
   * Retire the root-level GLOBAL scope: move every card of `<root>/topics/`
   * into `<root>/projects/legacy-global/topics/` and stamp that directory's
   * `project.json` with the display placeholder {@link LEGACY_GLOBAL_SLUG}.
   *
   * Why: the global scope injected its cards into EVERY project's sessions,
   * so a conclusion reached inside one workspace came back in all of them.
   * Nothing may be lost by removing it, and nothing may silently vanish
   * either — the cards land in an ordinary project directory, which the
   * settings page lists and the user can open and delete like any other.
   *
   * Idempotent, and a no-op unless `<root>/topics/` still holds `.md` files:
   * the sources are MOVED (never copied), so a second run finds nothing, and
   * a re-run after a partial failure skips destinations that already exist.
   * Never throws: a failure logs one line and leaves the cards where they
   * are, which costs a retry on the next boot and nothing else.
   *
   * `<root>/config.json` stays put — it holds the user's toggles and pins.
   * The pins of the moved cards are carried onto their new store, since a pin
   * keyed by topic is the user's "always inject this" intent.
   *
   * @param log - host logger (optional; the migration is also runnable from a probe).
   * @returns how many cards were moved.
   */
  async migrateLegacyGlobalScope(log?: { info(msg: string): void }): Promise<number> {
    const archived = await this.moveRetiredGlobalArchive(log)
    const source = this.global.storePath
    if (!existsSync(source)) return 0
    let entries: string[]
    try {
      entries = readdirSync(source, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => entry.name)
    } catch (error) {
      log?.info(`memory migration: could not read the retired global scope ${source} (left in place): ${String(error)}`)
      return 0
    }
    if (entries.length === 0) {
      if (archived > 0) log?.info(`memory migration: moved ${String(archived)} archived cop(y|ies) of the retired global scope, no live cards were left there`)
      return 0
    }

    const targetDir = join(this.dir, 'projects', LEGACY_GLOBAL_SLUG)
    const targetTopics = join(targetDir, 'topics')
    const pinned = this.global.pinnedSet()
    const moved: string[] = []
    const failed: string[] = []
    for (const name of entries) {
      const from = join(source, name)
      const to = join(targetTopics, name)
      // A destination that already holds this topic is a previous run's
      // result (or a genuine project card): the destination wins, the source
      // copy is left for a human rather than overwritten.
      if (existsSync(to)) continue
      try {
        // Created lazily and per file: a run that moves nothing must not leave
        // an empty project directory behind for the settings page to list.
        mkdirSync(targetTopics, { recursive: true })
        renameSync(from, to)
        moved.push(name.slice(0, -3))
      } catch (error) {
        failed.push(`${name} (${String(error)})`)
      }
    }
    if (moved.length === 0) {
      if (failed.length > 0) {
        log?.info(`memory migration: could not move ${String(failed.length)} retired global card(s), left in place: ${failed.join(', ')}`)
      }
      return 0
    }
    const metaPath = join(targetDir, 'project.json')
    try {
      if (!existsSync(metaPath)) {
        writeFileSync(metaPath, `${JSON.stringify({ cwd: LEGACY_GLOBAL_SLUG }, null, 2)}\n`, 'utf8')
      }
      const target = new MemoryStore(targetDir)
      target.attachLedger(this, LEGACY_GLOBAL_SLUG)
      await target.reindex()
      for (const key of moved) {
        if (pinned.has(key)) await target.addPin(key)
      }
      // The retired scope's own index described cards that no longer live
      // there; reindexing an emptied store drops the file.
      await this.global.reindex()
    } catch (error) {
      // The cards are already at their destination — this is reporting only.
      log?.info(`memory migration: moved ${String(moved.length)} retired global card(s) but could not finish their index/pins: ${String(error)}`)
      return moved.length
    }
    log?.info(`memory migration: moved ${String(moved.length)} retired global card(s) to projects/${LEGACY_GLOBAL_SLUG} (listable and deletable there)`)
    if (failed.length > 0) {
      log?.info(`memory migration: ${String(failed.length)} retired global card(s) could not be moved, left in place: ${failed.join(', ')}`)
    }
    return moved.length
  }

  /**
   * Move the retired scope's ARCHIVE into the same project directory.
   *
   * The archive is the undo surface of the scope the migration just retired, and
   * a restore writes back into the store it belongs to — so leaving it at the
   * root would let a user "restore" a card into a scope nothing injects and
   * nothing lists: the card would exist and be invisible. Moving it keeps the
   * undo working and makes the restored card land in `legacy-global`, where the
   * settings page shows it.
   *
   * Idempotent the same way the cards are (moves, never copies; a destination
   * that exists wins), and never fatal: a failure leaves the copy where it is.
   *
   * @param log - host logger (optional).
   * @returns how many archived copies were moved.
   */
  private async moveRetiredGlobalArchive(log?: { info(msg: string): void }): Promise<number> {
    // `storePath` is the topics directory; the archive sits beside it, at the
    // store's own root.
    const source = join(dirname(this.global.storePath), 'archive')
    if (!existsSync(source)) return 0
    let days: string[]
    try {
      days = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return 0
    }
    let moved = 0
    for (const day of days) {
      let names: string[]
      try {
        names = readdirSync(join(source, day), { withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
          .map(entry => entry.name)
      } catch {
        continue
      }
      for (const name of names) {
        const to = join(this.dir, 'projects', LEGACY_GLOBAL_SLUG, 'archive', day, name)
        if (existsSync(to)) continue
        try {
          mkdirSync(dirname(to), { recursive: true })
          renameSync(join(source, day, name), to)
          moved += 1
        } catch (error) {
          log?.info(`memory migration: could not move the archived copy ${day}/${name} of the retired global scope: ${String(error)}`)
        }
      }
      // The day directory itself is left if anything is still in it (a copy
      // that could not be moved); an empty one goes, so the retired archive
      // does not linger as a tree of empty dates.
      try {
        await fsp.rmdir(join(source, day))
      } catch {
        // Not empty, or already gone: nothing to do either way.
      }
    }
    return moved
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

  /**
   * Record many similarity suspects with ONE read/write.
   *
   * The per-pair form rewrites the whole state file — which also carries every
   * curated hash and rotation anchor — for each pair. Thirty cards produce up to 435
   * pairs, so one sweep rewrote that file 435 times on the caller's way back from
   * `memory_save`.
   */
  recordSuspects(scope: string, pairs: readonly { a: string, b: string, score: number }[]): void {
    if (pairs.length === 0) return
    const state = this.readDistillState()
    const suspects = state.suspects ?? []
    const at = Date.now()
    for (const pair of pairs) {
      suspects.push({ at, scope, a: pair.a, b: pair.b, score: Math.round(pair.score * 1000) / 1000 })
    }
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
   * carries every curated hash and rotation anchor) once per event.
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

  /**
   * Record what recent index/card reconciliations found, and persist — one
   * read/write per pass (a mount may reconcile every store at once).
   *
   * Never throws: this is diagnostic. A failure to record that an index was
   * rebuilt must not turn a mount into a failure.
   */
  recordIndexDrifts(events: ReadonlyArray<Omit<IndexDriftEvent, 'at'>>): void {
    if (events.length === 0) return
    try {
      const state = this.readDistillState()
      const drift = state.indexDrift ?? []
      const at = Date.now()
      for (const event of events) drift.push({ ...event, at })
      state.indexDrift = drift.slice(-MAX_INDEX_DRIFT_EVENTS)
      mkdirSync(this.dir, { recursive: true })
      atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch (error) {
      console.warn(`memory index: could not record ${String(events.length)} reconciliation event(s): ${String(error)}`)
    }
  }

  /** Recent reconciliation events, newest first. */
  indexDrifts(): IndexDriftEvent[] {
    return [...(this.readDistillState().indexDrift ?? [])].reverse()
  }

  /**
   * Record one light sweep's over-cap domains and persist — one read/write per
   * sweep, and none at all when every bucket is under the cap.
   *
   * Never throws: this is MEASUREMENT (the plan's Q1 keeps `DOMAIN_CAP` out of
   * every gate this round), and a failure to measure must not break the write
   * that triggered the sweep.
   */
  recordDomainOvers(scope: string, entries: ReadonlyArray<{ domain: string, cards: number, cap: number }>): void {
    if (entries.length === 0) return
    try {
      const state = this.readDistillState()
      const over = state.domainOver ?? []
      const at = Date.now()
      for (const entry of entries) over.push({ ...entry, scope, at })
      state.domainOver = over.slice(-MAX_DOMAIN_OVER_EVENTS)
      mkdirSync(this.dir, { recursive: true })
      atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch (error) {
      console.warn(`memory domain: could not record ${String(entries.length)} over-cap domain(s): ${String(error)}`)
    }
  }

  /** Recent over-cap domain measurements, newest first. */
  domainOvers(): DomainOverEvent[] {
    return [...(this.readDistillState().domainOver ?? [])].reverse()
  }

  /**
   * Reconcile every store's `index.md` against its cards, rebuilding the ones
   * that disagree (W2). Runs at mount and on `/status` — the two moments a
   * session can start reading a stale index without anything else noticing.
   *
   * Why not every write: `reindex()` already runs there. The gap is exactly the
   * writes that never happen — a card removed outside the plugin, a hand-edited
   * index, a store restored from another machine.
   *
   * Deliberately NOT fatal: a store whose index cannot be rebuilt keeps its
   * cards and answers the rest of the pass. Never throws — a `/status` request
   * must not fail because one project's index is unreadable.
   *
   * @param log - host logger (optional).
   * @returns the events recorded, in the order the stores were visited.
   */
  async reconcileIndexes(log?: { info(msg: string): void }): Promise<Array<Omit<IndexDriftEvent, 'at'>>> {
    // Enumerated from the DIRECTORY, not through `listProjects()`: that call
    // computes every store's metrics, i.e. parses every card — the full read
    // this check exists to avoid at mount. One readdir here, then one cheap
    // drift check per store.
    const stores: Array<[string, MemoryStore]> = [['global', this.global]]
    for (const slug of this.projectSlugs()) {
      const store = this.projectBySlug(slug)
      if (store !== undefined) stores.push([slug, store])
    }
    const events: Array<Omit<IndexDriftEvent, 'at'>> = []
    for (const [label, store] of stores) {
      const drift = store.indexDrift()
      if (drift === undefined) continue
      let repaired = false
      try {
        await store.reindex()
        repaired = true
      } catch (error) {
        log?.info(`memory index: ${label} drifted (index ${String(drift.indexLines)} lines / ${String(drift.cards)} cards) and the rebuild failed: ${String(error)}`)
      }
      events.push({ scope: label, ...drift, repaired })
      const detail = [
        drift.ghostKeys.length > 0 ? `ghost ${drift.ghostKeys.join(', ')}` : '',
        drift.unlistedKeys.length > 0 ? `unlisted ${drift.unlistedKeys.join(', ')}` : '',
        drift.duplicatedKeys.length > 0 ? `duplicated ${drift.duplicatedKeys.join(', ')}` : '',
        drift.malformedLines.length > 0 ? `malformed ${String(drift.malformedLines.length)} line(s)` : '',
      ].filter(part => part !== '').join('; ')
      log?.info(`memory index: ${label} was out of step (index ${String(drift.indexLines)} lines / ${String(drift.cards)} cards; ${detail})${repaired ? ' — rebuilt' : ''}`)
    }
    if (events.length > 0) this.recordIndexDrifts(events)
    return events
  }

  /** Project directory slugs, from the DIRECTORY (no `project.json` read, no
   *  card read). Used by {@link reconcileIndexes}, whose whole point is to cost
   *  nothing on a healthy root. A linked project directory is skipped — the
   *  same rule {@link listProjects} applies — and healed on its next write. */
  private projectSlugs(): string[] {
    const dir = join(this.dir, 'projects')
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && isValidSlug(entry.name))
        .map(entry => entry.name)
    } catch {
      return []
    }
  }

  /**
   * Append one background-LLM audit row and persist (bounded FIFO). */
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

  /** Read (and repair) distill-state.json; missing/malformed → empty. Keys an
   *  older file carries but this module no longer defines are ignored — an old
   *  state file must never make the store throw. */
  private readDistillState(): DistillState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.distillStatePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const curated = (parsed as { curated?: unknown }).curated
        const suspects = (parsed as { suspects?: unknown }).suspects
        const curateCursor = (parsed as { curateCursor?: unknown }).curateCursor
        const curateStalls = (parsed as { curateStalls?: unknown }).curateStalls
        const ledger = (parsed as { ledger?: unknown }).ledger
        const indexDrift = (parsed as { indexDrift?: unknown }).indexDrift
        const domainOver = (parsed as { domainOver?: unknown }).domainOver
        return {
          version: 1,
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
          indexDrift: Array.isArray(indexDrift) ? indexDrift.filter(isIndexDriftEvent) : [],
          domainOver: Array.isArray(domainOver) ? domainOver.filter(isDomainOverEvent) : [],
        }
      }
    } catch {
      // absent or unreadable → fresh state
    }
    return { version: 1 }
  }
}
