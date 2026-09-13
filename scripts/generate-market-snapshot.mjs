#!/usr/bin/env node
// One-shot maintenance tool: regenerate the market plugin's bundled offline
// catalog snapshot (plugins/plugin-market/src/catalog-snapshot.json) from the
// primary awesome directory source.
//
//   node scripts/generate-market-snapshot.mjs
//
// The selection/truncation rules live in the plugin's
// src/snapshot-builder.ts (imported here via Node's TS transform) so the
// committed artifact and the tests exercise the exact same code path — this
// script only adds the network fetch and the atomic file write.
//
// Re-runnable any time the upstream directory meaningfully changes; the
// snapshot is a disaster-recovery fallback, not a mirror (top 500 by stars,
// 140-char descriptions, ~a few hundred KB).
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The plugin sources use constructor parameter properties, which plain
// type-stripping rejects — re-exec once with the transform-enabled flag.
if (!process.execArgv.some(flag => flag.includes('transform-types'))) {
  const rerun = spawnSync(
    process.execPath,
    ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(rerun.status ?? 1)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const targetPath = join(repoRoot, 'plugins', 'plugin-market', 'src', 'catalog-snapshot.json')

const { DEFAULT_SOURCE_URL } = await import('../plugins/plugin-market/src/catalog.ts')
const { buildSnapshotDocument, SNAPSHOT_ENTRY_LIMIT } = await import(
  '../plugins/plugin-market/src/snapshot-builder.ts'
)

const FETCH_TIMEOUT_MS = 60_000
const MAX_BYTES = 16_000_000

const response = await fetch(DEFAULT_SOURCE_URL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
if (!response.ok) {
  console.error(`source answered HTTP ${response.status}`)
  process.exit(1)
}
const body = (await response.text()).slice(0, MAX_BYTES)
const source = JSON.parse(body)

const document = buildSnapshotDocument(source, { sourceUrl: DEFAULT_SOURCE_URL })
const rendered = `${JSON.stringify(document, null, 2)}\n`

// Atomic write (tmp + rename) so an interrupted run never leaves a truncated
// snapshot behind for the bundler to pick up.
mkdirSync(dirname(targetPath), { recursive: true })
const tmp = `${targetPath}.${process.pid}.tmp`
writeFileSync(tmp, rendered, 'utf8')
renameSync(tmp, targetPath)

const bytes = statSync(targetPath).size
const installable = document.plugins.filter(entry => entry.installable).length
console.log(`snapshot written: ${targetPath}`)
console.log(`entries: ${document.plugins.length}/${SNAPSHOT_ENTRY_LIMIT} (${installable} installable)`)
console.log(`size: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`)
console.log(`generatedAt: ${document.generatedAt}`)
if (bytes > 600 * 1024) {
  console.error('warning: snapshot exceeds the 600 KiB budget — tighten the caps')
  process.exit(1)
}
