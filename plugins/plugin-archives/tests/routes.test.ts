/**
 * Behavioral tests for the archive manager's /delete contract.
 *
 * The load-bearing invariant under test: /delete removes log artifacts and
 * NEVER touches the archive set. The set is the client's visibility fence
 * over the session-list snapshot the browser already holds, so dropping a
 * record publishes an immediate "unarchived" frame and the deleted session
 * pops back into the sidebar until the next reload. The record instead stays
 * behind as a stale record that /list reports and /prune reclaims.
 *
 * @module @dsh-app/plugin-archives/tests/routes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerArchiveRoutes,
  ROUTE_PREFIX,
  type ArchiveRoutesOptions,
  type WebServerLike,
} from '../src/routes.ts'
import type { ArchiveDeleteResult, ArchiveList } from '../src/types.ts'

// --- harness -----------------------------------------------------------------

type Handler = (req: IncomingMessage, res: unknown) => void

/** Capture the registered handlers keyed by path (no HTTP server involved). */
function harness(options: ArchiveRoutesOptions) {
  const handlers = new Map<string, Handler>()
  const webServer: WebServerLike = {
    register(route) {
      handlers.set(route.path, route.handler as unknown as Handler)
      return () => { handlers.delete(route.path) }
    },
  }
  registerArchiveRoutes(webServer, options)
  return handlers
}

/** Minimal IncomingMessage stand-in: only the fields the routes read. */
function request(method: string, body?: unknown, url = '/'): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  Object.assign(req, {
    method,
    url,
    headers: { host: '127.0.0.1:1' },
    destroy: () => { /* the size cap is not exercised here */ },
  })
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

/** Minimal ServerResponse stand-in; resolves with the serialized reply.
 * A fenced request is answered with nothing at all, so the wait is bounded
 * and reports `status: 0` instead of hanging the suite. */
function call(handler: Handler, req: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0
    const timer = setTimeout(() => { resolve({ status: 0, body: {} }) }, 150)
    const res = {
      setHeader: () => { /* headers are not asserted */ },
      writeHead: (code: number) => { status = code },
      end: (bytes?: Buffer) => {
        clearTimeout(timer)
        resolve({ status, body: JSON.parse(bytes === undefined ? '{}' : bytes.toString('utf8')) as Record<string, unknown> })
      },
    }
    handler(req, res)
  })
}

/** Registry stub that counts every write-side call. */
function registry(archivedSessionIds: readonly string[]) {
  const calls = { enqueueOperation: 0, requireState: 0, setState: 0 }
  const state = { workspaceIds: [], archivedSessionIds }
  return {
    calls,
    registry: {
      get archivedSessionIds(): readonly string[] { return state.archivedSessionIds },
      requireState: () => { calls.requireState++; return state },
      enqueueOperation: <T>(operation: () => Promise<T>): Promise<T> => { calls.enqueueOperation++; return operation() },
      setState: (next: unknown) => { calls.setState++; Object.assign(state, next); return next },
    },
  }
}

/** Create one on-disk session directory and return its log path. */
async function sessionDir(root: string, id: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  await writeFile(log, '{"type":"session/header"}\n')
  return log
}

/** Route options over one temp root; `resolvable: false` drops the resolver. */
async function scenario(options: {
  ids: readonly string[]
  archived: readonly string[]
  resolvable?: boolean
  sessions?: ArchiveRoutesOptions['sessions']
}) {
  const root = await mkdtemp(join(tmpdir(), 'dshar-test-'))
  const logs = new Map<string, string>()
  for (const id of options.ids) logs.set(id, await sessionDir(root, id))
  const listed: unknown[] = Object.keys(Object.fromEntries(logs)).map((id) => ({
    id, createdAt: 1, cwd: 'C:/project',
  }))
  const persistence: Record<string, unknown> = {
    // A deleted session stops being listed — exactly what the backend does
    // once its directory is gone.
    list: async () => listed.filter((entry) => existsSync(join(root, String((entry as { id: string }).id)))),
  }
  if (options.resolvable !== false) {
    persistence.resolveCurrentLog = async (id: string) => logs.get(id)
  }
  const made = registry(options.archived)
  const routes = harness({
    persistence: persistence as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: options.sessions,
    projectionCache: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })
  return { root, logs, made, routes }
}

// --- /delete: locating a log the resolver refuses to name --------------------

/** A sessions root laid out the way the backend stores it
 * (`<root>/<project>/<id>/session…jsonl[.zstd]`) behind a resolver that
 * refuses to name the log — the pre-current-format shape that made /delete
 * report `missing` while the session kept listing forever. */
async function legacyScenario(
  stored: ReadonlyArray<{ project: string; id: string; file?: string }>,
  exposure: 'root' | 'config' | 'none' = 'root',
) {
  const root = await mkdtemp(join(tmpdir(), 'dshar-legacy-'))
  for (const entry of stored) {
    const dir = join(root, entry.project, entry.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, entry.file ?? 'session.jsonl.zstd'), 'x')
  }
  const persistence: Record<string, unknown> = {
    list: async () => stored.map((entry) => ({ id: entry.id, createdAt: 1, cwd: 'C:/project' })),
    resolveCurrentLog: async () => undefined,
  }
  if (exposure === 'root') persistence.root = root
  if (exposure === 'config') persistence.config = { root }
  const made = registry(stored.map((entry) => entry.id))
  const routes = harness({
    persistence: persistence as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })
  return { root, made, routes }
}

// --- /delete: the archive set is never written ------------------------------

test('delete: removes the log directory and leaves the archive set untouched', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-a'])
  assert.equal(existsSync(s.logs.get('session-a')!), false, 'the log directory must be gone')
  assert.ok(value.freedBytes > 0, 'freedBytes must report the removed directory size')
  // The core invariant: no registry write, and the record still filters the id.
  assert.deepEqual(s.made.calls, { enqueueOperation: 0, requireState: 0, setState: 0 })
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-a'])
})

test('delete: the kept record turns into the stale record /list reports', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const listBefore = (await call(s.routes.get(`${ROUTE_PREFIX}/list`)!, request('GET')).then(r => (r.body as { value: ArchiveList }).value))
  assert.deepEqual(
    { archived: listBefore.archivedCount, stale: listBefore.staleCount },
    { archived: 1, stale: 0 },
    'a live archive lists as archived, not stale',
  )

  await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const listAfter = (await call(s.routes.get(`${ROUTE_PREFIX}/list`)!, request('GET')).then(r => (r.body as { value: ArchiveList }).value))
  assert.deepEqual(
    { archived: listAfter.archivedCount, stale: listAfter.staleCount },
    { archived: 0, stale: 1 },
    'the record survives deletion as a prunable stale record',
  )
})

test('delete: a backend without a log resolver skips instead of dropping records', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'], resolvable: false })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'unsupported' }])
  assert.equal(existsSync(s.logs.get('session-a')!), true)
  assert.equal(s.made.calls.setState, 0, 'degrading to a record drop is the pop-back bug')
})

test('delete: fences unarchived and mid-turn ids without touching either', async () => {
  const s = await scenario({
    ids: ['session-a', 'session-b'],
    archived: ['session-a'],
    // turn/start with no matching turn/end — the open-turn fence.
    sessions: { get: (id: string) => (id === 'session-a' ? { snapshotEvents: () => [{ type: 'turn/start' }] } : undefined) },
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a', 'session-b'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [
    { id: 'session-a', reason: 'live' },
    { id: 'session-b', reason: 'not-archived' },
  ])
  assert.equal(existsSync(s.logs.get('session-a')!), true)
  assert.equal(existsSync(s.logs.get('session-b')!), true)
  assert.equal(s.made.calls.setState, 0)
})

test('delete: rejects a malformed body before any filesystem work', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: [] }))

  assert.equal(reply.status, 400)
  assert.equal((reply.body as { ok: boolean }).ok, false)
  assert.equal(existsSync(s.logs.get('session-a')!), true)
})

test('delete: locates a session whose log the resolver refuses to name', async () => {
  const s = await legacyScenario([{ project: '--D-codes-app--', id: 'session-legacy-1' }])

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-legacy-1'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-legacy-1'])
  assert.equal(existsSync(join(s.root, '--D-codes-app--', 'session-legacy-1')), false, 'the directory must be gone')
  assert.ok(value.freedBytes > 0)
  assert.equal(s.made.calls.setState, 0)
})

test('delete: reads the sessions root from the public config copy too', async () => {
  const s = await legacyScenario([{ project: 'p', id: 'session-legacy-2' }], 'config')

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-legacy-2'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, ['session-legacy-2'])
  assert.equal(existsSync(join(s.root, 'p', 'session-legacy-2')), false)
})

test('delete: a session the fallback cannot locate is still reported missing', async () => {
  const s = await legacyScenario([{ project: 'p', id: 'session-legacy-3' }], 'none')

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-legacy-3'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-legacy-3', reason: 'missing' }])
  assert.equal(existsSync(join(s.root, 'p', 'session-legacy-3')), true, 'nothing may be removed without a known root')
})

test('delete: ignores a directory that is not a stored session', async () => {
  // The id names a directory that holds no session log at all: the fallback
  // must not aim a deletion at it just because the name matched.
  const s = await legacyScenario([{ project: 'p', id: 'session-legacy-4', file: 'notes.txt' }])

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-legacy-4'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.skipped, [{ id: 'session-legacy-4', reason: 'missing' }])
  assert.equal(existsSync(join(s.root, 'p', 'session-legacy-4')), true)
})

test('delete: refuses an id whose directory name would be escaped upstream', async () => {
  // A real backend stores this id `~`-escaped, so a literal name match could
  // only hit the wrong directory. The id stays missing instead of guessed at.
  const s = await legacyScenario([{ project: 'p', id: 'session~weird' }])

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session~weird'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.skipped, [{ id: 'session~weird', reason: 'missing' }])
  assert.equal(existsSync(join(s.root, 'p', 'session~weird')), true)
})

// --- /prune: the reclaim path for the records /delete keeps -----------------

test('prune: drops exactly the records whose logs are gone', async () => {
  const s = await scenario({ ids: ['session-a', 'session-b'], archived: ['session-a', 'session-b'] })

  await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/prune`)!, request('POST', {}))
  const value = (reply.body as { value: { pruned: number; remaining: number } }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value, { pruned: 1, remaining: 1 })
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-b'])
  // The surviving record is an untouched live archive, not collateral damage.
  assert.equal(existsSync(s.logs.get('session-b')!), true)
})

test('prune: a registry without the write chain answers 501', async () => {
  const handlers = harness({
    persistence: { list: async () => [] },
    registry: { archivedSessionIds: [] },
    sessions: undefined,
    projectionCache: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })

  const reply = await call(handlers.get(`${ROUTE_PREFIX}/prune`)!, request('POST', {}))
  assert.equal(reply.status, 501)
  assert.equal((reply.body as { error: { code: string } }).error.code, 'prune-unsupported')
})

// --- fences -----------------------------------------------------------------

test('routes: a non-loopback Host is refused with an answer, not a hang', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const req = request('POST', { ids: ['session-a'] })
  ;(req.headers as Record<string, string>).host = 'evil.example'

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, req)

  // Answered, never left hanging: a fenced caller used to hold the socket
  // until its own timeout, unlike every other plugin's route surface.
  assert.equal(reply.status, 403)
  assert.equal((reply.body as { error: { code: string } }).error.code, 'forbidden')
  assert.equal(existsSync(s.logs.get('session-a')!), true)
})

test('routes: probe-level sanity — the four paths are registered', async () => {
  const s = await scenario({ ids: [], archived: [] })
  assert.deepEqual(
    [...s.routes.keys()].sort(),
    [`${ROUTE_PREFIX}/delete`, `${ROUTE_PREFIX}/list`, `${ROUTE_PREFIX}/prune`, `${ROUTE_PREFIX}/search`].sort(),
  )
})
