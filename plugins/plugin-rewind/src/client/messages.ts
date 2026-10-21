/**
 * Resolve a host-issued coded answer into a sentence in this plugin's
 * dictionary.
 *
 * The host sends `HostText` (`{ code, params?, text? }`) as JSON inside a
 * command result's `text`, because it must never send user-visible prose. This
 * module turns that payload back into copy: it looks the code up in the
 * dictionary, and falls back to the host's English diagnostic only when the
 * code is unknown (an older UI beside a newer host). A nested `params` value
 * that itself names a code is resolved one level deep, the same convention the
 * other suite plugins use.
 *
 * @module @dsh-app/plugin-rewind/client/messages
 */

import { zh, type RewindKey } from './locales.ts'

/** The `t` seat shape this module needs. */
export type Translate = (key: RewindKey, params?: Readonly<Record<string, string | number>>) => string

/** A coded host answer, resolved to what a dictionary lookup needs. */
export interface CodedAnswer {
  readonly code: RewindKey
  readonly params?: Readonly<Record<string, string | number>>
}

/** The coded payload the host half puts in a command result's text. */
interface HostTextLike {
  readonly code?: unknown
  readonly params?: unknown
  readonly text?: unknown
}

/** Every key this dictionary owns, for the unknown-code fallback. */
const KNOWN_KEYS = new Set<string>(Object.keys(zh))

/** Narrow one parsed value to the coded payload shape. */
function asHostText(value: unknown): HostTextLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as HostTextLike
  return typeof record.code === 'string' ? record : undefined
}

/**
 * Whether the dictionary owns this code.
 *
 * Membership is checked against the real key set rather than a prefix: a newer
 * host may send a code this UI does not know (`rewind.future.thing`), and a
 * prefix test would claim it and render a blank sentence where the host's own
 * English diagnostic is the honest answer.
 */
function isKnownKey(code: string): code is RewindKey {
  return KNOWN_KEYS.has(code)
}

/**
 * Resolve a coded host answer to the dictionary key and params its sentence
 * needs, without rendering it.
 *
 * This is the shape a COMPONENT wants: it holds the `t` seat, so it renders the
 * sentence itself and re-renders on a locale switch. The client entry has no
 * `t` of its own and must not bind one per call, so it hands the coded answer up
 * and lets the seat that owns the copy do the talking.
 *
 * An unknown code falls back to {@link UNKNOWN_CODE} with the host's own English
 * diagnostic as `detail` — never a blank sentence.
 */
export function hostCode(raw: string | undefined): CodedAnswer | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { code: UNKNOWN_CODE, params: { detail: raw } }
  }
  const payload = asHostText(parsed)
  if (payload === undefined) return { code: UNKNOWN_CODE, params: { detail: raw } }
  const code = payload.code as string
  if (!isKnownKey(code)) {
    return {
      code: UNKNOWN_CODE,
      params: { detail: typeof payload.text === 'string' && payload.text !== '' ? payload.text : code },
    }
  }
  const params = plainParams(payload.params)
  return params === undefined ? { code } : { code, params }
}

/** The dictionary key an unrecognised host code is reported under. */
export const UNKNOWN_CODE: RewindKey = 'rewind.host.rejected'

/** The file report as it rides a command result's `files` field. */
export interface FileReportLike {
  readonly coverage?: unknown
  readonly coverageReason?: unknown
  readonly tools?: unknown
  /** The recall was asked to leave the working tree alone. */
  readonly skipped?: unknown
}

/** The dictionary key naming why a workspace snapshot fell short. */
export function coverageReasonKey(reason: unknown): RewindKey {
  switch (reason) {
    case 'noSnapshot': return 'rewind.files.reasonNoSnapshot'
    case 'file-count': return 'rewind.files.reasonTooManyFiles'
    case 'total-bytes': return 'rewind.files.reasonTooManyBytes'
    case 'timeout': return 'rewind.files.reasonTimeout'
    // A directory or file the walk could not read, or a link it refused to
    // follow: the tree was looked at, but not all of it.
    case 'unreadable-directory':
    case 'unreadable-file':
    case 'symlink': return 'rewind.files.reasonUnreadable'
    default: return 'rewind.files.reasonOther'
  }
}

/**
 * The sentence for how much of a range's file changes a recall could see.
 *
 * `full` says nothing — a recall that did what it said needs no announcement —
 * while `none` and `partial` are exactly the cases the user must hear about: the
 * tree was only partly put back and this is the only place that says so. The
 * shortfall's cause arrives as a code (`noSnapshot`, `file-count`, …) and is
 * rendered here, because a host half never sends prose.
 *
 * @param files - the report from the command result, read defensively.
 * @param t - this plugin's locale-bound `t`.
 * @param keys - the two sentences this caller wants, so the transcript note and
 *   the confirmation dialog can word the same fact differently.
 * @returns the sentence, or undefined when coverage is full.
 */
export function coverageSentence(
  files: FileReportLike | undefined,
  t: Translate,
  keys: { readonly none: RewindKey, readonly partial: RewindKey },
): string | undefined {
  // A skipped revert is checked FIRST and is not a coverage verdict at all: the
  // files were deliberately left alone, so the `none` sentence ("could not be
  // restored") would describe a chosen outcome as a failure.
  if (files?.skipped === true) return t('rewind.files.skipped')
  const coverage = files?.coverage
  if (coverage !== 'none' && coverage !== 'partial') return undefined
  if (coverage === 'none') {
    const tools = Array.isArray(files?.tools)
      ? files.tools.filter((tool): tool is string => typeof tool === 'string').join(', ')
      : ''
    return t(keys.none, { tools: tools === '' ? '—' : tools })
  }
  return t(keys.partial, { reason: t(coverageReasonKey(files?.coverageReason)) })
}

/** Keep only the primitive values a sentence can interpolate. */
function plainParams(raw: unknown): Record<string, string | number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Render one command result's text.
 *
 * A plain string that is not a coded payload is passed through unchanged: the
 * kernel's own commands answer with ordinary text, and this renderer must not
 * mangle them.
 */
export function hostMessage(raw: string | undefined, t: Translate): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  const payload = asHostText(parsed)
  if (payload === undefined) return raw
  const code = payload.code as string
  if (!isKnownKey(code)) {
    return typeof payload.text === 'string' && payload.text !== '' ? payload.text : raw
  }
  const params = resolveParams(payload.params, t)
  return t(code, params)
}

/** Resolve a `params` bag, one level of nested codes deep. */
function resolveParams(
  raw: unknown,
  t: Translate,
): Record<string, string | number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = isKnownKey(value) ? t(value) : value
    } else if (typeof value === 'number') {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
