/**
 * User-side runtime configuration: an optional `config.json` inside the
 * store directory.
 *
 * The desktop shell's loader overlay is the last patch layer, so no user
 * patch layer can reach this plugin entry's own config. This file is the
 * user's extension point instead:
 *
 *   { "enabled": false,
 *     "pricing": [ { "provider": "...", "model": "...", "input": 1.5,
 *                    "output": 4.5, "cacheRead": 0.05, "cacheWrite": 1.5,
 *                    "peakFactor": 2 } ] }
 *
 * `enabled: false` is the coexistence exit valve — a user who prefers their
 * own third-party usage plugin runs only that one. `pricing` rows (CNY ¥
 * per 1M tokens) override or extend the built-in price table, e.g. for
 * personal gateway providers the product cannot price by default.
 * `peakFactor` (default 1) multiplies every rate during DeepSeek peak
 * hours (weekdays 9:00-12:00 & 14:00-18:00 Beijing time); set 2 for
 * dual-tier-billed models, omit for flat pricing.
 *
 * The file is external input: anything malformed degrades to defaults with
 * a warning, never a boot failure. Changes take effect on restart.
 *
 * @module @dsh-app/plugin-usage/user-config
 */

import { readFileSync } from 'node:fs'
import type { UsagePrice } from './types.ts'

/** Validated user config. */
export interface UserConfig {
  /** false → the plugin mounts nothing but its status route. */
  enabled: boolean
  /** Price rows merged over the loader-entry config's table. */
  pricing: UsagePrice[]
}

/** What a missing file (the common case) resolves to. */
const DEFAULTS: UserConfig = { enabled: true, pricing: [] }

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asPrice(value: unknown): UsagePrice | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const provider = asString(row.provider)
  const model = asString(row.model)
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
 * Read and validate the user config file.
 * @param path - absolute path of `<storeDir>/config.json`.
 * @param log - diagnostic logger for degradations.
 * @returns the validated config; defaults when absent or malformed.
 */
export function loadUserConfig(path: string, log: (message: string) => void): UserConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return DEFAULTS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`usage user config: unreadable JSON, using defaults: ${(error as Error).message}`)
    return DEFAULTS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    log('usage user config: expected a JSON object, using defaults')
    return DEFAULTS
  }
  const obj = parsed as Record<string, unknown>
  const enabled = obj.enabled === undefined ? true : obj.enabled
  if (typeof enabled !== 'boolean') {
    log('usage user config: "enabled" must be a boolean, using defaults')
    return DEFAULTS
  }
  const pricing: UsagePrice[] = []
  if (obj.pricing !== undefined) {
    if (!Array.isArray(obj.pricing)) {
      log('usage user config: "pricing" must be an array, ignored')
    } else {
      for (const entry of obj.pricing) {
        const price = asPrice(entry)
        if (price === undefined) {
          log('usage user config: dropping a malformed pricing row')
        } else {
          pricing.push(price)
        }
      }
    }
  }
  return { enabled, pricing }
}
