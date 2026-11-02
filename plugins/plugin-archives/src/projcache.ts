/**
 * The projection cache's per-session shards, and how a purge gets rid of them.
 *
 * The kernel keeps one durable checkpoint document per session in the
 * `session_projcache` storage domain, laid out by the JSON backend as
 * `<DSH_HOME>/storages/session_projcache/sessions/<name>.json`. Nothing in the
 * session-persistence contract removes a shard when the session's log directory
 * goes away — the cache has no eviction surface at all — so every session this
 * plugin deletes for good leaves a document behind that no listing can reach.
 * That is the "projection cache leaks for ever" gap: measured on this machine at 469
 * shards for 326 session directories.
 *
 * ## Where it is called, and where it deliberately is not
 *
 * `purgeEntry`'s callers call {@link purgeSessionShards} after the bytes are
 * gone: `/purge` (which is also what "empty the trash" posts), and the expiry
 * sweep when retention lands. Moving a session INTO the trash never touches its
 * shard, and that is the point: a restored session must come back with its
 * title and cached projection values instead of refolding from a log the
 * listing already showed as gone.
 *
 * ## Two spellings, because this app has shipped two id shapes
 *
 * The document's name is the session id, and that id has travelled in two
 * shapes: a bare UUID (what this kernel line mints) and `session-<uuid>` (the
 * one earlier lines wrote). A shard is stored under the id its writer knew, so
 * a purge named by the other shape would miss it — and on this machine the two
 * shapes are 241 and 228 of the 469 shards, i.e. missing one spelling leaks
 * about half of them. {@link shardNamesFor} therefore answers both spellings
 * and the cleanup treats them as equal candidates rather than inferring one
 * from the other's presence.
 *
 * ## A failed cleanup is a warning, never a failed purge
 *
 * The session's bytes are already gone by the time this runs; a shard that
 * cannot be removed is residue to report, not a reason to report the purge
 * itself as failed (which would invite a retry that finds nothing left to
 * delete). Each failure becomes a `ProjCacheWarning` with a stable code that
 * the route layer forwards as a warning the client words.
 *
 * @module @dsh-app/plugin-archives/projcache
 */

import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_ID_SEGMENT } from './trash.ts'
import { rmWithRetry } from './fs-util.ts'

/** The domain directory's own name inside `<DSH_HOME>/storages/`. */
const DOMAIN_DIR = 'session_projcache'

/** The record table the domain stores its per-session documents in. */
const SESSIONS_TABLE = 'sessions'

/** The document suffix the JSON storage backend appends to a record key. */
const SHARD_SUFFIX = '.json'

/** The id prefix an earlier kernel line put in front of a session UUID. */
const LEGACY_PREFIX = 'session-'

/** Stable codes this module reports. */
export type ProjCacheWarningCode =
  /** A shard is there and could not be removed (locked, denied, or not a file). */
  | 'projcache-cleanup-failed'
  /** A shard name is occupied by something that is not a plain file; left alone. */
  | 'projcache-shard-not-a-file'

/** A cleanup that did not fully happen, with the session it concerned. */
export interface ProjCacheWarning {
  /** Stable code the client words in its own language. */
  readonly code: ProjCacheWarningCode
  /** The session whose shard it was, when the id was usable at all. */
  readonly id: string
  /** English diagnostic for logs; never shown as a sentence. */
  readonly detail: string
}

/**
 * The sessions table of the projection cache, inside one harness home.
 * @param dshHome - absolute `$DSH_HOME`.
 * @returns the absolute shard directory (`…/storages/session_projcache/sessions`).
 */
export function projCacheSessionsDir(dshHome: string): string {
  return join(dshHome, 'storages', DOMAIN_DIR, SESSIONS_TABLE)
}

/**
 * Every document name one session id can be stored under.
 *
 * Both shapes are returned, unconditionally: the file that exists is whichever
 * line wrote it, and nothing in an id says which line that was. The two names
 * are distinct strings, so a caller removing both never unlinks one twice for a
 * different reason than "it was not there".
 * @param id - session id, in either shape.
 * @returns the candidate document names, never empty.
 */
export function shardNamesFor(id: string): string[] {
  const other = id.startsWith(LEGACY_PREFIX) ? id.slice(LEGACY_PREFIX.length) : `${LEGACY_PREFIX}${id}`
  return [`${id}${SHARD_SUFFIX}`, `${other}${SHARD_SUFFIX}`]
}

/** Whether a probe failure is positive evidence that the shard is not there. */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Remove the projection-cache shards of the sessions a purge just deleted.
 *
 * Idempotent, and safe to call for an id whose shard was never written: both
 * candidate names are probed, an absent one is skipped without an unlink. Only
 * a plain file is ever removed — a directory or a link occupying a shard name
 * is left where it is and reported, because the kernel's own backend only ever
 * writes a regular document there and guessing what else it is would be a
 * delete nobody authorized.
 * @param input.dir - absolute shard directory, or undefined when the caller
 *   exposes none (nothing is cleaned and nothing is claimed).
 * @param input.ids - the sessions whose shards should go.
 * @returns one warning per shard that could not be removed.
 */
export async function purgeSessionShards(input: {
  dir: string | undefined
  ids: readonly string[]
}): Promise<ProjCacheWarning[]> {
  const warnings: ProjCacheWarning[] = []
  if (input.dir === undefined) return warnings
  for (const id of input.ids) {
    // A record key must be one path segment in the storage backend. An id that
    // is not one cannot name a shard this plugin should touch, and joining it
    // would be the path-escape this whole module avoids elsewhere.
    if (id === '.' || id === '..' || !SESSION_ID_SEGMENT.test(id)) {
      warnings.push({
        code: 'projcache-cleanup-failed',
        id,
        detail: `refusing to clean a cache shard for ${JSON.stringify(id)}: not a literal path segment`,
      })
      continue
    }
    for (const name of shardNamesFor(id)) {
      const path = join(input.dir, name)
      let kind
      try {
        kind = await fsp.lstat(path)
      } catch (error) {
        if (isAbsence(error)) continue
        warnings.push({
          code: 'projcache-cleanup-failed',
          id,
          detail: `could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      if (!kind.isFile()) {
        warnings.push({
          code: 'projcache-shard-not-a-file',
          id,
          detail: `left ${path} alone: it is not a plain file`,
        })
        continue
      }
      try {
        // The shard is a single locked-or-not file: the retry covers a read-only
        // attribute and a handle the indexer still holds.
        await rmWithRetry(path)
      } catch (error) {
        warnings.push({
          code: 'projcache-cleanup-failed',
          id,
          detail: `could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }
  return warnings
}
