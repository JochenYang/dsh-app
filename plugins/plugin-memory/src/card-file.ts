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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_CATEGORIES, type MemoryCategory } from './types.ts'

/** Index hook length ceiling: the summary is what future saves route by, so
 *  it must state coverage in one glance. */
export const MAX_SUMMARY_CHARS = 40

/** Topic-key shape: ASCII kebab-case, also the card filename. Chinese topic
 *  words slugify to '' and are rejected — the model must translate. */
export const TOPIC_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u

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
 *  shared so every path reports the same thing on the wire. */
export class CardUnreadableError extends Error {
  constructor(topicsDir: string, name: string, consequence: string, label = 'card') {
    super(`cannot read the ${label} "${name}" in ${topicsDir}; ${consequence}`)
    this.name = 'CardUnreadableError'
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
