/**
 * The card FILE format and its three-state read.
 *
 * Two things live here because two layers need them without owning a store:
 *
 *   1. one topic card ⇄ its Markdown text (`parseCard` / `renderCard`), and
 *   2. the read that answers `present` / `absent` / `unreadable`.
 *
 * The probe is the reason this module exists. A move reads ANOTHER store's card
 * (`moveCardTo`), and every delete path (`remove`, `forget`) has to decide the
 * same question: is the card there, or could I simply not read it? That decision
 * has exactly one definition — here — so a destructive caller cannot grow its
 * own.
 *
 * `memory-store.ts` re-exports every name below, so the public import surface
 * is unchanged for the rest of the host half and the tests.
 *
 * @module @dsh-app/plugin-memory/card-file
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/** Index hook length ceiling: the summary is what future saves route by, so
 *  it must state coverage in one glance. */
export const MAX_SUMMARY_CHARS = 40

/** Topic-key shape: ASCII kebab-case, also the card filename. Chinese topic
 *  words slugify to '' and are rejected — the model must translate. */
export const TOPIC_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u

/** The longest topic key {@link TOPIC_KEY_PATTERN} admits (one lead character
 *  plus the pattern's 47). {@link slugifyTopic} cuts at this width. */
const TOPIC_KEY_MAX_CHARS = 48

/** What the disambiguating suffix of a CUT key costs: a dash and four hex. */
const TOPIC_KEY_SUFFIX_CHARS = 5

/** Shape of a card's `source:` — a short session id. Conservative on purpose:
 *  the value is metadata, and a hand-edited line must not be able to turn it
 *  into prose, a path, or a second frontmatter key. ONE definition shared by
 *  the writer's validation and the reader, so the two cannot disagree. */
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u

/** Domain-key shape. Deliberately the same alphabet as a topic key but
 *  shorter: a domain prefixes EVERY index line of its group, so its length is
 *  a per-card cost in the injected index (48 characters would cost more than
 *  the summaries it groups). */
export const DOMAIN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}$/u

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
  /** Optional DECLARED domain (a subject bucket wider than one topic, e.g.
   *  `dsh`, `windows`). Absent on every card written before this field
   *  existed; {@link domainOf} derives one from the topic key in that case, so
   *  no migration is needed. Never invented here: a value the frontmatter
   *  cannot validate is read as absent. */
  domain?: string
  /** Short id of the session whose save CREATED the card (provenance: which
   *  conversation a fact came from). Written once, kept by later updates.
   *  Absent on cards written before the field existed and on hand-written
   *  files; a value of the wrong shape is read as absent, never as malformed. */
  source?: string
  /** Hand-edited file whose frontmatter failed to parse: the body is carried
   *  verbatim (like the old hand-note lines) and the card is injectable but
   *  not upsertable until rewritten. */
  malformed: boolean
}

/** Normalize a model-provided topic into a key: lowercase, non [a-z0-9]
 *  runs collapse to '-', trimmed, capped at 48 chars. '' means the proposal
 *  carried no ASCII letters/digits at all (e.g. pure Chinese) — reject it.
 *
 *  A proposal LONGER than the cap is cut and takes a `-<4 hex>` suffix: the
 *  first four hex digits of sha256 of the NORMALIZED proposal. Without it two
 *  topics that share their first 48 characters but differ after the cut
 *  became the same key — i.e. the same card, one silently overwriting the
 *  other. The hash is taken after normalization, not of the raw input, so a
 *  key means the same thing at every length: two proposals that differ only
 *  in case or punctuation are one subject below the cap, and stay one subject
 *  above it. Exactly 48 characters is not a cut and takes no suffix; the
 *  result always satisfies {@link TOPIC_KEY_PATTERN}. */
export function slugifyTopic(input: string): string {
  const full = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (full.length <= TOPIC_KEY_MAX_CHARS) return full
  const head = full
    .slice(0, TOPIC_KEY_MAX_CHARS - TOPIC_KEY_SUFFIX_CHARS)
    .replace(/-+$/u, '')
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 4)
  return `${head}-${hash}`
}

/** Whether a topic key is well-formed (also the traversal fence for card paths). */
/** Windows device names. A file called `con.md` is the console, not a file —
 *  writes, renames and `existsSync` on it behave as devices — so a topic key
 *  may not be one, on every platform: a store written on one OS is read on
 *  the others. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u

/** Whether `name` is a topic key this plugin will use as a filename. */
export function isValidTopic(name: string): boolean {
  return TOPIC_KEY_PATTERN.test(name) && !WINDOWS_DEVICE_NAME.test(name)
}

/** Whether a declared domain is well-formed (see {@link DOMAIN_KEY_PATTERN}). */
export function isValidDomain(domain: string): boolean {
  return DOMAIN_KEY_PATTERN.test(domain)
}

/** Which domain a card belongs to, and where that answer came from. */
export interface CardDomain {
  /** The domain key: declared, or the topic key's first `-` segment. */
  key: string
  /** `declared` = the card carries `domain:`; `inferred` = derived from the
   *  topic key because the card predates (or omits) the field. The distinction
   *  is the whole point: a metric that mixed the two could not tell a store
   *  organised by its writer from one grouped by a filename convention. */
  src: 'declared' | 'inferred'
}

/**
 * The domain of one card: its declared `domain`, else the FIRST SEGMENT of the
 * topic key (`dsh-plugin-install` → `dsh`).
 *
 * Read-only and never persisted — a derived domain has to stay derivable, so a
 * later change to this rule re-groups old cards instead of leaving half a store
 * on the previous rule. Deployment-independent of `memory-store.ts` on purpose:
 * the index, the curator input and the health audit all ask this one question.
 *
 * The first segment is coarse on purpose (the plan's ruled-out list rejects
 * prefix GROUPING as a consolidation strategy, not as a derivation): a `dsh`
 * domain holds 16 unrelated `dsh-*` cards today, and that is a measurable fact
 * about the store, not a merge proposal.
 */
export function domainOf(card: Pick<TopicCard, 'name' | 'domain'>): CardDomain {
  if (card.domain !== undefined && card.domain !== '') return { key: card.domain, src: 'declared' }
  const cut = card.name.indexOf('-')
  return { key: cut === -1 ? card.name : card.name.slice(0, cut), src: 'inferred' }
}

/** Local-date stamp for frontmatter fields. */
export function todayStamp(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Render one card to its file text (frontmatter + blank line + body). */
export function renderCard(card: TopicCard): string {
  return [
    '---',
    `name: ${card.name}`,
    `category: ${card.category}`,
    `summary: ${card.summary}`,
    ...(card.domain === undefined || card.domain === '' ? [] : [`domain: ${card.domain}`]),
    ...(card.source === undefined || card.source === '' ? [] : [`source: ${card.source}`]),
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
 *
 * `source` is out for a different reason: provenance says WHERE a fact came
 * from, not WHAT it says. A card whose recorded origin differs is not a
 * different card to an edit that was decided on its content, so the witness
 * does not move when only the origin does.
 */
export function cardFingerprint(card: TopicCard): string {
  return [card.name, card.category, card.summary, card.domain ?? '', card.body, card.malformed ? 'malformed' : ''].join('\u0000')
}

/**
 * Parse a card file tolerantly. The filename stem is the authoritative key.
 * A file whose frontmatter is missing/broken (hand edits) still yields a card
 * with `malformed: true` and the WHOLE raw text as body — injectable verbatim,
 * excluded from upsert targeting until rewritten, never silently dropped.
 */
export function parseCard(name: string, text: string): TopicCard {
  const today = todayStamp()
  // A hand-edited file carries no date this reader can trust, so it gets
  // none: {@link UNKNOWN_DATE} reads as the oldest card and is the same on
  // every day. Stamping it "today" made an unchanged store inject a different
  // key line after midnight, and ranked the file as freshly edited.
  const fail = (): TopicCard => ({
    name, category: 'fact', summary: '(hand-edited)', created: UNKNOWN_DATE, updated: UNKNOWN_DATE,
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
  // A `domain:` line the shape check refuses is read as ABSENT, not as a
  // malformed card: the tolerance rule is "never lose the body because one
  // optional key is odd", and an absent domain simply falls back to the
  // topic-key derivation. Unknown keys are ignored the same way — the field
  // map is consulted by name, so a stray key costs nothing.
  const declared = fields.domain
  const domain = declared !== undefined && isValidDomain(declared) ? declared : undefined
  // `source:` is a short session id ({@link SOURCE_ID_PATTERN}): a
  // conservative shape, so a hand-edited line cannot smuggle prose (or a
  // path) into the card's metadata.
  const declaredSource = fields.source
  const source = declaredSource !== undefined && SOURCE_ID_PATTERN.test(declaredSource) ? declaredSource : undefined
  return {
    name,
    category: category as MemoryCategory,
    summary: singleLine((fields.summary ?? '').slice(0, MAX_SUMMARY_CHARS)) || '(no summary)',
    ...(domain === undefined ? {} : { domain }),
    ...(source === undefined ? {} : { source }),
    created: stampOrUnknown(fields.created, today),
    updated: stampOrUnknown(fields.updated, today),
    body,
    malformed: false,
  }
}

/** A frontmatter date, exactly as the host writes it. */
const DATE_STAMP = /^\d{4}-\d{2}-\d{2}$/u

/** The date of a card whose `created:` / `updated:` line is present but is not
 *  a date. It sorts as the OLDEST card, never as the newest: a hand-edited
 *  `updated: see branch x` used to ride verbatim into the heading of every
 *  injected body, and falling back to today would have ranked an undated card
 *  as the freshest of its category. */
export const UNKNOWN_DATE = '0000-00-00'

/** The field's date when it is one, `fallback` when the line is absent (the
 *  host omits nothing, so that is an older file), {@link UNKNOWN_DATE} when the
 *  line is there and is not a date. */
function stampOrUnknown(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  return DATE_STAMP.test(value) ? value : UNKNOWN_DATE
}

/** Every code point a line-oriented reader may treat as a line break: CR, LF,
 *  and the Unicode ones — next line (U+0085), line separator (U+2028),
 *  paragraph separator (U+2029). */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/u
const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]/gu

/** Whether `text` holds a line break of any kind (see {@link LINE_BREAK}). */
export function hasLineBreak(text: string): boolean {
  return LINE_BREAK.test(text)
}

/** `text` on one line: every line break of any kind becomes a space. The
 *  injected card block and the index are line-oriented, and a separator the
 *  host does not fold would let a card start "another entry". */
export function singleLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ')
}

// ---------------------------------------------------------------------------
// The three-state read
// ---------------------------------------------------------------------------

/** How a card file is read. Production uses {@link readCardFile}; the tests
 *  replace it to throw, because an fs-level read failure (EACCES / EISDIR / a
 *  torn mount) cannot be reproduced in-process any other way. */
export type CardFileReader = (path: string) => string

/** The production reader. */
export const readCardFile: CardFileReader = path => readFileSync(path, 'utf8')

/** `present` (read and parsed), `absent` (the read answered ENOENT/ENOTDIR) or
 *  `unreadable` (the file is there but the read or the parse failed). */
export type CardState = 'present' | 'absent' | 'unreadable'

/** A probe answer. Only `present` carries the card; only `present` and `absent`
 *  are ANSWERS — `unreadable` is the absence of one. */
export type CardProbe =
  | { state: 'present', card: TopicCard }
  | { state: 'absent' }
  | { state: 'unreadable' }

/** `ENOENT` / `ENOTDIR` are the only failures that mean "no such file". Any
 *  other error (EACCES, ELOOP, EISDIR, EBUSY, a broken mount, or one that
 *  carries no code at all) means "I could not read it" and must never be
 *  answered as absent. */
export function isMissingError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Read one card file and answer in three states.
 *
 * Not `existsSync` first: that answers `false` for ANY failure (an unreadable
 * parent, a loop, a broken mount), which would fold exactly those failures back
 * into "absent", and an exists-then-read pair also leaves a TOCTOU window
 * between the two. The read is the authority; its error code separates the two.
 *
 * @param topicsDir - the store's `topics/` directory.
 * @param name - the topic key (also the filename stem).
 * @param read - how to read a card file (see {@link CardFileReader}).
 */
export function probeCardFile(topicsDir: string, name: string, read: CardFileReader = readCardFile): CardProbe {
  if (!isValidTopic(name)) return { state: 'absent' }
  const path = join(topicsDir, `${name}.md`)
  let text: string
  try {
    text = read(path)
  } catch (error) {
    return { state: isMissingError(error) ? 'absent' : 'unreadable' }
  }
  try {
    return { state: 'present', card: parseCard(name, text) }
  } catch {
    // The read succeeded, the content did not parse: present, not absent.
    return { state: 'unreadable' }
  }
}

/** Raised when an action needs a card it cannot read. The message shape is
 *  shared so every path reports the same thing on the wire. The directory is
 *  deliberately not in it: a tool call's failure text reaches the model, and
 *  the key plus what did not happen is all a reader needs. */
export class CardUnreadableError extends Error {
  constructor(_topicsDir: string, name: string, consequence: string, label = 'card') {
    super(`cannot read the ${label} "${name}"; ${consequence}`)
    this.name = 'CardUnreadableError'
  }
}

/** Raised when a card's archive copy could not be written. The removal that
 *  asked for the copy is REFUSED — the copy is that removal's only undo — so
 *  the message names what did NOT happen, and `cause` keeps the error the
 *  write failed with. The mirror of {@link CardUnreadableError}: "cannot
 *  read it, so it is not deleted" and "cannot copy it, so it is not
 *  deleted" are one invariant seen from its two ends. */
export class ArchiveWriteError extends Error {
  // The archive directory is deliberately NOT in the message: an absolute path
  // carries the user's home directory, and this sentence reaches the settings
  // page and the model. The host log line beside the throw names the directory.
  constructor(name: string, options?: ErrorOptions) {
    super(`cannot archive the card "${name}"; it was not removed`, options)
    this.name = 'ArchiveWriteError'
  }
}

/**
 * The probe, with `unreadable` turned into a throw: the shape every destructive
 * caller wants. `absent` and `present` are answers; "I could not read it" is
 * not, and acting on it deletes or overwrites on a guess.
 *
 * @param topicsDir - the store's `topics/` directory.
 * @param name - the topic key to probe.
 * @param read - how to read a card file.
 * @param consequence - what did NOT happen, e.g. "nothing was forgotten".
 * @param label - what the card is in this sentence (default `card`; the move
 *   destination passes `destination card`).
 */
export function probeOrThrow(
  topicsDir: string,
  name: string,
  read: CardFileReader,
  consequence: string,
  label = 'card',
): { state: 'present', card: TopicCard } | { state: 'absent' } {
  const probe = probeCardFile(topicsDir, name, read)
  if (probe.state === 'unreadable') throw new CardUnreadableError(topicsDir, name, consequence, label)
  return probe
}
