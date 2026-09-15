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
export function checkSuiteRoster(repoRoot, roster = SUITE_PLUGINS) {
  return roster
    .filter((name) => !existsSync(path.join(repoRoot, 'plugins', name.split('/').pop() ?? name, 'package.json')))
    .map((name) => `roster lists ${name}, but plugins/${name.split('/').pop() ?? name}/package.json does not exist (the overlay row would boot vanilla)`)
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
  const violations = [...checkPluginGraph(plugins, followed), ...checkSuiteRoster(repoRoot)]

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
