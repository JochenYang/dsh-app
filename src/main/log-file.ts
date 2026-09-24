/**
 * Rotation for the shell's diagnostics log (`<logs>/dsh-kernel.log`).
 *
 * Split out of `index.ts` so the rule is testable without booting Electron: the
 * log is the only place a packaged Windows build can be diagnosed (there is no
 * console), so its rotation has to keep exactly one previous run and never lose
 * the file it is rotating — an unbounded log is worse than none, and a rotation
 * that fails is worse than either.
 *
 * @module dsh-app/main/log-file
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/** Rotate once the live file passes this size (~1 MiB). */
export const LOG_ROTATE_BYTES = 1_000_000

/**
 * Append one line to a rotating log, creating the directory when needed.
 *
 * Rotation keeps exactly one previous generation at `<file>.1`. Windows refuses a
 * rename onto an existing target, so the previous `.1` is removed first.
 *
 * @param file - absolute path of the live log.
 * @param line - the line to append (a newline is added).
 * @returns nothing; a failure is reported by the caller, never thrown from here.
 */
export function appendRotatingLog(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_ROTATE_BYTES) {
    rmSync(`${file}.1`, { force: true })
    renameSync(file, `${file}.1`)
  }
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
}
