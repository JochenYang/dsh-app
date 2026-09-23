/**
 * The settings-page knobs of the swarm plugin: the ten editable fields, the
 * validation a write must pass, and how a patch becomes the config object the
 * kernel stores.
 *
 * The fields themselves are declared on the kernel Config schema
 * (`src/index.ts`, marked `.volatile()`), so a saved value reaches the running
 * plugin through the kernel's config editor writing the profile's
 * `cordis.patch.yml` — the plugin owns no configuration file any more. What
 * stays plugin-owned is the editorial layer around those fields:
 *
 *   - {@link SWARM_CONFIG_FIELDS} — the names a settings write may address.
 *   - {@link validateSwarmConfigPatch} — the floors and types, refused with a
 *     coded message the settings page renders (the schema is the last line of
 *     defense, but a rejection it raises has no copy the page can show).
 *   - {@link projectSwarmConfig} — the projection every write goes through, so
 *     a one-field save never silently retunes the other nine.
 *   - {@link readRetiredSwarmConfig} / {@link retireSwarmConfigFile} — the
 *     one-time import of the JSON file this plugin used to keep, and keeping
 *     that file as evidence instead of deleting it.
 *
 * @module @dsh-app/plugin-swarm/user-config
 */

import { readFileSync, renameSync } from 'node:fs'
import { MIN_ITEMS } from './expand.ts'
import type { HostText } from './wire.ts'

/** Numeric editable fields. */
const NUMERIC_FIELDS = [
  'defaultConcurrency',
  'maxConcurrency',
  'maxItems',
  'startStaggerMs',
  'itemMaxRetries',
  'itemRetryDelayMs',
  'perItemOutputLimit',
  'tokenBudget',
] as const

/** Boolean editable fields. */
const BOOLEAN_FIELDS = ['enabled', 'adaptive'] as const

/** Every editable field name (a write addressing anything else is refused). */
export const SWARM_CONFIG_FIELDS: readonly string[] = [...NUMERIC_FIELDS, ...BOOLEAN_FIELDS]

/**
 * The ten editable values as one plain object: the shape the settings page
 * reads and the shape downstream code uses, with the kernel's volatile config
 * references already snapshotted.
 */
export type SwarmConfigValues = {
  readonly enabled: boolean
  readonly adaptive: boolean
  readonly defaultConcurrency: number
  readonly maxConcurrency: number
  readonly maxItems: number
  readonly startStaggerMs: number
  readonly itemMaxRetries: number
  readonly itemRetryDelayMs: number
  readonly perItemOutputLimit: number
  readonly tokenBudget: number
}

/** A validated write: one value per named field, `null` meaning "clear it". */
export type SwarmConfigPatch = Readonly<Record<string, number | boolean | null>>

/**
 * Fields with a semantic floor: the numeric check alone is not enough —
 * a 0 here would merge into the effective config and trip the plugin's
 * load-time assertions (maxItems ≥ MIN_ITEMS, concurrency ≥ 1).
 */
const FIELD_MINIMUMS: Partial<Record<(typeof NUMERIC_FIELDS)[number], number>> = {
  defaultConcurrency: 1,
  maxConcurrency: 1,
  maxItems: MIN_ITEMS,
  // 0 would silently truncate every item's output to nothing.
  perItemOutputLimit: 1,
}

/** A rejected field, as the client dictionary and the log line both need it. */
interface FieldRejection {
  /** Stable message code (see the `swarm.host.*` keys). */
  readonly code: 'config.notBoolean' | 'config.belowMinimum'
  /** Values the client's copy interpolates. */
  readonly params: Readonly<Record<string, string | number>>
  /** English developer-facing diagnostic. */
  readonly text: string
}

/**
 * Validate one field value.
 * @returns the normalized value, or the coded reason it was rejected.
 */
function validateField(field: string, value: unknown): { ok: true, value: number | boolean } | ({ ok: false } & FieldRejection) {
  if ((BOOLEAN_FIELDS as readonly string[]).includes(field)) {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, code: 'config.notBoolean', params: { field }, text: `"${field}" must be a boolean` }
  }
  const minimum = FIELD_MINIMUMS[field as (typeof NUMERIC_FIELDS)[number]] ?? 0
  if (typeof value === 'number' && Number.isFinite(value) && value >= minimum) {
    return { ok: true, value: Math.floor(value) }
  }
  return { ok: false, code: 'config.belowMinimum', params: { field, minimum }, text: `"${field}" must be a number >= ${minimum}` }
}

/**
 * Validation failure of a settings-page write (routes map it to 400).
 *
 * Carries a code plus its params rather than a sentence: the client renders
 * the copy, and `text` keeps an English developer-facing diagnostic for logs
 * and for a client that does not know the code.
 */
export class SwarmConfigValidationError extends Error {
  /**
   * @param code - stable message code (see the `swarm.host.*` keys).
   * @param text - English developer-facing diagnostic.
   * @param params - values the client's copy interpolates.
   */
  constructor(
    readonly code: string,
    readonly text: string,
    readonly params?: Readonly<Record<string, string | number>>,
  ) {
    super(text)
    this.name = 'SwarmConfigValidationError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.params === undefined
      ? { code: this.code, text: this.text }
      : { code: this.code, params: this.params, text: this.text }
  }
}

/**
 * Validate one settings-page body into a patch.
 *
 * Unknown fields reject the whole write (a typo must never look saved), and so
 * does any value the field cannot hold. `null` is admitted on every field: it
 * is how the page clears an override.
 *
 * @param body - the decoded request body.
 * @returns the validated patch, ready for {@link projectSwarmConfig}.
 * @throws {SwarmConfigValidationError} on the first unusable field.
 */
export function validateSwarmConfigPatch(body: Record<string, unknown>): SwarmConfigPatch {
  for (const field of Object.keys(body)) {
    if (!SWARM_CONFIG_FIELDS.includes(field)) {
      throw new SwarmConfigValidationError('config.unknownField', `unknown config field "${field}"`, { field })
    }
  }
  const patch: Record<string, number | boolean | null> = {}
  for (const [field, value] of Object.entries(body)) {
    if (value === null) {
      patch[field] = null
      continue
    }
    const result = validateField(field, value)
    if (!result.ok) throw new SwarmConfigValidationError(result.code, result.text, result.params)
    patch[field] = result.value
  }
  return patch
}

/**
 * Build the config object a write stores for this plugin's profile row.
 *
 * The row that carries a saved value assigns its whole `config` onto the entry
 * it patches (`applyEntryPatches`: `target.config = next`), so every editable
 * field must travel with every write. A field left out does not fall back to
 * the layer that shipped it: it falls back to the SCHEMA default, which is not
 * the deployment value (the shipped overlay asks for 64 items at concurrency
 * 16; the schema defaults are 8 and 8). A one-field save that omitted the rest
 * would therefore retune every other knob in silence.
 *
 * Fields the patch does not name keep their current effective value (`live`,
 * the volatile references snapshotted), non-editable fields keep whatever the
 * entry already carries (`current` — `provider`, `agentOptions`, `maxDepth`),
 * and a field cleared with `null` falls back to the layer value (`inherited`),
 * or is dropped entirely when no layer sets it, which is the one case where
 * the schema default IS the deployment value.
 *
 * @param current - the raw config the entry currently carries.
 * @param inherited - the config the composing layers alone yield.
 * @param patch - the validated write.
 * @param live - the current effective values.
 * @returns the complete config object for the profile row.
 */
export function projectSwarmConfig(
  current: Readonly<Record<string, unknown>>,
  inherited: Readonly<Record<string, unknown>>,
  patch: SwarmConfigPatch,
  live: Readonly<Record<string, number | boolean>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  for (const field of SWARM_CONFIG_FIELDS) {
    const explicit = patch[field]
    if (explicit === null) {
      if (inherited[field] === undefined) Reflect.deleteProperty(next, field)
      else next[field] = inherited[field]
      continue
    }
    next[field] = explicit ?? live[field]
  }
  return next
}

/** Parse the raw file content into an object, or undefined when unusable. */
function readRawConfig(path: string, log: (message: string) => void): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined // missing file: no store to import
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`swarm user config: unreadable JSON, nothing to import: ${(error as Error).message}`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('swarm user config: expected a JSON object, nothing to import')
    return undefined
  }
  return parsed as Record<string, unknown>
}

/**
 * Read the retired JSON store (`<storeDir>/config.json`) for the one-time
 * import into the declarative config.
 *
 * Reads degrade: an absent, malformed or unreadable file yields `undefined`
 * (nothing to import, nothing to rename), and a value a field cannot hold is
 * logged and dropped rather than failing a boot.
 *
 * @param path - absolute path of the retired store.
 * @param log - diagnostic logger for degradations.
 * @returns the values worth importing, or undefined when the file is unusable.
 */
export function readRetiredSwarmConfig(path: string, log: (message: string) => void): Record<string, number | boolean> | undefined {
  const obj = readRawConfig(path, log)
  if (obj === undefined) return undefined
  const imported: Record<string, number | boolean> = {}
  for (const field of SWARM_CONFIG_FIELDS) {
    const value = obj[field]
    if (value === undefined) continue
    const result = validateField(field, value)
    if (result.ok) imported[field] = result.value
    else log(`swarm user config: ${result.text}, ignored`)
  }
  return imported
}

/**
 * Move the retired store aside under a timestamped name.
 *
 * The file is the user's own writing, so it is kept, never deleted: the import
 * is one-way, and a value this build refused is recoverable by hand from the
 * renamed copy.
 *
 * @param path - absolute path of the retired store.
 * @returns the path it was moved to, or undefined when it could not be moved.
 */
export function retireSwarmConfigFile(path: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const retired = `${path}.imported-${stamp}`
  try {
    renameSync(path, retired)
    return retired
  } catch {
    return undefined
  }
}
