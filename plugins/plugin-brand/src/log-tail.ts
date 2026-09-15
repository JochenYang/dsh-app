/**
 * Read the tail of the shell's own server log — the one diagnostic this
 * process cannot otherwise reach.
 *
 * The shell owns the log directory (`<userData>/logs`, see
 * `resolveLogDir()` in `src/main/server.ts`) and publishes the resolved path
 * to the kernel child as `DSH_APP_LOG_DIR`. Without that variable — a bare
 * `dsh` run, an older shell — there is nothing to read, which the route
 * reports as `unsupported` rather than as an error.
 *
 * A server log can be tens of megabytes and the interesting part is the end,
 * so the reader walks the file BACKWARDS in fixed-size chunks and stops as
 * soon as it holds the requested lines (plus the one extra boundary that tells
 * it where the first complete line starts). Slurping is deliberately not an
 * option: this runs inside the kernel host process, where a 100 MB string is
 * charged to the user's session rather than to a one-off CLI that exits.
 *
 * Lines arrive already redacted — the shell redacts at write time (`redact()`
 * in `src/main/server.ts`) — so nothing here re-redacts or logs them, and no
 * credential is ever read on this path.
 *
 * @module @dsh-app/plugin-brand/log-tail
 */

import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** Injected by the shell's `startServerAndOpenWindow` into the kernel child env. */
export const LOG_DIR_ENV = 'DSH_APP_LOG_DIR'

/** Lines returned when the caller names none. */
export const DEFAULT_TAIL_LINES = 200

/** Ceiling applied to whatever the caller asks for. */
export const MAX_TAIL_LINES = 1000

/** Bytes pulled per backward step. */
const READ_CHUNK_BYTES = 64 * 1024

/**
 * Total bytes one tail read may consume. A degenerate file (megabytes without
 * a single newline) would otherwise pull all of itself into the host process;
 * the server caps every line at 2 000 chars, so this budget covers any real
 * log many times over.
 */
const MAX_TAIL_BYTES = 4 * 1024 * 1024

/** How `src/main/server.ts` names its log files; the name sorts chronologically. */
const LOG_FILE_PREFIX = 'dsh-server-'
const LOG_FILE_SUFFIX = '.log'

/** Why a tail request produced no log path at all. */
export type LogTailMiss = 'unsupported' | 'missing'

/** Outcome of one tail read, split so the route can map each case to a status. */
export type LogTailResult =
  | { readonly ok: true; readonly file: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: LogTailMiss }

/** The handle methods the reader uses (a subset of `fs/promises`' FileHandle). */
export interface LogFileHandle {
  stat(): Promise<{ size: number }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/**
 * The filesystem slice this module needs, injectable so a suite can COUNT what
 * one read costs: "does not read the whole file" is a performance claim, and
 * only the ability to measure it makes that claim worth anything.
 */
export interface LogFileIo {
  open(file: string, flags: 'r'): Promise<LogFileHandle>
}

const NODE_IO: LogFileIo = { open: (file, flags) => open(file, flags) }

/**
 * Parse the route's `lines` query parameter.
 * @param raw - the query value, or null when the caller sent none.
 * @returns the count clamped to [1, MAX_TAIL_LINES], the default when absent,
 * or undefined when the value is not a positive integer (the route refuses
 * those instead of guessing).
 */
export function parseTailLines(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return DEFAULT_TAIL_LINES
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return undefined
  const requested = Number(text)
  if (requested < 1) return undefined
  return Math.min(requested, MAX_TAIL_LINES)
}

/**
 * Read the tail of the newest server log under one directory.
 * @param dir - the log directory the shell injected, or undefined.
 * @param lines - an already-clamped line count.
 * @param io - filesystem seam; the default is the real one.
 * @returns the tail, or the reason there is none.
 * @throws whatever the filesystem throws for an unreadable directory or file
 * that is not a plain "it is gone" — the route turns that into its own status.
 */
export async function readLogTail(
  dir: string | undefined,
  lines: number,
  io: LogFileIo = NODE_IO,
): Promise<LogTailResult> {
  if (dir === undefined || dir === '') return { ok: false, reason: 'unsupported' }
  let isDirectory = false
  try {
    isDirectory = (await stat(dir)).isDirectory()
  } catch {
    // A missing directory tells the same story as a missing variable: this
    // environment has no log directory to read. Any other stat failure lands
    // here too, and the caller sees "unsupported" rather than a broken page.
    isDirectory = false
  }
  if (!isDirectory) return { ok: false, reason: 'unsupported' }
  const file = await newestLogFile(dir)
  if (file === undefined) return { ok: false, reason: 'missing' }
  try {
    return { ok: true, file, lines: await tailLines(file, lines, io) }
  } catch (error) {
    // The file can be pruned between listing and reading (the shell keeps the
    // last ten); that is "no log left", not a read failure.
    if (isMissingFile(error)) return { ok: false, reason: 'missing' }
    throw error
  }
}

/**
 * The newest `dsh-server-*.log` under `dir`. The name is an ISO timestamp with
 * punctuation replaced by dashes, so plain string order is chronological — the
 * same assumption the shell's own pruning makes.
 * @param dir - the log directory.
 * @returns the absolute path, or undefined when the directory holds no log.
 */
async function newestLogFile(dir: string): Promise<string | undefined> {
  const names = await readdir(dir)
  const logs = names
    .filter((name) => name.startsWith(LOG_FILE_PREFIX) && name.endsWith(LOG_FILE_SUFFIX))
    .sort()
  const newest = logs[logs.length - 1]
  return newest === undefined ? undefined : path.join(dir, newest)
}

/** Whether an error is `ENOENT`. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * The last `lines` complete lines of one file.
 * @param file - absolute path to read.
 * @param lines - how many to keep.
 * @param io - filesystem seam.
 * @returns the lines, oldest first; empty for an empty file or one whose only
 * content is a line longer than the byte budget.
 */
async function tailLines(file: string, lines: number, io: LogFileIo): Promise<string[]> {
  const handle = await io.open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const chunks: Buffer[] = []
    let start = size
    let boundaries = 0
    let read = 0
    // `boundaries <= lines` buys ONE extra newline: the one the first kept line
    // starts after, which is how the split below recognizes a partial head.
    while (start > 0 && boundaries <= lines && read < MAX_TAIL_BYTES) {
      const length = Math.min(READ_CHUNK_BYTES, start, MAX_TAIL_BYTES - read)
      const from = start - length
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, from)
      // Zero bytes means the file was truncated under us; what the buffer
      // already holds is then the honest answer.
      if (bytesRead === 0) break
      // Decode AFTER concatenating: a chunk boundary can split a UTF-8
      // sequence, and per-chunk decoding would turn those bytes into U+FFFD.
      const chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk)
      boundaries += countNewlines(chunk)
      read += bytesRead
      start = from
    }
    const parts = Buffer.concat(chunks).toString('utf8').split('\n')
    // A trailing newline TERMINATES the last line instead of opening an empty
    // one, so the empty tail element is not a line.
    if (parts[parts.length - 1] === '') parts.pop()
    // Stopping mid-file leaves the first element holding only the visible tail
    // of a longer line; an incomplete line is not shown.
    if (start > 0 && parts.length > 0) parts.shift()
    return parts
      .slice(-lines)
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  } finally {
    await handle.close()
  }
}

/** Newline count of one chunk (`\n` is single-byte in UTF-8, so byte-wise is exact). */
function countNewlines(chunk: Buffer): number {
  let count = 0
  for (const byte of chunk) {
    if (byte === 0x0a) count += 1
  }
  return count
}
