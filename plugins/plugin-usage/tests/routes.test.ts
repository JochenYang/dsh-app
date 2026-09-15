/**
 * Route-layer contract of the usage plugin: every failure crosses as a stable
 * code plus an ENGLISH diagnostic, never as a Chinese sentence — the settings
 * page owns the copy, in whichever language is active (see `HostText` in
 * src/types.ts). Run via `npm test` (esbuild bundles TS → .test-dist, node
 * --test runs it).
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
 * Mount the routes over a fake web server and return the handler per path.
 * The store is null on purpose: only summary/heatmap read it, and every case
 * here exercises a path that fails before the store matters.
 */
function mountRoutes(options: UsageRoutesOptions): Map<string, (req: unknown, res: unknown) => void> {
  const handlers = new Map<string, (req: unknown, res: unknown) => void>()
  registerUsageRoutes({
    register: (route: { path: string, handler: (req: never, res: never) => void }) => {
      handlers.set(route.path, route.handler as unknown as (req: unknown, res: unknown) => void)
      return () => {}
    },
  }, null, options)
  return handlers
}

/** One registered route handler, asserted present. */
function route(handlers: Map<string, (req: unknown, res: unknown) => void>, path: string): (req: unknown, res: unknown) => void {
  const handler = handlers.get(`${ROUTE_PREFIX}/${path}`)
  assert.ok(handler !== undefined, `the /${path} route must be registered`)
  return handler
}

/** One GET round trip; the handler answers from a promise chain. */
async function call(handler: (req: unknown, res: unknown) => void, method: string): Promise<Answer> {
  const req = {
    method,
    url: '/',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
  }
  const res = {
    status: 0,
    body: '',
    setHeader: (_name: string, _value: string): void => {},
    writeHead(status: number): void { res.status = status },
    end(chunk: string): void { res.body = String(chunk) },
  }
  handler(req, res)
  // Every handler is synchronous or settles within one macrotask (no upstream
  // call is made here: the fetchers reject immediately).
  await new Promise(resolve => setTimeout(resolve, 0))
  return { status: res.status, text: res.body }
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
    assert.equal(body.error.host.text, 'built-in usage collection is disabled by the user config file')
    assert.ok(!HAN.test(answer.text), `/${path} must not answer with a Chinese sentence`)
  }
})

test('a non-GET request is refused with a coded method-not-allowed answer', async () => {
  const handlers = mountRoutes({ active: false })

  const statusAnswer = await call(route(handlers, 'status'), 'GET')
  assert.equal(statusAnswer.status, 200)
  assert.deepEqual(JSON.parse(statusAnswer.text), { ok: true, value: { active: false, reason: 'disabled-by-user-config' } })

  const refused = await call(route(handlers, 'status'), 'POST')
  assert.equal(refused.status, 405)
  const body = JSON.parse(refused.text) as FailureBody
  assert.equal(body.error.host.code, 'method-not-allowed')
  assert.deepEqual(body.error.host.params, { method: 'GET' })
})
