#!/usr/bin/env node
// Static plugin-graph check: the rules a runtime boot can only fail at, and
// only on a user's machine.
//
// The runtime boots by linking/composing our plugins ON TOP of the kernel's own
// packages, so the graph is load-bearing in ways a build cannot see:
//
//   1. A `@deepseek-ai/*` or `@dsh-app/*` entry in `dependencies` makes the
//      installer pull a SECOND copy of a core package next to the kernel's. The
//      two copies have different module identity, so the plugin and the kernel
//      stop sharing state (the upstream desktop rejects the same shape with its
//      own graph validation).
//   2. Packaging `node_modules` freezes a platform-specific tree into a plugin
//      that is copied for every platform.
//   3. A `@deepseek-ai/dsh*` peer range that does not line up with the followed
//      kernel line is the "one edit moves the line" failure: moving the line
//      bumps the root and every plugin together, and a plugin left behind
//      fails at link time only when that plugin happens to load.
//   4. A suite roster entry with no package on disk is the fail-soft vanilla
//      boot: the overlay row exists, the package does not, and every suite page
//      silently disappears.
//
// Zero-dependency apart from the repo's own semver, no kernel and no network,
// so it belongs in the fast CI gate rather than the smoke job.
//
// Usage: node scripts/check-plugin-graph.mjs [--repo <dir>]
// Exit: 0 clean, 1 violations, 2 usage error.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { DSH_PACKAGE, SUITE_PLUGINS, followedSpec } from './kernel-line.mjs'
import { stripComments } from './lib/strip-comments.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const CORE_SCOPES = ['@deepseek-ai/', '@dsh-app/']
const PACKAGED_NODE_MODULES = /(^|\/)node_modules(\/|$)/u

/** True for the packages whose version must track the followed kernel line. */
const isDshLine = (name) => name === DSH_PACKAGE || name.startsWith(`${DSH_PACKAGE}-`)

/**
 * Apply every rule to one repository's plugins.
 * @param {Array<{ dir: string, manifest: Record<string, unknown> }>} plugins - suite plugins on disk.
 * @param {string} followed - the followed kernel-line spec, e.g. `^0.1.5-rc.2`.
 * @returns {string[]} human-readable violations, empty when the graph is sound.
 */
export function checkPluginGraph(plugins, followed) {
  const violations = []
  const followedFloor = semver.minVersion(followed) ?? semver.valid(followed)

  for (const { dir, manifest } of plugins) {
    const label = `plugins/${dir}`

    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (CORE_SCOPES.some((scope) => name.startsWith(scope))) {
        violations.push(`${label}: ${name}@${range} is a dependency; core packages must be peerDependencies so no second copy is installed`)
      }
    }

    const files = Array.isArray(manifest.files) ? manifest.files : []
    for (const entry of files) {
      if (typeof entry === 'string' && PACKAGED_NODE_MODULES.test(entry)) {
        violations.push(`${label}: files[] packages ${entry}; node_modules must never ship inside a plugin`)
      }
    }

    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!isDshLine(name)) continue
      // validRange (not minVersion) is the non-throwing form: minVersion THROWS
      // a TypeError on an unparseable range, which would take the whole check
      // down instead of reporting the offending plugin.
      if (semver.validRange(String(range)) === null) {
        violations.push(`${label}: ${name} has an unparseable peer range ${String(range)}`)
        continue
      }
      const floor = semver.minVersion(String(range))
      if (followedFloor !== null && (floor.major !== followedFloor.major || floor.minor !== followedFloor.minor || floor.patch !== followedFloor.patch)) {
        violations.push(`${label}: ${name}@${String(range)} does not track the followed line ${followed} — bump both in the same commit`)
      }
    }
  }

  return violations
}

/**
 * Every suite plugin named in the roster must exist on disk. The roster holds
 * package names (`@dsh-app/plugin-brand`); on disk each one is the directory
 * `plugins/plugin-brand`, so compare on the last path segment.
 */
/**
 * The on-disk directory a roster entry names.
 *
 * ONE normalizer for both directions: the forward check resolves a roster name
 * to its directory, the reverse check resolves a directory back to a name, and
 * two implementations of this rule would disagree about a name that is not
 * `plugin-`-prefixed (`@dsh-app/brand`).
 */
export function dirNameFor(packageName) {
  const short = packageName.split('/').pop() ?? packageName
  return short.startsWith('plugin-') ? short : `plugin-${short}`
}

export function checkSuiteRoster(repoRoot, roster = SUITE_PLUGINS) {
  return roster
    .filter((name) => !existsSync(path.join(repoRoot, 'plugins', dirNameFor(name), 'package.json')))
    .map((name) => `roster lists ${name}, but plugins/${dirNameFor(name)}/package.json does not exist (the overlay row would boot vanilla)`)
}

/**
 * The reverse direction: a plugin directory on disk that no roster carries.
 *
 * The forward check only proves the roster resolves; a NEW plugin builds and
 * tests green in CI (the `plugins/*` glob) yet never reaches the runtime — it
 * is not in the overlay, not in the link set, not in the artifact. The failure
 * is invisible everywhere except the user's UI, which simply lacks the feature.
 */
export function checkOnDiskRoster(repoRoot, roster = SUITE_PLUGINS) {
  const expected = new Set(roster.map(dirNameFor))
  const pluginsDir = path.join(repoRoot, 'plugins')
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(pluginsDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .filter((dir) => !expected.has(dir))
    .map((dir) => `plugins/${dir} is on disk but no roster carries it (add it to all five roster places in one commit, or it never ships)`)
}

/**
 * Han characters outside a plugin's own dictionary.
 *
 * Repository rule (AGENTS.md §4 / plugins/AGENTS.md §4): each plugin owns its
 * dictionary file and writes no Han characters anywhere else — the model-facing
 * zh-CN tool failures and the one declared exception in plugin-brand's routes
 * are the sanctioned cases. New prose drifting into a second place splits the
 * dictionary and starts a translation nobody can find, so the check enforces
 * the rule with an explicit allowlist instead of trusting review.
 *
 * @param {string} repoRoot - repository root.
 * @returns {string[]} violations, empty when no stray Han text is found.
 */
export function checkHanCharacters(repoRoot) {
  // Sanctioned locations. Entry forms: a file that IS the dictionary, a
  // directory whose whole contents are model-facing by declared design, or an
  // individual file with its reason. Anything not listed here must be Han-free.
  const DICTIONARY = /(^|\/)(locales?|zh-CN)\.tsx?$/u
  const ALLOWED_DIRS = [
    // The office four: every non-client module under these trees is the
    // model-facing layer by declared design — skill text, prompts, validation
    // reports and single actionable failure values are all zh-CN (each file's
    // JSDoc says so). `client/` is explicitly NOT covered: that is the UI
    // half, whose copy belongs in the plugin's own dictionary.
    'plugins/plugin-doc/src/',
    'plugins/plugin-pdf/src/',
    'plugins/plugin-ppt/src/',
    'plugins/plugin-sheet/src/',
  ]
  const ALLOWLIST = new Set([
    // plugin-brand's route labels: documented at routes.ts and in the file
    // header — user-facing picker labels with no dictionary to live in.
    'plugins/plugin-brand/src/routes.ts',
    // The cross-session memory's model-facing layer: the curator's prompt and
    // the failure values the tools relay.
    'plugins/plugin-memory/src/prompt.ts',
    'plugins/plugin-memory/src/curator.ts',
    'plugins/plugin-memory/src/llm-direct.ts',
    'plugins/plugin-memory/src/memory-store.ts',
    'plugins/plugin-memory/src/tools.ts',
    // The one shared card-text rule: it is copied into every model-facing
    // surface that asks for card text, and the rule itself names the Chinese
    // narration markers it bans ("本次…", "已修复…") — the same class of zh-CN
    // model-facing text as the files above. It was Han-free until that
    // sentence was added.
    'plugins/plugin-memory/src/card-discipline.ts',
    // The market parses pnpm's own stdout, which is Chinese on a Chinese
    // Windows; matching its wording is the function.
    'plugins/plugin-market/src/installer.ts',
    // plugin-swarm's /swarm command: the NATIVE conversation surface
    // (upstream's own chat view, which has no dictionary), not the branded
    // client UI. Known deviation from the HostText rule — tracked as a
    // follow-up to route it through the wire contract.
    'plugins/plugin-swarm/src/index.ts',
  ])
  const HAN = /[\u4e00-\u9fff]/u
  const violations = []
  for (const { dir } of readPlugins(repoRoot)) {
    for (const file of sourceFiles(path.join(repoRoot, 'plugins', dir, 'src'))) {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/')
      if (DICTIONARY.test(relative) || ALLOWLIST.has(relative)) continue
      // A directory allowance covers the model-facing files ONLY: the UI half
      // (`client/`) keeps the dictionary rule like every other plugin.
      if (ALLOWED_DIRS.some((prefix) => relative.startsWith(prefix) && !relative.slice(prefix.length).startsWith('client/'))) continue
      // Comments are outside the language rule; the shared stripper is
      // quote-aware and keeps line numbers (a glob like '**/*.ts' must not be
      // read as a comment start).
      const text = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/)
      text.forEach((line, index) => {
        if (HAN.test(line)) violations.push(`${relative}:${String(index + 1)} holds Han characters outside the dictionary: ${line.trim().slice(0, 60)}`)
      })
    }
  }
  return violations
}

/** Every TypeScript source file under `dir`, recursively. */
function sourceFiles(dir) {
  const found = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

/** Read every plugin manifest under plugins/ (a directory without one is skipped). */
export function readPlugins(repoRoot) {
  const pluginsDir = path.join(repoRoot, 'plugins')
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(pluginsDir, entry.name, 'package.json')))
    .map((entry) => ({
      dir: entry.name,
      manifest: JSON.parse(readFileSync(path.join(pluginsDir, entry.name, 'package.json'), 'utf8')),
    }))
}

function main() {
  const argv = process.argv.slice(2)
  const repoIndex = argv.indexOf('--repo')
  if (repoIndex !== -1 && argv[repoIndex + 1] === undefined) {
    console.error('usage: check-plugin-graph.mjs [--repo <dir>]')
    process.exitCode = 2
    return
  }
  const repoRoot = repoIndex === -1 ? root : path.resolve(argv[repoIndex + 1])

  const followed = followedSpec(repoRoot)
  const plugins = readPlugins(repoRoot)
  const violations = [
    ...checkPluginGraph(plugins, followed),
    ...checkSuiteRoster(repoRoot),
    ...checkOnDiskRoster(repoRoot),
    ...checkHanCharacters(repoRoot),
  ]

  console.log(`plugin graph: ${plugins.length} plugins, followed line ${followed}`)
  if (violations.length === 0) {
    console.log('ok — no violations')
    return
  }
  console.error(`\n${violations.length} violation(s):`)
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exitCode = 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
