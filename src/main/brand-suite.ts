/**
 * Brand suite wiring between the desktop shell and the dsh child process.
 *
 * The suite plugins (@dsh-app/plugin-brand, @dsh-app/plugin-client-ui,
 * @dsh-app/plugin-sidebar, @dsh-app/plugin-swarm, @dsh-app/plugin-usage,
 * @dsh-app/plugin-archives, @dsh-app/plugin-memory, @dsh-app/plugin-fff,
 * @dsh-app/plugin-mcp, @dsh-app/plugin-hooks) ship with the product, not
 * with the upstream dsh
 * kernel, so two seams have to be stitched at every server start:
 *
 *   1. Module resolution — the composed loader resolves entry names through
 *      the ordinary Node parent-walk from the profile directory;
 *      $DSH_HOME/profiles/node_modules is the flat fallback directory the
 *      harness maintains so in-box plugins resolve from any profile. The
 *      suite plugins are NOT in the kernel's heal-link closure (they are
 *      product additions), so the shell adds one link per plugin, pointing at
 *      the real install:
 *        dev  — this repo's plugins/* directories,
 *        prod — the active kernel's app/node_modules (build-runtime.mjs
 *               npm-installs them through file: references).
 *      Links are idempotent; the harness heal step never removes names it does
 *      not manage, so these survive every boot.
 *
 *      They are linked in TWO scope directories, and both are load-bearing:
 *
 *        - $DSH_HOME/profiles/node_modules/@dsh-app — the shared fallback the
 *          harness maintains for in-box plugins, so a plain `dsh` / `dsh web`
 *          run against ANY profile resolves them (that is the seam the
 *          hand-run UI probes use, and the one the user's own CLI runs see);
 *        - <profile>/node_modules/@dsh-app — the booted profile itself. The
 *          desktop host installs the harness's "runtime" profile resolver in
 *          its enforcing mode: for a bare specifier it collects candidates from
 *          the profile's own node_modules walk and STOPS at the shared fallback
 *          position (`generation.shared`), which is resolved only through the
 *          installation closure table. A package that is neither in that table
 *          nor installed in the profile is routed "after the fallback" and
 *          fails to import — measured as "17 entries did not activate" with
 *          every suite row failing, so the profile-local link is what makes
 *          the suite load under the host at all.
 *
 *      The profile's node_modules belongs to the package manager (the plugin
 *      market drives pnpm there), and a pnpm install may prune a link it does
 *      not know; that is why the shell re-links on every start rather than
 *      trusting a link once made, and why the shared copy stays: a pruned
 *      profile link costs nothing at the next boot.
 *
 * Known boundary: a kernel packaged as pkg/asar (upstream's own desktop) skips
 * the fallback wholesale; we spawn a plain node with a normal node_modules tree
 * (link mode), which honours it. Revisit if we ever package the kernel.
 *
 *   2. Composition — the loader overlay (plugins/dsh-app.patch.yml, copied
 *      next to the main bundle by copy-static.mjs) inserts the suite plugin
 *      rows. The desktop host takes no `--patch` argument (it always loads its
 *      own package's config and nothing else), and it does not read the home
 *      layer either, so the shell writes BOTH into the suite profile's own
 *      `profiles/<profile>/cordis.patch.yml`: the shipped rows first, then the
 *      rows this profile already carried, then the user's home layer
 *      ($DSH_HOME/cordis.patch.yml — where the machine-local rows, MCP servers
 *      among them, live). The file is regenerated from those three sections on
 *      every start and written only when the result changed.
 *
 *      The carried sections are not trusted blindly: a row naming a package
 *      this profile cannot resolve is *not* written into the composition.
 *      Measured on a real profile, an inherited row that named a package the
 *      profile lacked reached the loader and came back as "1 entry did not
 *      activate" — a failure the user can only answer by reading the kernel's
 *      own diagnostics. Such a row is kept in the file, commented out with the
 *      reason above it, and reported once per start (see
 *      {@link filterUnresolvableRows}).
 *
 * Both seams degrade gracefully: an older kernel without the suite plugins
 * (a rollback target) boots vanilla — no links, no overlay.
 *
 * Ownership fence: the scope dir ($DSH_HOME/profiles/node_modules/@dsh-app)
 * is SHARED — a user may install a real @dsh-app package there independently.
 * The shell therefore only ever replaces links it can prove it created (a
 * journal inside the scope dir records every link this shell owns), and a
 * directory or file it did not create is left untouched with a logged
 * warning while the remaining plugins still link.
 */
import { app } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

/** Suite plugin directory names under dsh-app/plugins (and kernel node_modules). */
export const SUITE_PLUGIN_DIRS = ['plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives', 'plugin-memory', 'plugin-fff', 'plugin-mcp', 'plugin-hooks', 'plugin-ppt', 'plugin-market', 'plugin-presets', 'plugin-doc', 'plugin-sheet', 'plugin-pdf', 'plugin-websearch'] as const

/** npm scope shared by the suite plugins. */
const PLUGIN_SCOPE = '@dsh-app'

/** Journal file inside the scope dir naming every link this shell owns. */
const OWNERSHIP_JOURNAL = '.dsh-app-links.json'

/**
 * Mirror the harness's resolveDshHome: $DSH_HOME wins, else ~/.dsh.
 */
export function resolveDshHome(): string {
  const raw = (process.env.DSH_HOME ?? '').trim()
  if (raw !== '') {
    return path.resolve(raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw)
  }
  return path.join(os.homedir(), '.dsh')
}

/** One suite plugin's resolvable source directory. */
export interface SuitePluginSource {
  /** Directory name under plugins/ (e.g. 'plugin-brand'). */
  dirName: string
  /** Absolute directory holding the built package (lib/ included). */
  dir: string
}

/** Dev sources: the dsh-app repo's plugins/ (built in place). */
export function devSuiteSources(): SuitePluginSource[] {
  const appRoot = app.getAppPath()
  return SUITE_PLUGIN_DIRS.map((dirName) => ({ dirName, dir: path.join(appRoot, 'plugins', dirName) }))
}

/** Prod sources: the active kernel's npm-flattened app/node_modules. */
export function prodSuiteSources(kernelDir: string): SuitePluginSource[] {
  return SUITE_PLUGIN_DIRS.map((dirName) => ({
    dirName,
    dir: path.join(kernelDir, 'app', 'node_modules', PLUGIN_SCOPE, dirName),
  }))
}

/** Read the ownership journal. Returns the owned set plus whether the journal
 * file existed at all (a corrupt journal counts as existing: nothing is proven
 * owned, but the historical-unowned-symlink exception must NOT apply either). */
async function readOwnedLinks(scopeDir: string): Promise<{ owned: Set<string>; journalExists: boolean }> {
  const journalPath = path.join(scopeDir, OWNERSHIP_JOURNAL)
  try {
    const raw = await fs.readFile(journalPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return {
      owned: new Set(parsed.filter((entry): entry is string => typeof entry === 'string')),
      journalExists: true,
    }
    // File exists but is not a JSON array: treat as corrupt → nothing owned,
    // and do not extend the historical exception.
    return { owned: new Set(), journalExists: true }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { owned: new Set(), journalExists: !missing }
  }
}

/** Persist the ownership journal (names the shell created or still owns). */
async function writeOwnedLinks(scopeDir: string, owned: ReadonlySet<string>): Promise<void> {
  await fs.writeFile(
    path.join(scopeDir, OWNERSHIP_JOURNAL),
    `${JSON.stringify([...owned], null, 2)}\n`,
    'utf8',
  )
}

/**
 * Ensure $DSH_HOME/profiles/node_modules/@dsh-app/<dirName> resolves to each
 * suite plugin's real directory. Junction on Windows (no elevation needed),
 * symlink elsewhere.
 *
 * Ownership fence: a link is replaced only when the journal proves this shell
 * created it; a name the journal does not own (a real package dir, a foreign
 * symlink) is left in place and skipped with a warning — never deleted, never
 * overwritten. A non-link entry of ours from a pre-journal shell run is still
 * replaceable when the journal is absent AND the entry is a symlink pointing
 * at a suite source (the historical shape); anything else is foreign.
 *
 * @param sources - suite plugin sources for the active kernel.
 * @param scopeDirs - the `@dsh-app` directories to link into: the shared
 *   fallback position and the booted profile (see the module header).
 * @returns true when every plugin linked (false → boot without the overlay).
 */
export async function linkSuitePlugins(
  sources: readonly SuitePluginSource[],
  scopeDirs: readonly string[],
): Promise<boolean> {
  for (const source of sources) {
    try {
      // A missing source means a kernel predating the suite: boot vanilla.
      await fs.access(path.join(source.dir, 'package.json'))
    } catch {
      return false
    }
  }
  const suiteTargets = new Set<string>()
  for (const source of sources) suiteTargets.add(await fs.realpath(source.dir))
  for (const scopeDir of scopeDirs) await linkScope(scopeDir, sources, suiteTargets)
  return true
}

/** One scope directory's worth of suite links, under that directory's journal. */
async function linkScope(
  scopeDir: string,
  sources: readonly SuitePluginSource[],
  suiteTargets: ReadonlySet<string>,
): Promise<void> {
  await fs.mkdir(scopeDir, { recursive: true })
  const { owned, journalExists: hadJournal } = await readOwnedLinks(scopeDir)
  for (const source of sources) {
    const target = await fs.realpath(source.dir)
    const linkPath = path.join(scopeDir, source.dirName)
    const ours = owned.has(source.dirName)
    try {
      const stat = await fs.lstat(linkPath)
      // Correct target already: mark ownership and move on. readlink may
      // return a relative or 8.3-short form (Windows junction); compare via
      // realpath on both sides so forms cannot fight.
      if (stat.isSymbolicLink()) {
        let existing: string | undefined
        try { existing = await fs.realpath(linkPath) } catch { existing = undefined }
        if (existing === target) {
          owned.add(source.dirName)
          continue
        }
      }
      // Not ours to touch: a real dir/file or a foreign symlink.
      // Historical exception: a pre-journal run left a symlink to a suite
      // source; without a journal that is the only shape we still own.
      // realpath may throw on a dangling link — that link is not ours to
      // replace either, so a false (not owned) answer is the safe outcome.
      let linkTarget: string | undefined
      try {
        linkTarget = await fs.realpath(linkPath)
      } catch {
        linkTarget = undefined
      }
      const isOwnedByUs = ours
        || (!hadJournal && stat.isSymbolicLink() && linkTarget !== undefined && suiteTargets.has(linkTarget))
      if (!isOwnedByUs) {
        console.warn(`[brand-suite] @dsh-app/${source.dirName} at ${linkPath} is not a link managed by this shell; leaving it in place and skipping.`)
        continue
      }
      // Ours to replace.
      if (stat.isSymbolicLink()) {
        await fs.unlink(linkPath)
      } else {
        await fs.rm(linkPath, { recursive: true, force: true })
      }
    } catch {
      /* absent → create below */
    }
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    owned.add(source.dirName)
  }
  await writeOwnedLinks(scopeDir, owned)
}

/**
 * File name the host reads as a profile's own user layer (`PROFILE_PATCH_FILENAME`
 * in app-boot). The shell owns this file inside the suite profile.
 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/**
 * Section markers inside the generated patch file. They exist so the file can be
 * rebuilt from its parts on every start: what the shell wrote last time is
 * replaced, and whatever this profile carried before A1 (the rows the suite
 * profile migration copied out of the `web` profile) survives in the middle.
 * Without them a regeneration would have to choose between re-appending the same
 * rows forever and silently dropping the user's own.
 */
const PATCH_HEADER = [
  '# DSH APP suite overlay — generated by the desktop shell on every start.',
  '#',
  '# The desktop host reads no --patch argument and no home layer, so this file is',
  '# the only channel the suite rows travel through. It is rebuilt from:',
  '#   1. the shipped overlay (plugins/dsh-app.patch.yml),',
  '#   2. the rows this profile already carried (kept between the markers below),',
  '#   3. the home layer $DSH_HOME/cordis.patch.yml — where rows written by you',
  '#      belong, and where they keep applying to your own dsh runs as well.',
  '#',
  '# Edits made to section 1 or 3 here are lost on the next start; edit the home',
  '# layer instead. Rows between the preserved markers are kept as they are —',
  '# except a row whose package does not resolve from this profile: that row is',
  '# commented out, with the reason on the line above it, instead of reaching the',
  '# loader as an entry that cannot activate.',
  '',
].join('\n')

const PATCH_SUITE_MARK = '# @@dsh-app-rows:suite\n'
const PATCH_PRESERVED_MARK = '# @@dsh-app-rows:preserved\n'
const PATCH_HOME_MARK = '# @@dsh-app-rows:home\n'

/** Render the generated patch file from its three sections. */
export function composeSuitePatch(sections: { suite: string; preserved: string; home: string }): string {
  const block = (mark: string, text: string): string => `${mark}${text.trim() === '' ? '' : `${text.trimEnd()}\n`}`
  return PATCH_HEADER + block(PATCH_SUITE_MARK, sections.suite) + block(PATCH_PRESERVED_MARK, sections.preserved) + block(PATCH_HOME_MARK, sections.home)
}

/**
 * Read the preserved section out of an existing generated file.
 *
 * A file without the markers is either empty or the profile's own layer from
 * before the shell generated it — both are preserved verbatim, which is what
 * keeps a user's hand-written rows alive across the first A1 start.
 *
 * @param content - current file content ('' when absent).
 * @returns the text to keep as this profile's preserved section.
 */
export function parseSuitePatch(content: string): { preserved: string } {
  if (content.trim() === '') return { preserved: '' }
  const preservedAt = content.indexOf(PATCH_PRESERVED_MARK)
  const homeAt = content.indexOf(PATCH_HOME_MARK)
  if (preservedAt === -1 || homeAt === -1 || homeAt < preservedAt) return { preserved: content.trimEnd() }
  return { preserved: content.slice(preservedAt + PATCH_PRESERVED_MARK.length, homeAt).trimEnd() }
}

/** Read a file as UTF-8, or '' when it is not there (or not readable). */
async function readOptionalFile(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * A loader entry's package line: `name: <specifier>`, quoted or bare, with an
 * optional trailing comment. Read as text — see {@link filterUnresolvableRows}
 * for why the shell does not parse the document.
 */
const PATCH_NAME_LINE = /^([ \t]*)(?:-\s+)?name:[ \t]*(['"]?)([^\s'"#]+)\2[ \t]*(?:#.*)?$/

/** A loader entry's id line — the sibling that tells an entry from a config key. */
const PATCH_ID_LINE = /^([ \t]*)(-\s+)?id:[ \t]*\S/

/** A top-level row of one section: `- ` at column zero. */
const PATCH_ROW_LINE = /^- /

/**
 * Indentation of a line's content, counting a `- ` sequence marker as two
 * columns: an entry's `id:` and `name:` land on the same number, while a nested
 * config key called `name` lands somewhere else.
 */
function contentIndent(line: string): number | undefined {
  const match = /^([ \t]*)(-\s+)?(.*)$/.exec(line)
  if (match === null || (match[3] ?? '').trim() === '') return undefined
  return (match[1] ?? '').length + (match[2] === undefined ? 0 : 2)
}

/**
 * Package specifiers one row names, taken only from lines that are entry
 * fields: a `name:` whose content indent carries a sibling `id:`.
 */
function rowSpecifiers(row: readonly string[]): string[] {
  const entryIndents = new Set<number>()
  for (const line of row) {
    if (!PATCH_ID_LINE.test(line)) continue
    const indent = contentIndent(line)
    if (indent !== undefined) entryIndents.add(indent)
  }
  const specifiers: string[] = []
  for (const line of row) {
    const match = PATCH_NAME_LINE.exec(line)
    if (match === null) continue
    const indent = contentIndent(line)
    if (indent === undefined || !entryIndents.has(indent)) continue
    specifiers.push(match[3] ?? '')
  }
  return specifiers.filter((specifier) => specifier !== '')
}

/**
 * Whether a row's package specifier can resolve from the booted profile.
 *
 * The walk starts at the profile directory, so it also covers the shared
 * fallback the harness maintains at `$DSH_HOME/profiles/node_modules` — the
 * directory carrying the kernel's own closure. A kernel-provided package
 * therefore counts as resolvable even though the profile never installed it,
 * which is exactly the set the host's own resolver sees. A specifier that is
 * not a bare package name (a relative path, a `cordis:` builtin) is left alone:
 * not the shell's to judge.
 *
 * @param specifier - the row's `name:` value.
 * @param profileDir - the profile the composition boots from.
 */
export function specifierResolves(specifier: string, profileDir: string): boolean {
  if (specifier.startsWith('.') || specifier.includes(':')) return true
  const searchPaths = createRequire(path.join(profileDir, PROFILE_PATCH_FILENAME)).resolve.paths(specifier) ?? []
  return searchPaths.some((dir) => existsSync(path.join(dir, ...specifier.split('/'), 'package.json')))
}

/**
 * Comment out the rows whose entries name a package this profile cannot
 * resolve, and report every skipped specifier.
 *
 * The sections above and below the shipped rows are carried in from two places
 * the shell does not control (this profile's earlier layer, and the user's home
 * layer), and a row among them naming a package this profile does not have is a
 * guaranteed "N entries did not activate" at the next boot — the kernel warns,
 * the client's own boot audit then refuses the page, and nothing about the cause
 * reaches the user. Commenting the row out keeps the composition loadable and
 * the row itself recoverable (the row is intact; delete the `#` prefix after
 * installing the package), while the log line keeps the skip from being silent.
 *
 * The scan is deliberately text-level: the shell has no YAML dependency, so it
 * reads entry-shaped `name:` fields rather than parsing the document. Anything
 * it cannot attribute to an entry is KEPT — a wrong keep costs a kernel warning,
 * a wrong drop would silently remove a user's own row.
 *
 * @param text - one section's text (comments included).
 * @param profileDir - the profile the composition boots from.
 * @returns the section with unloadable rows commented out, plus the specifiers
 *   that were skipped (for the caller's log lines).
 */
export function filterUnresolvableRows(text: string, profileDir: string): { text: string; skipped: string[] } {
  const lines = text.split('\n')
  const kept: string[] = []
  const skipped: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!PATCH_ROW_LINE.test(line)) {
      kept.push(line)
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && !PATCH_ROW_LINE.test(lines[end] ?? '')) end += 1
    const row = lines.slice(index, end)
    const unresolved = rowSpecifiers(row).filter((specifier) => !specifierResolves(specifier, profileDir))
    if (unresolved.length === 0) {
      kept.push(...row)
    } else {
      skipped.push(...unresolved)
      // The marker names every package the row could not load: one row, one
      // reason line, so the file explains its own dead text.
      kept.push(`# [dsh-app] NOT LOADED: ${unresolved.map((specifier) => `"${specifier}"`).join(', ')} does not resolve from this profile.`)
      kept.push(...row.map((rowLine) => (rowLine.trim() === '' || rowLine.startsWith('#') ? rowLine : `# ${rowLine}`)))
    }
    index = end
  }
  return { text: kept.join('\n'), skipped }
}

/**
 * Write the suite profile's patch layer: the shipped rows, the rows this profile
 * already carried, and the user's home layer.
 *
 * Both carried sections pass through {@link filterUnresolvableRows} first, so a
 * row naming a package this profile cannot load never becomes part of the
 * composition the host boots.
 *
 * Idempotent by content comparison — an unchanged result leaves the file (and its
 * mtime) alone, so a user watching the profile directory sees a write only when
 * something actually changed.
 *
 * @param profileDir - the booted profile's directory (its `cordis.patch.yml`).
 * @param options - `suite: false` (safe mode) drops the shipped rows and keeps
 *   only what is the user's own.
 */
export async function writeSuitePatchFile(profileDir: string, options: { suite: boolean }): Promise<void> {
  let suite = ''
  if (options.suite) {
    suite = await readOptionalFile(path.join(__dirname, 'dsh-app.patch.yml'))
    if (suite.trim() === '') {
      console.warn('[brand-suite] shipped overlay dsh-app.patch.yml is missing; booting without the suite rows')
    }
  }
  const target = path.join(profileDir, PROFILE_PATCH_FILENAME)
  const existing = await readOptionalFile(target)
  // The carried sections are filtered before they enter the composition, and
  // every skip is reported: a user who reads the log learns which row was left
  // out and why, and the file itself carries the reason beside the dead row.
  const carried = filterUnresolvableRows(parseSuitePatch(existing).preserved, profileDir)
  const home = filterUnresolvableRows(await readOptionalFile(path.join(resolveDshHome(), PROFILE_PATCH_FILENAME)), profileDir)
  for (const specifier of [...carried.skipped, ...home.skipped]) {
    console.warn(`[brand-suite] patch row skipped: "${specifier}" does not resolve from ${profileDir}; the row stays in ${PROFILE_PATCH_FILENAME} commented out`)
  }
  const next = composeSuitePatch({
    suite,
    preserved: carried.text,
    home: home.text,
  })
  if (next === existing) return
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(target, next, 'utf8')
  // The pre-A1 overlay copy in userData is no longer passed to anything; remove
  // it so a stale file cannot look like the live composition.
  await fs.rm(path.join(app.getPath('userData'), 'dsh-app-suite.patch.yml'), { force: true }).catch(() => undefined)
}

/**
 * Wire both seams before a host start.
 * @param sources - suite plugin sources for the kernel about to boot.
 * @param options - the booted profile's directory, and whether the suite rows
 *   should be part of it (safe mode boots without them).
 * @returns true when the suite rows are in the profile's layer.
 */
export async function prepareBrandSuite(
  sources: readonly SuitePluginSource[],
  options: { profileDir: string; suite: boolean },
): Promise<boolean> {
  let suite = options.suite
  try {
    if (suite) {
      // The shared fallback position first (the seam the CLI and the hand-run
      // probes resolve through), then the booted profile itself — the
      // directory the host's enforcing resolver reads.
      const scopeDirs = [
        path.join(resolveDshHome(), 'profiles', 'node_modules', PLUGIN_SCOPE),
        path.join(options.profileDir, 'node_modules', PLUGIN_SCOPE),
      ]
      suite = await linkSuitePlugins(sources, scopeDirs)
    }
  } catch (err) {
    // Never block the boot over brand wiring: log and go vanilla.
    console.error('[brand-suite] plugin linking failed; booting without the suite rows:', err)
    suite = false
  }
  try {
    await writeSuitePatchFile(options.profileDir, { suite })
    return suite
  } catch (err) {
    console.error('[brand-suite] patch layer could not be written:', err)
    return false
  }
}
