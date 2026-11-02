/**
 * A small shared fixture for the suites that drive the whole route layer.
 *
 * `routes.test.ts` builds its own copies of these helpers inline; the suites added
 * after it (retention, audit, the removal broadcast) need the same three things —
 * a captured exact-Fetch registry, a temp sessions/trash layout, and a runtime stub
 * that counts its writes — and a third copy is where they start to drift. Nothing
 * here asserts anything: it is the shape of a host, not a test.
 *
 * Scratch roots are recorded in {@link created} so each suite can remove them in
 * its own `after` hook (the removal is the suite's, because the hook belongs to the
 * file that ran).
 *
 * @module @dsh-app/plugin-archives/tests/harness
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { registerArchiveRoutes, type ArchiveRoutesOptions } from '../src/routes.ts'

/** Scratch roots the calling suite created; it removes them when it finishes. */
export const created: string[] = []

/** Remove every scratch root this process's suites registered. */
export async function cleanup(): Promise<void> {
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** One captured exact-Fetch route: its declared methods and its handler. */
export interface CapturedRoute {
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** Capture the registered exact-Fetch routes keyed by path. */
export function harness(options: ArchiveRoutesOptions): Map<string, CapturedRoute> {
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
export function request(method: string, body?: unknown, url = '/'): Request {
  return new Request(`dsh-app://app${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

/** Dispatch one request through a captured route and decode the JSON envelope. */
export async function call(
  route: CapturedRoute | undefined,
  req: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
  assert.ok(route !== undefined, `no route was registered for this request (${req.method} ${new URL(req.url).pathname})`)
  const response = await route.fetch(req)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** Registry stub that counts every write-side call and mutates its own state. */
export function registry(archivedSessionIds: readonly string[]) {
  const calls = { unarchiveSession: 0, archiveSession: 0 }
  const state = { archivedSessionIds: [...archivedSessionIds] }
  return {
    calls,
    registry: {
      get archivedSessionIds(): readonly string[] { return state.archivedSessionIds },
      unarchiveSession: (sessionId: string): Promise<void> => {
        calls.unarchiveSession += 1
        state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== sessionId)
        return Promise.resolve()
      },
      archiveSession: (sessionId: string): Promise<void> => {
        calls.archiveSession += 1
        if (!state.archivedSessionIds.includes(sessionId)) {
          state.archivedSessionIds = [...state.archivedSessionIds, sessionId]
        }
        return Promise.resolve()
      },
    },
  }
}

/** Create one on-disk session directory and return its log path. */
export async function sessionDir(root: string, id: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  await writeFile(log, '{"type":"session/header"}\n')
  return log
}

/**
 * A host fixture: sessions root, trash root, projection-cache directory, settings
 * file and audit log, all under one temporary base.
 */
export interface Fixture {
  readonly base: string
  readonly root: string
  readonly trashRoot: string
  readonly projCacheDir: string
  readonly settingsPath: string
  readonly auditLog: string
  readonly logs: Map<string, string>
  readonly made: ReturnType<typeof registry>
  readonly routes: Map<string, CapturedRoute>
  readonly options: ArchiveRoutesOptions
  /** Session ids the broadcast named, in order. */
  readonly emitted: string[]
  /** Messages the route layer reported as warnings (never thrown). */
  readonly warnings: string[]
}

/** Build one fixture and its routes. */
export async function fixture(input: {
  ids: readonly string[]
  archived: readonly string[]
  /** Registry to hand over instead of the counting stub. */
  registry?: ArchiveRoutesOptions['registry']
  /** The kernel's activity answer per id; absent means nothing is running. */
  activity?: ArchiveRoutesOptions['activity']
  /** Clock the retention sweep reads. */
  now?: () => number
}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'dshar-fx-'))
  created.push(base)
  const root = join(base, 'sessions')
  const trashRoot = join(base, 'trash')
  const projCacheDir = join(base, 'session_projcache', 'sessions')
  const logs = new Map<string, string>()
  await mkdir(root, { recursive: true })
  await mkdir(projCacheDir, { recursive: true })
  for (const id of input.ids) logs.set(id, await sessionDir(root, id))
  const settingsPath = join(base, 'storages', 'dsh-app-plugin-archives', 'settings.json')
  const auditLog = join(base, 'logs', 'dsh-app-plugin-archives.log')
  const made = registry(input.archived)
  const emitted: string[] = []
  const warnings: string[] = []
  const options: ArchiveRoutesOptions = {
    persistence: {
      // A moved session stops being listed — what the backend does once its
      // directory has left the sessions root.
      list: async () => [...logs.keys()]
        .filter((id) => existsSync(join(root, id)))
        .map((id) => ({ id, createdAt: 1, cwd: 'C:/project' })),
      resolveCurrentLog: async (id: string) => logs.get(id),
      root,
    } as unknown as ArchiveRoutesOptions['persistence'],
    registry: input.registry ?? (made.registry as unknown as ArchiveRoutesOptions['registry']),
    sessions: undefined,
    projectionCache: undefined,
    trashRoot,
    projCacheDir,
    activity: input.activity ?? (async () => []),
    stopSession: undefined,
    subagents: undefined,
    sessionQuery: undefined,
    tools: undefined,
    auditLog,
    settingsPath,
    emitRemoved: (id: string) => { emitted.push(id) },
    warn: (message: string) => { warnings.push(message) },
    ...(input.now === undefined ? {} : { now: input.now }),
  }
  return {
    base,
    root,
    trashRoot,
    projCacheDir,
    settingsPath,
    auditLog,
    logs,
    made,
    routes: harness(options),
    options,
    emitted,
    warnings,
  }
}
