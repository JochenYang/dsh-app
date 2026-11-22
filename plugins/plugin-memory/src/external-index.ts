/**
 * Read-only bridge to the memory index another coding assistant keeps for the
 * same workspace (ZCode).
 *
 * Two assistants working in one repository each keep their own notes, and
 * neither can see the other's. This module reads ONE file — the other tool's
 * per-project memory INDEX — so its one-line entries ride into the prompt and
 * the model can read an entry's file when a line bears on the task. Nothing is
 * copied, written or kept in sync: the other tool's directory stays the only
 * source of its notes (a copy would be a second source that drifts), and this
 * plugin's own cards never change because of it. A user without that tool has
 * no such directory, and nothing happens at all.
 *
 * Where the index is: `<home>/.zcode/cli/memories/projects/<name>-<hash>/`
 * where `<hash>` is the first 16 hex characters of the SHA-256 of the lowercased
 * workspace path — that tool's own convention, mirrored here (so on a
 * case-sensitive file system two directories that differ only in case share
 * one index there, and therefore here). The `<name>` half is that tool's
 * rendering of the path's last segment and is not relied on: the directory is
 * found by its hash suffix. Two spellings of the path are hashed — backslashes
 * and forward slashes. When the hash does not match at all (a junction) the
 * bridge is simply absent; nothing is guessed. The layout is that tool's, not
 * a contract: if it moves, this reads nothing and the prompt is unchanged.
 *
 * The index is text another tool's MODEL wrote, so it is untrusted input on
 * every path below:
 *   - only regular files are read (`lstat`: no link, no device), and only up
 *     to {@link MAX_INDEX_BYTES} — this runs on the prompt path of every step;
 *   - only list lines (`- …`) are taken, each folded onto one line and stripped
 *     of control, bidi and zero-width characters;
 *   - a line that looks like a credential, or that so much as names one, is
 *     dropped: an index line is a pointer, so a false drop costs nothing, while
 *     the file never passed through this plugin's write-side filter;
 *   - a link target is kept only when it is a bare file name of that
 *     directory. The prompt tells the model these targets are files "in that
 *     directory"; a target may say anything (`../../.ssh/id_rsa`, a `file://`
 * URL), and the plugin must not vouch for a path it did not check. Anything
 *     else keeps its title and loses the target.
 *
 * Every failure — no such directory, no index, unreadable — is an absent
 * bridge, never a throwing prompt assembly. What is accepted knowingly: the
 * block names the index's absolute directory (under the user's home), which
 * therefore reaches the model provider on every turn, and the entry FILES the
 * lines point to are not filtered by this plugin — reading one is the model's
 * own file tool acting on text framed as reference material.
 *
 * @module @dsh-app/plugin-memory/external-index
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { singleLine } from './card-file.ts'
import { containsCredential } from './memory-store.ts'

/** Index lines injected at most. */
export const EXTERNAL_INDEX_LINES = 40

/** One index line's ceiling, in UTF-16 units (an entry is a one-line pointer). */
const EXTERNAL_LINE_CHARS = 300

/** Hex characters of the workspace hash that identify a project directory. */
const KEY_HASH_CHARS = 16

/** An index is a list of one-line pointers; anything larger is not one. */
const MAX_INDEX_BYTES = 65_536

/** Control characters, bidi controls and zero-width characters. None of them
 *  belongs in an index line, and a bidi override can make a line READ as
 *  something else than it is. */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu

/** Naming a credential is enough to drop a line (see the module header). The
 *  shape rules (`containsCredential`) catch `token: …`; a word like "token" on
 *  its own is not in here, because "token counting" is an ordinary subject of
 *  an engineering note and an index line only names the subject. The last four
 *  alternatives are the Chinese for password, passphrase, private key and
 *  secret key, escaped: host code holds no Han characters (`check:graph`). */
const CREDENTIAL_WORDS = /password|passwd|secret|credential|private[ _-]?key|api[ _-]?key|\u5bc6\u7801|\u53e3\u4ee4|\u79c1\u94a5|\u5bc6\u94a5/iu

/** A markdown link whose target is a bare `.md` file name: letters, digits,
 *  underscore, dot and dash — no separator, no drive, no scheme, no `..`. */
const LINK = /\[([^\]]*)\]\(([^()]*)\)/gu
const BARE_FILE = /^[\w.-]+\.md$/u

/** The other tool's memory index of one workspace. */
export interface ExternalIndex {
  /** The directory the entry files live in (what the prompt tells the model). */
  dir: string
  /** The injected lines, in the index's order. */
  lines: string[]
  /** How many list lines the ceiling left out (0 when they all fit). */
  cut: number
  /** How many list lines were dropped because they looked like, or named, a
   *  credential. */
  withheld: number
}

/** The 16-hex workspace hashes a project directory may be suffixed with. */
function keyCandidates(cwd: string): Set<string> {
  const lower = cwd.toLowerCase().replace(/[\\/]+$/u, '')
  return new Set([lower, lower.replace(/\\/gu, '/')].map(text => createHash('sha256').update(text).digest('hex').slice(0, KEY_HASH_CHARS)))
}

/** The index file's text, or undefined when there is nothing safe to read. */
function readIndexFile(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    const stat = lstatSync(file)
    // A link, a directory or a device is not an index. `lstat`, not `stat`: a
    // link to elsewhere must not turn this read into a read of somewhere else.
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return undefined
    const text = readFileSync(file, 'utf8')
    return text.length > MAX_INDEX_BYTES ? undefined : text
  } catch {
    return undefined
  }
}

/** One index line made safe to inject (see the module header). */
function sanitize(line: string): string {
  const clean = singleLine(line.replace(INVISIBLE, '')).trimEnd()
  return clean.replace(LINK, (whole: string, title: string, target: string): string => (BARE_FILE.test(target.trim()) ? whole : title))
}

/**
 * Read the other tool's memory index for `cwd`.
 *
 * @param cwd - the assembling session's workspace path.
 * @param home - the user's home directory (injected for tests).
 * @returns the index, or undefined when the tool has no memory for this
 *   workspace or the index cannot be read.
 */
export function readExternalIndex(cwd: string, home: string = homedir()): ExternalIndex | undefined {
  const projects = join(home, '.zcode', 'cli', 'memories', 'projects')
  if (!existsSync(projects)) return undefined
  const keys = keyCandidates(cwd)
  let project: string | undefined
  try {
    project = readdirSync(projects).find(name => keys.has(name.slice(name.lastIndexOf('-') + 1)))
  } catch {
    return undefined
  }
  if (project === undefined) return undefined
  const text = readIndexFile(join(projects, project, 'memory', 'MEMORY.md'))
  if (text === undefined) return undefined
  const listed = text.split('\n').filter(line => line.startsWith('- '))
  const kept = listed.filter(line => !containsCredential(line) && !CREDENTIAL_WORDS.test(line)).map(sanitize)
  const lines = kept.slice(0, EXTERNAL_INDEX_LINES).map(line => cut(line))
  return {
    dir: join(projects, project, 'memory'),
    lines,
    cut: kept.length - lines.length,
    withheld: listed.length - kept.length,
  }
}

/** `line` cut to {@link EXTERNAL_LINE_CHARS} and marked, never splitting a
 *  surrogate pair. */
function cut(line: string): string {
  if (line.length <= EXTERNAL_LINE_CHARS) return line
  const head = line.slice(0, EXTERNAL_LINE_CHARS)
  return `${/[\uD800-\uDBFF]/u.test(head.charAt(head.length - 1)) ? head.slice(0, -1) : head}…`
}
