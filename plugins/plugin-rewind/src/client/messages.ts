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
