#!/usr/bin/env node
/**
 * Fold the changeset fragments into the CHANGELOG at release time.
 *
 *   node scripts/fold-changesets.mjs 0.14.0 [--date YYYY-MM-DD]
 *
 * Assembles every fragment under changesets/ into a bilingual section above
 * the previous version, writes CHANGELOG.md, and deletes the consumed
 * fragments. The output is a DRAFT for the releaser to review and enrich —
 * the release checklist's ordering (version bump first, then this fold, then
 * commit) is unchanged; what changes is that the notes are assembled from
 * declarations made where each change landed instead of from memory.
 *
 * Exit 0 = folded, 1 = refused, 2 = bad invocation.
 *
 * @module dsh-app/scripts/fold-changesets
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANGESET_DIR, insertSection, readFragments, renderSection } from './lib/changeset.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const changelogPath = path.join(root, 'CHANGELOG.md')
const changesetDir = path.join(root, CHANGESET_DIR)

/**
 * Today's date in the machine's local timezone, `YYYY-MM-DD`.
 *
 * @returns {string} the local date.
 */
function localDate() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function main() {
  const args = process.argv.slice(2)
  const version = /^(\d+\.\d+\.\d+)$/.exec(args[0] ?? '')?.[1]
  if (version === undefined) {
    console.error('usage: fold-changesets.mjs <version> [--date YYYY-MM-DD]   e.g. fold-changesets.mjs 0.14.0')
    process.exit(2)
  }
  const dateIndex = args.indexOf('--date')
  const date = dateIndex === -1 ? localDate() : args[dateIndex + 1]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date must be YYYY-MM-DD, got "${date}"`)
    process.exit(2)
  }

  const fragments = readFragments(changesetDir)
  if (fragments.length === 0) {
    console.error(`fold-changesets: no fragments under ${CHANGESET_DIR}/ — nothing to fold (if the release really has no user-visible change, write the section by hand)`)
    process.exit(1)
  }

  const section = renderSection(version, date, fragments)
  const changelog = readFileSync(changelogPath, 'utf8')
  const updated = insertSection(changelog, section, version)

  writeFileSync(changelogPath, updated)
  for (const { name } of fragments) {
    // A fragment is one file the fold itself just consumed, so the plain
    // unlink is the whole delete — no tree, nothing a link can point out of.
    unlinkSync(path.join(changesetDir, name))
  }

  console.log(`fold-changesets: v${version} (${date}) from ${fragments.length} fragment(s):`)
  for (const { name, fragment } of fragments) {
    const plugins = fragment.plugins.length === 0 ? '' : ` [${fragment.plugins.join(', ')}]`
    console.log(`  ${name} (shell: ${fragment.shell})${plugins}`)
  }
  console.log('fold-changesets: CHANGELOG.md written, fragments consumed — review the section, then commit')
}

main()
