/**
 * Route-layer contract of the usage plugin: every failure crosses as a stable
 * code plus an ENGLISH diagnostic, never as a Chinese sentence — the settings
 * page owns the copy, in whichever language is active (see `HostText` in
 * src/types.ts). Run via `npm test` (esbuild bundles TS → .test-dist, node
 * --test runs it).
 *
 * The transport under test is the Connection exact-Fetch registry, so a case
 * registers its routes into a fake registry and calls the captured Fetch
 * handler with a real `Request` — no HTTP server and no socket are involved.
 *
 * @module @dsh-app/plugin-usage/tests/routes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BalanceError, registerUsageRoutes, ROUTE_PREFIX, type UsageRoutesOptions } from '../src/routes.ts'

/** The Han range: a wire payload must never carry one — the client renders copy. */
const HAN = /[\u4e00-\u9fff]/

/** What one route answers: `status` 0 means nothing was written. */
interface Answer {
  readonly status: number
  readonly text: string
}

/** One registered exact route: the methods it owns and its Fetch handler. */
interface RegisteredRoute {
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** The body shape every route answers a failure with. */
interface FailureBody {
  readonly ok: boolean
  readonly error: {
    readonly code: string
    readonly message: string
    readonly host: { readonly code: string, readonly params?: Record<string, unknown>, readonly text: string }
  }
}

/**
 * Mount the routes over a fake exact-Fetch registry and return them per path.
 * The store is null on purpose: only summary/heatmap read it, and every case
 * here exercises a path that fails before the store matters.
 */
function mountRoutes(options: UsageRoutesOptions): Map<string, RegisteredRoute> {
  const routes = new Map<string, RegisteredRoute>()
  registerUsageRoutes({
    register: (route: { path: string, methods: readonly string[], fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, { methods: route.methods, fetch: route.fetch })
      return Promise.resolve()
    },
  } as never, null, options)
  return routes
}

/** One registered route, asserted present. */
function route(routes: Map<string, RegisteredRoute>, path: string): RegisteredRoute {
  const registered = routes.get(`${ROUTE_PREFIX}/${path}`)
  assert.ok(registered !== undefined, `the /${path} route must be registered`)
  return registered
}

/** One round trip through a captured Fetch handler. */
async function call(registered: RegisteredRoute, method: string, url = '/'): Promise<Answer> {
  const response = await registered.fetch(new Request(new URL(url, 'dsh-app://app'), { method }))
  return { status: response.status, text: await response.text() }
}

test('BalanceError: the wire form is a code, its params, and an English diagnostic', () => {
  const missing = new BalanceError('missing-credential', 'no DEEPSEEK_API_KEY credential is configured')
  assert.deepEqual(missing.hostText(), {
    code: 'missing-credential',
    text: 'no DEEPSEEK_API_KEY credential is configured',
  })

  const http = new BalanceError('upstream-http', 'the balance endpoint answered HTTP 429', { status: 429 })
  assert.deepEqual(http.hostText(), {
    code: 'upstream-http',
    params: { status: 429 },
    text: 'the balance endpoint answered HTTP 429',
  })

  // The point of the contract: no Chinese prose crosses to the client, and an
  // unknown code still has an English diagnostic to fall back to.
  for (const error of [missing, http]) {
    assert.ok(!HAN.test(JSON.stringify(error.hostText())), 'the wire form must contain no Han characters')
    assert.ok(error.hostText().text !== '', 'an unknown code needs the English fallback')
  }
})

test('GET /balance: the code decides the status, and the answer carries the coded message', async () => {
  const cases: Array<{ error: unknown, status: number, code: string, params?: Record<string, unknown> }> = [
    // Account-side problems answer 503; upstream trouble answers 502.
    { error: new BalanceError('missing-credential', 'no DEEPSEEK_API_KEY credential is configured'), status: 503, code: 'missing-credential' },
    { error: new BalanceError('invalid-credential', 'the DeepSeek API key was rejected (HTTP 401)'), status: 503, code: 'invalid-credential' },
    { error: new BalanceError('upstream-timeout', 'the balance request timed out'), status: 502, code: 'upstream-timeout' },
    { error: new BalanceError('upstream-network', 'the balance request failed: fetch failed'), status: 502, code: 'upstream-network' },
    { error: new BalanceError('upstream-http', 'the balance endpoint answered HTTP 429', { status: 429 }), status: 502, code: 'upstream-http', params: { status: 429 } },
    // An unexpected throw from the injected fetcher still answers a coded
    // message, with the thrown text as the diagnostic.
    { error: new Error('boom'), status: 502, code: 'upstream' },
  ]

  for (const item of cases) {
    const handlers = mountRoutes({ active: true, fetchBalance: () => Promise.reject(item.error) })
    const answer = await call(route(handlers, 'balance'), 'GET')
    assert.equal(answer.status, item.status, `${item.code} must answer ${item.status}`)
    const body = JSON.parse(answer.text) as FailureBody
    assert.equal(body.ok, false)
    assert.equal(body.error.host.code, item.code)
    assert.equal(body.error.message, body.error.host.text, 'the plain message stays the English diagnostic')
    if (item.params !== undefined) assert.deepEqual(body.error.host.params, item.params)
    assert.ok(!HAN.test(answer.text), `${item.code} must not answer with a Chinese sentence`)
  }
})

test('data routes answer the coded disabled message while the collector is off', async () => {
  const handlers = mountRoutes({ active: false })
  for (const path of ['summary', 'heatmap', 'balance']) {
    const answer = await call(route(handlers, path), 'GET')
    assert.equal(answer.status, 503, `/${path} must answer 503 while disabled`)
    const body = JSON.parse(answer.text) as FailureBody
    assert.equal(body.error.code, 'disabled')
    assert.equal(body.error.host.code, 'disabled')
    assert.equal(body.error.host.text, 'built-in usage collection is disabled in the plugin configuration')
    assert.ok(!HAN.test(answer.text), `/${path} must not answer with a Chinese sentence`)
  }
})

test('a route owns GET only: another method falls through to the shared channel', async () => {
  const routes = mountRoutes({ active: false })
  for (const path of ['status', 'summary', 'heatmap', 'balance']) {
    assert.deepEqual(route(routes, path).methods, ['GET'], `/${path} must own GET and nothing else`)
  }

  const statusAnswer = await call(route(routes, 'status'), 'GET')
  assert.equal(statusAnswer.status, 200)
  assert.deepEqual(JSON.parse(statusAnswer.text), { ok: true, value: { active: false, reason: 'disabled-by-user-config' } })
})
