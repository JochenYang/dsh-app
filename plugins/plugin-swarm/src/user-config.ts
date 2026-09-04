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
 * The file is external input: anything malformed degrades to the overlay
 * value with a warning, never a boot failure. Changes take effect on
 * restart.
 *
 * @module @dsh-app/plugin-swarm/user-config
 */

import { readFileSync } from 'node:fs'
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

/** Numeric fields validated as positive (or zero) integers. */
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

/**
 * Fields with a semantic floor: the loader's `>= 0` check is not enough —
 * a 0 here would merge into the effective config and trip the plugin's
 * load-time assertions (maxItems ≥ 2, concurrency ≥ 1).
 */
const FIELD_MINIMUMS: Partial<Record<(typeof NUMERIC_FIELDS)[number], number>> = {
  defaultConcurrency: 1,
  maxConcurrency: 1,
  maxItems: MIN_ITEMS,
}

/**
 * Read and validate the user config file.
 * @param path - absolute path of `<storeDir>/config.json`.
 * @param log - diagnostic logger for degradations.
 * @returns the validated overrides; empty when absent or malformed.
 */
export function loadSwarmUserConfig(path: string, log: (message: string) => void): SwarmUserConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`swarm user config: unreadable JSON, using overlay values: ${(error as Error).message}`)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('swarm user config: expected a JSON object, using overlay values')
    return {}
  }
  const obj = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      out.enabled = obj.enabled
    } else {
      log('swarm user config: "enabled" must be a boolean, ignored')
    }
  }
  if (obj.adaptive !== undefined) {
    if (typeof obj.adaptive === 'boolean') {
      out.adaptive = obj.adaptive
    } else {
      log('swarm user config: "adaptive" must be a boolean, ignored')
    }
  }
  for (const field of NUMERIC_FIELDS) {
    const value = obj[field]
    if (value === undefined) continue
    const minimum = FIELD_MINIMUMS[field] ?? 0
    if (typeof value === 'number' && Number.isFinite(value) && value >= minimum) {
      out[field] = Math.floor(value)
    } else {
      log(`swarm user config: "${field}" must be a number >= ${minimum}, ignored`)
    }
  }
  return out
}
