/**
 * The incremental index pass: walk a project, parse what changed, forget what is
 * gone.
 *
 * The contract with `store.ts` is narrow on purpose. This module decides WHICH
 * files to parse; `replaceFile` / `forgetFile` decide what the graph says about
 * them. Nothing here writes SQL, and nothing in `store.ts` reads the disk.
 *
 * Why the pass is bounded. A first index of a real repository reads tens of
 * thousands of files, and doing that without limits turns a background task into
 * a memory spike and a UI that looks hung. The walk therefore stops at
 * {@link MAX_FILES} and reports `truncated`, which the tools surface — a graph
 * that covers 90% of a project and says so is useful; one that silently covers
 * 60% is not.
 *
 * Which files are candidates at all is decided in two steps: the fixed directory
 * list below, then the project's own `.gitignore` (`ignore.ts`), then generation
 * by name, by header banner or by the shape of their lines. The last three only
 * ever SHRINK the walk, which is why the counts they produce are reported rather
 * than dropped.
 *
 * What counts as changed. `mtime` + `size` first, because that is one `stat` per
 * file and catches every ordinary edit. A same-size rewrite with a preserved
 * mtime (a checkout, a restore from backup, some editors) slips past both, so a
 * file whose `mtime`+`size` match is re-hashed only when its recorded hash is
 * absent — otherwise the pass would hash every file on every run, which is the
 * cost this comparison exists to avoid. `hash` is still stored, so a future
 * `--verify` mode can use it.
 *
 * @module @dsh-app/plugin-codegraph/host/indexer
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { MAX_SOURCE_FILE_BYTES } from './budget.ts'
import { languageForPath } from './languages.ts'
import { DOCUMENT_EXTENSIONS, documentMentions, knownNames } from './docs.ts'
import {
  GENERATED_HEAD_BYTES,
  hasNegation,
  isGeneratedHead,
  isGeneratedPath,
  isGeneratedShape,
  isIgnored,
  parseGitignore,
  type IgnoreRule,
} from './ignore.ts'
import { callEdges, relationEdges, type ParsedFile } from './parse.ts'
import {
  allRows,
  fileNodeId,
  forgetFile,
  graphStats,
  isResolvableKind,
  NAME_RESOLVABLE,
  readFiles,
  registrationsFor,
  replaceFile,
  symbolsOf,
  writeProjectMeta,
  type EdgeRecord,
  type FileRecord,
  type Graph,
  type ProjectMeta,
  type Registration,
  type RegistrationKind,
  type SymbolRecord,
} from './store.ts'
import { dispatchEdges, refineRegistrationTargets, resolveHandler, routeEdges, synthesizeFile } from './synthesis.ts'

/** The names a file's import clauses bring into scope, for the route rule (`synthesis.ts`). */
function importedNames(parsed: ParsedFile): Set<string> {
  return new Set(parsed.imports.flatMap(specifier => specifier.names))
}

const execFileAsync = promisify(execFile)

/** How many files one pass will consider. */
export const MAX_FILES = 20_000

/**
 * Directories never worth walking: dependency trees, build output, VCS metadata.
 *
 * This list stays the floor under `.gitignore` rather than being replaced by it.
 * A project that excludes nothing still has a `node_modules/`, and the walk must
 * not descend into one to ask a rule that was never written.
 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
  'coverage', '.test-dist', 'lib', 'release', 'runtime-dist', 'bundled-kernel',
  // .NET build output. Measured on a real WPF project: `obj/Release/net9.0-windows`
  // and its `win-x64` variant contributed ten files that declare nothing, and the
  // view listed them as two blocks of "0 symbols" under a path nobody wrote. A
  // generated file has no place in a graph of the source.
  'obj', 'bin',
])

/** A file that is large enough to be generated rather than written. */
const MAX_FILE_BYTES = MAX_SOURCE_FILE_BYTES

/**
 * The languages whose imports are JS module specifiers — the only ones
 * {@link isExternalSpecifier} makes a statement about. A Python `import json` is a
 * bare specifier too, but it names neither a Node built-in nor a `node_modules`
 * package, and a rule about one module system must not be applied to another.
 */
const JS_MODULE_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'vue', 'svelte', 'astro'])

/**
 * The C family: a `.cpp` or `.m` file calls what a `.h` header declares, and the
 * graph must not read that as a cross-language match.
 */
const C_FAMILY_LANGUAGES = new Set(['c', 'cpp', 'objc'])

/**
 * Which languages may name each other's declarations by a bare name — the unit the
 * project-wide name match is allowed inside. A TypeScript file cannot call a Swift
 * or Python declaration by name (the two talk through strings and bindings), so a
 * same-named declaration there is never its target; a `.cpp` file calls a header's
 * function all the time. Measured on a real 17,112-file project: 321,990 of its
 * 4,154,811 reference edges — 7.7% — crossed a family, 288,223 of them TypeScript
 * onto Swift declarations, and a Python `class Error` was the project's
 * most-referenced symbol on 23,556 of them.
 *
 * @param languageId - a language id as `languages.ts` spells it.
 * @returns the family: `js`, `c`, or the id itself for a language that is its own.
 */
export function languageFamily(languageId: string): string {
  if (JS_MODULE_LANGUAGES.has(languageId)) return 'js'
  if (C_FAMILY_LANGUAGES.has(languageId)) return 'c'
  return languageId
}

/** A manifest larger than this is not one anyone reads by hand; its name is not read. */
const MAX_PACKAGE_JSON_BYTES = 1_000_000

/** What one pass did. */
export interface IndexOutcome {
  /** Files parsed in this pass. */
  readonly parsed: number
  /** Files whose `mtime`/`size` matched the graph, so they were skipped. */
  readonly skipped: number
  /** Paths removed from the graph because they are no longer on disk. */
  readonly removed: number
  /** True when {@link MAX_FILES} stopped the walk before the tree was exhausted. */
  readonly truncated: boolean
  /** Files skipped because their grammar is NOT INSTALLED (a download fixes it). */
  readonly missingLanguage: number
  /** Files skipped because this plugin has no extraction rules for an installed grammar. */
  readonly noRules: number
  /** Files whose parse produced an ERROR node; their symbols are partial. */
  readonly parseErrors: number
  /** Files present but not indexed because they exceed the size limit. */
  readonly tooLarge: number
  /**
   * Paths the walk skipped because a `.gitignore` rule excludes them.
   *
   * Counted rather than hidden: a graph that covers less than the tree must be
   * able to say why, and "your `.gitignore` excludes 4000 files" is a different
   * fact from "the index gave up". A pruned directory counts as one path.
   */
  readonly ignored: number
  /**
   * Files the walk skipped because they are generated, by name, by header
   * banner. Separate from {@link ignored} because nobody excluded these — they
   * are tracked files that no human wrote.
   */
  readonly generated: number
  /** Wall time of the pass. */
  readonly durationMs: number
  /**
   * True when the removal pass did NOT run.
   *
   * Deleting from the graph is only safe when the scan is trustworthy: a
   * truncated walk or an unreadable root both produce a SHORTER file list than
   * the disk really has, and treating that as "these files are gone" would
   * silently drop most of a project. The pass then reports `removalSkipped` and
   * keeps the old rows — a graph that is stale is recoverable, a graph that
   * deleted half a repository is not.
   */
  readonly removalSkipped: boolean
}

/**
 * The pass was cancelled by its owner.
 *
 * A queue that can be told "stop this project" needs the pass to have a way out:
 * otherwise `forget` would either return while the pass keeps writing, or wait for a
 * full walk of a project the user just deleted. The class exists rather than a bare
 * `AbortError` so `queue.ts` can recognise a cancellation and refuse to record it as a
 * structural failure — a cancelled pass is not a broken one.
 */
export class IndexAbortedError extends Error {
  constructor() {
    super('the index pass was aborted')
    this.name = 'IndexAbortedError'
  }
}

/**
 * Was this pass cancelled?
 *
 * The two phases need to know before they run their RECOVERY path, because that path
 * opens a transaction of its own (`forgetStatCache`). A cancelled pass must stop
 * without writing anything: the caller is closing the graph handle, so a write there
 * is a closed-database error at best and a write after teardown at worst.
 *
 * @param error - whatever the phase caught.
 * @returns true when the pass was cancelled rather than broken.
 */
export function isAborted(error: unknown): boolean {
  return error instanceof IndexAbortedError || (error instanceof Error && error.name === 'IndexAbortedError')
}

/** `git rev-parse HEAD` in a directory, or '' when it is not a repository. */
export async function gitHead(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
    })
    return stdout.trim()
  } catch {
    // Not a repository, or no commits yet. Both mean "no HEAD to compare",
    // which the stale check treats as "cannot prove freshness".
    return ''
  }
}

/** What one file the walk found, before parsing. */
interface Candidate {
  readonly path: string
  readonly mtime: number
  readonly size: number
  /**
   * True when this is a DOCUMENT (prose that names symbols) rather than source.
   *
   * The distinction has to be carried out of the walk rather than re-derived
   * later: both kinds end up as rows in `files`, and a second `languageForPath`
   * call at the use site is how a document would one day be handed to a parser.
   */
  readonly document: boolean
}

/** A path's extension, lower case, with its dot; empty when it has none. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash || dot < 0) return ''
  return path.slice(dot).toLowerCase()
}

/** What a walk produced, including the facts that decide whether deletion is safe. */
export interface ScanResult {
  readonly files: Candidate[]
  /** True when {@link MAX_FILES} cut the walk short. */
  readonly truncated: boolean
  /** Files that exist but were skipped for size; never candidates for deletion. */
  readonly tooLarge: string[]
  /**
   * Paths that exist but a `.gitignore` rule excludes.
   *
   * A pruned directory is listed once, with a trailing `/`, because the walk does
   * not descend to enumerate it; the `/` is what tells the removal pass that the
   * entry covers a subtree.
   */
  readonly ignored: string[]
  /** Files that exist but are generated, by name, by header banner or by line shape. */
  readonly generated: string[]
  /**
   * True when the ROOT itself could not be read.
   *
   * An unreadable subdirectory is tolerable (it may be a permission quirk), but
   * an unreadable root means the scan learned nothing, and the caller must not
   * treat its empty result as "everything is gone".
   */
  readonly rootUnreadable: boolean
  /**
   * The package names the project's own `package.json` files declare, in walk order.
   *
   * What tells a workspace package (`@acme/ui`, whose sources are in the walk) from
   * an installed one (`react`, under `node_modules`) when a file imports by bare
   * specifier — see {@link isExternalSpecifier}. Empty for a project without
   * manifests, which is every non-JS project and a plain single-package app that
   * imports nothing of its own by name.
   */
  readonly packages: readonly string[]
}

/**
 * The `name` a package.json declares, or `undefined` when the file is not a
 * readable manifest that has one.
 *
 * A manifest that fails here is not an error to raise: the walk is deciding what
 * to index, and a package it cannot name is simply not known as a project module
 * (`isExternalSpecifier` then falls back to the installed-package test, which is
 * the pre-manifest behaviour). Nothing is indexed from the file either way.
 */
function readPackageName(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_PACKAGE_JSON_BYTES) return undefined
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const name = (parsed as { name?: unknown }).name
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

/** The first bytes of a file decoded as UTF-8, or '' when it cannot be read. */
function readHead(absolute: string, bytes: number): string {
  let fd: number
  try {
    fd = openSync(absolute, 'r')
  } catch {
    return ''
  }
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
  }
}

/** The contents of a directory's `.gitignore`, or undefined when it has none. */
function readIgnoreFile(absolute: string): string | undefined {
  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The walk's refusals, in the two shapes the removal pass needs.
 *
 * A path the walk refused is still ON DISK. Comparing the graph against the
 * walked files alone reads every one of them as a deletion, so they are collected
 * here once and consulted by `projectChanged` as well as by the pass itself — a
 * check that disagreed with the pass about which files count would report a
 * change the pass then has nothing to do about, on every single run.
 */
interface WalkSkips {
  /** Refused paths that name exactly one file or directory. */
  readonly exact: ReadonlySet<string>
  /** Refused directories, which cover everything beneath them. */
  readonly directories: ReadonlySet<string>
}

function walkSkips(scan: ScanResult): WalkSkips {
  const exact = new Set<string>(scan.tooLarge)
  const directories = new Set<string>()
  for (const entry of scan.ignored) {
    if (entry.endsWith('/')) directories.add(entry.slice(0, -1))
    else exact.add(entry)
  }
  for (const entry of scan.generated) exact.add(entry)
  return { exact, directories }
}

/** Does this path fall under something the walk refused? */
function skippedByWalk(skips: WalkSkips, path: string): boolean {
  if (skips.exact.has(path)) return true
  if (skips.directories.size === 0) return false
  const segments = path.split('/')
  let prefix = ''
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    if (skips.directories.has(prefix)) return true
  }
  return false
}

/**
 * Walk a project for parseable files.
 *
 * @param root - the absolute project root.
 * @param limit - the file budget.
 * @param indexed - paths the graph already holds. A file that is already indexed was
 *   judged not-generated by the pass that read it, so its header does not have to be
 *   read again — which is what keeps `projectChanged` (a read-only check that runs
 *   after every settled tool call) from opening every source file in the project. The
 *   verdict is therefore STICKY for an indexed file: if one later gains a generation
 *   banner, its symbols still follow its bytes (the hash re-parses it) but it is not
 *   dropped as generated. That is the trade — one imprecise exclusion, against opening
 *   N files after every tool call.
 * @returns the candidates plus the facts that decide whether removal is safe.
 */
export function scanProject(root: string, limit = MAX_FILES, indexed?: ReadonlySet<string>): ScanResult {
  const files: Candidate[] = []
  const tooLarge: string[] = []
  const ignored: string[] = []
  const generated: string[] = []
  const packages = new Set<string>()
  let truncated = false

  /**
   * @param dir - the absolute directory to read.
   * @param base - its project-relative POSIX path, `''` at the root.
   * @param inherited - the `.gitignore` rules in force from its ancestors.
   */
  const walk = (dir: string, base: string, inherited: readonly IgnoreRule[]): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // An unreadable SUBdirectory is skipped; the root is checked below.
      return
    }
    const own = readIgnoreFile(join(dir, '.gitignore'))
    const rules = own === undefined ? inherited : [...inherited, ...parseGitignore(own, base)]
    for (const entry of entries) {
      if (truncated) return
      // Built from the walk's own segments rather than `path.relative`: the graph
      // stores POSIX paths on every platform, and a Windows walk that formatted a
      // path through the shell's separator would key two files the same way.
      const relativePath = base === '' ? entry.name : `${base}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        if (isIgnored(rules, relativePath, true)) {
          // A negated rule can bring a file back out of an excluded directory, so
          // that directory has to be walked to find it. Any other ignored
          // directory is pruned as one entry, which is what keeps an excluded tree
          // of thousands of files from costing the walk anything.
          if (hasNegation(rules)) walk(join(dir, entry.name), relativePath, rules)
          else ignored.push(`${relativePath}/`)
          continue
        }
        walk(join(dir, entry.name), relativePath, rules)
        continue
      }
      if (!entry.isFile()) continue
      // The project's own package names, read where the walk's refusals (an ignored
      // or generated path) already apply, so a package whose sources are not in the
      // graph is not known as a project module. Before the candidate test, because
      // the manifest itself is never parsed: only its name is used, by the import
      // layer (`isExternalSpecifier`).
      if (entry.name === 'package.json') {
        if (!isIgnored(rules, relativePath, false)) {
          const name = readPackageName(join(dir, entry.name))
          if (name !== undefined) packages.add(name)
        }
        continue
      }
      // A document is walked for its own sake, not parsed. It carries no symbols
      // and no imports; what it contributes is the list of symbols it NAMES
      // (`docs.ts`), which the second phase turns into `documents` edges.
      const isDocument = DOCUMENT_EXTENSIONS.includes(extensionOf(relativePath))
      if (!isDocument && languageForPath(relativePath) === undefined) continue
      // AFTER the candidate test, so the count means "source files a rule took away"
      // rather than "every file in an ignored directory": a rule that excludes a
      // `.log` is worth nothing to a count of what the graph is missing.
      if (isIgnored(rules, relativePath, false)) {
        // Listed, never silently dropped: the file is on disk, so its absence from
        // `files` must not be read as a deletion.
        ignored.push(relativePath)
        continue
      }
      // Generation by NAME is settled before the file is opened: a `.min.js` is
      // generated in every project that has one, and reading its head to confirm
      // what its name already says costs a read per file per pass.
      if (isGeneratedPath(relativePath)) {
        generated.push(relativePath)
        continue
      }
      const absolute = join(dir, entry.name)
      let stat
      try {
        stat = statSync(absolute)
      } catch {
        continue
      }
      if (stat.size > MAX_FILE_BYTES) {
        // Recorded, never silently dropped: a file that grew past the limit is
        // still on disk, so the removal pass must not treat it as gone.
        tooLarge.push(relativePath)
        continue
      }
      // The banner — and, for source files, the SHAPE of the head — are checked
      // during the walk rather than when the bytes are parsed, because the two
      // callers of this walk have to agree: `projectChanged` never parses, so a
      // verdict that needed the parse would leave a generated file looking "new"
      // to the check on every pass forever.
      //
      // The shape rule (a bundler's thousand-character lines) is for source only:
      // prose is written one paragraph per line, and a README with long
      // paragraphs is what it would otherwise call generated.
      if (!(indexed?.has(relativePath) ?? false)) {
        const head = readHead(absolute, GENERATED_HEAD_BYTES)
        if (isGeneratedHead(head) || isGeneratedShape(head, isDocument)) {
          generated.push(relativePath)
          continue
        }
      }
      if (files.length >= limit) {
        truncated = true
        return
      }
      files.push({ path: relativePath, mtime: Math.floor(stat.mtimeMs), size: stat.size, document: isDocument })
    }
  }

  let rootUnreadable = false
  try {
    readdirSync(root)
  } catch {
    rootUnreadable = true
  }
  if (!rootUnreadable) walk(root, '', [])
  return { files, truncated, tooLarge, ignored, generated, packages: [...packages], rootUnreadable }
}

/**
 * Resolve one import specifier to a project-relative path, or undefined.
 *
 * Deliberately minimal, and honest about it: relative specifiers resolve against
 * the importing file; a bare specifier (`react`, `@deepseek-ai/…`) is a package
 * and has no file in this project, so it resolves to nothing rather than to a
 * guess. Extension completion tries the exact path first, then the common
 * additions, then `index.*` — the three shapes a real import takes.
 *
 * A resolver that guesses would turn "this package is external" into "this file
 * depends on some other file with a similar name", which is worse than no edge.
 *
 * @param from - the importing file's project-relative path.
 * @param specifier - the raw specifier.
 * @param exists - predicate for "is this path in the project".
 * @returns the target path, or undefined.
 */
export function resolveImport(
  from: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = from.split('/').slice(0, -1)
  const parts = specifier.split('/')
  const stack = [...base]
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  const joined = stack.join('/')
  const candidates = [
    joined,
    `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.mjs`, `${joined}.cjs`,
    `${joined}.py`, `${joined}.go`, `${joined}.java`, `${joined}.cs`, `${joined}.c`, `${joined}.cpp`,
    `${joined}/index.ts`, `${joined}/index.tsx`, `${joined}/index.js`,
  ]
  return candidates.find(candidate => exists(candidate))
}

/** The package a bare specifier names: `@scope/name/sub` and `name/sub` both name the package, not the subpath. */
function packageOf(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] ?? ''
}

/**
 * Is this import specifier a module OUTSIDE the project? Only what is certain.
 *
 * The import layer (`linkFor` in parse.ts) falls back to a project-wide name match
 * when a clause cannot say which project file declares a name. That is right for a
 * barrel and wrong for a module the project does not contain: the clause then says
 * exactly where the name lives, and the fallback contradicts it. Measured on a real
 * 1728-file TypeScript project, 20,161 calls — 12% of all calls — named a symbol the
 * file had imported from an external module while some project file declared the same
 * name, and each became a reference to that unrelated declaration: `expect` (vitest)
 * 15,216, `join` (node:path) 2,874, `describe` 1,182. The overview ranked `describe`
 * the project's most-referenced symbol on the strength of 1,184 false edges.
 *
 * So the answer is `true` only for a specifier the project cannot contain:
 *   - a Node built-in (`node:*`, `fs`, `path`, …) — `isBuiltin` is the runtime's own
 *     list, not one maintained here;
 *   - a package the importer can resolve from a `node_modules` on the way up to the
 *     root ({@link installedPackages}), and that no `package.json` in the walk names —
 *     a workspace package is linked into `node_modules` too, and its sources ARE the
 *     project, which is why `installedPackages` also asks where the link POINTS.
 *
 * Everything else answers `false`, and the name keeps its project-wide match: a
 * tsconfig path alias, a `#subpath` import, a dependency that is not installed. An
 * uncertain clause MUST fall through — dropping a real caller is the worst answer
 * the graph can give, and a false edge is only a row the reader can discount. The
 * price of that bias is two known gaps (§10b of docs/agents/codegraph.md): a
 * module the runtime injects without installing it (`bun:test`) is never placed
 * outside, and a workspace package that is neither linked into `node_modules` nor
 * named by a manifest the walk read — an unreadable `package.json`, or one beyond
 * a truncated walk's cut — is placed outside by a package of the same name that
 * happens to be installed.
 *
 * @param specifier - the raw import specifier.
 * @param from - the importing file's project-relative path.
 * @param workspace - the package names the project's own manifests declare.
 * @param installed - whether this importer can resolve a package from a `node_modules`.
 * @returns true only when the specifier is certainly outside the project.
 */
export function isExternalSpecifier(
  specifier: string,
  from: string,
  workspace: ReadonlySet<string>,
  installed: (from: string, name: string) => boolean,
): boolean {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('#')) return false
  if (isBuiltin(specifier)) return true
  const name = packageOf(specifier)
  if (name === '' || workspace.has(name)) return false
  return installed(from, name)
}

/**
 * Whether an importing file can resolve a package from a `node_modules`, the way
 * Node resolves it: the importer's own directory first, then each ancestor up to the
 * project root.
 *
 * One lookup per (directory, package) per pass: the answer is the same for every
 * file in a directory, and a 1700-file pass would otherwise repeat it per file.
 * A project without a `node_modules` answers `false` for everything, which leaves
 * every name in the project-wide fallback — the behaviour before this existed.
 *
 * A `node_modules/<name>` that LINKS to a source directory of the project is not
 * an installed package ({@link linksIntoProject}): pnpm, yarn and npm all link
 * workspace packages this way, and treating one as installed would drop every
 * reference to it by name exactly when its manifest was not read.
 *
 * @param root - the absolute project root.
 * @returns (project-relative importer path, package name) → installed.
 */
export function installedPackages(root: string): (from: string, name: string) => boolean {
  const cache = new Map<string, boolean>()
  // Both sides of the comparison below go through the real path: a root spelled
  // with an 8.3 short name or through a link would otherwise never equal the real
  // path of the manifest it contains (measured in a temp-dir test: the link was
  // read as installed for exactly that reason).
  let realRoot = root
  try {
    realRoot = realpathSync.native(root)
  } catch { /* an unreadable root names nothing; the comparison keeps the spelling it was given */ }
  return (from, name) => {
    const start = dirname(from)
    const key = `${start}\u0000${name}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let found = false
    let dir = start
    for (;;) {
      const manifest = join(root, dir, 'node_modules', name, 'package.json')
      if (existsSync(manifest) && !linksIntoProject(realRoot, manifest)) {
        found = true
        break
      }
      if (dir === '' || dir === '.') break
      dir = dirname(dir)
    }
    cache.set(key, found)
    return found
  }
}

/**
 * Is this `node_modules/<name>/package.json` the project's own source rather than
 * an installed copy? The real path tells: a workspace link resolves to a source
 * directory under the root (`packages/ui`), an installed package's real path keeps
 * a `node_modules` segment (pnpm's `.pnpm/<name>/node_modules/<name>` store) or
 * leaves the root altogether. A real path that cannot be read answers "inside" —
 * the side that keeps the edge.
 *
 * @param realRoot - the project root's own real path.
 * @param manifest - the manifest path as resolved from the importer.
 * @returns true when the manifest's real location is a source directory of the project.
 */
function linksIntoProject(realRoot: string, manifest: string): boolean {
  let real: string
  try {
    real = realpathSync.native(manifest)
  } catch {
    return true
  }
  const within = relative(realRoot, real)
  return within !== '' && !isAbsolute(within) && !within.startsWith('..') && !within.split(/[\\/]/u).includes('node_modules')
}

/**
 * The name→ids table for the whole project, read once.
 *
 * Project-wide rather than pass-local, and that part is load-bearing: the callee
 * may be declared in a file this pass SKIPPED (unchanged since the last run), so a
 * map built only from the files just parsed would make every reference into an
 * unchanged file vanish.
 *
 * Read in ONE query for the same reason: the first version ran a `SELECT` per call
 * edge inside the phase-2 transaction, and on a 1613-file project that resolved
 * tens of thousands of times and held the kernel's event loop for 251 seconds.
 *
 * @param graph - the open graph.
 * @returns name → every id carrying it (an ambiguous name stays ambiguous, which
 *   is what `callEdges` checks before drawing an edge).
 */
function namesIndex(graph: Graph): (name: string) => readonly string[] {
  const byName = new Map<string, string[]>()
  for (const row of allRows<{ id: string, name: string }>(graph.db, `SELECT id, name FROM symbols WHERE ${NAME_RESOLVABLE}`)) {
    const list = byName.get(row.name)
    if (list === undefined) byName.set(row.name, [row.id])
    else list.push(row.id)
  }
  return (name) => byName.get(name) ?? []
}

/**
 * Drop the stat-cache row of every file a failed phase left without its edges.
 *
 * Phase 1 commits each file's `mtime`/`size`/`hash` before phase 2 builds its
 * edges, so a phase 2 failure would otherwise leave the graph claiming those files
 * are unchanged — the next pass skips them and the edges never come back. With no
 * `files` row the next pass re-parses the file, which is the only way to rebuild
 * the edges phase 1's range delete already removed.
 *
 * Only the `files` row goes: the symbols stay, so the graph still answers
 * `codegraph_find` for these files while the next pass repairs their edges.
 *
 * @param graph - the open graph.
 * @param entries - the files whose edges are missing, at minimum their `path`.
 */
function forgetStatCache(graph: Graph, entries: readonly { readonly path: string }[]): void {
  if (entries.length === 0) return
  const drop = graph.db.prepare('DELETE FROM files WHERE path = ?')
  graph.db.exec('BEGIN')
  try {
    for (const entry of entries) drop.run(entry.path)
    graph.db.exec('COMMIT')
  } catch (error) {
    try { graph.db.exec('ROLLBACK') } catch { /* already rolled back */ }
    // A failure here must not mask the phase error the caller is already carrying;
    // the next pass still re-reads these files because their mtime never moved on.
    void error
  }
}

/**
 * Did the working tree actually change since the last pass?
 *
 * THE QUESTION A READ-ONLY TOOL RESULT MAY NOT ANSWER WITH "STALE". A tool result
 * says a tool ran, not that it wrote anything: `Read`, `Grep`, a test run, a build that
 * produced identical bytes. Marking the graph `stale` on that evidence reports work
 * nobody did — and because a query then re-arms the same check, a stream of read-only
 * calls would keep a project permanently `stale` and permanently walking.
 *
 * So the decision is made from the SAME comparison `indexProject` uses, without
 * writing anything: a file whose `mtime`+`size` differ from its recorded row, a
 * recorded file that is gone, or a file the graph has never seen. That is exactly the
 * set the next pass would parse, so "changed" here and "the pass has work to do" are
 * the same fact rather than two estimates of it.
 *
 * It reads the disk and the graph — nothing is written — so it is safe to run on every
 * debounced check, and it costs one directory walk plus one query. A pass that follows
 * it re-scans; that is the cost of the honest answer, and it is bounded by the same
 * debounce as the pass itself.
 *
 * `removalSkipped` (a truncated walk or an unreadable root) must NOT answer `false`.
 * "Unchanged" is a claim about a comparison this call did not make: an unreadable root
 * means the walk learned nothing, and a truncated walk means it stopped early, so
 * neither can prove that nothing moved. Answering `false` there reported a broken
 * project as up to date — the caller then kept `current`, and the model was told the
 * graph had been checked and was complete. Both cases answer `true` instead: the pass
 * runs, records `removalSkipped` (so the answer carries "deletions were not verified"),
 * and performs no removal of its own — which is the pass's existing budget rule, not a
 * new one.
 *
 * @param graph - the open graph for this project.
 * @param root - the absolute project root.
 * @param limit - the file budget the pass would use.
 * @returns true when the next pass would parse or remove anything, OR when this check
 *   could not see enough of the tree to say it would not.
 */
export function projectChanged(graph: Graph, root: string, limit = MAX_FILES): boolean {
  const known = readFiles(graph.db)
  const scan = scanProject(root, limit, new Set(known.keys()))
  // Cannot prove "nothing changed": the walk was cut short or could not read the root.
  // `true` is the honest answer and the only safe one — `false` would let a caller
  // report a current, complete graph over a tree this call never saw.
  if (scan.truncated || scan.rootUnreadable) return true
  // The walk's refusals are seeded for the same reason `indexProject` seeds them: a
  // file that is too large, excluded by `.gitignore` or generated LEAVES `scan.files`
  // while staying on disk, and comparing against that set alone reads the absence as
  // a deletion — a change reported on every pass forever.
  const skips = walkSkips(scan)
  const seen = new Set<string>(skips.exact)
  for (const candidate of scan.files) {
    seen.add(candidate.path)
    const previous = known.get(candidate.path)
    // Never indexed, or the recorded stat moved.
    if (previous === undefined || previous.mtime !== candidate.mtime || previous.size !== candidate.size) return true
  }
  for (const path of known.keys()) {
    if (seen.has(path) || skippedByWalk(skips, path)) continue
    return true
  }
  return false
}

/**
 * Run one incremental pass over a project.
 *
 * `parse` is injected rather than imported so this module stays free of
 * tree-sitter: the parse itself needs the grammar loader and the wasm runtime,
 * and a test that only cares about the diffing should not have to load either.
 *
 * **INCREMENTAL EVIDENCE IS PART OF THE RESULT.** `parsed` and `removed` are what
 * decide whether the working tree actually moved: a pass over an unchanged project
 * parses nothing and removes nothing, which is the fact the caller needs before it
 * says "stale" to anyone. That is why the outcome carries them rather than only a
 * total.
 *
 * **CANCELLABLE.** `signal` aborts the pass at its next checkpoint, including the
 * one before the first file and the one before the metadata write. The queue passes
 * the controller's signal, so deleting a project (or unloading the plugin) stops the
 * pass instead of letting it write into a database whose handle was just closed. A
 * cancelled pass throws {@link IndexAbortedError} and commits nothing further.
 *
 * @param graph - the open graph for this project.
 * @param root - the absolute project root.
 * @param parse - turns a source string into symbols and edges for one file.
 * @param now - clock, injectable for tests.
 * @param limit - the file budget.
 * @param signal - cancellation for the pass.
 * @returns what the pass did.
 */
export async function indexProject(
  graph: Graph,
  root: string,
  parse: (source: string, path: string, languageId: string) => ParsedFile | Promise<ParsedFile>,
  now: () => number = Date.now,
  limit = MAX_FILES,
  signal?: AbortSignal,
): Promise<IndexOutcome> {
  const started = now()
  const checkAborted = (): void => { if (signal?.aborted === true) throw new IndexAbortedError() }
  checkAborted()
  const known = readFiles(graph.db)
  const scan = scanProject(root, limit, new Set(known.keys()))
  const skips = walkSkips(scan)
  const seen = new Set<string>(skips.exact)

  let parsed = 0
  let skipped = 0
  let missingLanguage = 0
  let noRules = 0
  let parseErrors = 0
  /**
   * Whether phase 3 has to re-derive document edges this pass.
   *
   * Set by anything that can change the answer: a document whose bytes changed, or
   * a source file that contributed or retired symbols (a mention resolves against
   * the symbol table, so a new declaration makes an old paragraph point somewhere
   * new). When neither happened the previous pass's edges are still correct, and
   * re-deriving them costs a full re-read of every document — measured at 64
   * seconds on a real project before the fan-out was capped, and still the single
   * most expensive step afterwards.
   */
  let documentsDirty = false
  let symbolsChanged = false

  // Two phases, because a call edge needs the CALLEE to be in the graph already
  // and the walk order is arbitrary: `a.ts` calling `beta` must resolve whether
  // `b.ts` was parsed before or after it. Phase 1 writes every changed file's
  // symbols and contains edges; phase 2 resolves the calls against the finished
  // symbol table.
  const pending: { path: string, fileId: string, parsed: ParsedFile, registrations: readonly Registration[] }[] = []

  /**
   * Yield to the event loop, so a long pass does not freeze the kernel.
   *
   * BY TIME, not by a file count. The first version yielded every 64 files, which
   * reads as "bounded" and is not: 64 files that each need a full tree-sitter parse
   * and a transaction is seconds of a blocked event loop, and the kernel serves the
   * whole UI from it — measured on a 1930-file project, the window went dead with an
   * empty settings pane and a graph view stuck on "loading".
   *
   * A time budget is what actually bounds the stall: 8ms of work then one turn of
   * the loop, whatever the files weigh.
   */
  const BREATHE_MS = 8
  let lastBreathe = Date.now()
  const breatheIfDue = async (): Promise<void> => {
    if (Date.now() - lastBreathe < BREATHE_MS) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
    // Cancellation is checked HERE as well as before each file, because a long
    // sequence of cheap files (stat-cache hits) never reaches the file checks if the
    // only check is inside the parse branch.
    checkAborted()
    lastBreathe = Date.now()
  }

  for (const candidate of scan.files) {
    // Cancellation before each file: a pass over a 20 000-file tree must stop at the
    // next file, not at the next phase.
    checkAborted()
    seen.add(candidate.path)
    const previous = known.get(candidate.path)
    if (previous !== undefined && previous.mtime === candidate.mtime && previous.size === candidate.size) {
      skipped += 1
      continue
    }
    // Documents take their own path: their row is stored (so the stat cache stops
    // a re-read every pass), and they are never handed to a parser and never
    // declare a symbol. Their TEXT is re-read in phase 3, which scans every known
    // document — see the comment there for why that is not just this pass's
    // changed ones.
    if (candidate.document) {
      let docHash: string
      try {
        const bytes = readFileSync(join(root, candidate.path))
        docHash = createHash('sha256').update(bytes).digest('hex')
      } catch {
        // Vanished between the scan and the read; `seen` already holds it, so the
        // removal pass leaves its old rows for the next run.
        continue
      }
      if (previous !== undefined && previous.hash === docHash) {
        graph.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?')
          .run(candidate.mtime, candidate.size, candidate.path)
        skipped += 1
        continue
      }
      replaceFile(graph.db, { path: candidate.path, mtime: candidate.mtime, size: candidate.size, hash: docHash, lang: 'document' }, [], [])
      documentsDirty = true
      continue
    }
    const language = languageForPath(candidate.path)
    if (language === undefined) continue
    let source: string
    let hash: string
    try {
      const bytes = readFileSync(join(root, candidate.path))
      // One read: the hash comes from the same bytes the parse sees, so a file
      // edited between two reads cannot record a hash that describes neither.
      hash = createHash('sha256').update(bytes).digest('hex')
      source = bytes.toString('utf8')
    } catch {
      // Vanished between the scan and the read. It stays in `seen`, so the
      // removal pass leaves its old rows for the next run to settle.
      continue
    }
    if (previous !== undefined && previous.hash === hash) {
      // Same bytes, new timestamp: a checkout, a stash, a touch. Record the new
      // stamp, or every later pass re-reads and re-hashes this file forever.
      graph.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?')
        .run(candidate.mtime, candidate.size, candidate.path)
      skipped += 1
      continue
    }
    const result = await parse(source, candidate.path, language.id)
    if (result.unsupported !== false) {
      // The file row is still written: it is the stat cache, and without it this
      // file is re-read and re-parsed on every pass forever. `lang` records what
      // it would need, which is what the settings page counts.
      if (result.unsupported === 'missing') missingLanguage += 1
      else noRules += 1
      graph.db.prepare('INSERT INTO files (path, mtime, size, hash, lang) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash, lang = excluded.lang')
        .run(candidate.path, candidate.mtime, candidate.size, hash, language.id)
      continue
    }
    if (result.hasError) parseErrors += 1
    const record: FileRecord = {
      path: candidate.path,
      mtime: candidate.mtime,
      size: candidate.size,
      hash,
      lang: language.id,
    }
    const fileId = fileNodeId(candidate.path)
    // The declarations a file gains from its registrations (an inline handler, a
    // route) and the registrations themselves, so a dispatch in another file can
    // find them after this file is never parsed again (synthesis.ts).
    const synthesis = synthesizeFile(candidate.path, result.calls, result.symbols, importedNames(result))
    const symbols = [...result.symbols, ...synthesis.symbols]
    // Phase 1: symbols plus the `contains` edges that need nothing but this file.
    replaceFile(graph.db, record, symbols, symbols.map(symbol => ({
      from: fileId,
      to: symbol.id,
      kind: 'contains' as const,
      line: symbol.line,
    })), synthesis.registrations)
    pending.push({ path: candidate.path, fileId, parsed: result, registrations: synthesis.registrations })
    symbolsChanged = true
    parsed += 1
    // After EVERY file, decided by elapsed time rather than a file count: the call
    // is cheap when it is not due, and it is the only thing standing between a
    // 2000-file pass and a kernel that cannot answer the UI.
    await breatheIfDue()
  }

  // Phase 2: the calls and imports, now that every changed file's symbols are
  // present.
  //
  // WHY THE FILES ROWS ARE DELETED ON FAILURE. Phase 1 already committed each
  // file's `mtime`/`size`/`hash` (inside `replaceFile`), and phase 2 runs in
  // BATCHES of `FILES_PER_COMMIT` so a large pass can yield to the event loop. A
  // failure therefore rolls back only the batch in flight: every earlier batch
  // stays committed, and — worse — the `files` rows from phase 1 stay too. The
  // next pass then skips those files by mtime, `pending` is empty, and the
  // `references` edges phase 1's range delete removed are never rebuilt. The graph
  // reports `current` while under-reporting every caller of those files.
  //
  // So a failure deletes the `files` rows for everything still pending: without a
  // stat-cache row the next pass re-parses the file and rebuilds its edges. This
  // is the invariant the old single-transaction version got for free and the
  // batched version has to restore explicitly.
  if (pending.length > 0) {
    // `narrowed` rides along with the name-resolved kinds; an `imports` edge below
    // binds the column to 0, which is what a kind that never resolves by name carries.
    // `provenance` is 'parse' for every edge the grammar produced and the pairing's
    // name for a synthesized one (synthesis.ts).
    const insert = graph.db.prepare('INSERT OR IGNORE INTO edges (src, dst, kind, line, narrowed, provenance) VALUES (?, ?, ?, ?, ?, ?)')
    const insertResolved = (edge: EdgeRecord): void => {
      insert.run(edge.from, edge.to, edge.kind, edge.line, edge.narrowed === true ? 1 : 0, edge.provenance ?? 'parse')
    }
    // `imports` targets are project-relative paths; the graph's file nodes are
    // keyed the same way, so membership in the known set is the resolution test.
    // What an import may resolve TO: the files the graph already holds, plus the ones
    // this pass is about to write. The walk's skips are deliberately NOT here — an
    // `import './dist/bundle.js'` that targets an ignored file would otherwise get an
    // `imports` edge pointing at a node no pass ever creates, and nothing would ever
    // clean it up.
    const knownPaths = new Set<string>([...known.keys(), ...scan.files.map(entry => entry.path)])
    // ONE query for the whole name table, not one per call edge.
    //
    // `resolveName` used to run a SELECT per edge, inside this transaction, and
    // that is what made a real pass unusable: a 1613-file project resolves tens of
    // thousands of edges, and measured end to end the pass held the kernel's event
    // loop for 251 SECONDS — the window went dead, the settings pane emptied, and
    // "new session" did nothing until it finished. The table is a few thousand rows,
    // so reading it once costs milliseconds and turns N queries into 1.
    const resolveOnce = namesIndex(graph)
    // The project-wide name match is bounded by LANGUAGE FAMILY (`languageFamily`):
    // a name resolves, for one file, only to declarations in files of its own
    // family. The same-file and import-clause layers are inside one module and so
    // one family by construction, which is why the bound can sit on the resolver
    // they all share. Path → family, read once: a lookup per candidate id is a
    // slice to the `#` and a map read, against the 165,000 times per pass the
    // resolver runs on a real project.
    const familyByPath = new Map<string, string>()
    for (const row of allRows<{ path: string, lang: string }>(graph.db, 'SELECT path, lang FROM files')) {
      familyByPath.set(row.path, languageFamily(row.lang))
    }
    const familyOfId = (id: string): string => familyByPath.get(id.slice(0, id.indexOf('#'))) ?? ''
    /** The name resolver as one file may use it: every declaration of the name in its own family. */
    const resolveIn = (path: string): ((name: string) => readonly string[]) => {
      const family = familyByPath.get(path)
      if (family === undefined) return resolveOnce
      return name => resolveOnce(name).filter(id => familyOfId(id) === family)
    }
    // Every changed file's symbols are in the graph now, so a handler a file
    // imports can be pointed at its declaration (synthesis.ts). Before the
    // dispatch edges, which read the registrations these targets belong to.
    refineRegistrationTargets(graph.db)
    const registrationsOf = (kind: RegistrationKind, key: string): Registration[] => registrationsFor(graph.db, kind, key)
    /**
     * Files per transaction, and the yield between them.
     *
     * The phase used to be one transaction with no yield, so a 1600-file project
     * held the kernel's event loop for its whole duration (measured: seconds of a
     * dead window). A file's edges are independent of the next file's, so batching
     * them costs nothing and gives the loop a turn between batches.
     */
    const FILES_PER_COMMIT = 50
    let inBatch = 0
    // What the import layer may call a module OUTSIDE the project: the walk's own
    // package names against the packages this tree has installed (isExternalSpecifier).
    const workspace = new Set(scan.packages)
    const installed = installedPackages(root)
    graph.db.exec('BEGIN')
    try {
      for (const entry of pending) {
        // The import layer: a call to a name declared in several files links to the
        // one this file actually imports. The same resolver serves `imports` and the
        // re-export edges below — a re-export and an import name a path in exactly the
        // same way, so a star edge points at the node the rest of the graph uses
        // instead of at a `./`-relative string that joins to nothing.
        const modulePath = (specifier: string): string | undefined => resolveImport(entry.path, specifier, path => knownPaths.has(path))
        // A name this file imports from a module outside the project is not linked
        // to a same-named project declaration. Only for the languages whose imports
        // are JS module specifiers.
        const isExternal = JS_MODULE_LANGUAGES.has(languageForPath(entry.path)?.id ?? '')
          ? (specifier: string): boolean => isExternalSpecifier(specifier, entry.path, workspace, installed)
          : undefined
        const resolveHere = resolveIn(entry.path)
        for (const edge of callEdges(entry.parsed, entry.fileId, resolveHere, modulePath, isExternal)) {
          insertResolved(edge)
        }
        // Heritage and type references, resolved the same way calls are. These are
        // the edges that let `impact` answer "who implements this interface" and
        // "which signatures name this type" — neither is a call, so `callEdges`
        // could never produce them.
        for (const edge of relationEdges(entry.parsed, entry.fileId, resolveHere, modulePath, isExternal)) {
          insertResolved(edge)
        }
        // The synthesized edges (synthesis.ts): this file's dispatches against the
        // registrations the whole graph holds, and its routes against their
        // handlers. `narrowed` is 0 on all of them — nothing here resolved a
        // name — and `provenance` is what tells the reader how they were made.
        for (const edge of dispatchEdges(entry.parsed.calls, entry.fileId, registrationsOf)) insertResolved(edge)
        for (const edge of routeEdges(entry.registrations, (handler, path) => resolveHandler(graph.db, handler, path))) insertResolved(edge)
        for (const specifier of entry.parsed.imports) {
          const target = modulePath(specifier.specifier)
          if (target === undefined) continue
          insert.run(entry.fileId, fileNodeId(target), 'imports', specifier.line, 0, 'parse')
        }
        inBatch += 1
        if (inBatch >= FILES_PER_COMMIT) {
          graph.db.exec('COMMIT')
          inBatch = 0
          await new Promise<void>(resolve => { setImmediate(resolve) })
          // CHECKED AFTER EVERY YIELD, not only at the phase's entry. A long phase 2
          // yields ~once per 50 files, and a cancellation that arrives during one of
          // those turns must stop the pass BEFORE the next transaction opens — otherwise
          // the pass keeps writing after the caller closed the graph.
          checkAborted()
          graph.db.exec('BEGIN')
        }
      }
      graph.db.exec('COMMIT')
    } catch (error) {
      // A CANCELLED PASS MUST NOT WRITE. `forgetStatCache` opens its own transaction, so
      // running it here would be a write after the abort — exactly the "closed database"
      // failure a teardown produces. The recovery it performs is for a FAILED pass; a
      // cancelled one is finished, and the next explicit pass re-reads whatever it left.
      if (!isAborted(error)) {
        try { graph.db.exec('ROLLBACK') } catch { /* already rolled back */ }
        forgetStatCache(graph, pending)
      }
      throw error
    }
  }

  // Phase 3: the documents. Deliberately AFTER phase 2, because a `documents`
  // edge targets a symbol and a document may name one declared in a file the walk
  // reached later.
  //
  // TWO decisions here, each fixing a defect the first version shipped:
  //
  //   - The edge targets `file:<docpath>`, with the LINE in the `line` column,
  //     instead of a `doc:<path>#<line>` pseudo-node. A doc node is in no table,
  //     so nothing that reclaims a path knew to reclaim it: deleting a document
  //     left its edges as permanent orphans. A file node is what `forgetFile`
  //     already sweeps, and the primary key `(src, dst, kind, line)` keeps the
  //     same document's several mentions apart.
  //   - The scan covers EVERY known document on every pass, not only the ones
  //     whose bytes changed. `replaceFile` deletes every outgoing edge of a file's
  //     symbols, so editing `a.ts` removed the edges INTO a.ts's symbols from
  //     documents that had not changed — and only a changed document was ever
  //     rescanned, so they never came back. Rescanning all of them costs a few
  //     hundred file reads; tracking which name appears in which document costs a
  //     second index and a new way to be wrong.
  const documentPaths = allRows<{ path: string }>(graph.db, 'SELECT path FROM files WHERE lang = ?', 'document')
  // Re-derived only when the answer can have changed: a document whose bytes moved,
  // or a source file that added or retired symbols (a mention resolves against the
  // symbol table). When neither happened the previous edges are still correct, and
  // re-reading every document is the most expensive step of the pass.
  if (documentPaths.length > 0 && (documentsDirty || symbolsChanged)) {
    // The mention scan matches by NAME, but an edge needs a NODE id, and one name
    // can be declared in several places (a `render` in each component, an `open`
    // per class). Every declaration of a mentioned name gets the edge: guessing
    // which one a paragraph meant is exactly the confident-but-wrong edge this
    // plugin exists to avoid.
    const byName = new Map<string, SymbolRecord[]>()
    const declared: SymbolRecord[] = []
    // Every kind counts as a KNOWN name (a paragraph that spells `GET /x` names
    // something), but only a resolvable kind can be what a mention MEANS: a
    // synthesized handler's name is an IPC key, and a paragraph that says `open`
    // means the function, not the channel.
    for (const symbol of symbolsOf(graph.db)) {
      declared.push(symbol)
      if (!isResolvableKind(symbol.kind)) continue
      const existing = byName.get(symbol.name)
      if (existing === undefined) byName.set(symbol.name, [symbol])
      else existing.push(symbol)
    }
    const known2 = knownNames(declared)
    /**
     * How many declarations ONE mention may point at.
     *
     * This number is the whole cost of phase 3, and it was measured rather than
     * guessed. A real project's documents produced 103,334 mentions, and at 20
     * targets each that is two million inserts — 64 seconds inside one phase,
     * which froze the kernel. The scan itself is cheap (117ms for the same 127
     * documents); the fan-out is what costs.
     *
     * ONE. A paragraph that names `index` does not describe 300 unrelated
     * declarations, and a reader following the edge wants the one the author meant.
     * With a single target the phase is linear in mentions instead of
     * mentions × duplicates, and the answer stays useful: `context` still shows
     * the documents that name a symbol, which is the feature.
     */
    const MAX_TARGETS_PER_MENTION = 1
    // DELETE then INSERT inside one transaction. The delete is per DOCUMENT, not
    // per symbol, so a mention the author removed stops being an edge — the first
    // version only inserted, so a deleted paragraph kept its edge for ever.
    const clear = graph.db.prepare("DELETE FROM edges WHERE kind = 'documents' AND dst = ?")
    const insert = graph.db.prepare('INSERT OR IGNORE INTO edges (src, dst, kind, line) VALUES (?, ?, ?, ?)')
    /**
     * Documents per transaction, and the yield between them.
     *
     * This loop used to run inside ONE transaction with no yield, which is what
     * made a real project freeze the whole kernel: measured on a 1771-file project,
     * phase 3 alone ran past 200 seconds with the event loop held the entire time —
     * the window stopped answering, the settings pane came up empty, and "new
     * session" did nothing. The cost of the scan is not the problem; running it
     * without ever returning to the loop is.
     *
     * 25 is small enough that one batch is milliseconds and large enough that the
     * commit overhead stays negligible against the file reads.
     */
    const DOCS_PER_COMMIT = 25
    let inBatch = 0
    graph.db.exec('BEGIN')
    try {
      for (const row of documentPaths) {
        const target = fileNodeId(row.path)
        clear.run(target)
        let text: string
        try {
          text = readFileSync(join(root, row.path)).toString('utf8')
        } catch {
          // Gone between the walk and this read; `seen` already covered it, so the
          // removal pass settles the file row on the next run.
          continue
        }
        for (const mention of documentMentions({ path: row.path, text }, known2)) {
          // The edge points FROM the symbol TO the document: "this code is
          // described here", which is what `context` reads.
          const targets = byName.get(mention.name) ?? []
          const keep = targets.length > MAX_TARGETS_PER_MENTION ? targets.slice(0, MAX_TARGETS_PER_MENTION) : targets
          for (const symbol of keep) {
            insert.run(symbol.id, target, 'documents', mention.line)
          }
        }
        inBatch += 1
        if (inBatch >= DOCS_PER_COMMIT) {
          // Commit, then give the loop a turn. A batch that fails leaves the
          // documents before it committed and the rest for the next pass, which is
          // the same recovery the phase already has: the documents' file rows are
          // written, so a re-run re-derives their edges.
          graph.db.exec('COMMIT')
          inBatch = 0
          await new Promise<void>(resolve => { setImmediate(resolve) })
          // Same rule as phase 2: a cancellation that arrives during a yield stops the
          // pass before the next transaction, so nothing is written after the caller
          // closed the graph.
          checkAborted()
          graph.db.exec('BEGIN')
        }
      }
      graph.db.exec('COMMIT')
    } catch (error) {
      // Same rule as phase 2: `forgetStatCache` opens a transaction, so a cancelled pass
      // must not reach it — that would be a write after the abort.
      if (!isAborted(error)) {
        try { graph.db.exec('ROLLBACK') } catch { /* already rolled back */ }
        // Same recovery as phase 2, and for the same reason: a document whose edges
        // were cleared but not rewritten must be re-scanned. Its `files` row does not
        // decide that here (this phase re-reads every document when the pass is dirty),
        // but dropping it keeps one rule for both phases instead of two.
        forgetStatCache(graph, documentPaths.map(row => ({ path: row.path })))
      }
      throw error
    }
  }

  const removalSkipped = scan.truncated || scan.rootUnreadable
  let removed = 0
  if (!removalSkipped) {
    for (const path of known.keys()) {
      // Everything the walk refused is skipped here too, INCLUDING a path under an
      // ignored directory that was pruned rather than descended: `.gitignore` makes
      // the walk smaller without anything leaving the disk, and a removal pass that
      // read that as a deletion would empty the graph of every file it stopped
      // reading. Same rule as `tooLarge`, one predicate for both.
      if (seen.has(path) || skippedByWalk(skips, path)) continue
      checkAborted()
      forgetFile(graph.db, path)
      removed += 1
      symbolsChanged = true
    }
  }

  // The last checkpoint before the metadata write: after this the pass has declared
  // itself complete, so a cancellation that arrives earlier must win. Writing `meta`
  // for a project whose graph handle is about to close is exactly the "recreated after
  // delete" failure this checkpoint exists to prevent.
  checkAborted()
  const stats = graphStats(graph.db)
  const meta: ProjectMeta = {
    cwd: root,
    name: root.split(/[\\/]/u).filter(part => part !== '').pop() ?? root,
    head: await gitHead(root),
    indexedAt: now(),
    fileCount: stats.files,
    symbolCount: stats.symbols,
    edgeCount: stats.edges,
    truncated: scan.truncated,
    removalSkipped,
    generatedSkipped: scan.generated.length,
    missingLanguage,
    noRules,
    parseErrors,
  }
  writeProjectMeta(graph.db, meta)

  return {
    parsed,
    skipped,
    removed,
    truncated: scan.truncated,
    missingLanguage,
    noRules,
    parseErrors,
    tooLarge: scan.tooLarge.length,
    ignored: scan.ignored.length,
    generated: scan.generated.length,
    durationMs: now() - started,
    removalSkipped,
  }
}

/**
 * Whether a stored HEAD still describes the working tree.
 *
 * Three states, not two. `undefined` (never indexed) and a stored HEAD that
 * differs are both stale. An UNPROVABLE comparison — no repository, or no git on
 * PATH, which both answer `''` — is NOT stale: a graph that reports stale
 * forever would re-index on every query and never converge, because re-indexing
 * writes `''` again.
 *
 * @param meta - the stored metadata, or undefined.
 * @param head - the working tree's HEAD, or '' when it could not be read.
 * @returns true only when the graph is provably out of date.
 */
export function isStale(meta: ProjectMeta | undefined, head: string): boolean {
  if (meta === undefined) return true
  // No HEAD on either side: the project is not a repository (or git is absent),
  // so freshness cannot be judged by HEAD. The mtime comparison still governs
  // which files get re-parsed, so this is not a blind spot in practice.
  if (meta.head === '' && head === '') return false
  // A project that became a repository after indexing: the stored '' cannot
  // describe the new HEAD.
  if (meta.head === '') return true
  return meta.head !== head
}
