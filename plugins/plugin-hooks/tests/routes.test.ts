/**
 * Route registration and handler tests on the Connection exact-Fetch registry:
 * which exact paths and methods this plugin claims, and what each handler
 * answers. A captured registry stands in for `ctx.connection.fetch` and a real
 * store on disk stands in for `$DSH_HOME/storages`, so no transport and no HTTP
 * server are involved.
 *
 * @module plugin-hooks/tests/routes
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { HooksMountManager } from '../src/mount.ts'
import { NativeHookRuntime } from '../src/native.ts'
import { registerHooksRoutes, ROUTE_PREFIX } from '../src/routes.ts'
import { HooksStore } from '../src/store.ts'

const NATIVE_INLINE = { dialect: 'native', enabled: true, configSource: 'inline', configContent: JSON.stringify({ rules: [{ on: 'pre-tool-use', action: 'block', message: 'x' }] }) }

interface Harness {
  readonly routes: Map<string, ConnectionFetchRoute>
  readonly store: HooksStore
  readonly storePath: string
  readonly call: (path: string, init?: RequestInit) => Promise<Response>
  readonly json: (path: string, init?: RequestInit) => Promise<{ status: number, body: Record<string, unknown> }>
}

let dir: string
let harness: Harness
let dispose: () => Promise<void>

function capture(loader?: unknown): Harness {
  const routes = new Map<string, ConnectionFetchRoute>()
  const connectionFetch: HostConnectionFetch = {
    register: (route) => {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    },
  }
  const store = new HooksStore(dir, () => undefined)
  dispose = registerHooksRoutes(connectionFetch, store, new HooksMountManager(() => undefined, loader), new NativeHookRuntime(() => undefined))
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const route = routes.get(path)
    assert.ok(route !== undefined, `no route registered for ${path}`)
    return await route.fetch(new Request(`dsh-app://app${path}`, init))
  }
  return {
    routes,
    store,
    storePath: store.filePath,
    call,
    json: async (path, init) => {
      const response = await call(path, init)
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
  }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-hooks-routes-'))
  harness = capture()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('route registration', () => {
  it('claims exactly the four exact paths on the shared /api channel', () => {
    assert.deepEqual([...harness.routes.keys()].sort(), [
      `${ROUTE_PREFIX}/bridge/create`,
      `${ROUTE_PREFIX}/bridge/delete`,
      `${ROUTE_PREFIX}/bridge/update`,
      `${ROUTE_PREFIX}/hooks`,
    ])
    assert.equal(ROUTE_PREFIX, '/api/plugins/dsh-app/plugin-hooks')
    for (const route of harness.routes.values()) {
      assert.equal(route.requestBody, 'buffered')
      // The npm scope's `@` cannot appear in a path segment, and the registry
      // admits no parameter segment: an argument rides the body.
      assert.equal(/^\/api\/(?:[A-Za-z0-9_$.-]+\/)*[A-Za-z0-9_$.-]+$/.test(route.path), true, route.path)
    }
  })

  it('owns GET on the read route and POST on every write route', () => {
    const methods = (suffix: string): readonly string[] => harness.routes.get(`${ROUTE_PREFIX}/${suffix}`)!.methods
    assert.deepEqual(methods('hooks'), ['GET'])
    assert.deepEqual(methods('bridge/create'), ['POST'])
    assert.deepEqual(methods('bridge/update'), ['POST'])
    assert.deepEqual(methods('bridge/delete'), ['POST'])
  })

  it('leaves the removed web-server prefix unclaimed', () => {
    for (const path of harness.routes.keys()) assert.equal(path.startsWith('/plugins/'), false, path)
  })

  it('removes every route when the returned disposer runs', async () => {
    await dispose()
    assert.equal(harness.routes.size, 0)
  })
})

describe('GET /hooks', () => {
  it('answers the status envelope with the store path and no bridges', async () => {
    const { status, body } = await harness.json(`${ROUTE_PREFIX}/hooks`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const value = body.value as Record<string, unknown>
    assert.equal(value.enabled, true)
    assert.equal(value.filePath, harness.storePath)
    assert.equal(value.mountAvailable, false)
    assert.deepEqual(value.bridges, [])
  })

  it('reports a native entry with its mount status', async () => {
    await harness.call(`${ROUTE_PREFIX}/bridge/create`, post(NATIVE_INLINE))
    const { body } = await harness.json(`${ROUTE_PREFIX}/hooks`)
    const bridges = (body.value as Record<string, unknown>).bridges as Array<Record<string, unknown>>
    assert.equal(bridges.length, 1)
    assert.equal(bridges[0]?.dialect, 'native')
    assert.deepEqual(bridges[0]?.status, { state: 'mounted' })
  })
})

describe('write routes', () => {
  it('creates a bridge, persists it, and answers the refreshed list', async () => {
    const { status, body } = await harness.json(`${ROUTE_PREFIX}/bridge/create`, post(NATIVE_INLINE))
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal((body.value as { bridges: unknown[] }).bridges.length, 1)
    assert.equal(existsSync(harness.storePath), true)
    assert.equal(harness.store.load().bridges.length, 1)
  })

  it('updates and deletes a compatibility bridge by the id in the body', async () => {
    harness = capture({ create: async () => 'entry-1', remove: async () => undefined })
    const configPath = join(dir, 'hooks.json')
    const created = await harness.json(`${ROUTE_PREFIX}/bridge/create`, post({ dialect: 'claude-code', enabled: true, configSource: 'file', configPath }))
    assert.equal(created.status, 200)
    const id = harness.store.load().bridges[0]!.id
    const updated = await harness.json(`${ROUTE_PREFIX}/bridge/update`, post({ dialect: 'claude-code', enabled: false, configSource: 'file', configPath, id }))
    assert.equal(updated.status, 200)
    const views = (updated.body.value as { bridges: Array<{ id: string, enabled: boolean, status: { state: string } }> }).bridges
    assert.equal(views[0]?.enabled, false)
    assert.equal(views[0]?.status.state, 'disabled')
    const deleted = await harness.json(`${ROUTE_PREFIX}/bridge/delete`, post({ id }))
    assert.equal(deleted.status, 200)
    assert.equal((deleted.body.value as { bridges: unknown[] }).bridges.length, 0)
    assert.equal(harness.store.load().bridges.length, 0)
  })

  it('answers a rejected definition with the 400 that carries its code', async () => {
    const { status, body } = await harness.json(`${ROUTE_PREFIX}/bridge/create`, post({ dialect: 'vscode' }))
    assert.equal(status, 400)
    assert.equal(body.ok, false)
    assert.equal((body.error as { code: string }).code, 'bad-request')
    assert.equal((body.error as { host: { code: string } }).host.code, 'dialect.invalid')
  })

  it('answers an unknown id on update with the 400 that carries its code', async () => {
    const { status, body } = await harness.json(`${ROUTE_PREFIX}/bridge/update`, post({ ...NATIVE_INLINE, id: 'hook-9' }))
    assert.equal(status, 400)
    assert.equal((body.error as { host: { code: string } }).host.code, 'bridge.notFound')
  })

  it('refuses every write when the whole plugin is disabled', async () => {
    writeFileSync(harness.storePath, JSON.stringify({ version: 1, enabled: false, bridges: [] }))
    const { status, body } = await harness.json(`${ROUTE_PREFIX}/bridge/create`, post(NATIVE_INLINE))
    assert.equal(status, 409)
    assert.equal((body.error as { host: { code: string } }).host.code, 'route.disabled')
    assert.equal(existsSync(harness.storePath), true)
  })

  it('answers an unparseable body as 400 and an oversized one as 413', async () => {
    const invalid = await harness.json(`${ROUTE_PREFIX}/bridge/create`, post('{not json'))
    assert.equal(invalid.status, 400)
    assert.equal((invalid.body.error as { host: { code: string } }).host.code, 'route.invalidBody')
    const oversized = await harness.json(`${ROUTE_PREFIX}/bridge/delete`, post({ id: 'x'.repeat(17_000) }))
    assert.equal(oversized.status, 413)
    assert.equal((oversized.body.error as { host: { code: string } }).host.code, 'route.bodyTooLarge')
  })

  it('keeps a store write failure a 500 with the failing reason attached', async () => {
    // A directory where the store file must go makes every save fail.
    const blocked = mkdtempSync(join(tmpdir(), 'plugin-hooks-blocked-'))
    mkdirSync(join(blocked, 'config.json'))
    const failing = new HooksStore(blocked, () => undefined)
    const routes = new Map<string, ConnectionFetchRoute>()
    const connectionFetch: HostConnectionFetch = {
      register: (route) => {
        routes.set(route.path, route)
        return async () => undefined
      },
    }
    registerHooksRoutes(connectionFetch, failing, new HooksMountManager(() => undefined, undefined), new NativeHookRuntime(() => undefined))
    const response = await routes.get(`${ROUTE_PREFIX}/bridge/create`)!.fetch(
      new Request(`dsh-app://app${ROUTE_PREFIX}/bridge/create`, post(NATIVE_INLINE)),
    )
    assert.equal(response.status, 500)
    const body = await response.json() as { error: { host: { code: string, text?: string } } }
    assert.equal(body.error.host.code, 'route.writeFailed')
    assert.equal(typeof body.error.host.text, 'string')
    rmSync(blocked, { recursive: true, force: true })
  })
})
