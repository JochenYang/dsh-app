import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Kernel child-process environment scrubbing (opt-in, zero behavior by
 * default).
 *
 * A packaged desktop launch starts from a naturally clean environment, but a
 * dev run or a launch from a terminal inherits the whole shell session —
 * including credential variables left over from other projects. The kernel's
 * bash tool sessions can surface those to the model and to tool-output logs.
 * This module lets the user opt into removing variables by NAME pattern
 * before the kernel is spawned.
 *
 * Config: `dsh-app-env-scrub.json` under userData, e.g.
 *
 *     { "removePatterns": ["^MY_OLD_PROJECT_", ".*_TOKEN$"] }
 *
 * Patterns are JavaScript regex source strings matched against variable
 * NAMES only (never values). A missing file or an empty list removes
 * nothing — the default — because user-configured MCP servers may
 * legitimately depend on inherited variables (e.g. GITHUB_TOKEN). RISK: a
 * removed variable is invisible to the kernel process AND to every MCP
 * child it spawns, so an over-broad pattern can break an existing
 * installation; enabling this is an explicit user choice.
 */

/** Config file name under userData. */
const ENV_SCRUB_FILE = 'dsh-app-env-scrub.json'

/** Upper bound on accepted patterns so a bloated config cannot slow every boot. */
const MAX_PATTERNS = 50

/**
 * Variables kept even when a pattern matches. The kernel child and its tool
 * sessions cannot function without these: PATH/SYSTEMROOT/TEMP/TMP keep
 * process spawning and temp files working, APPDATA/LOCALAPPDATA/
 * USERPROFILE/HOMEDRIVE/HOMEPATH locate the user profile (npm/pnpm/git and
 * the dsh credential store resolve the home dir through them), HOME keeps
 * the same resolution working on macOS/Linux, and COMSPEC/PATHEXT/
 * SYSTEMDRIVE keep Windows shell derivation alive. DSH_* carries the app's
 * own wiring (DSH_HOME, DSH_APP_*). Compared case-insensitively because
 * Windows env keys keep their authored case.
 */
const PROTECTED_KEYS = new Set([
  'PATH',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'COMSPEC',
  'PATHEXT',
])

export interface EnvScrubConfig {
  removePatterns: RegExp[]
}

/**
 * Load and validate the scrub config. A missing file is the default
 * zero-behavior state (silent); a present-but-broken file degrades to empty
 * with one `[kernel]` warning, and invalid entries are skipped individually
 * — a broken config must never fail a boot. The empty string is rejected
 * too: `new RegExp('')` matches every name, which is almost certainly a
 * typo with maximal destructive effect.
 */
export async function loadEnvScrubConfig(userDataDir: string): Promise<EnvScrubConfig> {
  const file = path.join(userDataDir, ENV_SCRUB_FILE)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { removePatterns: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[kernel] env-scrub config is not valid JSON; ignoring (${ENV_SCRUB_FILE})`)
    return { removePatterns: [] }
  }

  const entries = typeof parsed === 'object' && parsed !== null
    ? (parsed as { removePatterns?: unknown }).removePatterns
    : undefined
  if (!Array.isArray(entries)) {
    console.warn(`[kernel] env-scrub config malformed; ignoring (${ENV_SCRUB_FILE})`)
    return { removePatterns: [] }
  }

  if (entries.length > MAX_PATTERNS) {
    console.warn(`[kernel] env-scrub config exceeds ${MAX_PATTERNS} patterns; extra entries ignored`)
  }
  const patterns: RegExp[] = []
  for (const entry of entries.slice(0, MAX_PATTERNS)) {
    if (typeof entry !== 'string' || entry === '') {
      console.warn('[kernel] env-scrub pattern is not a non-empty string; skipped')
      continue
    }
    try {
      patterns.push(new RegExp(entry))
    } catch {
      console.warn(`[kernel] env-scrub pattern is not a valid regex; skipped: ${entry}`)
    }
  }
  return { removePatterns: patterns }
}

/**
 * Copy `env` without the variables whose names match any pattern. Protected
 * keys (see {@link PROTECTED_KEYS}) survive a direct match; DSH_* is kept
 * for the same reason. Matching is by name only — values are never read,
 * logged, or emitted.
 *
 * @returns a fresh copy with matches removed (the input object is never
 * mutated) plus the removed variable names in encounter order.
 */
export function scrubEnvironment(env: NodeJS.ProcessEnv, patterns: RegExp[]): { env: NodeJS.ProcessEnv; removed: string[] } {
  const removed: string[] = []
  const result: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    const protectedKey = PROTECTED_KEYS.has(upper) || upper.startsWith('DSH_')
    if (!protectedKey && patterns.some((pattern) => pattern.test(key))) {
      removed.push(key)
      continue
    }
    result[key] = env[key]
  }
  return { env: result, removed }
}
