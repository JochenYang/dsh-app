/**
 * Deleting a tree on Windows, where the first attempt is allowed to fail.
 *
 * `fs.rm` reports EPERM / EBUSY / EACCES for two everyday reasons on this
 * platform, and neither is a durable answer: an antivirus or the search indexer
 * holds a handle for a few hundred milliseconds, and a file whose read-only
 * attribute is set cannot be unlinked at all until that attribute is cleared.
 * A delete path that treats either as final turns "the indexer was looking at
 * it" into an `io` error for something that would have worked one moment
 * later.
 *
 * So the removal is retried with an EXHAUSTIVE read-only pass between attempts,
 * and the retry budget is bounded twice over — {@link DEFAULT_ATTEMPTS} tries
 * and {@link DEFAULT_DEADLINE_MS} of wall clock, whichever ends first. A caller
 * never waits longer than that for a directory it has already decided to
 * delete; what it gets instead is a {@link DeleteError} carrying a stable code,
 * the path, and the last errno as its cause.
 *
 * ## What this module will not do
 *
 * It is not a safety fence. It deletes whatever is at the path it is given, so
 * the caller decides what may be there: `./projcache.ts` probes for a plain
 * file first, and `./trash.ts` only ever aims it at a trash entry it has
 * already taken out of service.
 *
 * A link is never followed. `fs.rm`'s async recursive form unlinks a junction
 * or a directory symlink instead of descending through it, which is the whole
 * reason this repository's tree deletes are async (`test/recursive-delete-guard.test.mjs`);
 * the read-only pass follows the same rule, because it walks by `Dirent` kind
 * and never `stat`s through a link.
 *
 * @module @dsh-app/plugin-archives/fs-util
 */

import fsp from 'node:fs/promises'
import { join } from 'node:path'

/** The one code this module reports. */
export type DeleteErrorCode = 'fs-rm-failed'

/** A removal that ran out of retries, with the last reason the filesystem gave. */
export class DeleteError extends Error {
  constructor(
    readonly code: DeleteErrorCode,
    message: string,
    options: {
      /** The path the removal was aimed at. */
      readonly path: string
      /** How many attempts were made before giving up. */
      readonly attempts: number
      /** The last errno the filesystem reported. */
      readonly cause: unknown
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'DeleteError'
    this.path = options.path
    this.attempts = options.attempts
  }

  /** The path the removal was aimed at. */
  readonly path: string

  /** How many attempts were made before giving up. */
  readonly attempts: number
}

/** The `code` of a {@link DeleteError}, or undefined for anything else. */
export function deleteErrorCode(error: unknown): DeleteErrorCode | undefined {
  return error instanceof DeleteError ? error.code : undefined
}

/**
 * The errno values a retry can plausibly outlast.
 *
 * EPERM/EBUSY/EACCES are the Windows pair (open handle, denied) and ENOENT-class
 * failures are already absorbed by `force`; everything else — ENOTDIR, EROFS, a
 * cross-device error — describes something a later attempt cannot change.
 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE'])

/** Attempts, retries included. Five is the count that outlasts an indexer. */
const DEFAULT_ATTEMPTS = 5

/** First backoff step; doubles per attempt. */
const DEFAULT_BASE_DELAY_MS = 20

/** Ceiling on one backoff step, so the last wait is not the longest by far. */
const DEFAULT_MAX_DELAY_MS = 250

/** Wall clock a single removal may spend retrying, sleeps included. */
const DEFAULT_DEADLINE_MS = 2_000

/** Whether a failed removal is worth another attempt. */
export function isRetryableDeleteError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && RETRYABLE.has(code)
}

/** How one removal spends its retries. Every field has a documented default. */
export interface RmWithRetryOptions {
  /** Attempts, retries included (default {@link DEFAULT_ATTEMPTS}). */
  readonly attempts?: number
  /** First backoff step in milliseconds, doubled per attempt (default 20). */
  readonly baseDelayMs?: number
  /** Ceiling on one backoff step in milliseconds (default 250). */
  readonly maxDelayMs?: number
  /** Wall clock the retries may spend, sleeps included (default 2000). */
  readonly deadlineMs?: number
  /** Sleep between attempts; injected so a test can spend no real time. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Wait `ms`, the real way. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}

/**
 * Clear the read-only attribute across a tree, best effort.
 *
 * Iterative on an explicit worklist rather than recursive, so a deep tree
 * cannot overflow the stack, and kind-driven: a `Dirent` is what decides
 * whether something is descended into, so a junction or a symlink is never
 * opened. Adding the owner's write bit is the only change — nothing else about
 * the mode is rewritten, and a path that cannot be chmodded is left for the
 * retry to report.
 * @param root - the path a removal just failed on.
 */
async function clearReadOnly(root: string): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const path = pending.pop() as string
    let info
    try {
      info = await fsp.lstat(path)
    } catch {
      continue
    }
    try {
      await fsp.chmod(path, info.mode | 0o200)
    } catch {
      // A chmod that fails says nothing new: the retry reports the real reason.
    }
    if (!info.isDirectory()) continue
    let entries
    try {
      entries = await fsp.readdir(path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(path, entry.name))
      else if (entry.isFile()) pending.push(join(path, entry.name))
    }
  }
}

/**
 * Remove a file or a tree, retrying the failures a later attempt can outlast.
 *
 * Each attempt is `fsp.rm(path, { recursive: true, force: true, maxRetries: 0 })`:
 * `force` makes a path that is already gone a success, and `maxRetries: 0` keeps
 * Node's own hidden retry loop out of the accounting — this module's budget is
 * the only one, which is what makes "it gave up after N tries" a fact the tests
 * and the error can both state.
 *
 * Between attempts the read-only attribute is cleared across the tree, then the
 * backoff doubles from {@link RmWithRetryOptions.baseDelayMs}. Retrying stops
 * on any failure a retry cannot change, when the attempt budget is spent, and
 * when the next sleep would cross the deadline.
 * @param path - the file or tree to remove.
 * @param options - the retry budget; see {@link RmWithRetryOptions}.
 * @throws {DeleteError} with `fs-rm-failed` when the last attempt failed too.
 */
export async function rmWithRetry(path: string, options: RmWithRetryOptions = {}): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const baseDelay = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS)
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
  const deadline = Math.max(0, options.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const sleep = options.sleep ?? realSleep
  const startedAt = Date.now()
  let lastError: unknown
  let made = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    made = attempt
    try {
      await fsp.rm(path, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      lastError = error
      if (!isRetryableDeleteError(error) || attempt === attempts) break
      const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1))
      if (Date.now() - startedAt + delay > deadline) break
      // A read-only attribute is the one cause this module can remove itself,
      // and clearing it before sleeping means the next attempt starts clean.
      await clearReadOnly(path)
      await sleep(delay)
    }
  }
  const cause = lastError as { code?: unknown; message?: unknown }
  throw new DeleteError(
    'fs-rm-failed',
    `could not remove ${path} after ${made} attempt(s): ${
      typeof cause?.message === 'string' ? cause.message : String(lastError)
    }`,
    { path, attempts: made, cause: lastError },
  )
}
