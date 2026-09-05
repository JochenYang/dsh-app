/**
 * User-side runtime configuration: an optional `config.json` inside the
 * store directory (`$DSH_HOME/storages/dsh-app-plugin-swarm/config.json`).
 *
 * The desktop shell rewrites the loader overlay on every server start, so
 * edits to the patch layer do not stick — this file is the user's tuning
 * point instead. Every field is optional and overrides the overlay value:
 *
 *   { "enabled": true,
 *     "defaultConcurrency": 8, "maxConcurrency": 16, "maxItems": 64,
 *     "startStaggerMs": 1000, "itemMaxRetries": 2, "itemRetryDelayMs": 15000,
 *     "perItemOutputLimit": 4000, "tokenBudget": 0, "adaptive": true }
 *
 * Reads degrade to the overlay value with a warning, never a boot failure.
 * Writes come from the settings-page routes (`POST .../config`): they are
 * validated against the same rules, merged into the file, and written
 * atomically (tmp + rename). Scheduling fields apply to the NEXT swarm call
 * (the tool re-reads this file per execution); `enabled` needs a restart.
 *
 * @module @dsh-app/plugin-swarm/user-config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIN_ITEMS } from './expand.ts'

/** Validated user overrides; absent fields inherit the overlay config. */
export interface SwarmUserConfig {
  readonly enabled?: boolean
  readonly defaultConcurrency?: number
  readonly maxConcurrency?: number
  readonly maxItems?: number
  readonly startStaggerMs?: number
  readonly itemMaxRetries?: number
  readonly itemRetryDelayMs?: number
  readonly perItemOutputLimit?: number
  readonly tokenBudget?: number
  readonly adaptive?: boolean
}

/** Numeric overridable fields. */
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

/** Boolean overridable fields. */
const BOOLEAN_FIELDS = ['enabled', 'adaptive'] as const

/** Every overridable field name (routes validate unknown keys against this). */
export const SWARM_CONFIG_FIELDS: readonly string[] = [...NUMERIC_FIELDS, ...BOOLEAN_FIELDS]

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

/**
 * Validate one field value.
 * @returns the normalized value, or undefined plus a reason when invalid.
 */
function validateField(field: string, value: unknown): { ok: true, value: number | boolean } | { ok: false, reason: string } {
  if ((BOOLEAN_FIELDS as readonly string[]).includes(field)) {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, reason: `"${field}" must be a boolean` }
  }
  const minimum = FIELD_MINIMUMS[field as (typeof NUMERIC_FIELDS)[number]] ?? 0
  if (typeof value === 'number' && Number.isFinite(value) && value >= minimum) {
    return { ok: true, value: Math.floor(value) }
  }
  return { ok: false, reason: `"${field}" must be a number >= ${minimum}` }
}

/** Validation failure of a settings-page write (routes map it to 400). */
export class SwarmConfigValidationError extends Error {}

/** Parse the raw file content into an object, or undefined when unusable. */
function readRawConfig(path: string, log: (message: string) => void): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined // missing file: the common case
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`swarm user config: unreadable JSON, using overlay values: ${(error as Error).message}`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('swarm user config: expected a JSON object, using overlay values')
    return undefined
  }
  return parsed as Record<string, unknown>
}

/**
 * Read and validate the user config file.
 * @param path - absolute path of `<storeDir>/config.json`.
 * @param log - diagnostic logger for degradations.
 * @returns the validated overrides; empty when absent or malformed.
 */
export function loadSwarmUserConfig(path: string, log: (message: string) => void): SwarmUserConfig {
  const obj = readRawConfig(path, log)
  if (obj === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const field of SWARM_CONFIG_FIELDS) {
    const value = obj[field]
    if (value === undefined) continue
    const result = validateField(field, value)
    if (result.ok) {
      out[field] = result.value
    } else {
      log(`swarm user config: ${result.reason}, ignored`)
    }
  }
  return out
}

/**
 * Merge a settings-page patch into the user config file and persist it
 * atomically. A field set to `null` clears that override (falls back to the
 * overlay value); unknown fields and invalid values reject the whole write
 * with a zh-CN message for the settings UI. Returns the full validated
 * override set after the write.
 */
export function writeSwarmUserConfig(path: string, patch: Record<string, unknown>): SwarmUserConfig {
  const keys = Object.keys(patch)
  for (const key of keys) {
    if (!SWARM_CONFIG_FIELDS.includes(key)) {
      throw new SwarmConfigValidationError(`未知配置项：${key}`)
    }
  }
  const current = readRawConfig(path, () => {}) ?? {}
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete current[field]
      continue
    }
    const result = validateField(field, value)
    if (!result.ok) {
      throw new SwarmConfigValidationError(`配置项 ${field} 的值不合法：${result.reason}`)
    }
    current[field] = result.value
  }
  // An empty (or all-already-absent) patch never touches the disk.
  if (keys.length === 0) {
    return loadSwarmUserConfig(path, () => {})
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return loadSwarmUserConfig(path, () => {})
}
