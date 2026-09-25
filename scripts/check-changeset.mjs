#!/usr/bin/env node
/**
 * The changeset gate, in its two modes.
 *
 *   node scripts/check-changeset.mjs --base <git-ref>
 *       Gate mode: the diff <ref>...HEAD must carry a changeset fragment when
 *       it touches a releasable path. Runs in ci.yml on every push and PR.
 *
 *   node scripts/check-changeset.mjs --tag v0.14.0
 *       Tag mode: the version must already have a bilingual CHANGELOG section.
 *       Runs in release.yml's prepare-release job, before the draft exists, so
 *       an empty release page (v0.13.2) fails the tag instead of shipping.
 *
 * Exit 0 = pass, 1 = fail with an actionable message, 2 = bad invocation.
 *
 * @module dsh-app/scripts/check-changeset
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHANGESET_DIR,
  decide,
  isChangesetFile,
  parseFragment,
  sectionBullets,
} from './lib/changeset.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Run git in the repository.
 *
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

/**
 * Repository-relative paths changed since a ref.
 *
 * @param {string} base - the git ref to diff against.
 * @returns {string[]} the changed paths.
 */
function changedSince(base) {
  const output = git(['diff', '--name-only', `${base}...HEAD`])
  return output === '' ? [] : output.split('\n')
}

function fail(message) {
  console.error(`changeset gate: ${message}`)
  process.exit(1)
}

function main() {
  const args = process.argv.slice(2)
  const baseIndex = args.indexOf('--base')
  const tagIndex = args.indexOf('--tag')

  if (baseIndex !== -1 && tagIndex !== -1) {
    console.error('usage: check-changeset.mjs --base <git-ref> | --tag <tag>')
    process.exit(2)
  }

  if (tagIndex !== -1) {
    const tag = args[tagIndex + 1]
    const version = /^v?(\d+\.\d+\.\d+)$/.exec(tag ?? '')?.[1]
    if (version === undefined) {
      console.error(`usage: check-changeset.mjs --tag vX.Y.Z (got "${tag ?? ''}")`)
      process.exit(2)
    }
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
    const bullets = sectionBullets(changelog, version)
    if (bullets.zh.length === 0 || bullets.en.length === 0) {
      fail(`CHANGELOG.md has no bilingual section for v${version} — fold the fragments (node scripts/fold-changesets.mjs ${version}) and commit before tagging`)
    }
    console.log(`changeset gate: v${version} has ${bullets.zh.length} zh / ${bullets.en.length} en bullets`)
    return
  }

  if (baseIndex === -1) {
    console.error('usage: check-changeset.mjs --base <git-ref> | --tag <tag>')
    process.exit(2)
  }

  const base = args[baseIndex + 1]
  if (base === undefined || base === '') {
    console.error('usage: check-changeset.mjs --base <git-ref> | --tag <tag>')
    process.exit(2)
  }

  const changed = changedSince(base)
  const { releasable, hasFragment } = decide(changed)

  for (const file of changed.filter(isChangesetFile)) {
    try {
      parseFragment(readFileSync(path.join(root, file), 'utf8'), file)
    } catch (error) {
      fail(`${error instanceof Error ? error.message : String(error)} — see ${CHANGESET_DIR}/README.md`)
    }
  }

  if (releasable.length > 0 && !hasFragment) {
    fail(`releasable changes without a changeset fragment:\n${releasable.map((file) => `  ${file}`).join('\n')}\nAdd ${CHANGESET_DIR}/<name>.md in the same commit — see ${CHANGESET_DIR}/README.md`)
  }

  console.log(`changeset gate: ${releasable.length} releasable path(s), fragment ${hasFragment ? 'present' : 'not needed'}`)
}

main()
