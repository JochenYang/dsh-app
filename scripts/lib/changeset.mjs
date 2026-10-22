/**
 * Changeset fragments: the release input, authored where the change lands.
 *
 * Why this exists: the release checklist's first question — "does a user on the
 * previous version actually RECEIVE this change?" — used to be answered at
 * release time, from the releaser's memory of the diff. Two release classes
 * were paid for exactly there: v0.12.5 (four plugins changed, no version
 * bumped, every installation kept the old plugin, all gates green) and v0.13.6
 * (a settings row moved, same silent nothing). A fragment makes the author
 * declare, in the same commit as the change, what reaches users and how — the
 * shape kimicode's @changesets/cli uses, without adopting the tool (this
 * repository ships an Electron app plus runtime artifacts, not npm packages,
 * so the package-graph semantics do not map).
 *
 * Fragment format (changesets/<kebab-name>.md):
 *
 *     ---
 *     shell: patch
 *     plugins: plugin-market, plugin-memory
 *     ---
 *
 *     中文一行说明。
 *     English one-liner.
 *
 * `shell` is none|patch|minor|major for the shell tag; `plugins` names the
 * suite plugins whose behaviour changed (each must bump its own version — the
 * suiteVersion hash reads package.json versions, not code). The body is
 * exactly two non-empty lines: Chinese first, English second. One line each is
 * the discipline; the fold at release time assembles them into the bilingual
 * CHANGELOG section, which the releaser reviews before tagging.
 *
 * @module dsh-app/scripts/lib/changeset
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Directory holding the fragments; consumed ones are deleted by the fold. */
export const CHANGESET_DIR = 'changesets'

/** The one file under the directory that is not a fragment. */
const README_NAME = 'README.md'

/**
 * Paths whose changes reach an existing installation. They mirror the delivery
 * paths in docs/agents/release-checklist.md: `src/` ships with the shell tag;
 * a plugin's src or manifest ships through the runtime's suiteVersion; the two
 * build scripts decide what the runtime contains. Anything else (docs, CI,
 * tests, tooling) reaches nobody and needs no fragment.
 */
const RELEASABLE_PREFIXES = ['src/']
const RELEASABLE_PLUGIN_RE = /^plugins\/[^/]+\/(?:src\/.+|package\.json)$/
const RELEASABLE_SCRIPTS = ['scripts/build-runtime.mjs', 'scripts/kernel-line.mjs']

/** Shell impact levels a fragment may declare, strongest last. */
const SHELL_LEVELS = ['none', 'patch', 'minor', 'major']

/**
 * Whether one changed path reaches users on the previous version.
 *
 * @param {string} filePath - repository-relative, forward slashes.
 * @returns {boolean} true when the path ships.
 */
export function isReleasablePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  if (RELEASABLE_SCRIPTS.includes(normalized)) return true
  if (RELEASABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  return RELEASABLE_PLUGIN_RE.test(normalized)
}

/**
 * Whether one changed path is a fragment (not the directory's README).
 *
 * @param {string} filePath - repository-relative, forward slashes.
 * @returns {boolean} true for `changesets/<name>.md` other than the README.
 */
export function isChangesetFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  return normalized.startsWith(`${CHANGESET_DIR}/`)
    && normalized.endsWith('.md')
    && path.posix.basename(normalized) !== README_NAME
}

/**
 * Parse one fragment.
 *
 * @param {string} text - the fragment's full text.
 * @param {string} name - file name, for error messages.
 * @returns {{ shell: string, plugins: string[], zh: string, en: string }} the
 *   parsed fragment.
 * @throws {Error} when the front matter or the body does not match the format.
 */
export function parseFragment(text, name) {
  const lines = text.split(/\r?\n/)
  let index = 0
  if (lines[index]?.trim() !== '---') {
    throw new Error(`${name}: missing the opening --- of the front matter`)
  }
  index += 1

  const fields = new Map()
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '---') {
      index += 1
      break
    }
    const match = /^([a-z]+):\s*(.*)$/.exec(line)
    if (match === null) {
      throw new Error(`${name}: front matter line is not "key: value": ${line}`)
    }
    fields.set(match[1], match[2].trim())
  }

  const shell = fields.get('shell')
  if (shell === undefined || !SHELL_LEVELS.includes(shell)) {
    throw new Error(`${name}: shell must be one of ${SHELL_LEVELS.join('|')}, got "${shell ?? ''}"`)
  }

  const plugins = (fields.get('plugins') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  const body = lines.slice(index).map((line) => line.trim()).filter((line) => line !== '')
  if (body.length !== 2) {
    throw new Error(`${name}: the body must be exactly two non-empty lines (Chinese, then English), got ${body.length}`)
  }

  return { shell, plugins, zh: body[0], en: body[1] }
}

/**
 * Decide whether a diff satisfies the gate.
 *
 * Three ways to declare a change:
 *
 * - a fragment that comes WITH the change (`changesets/<name>.md`), the normal
 *   and always-available form;
 * - a RELEASE commit, which consumes the fragments it folds into CHANGELOG and
 *   bumps `package.json`, so its own declaration is the changelog section it
 *   writes — requiring a fragment here would forbid folding and releasing in one
 *   commit, which is a legitimate shape;
 * - nothing at all when no releasable path changed.
 *
 * The release form is narrow on purpose: the SAME commit that deletes a fragment
 * must also write a NEW `[vX.Y.Z]` section in CHANGELOG.md. A commit that only
 * deletes fragments declares nothing, and a `src/` change smuggled next to a
 * release bump therefore lives or dies by the section the release wrote — which
 * the `--tag` form of this gate checks again before a tag ships.
 *
 * A caller that knows which paths were DELETED must pass them: a deleted fragment
 * is indistinguishable from an added one by path alone, and treating the fold's
 * own cleanup as "this commit brought a fragment" is how the exemption leaks.
 *
 * @param {readonly string[]} changedPaths - repository-relative paths.
 * @param {{ releasedVersion?: string, deletedPaths?: readonly string[] }} [context] -
 *   the section the commit ADDS, and the paths it removed.
 * @returns {{ releasable: string[], hasFragment: boolean, released: string | null, ok: boolean }}
 *   the releasable paths in the diff, whether a fragment came with it, the
 *   version it released if any, and the verdict.
 */
export function decide(changedPaths, context = {}) {
  const releasable = changedPaths.filter(isReleasablePath)
  const deleted = new Set(context.deletedPaths ?? [])
  const addedFragments = changedPaths.filter((filePath) => isChangesetFile(filePath) && !deleted.has(filePath))
  const hasFragment = addedFragments.length > 0
  const consumedFragments = changedPaths.some((filePath) => isChangesetFile(filePath) && deleted.has(filePath))
  return {
    releasable,
    hasFragment,
    released: context.releasedVersion !== undefined && consumedFragments ? context.releasedVersion : null,
    ok: releasable.length === 0
      || hasFragment
      || (context.releasedVersion !== undefined && consumedFragments),
  }
}

/**
 * Decide per commit — the unit the fragment travels in.
 *
 * A push's endpoint diff is the WRONG unit: a release push adds the fragment
 * in the fix commit and consumes it in the release commit, so the cumulative
 * diff shows the code change and no fragment, and a gate that reads endpoints
 * fails a release that followed the rule (measured on v0.14.1's push). Each
 * commit answers for itself.
 *
 * A commit may also carry its context: whether it ADDED a `[vX.Y.Z]` changelog
 * section and whether it deleted fragments. Together those identify a release
 * commit, whose declaration is the section it wrote (see {@link decide}), so a
 * fold that also touches `src/` is not reported as undeclared.
 *
 * @param {readonly { sha: string, paths: readonly string[], context?: object }[]} commits -
 *   the commits a push or PR adds, oldest first.
 * @returns {{ sha: string, releasable: string[], hasFragment: boolean }[]} one
 *   entry per offending commit; empty when every commit carries its
 *   declaration.
 */
export function decideCommits(commits) {
  const problems = []
  for (const { sha, paths, context } of commits) {
    const { releasable, hasFragment, ok } = decide(paths, context)
    if (!ok) problems.push({ sha, releasable, hasFragment })
  }
  return problems
}

/**
 * Read and parse every fragment in a directory, sorted by name.
 *
 * @param {string} dir - the changesets directory.
 * @returns {{ name: string, fragment: ReturnType<typeof parseFragment> }[]} the
 *   fragments in a stable order.
 * @throws {Error} when a fragment does not parse.
 */
export function readFragments(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && isChangesetFile(`${CHANGESET_DIR}/${entry.name}`))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      fragment: parseFragment(readFileSync(path.join(dir, name), 'utf8'), name),
    }))
}

/**
 * Render the CHANGELOG section for one version from its fragments.
 *
 * @param {string} version - bare version, e.g. `0.14.0`.
 * @param {string} date - `YYYY-MM-DD`.
 * @param {{ name: string, fragment: ReturnType<typeof parseFragment> }[]} fragments -
 *   the fragments this release consumes.
 * @returns {string} the section text, ending with exactly one newline.
 */
export function renderSection(version, date, fragments) {
  const zh = fragments.map((entry) => `- ${entry.fragment.zh}`).join('\n')
  const en = fragments.map((entry) => `- ${entry.fragment.en}`).join('\n')
  return `## [v${version}] - ${date}\n\n### 中文\n${zh}\n\n### English\n${en}\n`
}

/**
 * Insert a rendered section into the CHANGELOG, above the previous version.
 *
 * @param {string} changelog - the current CHANGELOG.md text.
 * @param {string} section - the rendered section.
 * @param {string} version - bare version, for the duplicate check.
 * @returns {string} the new CHANGELOG text.
 * @throws {Error} when the version already has a section.
 */
export function insertSection(changelog, section, version) {
  if (changelog.includes(`## [v${version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for v${version}`)
  }
  const lines = changelog.split('\n')
  const firstVersion = lines.findIndex((line) => /^## \[v/.test(line))
  if (firstVersion === -1) {
    const trimmed = changelog.replace(/\n*$/, '')
    return `${trimmed}\n\n${section}`
  }
  lines.splice(firstVersion, 0, section.replace(/\n$/, ''), '')
  return lines.join('\n')
}

/**
 * Split NUL-separated git output into records.
 *
 * `-z` is what makes this safe: without it git quotes any path with a non-ASCII
 * byte (or a quote) and escapes it, so a fragment named in Chinese would never be
 * recognised — a legitimate release commit then fails as if it declared nothing.
 * Splitting on NUL also keeps spaces and newlines in names intact.
 *
 * @param {string} output - raw stdout from a `-z` invocation.
 * @returns {string[]} the records, empty trailing record dropped.
 */
export function nulRecords(output) {
  return output.split('\0').filter((record) => record !== '')
}

/**
 * The paths one commit changed, from `git diff --name-status -z`.
 *
 * Rename records are `R100\0old\0new` (three fields); every other status is a
 * single path. Only the POST-image path is reported, which is what a changed-path
 * list means everywhere else in this gate.
 *
 * @param {string[]} records - output of {@link nulRecords}.
 * @returns {{ paths: string[], deleted: string[] }} the changed paths, and the
 *   ones the commit removed.
 */
export function parseNameStatus(records) {
  const paths = []
  const deleted = []
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]
    if (/^[RC]\d*$/u.test(status)) {
      // A rename/copy record carries two paths: source, then destination.
      const destination = records[index + 2]
      if (destination !== undefined) paths.push(destination)
      index += 2
      continue
    }
    const filePath = records[index + 1]
    if (filePath === undefined) break
    paths.push(filePath)
    if (status === 'D') deleted.push(filePath)
    index += 1
  }
  return { paths, deleted }
}

/**
 * The `[vX.Y.Z]` sections a CHANGELOG diff ADDS.
 *
 * Read from added diff lines rather than the file, so correcting a past version's
 * wording is not mistaken for releasing it. A version already present in the
 * parent is never "added", however the diff happens to align, which is what keeps
 * a reformat or a reorder from granting a release exemption it never earned.
 *
 * @param {string} diff - `git diff --unified=0 … -- CHANGELOG.md` output.
 * @param {readonly string[]} presentInParent - versions already in the parent file.
 * @returns {string[]} the versions this diff introduces.
 */
export function addedVersions(diff, presentInParent = []) {
  const existing = new Set(presentInParent)
  const versions = []
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const match = /^\+## \[v(\d+\.\d+\.\d+)\]/u.exec(line)
    if (match === null || existing.has(match[1])) continue
    versions.push(match[1])
  }
  return versions
}

export function sectionBullets(changelog, version) {
  const lines = changelog.split('\n')
  const heading = `## [v${version}]`
  const start = lines.findIndex((line) => line.startsWith(heading))
  if (start === -1) return { zh: [], en: [] }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \[v/.test(lines[index])) {
      end = index
      break
    }
  }
  const section = lines.slice(start + 1, end)
  const collect = (heading) => {
    const headingIndex = section.findIndex((line) => line.trim() === heading)
    if (headingIndex === -1) return []
    const bullets = []
    for (let index = headingIndex + 1; index < section.length; index += 1) {
      const line = section[index]
      if (line.startsWith('### ')) break
      if (line.startsWith('- ')) bullets.push(line)
    }
    return bullets
  }
  return { zh: collect('### 中文'), en: collect('### English') }
}
