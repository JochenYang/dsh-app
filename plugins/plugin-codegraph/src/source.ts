/**
 * The source reader: a symbol's declared lines, read from the file at query time.
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
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { oneRow } from './store.ts'

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
 * the tools did before it existed.
 */
export function sourceEnabled(): boolean {
  const value = process.env.DSH_APP_CODEGRAPH_SOURCE
  return value !== '0' && value !== 'false'
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
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
  return absolute
}
