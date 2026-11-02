/**
 * Behavioral tests for the archive manager's delete/restore/purge contract.
 *
 * The load-bearing invariants under test:
 *   - `/delete` MOVES a session's log directory into the session trash and
 *     never touches the archive set. The set is the client's visibility fence
 *     over the session-list snapshot the browser already holds, so dropping a
 *     record publishes an immediate "unarchived" frame and the moved session
 *     pops back into the sidebar until the next reload; the record instead
 *     stays behind as a stale record that `/list` reports and `/prune`
 *     reclaims — and that `/restore-deleted` needs in order to put the session
 *     back.
 *   - `/restore-deleted` returns the directory to its original path and
 *     re-creates the record through the registry's public `archiveSession`.
 *   - `/purge` is the only route that frees bytes.
 *
 * The routes are exercised through a captured Connection exact-Fetch registry
 * (no HTTP server and no carrier): trust and method dispatch belong to the
 * carrier, which runs before a handler, so these tests cover what this plugin
 * owns — path, methods, and the Fetch-shaped answer.
 *
 * @module @dsh-app/plugin-archives/tests/routes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after } from 'node:test'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  registerArchiveRoutes,
  ROUTE_PREFIX,
  type ArchiveRoutesOptions,
} from '../src/routes.ts'
import type {
  ArchiveDeleteResult,
  ArchiveList,
  ArchivePurgeResult,
  ArchiveRestoreDeletedResult,
  ArchiveTrashList,
} from '../src/types.ts'

/**
 * Scratch roots this run created, removed when it finishes.
 *
 * Why: the fixture roots below are built with `mkdtemp` and were never removed,
 * so repeated runs accumulated thousands of `dshar-*` directories in the system
 * temp (measured 2026-10-02 on this project's machine: 41,570 of our own
 * entries). Accumulating scratch is not a test failure, so nothing caught it.
 */
const created: string[] = []

after(async () => {
  const { rm } = await import('node:fs/promises')
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

// --- harness -----------------------------------------------------------------

type FetchHandler = (request: Request) => Promise<Response>

/** One captured exact-Fetch route: its declared methods and its handler. */
interface CapturedRoute {
  readonly methods: readonly string[]
  readonly fetch: FetchHandler
}

/** Capture the registered exact-Fetch routes keyed by path. */
function harness(options: ArchiveRoutesOptions) {
  const routes = new Map<string, CapturedRoute>()
  const connectionFetch = {
    register(route: ConnectionFetchRoute): () => Promise<void> {
      routes.set(route.path, { methods: route.methods, fetch: route.fetch })
      return async () => { routes.delete(route.path) }
    },
  }
  registerArchiveRoutes(connectionFetch, options)
  return routes
}

/** A Fetch request against the plugin's namespace, with an optional JSON body. */
function request(method: string, body?: unknown, url = '/'): Request {
  return new Request(`dsh-app://app${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

/** Dispatch one request through a captured route and decode the JSON envelope. */
async function call(
  route: CapturedRoute,
  req: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route.fetch(req)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** Registry stub that counts every write-side call. */
function registry(archivedSessionIds: readonly string[]) {
  const calls = { unarchiveSession: 0, archiveSession: 0 }
  const state = { workspaceIds: [] as string[], archivedSessionIds: [...archivedSessionIds] }
  return {
    calls,
    registry: {
      get archivedSessionIds(): readonly string[] { return state.archivedSessionIds },
      // The PUBLIC removal path this plugin uses (`WorkspaceRegistry.
      // unarchiveSession`). The double mutates its own state the way the kernel
      // mutates its domain state, and it does so one id at a time — which is what
      // makes "how many writes did this flow perform" observable here.
      unarchiveSession: (sessionId: string): Promise<void> => {
        calls.unarchiveSession += 1
        state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== sessionId)
        return Promise.resolve()
      },
      // The PUBLIC add path (`WorkspaceRegistry.archiveSession`), used by
      // /restore-deleted. The real one refuses an id neither live nor in
      // persistence; the double accepts anything so a test can isolate the
      // route's own bookkeeping, and one test below drops it entirely to prove
      // the route answers 501 instead of reaching for a private chain.
      archiveSession: (sessionId: string): Promise<void> => {
        calls.archiveSession += 1
        if (!state.archivedSessionIds.includes(sessionId)) state.archivedSessionIds = [...state.archivedSessionIds, sessionId]
        return Promise.resolve()
      },
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

/** Read one trash entry's metadata from the route-level fixture. */
async function trashMetadata(trashRoot: string, trashId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(trashRoot, trashId, 'metadata.json'), 'utf8')) as Record<string, unknown>
}

/** A trash root inside a fresh temporary directory, with nothing in it. */
async function emptyTrashRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'dshar-trash-'))
  created.push(base)
  return join(base, 'trash')
}

/** Create a directory link (`junction` on Windows, `dir` symlink elsewhere). */
async function linkDirectory(target: string, linkPath: string): Promise<string | undefined> {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return undefined
  } catch (error) {
    const code = (error as { code?: string }).code ?? String(error)
    return `directory links unavailable in this environment (${code})`
  }
}

/**
 * A backend with a working log resolver but NO sessions root on the instance —
 * neither `root` nor `config.root`. `/prune` and the trash's strict containment
 * fence both read that root, so this is the shape that has to keep working
 * without it.
 */
async function rootlessScenario(options: { ids: readonly string[]; archived: readonly string[] }) {
  const base = await mkdtemp(join(tmpdir(), 'dshar-rootless-'))
  created.push(base)
  const sessionsRoot = join(base, 'sessions')
  const trashRoot = join(base, 'trash')
  await mkdir(sessionsRoot, { recursive: true })
  const logs = new Map<string, string>()
  for (const id of options.ids) logs.set(id, await sessionDir(sessionsRoot, id))
  const persistence = {
    list: async () => options.ids.map((id) => ({ id, createdAt: 1, cwd: 'C:/project' })),
    resolveCurrentLog: async (id: string) => logs.get(id),
  }
  const made = registry(options.archived)
  const routes = harness({
    persistence: persistence as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot,
    // No root, and no projection cache either: this backend exposes the trash
    // store only, which is the minimum a delete needs.
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })
  return { trashRoot, routes, made, sessionsRootOf: (id: string) => join(sessionsRoot, id) }
}

/** Route options over one temp root; `resolvable: false` drops the resolver. */
async function scenario(options: {
  ids: readonly string[]
  archived: readonly string[]
  resolvable?: boolean
  sessions?: ArchiveRoutesOptions['sessions']
  /** The kernel's activity answer per id; absent means nothing is running. */
  activity?: ArchiveRoutesOptions['activity']
  /** Create a projection-cache shard directory beside the trash, and return it. */
  projectionCache?: boolean
  /** The kernel's stop seam (`workspace/session-stop`), for a `stopFirst` case. */
  stopSession?: ArchiveRoutesOptions['stopSession']
  /** The subagent catalog walk (`ctx.subagents.listDescendants`). */
  subagents?: ArchiveRoutesOptions['subagents']
  /** The bounded wait a `stopFirst` case uses (defaults would wait 5s). */
  stopWait?: ArchiveRoutesOptions['stopWait']
}) {
  const base = await mkdtemp(join(tmpdir(), 'dshar-test-'))
  created.push(base)
  // Sessions and trash are siblings: two roots under one base, which is also
  // the layout of `$DSH_HOME/sessions` beside `$DSH_HOME/storages/...`.
  const root = join(base, 'sessions')
  const trashRoot = join(base, 'trash')
  // The kernel's own cache table, laid out the way `/purge` finds it.
  const projCacheDir = options.projectionCache === true ? join(base, 'session_projcache', 'sessions') : undefined
  if (projCacheDir !== undefined) await mkdir(projCacheDir, { recursive: true })
  await mkdir(root, { recursive: true })
  const logs = new Map<string, string>()
  for (const id of options.ids) logs.set(id, await sessionDir(root, id))
  const listed: unknown[] = Object.keys(Object.fromEntries(logs)).map((id) => ({
    id, createdAt: 1, cwd: 'C:/project',
  }))
  const persistence: Record<string, unknown> = {
    // A moved session stops being listed — exactly what the backend does once
    // its directory is gone from the sessions root.
    list: async () => listed.filter((entry) => existsSync(join(root, String((entry as { id: string }).id)))),
    root,
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
    trashRoot,
    projCacheDir,
    // Nothing runs anywhere unless a test says so: the fence's own test is the
    // one that passes a busy id, and every other scenario means "idle".
    activity: options.activity ?? (async () => []),
    // Both seams are capabilities, not defaults: a scenario that does not name
    // them is a host that cannot stop a session and cannot walk a subagent tree.
    stopSession: options.stopSession,
    subagents: options.subagents,
    ...(options.stopWait === undefined ? {} : { stopWait: options.stopWait }),
    sessionQuery: undefined,
    tools: undefined,
  })
  return { base, root, trashRoot, projCacheDir, logs, made, routes }
}

// --- /delete: locating a log the resolver refuses to name --------------------

/** A sessions root laid out the way the backend stores it
 * (`<root>/<project>/<id>/session…jsonl[.zstd]`) behind a resolver that
 * refuses to name the log — the pre-current-format shape that made /delete
 * report `missing` while the session kept listing forever. */
async function legacyScenario(
  stored: ReadonlyArray<{ project: string; id: string; file?: string }>,
  exposure: 'root' | 'config' = 'root',
) {
  const base = await mkdtemp(join(tmpdir(), 'dshar-legacy-'))
  created.push(base)
  const root = join(base, 'sessions')
  const trashRoot = join(base, 'trash')
  await mkdir(root, { recursive: true })
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
    trashRoot,
    projCacheDir: undefined,
    // These scenarios are about LOCATING a log, not about liveness: nothing is
    // running, so the fence has nothing to refuse.
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })
  return { base, root, trashRoot, made, routes }
}

// --- /delete: a move into the trash, and the archive set is never written ----

test('delete: moves the log directory into the trash and leaves the archive set untouched', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-a'])
  // The directory is not gone: it moved, whole, into the entry's payload slot.
  assert.equal(existsSync(join(s.root, 'session-a')), false, 'the sessions root no longer holds the directory')
  assert.ok(value.trashId !== undefined, 'the response names the entry it created')
  const trashId = value.trashId!
  assert.equal(existsSync(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl')), true, 'the log travelled with it')
  const metadata = await trashMetadata(s.trashRoot, trashId)
  assert.equal(metadata.version, 1)
  assert.equal(metadata.state, 'ready')
  assert.equal(metadata.trashId, trashId)
  assert.match(String(metadata.deletedAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual((metadata.members as Array<Record<string, unknown>>).map((member) => ({
    sessionId: member.sessionId,
    payload: member.payload,
    originalPath: member.originalPath,
  })), [{ sessionId: 'session-a', payload: '0', originalPath: join(s.root, 'session-a') }])
  assert.ok(value.freedBytes > 0, 'freedBytes reports what the trash now holds after the move')
  // The core invariant: no registry write, and the record still filters the id.
  assert.deepEqual(s.made.calls, { unarchiveSession: 0, archiveSession: 0 })
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-a'], 'the record is kept')
  // Keeping the record is what holds the session hidden: the archive set filters the
  // list snapshot the browser already has, so dropping it would un-hide the row.
  // The record stays in the archive set either way; only /purge and the sweep free bytes.
})

test('delete: a second call for the same id is a no-op reported as already-in-trash', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })

  const first = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const second = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (second.body as { value: ArchiveDeleteResult }).value

  assert.equal(second.status, 200)
  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'already-in-trash' }])
  assert.equal(value.trashId, undefined, 'no second entry is created')
  const trashIds = await readdir(s.trashRoot)
  assert.equal(trashIds.length, 1, 'the first entry is the only one on disk')
  assert.equal((first.body as { value: ArchiveDeleteResult }).value.trashId, trashIds[0])
  assert.equal(s.made.calls.archiveSession, 0)
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
  assert.equal(s.made.calls.unarchiveSession, 0, 'degrading to a record drop is the pop-back bug')
})

test('delete: fences unarchived and BUSY ids without touching either', async () => {
  const s = await scenario({
    ids: ['session-a', 'session-b'],
    archived: ['session-a'],
    // The kernel's own answer for a running session: the waterfall reports what
    // it found, and the fence takes its word for it.
    activity: async (id: string) => (id === 'session-a' ? [{ kind: 'turn', label: 'a turn' }] : []),
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
  // W12 was reversed (src/routes.ts): a COMPLETED move keeps the archive record and
  // announces the removal; every refusal path above leaves the set exactly as it was.
})

test('delete: a fence that cannot answer keeps the session', async () => {
  // The waterfall throwing means "cannot tell whether work is running" — and the
  // only safe reading of that is that it might be. A delete path that treated an
  // error as "idle" would remove a live session's log, taking the turn, its
  // subagent transcripts and the record of what ran with it.
  const s = await scenario({
    ids: ['session-a'],
    archived: ['session-a'],
    activity: async () => { throw new Error('waterfall disposed') },
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'live' }])
  assert.equal(existsSync(s.logs.get('session-a')!), true)
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
  // W12: the move drops the record through the public removal, in the same request.
  assert.equal(s.made.calls.unarchiveSession, 0, 'a delete keeps the archive record')
  assert.equal(existsSync(join(s.root, '--D-codes-app--', 'session-legacy-1')), false, 'the directory moved into the trash')
  assert.equal(existsSync(join(s.trashRoot, value.trashId!, 'payload', '0', 'session.jsonl.zstd')), true)
  assert.ok(value.freedBytes > 0)
  // W12 was reversed (src/routes.ts): a COMPLETED move keeps the archive record and
  // announces the removal; every refusal path above leaves the set exactly as it was.
})

test('delete: reads the sessions root from the public config copy too', async () => {
  const s = await legacyScenario([{ project: 'p', id: 'session-legacy-2' }], 'config')

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-legacy-2'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, ['session-legacy-2'])
  assert.equal(existsSync(join(s.root, 'p', 'session-legacy-2')), false)
})

test('delete: a backend that exposes no sessions root still moves the session', async () => {
  // F5: a backend can expose `resolveCurrentLog` and neither `root` nor
  // `config.root`. The DELETE keeps working (it only moves the directory the
  // kernel named); the RESTORE does not, because a restore writes to a path that
  // came out of a file on disk and there is no root to fence it against.
  const s = await rootlessScenario({ ids: ['session-a'], archived: ['session-a'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-a'])
  assert.deepEqual(value.skipped, [])
  assert.equal(existsSync(s.sessionsRootOf('session-a')), false, 'the directory moved into the trash')
  const metadata = await trashMetadata(s.trashRoot, value.trashId!)
  assert.equal(metadata.rootUnknown, true, 'the entry records that no root was available')
  assert.equal(metadata.state, 'ready')

  // P1-4's other trigger: this backend wrote the entry, so it can never fence it.
  // The row says so instead of offering a restore that cannot run.
  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.equal(listed.value.entries[0].restorable, false, 'a backend with no root cannot offer a restore')
  assert.equal(listed.value.entries[0].restorableBlock, 'needs-root')

  const restored = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] }))
  const restoredValue = (restored.body as { value: ArchiveRestoreDeletedResult }).value
  assert.equal(restored.status, 200)
  assert.deepEqual(restoredValue.restored, [])
  assert.deepEqual(restoredValue.skipped, [{ id: 'session-a', reason: 'needs-root' }])
  assert.equal(existsSync(join(s.trashRoot, value.trashId!, 'payload', '0', 'session.jsonl')), true, 'and nothing moved')
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

// --- /trash, /restore-deleted, /purge: the way back --------------------------

test('trash: lists the entry a delete created, with its members', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = (await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveDeleteResult }

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))
  const value = (reply.body as { value: ArchiveTrashList }).value

  assert.equal(reply.status, 200)
  assert.equal(value.entries.length, 1)
  assert.equal(value.entries[0].trashId, deleted.value.trashId)
  assert.equal(value.entries[0].state, 'ready')
  assert.equal(value.entries[0].restorable, true, 'the payload is here and the root can fence it')
  assert.equal(value.entries[0].restorableBlock, undefined)
  assert.deepEqual(value.entries[0].members.map((member) => member.sessionId), ['session-a'])
  assert.deepEqual(value.entries[0].members.map((member) => member.present), [true])
  assert.equal(value.sessionCount, 1)
  assert.equal(value.totalBytes, value.entries[0].totalBytes)
  assert.ok(value.totalBytes > 0)
})

test('trash: an absent trash root is an empty listing, not a failure', async () => {
  const s = await scenario({ ids: [], archived: [] })
  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))
  assert.equal(reply.status, 200)
  assert.deepEqual((reply.body as { value: ArchiveTrashList }).value, { entries: [], sessionCount: 0, totalBytes: 0 })
})

test('trash: a ghost entry with an empty payload never shadows the real one', async () => {
  // F2: two overlapping deletes used to leave a "ready" entry whose payload was
  // empty but which claimed the session. It sorted first, so every restore
  // picked it and failed forever.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = (await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveDeleteResult }
  const ghostId = '2999999999999-abcdef01'
  await mkdir(join(s.trashRoot, ghostId, 'payload'), { recursive: true })
  await writeFile(join(s.trashRoot, ghostId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId: ghostId,
    deletedAt: new Date(2999999999999).toISOString(),
    members: [{ sessionId: 'session-a', title: '', originalPath: join(s.root, 'session-a'), payload: '0', sizeBytes: 24 }],
  }))

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.deepEqual(listed.value.entries.map((entry) => [entry.trashId, entry.state]), [
    [ghostId, 'interrupted'],
    [deleted.value.trashId, 'ready'],
  ], 'the ghost is listed as interrupted and sorts first')

  const restored = (await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveRestoreDeletedResult }
  assert.deepEqual(restored.value.restored, ['session-a'], 'and the real entry is the one that answers')
  assert.deepEqual(restored.value.skipped, [])
  assert.equal(existsSync(join(s.root, 'session-a', 'session.jsonl')), true)
})

test('trash: a complete payload is restorable even if the entry never committed', async () => {
  // F2: the state flag is diagnostic. A crash between the last rename and the
  // commit used to leave a session sitting in the trash with no way back in the
  // product — the payload was right there.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = (await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveDeleteResult }
  const metadata = await trashMetadata(s.trashRoot, deleted.value.trashId!)
  await writeFile(join(s.trashRoot, deleted.value.trashId!, 'metadata.json'), JSON.stringify({ ...metadata, state: 'moving' }))

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.equal(listed.value.entries.length, 1)
  assert.equal(listed.value.entries[0].state, 'ready', 'the payload is what decides')

  const restored = (await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveRestoreDeletedResult }
  assert.deepEqual(restored.value.restored, ['session-a'])
  assert.deepEqual(restored.value.skipped, [])
  assert.equal(existsSync(join(s.root, 'session-a', 'session.jsonl')), true)
})

test('trash: an incomplete payload is listed but never restored', async () => {
  // The other half of F2: when a member's slot is really gone, the entry cannot be
  // restored as a whole — and it must not be offered as if it could.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = (await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveDeleteResult }
  await rm(join(s.trashRoot, deleted.value.trashId!, 'payload', '0'), { recursive: true, force: true })

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.equal(listed.value.entries.length, 1, 'it is not lost')
  assert.equal(listed.value.entries[0].state, 'interrupted')
  assert.equal(listed.value.entries[0].restorable, false, 'there is nothing to put back')
  assert.equal(listed.value.entries[0].restorableBlock, 'no-payload', 'and the row says so')
  assert.deepEqual(listed.value.entries[0].members, [], 'and it does not claim a session it cannot hold')

  const restored = (await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveRestoreDeletedResult }
  assert.deepEqual(restored.value.restored, [])
  assert.deepEqual(restored.value.skipped, [{ id: 'session-a', reason: 'not-in-trash' }])
})

test('trash: a row the current root cannot fence reports why it offers no restore', async () => {
  // P1-4: this row reported `state: 'ready'` and the page drew a Restore button
  // that failed every single time (`path-outside-root`). Whether a row may offer a
  // restore is answered per request, from the root this backend can see.
  const s = await scenario({ ids: [], archived: [] })
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const trashId = '1700000000000-abcdef01'
  await mkdir(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'x')
  await writeFile(join(s.trashRoot, trashId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: [{ sessionId: 'session-a', title: '', originalPath: join(outside, 'session-a'), payload: '0', sizeBytes: 1 }],
  }))

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.equal(listed.value.entries[0].state, 'ready', 'the payload IS here')
  assert.deepEqual(listed.value.entries[0].members.map((member) => member.present), [true], 'and it is shown')
  assert.equal(listed.value.entries[0].restorable, false, 'but no request from here could restore it')
  assert.equal(listed.value.entries[0].restorableBlock, 'outside-root')

  // The request says the same thing the row did, and the row stays clearable.
  const refused = (await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: [trashId] })))
    .body as { value: ArchiveRestoreDeletedResult }
  assert.deepEqual(refused.value.skipped, [{ id: trashId, reason: 'path-outside-root' }])
  const purged = (await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: [trashId] })))
    .body as { value: ArchivePurgeResult }
  assert.deepEqual(purged.value.purged.map((entry) => entry.trashId), [trashId])
  assert.deepEqual(await readdir(s.trashRoot), [])
})

test('purge: the trash id clears a row whose payload is entirely gone', async () => {
  // P1-3: this row was listed, the client sent `[trashId]` (the only id it had),
  // and `/purge` answered `not-in-trash` — so a row with bytes on disk had no
  // request that could clear it. The row's own identity is a handle now.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = (await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveDeleteResult }
  const trashId = deleted.value.trashId!
  await rm(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true, force: true })

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.deepEqual(listed.value.entries.map((entry) => [entry.trashId, entry.state]), [[trashId, 'interrupted']])

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: [trashId] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value
  assert.equal(reply.status, 200)
  assert.deepEqual(value.purged.map((entry) => entry.trashId), [trashId])
  assert.deepEqual(value.skipped, [])
  assert.equal(existsSync(join(s.trashRoot, trashId)), false, 'and the row is gone for good')
})

test('purge: a member that went home is not a handle for the payload that stayed', async () => {
  // B2 at the route level: naming the member that is BACK must not free the entry
  // that still holds the other one.
  const s = await scenario({ ids: [], archived: [] })
  const trashId = '1700000000000-abcdef01'
  const homeAgain = join(s.root, 'session-b')
  await mkdir(homeAgain, { recursive: true })
  await writeFile(join(homeAgain, 'session.jsonl'), 'x')
  await mkdir(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'x')
  await writeFile(join(s.trashRoot, trashId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: [
      { sessionId: 'session-a', title: '', originalPath: join(s.root, 'session-a'), payload: '0', sizeBytes: 1 },
      { sessionId: 'session-b', title: '', originalPath: homeAgain, payload: '1', sizeBytes: 1 },
    ],
  }))

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: ['session-b', 'session-a'] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value
  assert.deepEqual(value.skipped[0], { id: 'session-b', reason: 'not-in-trash' }, 'the member that went home names nothing')
  // …while the member that IS here still authorizes the entry.
  assert.deepEqual(value.purged.map((entry) => entry.trashId), [trashId])
  assert.equal(existsSync(join(s.trashRoot, trashId)), false)
})

test('trash: an entry whose metadata cannot be read is a row, and its trash id clears it', async () => {
  // B3's last case. The review put it as "「此形态连行都没有」" — no row, so no
  // request could name it and its bytes were unreachable. The directory name is a
  // minted trash id, which is the identity every request accepts.
  const s = await scenario({ ids: [], archived: [] })
  const trashId = '1700000000000-abcdef01'
  await mkdir(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'x')

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.deepEqual(
    listed.value.entries.map((entry) => [entry.trashId, entry.state, entry.restorable]),
    [[trashId, 'unverified', false]],
    'a row that says what it is and offers no restore',
  )
  assert.deepEqual(listed.value.entries[0].members, [], 'it names no session — nothing in it does')
  assert.ok(listed.value.entries[0].totalBytes > 0, 'but its bytes are on the books')

  // Nothing can restore it (the metadata held the original paths), and its name
  // frees it.
  const refused = (await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: [trashId] })))
    .body as { value: ArchiveRestoreDeletedResult }
  assert.deepEqual(refused.value.restored, [])
  assert.deepEqual(refused.value.skipped, [{ id: trashId, reason: 'missing' }],
    'nothing in it can be located — and that is not "no such session in the trash"')

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: [trashId] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value
  assert.deepEqual(value.purged.map((entry) => entry.trashId), [trashId])
  assert.deepEqual(await readdir(s.trashRoot), [], 'and the bytes are gone')
})

test('purge: removes the projection-cache shard, and the delete before it keeps it', async () => {
  // W4: the kernel's cache has no eviction surface, so a deleted session's
  // document would outlive every listing that could name it. Moving INTO the trash
  // keeps it on purpose — a restored session must come back with its title — and
  // only the purge takes it away, under either id spelling.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'], projectionCache: true })
  const cacheDir = s.projCacheDir!
  await writeFile(join(cacheDir, 'session-a.json'), '{"ver":7}')
  await writeFile(join(cacheDir, 'a.json'), '{"ver":7}')
  await writeFile(join(cacheDir, 'someone-else.json'), '{"ver":7}')

  await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  assert.equal(existsSync(join(cacheDir, 'session-a.json')), true, 'a delete keeps the shard: a restore needs its title')
  assert.equal(existsSync(join(cacheDir, 'a.json')), true)

  const [trashId] = await readdir(s.trashRoot)
  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: [trashId] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value
  assert.deepEqual(value.warnings, [], 'nothing to warn about')
  assert.equal(existsSync(join(cacheDir, 'session-a.json')), false, 'both spellings go with the session')
  assert.equal(existsSync(join(cacheDir, 'a.json')), false)
  assert.deepEqual(await readdir(cacheDir), ['someone-else.json'], 'and no other session is touched')
})

test('delete: a junction under the sessions root is refused, not followed', async (t) => {
  // F6: the string fence says "inside" for anything below a junction, so this is
  // the case only `realpath` catches.
  const base = await mkdtemp(join(tmpdir(), 'dshar-link-'))
  created.push(base)
  const root = join(base, 'sessions')
  const trashRoot = join(base, 'trash')
  await mkdir(root, { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const reason = await linkDirectory(outside, join(root, 'link'))
  if (reason !== undefined) {
    t.diagnostic(reason)
    t.skip(reason)
    return
  }
  await mkdir(join(outside, 'session-a'), { recursive: true })
  await writeFile(join(outside, 'session-a', 'session.jsonl'), 'x')
  const made = registry(['session-a'])
  const routes = harness({
    persistence: {
      list: async () => [{ id: 'session-a', createdAt: 1, cwd: 'C:/project' }],
      // The backend names a log reached through the junction: every string
      // comparison still calls it "inside the sessions root".
      resolveCurrentLog: async () => join(root, 'link', 'session-a', 'session.jsonl'),
      root,
    } as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot,
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })

  const reply = await call(routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'path-outside-root' }])
  assert.equal(existsSync(join(outside, 'session-a', 'session.jsonl')), true, 'the directory outside is untouched')
})

test('restore-deleted: puts the directory back and re-creates the archive record', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  // Deleting kept the record; the point of the restore is that the directory and
  // the record agree again.
  assert.equal(existsSync(join(s.root, 'session-a')), false)

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveRestoreDeletedResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.restored, ['session-a'])
  assert.deepEqual(value.skipped, [])
  assert.deepEqual(value.warnings, [])
  assert.equal(existsSync(join(s.root, 'session-a', 'session.jsonl')), true, 'the log is back at its original path')
  assert.deepEqual(await readdir(s.trashRoot), [], 'the emptied entry is removed')
  assert.equal(s.made.calls.archiveSession, 1, 'the record is re-created through the public archive path')
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-a'], 'restored: the record is back in the archive set')
  // The record stays in the archive set either way; only /purge and the sweep free bytes.
})

test('restore-deleted: refuses an original path that is occupied again', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  // A new session took the slot back while the entry was parked.
  await sessionDir(s.root, 'session-a')

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveRestoreDeletedResult }).value

  assert.deepEqual(value.restored, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'target-exists' }])
  assert.equal(s.made.calls.archiveSession, 0, 'a refused restore writes no record')
  assert.equal((await readdir(s.trashRoot)).length, 1, 'the entry is still there to restore later')
})

test('restore-deleted: a batch with one member already home restores the rest', async () => {
  // B1 at the route level: one member that had already gone home used to make the
  // whole entry unrestorable, so the only action left on a payload that was still
  // intact was the irreversible one. The member that is here comes back; the one
  // that is already home is reported instead of failing the batch.
  const s = await scenario({ ids: [], archived: [] })
  const trashId = '1700000000000-abcdef01'
  const parked = join(s.root, 'session-a')
  const home = join(s.root, 'session-b')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'session.jsonl'), 'b')
  await mkdir(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'a')
  await writeFile(join(s.trashRoot, trashId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: [
      { sessionId: 'session-a', title: '', originalPath: parked, payload: '0', sizeBytes: 1 },
      { sessionId: 'session-b', title: '', originalPath: home, payload: '1', sizeBytes: 1 },
    ],
  }))

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: [trashId] }))
  const value = (reply.body as { value: ArchiveRestoreDeletedResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.restored, ['session-a'], 'what was here is back')
  assert.deepEqual(value.skipped, [], 'and nothing was refused')
  assert.deepEqual(value.warnings, [{ id: 'session-b', code: 'trash-member-already-home' }],
    'the member that was already home is reported as such')
  assert.equal(existsSync(join(parked, 'session.jsonl')), true)
  assert.equal(existsSync(join(home, 'session.jsonl')), true, 'and it is still where it was')
  assert.deepEqual(await readdir(s.trashRoot), [], 'the emptied entry is gone')
})

test('restore-deleted: refuses an entry whose recorded path is outside the sessions root', async () => {
  // The entry's metadata is a file on disk, so the path in it is re-validated
  // rather than trusted: a copied or edited entry must not write outside the
  // sessions root.
  const s = await scenario({ ids: [], archived: [] })
  const outside = await mkdtemp(join(tmpdir(), 'dshar-outside-'))
  created.push(outside)
  const trashId = '1700000000000-abcdef01'
  await mkdir(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'x')
  await writeFile(join(s.trashRoot, trashId, 'metadata.json'), JSON.stringify({
    version: 1,
    trashId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: [{ sessionId: 'session-a', title: '', originalPath: join(outside, 'session-a'), payload: '0', sizeBytes: 1 }],
  }))

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveRestoreDeletedResult }).value

  assert.deepEqual(value.restored, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'path-outside-root' }])
  assert.equal(existsSync(join(outside, 'session-a')), false, 'nothing is written outside the sessions root')
})

test('restore-deleted: an id that is not in the trash is skipped, not failed', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchiveRestoreDeletedResult }).value
  assert.equal(reply.status, 200)
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'not-in-trash' }])
})

test('restore-deleted: answers 501 when the kernel publishes no archive path', async () => {
  const routes = harness({
    persistence: { list: async () => [] } as unknown as ArchiveRoutesOptions['persistence'],
    // No `archiveSession`: the shape of a kernel that cannot put an id back.
    registry: { archivedSessionIds: [] } as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot: await emptyTrashRoot(),
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
    // These two cases assert a capability refusal, which happens before anything
    // reads the settings file or appends an audit line: the paths are placeholders
    // that nothing here opens.
    auditLog: undefined,
    settingsPath: join(tmpdir(), 'dshar-unused-settings.json'),
    emitRemoved: undefined,
    warn: () => {},
  } as ArchiveRoutesOptions)
  const reply = await call(routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: ['session-a'] }))
  assert.equal(reply.status, 501)
  assert.equal((reply.body as { error: { host: { code: string } } }).error.host.code, 'route.restoreDeletedUnsupported')
})

test('purge: removes the entry for good and reports the bytes it held', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] }))
  const [trashId] = await readdir(s.trashRoot)

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.purged.map((entry) => entry.trashId), [trashId])
  assert.deepEqual(value.purged[0].ids, ['session-a'])
  assert.ok(value.freedBytes > 0, 'the recursive payload size is reported as freed')
  assert.deepEqual(await readdir(s.trashRoot), [], 'the entry directory is gone')
  // A purge does not bring anything back: the sessions root stays empty too.
  assert.equal(existsSync(join(s.root, 'session-a')), false)
  assert.equal(s.made.calls.archiveSession, 0)
})

test('purge: an id that is not in the trash is skipped', async () => {
  const s = await scenario({ ids: [], archived: [] })
  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value
  assert.equal(reply.status, 200)
  assert.deepEqual(value.purged, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'not-in-trash' }])
})

test('purge: a member that is back home does not make the entry reachable', async () => {
  // F3: the entry still lists session-b in its metadata, but session-b is back at
  // its original path. Acting on that id must not delete the entry — which still
  // holds session-a, the only copy of it.
  const s = await scenario({ ids: [], archived: [] })
  const trashId = '1700000000000-abcdef01'
  const homeAgain = join(s.root, 'session-b')
  await mkdir(homeAgain, { recursive: true })
  await writeFile(join(homeAgain, 'session.jsonl'), 'x')
  await mkdir(join(s.trashRoot, trashId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl'), 'x')
  await writeFile(join(s.trashRoot, trashId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: [
      { sessionId: 'session-a', title: '', originalPath: join(s.root, 'session-a'), payload: '0', sizeBytes: 1 },
      { sessionId: 'session-b', title: '', originalPath: homeAgain, payload: '1', sizeBytes: 1 },
    ],
  }))

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.deepEqual(listed.value.entries[0].members.map((member) => member.sessionId), ['session-a'], 'only what is on disk')

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: ['session-b'] }))
  const value = (reply.body as { value: ArchivePurgeResult }).value
  assert.deepEqual(value.purged, [])
  assert.deepEqual(value.skipped, [{ id: 'session-b', reason: 'not-in-trash' }])
  assert.equal(existsSync(join(s.trashRoot, trashId, 'payload', '0', 'session.jsonl')), true, 'session-a is untouched')
})

test('purge: an unfinished deletion is listed and can be retried', async () => {
  // F4: a purge that dies halfway used to leave invisible bytes with no way to
  // clear them. It is a row now, and the retry completes the removal.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const deleted = (await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-a'] })))
    .body as { value: ArchiveDeleteResult }
  const trashId = deleted.value.trashId!
  // What a failed purge leaves: the entry renamed out of service, payload intact.
  await rename(join(s.trashRoot, trashId), join(s.trashRoot, `${trashId}.purging`))

  const listed = (await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))).body as { value: ArchiveTrashList }
  assert.equal(listed.value.entries.length, 1, 'it is visible')
  assert.equal(listed.value.entries[0].state, 'purging')
  assert.equal(listed.value.entries[0].trashId, trashId, 'addressed by its entry id')
  assert.ok(listed.value.entries[0].totalBytes > 0, 'its bytes are on the books')
  assert.deepEqual(listed.value.entries[0].members.map((member) => member.sessionId), ['session-a'])

  const retried = await call(s.routes.get(`${ROUTE_PREFIX}/purge`)!, request('POST', { ids: ['session-a'] }))
  const value = (retried.body as { value: ArchivePurgeResult }).value
  assert.equal(retried.status, 200)
  assert.deepEqual(value.purged.map((entry) => entry.trashId), [trashId])
  assert.ok(value.freedBytes > 0)
  assert.deepEqual((await readdir(s.trashRoot)), [], 'the leftover is gone')
})

// --- /restore: the inverse of archiving ------------------------------------

test('restore: drops the archive record so the session is visible again', async () => {
  const s = await scenario({ ids: ['session-a', 'session-b'], archived: ['session-a', 'session-b'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore`)!, request('POST', { ids: ['session-a'] }))
  const value = (reply.body as { value: { restored: string[], skipped: Array<{ id: string, reason: string }> } }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.restored, ['session-a'])
  assert.deepEqual(value.skipped, [])
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-b'])
  // Restoring is NOT deletion: the log is untouched, so the session can be
  // opened (and archived again) afterwards.
  assert.equal(existsSync(s.logs.get('session-a')!), true)
})

test('restore: a session that is not archived is skipped, not failed', async () => {
  // The normal cause is a second click, or another window having restored it
  // already. Failing the whole call over that would report a user error where
  // there is none.
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })

  const first = await call(s.routes.get(`${ROUTE_PREFIX}/restore`)!, request('POST', { ids: ['session-a'] }))
  const second = await call(s.routes.get(`${ROUTE_PREFIX}/restore`)!, request('POST', { ids: ['session-a'] }))
  const value = (second.body as { value: { restored: string[], skipped: Array<{ id: string, reason: string }> } }).value

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(value.restored, [])
  assert.deepEqual(value.skipped, [{ id: 'session-a', reason: 'not-archived' }])
})

test('restore: rejects a body that names no ids', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })
  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/restore`)!, request('POST', { ids: [] }))
  assert.equal(reply.status, 400)
})

test('restore: answers 501 when the kernel publishes no unarchive path', async () => {
  // Same capability discipline as /prune: this plugin must never reach for a
  // private write chain, so a kernel without the public removal path gets a
  // coded refusal instead of a silent no-op.
  const routes = harness({
    persistence: { list: async () => [] } as unknown as ArchiveRoutesOptions['persistence'],
    // No `unarchiveSession`: the shape of a kernel that does not publish it.
    registry: { archivedSessionIds: ['session-a'] } as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot: await emptyTrashRoot(),
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
    // These two cases assert a capability refusal, which happens before anything
    // reads the settings file or appends an audit line: the paths are placeholders
    // that nothing here opens.
    auditLog: undefined,
    settingsPath: join(tmpdir(), 'dshar-unused-settings.json'),
    emitRemoved: undefined,
    warn: () => {},
  } as ArchiveRoutesOptions)
  const reply = await call(routes.get(`${ROUTE_PREFIX}/restore`)!, request('POST', { ids: ['session-a'] }))
  assert.equal(reply.status, 501)
})

// --- /prune: the reclaim path for stale records -----------------------------

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

test('prune: keeps a record whose log this kernel cannot list, and drops one that is really gone', async () => {
  // What a rollback looks like from here: a newer kernel wrote the session, so
  // this one's listing does not report it at all — the persistence backend lists
  // the generations it can read and skips the rest in silence. The archive record
  // IS the client's visibility fence, so dropping it would un-hide a session the
  // user archived, for good, and nothing re-creates it. The filesystem has the
  // last word: the directory is there, the session is not gone.
  const root = await mkdtemp(join(tmpdir(), 'dshar-unlisted-'))
  created.push(root)
  const dir = join(root, '--D-codes-example--', 'session-hidden')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  const made = registry(['session-hidden', 'session-gone'])
  const routes = harness({
    persistence: { list: async () => [], root } as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot: await emptyTrashRoot(),
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })

  const reply = await call(routes.get(`${ROUTE_PREFIX}/prune`)!, request('POST', {}))
  const value = (reply.body as { value: { pruned: number; remaining: number } }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value, { pruned: 1, remaining: 1 })
  assert.equal(made.calls.unarchiveSession, 1, 'only the record whose log is really gone is dropped')
  assert.deepEqual([...made.registry.archivedSessionIds], ['session-hidden'], 'the unlisted-but-present record is kept')
})

test('prune: a registry without the write chain answers 501', async () => {
  const handlers = harness({
    persistence: { list: async () => [] },
    registry: { archivedSessionIds: [] },
    sessions: undefined,
    projectionCache: undefined,
    trashRoot: await emptyTrashRoot(),
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })

  const reply = await call(handlers.get(`${ROUTE_PREFIX}/prune`)!, request('POST', {}))
  assert.equal(reply.status, 501)
  assert.equal((reply.body as { error: { code: string } }).error.code, 'prune-unsupported')
  assert.equal((reply.body as { error: { host: { code: string } } }).error.host.code, 'route.pruneUnsupported')
})

// --- /list: the host sends facts, the page writes the copy --------------------

test('list: a session whose header has no cwd gets an empty group title — that heading is client copy', async () => {
  const routes = harness({
    persistence: { list: async () => [{ id: 'session-a', createdAt: 1 }] },
    registry: { archivedSessionIds: ['session-a'] },
    sessions: undefined,
    projectionCache: undefined,
    trashRoot: await emptyTrashRoot(),
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
  })

  const reply = await call(routes.get(`${ROUTE_PREFIX}/list`)!, request('GET'))
  const value = (reply.body as { value: ArchiveList }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(
    value.groups.map(group => ({ cwd: group.cwd, title: group.title })),
    [{ cwd: '', title: '' }],
    'no placeholder sentence crosses the wire; the page renders its own line for cwd === ""',
  )
})

// --- refusals: a stable code beside the transport one --------------------------

test('routes: a refused request carries a coded host message, not a sentence', async () => {
  const s = await scenario({ ids: ['session-a'], archived: ['session-a'] })

  const malformed = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: [] }))

  assert.equal(malformed.status, 400)
  assert.equal((malformed.body as { error: { host: { code: string } } }).error.host.code, 'route.idsRequired')
  assert.equal(existsSync(s.logs.get('session-a')!), true)
})

// --- registration: the carrier's exact-Fetch contract --------------------------

test('routes: each path owns exactly the methods and body mode it declares', async () => {
  const s = await scenario({ ids: [], archived: [] })

  assert.deepEqual(
    [...s.routes].map(([path, route]) => [path, [...route.methods]]),
    [
      // Path order is registration order; the carrier matches paths exactly
      // and lets a method it does not own fall through to the channel's 404.
      [`${ROUTE_PREFIX}/list`, ['GET']],
      [`${ROUTE_PREFIX}/trash`, ['GET']],
      [`${ROUTE_PREFIX}/delete`, ['POST']],
      [`${ROUTE_PREFIX}/restore`, ['POST']],
      [`${ROUTE_PREFIX}/restore-deleted`, ['POST']],
      [`${ROUTE_PREFIX}/purge`, ['POST']],
      [`${ROUTE_PREFIX}/prune`, ['POST']],
      [`${ROUTE_PREFIX}/settings`, ['GET', 'POST']],
      [`${ROUTE_PREFIX}/sweep`, ['POST']],
      [`${ROUTE_PREFIX}/search`, ['GET']],
    ],
  )
})


// --- /delete: the whole subagent tree, and "stop first" -----------------------

/** One session in a tree fixture: its id, and the header facts the walk reads. */
interface TreeMemberSpec {
  readonly id: string
  /** `parentSession` in the header — the fork lineage, which a subagent child
   *  also carries. */
  readonly parent?: string
  /** `origin` in the header; `'subagent'` is the half that makes a child a
   *  SUBAGENT child rather than a fork child. */
  readonly origin?: 'subagent'
}

/**
 * A sessions root holding one parent plus its subagent children, with the header
 * markers `src/tree.ts` reads (`parentSession` + `origin: 'subagent'`).
 *
 * The listing keeps answering for the sessions whose directory is still on disk —
 * the backend's own behavior — so a test can observe what a half-moved tree would
 * look like and prove this surface never produces one.
 */
async function treeScenario(options: {
  readonly members: readonly TreeMemberSpec[]
  /** Ids in the registry's archive set (the roots a delete may name). */
  readonly archived: readonly string[]
  activity?: ArchiveRoutesOptions['activity']
  stopSession?: ArchiveRoutesOptions['stopSession']
  stopWait?: ArchiveRoutesOptions['stopWait']
  subagents?: ArchiveRoutesOptions['subagents']
}) {
  const base = await mkdtemp(join(tmpdir(), 'dshar-tree-'))
  created.push(base)
  const root = join(base, 'sessions')
  const trashRoot = join(base, 'trash')
  await mkdir(root, { recursive: true })
  const logs = new Map<string, string>()
  for (const member of options.members) logs.set(member.id, await sessionDir(root, member.id))
  const made = registry(options.archived)
  const routes = harness({
    persistence: {
      list: async () => options.members
        .filter((member) => existsSync(join(root, member.id)))
        .map((member) => ({
          id: member.id,
          createdAt: 1,
          cwd: 'C:/project',
          ...(member.parent === undefined ? {} : { parentSession: member.parent }),
          ...(member.origin === undefined ? {} : { origin: member.origin }),
        })),
      resolveCurrentLog: async (id: string) => logs.get(id),
      root,
    } as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot,
    projCacheDir: undefined,
    activity: options.activity ?? (async () => []),
    stopSession: options.stopSession,
    subagents: options.subagents,
    ...(options.stopWait === undefined ? {} : { stopWait: options.stopWait }),
    sessionQuery: undefined,
    tools: undefined,
  })
  return { base, root, trashRoot, logs, made, routes }
}

/** One root with two subagent children: the canonical tree. */
const TWO_CHILDREN: readonly TreeMemberSpec[] = [
  { id: 'session-root' },
  { id: 'session-child-a', parent: 'session-root', origin: 'subagent' },
  { id: 'session-child-b', parent: 'session-root', origin: 'subagent' },
]

/** The entry directories under a trash root (the fingerprint of "nothing moved"). */
async function trashEntries(trashRoot: string): Promise<string[]> {
  try { return (await readdir(trashRoot)).sort() } catch { return [] }
}

test('delete: a parent and its two subagent children move into ONE trash entry', async () => {
  const s = await treeScenario({ members: TWO_CHILDREN, archived: ['session-root'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-root', 'session-child-a', 'session-child-b'])
  assert.equal((await trashEntries(s.trashRoot)).length, 1, 'one entry holds the whole tree')
  const metadata = await trashMetadata(s.trashRoot, value.trashId!)
  assert.deepEqual(
    (metadata.members as Array<Record<string, unknown>>).map((member) => ({
      id: member.sessionId,
      slot: member.payload,
      archived: member.archived,
    })),
    [
      { id: 'session-root', slot: '0', archived: undefined },
      // A child was never in the archive set, so a restore must not re-create a
      // record for it: `archived: false` is what carries that fact to disk.
      { id: 'session-child-a', slot: '1', archived: false },
      { id: 'session-child-b', slot: '2', archived: false },
    ],
  )
  for (const id of ['session-root', 'session-child-a', 'session-child-b']) {
    assert.equal(existsSync(join(s.root, id)), false, `${id} left the sessions root`)
    assert.equal(existsSync(join(s.trashRoot, value.trashId!, 'payload', String(value.deleted.indexOf(id)))), true)
  }
  // The tree's ROOT keeps its archive record; a child was never in the set, so
  // there is nothing to write for it and nothing was written.
  assert.deepEqual(s.made.calls, { unarchiveSession: 0, archiveSession: 0 })
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-root'])
})

test('restore-deleted: brings the whole tree back and re-creates only the root record', async () => {
  const s = await treeScenario({ members: TWO_CHILDREN, archived: ['session-root'] })

  const deleted = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
  const trashId = (deleted.body as { value: ArchiveDeleteResult }).value.trashId!

  const restored = await call(s.routes.get(`${ROUTE_PREFIX}/restore-deleted`)!, request('POST', { ids: [trashId] }))
  const value = (restored.body as { value: ArchiveRestoreDeletedResult }).value

  assert.equal(restored.status, 200)
  assert.deepEqual([...value.restored].sort(), ['session-child-a', 'session-child-b', 'session-root'])
  for (const id of ['session-root', 'session-child-a', 'session-child-b']) {
    assert.equal(existsSync(join(s.root, id, 'session.jsonl')), true, `${id} is back at its original path`)
  }
  // Exactly one write: archiving a child would HIDE it, which is the opposite of
  // putting the tree back as it was found.
  assert.deepEqual(s.made.calls, { unarchiveSession: 0, archiveSession: 1 })
  assert.deepEqual([...s.made.registry.archivedSessionIds], ['session-root'])
  assert.deepEqual(await trashEntries(s.trashRoot), [], 'the emptied entry is gone')
})

test('delete: a running subagent child refuses the WHOLE tree and moves nothing', async () => {
  const s = await treeScenario({
    members: TWO_CHILDREN,
    archived: ['session-root'],
    activity: async (id: string) => (id === 'session-child-b' ? [{ kind: 'turn' }] : []),
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-root', reason: 'live', sessions: ['session-child-b'] }])
  for (const id of ['session-root', 'session-child-a', 'session-child-b']) {
    assert.equal(existsSync(join(s.root, id, 'session.jsonl')), true, `${id} is untouched`)
  }
  assert.deepEqual(await trashEntries(s.trashRoot), [], 'no entry was created for a refused tree')
})

test('delete: a tree deeper than the walk bound refuses the whole tree', async () => {
  // MAX_TREE_DEPTH is 8 edges below the root (`src/tree.ts`); this chain is 9.
  const chain: TreeMemberSpec[] = [{ id: 'session-root' }]
  let parent = 'session-root'
  for (let depth = 1; depth <= 9; depth += 1) {
    const id = `session-d${depth}`
    chain.push({ id, parent, origin: 'subagent' })
    parent = id
  }
  const s = await treeScenario({ members: chain, archived: ['session-root'] })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.equal(value.skipped.length, 1)
  assert.equal(value.skipped[0]!.reason, 'tree-too-large')
  assert.match(value.skipped[0]!.detail ?? '', /deeper than 8 levels/)
  for (const member of chain) assert.equal(existsSync(join(s.root, member.id)), true, `${member.id} is untouched`)
  assert.deepEqual(await trashEntries(s.trashRoot), [])
})

test('delete: a member already parked in another entry is reported, not half-moved', async () => {
  // The state a restore/lookup race can leave: an entry claims a member's payload
  // while the sessions root still holds that member's directory too.
  const s = await treeScenario({ members: TWO_CHILDREN, archived: ['session-root'] })
  const seededId = '1700000000000-deadbeef'
  await mkdir(join(s.trashRoot, seededId, 'payload', '0'), { recursive: true })
  await writeFile(join(s.trashRoot, seededId, 'payload', '0', 'session.jsonl'), 'x')
  await writeFile(join(s.trashRoot, seededId, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId: seededId,
    deletedAt: new Date(1700000000000).toISOString(),
    members: [{
      sessionId: 'session-child-b',
      title: '',
      originalPath: join(s.root, 'session-child-b'),
      payload: '0',
      sizeBytes: 1,
      archived: false,
    }],
  }))

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-root', reason: 'already-in-trash', sessions: ['session-child-b'] }])
  assert.deepEqual(await trashEntries(s.trashRoot), [seededId], 'no second entry was created')
  for (const id of ['session-root', 'session-child-a', 'session-child-b']) {
    assert.equal(existsSync(join(s.root, id, 'session.jsonl')), true, `${id} is untouched`)
  }
})

test('delete: a second call for the same tree is a no-op reported as already-in-trash', async () => {
  const s = await treeScenario({ members: TWO_CHILDREN, archived: ['session-root'] })
  const route = s.routes.get(`${ROUTE_PREFIX}/delete`)!

  await call(route, request('POST', { ids: ['session-root'] }))
  const second = await call(route, request('POST', { ids: ['session-root'] }))
  const value = (second.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  // The whole tree reported as parked. It is named by the ROOT only: the children
  // are no longer in the kernel's listing (their directories left the sessions
  // root with the first call), so the walk that reads that listing finds this
  // request's tree to be the root itself — and the root is what the first entry
  // already holds, which is the answer the fence needs.
  assert.deepEqual(value.skipped, [{ id: 'session-root', reason: 'already-in-trash' }])
  assert.equal((await trashEntries(s.trashRoot)).length, 1, 'still exactly one entry')
  const listing = await call(s.routes.get(`${ROUTE_PREFIX}/trash`)!, request('GET'))
  const trash = (listing.body as { value: ArchiveTrashList }).value
  assert.deepEqual(
    trash.entries.flatMap((entry) => entry.members.map((member) => member.sessionId)).sort(),
    ['session-child-a', 'session-child-b', 'session-root'],
    'the single entry still holds the whole tree',
  )
})

test('delete: stopFirst stops the running child, waits for it to settle, then moves the tree', async () => {
  const running = new Set(['session-child-a'])
  const stopped: string[] = []
  const s = await treeScenario({
    members: TWO_CHILDREN,
    archived: ['session-root'],
    activity: async (id: string) => (running.has(id) ? [{ kind: 'turn' }] : []),
    stopSession: async (id: string) => {
      stopped.push(id)
      running.delete(id)
    },
    stopWait: { timeoutMs: 200, pollMs: 1 },
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'], stopFirst: true }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, ['session-root', 'session-child-a', 'session-child-b'])
  assert.deepEqual(stopped, ['session-child-a'], 'only the member that was running was asked to stop')
  const metadata = await trashMetadata(s.trashRoot, value.trashId!)
  assert.equal((metadata.members as unknown[]).length, 3)
})

test('delete: a session that never settles inside the bounded wait is refused with the ids still active', async () => {
  const s = await treeScenario({
    members: TWO_CHILDREN,
    archived: ['session-root'],
    // The stop is accepted, but the work never stops: the wait must end on its own
    // budget and the tree must stay where it is.
    activity: async (id: string) => (id === 'session-child-a' ? [{ kind: 'turn' }] : []),
    stopSession: async () => {},
    stopWait: { timeoutMs: 30, pollMs: 2 },
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'], stopFirst: true }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.skipped, [{ id: 'session-root', reason: 'still-running', sessions: ['session-child-a'] }])
  for (const id of ['session-root', 'session-child-a', 'session-child-b']) {
    assert.equal(existsSync(join(s.root, id, 'session.jsonl')), true, `${id} is untouched`)
  }
  assert.deepEqual(await trashEntries(s.trashRoot), [], 'a timed-out wait moves nothing')
})

test('delete: a failing stop dispatch refuses and keeps the failure reason', async () => {
  const s = await treeScenario({
    members: TWO_CHILDREN,
    archived: ['session-root'],
    activity: async (id: string) => (id === 'session-root' ? [{ kind: 'turn' }] : []),
    stopSession: async () => { throw new Error('cancel seam disposed') },
    stopWait: { timeoutMs: 50, pollMs: 1 },
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'], stopFirst: true }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.deleted, [])
  assert.equal(value.skipped.length, 1)
  assert.equal(value.skipped[0]!.reason, 'stop-failed')
  assert.deepEqual(value.skipped[0]!.sessions, ['session-root'])
  assert.match(value.skipped[0]!.detail ?? '', /cancel seam disposed/)
  for (const id of ['session-root', 'session-child-a', 'session-child-b']) {
    assert.equal(existsSync(join(s.root, id, 'session.jsonl')), true, `${id} is untouched`)
  }
})

test('delete: stopFirst does not guess when the activity seam throws', async () => {
  // Issuing no stop and then waiting would report a timeout for work nobody asked
  // to stop, so an unanswerable seam still refuses as `live`.
  const s = await treeScenario({
    members: TWO_CHILDREN,
    archived: ['session-root'],
    activity: async () => { throw new Error('waterfall disposed') },
    stopSession: async () => { throw new Error('must not be reached') },
    stopWait: { timeoutMs: 20, pollMs: 1 },
  })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'], stopFirst: true }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.deepEqual(value.skipped, [{
    id: 'session-root',
    reason: 'live',
    sessions: ['session-root', 'session-child-a', 'session-child-b'],
  }])
  assert.equal(existsSync(join(s.root, 'session-root', 'session.jsonl')), true)
})

test('delete: a non-boolean stopFirst is refused before any filesystem work', async () => {
  const s = await treeScenario({ members: TWO_CHILDREN, archived: ['session-root'] })

  const reply = await call(
    s.routes.get(`${ROUTE_PREFIX}/delete`)!,
    request('POST', { ids: ['session-root'], stopFirst: 'yes' }),
  )

  assert.equal(reply.status, 400)
  assert.equal((reply.body as { error: { host: { code: string } } }).error.host.code, 'route.badStopFirst')
  assert.equal(existsSync(join(s.root, 'session-root', 'session.jsonl')), true)
})

// --- /delete: a tree whose members cannot be inspected -----------------------

/**
 * A tree laid out the way the BACKEND stores it
 * (`<root>/<project>/<id>/session…jsonl`), behind a resolver that names only the
 * ROOT's log.
 *
 * That is what makes every child go through the directory walk: `resolveCurrentLog`
 * answers for the root, so the children's directories are found (or not found) by
 * reading the filesystem. It is the shape in which "I could not look" and "it is not
 * there" used to be the same answer.
 */
async function walkedTreeScenario() {
  const base = await mkdtemp(join(tmpdir(), 'dshar-walked-'))
  created.push(base)
  const root = join(base, 'sessions')
  const project = '--D-codes-example--'
  const ids = ['session-root', 'session-child-a', 'session-child-b']
  for (const id of ids) {
    const dir = join(root, project, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), '{"type":"session/header"}\n')
  }
  const made = registry(['session-root'])
  const routes = harness({
    persistence: {
      // A session stops being listed once its directory leaves the root — what the
      // backend does, and what makes a second click answer from the trash.
      list: async () => ids
        .filter((id) => existsSync(join(root, project, id)))
        .map((id) => ({
          id,
          createdAt: 1,
          cwd: 'C:/project',
          ...(id === 'session-root' ? {} : { parentSession: 'session-root', origin: 'subagent' }),
        })),
      // Only the ROOT is named: the children must be located by the walk.
      resolveCurrentLog: async (id: string) => (id === 'session-root' ? join(root, project, id, 'session.jsonl') : undefined),
      root,
    } as unknown as ArchiveRoutesOptions['persistence'],
    registry: made.registry as unknown as ArchiveRoutesOptions['registry'],
    sessions: undefined,
    projectionCache: undefined,
    trashRoot: join(base, 'trash'),
    projCacheDir: undefined,
    activity: async () => [],
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
    auditLog: undefined,
    settingsPath: join(base, 'settings.json'),
    emitRemoved: undefined,
    warn: () => {},
  } as ArchiveRoutesOptions)
  return { base, root, project, ids, trashRoot: join(base, 'trash'), made, routes }
}

/** The `fs/promises` exports object the route layer calls through. */
const fsSurface = createRequire(import.meta.url)('node:fs/promises') as Record<string, unknown>

test('delete: a child whose directory cannot be inspected refuses the WHOLE tree', async () => {
  // The bug this guards: the walk caught every readdir failure and answered "not in
  // this project", so a child that existed but could not be read was reported as
  // "member gone" — the root moved alone, the child's directory stayed on disk, and
  // `skipped` said nothing about it.
  const s = await walkedTreeScenario()
  const originalReaddir = fsSurface.readdir as (path: string, options?: unknown) => Promise<unknown>
  fsSurface.readdir = async (path: string, options?: unknown) => {
    if (typeof path === 'string' && path.includes('session-child-a')) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    return originalReaddir(path, options)
  }
  try {
    const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
    const value = (reply.body as { value: ArchiveDeleteResult }).value

    assert.equal(reply.status, 200)
    assert.deepEqual(value.deleted, [], 'nothing moves when a member cannot be inspected')
    assert.equal(value.skipped.length, 1)
    assert.equal(value.skipped[0]!.id, 'session-root', 'the refusal is reported against the requested id')
    assert.equal(value.skipped[0]!.reason, 'io')
    assert.deepEqual(value.skipped[0]!.sessions, s.ids, 'and it names the whole tree it is about')
    assert.match(value.skipped[0]!.detail ?? '', /could not inspect/)
    for (const id of s.ids) {
      assert.equal(existsSync(join(s.root, s.project, id, 'session.jsonl')), true, `${id} is untouched`)
    }
    assert.deepEqual(await trashEntries(s.trashRoot), [], 'no entry was created for a refused tree')
    assert.deepEqual(s.made.calls, { unarchiveSession: 0, archiveSession: 0 })
  } finally {
    fsSurface.readdir = originalReaddir
  }
})

test('delete: a child whose directory is really GONE is not a member, and the rest moves', async () => {
  // The other half of the same rule: positive absence is an answer, and the tree
  // moves without the member it cannot find. There is nothing on disk to orphan.
  const s = await walkedTreeScenario()
  await rm(join(s.root, s.project, 'session-child-b'), { recursive: true, force: true })

  const reply = await call(s.routes.get(`${ROUTE_PREFIX}/delete`)!, request('POST', { ids: ['session-root'] }))
  const value = (reply.body as { value: ArchiveDeleteResult }).value

  assert.equal(reply.status, 200)
  assert.deepEqual(value.deleted, ['session-root', 'session-child-a'], 'the gone member is not named as moved')
  assert.deepEqual(value.skipped, [])
  const metadata = await trashMetadata(s.trashRoot, value.trashId!)
  assert.deepEqual(
    (metadata.members as Array<Record<string, unknown>>).map((member) => member.sessionId),
    ['session-root', 'session-child-a'],
  )
})
