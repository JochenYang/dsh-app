/**
 * Behavioral tests for the projection-cache cleanup.
 *
 * What is load-bearing here:
 *   - BOTH id spellings are cleaned. The kernel has written a shard under
 *     `session-<uuid>` and, on later lines, under a bare `<uuid>`; a cleanup that
 *     knows one spelling leaks about half of them (241 and 228 of the 469 shards
 *     on the machine this was measured on);
 *   - another session's shard is never touched;
 *   - only a plain file is ever removed: a directory occupying a shard name is
 *     reported and left alone;
 *   - a failure is a WARNING with a stable code, and the rest of the batch still
 *     runs — the session's bytes are already gone by then, so nothing here may
 *     report the purge as failed;
 *   - an id that is not one path segment is refused before any join.
 *
 * @module @dsh-app/plugin-archives/tests/projcache
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projCacheSessionsDir, purgeSessionShards, shardNamesFor } from '../src/projcache.ts'

/** Scratch roots this run created, removed when it finishes. */
const created: string[] = []

after(async () => {
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/** A fresh shard directory, laid out the way the JSON storage backend does. */
async function fixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dshar-projcache-'))
  created.push(home)
  const dir = projCacheSessionsDir(home)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write one shard document. */
async function shard(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), '{"ver":7}')
}

test('the sessions directory is the kernel JSON backend layout', () => {
  assert.equal(
    projCacheSessionsDir(join('C:', 'home')).endsWith(join('storages', 'session_projcache', 'sessions')),
    true,
  )
})

test('both id spellings are candidates for one session', () => {
  assert.deepEqual(shardNamesFor('4b1f-uuid'), ['4b1f-uuid.json', 'session-4b1f-uuid.json'])
  assert.deepEqual(shardNamesFor('session-4b1f-uuid'), ['session-4b1f-uuid.json', '4b1f-uuid.json'])
})

test('a purge removes the shard under either spelling and leaves the rest', async () => {
  const dir = await fixture()
  const uuid = '4b1f28a6-1111-4c4c-9999-abcdefabcdef'
  // The two generations the kernel has written, side by side, as they are on disk.
  await shard(dir, `${uuid}.json`)
  await shard(dir, `session-${uuid}.json`)
  await shard(dir, 'another-session.json')

  const warnings = await purgeSessionShards({ dir, ids: [uuid] })

  assert.deepEqual(warnings, [], 'nothing to report')
  assert.equal(existsSync(join(dir, `${uuid}.json`)), false, 'the bare-UUID shard is gone')
  assert.equal(existsSync(join(dir, `session-${uuid}.json`)), false, 'and the legacy spelling with it')
  assert.deepEqual(await readdir(dir), ['another-session.json'], 'no other session is touched')
})

test('a purge named by the legacy spelling removes both too', async () => {
  const dir = await fixture()
  const uuid = '4b1f28a6-2222-4c4c-9999-abcdefabcdef'
  await shard(dir, `${uuid}.json`)
  await shard(dir, `session-${uuid}.json`)

  const warnings = await purgeSessionShards({ dir, ids: [`session-${uuid}`] })

  assert.deepEqual(warnings, [])
  assert.deepEqual(await readdir(dir), [])
})

test('a host that exposes no shard directory cleans nothing and claims nothing', async () => {
  const warnings = await purgeSessionShards({ dir: undefined, ids: ['session-a'] })
  assert.deepEqual(warnings, [])
})

test('a shard name holding a directory is reported, not deleted', async () => {
  const dir = await fixture()
  const uuid = '4b1f28a6-3333-4c4c-9999-abcdefabcdef'
  await mkdir(join(dir, `${uuid}.json`))
  await shard(dir, 'session-b.json')

  const warnings = await purgeSessionShards({ dir, ids: [uuid, 'session-b'] })

  assert.deepEqual(warnings.map((warning) => [warning.code, warning.id]), [
    ['projcache-shard-not-a-file', uuid],
  ])
  assert.equal(existsSync(join(dir, `${uuid}.json`)), true, 'the foreign object is left where it was')
  assert.equal(existsSync(join(dir, 'session-b.json')), false, 'and the batch still ran')
})

test('an id that is not one path segment is refused before any join', async () => {
  const dir = await fixture()
  const warnings = await purgeSessionShards({ dir, ids: ['..\\escape'] })
  assert.deepEqual(warnings.map((warning) => warning.code), ['projcache-cleanup-failed'])
  assert.deepEqual(await readdir(dir), [], 'and nothing was created or removed')
})

test('a shard that cannot be removed is a warning, and the rest of the batch still runs', async () => {
  const dir = await fixture()
  const stuck = '4b1f28a6-4444-4c4c-9999-abcdefabcdef'
  await shard(dir, `${stuck}.json`)
  await shard(dir, 'session-ok.json')
  // The `fs/promises` exports object is what the retry calls through, so this
  // substitution is the only lock in the process.
  const surface = createRequire(import.meta.url)('node:fs/promises') as Record<string, unknown>
  const original = surface.rm
  surface.rm = async (path: string) => {
    if (path === join(dir, `${stuck}.json`)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rm '${path}'`), { code: 'EPERM' })
    }
    // The captured original, not `fsp.rm`: the export it reads is this substitute.
    return (original as (p: string) => Promise<void>)(path)
  }
  try {
    const warnings = await purgeSessionShards({ dir, ids: [stuck, 'session-ok'] })

    assert.deepEqual(warnings.map((warning) => [warning.code, warning.id]), [
      ['projcache-cleanup-failed', stuck],
    ], 'one warning, naming the session whose shard stayed')
    assert.equal(warnings[0].detail.includes(stuck), true, 'the diagnostic names the shard')
    assert.equal(existsSync(join(dir, `${stuck}.json`)), true, 'the locked shard is still there')
    assert.equal(existsSync(join(dir, 'session-ok.json')), false, 'and the other id was still cleaned')
  } finally {
    surface.rm = original
  }
})
