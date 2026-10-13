#!/usr/bin/env node
/**
 * Gate plugin directories: the type gate, the import gate, then the two artifact
 * checks.
 *
 * The release workflow's pre-build loop and the CI gate job call this once per
 * plugin, so the verdicts have exactly one implementation
 * (`scripts/lib/plugin-gates.mjs` and `scripts/lib/plugin-imports.mjs`) rather
 * than one per call site, and the roster stays in the loop that names it.
 *
 * Every caller runs it AFTER the plugin's own build (see that module's header for
 * why the order matters), so both artifact checks are meaningful here: `lib/` is
 * not older than its inputs, and `lib/` holds what the plugin's manifest declares.
 * The type gate is the one with a precondition — it needs the plugin's declared
 * peers installed, which the workflows' `npm install --legacy-peer-deps` does not
 * provide — so it SKIPS (loudly, and per plugin) rather than failing, and every run
 * ends with the count of skips.
 *
 * The import gate has no precondition at all: it reads `src/**` and the plugin's
 * own manifest, so it runs on a clean checkout, on a CI tree and on a developer's
 * machine alike.
 *
 * Usage:
 *   node scripts/plugin-gates.mjs <plugin-dir> [...]
 *
 * Example (inside plugins/, as the release loop runs it):
 *   node ../scripts/plugin-gates.mjs plugin-effort
 *
 * Exit: 0 every plugin passed what could run; 1 an artifact check, the import
 * gate, or a type gate that had its peers refused a plugin; 2 usage.
 *
 * @module scripts/plugin-gates
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { importGateSummary, assertPluginImports } from './lib/plugin-imports.mjs'
import {
  assertPluginLibFresh,
  assertPluginOutputs,
  runPluginTypecheck,
  typecheckSkipSummary,
} from './lib/plugin-gates.mjs'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('usage: node scripts/plugin-gates.mjs <plugin-dir> [...]')
  process.exit(2)
}

/**
 * npm beside the running node. On Windows a bare `npm.cmd` lets cmd.exe prefer a
 * same-named shim under the current directory, which is a plugin directory full
 * of node_modules — the same hijack build-runtime.mjs's npmBin() guards against.
 */
function npmBin() {
  return process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : 'npm'
}

/**
 * Run npm in `cwd`, failing the process on a non-zero exit.
 *
 * One code path for both platforms: Node 22.12+ no longer wraps `.cmd` through
 * cmd.exe implicitly (CVE-2024-27980), so the command is passed as a single
 * quoted line to an explicit shell. Every argument here is a literal this file
 * chose, and they are still quoted so a path with spaces cannot split.
 */
function runNpm(args, cwd) {
  const line = [npmBin(), ...args].map((value) => `"${value.replace(/"/g, '\\"')}"`).join(' ')
  execFileSync(line, { cwd, stdio: 'inherit', shell: true, windowsHide: true })
}

let skippedTypechecks = 0
let checkedImports = 0
const typesOnlyPackages = new Set()
for (const target of targets) {
  const pluginDir = path.resolve(target)
  const name = path.basename(pluginDir)
  const typecheck = runPluginTypecheck(pluginDir, { runNpm })
  if (typecheck.skipped) skippedTypechecks += 1
  // No precondition, no skip: the plugin's own sources and its own manifest.
  const imports = assertPluginImports(pluginDir)
  checkedImports += imports.checked
  for (const pkg of imports.typesOnly) typesOnlyPackages.add(pkg)
  assertPluginLibFresh(pluginDir)
  const outputs = assertPluginOutputs(pluginDir)
  // What was actually measured, so this line cannot read as "the artifact is
  // fine" for a plugin that produced nothing: with no lib/ and no declared lib
  // output there is nothing to be current about.
  const artifact = outputs.libExists
    ? `lib/ present (${outputs.libFiles} file(s)), not older than its own inputs`
    : 'no lib/ output declared by this plugin'
  // The type verdict says which one happened — a skipped gate must never be
  // reported as a passed one, and its detail line above names the missing peers.
  const verdict = typecheck.skipped ? 'type gate skipped (declared peers missing)' : 'type gate passed'
  console.log(`[plugin-gate] ${name}: ${verdict}; ${String(imports.checked)} import(s) declared; ${artifact}`)
}
// One line per run, even when nothing was skipped: "0 of 18" is the only
// statement that a green log can be read as full type coverage.
console.log(typecheckSkipSummary(targets.length, skippedTypechecks))
console.log(importGateSummary(targets.length, checkedImports, [...typesOnlyPackages].sort()))
