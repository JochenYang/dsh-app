// Type-escape ratchet. The kernel line moves underneath this suite, and
// `as unknown as` bypasses the type gate: a kernel-deleted API leaves the
// compile green and fails at runtime (AGENTS.md §5/§6 name this the standing
// upgrade risk). There is no compile-time gate for an escape that is already
// written, so the count is pinned instead: it may go DOWN as call sites are
// narrowed, and any increase fails this test until someone reviews why.
//
// The baseline below is the count on the tree that introduced the ratchet.
// Lowering an entry is a real improvement; raising one must be a deliberate,
// reviewed edit to this file — never an incidental one.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** plugin name -> ceiling on `as unknown as` occurrences under its src/. */
const BASELINE = {
  'plugin-archives': 1,
  'plugin-brand': 0,
  'plugin-client-ui': 1,
  'plugin-effort': 0,
  'plugin-hooks': 2,
  'plugin-market': 1,
  'plugin-mcp': 1,
  'plugin-memory': 24,
  // 10: the pdf_edit tool answers a summary whose readonly arrays cannot be
  // assigned to JsonValue directly, so the one boundary cast follows the same
  // `as unknown as JsonValue` shape every other tool in this file already uses
  // (pdf_read, pdf_render and pdf_write each carry one). Narrowing it would mean
  // making the summary arrays mutable purely to satisfy the wire type.
  'plugin-pdf': 10,
  'plugin-ppt': 12,
  'plugin-presets': 0,
  'plugin-rewind': 0,
  'plugin-sidebar': 2,
  'plugin-swarm': 4,
  'plugin-usage': 0,
  'plugin-websearch': 0,
  'plugin-workbench': 0,
  // Three, each a boundary this package genuinely cannot type:
  //   - two `node:sqlite` casts: a row is `Record<string, SQLOutputValue>`, which
  //     shares no structural overlap with the column record. Both statements name
  //     their columns explicitly, and SCHEMA_VERSION guards a change to either.
  //   - `ctx.get('sessions')` in the client half: the concrete service face is
  //     declared by a package this plugin does not depend on, so the file narrows
  //     it to the one accessor it reads (`list.getSnapshot().byId[id].cwd`, the
  //     same accessor upstream uses). `plugin-sidebar` holds the identical cast
  //     for the identical reason.
  'plugin-codegraph': 3,
}

/** Every source file under a plugin's src/, recursively. */
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

test('as unknown as counts stay at or below the ratchet baseline', () => {
  const pluginsDir = path.join(ROOT, 'plugins')
  const onDisk = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
    .map((entry) => entry.name)
  // A roster entry with no baseline would sail past this test unchecked.
  for (const name of onDisk) {
    assert.ok(BASELINE[name] !== undefined || !statSync(path.join(pluginsDir, name, 'src')).isDirectory(),
      `${name} has a src/ tree but no baseline entry — add one after reviewing its escapes`)
  }
  for (const [plugin, ceiling] of Object.entries(BASELINE)) {
    const files = sourceFiles(path.join(pluginsDir, plugin, 'src'))
    const hits = []
    for (const file of files) {
      // The shared quote-aware stripper: comments are prose about escapes, not
      // escapes, and a glob string like '**/*.ts' must not be read as one.
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, index) => {
        for (const _ of line.match(/as unknown as/g) ?? []) hits.push(`${path.relative(ROOT, file)}:${String(index + 1)}`)
      })
    }
    assert.ok(hits.length <= ceiling,
      `${plugin} holds ${String(hits.length)} \`as unknown as\` (baseline ${String(ceiling)}):\n${hits.join('\n')}\n`
      + 'Narrow the call site, or lower the escape to one reviewed boundary; raising the baseline is a deliberate edit.')
  }
})

test('no `as any` anywhere in the suite source', () => {
  // The whole suite routes its escapes through the double assertion, so one
  // grep rule covers 100% of them — this asserts the shape stays that way.
  const pluginsDir = path.join(ROOT, 'plugins')
  const hits = []
  for (const name of Object.keys(BASELINE)) {
    for (const file of sourceFiles(path.join(pluginsDir, name, 'src'))) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '')
        if (/\bas any\b/.test(code)) hits.push(`${path.relative(ROOT, file)}:${String(index + 1)}`)
      })
    }
  }
  assert.deepEqual(hits, [])
})
