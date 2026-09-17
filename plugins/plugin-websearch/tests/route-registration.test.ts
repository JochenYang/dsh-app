/**
 * Route registration on the Connection exact-Fetch registry.
 *
 * The settings page reaches the host half over the shared `/api` channel, so
 * the registered paths, the methods each route owns, and the envelopes they
 * answer ARE the transport contract the client depends on. The harness is a
 * captured registry plus a real {@link WebSearchStore} in a temp directory —
 * no HTTP server, no kernel.
 *
 * @module plugin-websearch/tests/route-registration
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { registerWebSearchRoutes, ROUTE_PREFIX, type RouteDeps } from '../src/routes.ts'
import { WebSearchStore } from '../src/store.ts'
import { UPSTREAM_PROVIDER_ID } from '../src/wire.ts'

/** One route as the registry received it. */
interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Captured routes + a caller that drives one of them directly. */
interface Harness {
  readonly routes: ReadonlyMap<string, CapturedRoute>
  readonly call: (path: string, init?: RequestInit) => Promise<{ status: number, body: Record<string, unknown> }>
  readonly store: WebSearchStore
  readonly providerChoices: string[]
}

const dirs: string[] = []

function harness(overrides: Partial<RouteDeps> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-websearch-routes-'))
  dirs.push(dir)
  const routes = new Map<string, CapturedRoute>()
  // The registry faces the host as `ctx.connection.fetch`; only `register` is used.
  const connectionFetch = {
    register(route: CapturedRoute): () => Promise<void> {
      routes.set(route.path, route)
      return Promise.resolve()
    },
  }
  const store = new WebSearchStore(dir, () => undefined)
  const providerChoices: string[] = []
  const deps: RouteDeps = {
    applyProviderChoice: (file) => { providerChoices.push(file.provider) },
    clearCache: () => undefined,
    isChainExhausted: () => false,
    probe: async () => ({ latencyMs: 12, resultCount: 3 }),
    resolveKey: () => undefined,
    seamAvailable: () => true,
    searchThroughSeam: async () => ({ provider: 'dsh-app', resultCount: 5, latencyMs: 7 }),
    upstreamStatus: () => ({ registered: true, usable: true }),
    ...overrides,
  }
  registerWebSearchRoutes(connectionFetch as never, store, deps)
  return {
    routes,
    store,
    providerChoices,
    call: async (path, init) => {
      const route = routes.get(path)
      assert.ok(route !== undefined, `no route registered for ${path}`)
      const response = await route.fetch(new Request(`dsh-app://app${path}`, init))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
  }
}

/** POST helper: JSON body with the content type the client sends. */
function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('web search route registration', () => {
  it('registers the four routes on the unscoped /api path with their own methods', () => {
    const { routes } = harness()
    // The Connection registry admits `[A-Za-z0-9_$.-]` only, so the npm scope
    // cannot appear in a path segment: the host half and the client must agree
    // on the unscoped spelling.
    assert.deepEqual([...routes.keys()].sort(), [
      `${ROUTE_PREFIX}/config`,
      `${ROUTE_PREFIX}/config/save`,
      `${ROUTE_PREFIX}/engine/test`,
      `${ROUTE_PREFIX}/selftest`,
    ])
    assert.equal(ROUTE_PREFIX, '/api/plugins/dsh-app/plugin-websearch')
    assert.ok(!ROUTE_PREFIX.includes('@'))
    assert.deepEqual(routes.get(`${ROUTE_PREFIX}/config`)?.methods, ['GET'])
    for (const path of [`${ROUTE_PREFIX}/config/save`, `${ROUTE_PREFIX}/engine/test`, `${ROUTE_PREFIX}/selftest`]) {
      assert.deepEqual(routes.get(path)?.methods, ['POST'])
    }
    // The carrier buffers the body before the route sees it.
    for (const route of routes.values()) assert.equal(route.requestBody, 'buffered')
  })

  it('answers GET /config with the masked view', async () => {
    const { call } = harness()
    const { status, body } = await call(`${ROUTE_PREFIX}/config`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const value = body.value as Record<string, unknown>
    assert.equal(value.seamAvailable, true)
    assert.equal(value.activeProvider, 'dsh-app')
    assert.equal((value.providers as unknown[]).length, 2)
    assert.equal((value.engines as unknown[]).length, 5)
  })

  it('persists a save, re-points the provider, and drops the result cache', async () => {
    const cleared: number[] = []
    const { call, store, providerChoices } = harness({ clearCache: () => { cleared.push(1) } })
    const { status, body } = await call(`${ROUTE_PREFIX}/config/save`, post({ provider: UPSTREAM_PROVIDER_ID, maxResults: 3 }))
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(store.load().provider, UPSTREAM_PROVIDER_ID)
    assert.equal(store.load().maxResults, 3)
    assert.deepEqual(providerChoices, [UPSTREAM_PROVIDER_ID])
    assert.equal(cleared.length, 1)
  })

  it('rejects an unparseable save body with a coded 400', async () => {
    const { call } = harness()
    const { status, body } = await call(`${ROUTE_PREFIX}/config/save`, post('{not json'))
    assert.equal(status, 400)
    const error = body.error as Record<string, unknown>
    assert.equal(error.code, 'bad-request')
    assert.equal((error.host as Record<string, unknown>).code, 'route.invalidBody')
  })

  it('refuses a body over the route cap with 413', async () => {
    const { call } = harness()
    const { status, body } = await call(`${ROUTE_PREFIX}/engine/test`, post(JSON.stringify({ query: 'x'.repeat(70_000) })))
    assert.equal(status, 413)
    const error = body.error as Record<string, unknown>
    assert.equal(error.code, 'payload-too-large')
    assert.equal((error.host as Record<string, unknown>).code, 'route.bodyTooLarge')
  })

  it('probes one named engine and reports its measurement', async () => {
    const probed: string[] = []
    const { call } = harness({
      probe: async (id) => {
        probed.push(id)
        return { latencyMs: 21, resultCount: 4 }
      },
    })
    const { status, body } = await call(`${ROUTE_PREFIX}/engine/test`, post({ id: 'bing', query: 'dsh' }))
    assert.equal(status, 200)
    const value = body.value as Record<string, unknown>
    assert.deepEqual(probed, ['bing'])
    assert.equal(value.query, 'dsh')
    const rows = value.results as Record<string, unknown>[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, 'bing')
    assert.equal(rows[0]?.ok, true)
    assert.equal(rows[0]?.latencyMs, 21)
    assert.equal(rows[0]?.resultCount, 4)
  })

  it('answers 400 when the named engine is not a testable one', async () => {
    const { call } = harness()
    const { status, body } = await call(`${ROUTE_PREFIX}/engine/test`, post({ id: 'nope' }))
    assert.equal(status, 400)
    assert.equal((body.error as Record<string, unknown>).code, 'bad-request')
  })

  it('reports a failing self-check as a 200 result, not a server error', async () => {
    const { call } = harness({
      isChainExhausted: () => true,
      searchThroughSeam: async () => { throw new Error('every engine failed') },
    })
    const { status, body } = await call(`${ROUTE_PREFIX}/selftest`, post({ query: 'dsh' }))
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const value = body.value as Record<string, unknown>
    assert.equal(value.chainExhausted, true)
    assert.equal((value.error as Record<string, unknown>).code, 'selftest.chainExhausted')
  })
})
