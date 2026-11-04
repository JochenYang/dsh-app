/**
 * What a walk refuses to read: `.gitignore` rules, and generated files.
 *
 * Everything here is a pure function over a path string. The `stat`/`read` that
 * the index pass spends on a file stays in `indexer.ts`; this module only
 * answers "is this path excluded, and why", so the answer can be tested without
 * a filesystem and the walk keeps one place to call.
 *
 * WHY `.gitignore` IS READ AT ALL. `SKIP_DIRS` names the directories a build
 * tool writes into, and it is a guess about somebody else's project: it misses
 * `target`-versus-`dist` variants, per-tree output names, and every project that
 * checks in thousands of fixture files. The repository's own `.gitignore` is the
 * project's authoritative statement about what is not source, and a walk that
 * ignores it indexes a `dist/` the author explicitly excluded. A wrong exclusion
 * is also cheap to be wrong about: it can only shrink the graph, and a file it
 * drops can always be found by name search in the editor.
 *
 * WHY GENERATED FILES ARE SEPARATE FROM IGNORED ONES. They are not excluded by
 * anybody's rule — they are tracked, they sit in `src/`, and they are still not
 * something a human wrote. Reporting them under the same counter as `.gitignore`
 * would tell the user their repository excludes a file that it does not.
 *
 * WHAT THIS LAYER DOES NOT IMPLEMENT, deliberately, and what it costs:
 *
 *   - **No backslash escapes.** `\!important`, `\#hash` and a trailing `\ ` are
 *     read literally, so the backslash becomes part of the pattern and the rule
 *     matches a path nobody has. Rare in real repositories, and the alternative
 *     is an escape stripper this walk would have to keep bug-compatible with
 *     git's C code.
 *   - **No character classes.** `[abc]`, `[!0-9]` and `[a-z]` are matched as
 *     literal text, so such a rule matches nothing. A rule that silently matches
 *     nothing is the failure mode both `.gitignore` readers and users find
 *     confusing, which is why this is written down here rather than only in the
 *     commit that shipped it.
 *   - **No global excludes** — not `core.excludesFile`, not
 *     `.git/info/exclude`. Those live outside the tree the walk can see, and a
 *     machine-local file that changed the graph on one machine would make the
 *     graph depend on something the project does not carry.
 *   - **Case-insensitive comparison.** git's default is case-sensitive, but the
 *     filesystem this app runs on (Windows, and macOS for most trees) is not: a
 *     rule written as `Dist/` has to exclude the `dist/` directory that is
 *     really there, otherwise the rule works on the author's machine and not on
 *     the user's. The cost is the mirror case — on a case-sensitive filesystem a
 *     rule can drop a file git would keep.
 *   - **Re-inclusion inside an excluded directory IS honoured.** `dist/` plus
 *     `!dist/keep.ts` keeps `keep.ts`, where git cannot re-include a file whose
 *     parent directory is excluded. The walk therefore cannot prune an ignored
 *     directory unconditionally: it descends into one when a negated rule is in
 *     force (see `hasNegation`), and otherwise prunes it as one entry, which is
 *     also what keeps an ignored `vendor/` from costing a full descent.
 *
 * @module @dsh-app/plugin-codegraph/host/ignore
 */

/** One parsed `.gitignore` line. */
export interface IgnoreRule {
  /** The directory the rule was read from, project-relative POSIX; `''` for the root. */
  readonly base: string
  /** True for a `!` line, which re-includes what an earlier rule excluded. */
  readonly negated: boolean
  /** True for a trailing `/`: the rule only matches a directory. */
  readonly dirOnly: boolean
  /**
   * True when the rule is relative to {@link base}.
   *
   * git's rule: a separator at the start or in the middle anchors the pattern to
   * the `.gitignore`'s own directory; a pattern without one matches that name at
   * any depth below it.
   */
  readonly anchored: boolean
  /** The pattern split on `/`, with `**` keeping its cross-directory meaning. */
  readonly segments: readonly string[]
}

/** How many bytes of a file's head are read for a generated banner. */
export const GENERATED_HEAD_BYTES = 4096

/**
 * How many lines of that head the banner is looked for in.
 *
 * A banner is put at the top by every generator worth detecting, while a prose
 * mention of "do not edit" can appear anywhere: a README that documents its own
 * generated table would otherwise be dropped from the graph as a build artifact.
 */
export const GENERATED_BANNER_LINES = 5

/** Path suffixes that mark a file as output of a generator. */
const GENERATED_SUFFIXES: readonly string[] = [
  '.g.dart', // Dart build_runner
  '.g.cs', // WPF / WinForms designer output beside a hand-written file
  '.designer.cs',
  '.generated.cs',
  '.pb.go', // protobuf codegen
  '.pb.cc',
  '.pb.h',
  '.pb.cs',
  '_pb2.py', // protobuf python
  '_pb2.pyi',
  '.min.js',
  '.min.mjs',
  '.min.css',
]

/** Filename fragments that mark a file as generated wherever they appear. */
const GENERATED_INFIXES: readonly string[] = ['_generated.', '.generated.']

/**
 * Comment banners a generator writes into its output.
 *
 * One list for the shapes that actually occur: `@generated` (GraphQL codegen,
 * many JS tools), `<auto-generated` (the `// <auto-generated />` line every .NET
 * designer writes), `DO NOT EDIT` (protoc, sqlc, most Go generators) and
 * `generated by` (the long form, `// Code generated by X. DO NOT EDIT.`).
 */
const GENERATED_BANNERS: readonly string[] = ['@generated', '<auto-generated', 'do not edit', 'generated by']

/** Compiled per-segment matchers. Patterns are few and repeat across every path. */
const SEGMENT_PATTERNS = new Map<string, RegExp>()

/** Escape the characters that are special to a regular expression. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** A glob segment as regular-expression source. `*` and `?` never cross a `/`. */
function globSource(pattern: string): string {
  let source = ''
  for (const char of pattern) {
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escapeLiteral(char)
  }
  return source
}

/** Match one path segment against one pattern segment. */
function segmentMatches(pattern: string, segment: string): boolean {
  let expression = SEGMENT_PATTERNS.get(pattern)
  if (expression === undefined) {
    expression = new RegExp(`^${globSource(pattern)}$`, 'iu')
    SEGMENT_PATTERNS.set(pattern, expression)
  }
  return expression.test(segment)
}

/**
 * Match a whole relative path against a pattern's segments.
 *
 * The one asymmetry that has to be right is the trailing `**`: `a/**` covers what
 * is INSIDE `a`, not `a` itself, while a leading `**` segment matches at any
 * depth including none.
 */
function segmentsMatch(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0
  const head = pattern[0]!
  const tail = pattern.slice(1)
  if (head === '**') {
    if (tail.length === 0) return path.length > 0
    for (let take = 0; take <= path.length; take += 1) {
      if (segmentsMatch(tail, path.slice(take))) return true
    }
    return false
  }
  if (path.length === 0) return false
  return segmentMatches(head, path[0]!) && segmentsMatch(tail, path.slice(1))
}

/** Does one rule match one subject, where `subject` is relative to the rule's base? */
function ruleMatches(rule: IgnoreRule, subject: readonly string[], directory: boolean): boolean {
  if (rule.dirOnly && !directory) return false
  if (!rule.anchored) {
    const last = subject[subject.length - 1]
    return last !== undefined && segmentMatches(rule.segments[0]!, last)
  }
  return segmentsMatch(rule.segments, subject)
}

/**
 * Parse one `.gitignore` document.
 *
 * @param text - the file's contents.
 * @param base - the directory the file was found in, project-relative POSIX
 *   (`''` for the project root).
 * @returns the rules, in file order — the order IS the precedence, so a later
 *   negated line can undo an earlier one.
 */
export function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/u)) {
    // Trailing whitespace is trimmed because an editor leaves it behind and git
    // does the same; leading whitespace is kept, since it is part of the name.
    const line = raw.replace(/\s+$/u, '')
    if (line === '') continue
    if (line.startsWith('#')) continue
    const negated = line.startsWith('!')
    let body = negated ? line.slice(1) : line
    const dirOnly = body.endsWith('/')
    if (dirOnly) body = body.slice(0, -1)
    const anchored = body.startsWith('/') || body.includes('/')
    if (body.startsWith('/')) body = body.slice(1)
    if (body === '') continue
    rules.push({ base, negated, dirOnly, anchored, segments: body.split('/') })
  }
  return rules
}

/**
 * Is this path excluded by the rules in force?
 *
 * The verdict is the LAST rule that matches, and a rule matches when it matches
 * the path itself or any directory above it — that ancestor step is what makes
 * `dist/` exclude `dist/a/b.ts` without the walk having to remember that it
 * already refused `dist`. Rules arrive root-first, so a nested `.gitignore`
 * overrides the root one, which is git's order.
 *
 * @param rules - every rule in force for this path, shallowest base first.
 * @param path - the project-relative POSIX path.
 * @param isDirectory - whether the path itself is a directory.
 * @returns true when the path is excluded.
 */
export function isIgnored(rules: readonly IgnoreRule[], path: string, isDirectory = false): boolean {
  if (rules.length === 0) return false
  const segments = path.split('/').filter(part => part !== '')
  if (segments.length === 0) return false
  let ignored = false
  for (const rule of rules) {
    const baseSegments = rule.base === '' ? [] : rule.base.split('/').filter(part => part !== '')
    // A rule only speaks about paths strictly INSIDE its own directory.
    if (segments.length <= baseSegments.length) continue
    let under = true
    for (let index = 0; index < baseSegments.length; index += 1) {
      if (segments[index] !== baseSegments[index]) { under = false; break }
    }
    if (!under) continue
    const relative = segments.slice(baseSegments.length)
    let matched = ruleMatches(rule, relative, isDirectory)
    // The path's own directories are subjects too: an ignored directory excludes
    // everything under it, which is how `.gitignore` is read by everyone.
    if (!matched) {
      for (let depth = relative.length - 1; depth >= 1 && !matched; depth -= 1) {
        matched = ruleMatches(rule, relative.slice(0, depth), true)
      }
    }
    if (matched) ignored = !rule.negated
  }
  return ignored
}

/**
 * Is any rule in force able to re-include a path?
 *
 * The walk prunes an ignored directory as one entry, which is what keeps a huge
 * excluded tree from being walked. It may only do that when nothing could bring
 * a file back out of it; `!dist/keep.ts` is exactly such a rule, so its presence
 * turns the prune into a descent.
 *
 * @param rules - the rules in force for the directory.
 * @returns true when at least one rule is negated.
 */
export function hasNegation(rules: readonly IgnoreRule[]): boolean {
  return rules.some(rule => rule.negated)
}

/**
 * Does this path name build output by convention?
 *
 * Checked before the file is opened: a `.min.js` or a `.pb.go` is generated in
 * every project that has one, and reading its head to confirm what its name
 * already says would cost a read per file per pass.
 *
 * @param path - the project-relative path.
 * @returns true when the name marks the file as generated.
 */
export function isGeneratedPath(path: string): boolean {
  const lower = path.toLowerCase()
  if (GENERATED_SUFFIXES.some(suffix => lower.endsWith(suffix))) return true
  return GENERATED_INFIXES.some(infix => lower.includes(infix))
}

/**
 * Does a generated banner appear at the top of a file's head?
 *
 * @param head - the first {@link GENERATED_HEAD_BYTES} of the file, decoded.
 * @returns true when one of the first {@link GENERATED_BANNER_LINES} lines marks
 *   the file as generated.
 */
export function isGeneratedHead(head: string): boolean {
  // `split` already stops at the limit; a second slice would only restate it.
  for (const line of head.split(/\r?\n/u, GENERATED_BANNER_LINES)) {
    const lower = line.toLowerCase()
    if (GENERATED_BANNERS.some(banner => lower.includes(banner))) return true
  }
  return false
}
