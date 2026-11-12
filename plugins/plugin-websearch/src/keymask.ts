/**
 * Masking literal key values on the way to the client, and putting them back on
 * the way in.
 *
 * Host-side only: the placeholder carries a short digest of the value, so this
 * module needs `node:crypto` and must never be imported by the browser half.
 * The client only needs to recognise a placeholder, which is a pure pattern test
 * in `wire.ts`.
 *
 * ## Why a reference and not a position
 *
 * The page shows one chip per configured key so a key can be deleted on its own
 * (the alternative — one opaque placeholder for the whole list — cannot express
 * "remove this one"). The first attempt reconstructed the list POSITIONALLY:
 * each surviving placeholder consumed the next stored key. That is wrong in a
 * way the screen hides — chips are indistinguishable, so the placeholder that
 * survives is not the one the user kept, and a list mixing literals with
 * `$ENV:` references visibly swapped a deleted key back in.
 *
 * A per-value digest makes the placeholder position-independent: the client
 * sends back the placeholders it still has, and each one names its own value.
 * Eight hex characters of SHA-256 reveal nothing usable about a high-entropy
 * key (it is not reversible and cannot be brute-forced without already knowing
 * the value) and they do reveal equality, which is the point: two chips for the
 * same key collapse exactly like the stored list does.
 *
 * @module @dsh-app/plugin-websearch/keymask
 */

import { createHash } from 'node:crypto'
import {
  ENV_REFERENCE,
  isStoredKeyToken,
  VALUE_MASK,
  WebSearchValidationError,
  type EngineEntry,
  type EngineId,
} from './wire.ts'

/** The reference a placeholder carries for one literal key value. */
export function keyRefOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)
}

/** Build the placeholder the client sees in place of one stored literal. */
function placeholder(value: string): string {
  return `${VALUE_MASK}#${keyRefOf(value)}`
}

/**
 * Mask literal keys before they cross to the client.
 *
 * One placeholder per stored literal, in stored order; `$ENV:NAME` references
 * travel verbatim because they are not secrets and the page shows which
 * variable is referenced.
 *
 * @param engines - the persisted engine rows.
 * @returns the same rows with every literal key replaced by its placeholder.
 */
export function maskEngines(engines: readonly EngineEntry[]): EngineEntry[] {
  return engines.map((entry) => {
    const keys = entry.apiKeys
    if (keys === undefined || keys.length === 0) return { ...entry, apiKeys: undefined }
    return {
      ...entry,
      apiKeys: keys.map(key => ENV_REFERENCE.test(key) ? key : placeholder(key)),
    }
  })
}

/**
 * Put the stored values back where the client sent placeholders.
 *
 * Each placeholder is resolved through its own reference, so removing any chip
 * removes exactly that key — including the middle of a list, and including a
 * list mixed with `$ENV:` references.
 *
 * A placeholder that names a value the store no longer has is a rejected write,
 * not a silent drop: it means the page is showing a key the host cannot keep,
 * and acknowledging the save would leave the two disagreeing.
 *
 * @param raw - the `engines` field of a save request, as the client sent it.
 * @param existing - the stored rows, the source of the real values.
 * @returns the body with every placeholder replaced by its value.
 * @throws {WebSearchValidationError} `engine.keyMasked` for an unknown reference.
 */
export function unmaskEngines(raw: unknown, existing: readonly EngineEntry[]): unknown {
  if (!Array.isArray(raw)) return raw
  const stored = new Map(existing.map(entry => [entry.id, entry.apiKeys]))
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
    const keys = (item as { readonly apiKeys?: unknown }).apiKeys
    if (!Array.isArray(keys) || !keys.some(key => typeof key === 'string' && isStoredKeyToken(key))) return item
    const id = String((item as { readonly id?: unknown }).id)
    // References are computed from the LITERAL values only: an `$ENV:` entry
    // travels verbatim and must never be re-substituted.
    const byRef = new Map<string, string>()
    for (const value of stored.get(id as EngineId) ?? []) {
      if (ENV_REFERENCE.test(value)) continue
      const ref = keyRefOf(value)
      if (!byRef.has(ref)) byRef.set(ref, value)
    }
    const expanded: string[] = []
    for (const key of keys) {
      if (typeof key !== 'string' || !isStoredKeyToken(key)) {
        expanded.push(String(key))
        continue
      }
      const value = byRef.get(key.slice(key.lastIndexOf('#') + 1))
      if (value === undefined) throw new WebSearchValidationError('engine.keyMasked', { id })
      expanded.push(value)
    }
    return { ...(item as Record<string, unknown>), apiKeys: expanded }
  })
}
