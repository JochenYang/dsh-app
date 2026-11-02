/**
 * Behavioral tests for the session trash's storage layer.
 *
 * What is load-bearing here, in the order the module states it:
 *   - a path the filesystem will not describe is NOT "not there": `probePath`
 *     answers present / absent / unknown, and only `absent` frees data;
 *   - a move records where each member came from before anything moves, verifies
 *     each rename, and KEEPS the payload when a rollback cannot be proven;
 *   - restorability is what the payload holds, never how many members the metadata
 *     declares: an entry with one member still in it is restorable, and a member
 *     already back home is reported instead of refusing the batch;
 *   - a purge is authorized by positive evidence and by nothing else — a PRESENT
 *     slot for a session id, the row's own directory for a trash id — and a slot
 *     the filesystem will not describe is refused with a retryable code;
 *   - one restore plan answers both "may this row offer a restore" and "what will
 *     the restore do", so the two can never disagree;
 *   - what an entry reports is what is on disk, so a stale metadata line cannot
 *     aim a purge at a session that is back at its original path;
 *   - an unfinished deletion stays visible and retryable;
 *   - a restore is fenced by the root the call can see, and refused without one;
 *   - the path that is fenced is the path that is renamed.
 *
 * ## Fault injection
 *
 * Several states under test cannot be produced by asking a healthy filesystem to
 * fail: a rollback rename that fails, a rename that reports success without
 * moving anything, an `lstat` that is denied. Each is reproduced by substituting
 * ONE function on the `fs/promises` exports object — the module under test calls
 * through that object, which is exactly why it does (`src/trash.ts`, module
 * header). Every substitution is restored in a `finally`.
 *
 * @module @dsh-app/plugin-archives/tests/trash
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  TrashError,
  entryForAddress,
  isStrictlyInside,
  listEntries,
  lookupPurgeTarget,
  moveToTrash,
  planRestore,
  probeDirectory,
  probePath,
  purgeEntry,
  restoreEntry,
  trashErrorCode,
  type PurgeTarget,
  type TrashListing,
} from '../src/trash.ts'

/** Scratch roots this run created, removed when it finishes. */
const created: string[] = []

after(async () => {
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/**
 * The `fs/promises` exports object the module under test calls through. Patching
 * a property here substitutes one function for that module and for nothing else.
 */
const fsSurface = createRequire(import.meta.url)('node:fs/promises') as Record<string, unknown>

/** The real functions, captured before any test substitutes one. */
const originalRename = fsp.rename
const originalRm = fsp.rm
const originalLstat = fsp.lstat

/** Run `body` with one `fs` function substituted, restoring it afterwards. */
async function withFault(name: string, substitute: unknown, body: () => Promise<void>): Promise<void> {
  const original = fsSurface[name]
  fsSurface[name] = substitute
  try {
    await body()
  } finally {
    fsSurface[name] = original
  }
}

/** A permission failure, as an antivirus or the indexer produces it. */
function denied(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, lstat '${path}'`), { code: 'EPERM' })
}

/** A sessions root and a trash root beside it, both under one temporary base. */
async function fixture(): Promise<{ sessionsRoot: string; trashRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dshar-trash-'))
  created.push(base)
  const sessionsRoot = join(base, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  return { sessionsRoot, trashRoot: join(base, 'trash') }
}

/** Create one stored session directory (`<sessionsRoot>/<project>/<id>/`). */
async function sessionDir(sessionsRoot: string, id: string): Promise<string> {
  const dir = join(sessionsRoot, '--project--', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), '{"type":"session/header"}\n')
  return dir
}

/** Read one entry's metadata as raw JSON. */
async function metadataOf(trashRoot: string, trashId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(trashRoot, trashId, 'metadata.json'), 'utf8')) as Record<string, unknown>
}

/** Every directory under the trash root (purging leftovers included). */
async function trashDirectories(trashRoot: string): Promise<string[]> {
  try {
    return await readdir(trashRoot)
  } catch {
    return []
  }
}

/** The target a purge address resolves to; fails the test when it resolves to nothing. */
function purgeTargetOf(listing: TrashListing, id: string): PurgeTarget {
  const lookup = lookupPurgeTarget(listing, id)
  if (lookup.kind !== 'target') assert.fail(`${id} must name a purge target, but it resolved to ${lookup.kind}`)
  return lookup.target
}

/** Write a hand-made entry, the way a copied or edited metadata file looks. */
async function writeEntry(
  trashRoot: string,
  trashId: string,
  members: ReadonlyArray<{ sessionId: string; originalPath: string; payload: string }>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(trashRoot, trashId, 'payload'), { recursive: true })
  await writeFile(join(trashRoot, trashId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: members.map((member) => ({ title: '', sizeBytes: 1, ...member })),
    ...extra,
  }))
  for (const member of members) await mkdir(join(trashRoot, trashId, 'payload', member.payload), { recursive: true })
}

/**
 * Create a directory link (`junction` on Windows, `dir` symlink elsewhere).
 * @returns why it was impossible, or undefined on success.
 */
async function linkDirectory(target: string, linkPath: string): Promise<string | undefined> {
  try {
    await fsp.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return undefined
  } catch (error) {
    const code = (error as { code?: string }).code ?? String(error)
    return `directory links unavailable in this environment (${code}); on Windows this needs developer mode or administrator rights`
  }
}

test('a move lays the entry out as metadata plus payload/<n>', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')

  const entry = await moveToTrash({
    root: trashRoot,
    sessionsRoot,
    members: [{ sessionId: 'session-a', title: 'A title', dirPath: dir, sizeBytes: 24 }],
  })

  assert.match(entry.trashId, /^\d+-[0-9a-f]{8}$/)
  assert.equal(entry.state, 'ready')
  assert.equal(existsSync(dir), false, 'the original directory is gone')
  assert.equal(existsSync(join(trashRoot, entry.trashId, 'payload', '0', 'session.jsonl')), true)
  assert.deepEqual(await metadataOf(trashRoot, entry.trashId), {
    version: 1,
    state: 'ready',
    trashId: entry.trashId,
    deletedAt: entry.deletedAt,
    members: [{
      sessionId: 'session-a',
      title: 'A title',
      originalPath: dir,
      payload: '0',
      sizeBytes: 24,
    }],
  })
  const listing = await listEntries(trashRoot)
  assert.deepEqual(listing.entries.map((candidate) => candidate.entry.trashId), [entry.trashId])
  assert.deepEqual(listing.leftovers, [])
  assert.equal(listing.entries[0].restorable, true)
  assert.deepEqual(listing.entries[0].present, ['session-a'])
  assert.deepEqual(listing.entries[0].unreadable, [])
  assert.deepEqual(listing.entries[0].held, ['session-a'])
})

test('a member that is not a plain directory is refused', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const project = join(sessionsRoot, '--project--')
  await mkdir(project, { recursive: true })
  const file = join(project, 'session-a')
  await writeFile(file, 'not a directory')

  await assert.rejects(
    moveToTrash({
      root: trashRoot,
      sessionsRoot,
      members: [{ sessionId: 'session-a', title: '', dirPath: file, sizeBytes: 4 }],
    }),
    (error: unknown) => trashErrorCode(error) === 'trash-invalid-member',
  )
  assert.equal(existsSync(file), true, 'a refused member is never moved')
  assert.deepEqual((await listEntries(trashRoot)).entries, [])
})

test('a move refuses a member that is not there', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  await assert.rejects(
    moveToTrash({
      root: trashRoot,
      sessionsRoot,
      members: [{ sessionId: 'session-b', title: '', dirPath: join(sessionsRoot, '--project--', 'session-b'), sizeBytes: 1 }],
    }),
    (error: unknown) => trashErrorCode(error) === 'trash-invalid-member',
  )
  assert.deepEqual((await listEntries(trashRoot)).entries, [])
})

test('a move refuses a directory outside the sessions root', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)

  await assert.rejects(
    moveToTrash({
      root: trashRoot,
      sessionsRoot,
      members: [{ sessionId: 'session-a', title: '', dirPath: outside, sizeBytes: 0 }],
    }),
    (error: unknown) => trashErrorCode(error) === 'trash-path-outside-root',
  )
  assert.equal(existsSync(outside), true, 'a refused member is never moved')
})

test('a move that fails partway puts the moved members back and drops the entry', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const first = await sessionDir(sessionsRoot, 'session-a')
  const second = await sessionDir(sessionsRoot, 'session-b')

  let thrown: unknown
  await withFault(
    'rename',
    async (from: string, to: string) => {
      if (from === second) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' })
      }
      return originalRename(from, to)
    },
    async () => {
      try {
        await moveToTrash({
          root: trashRoot,
          sessionsRoot,
          members: [
            { sessionId: 'session-a', title: '', dirPath: first, sizeBytes: 24 },
            { sessionId: 'session-b', title: '', dirPath: second, sizeBytes: 24 },
          ],
        })
      } catch (error) {
        thrown = error
      }
    },
  )

  assert.equal(trashErrorCode(thrown), 'trash-move-failed')
  assert.equal(existsSync(join(first, 'session.jsonl')), true, 'the member already moved is back where it came from')
  assert.equal(existsSync(second), true, 'the member that failed never moved')
  assert.deepEqual((await listEntries(trashRoot)).entries, [], 'the half-built entry is gone')
  assert.deepEqual(await trashDirectories(trashRoot), [], 'not one entry directory is left behind')
})

test('a move whose rollback ALSO fails keeps the payload and names the entry', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const first = await sessionDir(sessionsRoot, 'session-a')
  const second = await sessionDir(sessionsRoot, 'session-b')

  let thrown: unknown
  await withFault(
    'rename',
    async (from: string, to: string) => {
      if (from === second) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' })
      }
      if (to === first) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      return originalRename(from, to)
    },
    async () => {
      try {
        await moveToTrash({
          root: trashRoot,
          sessionsRoot,
          members: [
            { sessionId: 'session-a', title: '', dirPath: first, sizeBytes: 24 },
            { sessionId: 'session-b', title: '', dirPath: second, sizeBytes: 24 },
          ],
        })
      } catch (error) {
        thrown = error
      }
    },
  )

  assert.ok(thrown instanceof TrashError, 'the move must fail')
  const error = thrown as TrashError
  assert.equal(error.code, 'trash-rollback-failed')
  assert.deepEqual(error.stuckIds, ['session-a'])
  assert.ok(error.trashId !== undefined, 'the error carries the entry id')
  assert.match(error.message, new RegExp(error.trashId!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), 'and the entry path')

  assert.equal(existsSync(join(trashRoot, error.trashId!, 'payload', '0', 'session.jsonl')), true, 'the payload is still here')
  const metadata = await metadataOf(trashRoot, error.trashId!)
  assert.equal(metadata.state, 'moving')
  assert.deepEqual((metadata.members as Array<{ sessionId: string }>).map((member) => member.sessionId), ['session-a'])
  const listing = await listEntries(trashRoot)
  assert.equal(listing.entries.length, 1, 'a person can see it in the trash')
  assert.deepEqual(listing.entries[0].present, ['session-a'], 'and can see which session is parked there')
})

test('a slot the filesystem will not describe is not treated as absent', async () => {
  // F1: an EPERM on the payload slot used to be read as "it is not there", so the
  // rollback skipped the member, the entry looked empty, and the payload was
  // deleted with it — the session gone from the disk, the trash and the list.
  // This reproduces that pair: the slot cannot be inspected AND the way back is
  // blocked, so nothing can prove the member left the trash.
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')

  let thrown: unknown
  await withFault(
    'lstat',
    async (path: string, ...rest: unknown[]) => {
      if (/payload[\\\\/]0$/u.test(path)) throw denied(path)
      return (originalLstat as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    },
    async () => {
      await withFault(
        'rename',
        async (from: string, to: string) => {
          if (to === dir) {
            throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' })
          }
          return originalRename(from, to)
        },
        async () => {
          try {
            await moveToTrash({
              root: trashRoot,
              sessionsRoot,
              members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }],
            })
          } catch (error) {
            thrown = error
          }
        },
      )
    },
  )

  assert.equal(trashErrorCode(thrown), 'trash-rollback-failed', 'nothing could prove the member left the trash')
  const error = thrown as TrashError
  assert.ok(error.trashId !== undefined)
  assert.deepEqual(error.stuckIds, ['session-a'], 'the member counts as still parked')
  assert.equal(existsSync(join(trashRoot, error.trashId!, 'payload', '0', 'session.jsonl')), true, 'so the payload is still here')
  assert.equal((await listEntries(trashRoot)).entries.length, 1, 'and it is visible')
})

test('a rename that reports success without moving anything leaves no ghost entry', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')

  let thrown: unknown
  await withFault(
    'rename',
    async (from: string, to: string) => {
      // The lie: success reported, directory untouched.
      if (from === dir) return undefined
      return originalRename(from, to)
    },
    async () => {
      try {
        await moveToTrash({
          root: trashRoot,
          sessionsRoot,
          members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }],
        })
      } catch (error) {
        thrown = error
      }
    },
  )

  assert.equal(trashErrorCode(thrown), 'trash-concurrent-move')
  assert.equal(existsSync(dir), true, 'the directory never moved')
  assert.deepEqual((await listEntries(trashRoot)).entries, [], 'and no entry claims to hold it')
  assert.deepEqual(await trashDirectories(trashRoot), [], 'no ghost directory either')
})

test('a complete payload is restorable even when the state was never committed', async () => {
  // F2: the commit write is diagnostic. A crash right before it used to leave a
  // session that sat in the trash with no way to get it back from the product.
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }] })
  const metadata = await metadataOf(trashRoot, entry.trashId)
  await writeFile(join(trashRoot, entry.trashId, 'metadata.json'), JSON.stringify({ ...metadata, state: 'moving' }))

  const listing = await listEntries(trashRoot)
  assert.equal(listing.entries[0].restorable, true, 'the payload is what decides')
  assert.equal(entryForAddress(listing, 'session-a')?.entry.trashId, entry.trashId)

  const outcome = await restoreEntry({ root: trashRoot, sessionsRoot, trashId: entry.trashId })
  assert.deepEqual(outcome.entry.members.map((member) => member.sessionId), ['session-a'])
  assert.equal(existsSync(join(dir, 'session.jsonl')), true, 'and it comes back')
})

test('an entry whose payload is gone is listed as having nothing to restore', async () => {
  // B1: the old rule was "restorable only when EVERY declared member's slot is
  // present", which made the metadata's member count a verdict. The disk is the
  // verdict: with no slot present there is nothing to put back, and the entry is
  // reported (and clearable) rather than restorable.
  const { sessionsRoot, trashRoot } = await fixture()
  const trashId = '1700000000000-abcdef01'
  const dir = join(sessionsRoot, '--project--', 'session-a')
  await writeEntry(trashRoot, trashId, [{ sessionId: 'session-a', originalPath: dir, payload: '0' }])
  await rm(join(trashRoot, trashId, 'payload', '0'), { recursive: true, force: true })

  const listing = await listEntries(trashRoot)
  assert.equal(listing.entries[0].restorable, false)
  assert.deepEqual(listing.entries[0].present, [])
  assert.deepEqual(listing.entries[0].held, [], 'a slot proven gone is not reported as held')
  assert.equal(entryForAddress(listing, 'session-a'), undefined, 'and no restore path picks it')

  // A restore has nothing to move, and says what became of the member instead of
  // refusing the request: the payload is not in the trash and not at its path.
  const outcome = await restoreEntry({ root: trashRoot, sessionsRoot, trashId })
  assert.deepEqual(outcome.restored, [])
  assert.deepEqual(outcome.alreadyHome, [])
  assert.deepEqual(outcome.lost, ['session-a'])
  assert.equal(existsSync(join(trashRoot, trashId)), false, 'the entry held nothing, so it is gone')
})

test('an entry keeps its reachable payload after one member went home', async () => {
  // B1: one member already restored used to make the whole entry unrestorable
  // (`present.length === members.length`), so the only action left on a payload
  // that was still intact was the irreversible one.
  const { sessionsRoot, trashRoot } = await fixture()
  const trashId = '1700000000000-abcdef01'
  const parked = join(sessionsRoot, '--project--', 'session-a')
  const wentBack = join(sessionsRoot, '--project--', 'session-b')
  await writeEntry(trashRoot, trashId, [
    { sessionId: 'session-a', originalPath: parked, payload: '0' },
    { sessionId: 'session-b', originalPath: wentBack, payload: '1' },
  ])
  await writeFile(join(trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'a')
  // session-b is back at its original path, so its slot is gone.
  await rm(join(trashRoot, trashId, 'payload', '1'), { recursive: true, force: true })
  await mkdir(wentBack, { recursive: true })
  await writeFile(join(wentBack, 'session.jsonl'), 'b')

  const listing = await listEntries(trashRoot)
  assert.equal(listing.entries[0].restorable, true, 'the payload that IS here is restorable')
  assert.deepEqual(listing.entries[0].present, ['session-a'])
  assert.equal(entryForAddress(listing, 'session-a')?.entry.trashId, trashId)

  const outcome = await restoreEntry({ root: trashRoot, sessionsRoot, trashId })
  assert.deepEqual(outcome.restored, ['session-a'], 'only what is here moves')
  assert.deepEqual(outcome.alreadyHome, ['session-b'], 'and the member that was home is reported as such')
  assert.deepEqual(outcome.lost, [])
  assert.equal(existsSync(join(parked, 'session.jsonl')), true, 'the parked member is back')
  assert.equal(existsSync(join(wentBack, 'session.jsonl')), true, 'the member that was home is untouched')
  assert.equal(existsSync(join(trashRoot, trashId)), false, 'the emptied entry is removed')
})

test('an unreadable payload slot refuses the restore instead of guessing', async () => {
  // B1: `unknown` cannot confirm the payload is complete, and a restore is an
  // all-or-nothing move of the batch — so it is refused with a retryable code,
  // and nothing is moved.
  const { sessionsRoot, trashRoot } = await fixture()
  const trashId = '1700000000000-abcdef01'
  const dir = join(sessionsRoot, '--project--', 'session-a')
  await writeEntry(trashRoot, trashId, [{ sessionId: 'session-a', originalPath: dir, payload: '0' }])
  await writeFile(join(trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'a')

  let thrown: unknown
  await withFault(
    'lstat',
    async (path: string, ...rest: unknown[]) => {
      if (/payload[\\/]+0$/u.test(path)) throw denied(path)
      return (originalLstat as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    },
    async () => {
      try {
        await restoreEntry({ root: trashRoot, sessionsRoot, trashId })
      } catch (error) {
        thrown = error
      }
    },
  )

  assert.equal(trashErrorCode(thrown), 'trash-state-unconfirmed', 'a retryable code, not "incomplete"')
  assert.equal(existsSync(join(trashRoot, trashId, 'payload', '0', 'session.jsonl')), true, 'nothing moved')
  assert.equal(existsSync(dir), false, 'and nothing was written to the target')
})

test('a restore plan names the capability it is missing, before anything moves', async () => {
  // B4: the SAME plan answers GET /trash ("may this row offer a restore?") and the
  // restore request itself, so a row can never advertise an action its own fence
  // has already made impossible.
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const trashId = '1700000000000-abcdef01'
  await writeEntry(trashRoot, trashId, [
    { sessionId: 'session-a', originalPath: join(outside, 'session-a'), payload: '0' },
  ])
  const listed = (await listEntries(trashRoot)).entries[0]
  const entryDir = join(trashRoot, trashId)

  // The payload is here, so the only thing missing is a root to fence against.
  const rootless = await planRestore({ entry: listed.entry, entryDir, sessionsRoot: undefined })
  assert.equal(rootless.blocked?.code, 'needs-root')
  assert.deepEqual(rootless.moving, [], 'and nothing is planned to move')

  const fenced = await planRestore({ entry: listed.entry, entryDir, sessionsRoot })
  assert.equal(fenced.blocked?.code, 'outside-root')
  assert.deepEqual(fenced.moving, [], 'a path outside the root is never planned')
})

test('a listing reports only the members that are really on disk', async () => {
  // F3: metadata may still name a member that went back to its original path. The
  // listing must not repeat that claim, because a purge acts on what it lists.
  const { sessionsRoot, trashRoot } = await fixture()
  const parked = join(sessionsRoot, '--project--', 'session-a')
  const wentBack = join(sessionsRoot, '--project--', 'session-b')
  await mkdir(wentBack, { recursive: true })
  await writeFile(join(wentBack, 'session.jsonl'), 'x')
  await writeEntry(trashRoot, '1700000000000-abcdef01', [
    { sessionId: 'session-a', originalPath: parked, payload: '0' },
    { sessionId: 'session-b', originalPath: wentBack, payload: '1' },
  ])
  // session-b is back at its original path, so its slot is gone.
  await rm(join(trashRoot, '1700000000000-abcdef01', 'payload', '1'), { recursive: true, force: true })

  const listing = await listEntries(trashRoot)
  assert.deepEqual(listing.entries[0].present, ['session-a'])
  assert.deepEqual(listing.entries[0].held, ['session-a'], 'the member that is back home is not held')
  assert.deepEqual(lookupPurgeTarget(listing, 'session-b'), { kind: 'none' }, 'and a purge by its id cannot reach this entry')
  // B3: the row itself is still a handle, which is what keeps a listed row clearable.
  assert.equal(lookupPurgeTarget(listing, '1700000000000-abcdef01').kind, 'target')
})

test('a listing reports a malformed entry as a row instead of skipping it', async () => {
  // It used to be skipped, which made a directory of bytes that no request could
  // name: not an entry, not a leftover, unreachable. Its name is a minted trash
  // id, so it is listed as an `unverified` leftover and `/purge` can free it.
  const { sessionsRoot, trashRoot } = await fixture()
  const older = await sessionDir(sessionsRoot, 'session-old')
  const newer = await sessionDir(sessionsRoot, 'session-new')
  const first = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-old', title: '', dirPath: older, sizeBytes: 1 }] })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  const second = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-new', title: '', dirPath: newer, sizeBytes: 1 }] })
  await mkdir(join(trashRoot, '1700000000000-aaaaaaaa'))
  await mkdir(join(trashRoot, '1700000000000-bbbbbbbb'))
  await writeFile(join(trashRoot, '1700000000000-bbbbbbbb', 'metadata.json'), '{ not json')

  const listing = await listEntries(trashRoot)
  assert.deepEqual(listing.entries.map((candidate) => candidate.entry.trashId), [second.trashId, first.trashId],
    'the readable entries, newest first')
  assert.deepEqual(
    listing.leftovers.map((candidate) => [candidate.trashId, candidate.kind, candidate.members.length]),
    [['1700000000000-bbbbbbbb', 'unverified', 0], ['1700000000000-aaaaaaaa', 'unverified', 0]],
    'and the unreadable ones are rows, newest first, naming no member',
  )
  assert.equal(lookupPurgeTarget(listing, '1700000000000-bbbbbbbb').kind, 'target',
    'the directory name is the handle that frees it')
  assert.equal(entryForAddress(listing, '1700000000000-bbbbbbbb'), undefined, 'but nothing can be restored from it')
})

test('a restore puts the directory back and removes the entry', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }] })

  const outcome = await restoreEntry({ root: trashRoot, sessionsRoot, trashId: entry.trashId })

  assert.deepEqual(outcome.warnings, [])
  assert.equal(existsSync(join(dir, 'session.jsonl')), true, 'the log is back at its original path')
  assert.equal(existsSync(join(trashRoot, entry.trashId)), false, 'the emptied entry is removed')
  assert.deepEqual((await listEntries(trashRoot)).entries, [])
})

test('a restore refuses an occupied original path and leaves the entry intact', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }] })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), '{"type":"session/header"}\n')

  await assert.rejects(
    restoreEntry({ root: trashRoot, sessionsRoot, trashId: entry.trashId }),
    (error: unknown) => trashErrorCode(error) === 'trash-target-exists',
  )
  assert.equal(existsSync(join(trashRoot, entry.trashId, 'payload', '0', 'session.jsonl')), true, 'nothing moved')
})

test('a restore refuses a recorded path outside the current sessions root', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const trashId = '1700000000000-abcdef01'
  await writeEntry(trashRoot, trashId, [{ sessionId: 'session-a', originalPath: join(outside, 'session-a'), payload: '0' }])

  await assert.rejects(
    restoreEntry({ root: trashRoot, sessionsRoot, trashId }),
    (error: unknown) => trashErrorCode(error) === 'trash-path-outside-root',
  )
  assert.equal(existsSync(join(outside, 'session-a')), false, 'nothing is written outside the sessions root')
})

test('a restore is refused when no sessions root is available', async () => {
  // F5: the fence is decided by the root THIS call can see, never by a flag the
  // metadata file carries.
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }] })

  await assert.rejects(
    restoreEntry({ root: trashRoot, sessionsRoot: undefined, trashId: entry.trashId }),
    (error: unknown) => trashErrorCode(error) === 'trash-restore-needs-root',
  )
  assert.equal(existsSync(join(trashRoot, entry.trashId, 'payload', '0', 'session.jsonl')), true, 'nothing moved')
})

test('a rootUnknown flag cannot widen the fence', async () => {
  // F5: editing `rootUnknown` into a metadata file used to skip `assertContained`
  // entirely. It is a diagnostic note now; the current root decides.
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const trashId = '1700000000000-abcdef01'
  await writeEntry(
    trashRoot,
    trashId,
    [{ sessionId: 'session-a', originalPath: join(outside, 'session-a'), payload: '0' }],
    { rootUnknown: true },
  )

  await assert.rejects(
    restoreEntry({ root: trashRoot, sessionsRoot, trashId }),
    (error: unknown) => trashErrorCode(error) === 'trash-path-outside-root',
  )
  assert.equal(existsSync(join(outside, 'session-a')), false, 'nothing is written outside the sessions root')
})

test('a junction under the sessions root cannot aim a move outside it', async (t) => {
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const reason = await linkDirectory(outside, join(sessionsRoot, 'link'))
  if (reason !== undefined) {
    t.diagnostic(reason)
    t.skip(reason)
    return
  }
  await mkdir(join(outside, 'session-a'), { recursive: true })
  await writeFile(join(outside, 'session-a', 'session.jsonl'), 'x')
  const viaLink = join(sessionsRoot, 'link', 'session-a')
  assert.equal(isStrictlyInside(sessionsRoot, viaLink), true, 'the string fence cannot see it — that is the point')

  await assert.rejects(
    moveToTrash({
      root: trashRoot,
      sessionsRoot,
      members: [{ sessionId: 'session-a', title: '', dirPath: viaLink, sizeBytes: 1 }],
    }),
    (error: unknown) => trashErrorCode(error) === 'trash-path-outside-root',
  )
  assert.equal(existsSync(join(outside, 'session-a', 'session.jsonl')), true, 'the directory outside is untouched')
})

test('a junction under the sessions root cannot aim a restore outside it', async (t) => {
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const reason = await linkDirectory(outside, join(sessionsRoot, 'link'))
  if (reason !== undefined) {
    t.diagnostic(reason)
    t.skip(reason)
    return
  }
  const trashId = '1700000000000-abcdef01'
  await writeEntry(trashRoot, trashId, [{
    sessionId: 'session-a',
    originalPath: join(sessionsRoot, 'link', 'session-a'),
    payload: '0',
  }])

  await assert.rejects(
    restoreEntry({ root: trashRoot, sessionsRoot, trashId }),
    (error: unknown) => trashErrorCode(error) === 'trash-path-outside-root',
  )
  assert.equal(existsSync(join(outside, 'session-a')), false, 'nothing is written outside the sessions root')
})

test('the path that is checked is the path that is moved', async () => {
  // F6: a `link/../name` spelling resolves differently on POSIX (the kernel
  // follows `link` before `..`) than the lexical `resolve()` used for the fence.
  // Resolving once and using THAT string for both closes it: whatever the
  // spelling meant, the rename never sees a `..`.
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const reason = await linkDirectory(outside, join(sessionsRoot, 'link'))
  if (reason !== undefined) {
    t.diagnostic(reason)
    t.skip(reason)
    return
  }
  // The lexical resolution of `link/../session-a` is `<sessionsRoot>/session-a`,
  // so that is the directory the move must touch.
  const real = join(sessionsRoot, 'session-a')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'session.jsonl'), 'inside')
  await mkdir(join(outside, 'session-a'), { recursive: true })
  await writeFile(join(outside, 'session-a', 'session.jsonl'), 'outside')

  const seen: string[] = []
  await withFault(
    'rename',
    async (from: string, to: string) => {
      seen.push(from)
      return originalRename(from, to)
    },
    async () => {
      await moveToTrash({
        root: trashRoot,
        sessionsRoot,
        members: [{
          sessionId: 'session-a',
          title: '',
          dirPath: join(sessionsRoot, 'link', '..', 'session-a'),
          sizeBytes: 1,
        }],
      })
    },
  )

  assert.ok(seen.includes(real), 'the rename touched the normalized path')
  assert.equal(seen.some((path) => path.includes('..')), false, 'and never a path with a `..` segment')
  assert.equal(existsSync(join(outside, 'session-a', 'session.jsonl')), true, 'the directory outside is untouched')
})

test('POSIX: a link/.. spelling cannot move a directory outside the root', async (t) => {
  if (process.platform === 'win32') {
    // Win32 normalizes `junction/..` lexically before the filesystem sees it, so
    // the difference this test exists for cannot be reproduced here.
    t.diagnostic('skipped on win32: the platform resolves `junction/..` lexically, so the hazard is not observable')
    t.skip('win32 resolves the spelling lexically; run on POSIX to exercise the kernel path')
    return
  }
  const { sessionsRoot, trashRoot } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const reason = await linkDirectory(outside, join(sessionsRoot, 'link'))
  if (reason !== undefined) {
    t.diagnostic(reason)
    t.skip(reason)
    return
  }
  // `outside/session-a` is what the kernel sees for `link/../session-a`.
  await mkdir(join(outside, 'session-a'), { recursive: true })
  await writeFile(join(outside, 'session-a', 'session.jsonl'), 'outside')
  // `sessionsRoot/session-a` is what the lexical resolution sees.
  await mkdir(join(sessionsRoot, 'session-a'), { recursive: true })
  await writeFile(join(sessionsRoot, 'session-a', 'session.jsonl'), 'inside')

  await moveToTrash({
    root: trashRoot,
    sessionsRoot,
    members: [{ sessionId: 'session-a', title: '', dirPath: join(sessionsRoot, 'link', '..', 'session-a'), sizeBytes: 1 }],
  })

  assert.equal(existsSync(join(outside, 'session-a', 'session.jsonl')), true, 'the directory outside is untouched')
  assert.equal(existsSync(join(sessionsRoot, 'session-a')), false, 'the verified path is the one that moved')
})

test('a purge removes the entry and reports the bytes it held', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }] })
  const target = purgeTargetOf(await listEntries(trashRoot), 'session-a')

  const { freedBytes } = await purgeEntry({ root: trashRoot, target })

  assert.ok(freedBytes > 0, 'the recursive size of the payload is reported')
  assert.equal(existsSync(join(trashRoot, entry.trashId)), false)
  assert.deepEqual(lookupPurgeTarget(await listEntries(trashRoot), 'session-a'), { kind: 'none' })
})

test('a purge that fails halfway leaves a visible leftover that can be retried', async () => {
  // F4: the entry is out of service the moment its deletion starts, and what it
  // could not delete stays LISTED — invisible bytes are how residue accumulates.
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({ root: trashRoot, sessionsRoot, members: [{ sessionId: 'session-a', title: '', dirPath: dir, sizeBytes: 24 }] })
  const target = purgeTargetOf(await listEntries(trashRoot), 'session-a')
  assert.ok(target !== undefined)

  let thrown: unknown
  await withFault(
    'rm',
    async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (path.includes('.purging')) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: 'EBUSY' })
      }
      return originalRm(path, options)
    },
    async () => {
      try {
        await purgeEntry({ root: trashRoot, target })
      } catch (error) {
        thrown = error
      }
    },
  )

  assert.equal(trashErrorCode(thrown), 'trash-purge-failed')
  assert.equal(existsSync(join(trashRoot, entry.trashId)), false, 'the entry is no longer an entry')
  const afterFailure = await listEntries(trashRoot)
  assert.deepEqual(afterFailure.entries, [], 'so it is not offered for restore')
  assert.equal(afterFailure.leftovers.length, 1, 'but its bytes are on the books')
  assert.equal(afterFailure.leftovers[0].dirName, `${entry.trashId}.purging`)
  assert.ok(afterFailure.leftovers[0].bytes > 0)
  assert.equal(afterFailure.leftovers[0].members[0]?.sessionId, 'session-a', 'its metadata is still readable')

  // And the retry finishes the job.
  const retry = purgeTargetOf(afterFailure, 'session-a')
  const { freedBytes } = await purgeEntry({ root: trashRoot, target: retry })
  assert.ok(freedBytes > 0)
  assert.deepEqual(await listEntries(trashRoot), { entries: [], leftovers: [] })
})

test('a leftover with no readable metadata is still addressable by its trash id', async () => {
  const { trashRoot } = await fixture()
  const trashId = '1700000000000-abcdef01'
  await mkdir(join(trashRoot, `${trashId}.purging`, 'payload', '0'), { recursive: true })
  await writeFile(join(trashRoot, `${trashId}.purging`, 'payload', '0', 'session.jsonl'), 'x')

  const listing = await listEntries(trashRoot)
  assert.equal(listing.leftovers[0].members.length, 0)
  const target = purgeTargetOf(listing, trashId)
  await purgeEntry({ root: trashRoot, target })
  assert.deepEqual(await listEntries(trashRoot), { entries: [], leftovers: [] })
})

test('a purge addressed by the row id removes an entry that holds nothing', async () => {
  // B3: this is the row P1-3 could not clear. Every declared member is gone, so
  // no session id names it — and the row was on screen with no request that could
  // remove it. The directory name is the identity, so it is the handle.
  const { sessionsRoot, trashRoot } = await fixture()
  const trashId = '1700000000000-abcdef01'
  const dir = join(sessionsRoot, '--project--', 'session-a')
  await writeEntry(trashRoot, trashId, [{ sessionId: 'session-a', originalPath: dir, payload: '0' }])
  await rm(join(trashRoot, trashId, 'payload', '0'), { recursive: true, force: true })

  const listing = await listEntries(trashRoot)
  assert.equal(listing.entries[0].restorable, false)
  assert.deepEqual(listing.entries[0].entry.members.map((member) => member.sessionId), ['session-a'],
    'the row still describes the member it was created for')
  assert.equal(entryForAddress(listing, 'session-a'), undefined, 'no session id names it any more')

  const { freedBytes } = await purgeEntry({ root: trashRoot, target: purgeTargetOf(listing, trashId) })
  assert.equal(freedBytes, 0, 'nothing was in it')
  assert.deepEqual(await listEntries(trashRoot), { entries: [], leftovers: [] }, 'and the row is gone')
})

test('a purge by a member id needs the payload to be present, and refuses "cannot tell"', async () => {
  // B2: a purge is the one irreversible act here, so it is authorized by positive
  // evidence. A member that went home must not be a handle for deleting a payload
  // that IS still in the entry, and a slot the filesystem will not describe is
  // refused with a retryable answer instead of being read as "it may be there".
  const { sessionsRoot, trashRoot } = await fixture()
  const trashId = '1700000000000-abcdef01'
  const parked = join(sessionsRoot, '--project--', 'session-a')
  const wentBack = join(sessionsRoot, '--project--', 'session-b')
  await writeEntry(trashRoot, trashId, [
    { sessionId: 'session-a', originalPath: parked, payload: '0' },
    { sessionId: 'session-b', originalPath: wentBack, payload: '1' },
  ])
  await writeFile(join(trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'a')
  // session-b is back at its original path: its slot is gone and its path is there.
  await rm(join(trashRoot, trashId, 'payload', '1'), { recursive: true, force: true })
  await mkdir(wentBack, { recursive: true })
  await writeFile(join(wentBack, 'session.jsonl'), 'b')

  const listing = await listEntries(trashRoot)
  assert.deepEqual(lookupPurgeTarget(listing, 'session-b'), { kind: 'none' }, 'a member that went home names nothing')
  assert.equal(lookupPurgeTarget(listing, 'session-a').kind, 'target', 'a member that is here authorizes it')

  let refused: unknown
  await withFault(
    'lstat',
    async (path: string, ...rest: unknown[]) => {
      if (/payload[\\/]+0$/u.test(path)) throw denied(path)
      return (originalLstat as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    },
    async () => {
      refused = lookupPurgeTarget(await listEntries(trashRoot), 'session-a')
    },
  )
  assert.equal((refused as { kind: string }).kind, 'refused', 'an unreadable slot authorizes nothing')
  assert.equal((refused as { code: string }).code, 'trash-state-unconfirmed')

  // The row id still works, which is what keeps it from being a locked door.
  assert.equal(lookupPurgeTarget(await listEntries(trashRoot), trashId).kind, 'target')
})

test('probes separate "not there" from "cannot tell"', async () => {
  const { sessionsRoot } = await fixture()
  const missing = join(sessionsRoot, '--project--', 'session-a')
  assert.equal(await probePath(missing), 'absent')
  assert.equal(await probeDirectory(missing), 'absent')

  const dir = await sessionDir(sessionsRoot, 'session-b')
  assert.equal(await probePath(dir), 'present')
  assert.equal(await probeDirectory(dir), 'present')
  assert.equal(await probeDirectory(join(dir, 'session.jsonl')), 'absent', 'a file is not a directory')

  await withFault(
    'lstat',
    async (path: string) => { throw denied(path) },
    async () => {
      assert.equal(await probePath(dir), 'unknown', 'a denied lstat is not absence')
      assert.equal(await probeDirectory(dir), 'unknown')
    },
  )
})

test('containment is decided by path.relative, not by a string prefix', () => {
  const root = join(tmpdir(), 'dshar-root')
  assert.equal(isStrictlyInside(root, join(root, 'p', 'session-a')), true)
  assert.equal(isStrictlyInside(root, `${root}-evil${'\\'}session-a`), false)
  assert.equal(isStrictlyInside(root, `${root}-evil/session-a`), false)
  assert.equal(isStrictlyInside(root, root), false)
  assert.equal(isStrictlyInside(root, join(root, '..', 'elsewhere')), false)
  if (process.platform === 'win32') {
    assert.equal(isStrictlyInside(root, 'Z:\\elsewhere\\session-a'), false)
    assert.equal(isStrictlyInside(root, join(root, 'p').toUpperCase()), true)
  }
})

test('a member path is stored normalized', async () => {
  const { sessionsRoot, trashRoot } = await fixture()
  const dir = await sessionDir(sessionsRoot, 'session-a')
  const entry = await moveToTrash({
    root: trashRoot,
    sessionsRoot,
    members: [{ sessionId: 'session-a', title: '', dirPath: join(dir, '..', 'session-a'), sizeBytes: 24 }],
  })
  assert.equal(entry.members[0].originalPath, resolve(dir), 'the stored path is the one that was moved')
})
