/**
 * The write side of the usage plugin's knobs: the price-row validation the
 * one-time import of the retired JSON applies, the projection every write goes
 * through, and keeping that file as evidence.
 *
 * The knobs themselves are declared on the kernel Config schema
 * (`src/index.ts`, marked `.volatile()`), so a saved value reaches the running
 * plugin through the kernel's config editor writing the profile's
 * `cordis.patch.yml` — the plugin owns no configuration file any more. What
 * stays plugin-owned is the editorial layer around those fields:
 *
 *   - {@link USAGE_CONFIG_FIELDS} — the fields every write must carry, and the
 *     reason: a row naming only some of them replaces the whole config (see
 *     {@link projectUsageConfig}).
 *   - {@link readRetiredUsageConfig} — the validation of the JSON file this
 *     plugin used to read (`<storeDir>/config.json`), for its one-time import.
 *   - {@link projectUsageConfig} — the projection that import goes through.
 *   - {@link retireUsageConfigFile} — moving that file aside afterwards, never
 *     deleting it.
 *
 * One semantic change is worth stating where the old comment lived. `pricing`
 * used to be TWO tables: the loader entry's own rows, and this file's rows
 * merged on top of them (a file row won per provider/model key). There is
 * exactly one table now — the config field itself — over the built-in defaults
 * that stay in the code (`aggregate.ts`). The import therefore writes the
 * retired file's rows AS that table: rows the entry itself carried are
 * replaced, not merged (this plugin ships none).
 *
 * @module @dsh-app/plugin-usage/user-config
 */

import { readFileSync, renameSync } from 'node:fs'
import type { UsagePrice } from './types.ts'

/**
 * Every editable field name. A write that names only some of them is still a
 * complete config after {@link projectUsageConfig} — see there for why that
 * matters.
 */
export const USAGE_CONFIG_FIELDS: readonly string[] = ['enabled', 'backfillOnStart', 'rescanMinutes', 'pricing']

/**
 * The editable values as one plain object: the shape the write path reads and
 * downstream code uses, with the kernel's volatile config references already
 * snapshotted.
 */
export type UsageConfigValues = {
  /** false → the plugin mounts nothing but its status route. */
  readonly enabled: boolean
  /** Whether the collector folds persisted session logs once at startup. */
  readonly backfillOnStart: boolean
  /** Minutes between incremental rescans; 0 disables. */
  readonly rescanMinutes: number
  /** The price table in effect: built-in defaults overridden by these rows. */
  readonly pricing: readonly UsagePrice[]
}

/** A write: one value per named field, `null` meaning "clear it". */
export type UsageConfigPatch = Readonly<Record<string, number | boolean | readonly UsagePrice[] | null>>

/**
 * Validate one price row of external input.
 *
 * Rates are CNY per 1M tokens, so an unusable one cannot be priced at all: a
 * row missing a provider/model key or carrying a negative or non-numeric rate
 * is dropped, never imported.
 */
function asPrice(value: unknown): UsagePrice | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const provider = typeof row.provider === 'string' ? row.provider : ''
  const model = typeof row.model === 'string' ? row.model : ''
  if (provider === '' || model === '') return undefined
  const rates = [row.input, row.output, row.cacheRead, row.cacheWrite]
  if (rates.some((rate) => typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return undefined
  if (row.peakFactor !== undefined && (typeof row.peakFactor !== 'number' || !Number.isFinite(row.peakFactor) || row.peakFactor < 1)) {
    return undefined
  }
  return {
    provider,
    model,
    input: row.input as number,
    output: row.output as number,
    cacheRead: row.cacheRead as number,
    cacheWrite: row.cacheWrite as number,
    peakFactor: row.peakFactor as number | undefined,
  }
}

/**
 * Build the config object a write stores for this plugin's profile row.
 *
 * The row that carries a saved value assigns its whole `config` onto the entry
 * it patches (`applyEntryPatches`: `target.config = next`), so every editable
 * field must travel with every write. A field left out does not fall back to
 * the layer that set it: it falls back to the SCHEMA default, which need not
 * be the value in effect (the schema default for `rescanMinutes` is 5, for
 * `backfillOnStart` true). A write naming one field would therefore retune
 * every other knob in silence — the import of a file that only turns the plugin
 * off must not reset the rescan interval.
 *
 * Fields the patch does not name keep their current effective value (`live`,
 * the volatile references snapshotted), and a field cleared with `null` falls
 * back to the layer value (`inherited`), or is dropped entirely when no layer
 * sets it, which is the one case where the schema default IS the deployment
 * value.
 *
 * @param current - the raw config the entry currently carries.
 * @param inherited - the config the composing layers alone yield.
 * @param patch - the write to apply.
 * @param live - the current effective values.
 * @returns the complete config object for the profile row.
 */
export function projectUsageConfig(
  current: Readonly<Record<string, unknown>>,
  inherited: Readonly<Record<string, unknown>>,
  patch: UsageConfigPatch,
  live: Readonly<Record<string, number | boolean | readonly UsagePrice[]>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  for (const field of USAGE_CONFIG_FIELDS) {
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
    log(`usage user config: unreadable JSON, nothing to import: ${(error as Error).message}`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('usage user config: expected a JSON object, nothing to import')
    return undefined
  }
  return parsed as Record<string, unknown>
}

/** The price table of the retired file: valid rows, malformed ones logged. */
function readPricing(value: unknown, log: (message: string) => void): readonly UsagePrice[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    log('usage user config: "pricing" must be an array, ignored')
    return undefined
  }
  const pricing: UsagePrice[] = []
  for (const entry of value) {
    const price = asPrice(entry)
    if (price === undefined) log('usage user config: dropping a malformed pricing row')
    else pricing.push(price)
  }
  return pricing
}

/**
 * Read the retired JSON store (`<storeDir>/config.json`) for the one-time
 * import into the declarative config.
 *
 * Only the fields that file actually fed are imported: `enabled` (the
 * coexistence exit valve) and `pricing` (the price extension point).
 * `backfillOnStart` and `rescanMinutes` were never read from it — the loader
 * entry carried them — so a value written there by hand never took effect and
 * is not promoted now.
 *
 * Reads degrade: an absent, malformed or unreadable file yields `undefined`
 * (nothing to import, nothing to rename), and a value a field cannot hold is
 * logged and dropped rather than failing a boot.
 *
 * @param path - absolute path of `<storeDir>/config.json`.
 * @param log - diagnostic logger for degradations.
 * @returns the values worth importing, or undefined when the file is unusable.
 */
export function readRetiredUsageConfig(path: string, log: (message: string) => void): UsageConfigPatch | undefined {
  const obj = readRawConfig(path, log)
  if (obj === undefined) return undefined
  const imported: Record<string, number | boolean | readonly UsagePrice[] | null> = {}
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') imported.enabled = obj.enabled
    else log('usage user config: "enabled" must be a boolean, ignored')
  }
  const pricing = readPricing(obj.pricing, log)
  if (pricing !== undefined) imported.pricing = pricing
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
export function retireUsageConfigFile(path: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const retired = `${path}.imported-${stamp}`
  try {
    renameSync(path, retired)
    return retired
  } catch {
    return undefined
  }
}
