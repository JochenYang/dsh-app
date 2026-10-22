#!/usr/bin/env node
/**
 * The changeset gate, in its two modes.
 *
 *   node scripts/check-changeset.mjs --base <git-ref>
 *       Gate mode: every commit in <ref>..HEAD that touches a releasable path
 *       must carry a changeset fragment in the SAME commit. Runs in ci.yml on
 *       every push and PR.
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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHANGESET_DIR,
  addedVersions,
  decideCommits,
  isChangesetFile,
  nulRecords,
  parseFragment,
  parseNameStatus,
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
 * Git stdout that may contain arbitrary paths.
 *
 * Kept separate from {@link git} because trimming would eat a leading or trailing
 * newline inside a file name, and every caller here splits on NUL instead.
 *
 * @param {string[]} args - git arguments (`-z` is the caller's job).
 * @param {readonly string[]} fallback - stdout when git cannot answer (a root
 *   commit has no parent to diff against).
 * @returns {string} raw stdout.
 */
function gitRaw(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return fallback
  }
}

/**
 * The commits a push or PR adds, oldest first.
 *
 * @param {string} base - the git ref the range starts after.
 * @returns {string[]} commit shas.
 */
function commitsSince(base) {
  const output = git(['rev-list', '--reverse', `${base}..HEAD`])
  return output === '' ? [] : output.split('\n')
}

/**
 * One commit's changed paths and removals, read from a single `-z` diff.
 *
 * `-z` plus `-M` are both explicit: without `-z` git quotes non-ASCII paths and a
 * Chinese fragment name silently stops being recognised, and without a stated
 * rename policy the answer depends on the operator's git config.
 *
 * @param {string} commit - the commit sha.
 * @returns {{ paths: string[], deleted: string[] }} the changed paths and removals.
 */
function changesIn(commit) {
  // A root commit has no parent; nothing was changed "against" it.
  const output = gitRaw(['diff', '--name-status', '-M', '-z', `${commit}^`, commit])
  return parseNameStatus(nulRecords(output))
}

/**
 * The versions already in the parent commit's CHANGELOG.
 *
 * Used to keep a reorder or a reformat from looking like a new release: only a
 * heading the parent did NOT carry counts as added.
 *
 * @param {string} commit - the commit sha.
 * @returns {string[]} bare versions.
 */
function parentVersions(commit) {
  const text = gitRaw(['show', `${commit}^:CHANGELOG.md`])
  const versions = []
  for (const line of text.split('\n')) {
    const match = /^## \[v(\d+\.\d+\.\d+)\]/u.exec(line)
    if (match !== null) versions.push(match[1])
  }
  return versions
}

/**
 * The `[vX.Y.Z]` sections this commit ADDS to CHANGELOG.md.
 *
 * Read from the diff rather than the file: an added section is a release, while
 * editing an existing one is not (a later fix may legitimately correct a note).
 *
 * @param {string} commit - the commit sha.
 * @returns {string[]} versions added, in diff order.
 */
function addedVersionsOf(commit) {
  const diff = gitRaw(['diff', '--unified=0', '--no-color', '--no-ext-diff', `${commit}^`, commit, '--', 'CHANGELOG.md'])
  return addedVersions(diff, parentVersions(commit))
}

/**
 * The gate's context for one commit: what it released, if anything, and which
 * fragments it consumed.
 *
 * Deletions are reported for EVERY commit, not only the ones that add a section:
 * a path list cannot tell an added fragment from a deleted one, so the gate needs
 * that fact to avoid reading the fold's own cleanup as a declaration.
 *
 * @param {string} commit - the commit sha.
 * @param {readonly string[]} paths - its changed paths.
 * @returns {{ releasedVersion?: string, deletedPaths: string[] }} the context.
 */
function commitContext(commit, paths) {
  const { deleted } = changesIn(commit)
  const deletedPaths = deleted.filter(isChangesetFile)
  if (!paths.includes('CHANGELOG.md')) return { deletedPaths }
  const versions = addedVersionsOf(commit)
  if (versions.length === 0) return { deletedPaths }
  return { releasedVersion: versions[0], deletedPaths }
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

  // Per commit, not per push: the fragment must travel in the SAME commit as
  // the change, and a release push adds the fragment in one commit and
  // consumes it in the next — an endpoint diff of the whole push sees neither
  // and would fail a release that followed the rule (measured on v0.14.1's
  // push; the pure decision lives in decideCommits, tested against that shape).
  const commits = commitsSince(base).map((sha) => {
    // One diff per commit answers both questions, which keeps the process count
    // down on a long push and keeps the two answers from disagreeing.
    const changes = changesIn(sha)
    return { sha, paths: changes.paths, context: commitContext(sha, changes.paths) }
  })

  const problems = []
  for (const commit of commits) {
    for (const file of commit.paths.filter(isChangesetFile)) {
      const full = path.join(root, file)
      // A deletion (the release commit consuming the fragments) was validated
      // when it was added; only what the tree still holds can be parsed.
      if (!existsSync(full)) continue
      try {
        parseFragment(readFileSync(full, 'utf8'), file)
      } catch (error) {
        problems.push(`${commit.sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)} — see ${CHANGESET_DIR}/README.md`)
      }
    }
  }

  for (const { sha, releasable } of decideCommits(commits)) {
    problems.push(`${sha.slice(0, 7)}: releasable changes without a changeset fragment:\n${releasable.map((file) => `    ${file}`).join('\n')}`)
  }

  if (problems.length > 0) {
    fail(`${problems.join('\n')}\nAdd ${CHANGESET_DIR}/<name>.md in the same commit — see ${CHANGESET_DIR}/README.md`)
  }

  console.log(`changeset gate: every commit since ${base.slice(0, 7)} carries its declaration`)
}

main()
