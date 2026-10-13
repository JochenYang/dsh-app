#!/usr/bin/env node
/**
 * Gate plugin directories: the type gate, then the two artifact checks.
 *
 * The release workflow's pre-build loop and the CI gate job call this once per
 * plugin, so the verdicts have exactly one implementation
 * (`scripts/lib/plugin-gates.mjs`) rather than one per call site, and the roster
 * stays in the loop that names it.
 *
 * Every caller runs it AFTER the plugin's own build (see that module's header for
 * why the order matters), so all three checks are meaningful here: the source
 * type-checks, `lib/` is not older than its inputs, and `lib/` holds what the
 * plugin's manifest declares.
 *
 * Usage:
 *   node scripts/plugin-gates.mjs <plugin-dir> [...]
 *
 * Example (inside plugins/, as the release loop runs it):
 *   node ../scripts/plugin-gates.mjs plugin-effort
 *
 * Exit: 0 every plugin passed; 1 a check refused a plugin; 2 usage.
 *
 * @module scripts/plugin-gates
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { assertPluginLibFresh, assertPluginOutputs, runPluginTypecheck } from './lib/plugin-gates.mjs'

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

for (const target of targets) {
  const pluginDir = path.resolve(target)
  const name = path.basename(pluginDir)
  runPluginTypecheck(pluginDir, { runNpm })
  assertPluginLibFresh(pluginDir)
  const outputs = assertPluginOutputs(pluginDir)
  // What was actually measured, so this line cannot read as "the artifact is
  // fine" for a plugin that produced nothing: with no lib/ and no declared lib
  // output there is nothing to be current about.
  const artifact = outputs.libExists
    ? `lib/ present (${outputs.libFiles} file(s)), not older than its own inputs`
    : 'no lib/ output declared by this plugin'
  console.log(`[plugin-gate] ${name}: type gate passed; ${artifact}`)
}
