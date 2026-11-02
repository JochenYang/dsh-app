/**
 * The audit log, and the archive record's fate (the broadcast).
 *
 * Two things here are load-bearing, and neither is visible from a type check:
 *
 *   - **one JSON line per action, and a rolling scheme Windows can perform.** The
 *     log rolls to `.1` at a size bound; on Windows a `rename` onto an existing file
 *     fails, so the old `.1` must be removed FIRST or the log stops rolling after the
 *     first roll — silently, on the platform this app ships to first. The rolling
 *     test therefore starts with a `.1` already on disk.
 *   - **an audit failure is a warning, never a failed action.** The bytes are
 *     already moved by the time the line is written; reporting the deletion as
 *     failed would invite a retry that finds nothing left to delete.
 *
 * ## The record's fate, and the announcement
 *
 * `/delete` KEEPS the session's archive record. The record is the client's
 * visibility fence over the list snapshot the browser already holds: dropping it
 * un-hides a session whose log is in the trash, so the row pops back until the next
 * reload. With the log gone the kept record is stale — `/list` counts it and
 * `/prune` reclaims it — and `/restore-deleted` re-creates it (idempotently) after
 * putting the directory back.
 *
 * The removal IS announced (`api-session/removed`), and that announcement is
 * informational only: no package installed on this kernel line subscribes to it, so
 * it is never a reason to drop a record, and a listener that throws costs a warning
 * on a delete that already moved the bytes.
 *
 * @module @dsh-app/plugin-archives/tests/audit-and-records
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendAudit, AUDIT_MAX_BYTES } from '../src/audit.ts'
import { ROUTE_PREFIX } from '../src/routes.ts'
import type { ArchiveDeleteResult, ArchiveList, ArchiveTrashList } from '../src/types.ts'
import { call, cleanup, fixture, harness, request } from './harness.ts'

after(cleanup)

/** One appended line, parsed. */
async function lines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

// --- the log itself -------------------------------------------------------

test('one action is one parseable JSON line, with the fields a reader needs', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const at = Date.parse('2026-11-02T10:00:00.000Z')

  const outcome = await appendAudit({
    logPath: f.auditLog,
    record: { operation: 'delete', result: 'ok', sessionId: 'session-a', entryId: '1700000000000-abcdef01', bytes: 512 },
    now: () => at,
  })

  assert.deepEqual(outcome, { written: true, rolled: false })
  const [line] = await lines(f.auditLog)
  assert.deepEqual(line, {
    at: new Date(at).toISOString(),
    operation: 'delete',
    result: 'ok',
    sessionId: 'session-a',
    entryId: '1700000000000-abcdef01',
    bytes: 512,
  })
})

test('the log rolls to .1 even when a previous .1 is already there', async () => {
  const f = await fixture({ ids: [], archived: [] })
  await mkdir(join(f.auditLog, '..'), { recursive: true })
  // The state after one earlier roll: a previous generation on disk. A scheme that
  // renames without removing it first fails here with EEXIST on Windows.
  await writeFile(`${f.auditLog}.1`, '{"at":"2020-01-01T00:00:00.000Z","operation":"delete"}\n')
  await writeFile(f.auditLog, `${'x'.repeat(64)}\n`)

  const outcome = await appendAudit({
    logPath: f.auditLog,
    record: { operation: 'purge', result: 'ok', sessionId: 'session-b' },
    maxBytes: 32,
  })

  assert.equal(outcome.written, true)
  assert.equal(outcome.rolled, true, 'the log rolled despite the existing .1')
  const rolled = await readFile(`${f.auditLog}.1`, 'utf8')
  assert.match(rolled, /^x{64}\n$/, 'the previous log became .1, replacing the older generation')
  const [line] = await lines(f.auditLog)
  assert.equal(line.operation, 'purge', 'and the new line is in the fresh log')
})

test('a log that cannot be appended to is reported, never thrown', async () => {
  const f = await fixture({ ids: [], archived: [] })
  // A DIRECTORY where the log should be: every append fails, and nothing the caller
  // already did may be undone by that.
  await mkdir(f.auditLog, { recursive: true })

  const outcome = await appendAudit({ logPath: f.auditLog, record: { operation: 'delete', result: 'ok' } })

  assert.equal(outcome.written, false)
  assert.equal(typeof outcome.detail, 'string')
})

test('the default bound is the one the module documents', () => {
  assert.equal(AUDIT_MAX_BYTES, 1_048_576)
})

// --- a real action is recorded -------------------------------------------

test('a delete appends a line naming the operation, session, entry and bytes', async () => {
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const value = reply.body.value as ArchiveDeleteResult

  const log = await lines(f.auditLog)
  assert.equal(log.length, 1)
  assert.equal(log[0].operation, 'delete')
  assert.equal(log[0].result, 'ok')
  assert.equal(log[0].sessionId, 'session-a')
  assert.equal(log[0].entryId, value.trashId)
  assert.ok((log[0].bytes as number) > 0)
  assert.match(String(log[0].at), /^\d{4}-\d{2}-\d{2}T/)
})

test('an audit that cannot be written does not fail the delete it records', async () => {
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  // Make the audit path unwritable by putting a directory in its place.
  await mkdir(f.auditLog, { recursive: true })

  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const value = reply.body.value as ArchiveDeleteResult

  assert.equal(reply.status, 200, 'the move happened; a log line is not the move')
  assert.deepEqual(value.deleted, ['session-a'])
  assert.equal(existsSync(join(f.trashRoot, value.trashId as string, 'payload', '0', 'session.jsonl')), true)
  assert.ok(f.warnings.some((message) => message.includes('could not append')), 'and the host log says why')
})

test('a skipped id is recorded as skipped, with its stable reason', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-nope'] }))
  assert.equal(reply.status, 200)

  const log = await lines(f.auditLog)
  assert.deepEqual(log.map((line) => [line.operation, line.result, line.sessionId, line.reason]), [
    ['delete', 'skipped', 'session-nope', 'not-archived'],
  ])
})

// --- the record's fate, and the announcement ------------------------------

test('delete announces the removal and KEEPS the archive record', async () => {
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })

  await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))

  assert.deepEqual(f.emitted, ['session-a'], 'one announcement for one session')
  // The record is the client's visibility fence over a list snapshot it already
  // holds: dropping it would un-hide a session whose log is in the trash. The
  // announcement is informational (no installed client subscribes to it), so it is
  // never a licence to drop anything.
  assert.equal(f.made.calls.unarchiveSession, 0, 'no registry write: the record is kept')
  assert.deepEqual([...f.made.registry.archivedSessionIds], ['session-a'])
})

test('a tree is announced by its root, and a child writes nothing', async () => {
  // A subagent child was never in the archive set: announcing it would tell the
  // client about a session it never listed, and there is no record to keep for it.
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  assert.deepEqual(f.emitted, ['session-a'])
  assert.equal(f.made.calls.unarchiveSession, 0)
})

test('a listener that throws costs a warning, never a failed delete', async () => {
  // The move already happened when the announcement is dispatched. Reporting the
  // delete as failed over a throwing listener would blank `deleted` on a payload
  // that is sitting in the trash, and the retry it invites finds the id gone.
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  const routes = harness({
    ...f.options,
    emitRemoved: () => { throw new Error('listener exploded') },
  })

  const reply = await call(routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const value = reply.body.value as ArchiveDeleteResult

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-a'], 'the move is what the answer reports')
  assert.deepEqual(value.skipped, [])
  assert.ok(value.trashId !== undefined)
  assert.equal(existsSync(join(f.trashRoot, value.trashId as string, 'payload', '0', 'session.jsonl')), true)
  assert.ok(f.warnings.some((message) => message.includes('listener exploded')), 'and the host log says why')
})

test('the record turns into a stale row, and a restore brings it back', async () => {
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const trashId = (deleted.body.value as ArchiveDeleteResult).trashId as string

  const afterDelete = (await call(f.routes.get(`${ROUTE_PREFIX}/list`), request('GET'))).body.value as ArchiveList
  assert.deepEqual(
    { archived: afterDelete.archivedCount, stale: afterDelete.staleCount },
    { archived: 0, stale: 1 },
    'the kept record is now a stale record: /list counts it and /prune reclaims it',
  )

  // The entry is the handle a restore takes. It re-creates the record — an
  // idempotent `archiveSession` for an id that is still in the set — after the
  // directory is back.
  const restored = await call(f.routes.get(`${ROUTE_PREFIX}/restore-deleted`), request('POST', { ids: [trashId] }))
  assert.equal(restored.status, 200)
  const afterRestore = (await call(f.routes.get(`${ROUTE_PREFIX}/list`), request('GET'))).body.value as ArchiveList
  assert.equal(afterRestore.archivedCount, 1, 'the restored session is back in the archive listing')
  assert.equal(afterRestore.staleCount, 0, 'and it is no longer stale')
  assert.deepEqual([...f.made.registry.archivedSessionIds], ['session-a'])
})

test('a refusal writes no record at all', async () => {
  // A busy session is never touched — including its archive record.
  const f = await fixture({
    ids: ['session-a'],
    archived: ['session-a'],
    activity: async () => [{ kind: 'turn' }],
  })

  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const value = reply.body.value as ArchiveDeleteResult

  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'live' }])
  assert.equal(f.made.calls.unarchiveSession, 0)
  assert.deepEqual(f.emitted, [], 'nothing moved, so nothing is announced')
  assert.deepEqual([...f.made.registry.archivedSessionIds], ['session-a'])
})

test('a host with no broadcast still deletes, and keeps the record', async () => {
  // `emitRemoved` is a capability, not a requirement: a host that cannot dispatch
  // the event loses nothing but the announcement.
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  const routes = harness({ ...f.options, emitRemoved: undefined })

  const reply = await call(routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const value = reply.body.value as ArchiveDeleteResult

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-a'], 'the bytes still move: that is what the trash is for')
  assert.ok(value.trashId !== undefined)
  assert.equal(f.made.calls.unarchiveSession, 0, 'and the record is kept either way')
  assert.deepEqual([...f.made.registry.archivedSessionIds], ['session-a'])
})

test('prune reclaims a stale record: archived, not listed, and gone from disk', async () => {
  const f = await fixture({ ids: ['session-a', 'session-b'], archived: ['session-a', 'session-b'] })
  // The shape a rollback leaves, and the shape /delete leaves by design: the record
  // is here, the log is not.
  await rm(join(f.root, 'session-a'), { recursive: true, force: true })

  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/prune`), request('POST', {}))
  const value = reply.body.value as { pruned: number; remaining: number }

  assert.equal(reply.status, 200)
  assert.deepEqual(value, { pruned: 1, remaining: 1 })
  assert.deepEqual([...f.made.registry.archivedSessionIds], ['session-b'])
  assert.deepEqual(await readdir(f.root), ['session-b'], 'the live session is untouched')
})

test('a purge records one line per session it buries', async () => {
  const f = await fixture({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = await call(f.routes.get(`${ROUTE_PREFIX}/delete`), request('POST', { ids: ['session-a'] }))
  const trashId = (deleted.body.value as ArchiveDeleteResult).trashId as string
  // The trash listing carries the row the panel would show.
  const listed = (await call(f.routes.get(`${ROUTE_PREFIX}/trash`), request('GET'))).body.value as ArchiveTrashList
  assert.equal(listed.entries[0].trashId, trashId)

  await call(f.routes.get(`${ROUTE_PREFIX}/purge`), request('POST', { ids: [trashId] }))

  const log = await lines(f.auditLog)
  const purges = log.filter((line) => line.operation === 'purge')
  assert.deepEqual(purges.map((line) => [line.result, line.sessionId, line.entryId]), [['ok', 'session-a', trashId]])
})
