/**
 * Host-route contract tests for the sidebar dock's git face.
 *
 * The migration this file guards: the plugin no longer registers a prefix
 * route on the dsh web server (`/plugins/@dsh-app/plugin-sidebar/api`, gone
 * with the desktop host's disabled `webserver` row) but one EXACT Fetch route
 * per git path on the shared Connection `/api` channel. Captures the
 * registrations with a fake registry, so no HTTP server, no Electron and no
 * kernel composition are involved.
 *
 * @module plugin-sidebar/tests/routes
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ROUTE_PREFIX as CLIENT_PREFIX } from '../src/client/api.ts'
import { handleGitRequest, registerGitRoutes, ROUTE_PREFIX } from '../src/git-routes.ts'
import type { GitSessionScope } from '../src/git-routes.ts'

/** One captured registration: its exact path, methods and handler. */
interface Captured {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Capture every route one `registerGitRoutes` call contributes. */
function harness(scope: GitSessionScope): Map<string, Captured> {
  const routes = new Map<string, Captured>()
  const registry = {
    register(route: Captured) {
      routes.set(route.path, route)
      return Promise.resolve()
    },
  }
  registerGitRoutes(registry as never, scope)
  return routes
}

/** The session scope every request below is checked against. */
const scope: GitSessionScope = {
  cwdForSession: (sessionId: string) => (sessionId === 'live' ? 'D:\\repo' : undefined),
}

/** Call one captured route with a query string, the way the client does. */
async function call(
  routes: Map<string, Captured>,
  path: string,
  query = '',
  init?: RequestInit,
): Promise<{ status: number, body: { ok: boolean, value?: unknown, error?: { code: string, message: string, host?: { code: string } } } }> {
  const route = routes.get(path)
  assert.ok(route !== undefined, `no route registered at ${path}`)
  const response = await route.fetch(new Request(`dsh-app://app${path}${query}`, init))
  return { status: response.status, body: await response.json() as never }
}

describe('git route registration', () => {
  it('registers one exact route per git path under the Connection prefix', () => {
    const routes = harness(scope)
    assert.deepEqual([...routes.keys()].sort(), [
      `${ROUTE_PREFIX}/git/action`,
      `${ROUTE_PREFIX}/git/diff`,
      `${ROUTE_PREFIX}/git/log`,
      `${ROUTE_PREFIX}/git/ls`,
      `${ROUTE_PREFIX}/git/show`,
      `${ROUTE_PREFIX}/git/status`,
    ])
  })

  it('declares the methods the registry admits, and only those', () => {
    const routes = harness(scope)
    for (const [path, route] of routes) {
      assert.deepEqual(route.methods, path.endsWith('/action') ? ['POST'] : ['GET'], path)
      assert.equal(route.requestBody, 'buffered', path)
    }
  })

  it('carries no `@` in any path segment (the registry rejects it)', () => {
    for (const path of harness(scope).keys()) {
      for (const segment of path.split('/')) {
        assert.match(segment, /^[A-Za-z0-9_$.-]*$/u, `${path} segment ${segment}`)
      }
    }
  })

  it('serves nothing on the retired web-server prefix', () => {
    for (const path of harness(scope).keys()) {
      assert.ok(!path.startsWith('/plugins/'), path)
    }
  })

  it('keeps the client prefix and the host prefix identical', () => {
    assert.equal(CLIENT_PREFIX, ROUTE_PREFIX)
  })
})

describe('git route envelopes', () => {
  it('answers 400 when a GET carries no session id', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/status`, '?cwd=D%3A%5Crepo')
    assert.equal(answer.status, 400)
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.error?.code, 'bad-request')
  })

  it('answers 403 for a session the host does not have', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/log`, '?cwd=D%3A%5Crepo&sessionId=ghost')
    assert.equal(answer.status, 403)
    assert.equal(answer.body.error?.code, 'forbidden')
    assert.equal(answer.body.error?.host?.code, 'forbidden')
  })

  it('answers 403 when the requested cwd is not the session cwd', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/ls`, '?cwd=D%3A%5Cother&sessionId=live')
    assert.equal(answer.status, 403)
    assert.equal(answer.body.error?.code, 'forbidden')
  })

  it('rejects a POST action carrying a cwd outside the session', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/action`, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'branch.list', cwd: 'D:\\other', sessionId: 'live' }),
    })
    assert.equal(answer.status, 403)
    assert.equal(answer.body.error?.code, 'forbidden')
  })

  it('rejects an action with no op before touching git', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/action`, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'D:\\repo', sessionId: 'live' }),
    })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error?.code, 'bad-request')
  })
})

describe('git request dispatch', () => {
  it('answers an unknown route name with a 404 envelope', async () => {
    const response = await handleGitRequest('nope' as never, new Request(`dsh-app://app${ROUTE_PREFIX}/git/nope`), scope)
    assert.equal(response.status, 404)
    const body = await response.json() as { ok: boolean, error: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not-found')
  })
})
