/**
 * Brand suite wiring between the desktop shell and the dsh child process.
 *
 * The suite plugins (@dsh-app/plugin-brand, @dsh-app/plugin-client-ui,
 * @dsh-app/plugin-sidebar, @dsh-app/plugin-swarm, @dsh-app/plugin-usage,
 * @dsh-app/plugin-archives, @dsh-app/plugin-memory,
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
 *      own diagnostics. A row naming a PATH is worse still: an absent file
 *      fails the whole tree (`plugin tree failed to load`) on every kernel,
 *      including a rollback target, so the app never reaches a window. Both
 *      shapes are kept in the file, commented out with the reason above them,
 *      and reported once per start (see {@link filterUnresolvableRows} and
 *      {@link specifierResolves}).
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
import { existsSync, promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Suite plugin directory names under dsh-app/plugins (and kernel node_modules). */
export const SUITE_PLUGIN_DIRS = ['plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives', 'plugin-memory', 'plugin-mcp', 'plugin-hooks', 'plugin-ppt', 'plugin-market', 'plugin-presets', 'plugin-doc', 'plugin-sheet', 'plugin-pdf', 'plugin-websearch'] as const

/** npm scope shared by the suite plugins; also the scope the mirror drop must not take back. */
export const PLUGIN_SCOPE = '@dsh-app'

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
 * @param report - where a diagnostic line goes (see {@link writeSuitePatchFile}).
 * @returns true when every plugin linked (false → boot without the overlay).
 */
export async function linkSuitePlugins(
  sources: readonly SuitePluginSource[],
  scopeDirs: readonly string[],
  report?: (line: string) => void,
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
  for (const scopeDir of scopeDirs) await linkScope(scopeDir, sources, suiteTargets, report)
  return true
}

/** One scope directory's worth of suite links, under that directory's journal. */
async function linkScope(
  scopeDir: string,
  sources: readonly SuitePluginSource[],
  suiteTargets: ReadonlySet<string>,
  report: ((line: string) => void) | undefined,
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
        reportLine(`[brand-suite] @dsh-app/${source.dirName} at ${linkPath} is not a link managed by this shell; leaving it in place and skipping.`, report)
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
/**
 * End of the sections the shell owns. Everything past this line is opaque: it
 * is read back verbatim and written out again untouched.
 *
 * It exists because the kernel's own configuration editor writes the rows it
 * stores for a setting into THIS file (`configEditor` edits the profile patch),
 * and it appends them after everything else. A regenerator that re-derives the
 * file from its named sections therefore dropped the user's settings on the next
 * start — the marker is what makes "not ours" a position rather than a guess.
 */
const PATCH_TAIL_MARK = '# @@dsh-app-rows:tail\n'

/**
 * Placeholder written instead of the home rows when the composer reads the home
 * layer itself. It sits under the home marker so the file still says where the
 * user's rows apply, and so the next start's `parseSuitePatch` keeps working.
 */
const PATCH_HOME_OMITTED = [
  '# The home layer $DSH_HOME/cordis.patch.yml is NOT copied here on this kernel:',
  '# this line boots through the kernel\'s own composer, which loads that file as a',
  '# layer itself — a copy beside it reaches the loader as a second row with the',
  '# same id and the plugin tree fails with "duplicate loader entry id". Your rows',
  '# still apply; edit them in the home layer.',
  '',
].join('\n')

/**
 * Whether the generated profile patch has to carry the home layer's rows.
 *
 * It does for a composer that reads ONLY this file. That is the FRAMES line: its
 * desktop host is handed the profile and composes no home layer, so without the
 * copy the user's own rows (their MCP servers, a pinned search provider) would
 * simply be absent from the UI.
 *
 * It must NOT for the web line (`0.1.6-alpha.2` and later), whose host composes
 * `$DSH_HOME/cordis.patch.yml` as a layer itself: the copy is then a second row
 * with the same id, and the tree fails with `duplicate loader entry id` —
 * measured on 0.1.6-alpha.2, where a profile carrying both could not start a host
 * at all, and measured again from the other side on the packaged 0.1.7 build:
 * with NO copy in the profile patch its preset menu still lists the migrated
 * `自进化模式` and its session header still shows the `Agent Team` action, both of
 * which come from the home layer alone.
 *
 * A dev checkout follows the same rule as production. It used to force the copy
 * (`isDev ||`), which put the duplicate into the shared profile on every dev
 * start — harmless while only the web line booted it, fatal the moment an older
 * build on the same machine did.
 *
 * @param options.transport - the host's transport (see `hostTransport`).
 */
export function homeRowsInProfilePatch(options: { transport: 'frames' | 'web' }): boolean {
  return options.transport === 'frames'
}

/** A line that is a root-level EMPTY flow collection: `[]` or `{}` at column 0. */
const ROOT_EMPTY_FLOW = /^[[{]\s*[\]}]\s*$/u

/**
 * Whether a section OPENS a root-level flow node — a complete YAML document on
 * its own, which therefore cannot be followed by anything.
 *
 * Comments and blank lines come first in the shapes that really occur (the
 * kernel's own patch template is three comment lines and then `[]`), so the
 * question is asked of the first CONTENT line, and only at column 0: a nested
 * value may be a flow collection without ending the document.
 */
function opensFlowNode(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return /^[[{]/u.test(line)
  }
  return false
}

/** Whether a section carries any row at all. */
function hasRows(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
}

/** What replaces an empty flow collection found at the top level of a section. */
const FLOW_EMPTY_NOTE = [
  '# [dsh-app] an empty flow collection ("[]" / "{}") was dropped here:',
  '# a flow node ENDS the YAML document, so nothing after it would parse.',
]

/** What replaces a section that is a NON-empty flow node and cannot be merged. */
const FLOW_CONTENT_NOTE = [
  '# [dsh-app] NOT MERGED: this section is a flow node ("[…]" / "{…}"), which',
  '# ends the YAML document — the rows that follow it would not parse. The text',
  '# is kept below, commented out; rewrite it as block rows to have it applied.',
  '',
].join('\n')

/** One line, commented out unless it is already blank or a comment. */
function commentOut(line: string): string {
  return line.trim() === '' || line.startsWith('#') ? line : `# ${line}`
}

/**
 * Render one section: its rows, or the notes that have to stand in for them.
 *
 * `mustMerge` is true when a LATER section carries rows — the only situation in
 * which a flow node here is fatal. Measured end to end on a real profile whose
 * patch file was the kernel's template (`# …` comments, then `[]`): the generated
 * file failed with `end of the stream or a document separator is expected
 * (274:1)` on both kernel lines, and because the regenerator only writes when the
 * content changed, the broken file regenerated to itself — safe mode included,
 * since that only drops the suite rows.
 */
function sectionBlock(mark: string, text: string, mustMerge: boolean): string {
  const trimmed = text.trim()
  if (trimmed === '') return mark
  // An empty flow collection carries no rows, so it is READ AS EMPTY wherever it
  // stands — that is the kernel's "no patch" shape, and it is what makes the
  // difference between a file that boots and one that never does.
  const lines = trimmed.split('\n').flatMap((line) => (ROOT_EMPTY_FLOW.test(line) ? FLOW_EMPTY_NOTE : [line]))
  if (!mustMerge) return `${mark}${lines.join('\n')}\n`
  const body = lines.join('\n')
  if (!opensFlowNode(body)) return `${mark}${body}\n`
  return `${mark}${FLOW_CONTENT_NOTE}${body.split('\n').map(commentOut).join('\n')}\n`
}

/** First line of the plugin market's own managed block; its writer's markers. */
const MARKET_BLOCK_HEADER = '# ── plugin-market managed disables ──'
/** Last line of that block. Kept in sync with `plugins/plugin-market/src/patchfile.ts`. */
const MARKET_BLOCK_FOOTER = '# ── end managed ──'

/**
 * The plugin market's managed disable block, wherever it sits in `content`.
 *
 * The market appends that block to the END of the profile patch — after the home
 * section, where the regenerator does not read. Without lifting it out first,
 * every start silently re-enabled the plugins a user had just switched off, and
 * the reason they switched them off (a row that stops the page from loading)
 * came back with them.
 *
 * @param content - current file content.
 * @returns the block verbatim, or '' when there is none (including a block whose
 *   footer is missing: a hand-truncated one is the market's to repair).
 */
export function marketManagedBlock(content: string): string {
  const start = content.indexOf(MARKET_BLOCK_HEADER)
  if (start === -1) return ''
  const end = content.indexOf(MARKET_BLOCK_FOOTER, start)
  if (end === -1) return ''
  return content.slice(start, end + MARKET_BLOCK_FOOTER.length).trimEnd()
}

/** Render the generated patch file from its sections. */
export function composeSuitePatch(sections: {
  suite: string
  preserved: string
  home: string
  /** Everything past {@link PATCH_TAIL_MARK}: rows the shell never interprets. */
  tail?: string
  managed?: string
}): string {
  // Order matters for the rule above: a flow node is only fatal when something
  // with rows follows it, and the sections travel in this order.
  const homeRows = hasRows(sections.home)
  const preservedRows = hasRows(sections.preserved)
  const managed = (sections.managed ?? '').trimEnd()
  const tail = (sections.tail ?? '').trim()
  return PATCH_HEADER
    + sectionBlock(PATCH_SUITE_MARK, sections.suite, preservedRows || homeRows)
    + sectionBlock(PATCH_PRESERVED_MARK, sections.preserved, homeRows)
    // The home section is no longer the last thing this file carries: the tail
    // marker and whatever the kernel appended after it follow, so the home body
    // has to merge whenever either of them brings rows of its own.
    + sectionBlock(PATCH_HOME_MARK, sections.home, tail !== '' || managed !== '')
    + PATCH_TAIL_MARK
    + (tail === '' ? '' : `${tail}\n`)
    // The market's block travels LAST, exactly as it was written: its rows have
    // to win over the suite rows they disable, and it owns its own markers.
    + (managed === '' ? '' : `${managed}\n`)
}

/**
 * Read the shell's own sections out of an existing generated file.
 *
 * A file without the markers is either empty or the profile's own layer from
 * before the shell generated it — both are preserved verbatim, which is what
 * keeps a user's hand-written rows alive across the first A1 start.
 *
 * The tail is returned verbatim and is the whole point of the marker: it is
 * where the KERNEL's configuration editor appends the rows it stores for a
 * setting (0.1.7 keeps user settings in this file), and re-deriving the file
 * from its sections alone dropped them on the next start.
 *
 * @param content - current file content ('' when absent).
 * @returns the preserved section, plus the opaque tail — '' for a file written
 *   before the tail marker existed, which the caller reads with
 *   {@link legacyTail} instead.
 */
export function parseSuitePatch(content: string): { preserved: string; tail: string } {
  const tailAt = content.indexOf(PATCH_TAIL_MARK)
  const body = tailAt === -1 ? content : content.slice(0, tailAt)
  const tail = tailAt === -1
    ? ''
    : content.slice(tailAt + PATCH_TAIL_MARK.length).replace(/^\n+/u, '').trimEnd()
  if (body.trim() === '') return { preserved: '', tail }
  const preservedAt = body.indexOf(PATCH_PRESERVED_MARK)
  const homeAt = body.indexOf(PATCH_HOME_MARK)
  if (preservedAt === -1 || homeAt === -1 || homeAt < preservedAt) return { preserved: body.trimEnd(), tail }
  return { preserved: body.slice(preservedAt + PATCH_PRESERVED_MARK.length, homeAt).trimEnd(), tail }
}

/**
 * The opaque tail of a profile patch written before {@link PATCH_TAIL_MARK}.
 *
 * The regenerator that wrote such a file ended its output with the home section,
 * so everything after that exact text is content the shell never wrote — in
 * practice the rows the kernel's configuration editor appends. The home text is
 * recomputed from the current home layer, which makes this an exact match
 * whenever nothing has edited that layer since the last start; when it does not
 * match, nothing is guessed and the caller keeps a copy of the file instead.
 *
 * @param withoutManaged - file content with the market's block already lifted out.
 * @param homeText - the home section this start would write.
 * @returns the tail, or undefined when the file does not end with that section.
 */
export function legacyTail(withoutManaged: string, homeText: string): string | undefined {
  const homeSection = sectionBlock(PATCH_HOME_MARK, homeText, false)
  const at = withoutManaged.lastIndexOf(homeSection)
  if (at === -1) return undefined
  return withoutManaged.slice(at + homeSection.length).trim()
}

/** Read a file as UTF-8, or '' when it is not there (or not readable). */
async function readOptionalFile(file: string): Promise<string> {
  try {
    // Line endings are normalized on the way in: a patch the user hand-edited on
    // Windows is CRLF, and the row reader below matches `name:` to the end of a
    // line. Left alone, that `\r` made a relative row read as a row WITHOUT a
    // specifier — silently unfilterable and uncarried, which is the exact shape
    // of the failure this file's guards exist to prevent.
    return (await fs.readFile(file, 'utf8')).replace(/\r\n?/gu, '\n')
  } catch {
    return ''
  }
}

/**
 * Emit one diagnostic line.
 *
 * Every line this function is used for explains why a row the user wrote is not
 * part of the boot — and the packaged Windows build shows no console at all, so
 * the caller passes the kernel log's own writer (`logKernel` in index.ts). The
 * console fallback keeps a probe and the dev checkout readable.
 */
function reportLine(line: string, report: ((line: string) => void) | undefined): void {
  if (report === undefined) console.warn(line)
  else report(line)
}

/**
 * A loader entry's package line: `name: <specifier>`, quoted or bare, with an
 * optional trailing comment. Read as text — see {@link filterUnresolvableRows}
 * for why the shell does not parse the document.
 */
const PATCH_NAME_LINE = /^([ \t]*)(?:-\s+)?name:[ \t]*(?:(["'])(.*?)\2|([^\s'"#]+))[ \t]*(?:#.*)?$/

/** A loader entry's id line — the sibling that tells an entry from a config key. */
const PATCH_ID_LINE = /^([ \t]*)(-\s+)?id:[ \t]*\S/

/** A top-level row of one section: `- ` at column zero. */
const PATCH_ROW_LINE = /^- /

/**
 * Split patch text into lines, with CRLF and lone-CR endings normalized to LF.
 *
 * This is where the line-ending rule lives, and it has to exist: `.` never
 * matches a carriage return (it is a line terminator, like `\n`), so
 * `contentIndent` cannot read a CRLF line, and a row reader anchored to the end
 * of a line sees a row with NO specifier at all. A patch a Windows user
 * hand-edited then reads as neither carried nor filtered — silently, which is
 * exactly the failure the two readers below exist to prevent.
 */
function patchLines(text: string): string[] {
  return text.replace(/\r\n?/gu, '\n').split('\n')
}

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
 *
 * The value is read whether it is quoted or bare, and a QUOTED one may contain
 * the characters a bare YAML scalar cannot: whitespace, `#`, quotes of the other
 * kind. That is not a corner case — it is how a path with a space in it is
 * written (`name: "./my plugins/x.mjs"`), and a reader that could not see such a
 * row would neither carry its file nor keep it out of the loader, which is the
 * one fatal shape this whole scan exists to prevent.
 *
 * @param row - the row's lines.
 * @param firstLine - 1-based number of the row's first line, so a finding can be
 *   reported as a place in the file rather than as a bare specifier.
 */
function rowSpecifiers(row: readonly string[], firstLine: number): PatchSpecifier[] {
  const entryIndents = new Set<number>()
  for (const line of row) {
    if (!PATCH_ID_LINE.test(line)) continue
    const indent = contentIndent(line)
    if (indent !== undefined) entryIndents.add(indent)
  }
  // Only the block's OWN entries are judged: those sit at its SHALLOWEST
  // id-bearing indent. A deeper one is a nested composition — a preset's
  // `config.plugins`, a group's children — and its names are resolved by
  // whoever mounts that composition, not by this profile. Judging them here
  // costs the whole row: measured on a real home layer, one migrated
  // `@deepseek-ai/dsh-agent-preset` row carries a 35-name composition, and a
  // single nested name that does not resolve from the profile got the user's
  // entire preset commented out. That is the "wrong drop" this function's own
  // doctrine forbids ("a wrong keep costs a kernel warning, a wrong drop would
  // silently remove a user's own row"): a nested row that cannot load fails the
  // preset's MOUNT — the registry logs a warning and the preset does not appear,
  // which is recoverable — while a dropped row takes the preset away with no
  // way back except editing the file by hand.
  const entryIndent = entryIndents.size === 0 ? undefined : Math.min(...entryIndents)
  const specifiers: PatchSpecifier[] = []
  row.forEach((line, index) => {
    const match = PATCH_NAME_LINE.exec(line)
    if (match === null) return
    const indent = contentIndent(line)
    if (indent === undefined || indent !== entryIndent) return
    const specifier = match[3] ?? match[4] ?? ''
    if (specifier !== '') specifiers.push({ specifier, line: firstLine + index })
  })
  return specifiers
}

/** One specifier a patch text names, with the 1-based line it was written on. */
export interface PatchSpecifier {
  readonly specifier: string
  readonly line: number
}

/** Every specifier a patch text names, in first-seen order, with its line. */
function namedSpecifiers(text: string): PatchSpecifier[] {
  const lines = patchLines(text)
  const found: PatchSpecifier[] = []
  let index = 0
  while (index < lines.length) {
    if (!PATCH_ROW_LINE.test(lines[index] ?? '')) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && !PATCH_ROW_LINE.test(lines[end] ?? '')) end += 1
    for (const named of rowSpecifiers(lines.slice(index, end), index + 1)) {
      if (!found.some((seen) => seen.specifier === named.specifier)) found.push(named)
    }
    index = end
  }
  return found
}

/**
 * Whether a row's specifier can load from the booted profile.
 *
 * Three positions, and they are the ones the host's enforcing resolver reads:
 *
 *   1. the booted profile's own `node_modules`,
 *   2. the shared fallback the harness maintains at
 *      `$DSH_HOME/profiles/node_modules`, and
 *   3. **the installation closure** (`extraDirs`, the active kernel's
 *      `app/node_modules`).
 *
 * Position 3 is not a convenience — it is the AUTHORITY, and positions 1-2 are
 * mirrors of it. `createRuntimeResolution` (`packages/boot/app-boot/src/profile.ts`)
 * builds the resolver's table from `collectInstallationScopePackages(installAnchor)`
 * — the running dsh installation's own dependency closure — and the resolver
 * consults that NAME→DIRECTORY TABLE, not a directory scan
 * (`profile-resolution/resolver.ts`: `entries: new Map(resolution.entries…)`).
 * The shared fallback directory is a harness-maintained copy of that closure, so
 * it LAGS: measured on this machine it still held the 0.1.6-era set (including a
 * package 0.1.7 deleted) while lacking three packages 0.1.7 ships. Reading only
 * the mirrors therefore reported resolvable rows as unresolvable — three of them
 * in one real home layer, which got the user's preset commented out for no
 * reason. Passing the closure directory closes that gap.
 *
 * A PATH specifier is judged first and against the file system, because the
 * loader imports it directly (`tree.import(name)`). Measured on a real profile:
 * a carried `name: ./local-plugins/x.mjs` whose file stayed behind in the
 * profile the user migrated FROM failed the WHOLE tree
 * (`ERR_MODULE_NOT_FOUND` → `plugin tree failed to load`) — on the new kernel
 * and on the one it rolled back to, so the app could not start at all until the
 * file was back. The check is `isFile`, not `existsSync`: a directory (a
 * half-copied `local-plugins/`, say) is not importable either. A `cordis:`
 * builtin stays unjudged — the shell has nothing to check it against.
 *
 * Node's own upward walk stays out of it on purpose: it would ALSO accept a
 * package installed at `$DSH_HOME/node_modules`, in the user's home directory or
 * at a disk root, and the shell would then keep a row the host cannot resolve.
 *
 * @param specifier - the row's `name:` value.
 * @param profileDir - the profile the composition boots from.
 * @param extraDirs - additional package roots the host resolves from, highest
 *   authority last (the active kernel's `app/node_modules`). Defaults to none,
 *   which is the pre-fix behaviour and keeps every existing caller honest.
 */
export function specifierResolves(specifier: string, profileDir: string, extraDirs: readonly string[] = []): boolean {
  // Paths first: a relative or absolute specifier may carry a colon (an NTFS
  // alternate data stream, or a Windows path a user wrote down by hand), and
  // mistaking that for a URL scheme would leave exactly those rows unexamined.
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    return importableFile(path.resolve(profileDir, specifier))
  }
  if (SCHEME_SPECIFIER.test(specifier)) return true
  const searchDirs = [
    path.join(profileDir, 'node_modules'),
    path.join(profileDir, '..', 'node_modules'),
    ...extraDirs,
  ]
  // A SUBPATH specifier (`@scope/pkg/tool`) has no `…/tool/package.json`; the
  // package root is what has to be present, and whether its `exports` admits the
  // subpath is the loader's business. Building the path from the whole specifier
  // reported every subpath row as unresolvable — two of the three above are
  // subpaths, and both are exported by their package.
  const [packageName] = splitPackageSpecifier(specifier)
  return packageName !== undefined
    && searchDirs.some((dir) => existsSync(path.join(dir, ...packageName.split('/'), 'package.json')))
}

/**
 * The package name a bare specifier starts with, plus whatever follows it.
 *
 * `@scope/pkg/tool/x` → `['@scope/pkg', 'tool/x']`; `pkg/tool` → `['pkg', 'tool']`;
 * a specifier whose scope segment is missing → `[undefined, '']`.
 *
 * @param specifier - a bare (non-path, non-scheme) specifier.
 */
function splitPackageSpecifier(specifier: string): [string | undefined, string] {
  const parts = specifier.split('/')
  if (!specifier.startsWith('@')) return [parts[0], parts.slice(1).join('/')]
  if (parts.length < 2 || parts[0] === '' || parts[1] === '') return [undefined, '']
  return [`${parts[0] ?? ''}/${parts[1] ?? ''}`, parts.slice(2).join('/')]
}

/** A specifier carrying a URL scheme (`cordis:include`, `node:fs`, `file:…`). */
const SCHEME_SPECIFIER = /^[a-z][a-z0-9+.-]*:/iu

/**
 * The installation-closure package root to add to the resolution check, or none
 * when there is no kernel to point at.
 *
 * A directory that does not exist is dropped rather than passed on: the check's
 * whole test is `existsSync`, so an absent root would never match — but handing
 * it over anyway would make a typo look like a position that was consulted.
 *
 * @param kernelNodeModules - the active kernel's `app/node_modules`, when known.
 */
function extraResolutionDirs(kernelNodeModules: string | undefined): readonly string[] {
  return kernelNodeModules !== undefined && existsSync(kernelNodeModules) ? [kernelNodeModules] : []
}

/**
 * Whether a path points at a file the loader can import.
 *
 * Three things have to hold, and only the first is obvious:
 *
 *   - the path exists as a REGULAR FILE (a directory throws);
 *   - its extension is one Node's ESM loader accepts. The kernel hands a
 *     relative specifier to Node's own resolver unchanged (measured in
 *     `dsh-app-boot`: a relative request with no route falls through to
 *     `native(request, parent, attributes)`), and Node refuses anything outside
 *     this set — a `.txt` a user typed by mistake would kill the whole tree
 *     exactly like a missing file does. Type stripping is NOT enabled in the
 *     kernel, so a raw `.ts` is refused too;
 *   - nothing about reading it throws.
 *
 * The list is deliberately narrow: commenting a row out is REPORTED in the file
 * and in the log, while keeping an unimportable one stops the app from starting.
 */
function importableFile(candidate: string): boolean {
  if (!IMPORTABLE_EXTENSIONS.includes(path.extname(candidate).toLowerCase())) return false
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Extensions Node's ESM loader imports without an import attribute. */
const IMPORTABLE_EXTENSIONS: readonly string[] = ['.js', '.mjs', '.cjs', '.node']

/**
 * Every specifier a patch text names, in first-seen order.
 *
 * `name:` values are read exactly the way {@link filterUnresolvableRows} reads
 * them (an entry field: a `name:` with a sibling `id:` at the same indent), so
 * this cannot mistake a plugin's own config key for a path. The migration uses
 * {@link relativePatchSpecifiers} to learn which files have to travel with a
 * patch that is otherwise only text.
 *
 * @param text - one or more sections of patch-layer text.
 */
export function patchSpecifiers(text: string): string[] {
  return namedSpecifiers(text).map((named) => named.specifier)
}

/**
 * The specifiers a patch text names that will NOT load from this profile, with
 * the line each of them sits on.
 *
 * This is the finding the shell cannot act on by itself when the text is the
 * HOME layer: on the web transport the kernel composes that file as its own
 * layer, so the shell can neither filter it nor comment a row out — but it can
 * name the file, the line and the row that will stop the host, which is what
 * turns "the app does not open" into something a user can fix in a minute.
 *
 * @param text - the patch text to examine.
 * @param profileDir - the profile the host will boot.
 * @param extraDirs - package roots the host also resolves from (see
 *   {@link specifierResolves}); the active kernel's `app/node_modules`.
 */
export function unloadableRows(text: string, profileDir: string, extraDirs: readonly string[] = []): PatchSpecifier[] {
  return namedSpecifiers(text).filter((named) => !specifierResolves(named.specifier, profileDir, extraDirs))
}

/**
 * The relative (path) specifiers a patch text names, in first-seen order.
 *
 * @param text - one or more sections of patch-layer text.
 */
export function relativePatchSpecifiers(text: string): string[] {
  return patchSpecifiers(text).filter((specifier) => specifier.startsWith('.'))
}

/**
 * Comment out the rows whose entries name a package or a path this profile
 * cannot load, and report every skipped specifier.
 *
 * The sections above and below the shipped rows are carried in from two places
 * the shell does not control (this profile's earlier layer, and the user's home
 * layer), and a row among them naming a package this profile does not have is a
 * guaranteed "N entries did not activate" at the next boot — the kernel warns,
 * the client's own boot audit then refuses the page, and nothing about the cause
 * reaches the user. A row naming a missing FILE is worse: the loader's own
 * `import` throws and the whole tree fails, on every kernel line, so the window
 * never opens at all. Commenting such a row out keeps the composition loadable
 * and the row itself recoverable (the row is intact; delete the `#` prefix after
 * restoring the package or the file), while the log line keeps the skip from
 * being silent.
 *
 * The scan is deliberately text-level: the shell has no YAML dependency, so it
 * reads entry-shaped `name:` fields rather than parsing the document. Anything
 * it cannot attribute to an entry is KEPT — a wrong keep costs a kernel warning,
 * a wrong drop would silently remove a user's own row.
 *
 * @param text - one section's text (comments included).
 * @param profileDir - the profile the composition boots from.
 * @param extraDirs - package roots the host also resolves from (see
 *   {@link specifierResolves}); the active kernel's `app/node_modules`.
 * @returns the section with unloadable rows commented out, plus the specifiers
 *   that were skipped (for the caller's log lines).
 */
export function filterUnresolvableRows(text: string, profileDir: string, extraDirs: readonly string[] = []): { text: string; skipped: string[] } {
  const lines = patchLines(text)
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
    const unresolved = rowSpecifiers(row, index + 1)
      .filter((named) => !specifierResolves(named.specifier, profileDir, extraDirs))
      .map((named) => named.specifier)
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
 * row naming a package — or a file — this profile cannot load never becomes part
 * of the composition the host boots. When the home layer is NOT copied here (the
 * web transport, where the kernel loads it as its own layer), the same check
 * runs over it for the log alone: a row the shell cannot comment out is still a
 * row it can name.
 *
 * Idempotent by content comparison — an unchanged result leaves the file (and its
 * mtime) alone, so a user watching the profile directory sees a write only when
 * something actually changed.
 *
 * @param profileDir - the booted profile's directory (its `cordis.patch.yml`).
 * @param options - `suite: false` (safe mode) drops the shipped rows and keeps
 *   only what is the user's own; `kernelNodeModules` is the active kernel's
 *   `app/node_modules`, the installation closure the host resolves through
 *   (see {@link specifierResolves}); `report` receives each diagnostic line (the
 *   packaged Windows build shows no console, so the caller passes the kernel
 *   log's own writer — the console fallback is for a probe or a dev checkout).
 */
export async function writeSuitePatchFile(
  profileDir: string,
  options: { suite: boolean; homeRows?: boolean; kernelNodeModules?: string; report?: (line: string) => void },
): Promise<readonly PatchSpecifier[]> {
  const closure = extraResolutionDirs(options.kernelNodeModules)
  let suite = ''
  if (options.suite) {
    suite = await readOptionalFile(path.join(__dirname, 'dsh-app.patch.yml'))
    if (suite.trim() === '') {
      reportLine('[brand-suite] shipped overlay dsh-app.patch.yml is missing; booting without the suite rows', options.report)
    }
  }
  const target = path.join(profileDir, PROFILE_PATCH_FILENAME)
  const existing = await readOptionalFile(target)
  // The market's block lives past the home marker, where a write would drop it.
  // It is lifted out before the sections are read, so it neither disappears nor
  // arrives twice.
  const managed = marketManagedBlock(existing)
  const withoutManaged = managed === '' ? existing : existing.replace(managed, '')
  // The carried sections are filtered before they enter the composition, and
  // every skip is reported: a user who reads the log learns which row was left
  // out and why, and the file itself carries the reason beside the dead row.
  const parsed = parseSuitePatch(withoutManaged)
  const carried = filterUnresolvableRows(parsed.preserved, profileDir, closure)
  const copyHome = options.homeRows !== false
  // Read once, for both jobs: the copy this line may compose, and the audit the
  // other line needs (it cannot compose that file, so naming the bad rows is the
  // only thing left to do about them).
  const homeLayerText = await readOptionalFile(path.join(resolveDshHome(), PROFILE_PATCH_FILENAME))
  const home = copyHome
    ? filterUnresolvableRows(homeLayerText, profileDir, closure)
    : { text: PATCH_HOME_OMITTED, skipped: [] }
  for (const specifier of [...carried.skipped, ...home.skipped]) {
    reportLine(`[brand-suite] patch row skipped: "${specifier}" does not load from ${profileDir}; the row stays in ${PROFILE_PATCH_FILENAME} commented out`, options.report)
  }
  // Rows in the HOME layer this profile cannot load. On this line the kernel
  // composes that file as a layer of its own, so the shell can neither filter it
  // nor comment a row out — but it can hand back the file, the line and the row,
  // which is the whole difference between "the app does not open" and a fix the
  // user can make in a minute.
  const homeUnloadable = copyHome ? [] : unloadableRows(homeLayerText, profileDir, closure)
  for (const named of homeUnloadable) {
    reportLine(`[brand-suite] the home layer names "${named.specifier}" (line ${String(named.line)}), which does not load from ${profileDir}: install it into that profile (the plugin market's install action does this) or remove the row — the host cannot start while it is there`, options.report)
  }
  // The opaque tail — the rows the kernel's configuration editor appended when it
  // stored a setting. A file written before the tail marker existed says nothing
  // about where its own content ends, so that case is read with `legacyTail`; and
  // when even that anchor is missing, the file is copied aside rather than
  // re-derived, because a rewrite would take those rows with it.
  let tail = parsed.tail
  if (tail === '' && !existing.includes(PATCH_TAIL_MARK)) {
    const recovered = legacyTail(withoutManaged, home.text)
    if (recovered === undefined) {
      await keepUnlocatableTailAside(target, existing, withoutManaged, options.report)
    } else {
      tail = recovered
      if (recovered !== '') {
        reportLine('[brand-suite] this profile patch predates the preserved tail; the rows past the home marker were adopted, so settings the kernel stores here survive from now on', options.report)
      }
    }
  }
  const next = composeSuitePatch({
    suite,
    preserved: carried.text,
    home: home.text,
    tail,
    managed,
  })
  if (next === existing) return homeUnloadable
  await fs.mkdir(profileDir, { recursive: true })
  await writePatchAtomically(target, next)
  // The pre-A1 overlay copy in userData is no longer passed to anything; remove
  // it so a stale file cannot look like the live composition.
  await fs.rm(path.join(app.getPath('userData'), 'dsh-app-suite.patch.yml'), { force: true }).catch(() => undefined)
  return homeUnloadable
}

/**
 * Install a newly composed profile patch through a temporary file and a rename.
 *
 * This file IS the composition the host boots, so the failure modes matter more
 * than the bytes. A plain `writeFile` interrupted by a crash or a full disk
 * leaves a TRUNCATED patch: a profile that cannot load, with the previous content
 * gone. A rename is atomic, so a reader sees the old file or the new one and
 * never half of either.
 *
 * What this deliberately does NOT do is remove the target first — the trick
 * `writeJsonFileAtomic` uses, which is fine for a record whose absence means "not
 * set". Here the same window would take the suite rows, the rows the profile
 * carried and the kernel's own tail with it, and a boot without them is the
 * failure this whole file exists to prevent. If the rename cannot be made to
 * land, the OLD file stays and the caller hears about it.
 *
 * Windows refuses a rename while another process holds the target — an antivirus
 * scanner or the search indexer, briefly — so the transient codes are retried
 * exactly as the kernel manager retries its own activation rename.
 *
 * @param target - absolute path of the profile's `cordis.patch.yml`.
 * @param content - the composed content to install.
 * @throws when the rename cannot be made to land; the previous file is untouched.
 */
export async function writePatchAtomically(target: string, content: string): Promise<void> {
  const staging = `${target}.${String(process.pid)}.tmp`
  await fs.writeFile(staging, content, 'utf8')
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(staging, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt >= 5) {
        // The old file is still in place, so the profile keeps booting on the
        // composition it had; the staging file is junk in a directory nothing
        // reads. Fail loudly rather than report a write that did not land.
        await fs.rm(staging, { force: true }).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50))
    }
  }
}

/**
 * Keep a copy of a profile patch whose tail could not be located.
 *
 * Reached only for a file written before {@link PATCH_TAIL_MARK} whose home
 * section this start would not reproduce byte for byte — the home layer changed
 * since, or the file was edited by hand. Rewriting it is still correct for the
 * shell's own sections, but anything past them goes with the rewrite, and the
 * shell cannot tell a kernel-written settings row from a user's row there. So the
 * file is copied beside itself first and the log names the copy. Best effort: a
 * copy that cannot be written must not stop the boot.
 *
 * @param target - the profile patch being rewritten.
 * @param content - its current content (the copy that is kept).
 * @param withoutManaged - content with the market's block already lifted out.
 * @param report - where the diagnostic line goes.
 */
async function keepUnlocatableTailAside(
  target: string,
  content: string,
  withoutManaged: string,
  report: ((line: string) => void) | undefined,
): Promise<void> {
  const homeAt = withoutManaged.indexOf(PATCH_HOME_MARK)
  if (homeAt === -1) return
  // Only rows are at risk: comments past the marker are already inert.
  const atRisk = withoutManaged.slice(homeAt).split('\n').some((line) => /^\s*-\s/u.test(line))
  if (!atRisk) return
  const copy = `${target}.pre-tail-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  try {
    await fs.writeFile(copy, content, 'utf8')
    reportLine(`[brand-suite] this profile patch predates the preserved tail and its rows past the home marker cannot be told apart from yours; the file as it was is kept at ${copy}`, report)
  } catch (error) {
    reportLine(`[brand-suite] could not keep a copy of ${target} before rewriting it (${String(error)}); rows past the home marker may be lost`, report)
  }
}

/**
 * Wire both seams before a host start.
 * @param sources - suite plugin sources for the kernel about to boot.
 * @param options - the booted profile's directory, whether the suite rows
 *   should be part of it (safe mode boots without them), and where a diagnostic
 *   line goes (see {@link writeSuitePatchFile}).
 * @returns whether the suite rows are in the profile's layer, plus the home-layer
 *   rows the booted profile cannot load (empty unless the kernel composes that
 *   file itself — see {@link unloadableRows}).
 */
export async function prepareBrandSuite(
  sources: readonly SuitePluginSource[],
  options: { profileDir: string; suite: boolean; homeRows?: boolean; kernelNodeModules?: string; report?: (line: string) => void },
): Promise<{ suite: boolean; homeUnloadable: readonly PatchSpecifier[] }> {
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
      suite = await linkSuitePlugins(sources, scopeDirs, options.report)
    }
  } catch (err) {
    // Never block the boot over brand wiring: log and go vanilla.
    reportLine(`[brand-suite] plugin linking failed; booting without the suite rows: ${(err as Error).message}`, options.report)
    suite = false
  }
  try {
    const homeUnloadable = await writeSuitePatchFile(options.profileDir, { suite, homeRows: options.homeRows, kernelNodeModules: options.kernelNodeModules, report: options.report })
    return { suite, homeUnloadable }
  } catch (err) {
    reportLine(`[brand-suite] patch layer could not be written: ${(err as Error).message}`, options.report)
    return { suite: false, homeUnloadable: [] }
  }
}
