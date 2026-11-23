/**
 * The source reader: a symbol's declared lines, read from the file at query time.
 *
 * Two reads live here and nothing else in the plugin opens a file. The slice is
 * one declaration, to edit from. The call sites are one line per reference in an
 * `impact` answer, each caller's file read once under a file and byte bound, so
 * that "who calls this" can be read without opening the callers' files. And one
 * `stat` with no read at all answers whether a cited file moved since the index.
 * All three admit a path the same way, below.
 *
 * Why the bytes are read here rather than stored. The graph already knows a
 * declaration's extent (`line`..`end_line`), so the only question left is what
 * those bytes ARE — and a copy in the database would be a second version of the
 * repository that nothing keeps current. A file edit would then need the whole
 * shelf re-written, and a slice could be served from a row whose `files.hash`
 * already says the file moved. Reading here costs one file read per answer and
 * makes the freshness question answerable: the bytes about to be returned are
 * hashed and compared against the hash the indexer recorded.
 *
 * Why the path is validated twice. A path in a tool answer is a value a MODEL
 * produced, so `path` is a request to read a file, not a fact. It is admitted only
 * when the graph holds a `files` row for it AND its absolute form stays inside the
 * project root — the first refuses every path this project never indexed, the
 * second refuses `..` and anything absolute before the filesystem is touched.
 * Neither check is redundant: an indexed path is still only safe relative to the
 * root that named it.
 *
 * @module @dsh-app/plugin-codegraph/host/source
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { oneRow } from './store.ts'
import { MAX_SOURCE_FILE_BYTES } from './budget.ts'
import { SWITCH_ENV, switchIsOn } from './switches.ts'

/** A requested slice: where it starts, where the declaration ends, and its bound. */
export interface SourceRequest {
  /** The project's open graph, for the recorded hash. */
  readonly db: DatabaseSync
  /** The project root the graph was built under, absolute. */
  readonly root: string
  /** Project-relative POSIX path, as the graph keys files. */
  readonly path: string
  /** 1-based first line of the declaration. */
  readonly startLine: number
  /** 1-based LAST line of the declaration. */
  readonly endLine: number
  /** How many lines one answer may carry for this file. */
  readonly maxLines: number
  /** How many characters one answer may carry for this file, numbering included. */
  readonly maxChars: number
}

/** One declaration's source, numbered the way `Read` numbers it. */
export interface SourceSlice {
  /** 1-based first line of `text`. */
  readonly startLine: number
  /** 1-based last line `text` carries — the declaration's last line unless cut. */
  readonly endLine: number
  /** Line-numbered text, `<n>\t<line>`, safe to edit from. */
  readonly text: string
  /** True when the declaration is longer than `maxLines`. */
  readonly truncated: boolean
  /**
   * True when the file on disk no longer hashes to what the graph recorded.
   *
   * The bytes returned are the CURRENT ones either way — refusing to answer would
   * hide the very edit the caller is asking about. The flag is what stops the
   * answer from being read as "the graph's view of this file".
   */
  readonly drift: boolean
}

/** Why a slice was not produced. Every value is a different thing to do next. */
export type SourceRefusal =
  | 'disabled'
  | 'not-indexed'
  | 'outside-root'
  | 'unreadable'
  /**
   * The graph's first line is past the end of the file — it changed since the last
   * pass. Distinct from `unreadable` on purpose: that one sends a reader to check
   * permissions, and there is nothing wrong with a file that simply got shorter.
   */
  | 'shortened'
  /**
   * The file grew past `MAX_SOURCE_FILE_BYTES` after it was indexed. Distinct
   * from `unreadable`: nothing is wrong with the file, it is simply too large
   * to read whole on the kernel's event loop for the sake of one declaration.
   */
  | 'too-large'

/** The answer: a slice, or the reason there is none. */
export type SourceResult =
  | { readonly ok: true, readonly slice: SourceSlice }
  | { readonly ok: false, readonly reason: SourceRefusal }

/**
 * Whether source reading is on.
 *
 * A kill switch rather than a config row: the risky half of this module is the one
 * filesystem read, and turning it off must not require a code change on a user's
 * machine. Set `DSH_APP_CODEGRAPH_SOURCE=0` to answer without source, exactly as
 * the tools did before it existed. The convention it follows lives in
 * `switches.ts`, beside the plugin's other two switches.
 */
export function sourceEnabled(): boolean {
  return switchIsOn(process.env, SWITCH_ENV.source)
}

/**
 * Read one declaration's source.
 *
 * @param request - the graph, the root, the span and the line bound.
 * @returns the numbered slice, or the refusal that explains its absence.
 */
export function readSourceSlice(request: SourceRequest): SourceResult {
  if (!sourceEnabled()) return { ok: false, reason: 'disabled' }
  const { db, root, path } = request
  const recorded = oneRow<{ hash: string }>(db, 'SELECT hash FROM files WHERE path = ?', path)
  if (recorded === undefined) return { ok: false, reason: 'not-indexed' }
  const absolute = absoluteWithin(root, path)
  if (absolute === undefined) return { ok: false, reason: 'outside-root' }

  let bytes: Buffer
  try {
    // Bounded BEFORE it is read. The walk skips files past
    // `MAX_SOURCE_FILE_BYTES`, but a file can grow after it was indexed — and the
    // slice used to read whatever was there, whole, on the kernel's event loop,
    // to hash it and take forty lines. The same bound, so a file the graph holds
    // is one the reader will open.
    if (statSync(absolute).size > MAX_SOURCE_FILE_BYTES) return { ok: false, reason: 'too-large' }
    bytes = readFileSync(absolute)
  } catch {
    // Indexed but not readable: deleted between the pass and this call, or a
    // permission the user's own tool does not have. Neither is a reason to throw
    // inside a tool answer.
    return { ok: false, reason: 'unreadable' }
  }
  const drift = createHash('sha256').update(bytes).digest('hex') !== recorded.hash
  const lines = bytes.toString('utf8').split(/\r?\n/u)
  // A file that ends with a newline does not have a line after it: keeping the empty
  // tail would make a declaration that ends at EOF cover two lines, and the second
  // one would be blank.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  // A graph that spans past the end of the file is a graph built from different
  // bytes — the hash comparison above already said so, so this is clamping, not a
  // second opinion. Clamping rather than refusing keeps the answers that are
  // still true: the declaration's opening lines are there, and the caller is told
  // the file moved.
  const first = Math.max(1, request.startLine)
  const declaredLast = Math.max(first, request.endLine)
  const last = Math.min(declaredLast, lines.length)
  // The graph says this declaration starts on a line the file no longer has. Nothing
  // truthful can be shown, and calling it `unreadable` would point a reader at
  // permissions for a file that was simply edited down.
  if (first > lines.length) return { ok: false, reason: 'shortened' }
  const wanted = last - first + 1
  const lineLimit = Math.min(wanted, Math.max(1, request.maxLines))
  const chosen: string[] = []
  let chars = 0
  let cutMidLine = false
  for (let index = first; index < first + lineLimit; index++) {
    const raw = lines[index - 1] ?? ''
    const numbered = `${String(index)}\t${raw}`
    if (chars + numbered.length + 1 <= request.maxChars) {
      chosen.push(numbered)
      chars += numbered.length + 1
      continue
    }
    // The line does not fit. For the FIRST line the text is cut instead of dropped:
    // one minified line can be a hundred thousand characters, and an empty answer
    // would be a wrong answer. For any later line the pass stops — a caller needs the
    // head of a declaration, not half of a line from the middle of it.
    if (chosen.length === 0) {
      const room = Math.max(0, request.maxChars - String(index).length - 2)
      chosen.push(`${String(index)}\t${raw.slice(0, room)}…`)
      cutMidLine = true
    }
    break
  }
  return {
    ok: true,
    slice: {
      startLine: first,
      endLine: first + chosen.length - 1,
      text: chosen.join('\n'),
      // A cut line is as much a cut as a dropped one: `truncated` says "this is not the
      // whole declaration", and the mid-line case is not the whole line.
      truncated: cutMidLine || chosen.length < wanted,
      // A clamped end is drift even when the hash happened to match (a graph
      // written by a build that counted lines differently).
      drift: drift || last < declaredLast,
    },
  }
}

/**
 * The absolute path of an indexed file, or `undefined` when it leaves the root.
 *
 * `relative` is the check, not a prefix test: `D:\app` is a prefix of
 * `D:\app-evil`, so a string comparison would admit a sibling directory whose name
 * only starts the same way.
 *
 * @param root - the project root, absolute.
 * @param path - the project-relative POSIX path from a graph row.
 * @returns the absolute path when it is inside the root.
 */
function absoluteWithin(root: string, path: string): string | undefined {
  const base = resolve(root)
  const absolute = resolve(base, ...path.split('/'))
  const inside = relative(base, absolute)
  // `..foo.ts` is a file in the root that happens to start with two dots; only
  // `..` itself and `..` followed by a separator leave it.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  return absolute
}

/** One call site's line, as the file reads now. */
export interface SiteText {
  /** The line, trimmed and folded to one line of at most `maxChars` characters. */
  readonly text: string
  /**
   * The file no longer hashes to what the graph recorded. The text is still the
   * file's current line `n`, but the graph's `n` may point elsewhere in the old
   * bytes — the row says so instead of presenting the line as the indexed call.
   */
  readonly drift: boolean
}

/** What `readCallSites` may spend, and the sites to read. */
export interface CallSitesRequest {
  /** The project's open graph, for the recorded hashes. */
  readonly db: DatabaseSync
  /** The project root the graph was built under, absolute. */
  readonly root: string
  /** The sites, in the order the answer lists them: the budget serves the first ones first. */
  readonly sites: readonly { readonly path: string, line: number }[]
  /** How many files may be read. */
  readonly maxFiles: number
  /** How many bytes may be read in all. */
  readonly maxBytes: number
  /** The longest line of text one site may carry. */
  readonly maxChars: number
  /** The most text all sites together may carry. */
  readonly maxTotalChars: number
}

/** The sites that got text, and what the reading cost. */
export interface CallSites {
  /** Keyed `${path}:${line}`. A site with no entry got no text: a blank line, a refused file, or past the budget. */
  readonly sites: Map<string, SiteText>
  /** Files actually read. Diagnostics: the bounds are behaviour, and a test reads them here. */
  readonly filesRead: number
  /** True when a bound stopped the walk: a file past the file or byte bound was not opened, a site past the text bound got no text. */
  readonly truncated: boolean
}

/** The key one site is recorded under. */
const siteKey = (path: string, line: number): string => `${path}:${String(line)}`

/**
 * The text of the lines a list of references points at, each file read once.
 *
 * `readSourceSlice` reads one declaration to edit from; this reads one line per
 * site so that "who calls this" can be answered without opening the callers'
 * files. Same three guards as the slice — the switch, the `files` row, the
 * containment check — and the slice's size bound — because it is the same
 * filesystem read. A file that no longer matches its recorded hash still yields
 * its current line, flagged: the call the graph saw is the one the reader asked
 * about, and a wrong line number is a smaller wrong than no line.
 *
 * The sites are walked in the order the answer lists them, and a file is read
 * the first time one of its sites comes up: so the text budget is spent on the
 * rows the reader meets first, whatever file they are in, and the moment it is
 * spent the walk STOPS — a file past that point is not opened, hashed or read,
 * since nothing from it could reach the answer.
 *
 * @param request - the graph, the root, the sites and the bounds.
 * @returns the sites that got text, or undefined when source reading is off.
 */
export function readCallSites(request: CallSitesRequest): CallSites | undefined {
  if (!sourceEnabled()) return undefined
  const { db, root } = request
  /** The lines of a file already read, or null for one that was refused or skipped. */
  const files = new Map<string, readonly string[] | null>()
  /** Files whose bytes no longer match the graph. */
  const drifted = new Set<string>()
  const sites = new Map<string, SiteText>()
  let filesRead = 0
  let bytes = 0
  let chars = 0
  let truncated = false
  for (const site of request.sites) {
    const key = siteKey(site.path, site.line)
    if (sites.has(key)) continue
    if (chars >= request.maxTotalChars) { truncated = true; break }
    let lines = files.get(site.path)
    if (lines === undefined) {
      if (filesRead >= request.maxFiles) { truncated = true; break }
      const recorded = oneRow<{ hash: string }>(db, 'SELECT hash FROM files WHERE path = ?', site.path)
      // Not indexed, or not inside the root: the same two refusals the slice
      // gives, and for the same reason — a path in an answer is a MODEL-produced
      // string.
      const absolute = recorded === undefined ? undefined : absoluteWithin(root, site.path)
      const content = absolute === undefined ? undefined : readBounded(absolute, request.maxBytes - bytes)
      if (content === undefined || content.bound) {
        files.set(site.path, null)
        if (content?.bound === true) truncated = true
        continue
      }
      filesRead += 1
      bytes += content.bytes.length
      if (createHash('sha256').update(content.bytes).digest('hex') !== recorded?.hash) drifted.add(site.path)
      lines = content.bytes.toString('utf8').split(/\r?\n/u)
      files.set(site.path, lines)
    }
    if (lines === null) continue
    const raw = lines[site.line - 1]
    if (raw === undefined) continue
    const text = foldLine(raw, request.maxChars)
    if (text === '') continue
    if (chars + text.length > request.maxTotalChars) { truncated = true; break }
    chars += text.length
    sites.set(key, { text, drift: drifted.has(site.path) })
  }
  return { sites, filesRead, truncated }
}

/**
 * A file's bytes, or why there are none. The size is checked BEFORE the read, so
 * a file that grew after it was indexed is never pulled into memory whole; one
 * past what is left of the byte bound is `bound`, which the caller reports as a
 * cut, while one that cannot be read at all is not a cut — nothing of it was
 * ever going to be in the answer.
 */
function readBounded(absolute: string, remaining: number): { bytes: Buffer, bound?: false } | { bound: true } | undefined {
  try {
    if (statSync(absolute).size > remaining) return { bound: true }
    return { bytes: readFileSync(absolute) }
  } catch {
    return undefined
  }
}

/**
 * One line of source as a row of an answer carries it: trimmed, whitespace
 * folded, backticks replaced (the row quotes the line between a pair of its
 * own), control and format characters replaced, cut with an ellipsis that is
 * part of the bound.
 */
function foldLine(raw: string, maxChars: number): string {
  // Whitespace first: a tab or a line break is spacing, not a stray control
  // character, and folding it before the replacement keeps it that way. Then every
  // control and FORMAT character — the bidi overrides and zero-width marks among
  // them, which would otherwise let a source line rearrange the row it sits in.
  // Surrogates are left alone on purpose: `\p{C}` would turn each half of an
  // emoji into a `?`.
  const folded = raw.replace(/\s+/gu, ' ').trim().replace(/`/gu, "'").replace(/[\p{Cc}\p{Cf}]/gu, '?')
  return folded.length > maxChars ? `${folded.slice(0, maxChars - 1)}…` : folded
}

/**
 * Whether one indexed file differs from what the graph recorded — `mtime` and
 * `size`, one `stat`, no read: the same comparison the pass makes before it
 * decides to re-parse a file.
 *
 * @param db - the project's open graph.
 * @param root - the project root, absolute.
 * @param path - the project-relative POSIX path from a graph row.
 * @returns true when the file changed, false when it matches, undefined when the
 *   question cannot be answered (not indexed, outside the root, unreadable).
 */
export function fileChangedSinceIndex(db: DatabaseSync, root: string, path: string): boolean | undefined {
  // The database read is inside the guard too: `pendingFiles` is an addition to
  // an answer that is already valid, and a handle closed underneath it (a delete
  // racing the call) must not turn that answer into an error.
  let recorded: { mtime: number, size: number } | undefined
  try {
    recorded = oneRow<{ mtime: number, size: number }>(db, 'SELECT mtime, size FROM files WHERE path = ?', path)
  } catch {
    return undefined
  }
  const absolute = recorded === undefined ? undefined : absoluteWithin(root, path)
  if (recorded === undefined || absolute === undefined) return undefined
  try {
    const stat = statSync(absolute)
    return Math.floor(stat.mtimeMs) !== recorded.mtime || stat.size !== recorded.size
  } catch {
    return undefined
  }
}

/**
 * The files among `paths` that changed since the index, in first-mention order.
 *
 * For an answer that already says it describes the previous state: naming the
 * files it cites that moved is what lets the reader open those and trust the
 * rest. A `current` answer never calls this — the check that made it current
 * has just compared the tree.
 */
export function changedFilesSinceIndex(db: DatabaseSync, root: string, paths: readonly string[]): string[] {
  const changed: string[] = []
  for (const path of paths) {
    if (changed.includes(path)) continue
    if (fileChangedSinceIndex(db, root, path)) changed.push(path)
  }
  return changed
}
