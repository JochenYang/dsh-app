/**
 * Every script the repository runs must PARSE.
 *
 * Why this exists, measured 2026-09-29: a comment added inside a template literal
 * in `scripts/probe-settings-nav.cjs` broke that file at LOAD time. Because the
 * probe runs under Electron's main process, the failure did not look like a tool
 * error at all — Electron showed a native "A JavaScript error occurred in the
 * main process" dialog on the author's desktop, which is what reached the user.
 * Nothing had looked at the file's syntax in between: the probe is hand-run, it
 * is not imported by any test, and the repository rule it violated ("no backticks
 * inside template-literal CSS/scripts", root AGENTS.md §5) is about two specific
 * shell strings rather than about this class.
 *
 * `node --check` parses a file WITHOUT executing it, and picks module vs script by
 * extension and `package.json` `type` — the same decision node itself makes, so
 * this gate cannot disagree with what running the file would see.
 *
 * @module dsh-app/tests/script-syntax
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_DIR = path.join(ROOT, 'scripts')
const EXTENSIONS = new Set(['.mjs', '.cjs', '.js'])

/** Every runnable script under `scripts/`, recursively. */
function scriptFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...scriptFiles(full))
    else if (EXTENSIONS.has(path.extname(entry.name))) found.push(full)
  }
  return found.sort()
}

test('every script under scripts/ parses', () => {
  const files = scriptFiles(SCRIPT_DIR)
  // A walker that finds nothing is a green gate that measures nothing. Pin two
  // files that must be in the set — one CJS probe, one ESM build script.
  const relative = files.map((file) => path.relative(ROOT, file).replaceAll('\\', '/'))
  assert.ok(relative.includes('scripts/probe-settings-nav.cjs'), 'the walker reaches the CJS probes')
  assert.ok(relative.includes('scripts/build-runtime.mjs'), 'the walker reaches the ESM build scripts')

  const broken = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      const first = `${result.stderr ?? ''}${result.stdout ?? ''}`.split('\n').find((line) => line.trim() !== '') ?? 'no diagnostic'
      broken.push(`${path.relative(ROOT, file).replaceAll('\\', '/')}: ${first.trim()}`)
    }
  }
  assert.deepEqual(broken, [], `these scripts do not parse, so running them fails before any of their own code (an Electron one shows a native error dialog instead): ${broken.join(' | ')}`)
})
