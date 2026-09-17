/**
 * Spreadsheet-mode persistence and the mode route contract: the store's
 * on/off round-trip through mode.json (including the shapes that must read as
 * "off" instead of as an accidental activation), and the Connection exact-Fetch
 * route's declared surface, method ownership and payload validation over a fake
 * Fetch registry and real Request/Response objects.
 *
 * @module @dsh-app/plugin-sheet/tests/mode
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SheetModeStore } from '../src/mode-store.ts'
import { OFFICE_ACTIVE_FORMAT } from '../src/office-format.ts'
import { officeActiveFilePath, readOfficeActive } from '../src/office-active-store.ts'
import { registerSheetRoutes, ROUTE_PREFIX } from '../src/routes.ts'

/** One temp store file plus its shared active file, removed when done. */
function tempStore(): { store: SheetModeStore, file: string, activeFile: string, done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-mode-test-'))
  const file = join(dir, 'mode.json')
  const activeFile = officeActiveFilePath(dir)
  mkdirSync(join(dir, 'storages', 'dsh-app-office'), { recursive: true })
  return {
    store: new SheetModeStore(file),
    file,
    activeFile,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// --- store -------------------------------------------------------------------

test('mode store: on/off round-trips through mode.json', async () => {
  const { store, file, done } = tempStore()
  try {
    assert.equal(store.enabledOf('s1'), false)
    store.set('s1', true)
    assert.equal(store.enabledOf('s1'), true)
    assert.equal(typeof store.updatedAtOf('s1'), 'number')
    await store.flush()
    assert.ok(existsSync(file))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { enabled: boolean, updatedAt: number }>
    assert.deepEqual(Object.keys(parsed), ['s1'])
    assert.equal(parsed['s1']?.enabled, true)
    assert.ok((parsed['s1']?.updatedAt ?? 0) > 0)

    const reopened = new SheetModeStore(file)
    reopened.load()
    assert.equal(reopened.enabledOf('s1'), true)

    reopened.set('s1', false)
    await reopened.flush()
    const reloaded = new SheetModeStore(file)
    reloaded.load()
    assert.equal(reloaded.enabledOf('s1'), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  } finally {
    done()
  }
})

test('mode store: only an explicit enabled:true entry counts as a mode', async () => {
  const { store, file, done } = tempStore()
  try {
    writeFileSync(file, JSON.stringify({
      off: { enabled: false, updatedAt: Date.now() },
      truthy: { enabled: 'yes', updatedAt: Date.now() },
      legacy: { template: 'dsh-blue-professional', updatedAt: Date.now() },
      stale: { enabled: true },
      on: { enabled: true, updatedAt: Date.now() },
    }), 'utf8')
    store.load()
    assert.equal(store.enabledOf('on'), true)
    for (const sessionId of ['off', 'truthy', 'legacy', 'stale']) {
      assert.equal(store.enabledOf(sessionId), false, `${sessionId} must read as off`)
    }
  } finally {
    done()
  }
})

test('mode store: a corrupt file starts empty instead of failing the mount', async () => {
  const { store, file, done } = tempStore()
  try {
    writeFileSync(file, '{ not json', 'utf8')
    const warnings: string[] = []
    const logging = new SheetModeStore(file, { warn: (message) => warnings.push(message), info: () => {} })
    logging.load()
    assert.equal(logging.enabledOf('s1'), false)
    assert.equal(warnings.length, 1)
    store.load()
    assert.equal(store.enabledOf('s1'), false)
  } finally {
    done()
  }
})

test('mode store: prune drops entries older than the max age', async () => {
  const { store, file, done } = tempStore()
  try {
    store.set('fresh', true)
    store.set('old', true)
    await store.flush()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { enabled: boolean, updatedAt: number }>
    assert.ok(parsed['old'] !== undefined)
    const pruned = store.prune(1_000, Date.now() + 2_000)
    assert.equal(pruned, 2)
    assert.equal(store.enabledOf('fresh'), false)
    await store.flush()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  } finally {
    done()
  }
})

// --- routes ------------------------------------------------------------------

/** One captured Connection exact-Fetch route. */
interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  fetch(request: Request): Promise<Response>
}

/** Fake Connection exact-Fetch registry capturing registrations by path. */
function fakeConnection(): {
  fetch: { register(route: CapturedRoute): () => Promise<void> }
  route(path: string): CapturedRoute
  count(): number
} {
  const routes = new Map<string, CapturedRoute>()
  return {
    fetch: {
      register(route: CapturedRoute) {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
    route(path) {
      const route = routes.get(path)
      assert.ok(route !== undefined, `route ${path} registered`)
      return route
    },
    count: () => routes.size,
  }
}

interface Envelope {
  ok: boolean
  value?: Record<string, unknown>
  error?: { code: string, message: string }
}

interface Answer {
  status: number
  contentType: string | null
  body: Envelope
}

/** Drive one captured route the way the carrier does: an absolute URL and a method. */
async function call(route: CapturedRoute, url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await route.fetch(new Request(`dsh-app://app${url}`, init))
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.json() as Envelope,
  }
}

test('mode route: POST toggles, GET reads, unknown sessions read as off', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const connection = fakeConnection()
    registerSheetRoutes(connection.fetch as never, store, activeFile)
    assert.equal(connection.count(), 2)
    const mode = `${ROUTE_PREFIX}/mode`

    const on = await call(connection.route(mode), mode, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', enabled: true }),
    })
    assert.equal(on.status, 200)
    assert.equal(on.contentType, 'application/json')
    assert.equal(store.enabledOf('s1'), true)
    assert.equal((on.body.value as { enabled: boolean }).enabled, true)
    assert.equal(readOfficeActive(activeFile)?.format, OFFICE_ACTIVE_FORMAT)

    const read = await call(connection.route(mode), `${mode}?sessionId=s1`)
    assert.equal((read.body.value as { enabled: boolean }).enabled, true)

    const unknown = await call(connection.route(mode), `${mode}?sessionId=nobody`)
    assert.equal(unknown.status, 200)
    assert.equal((unknown.body.value as { enabled: boolean }).enabled, false)

    const off = await call(connection.route(mode), mode, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', enabled: false }),
    })
    assert.equal(off.status, 200)
    assert.equal(store.enabledOf('s1'), false)
    // Turning off releases our own claim but keeps the claim readable.
    assert.equal(readOfficeActive(activeFile)?.format, null)

    const activePath = `${ROUTE_PREFIX}/office-active`
    const active = await call(connection.route(activePath), activePath)
    assert.equal(active.status, 200)
    assert.deepEqual((active.body.value as { active: unknown }).active, readOfficeActive(activeFile))
  } finally {
    done()
  }
})

test('mode route: bad payloads and oversized bodies are refused', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const connection = fakeConnection()
    registerSheetRoutes(connection.fetch as never, store, activeFile)
    const mode = `${ROUTE_PREFIX}/mode`
    const post = (body: string): Promise<Answer> => call(connection.route(mode), mode, { method: 'POST', body })

    const missingSession = await post(JSON.stringify({ enabled: true }))
    assert.equal(missingSession.status, 400)
    assert.equal(missingSession.body.ok, false)
    assert.equal(missingSession.body.error?.code, 'bad-request')

    const badEnabled = await post(JSON.stringify({ sessionId: 's1', enabled: 'yes' }))
    assert.equal(badEnabled.status, 400)

    const notJson = await post('not json at all')
    assert.equal(notJson.status, 400)

    const oversized = await post(JSON.stringify({ sessionId: 's1', enabled: true, padding: 'x'.repeat(9_000) }))
    assert.equal(oversized.status, 413)

    const noSession = await call(connection.route(mode), mode)
    assert.equal(noSession.status, 400)

    assert.equal(store.enabledOf('s1'), false)
  } finally {
    done()
  }
})

test('mode routes: exact paths, owned methods, and no `@` in the URL', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const connection = fakeConnection()
    const dispose = registerSheetRoutes(connection.fetch as never, store, activeFile)
    const mode = connection.route(`${ROUTE_PREFIX}/mode`)
    const active = connection.route(`${ROUTE_PREFIX}/office-active`)

    // The toggle travels as POST: the registry owns GET/HEAD/POST, so a PUT
    // would fall through to the shared channel's own 404.
    assert.deepEqual([...mode.methods], ['GET', 'POST'])
    assert.deepEqual([...active.methods], ['GET'])
    assert.equal(mode.requestBody, 'buffered')
    assert.equal(active.requestBody, 'buffered')
    assert.equal(ROUTE_PREFIX, '/api/plugins/dsh-app/plugin-sheet')
    assert.ok(!ROUTE_PREFIX.includes('@'), 'the registry admits no @ in a path segment')

    await dispose()
    assert.equal(connection.count(), 0)
  } finally {
    done()
  }
})
