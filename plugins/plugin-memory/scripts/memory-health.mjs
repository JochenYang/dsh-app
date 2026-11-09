#!/usr/bin/env node
/**
 * Read-only health audit of a memory root: one line per project store, then a
 * total. See `src/health.ts` for every metric's definition — this file only
 * resolves arguments, bundles that module and prints.
 *
 *   node plugins/plugin-memory/scripts/memory-health.mjs --root <dir> [--snapshot] [--json]
 *
 * `--snapshot` prepends the frozen anchor line (timestamp, card count, content
 * fingerprint). The store is LIVE: a card written between two runs moves the
 * numbers, so any before/after comparison has to quote the anchor it compared.
 *
 * There is no `--fix` on purpose: the audit answers "how bad is it", and the
 * one repair that exists (index reconciliation) belongs to the plugin's own
 * mount and `/status`, where it runs against a store it is responsible for.
 *
 * A missing root is a legitimate state (a kernel that never saved anything),
 * not an error: `auditRoot()` answers zero rows either way, so `--json` stays
 * valid JSON and `--snapshot` still pins `cards=0` with a fingerprint. Branching
 * early on `existsSync` here printed a comment instead, which broke both
 * modes for the one caller most likely to be scripting this.
 *
 * Why the source is bundled first: the metrics live in TypeScript next to the
 * code that also serves them, and a second JavaScript copy would be exactly the
 * drifting duplicate this audit exists to catch. The bundle is written under
 * `.test-dist/` (gitignored), the same place `scripts/test.mjs` builds into.
 */
import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

function fail(message) {
  process.stderr.write(`memory-health: ${message}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
let rootDir = ''
let snapshot = false
let json = false
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--snapshot') snapshot = true
  else if (arg === '--json') json = true
  else if (arg === '--root') {
    rootDir = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--root=')) rootDir = arg.slice('--root='.length)
  else fail(`unknown argument "${arg}"; usage: --root <dir> [--snapshot] [--json]`)
}
if (rootDir === '') fail('--root <dir> is required (the memory root, not a project store)')
rootDir = resolve(rootDir)

const outDir = join(pluginRoot, '.test-dist')
const bundle = join(outDir, 'memory-health.bundle.mjs')
mkdirSync(outDir, { recursive: true })
buildSync({
  entryPoints: [join(pluginRoot, 'src', 'health.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { auditRoot, formatHealthTable } = await import(pathToFileURL(bundle).href)

const audit = auditRoot(rootDir)
process.stdout.write(`${json ? JSON.stringify(audit, null, 2) : formatHealthTable(audit, snapshot)}\n`)
