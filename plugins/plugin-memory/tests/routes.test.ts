/**
 * Transport contract tests for the settings routes: the exact-Fetch
 * registration shape (one path, its own methods, buffered bodies) and the wire
 * envelope of a read route. No HTTP server and no web server are involved — the
 * Connection registry hands a handler a Fetch request and takes back a Response,
 * which is exactly what these drive.
 *
 * @module @dsh-app/plugin-memory/tests/routes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot } from '../src/memory-store.ts'
import { registerMemoryRoutes, ROUTE_PREFIX } from '../src/routes.ts'

/** One route as the fake Connection registry records it. */
interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Register the settings routes over a throwaway root. */
function register(): { readonly routes: RegisteredRoute[], readonly dispose: () => Promise<void> } {
  const routes: RegisteredRoute[] = []
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-routes-'))))
  return { routes, dispose }
}

test('every settings route owns one exact path, its own methods, and a buffered body', () => {
  const { routes, dispose } = register()

  assert.deepEqual(routes.map(route => route.path), [
    `${ROUTE_PREFIX}/status`,
    `${ROUTE_PREFIX}/config`,
    `${ROUTE_PREFIX}/clear`,
    `${ROUTE_PREFIX}/entries`,
    `${ROUTE_PREFIX}/pin`,
    `${ROUTE_PREFIX}/forget`,
    `${ROUTE_PREFIX}/llm-audit`,
  ])
  assert.deepEqual(routes.map(route => route.methods), [
    ['GET'], ['POST'], ['POST'], ['GET'], ['POST'], ['POST'], ['GET'],
  ])
  // The carrier buffers the body under its own cap, so a handler always reads a
  // complete request (and applies its own, smaller limit on top).
  assert.deepEqual([...new Set(routes.map(route => route.requestBody))], ['buffered'])
  void dispose()
})

test('the route prefix stays inside the Connection segment grammar', () => {
  // An `@` — the npm scope — is not an allowed segment character: the registry
  // refuses such a path at registration, taking the plugin's whole route set
  // with it. The scope therefore travels as `dsh-app`.
  assert.equal(ROUTE_PREFIX, '/api/plugins/dsh-app/plugin-memory')
  assert.ok(!ROUTE_PREFIX.includes('@'))
  for (const segment of ROUTE_PREFIX.split('/').filter(part => part !== '')) {
    assert.match(segment, /^[A-Za-z0-9_$.-]+$/u)
  }
  // Path parameters ride the query string: every segment is fixed text.
  assert.ok(!ROUTE_PREFIX.includes(':') && !ROUTE_PREFIX.includes('?'))
})

test('GET /status answers the envelope the settings page reads', async () => {
  const { routes, dispose } = register()
  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/status`)
  assert.ok(route !== undefined)

  const response = await route.fetch(new Request(`https://localhost${route.path}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  const body = await response.json() as { ok: boolean, value: Record<string, unknown> }
  assert.equal(body.ok, true)
  // Bodies stay out of the status payload; the entries route serves them.
  assert.deepEqual(Object.keys(body.value).sort(), [
    'activity', 'cards', 'distill', 'enabled', 'globalList', 'projects', 'sizeBytes', 'storePath',
  ])
  void dispose()
})
