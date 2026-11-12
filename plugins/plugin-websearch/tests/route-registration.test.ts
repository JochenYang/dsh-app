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
import { UPSTREAM_PROVIDER_IDS } from '../src/wire.ts'

/** The DeepSeek routes `dsh-base` mounts; the page offers one card each. */
const [OFFICIAL_PROVIDER_ID, SEARCH_API_PROVIDER_ID] = UPSTREAM_PROVIDER_IDS

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
    applyProviderChoice: async (file) => { providerChoices.push(file.provider) },
    clearCache: () => undefined,
    isChainExhausted: () => false,
    probe: async () => ({ latencyMs: 12, resultCount: 3 }),
    resolveKeys: () => [],
    unresolvedKeys: () => 0,
    seamAvailable: () => true,
    searchThroughSeam: async () => ({ provider: 'dsh-app', resultCount: 5, latencyMs: 7 }),
    networkStatus: async () => ({ route: 'direct', resolver: 'system', verdict: 'clean', checkedAt: null }),
    fetchProbe: async () => ({ statusCode: 200, bytes: 1256, latencyMs: 42 }),
    // The settings page reads these two off the seam: the registry (what is
    // mounted) and the live configured id (which one answers). The harness
    // replaces them per test; the defaults describe a healthy kernel.
    providerAvailability: () => new Map([
      ['dsh-app', true],
      ['deepseek-official', true],
      ['deepseek-search-api', true],
    ]),
    activeProviderId: () => 'dsh-app',
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
    // Brand + both DeepSeek routes the kernel line mounts: the page must offer
    // every provider the model could resolve to, not a fixed pair.
    assert.equal((value.providers as unknown[]).length, 3)
    assert.equal((value.engines as unknown[]).length, 5)
  })

  it('persists a save, re-points the source, and drops the result cache', async () => {
    const cleared: number[] = []
    const { call, store, providerChoices } = harness({ clearCache: () => { cleared.push(1) } })
    const { status, body } = await call(`${ROUTE_PREFIX}/config/save`, post({ provider: OFFICIAL_PROVIDER_ID, maxResults: 3 }))
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(store.load().provider, OFFICIAL_PROVIDER_ID)
    assert.equal(store.load().maxResults, 3)
    assert.deepEqual(providerChoices, [OFFICIAL_PROVIDER_ID])
    assert.equal(cleared.length, 1)
  })

  it('accepts the Search API provider as a saved choice', async () => {
    // Before 0.2.1 the validator knew only `deepseek-official`, so picking the
    // line's new Search API card quietly persisted the brand id instead.
    const { call, store } = harness()
    const { status } = await call(`${ROUTE_PREFIX}/config/save`, post({ provider: SEARCH_API_PROVIDER_ID }))
    assert.equal(status, 200)
    assert.equal(store.load().provider, SEARCH_API_PROVIDER_ID)
  })

  it('reports a switch the host could not apply instead of acknowledging it', async () => {
    // The store write happens first; a switch that never took effect must not
    // come back as a plain success, or the page shows a source that is not the
    // one answering.
    const { call, store } = harness({
      applyProviderChoice: async () => { throw new Error('config editor refused the write') },
    })
    const { status, body } = await call(`${ROUTE_PREFIX}/config/save`, post({ provider: OFFICIAL_PROVIDER_ID }))
    assert.equal(status, 502)
    assert.equal(body.ok, false)
    const host = (body.error as Record<string, unknown>).host as Record<string, unknown>
    assert.equal(host.code, 'provider.switchFailed')
    assert.equal(store.load().provider, OFFICIAL_PROVIDER_ID)
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

  it('reports the fetch probe next to the search verdict', async () => {
    const { call } = harness()
    const { body } = await call(`${ROUTE_PREFIX}/selftest`, post({ query: 'dsh' }))
    const value = body.value as Record<string, unknown>
    const fetch = value.fetch as Record<string, unknown>
    assert.equal(fetch.ok, true)
    assert.equal(fetch.statusCode, 200)
    assert.equal(fetch.bytes, 1256)
    const network = value.network as Record<string, unknown>
    assert.equal(network.resolver, 'system')
  })

  it('reports a failing fetch probe as a coded result, still 200', async () => {
    const { call } = harness({
      fetchProbe: async () => { throw new Error('URL hostname resolves to a non-public IP address') },
    })
    const { status, body } = await call(`${ROUTE_PREFIX}/selftest`, post({ query: 'dsh' }))
    assert.equal(status, 200)
    const value = body.value as Record<string, unknown>
    const fetch = value.fetch as Record<string, unknown>
    assert.equal(fetch.ok, false)
    assert.equal((fetch.error as Record<string, unknown>).code, 'selftest.fetchFailed')
    // The search half still reports: a fetch failure must not swallow it.
    assert.equal((value.provider as string), 'dsh-app')
  })
})

describe('engine keys over the config route', () => {
  /** Resolve the stored list as the host would (no `$ENV:` in these cases). */
  const resolveKeys = (entry: { readonly apiKeys?: readonly string[] }): string[] => [...entry.apiKeys ?? []]
  /** A host whose keys never reference the environment. */
  const noEnvRefs = (): number => 0

  /** One save body carrying just the engines (everything else defaults). */
  const saveEngines = (engines: unknown[]): RequestInit => post({ engines })

  /** The `exa` row as the page receives it. */
  async function exaRow(call: Harness['call']): Promise<{ entry: { apiKeys?: string[] }, status: { keyCount?: number, keyState?: string } }> {
    const { body } = await call(`${ROUTE_PREFIX}/config`)
    const engines = (body.value as { engines: { id: string }[] }).engines
    return engines.find(engine => engine.id === 'exa') as never
  }

  it('masks a stored key and reports how many are configured', async () => {
    // The masking boundary and the count are two halves of one contract: the
    // value must not cross, and the page must still be able to say "two".
    const { call } = harness({ resolveKeys, unresolvedKeys: noEnvRefs })
    await call(`${ROUTE_PREFIX}/config/save`, saveEngines([{ id: 'exa', enabled: true, priority: 0, apiKeys: ['sk-one', 'sk-two'] }]))
    const row = await exaRow(call)
    // One placeholder per key, each naming its own value: the page needs a chip
    // per key to delete exactly that one, and the count is what the badge says.
    assert.equal(row.entry.apiKeys?.length, 2)
    for (const token of row.entry.apiKeys ?? []) assert.match(token, /^•+#[0-9a-f]{8}$/)
    assert.notEqual(row.entry.apiKeys?.[0], row.entry.apiKeys?.[1])
    assert.equal(row.status.keyCount, 2)
    assert.equal(row.status.keyState, 'configured')
  })

  it('keeps the stored list when the page sends the mask back', async () => {
    const { call, store } = harness({ resolveKeys, unresolvedKeys: noEnvRefs })
    await call(`${ROUTE_PREFIX}/config/save`, saveEngines([{ id: 'exa', enabled: true, priority: 0, apiKeys: ['sk-one'] }]))
    const row = await exaRow(call)
    // Exactly what the page posts back when the field was never touched.
    await call(`${ROUTE_PREFIX}/config/save`, saveEngines([{ id: 'exa', enabled: true, priority: 0, apiKeys: row.entry.apiKeys }]))
    assert.deepEqual(store.load().engines.find(entry => entry.id === 'exa')?.apiKeys, ['sk-one'])
  })

  it('refuses a malformed key with a coded 400 naming the engine', async () => {
    // Refused on the WRITE path so nothing is stored: a key with a space inside
    // it would authenticate as 401 with no way to tell it from a revoked one.
    const { call, store } = harness({ resolveKeys, unresolvedKeys: noEnvRefs })
    const { status, body } = await call(`${ROUTE_PREFIX}/config/save`, saveEngines([{ id: 'exa', enabled: true, priority: 0, apiKeys: ['sk a'] }]))
    assert.equal(status, 400)
    const host = (body.error as Record<string, unknown>).host as Record<string, unknown>
    assert.equal(host.code, 'engine.keyMalformed')
    assert.deepEqual(host.params, { id: 'exa' })
    assert.equal(store.load().engines.find(entry => entry.id === 'exa')?.apiKeys, undefined)
  })

  it('does not echo a secret when the body is not valid JSON', async () => {
    // JSON.parse's own message quotes a slice of the input, and the input now
    // carries literal API keys.
    const { call } = harness({ resolveKeys, unresolvedKeys: noEnvRefs })
    const { status, body } = await call(
      `${ROUTE_PREFIX}/config/save`,
      post('{"engines":[{"id":"exa","apiKeys":["sk-do-not-echo"]'),
    )
    assert.equal(status, 400)
    assert.equal(JSON.stringify(body).includes('sk-do-not-echo'), false)
    assert.equal((body.error as Record<string, unknown>).host instanceof Object, true)
  })
})

describe('key count and the mask, end to end', () => {
  const resolveKeys = (entry: { readonly apiKeys?: readonly string[] }): string[] => [...entry.apiKeys ?? []]
  const noEnvRefs = (): number => 0

  /** Store a config, then read the `exa` row back the way the page sees it. */
  async function roundTrip(call: Harness['call'], apiKeys?: readonly string[]): Promise<{ entry: { apiKeys?: string[] }, status: { keyCount?: number, keyState?: string } }> {
    await call(`${ROUTE_PREFIX}/config/save`, post({ engines: [{ id: 'exa', enabled: true, priority: 0, ...apiKeys === undefined ? {} : { apiKeys } }] }))
    const { body } = await call(`${ROUTE_PREFIX}/config`)
    return ((body.value as { engines: { id: string }[] }).engines.find(engine => engine.id === 'exa')) as never
  }

  it('refuses an eleventh key even when it arrives beside the mask', async () => {
    // The mask expands AFTER the raw body is read, so a cap checked on the raw
    // body would count "mask + typed key" as two and let the eleventh through
    // to be silently dropped by the clamp — a green save that lost a key.
    const { call, store } = harness({ resolveKeys, unresolvedKeys: noEnvRefs })
    const ten = Array.from({ length: 10 }, (_, index) => `sk-${index}`)
    const row = await roundTrip(call, ten)
    const { status, body } = await call(`${ROUTE_PREFIX}/config/save`, post({
      engines: [{ id: 'exa', enabled: true, priority: 0, apiKeys: [...row.entry.apiKeys ?? [], 'sk-eleven'] }],
    }))
    assert.equal(status, 400)
    const host = (body.error as Record<string, unknown>).host as Record<string, unknown>
    assert.equal(host.code, 'engine.keyTooMany')
    assert.equal(store.load().engines.find(entry => entry.id === 'exa')?.apiKeys?.length, 10)
    assert.equal(row.entry.apiKeys?.length, 10, 'ten chips, one per stored key')
  })

  it('clears the stored keys when the field is emptied', async () => {
    // The copy says an empty field clears the keys, so this is deliberate — and
    // it must clear, not keep, or the sentence would be a lie.
    const { call, store } = harness({ resolveKeys, unresolvedKeys: noEnvRefs })
    await roundTrip(call, ['sk-one'])
    await roundTrip(call, [])
    assert.equal(store.load().engines.find(entry => entry.id === 'exa')?.apiKeys, undefined)
  })

  it('reports an unset $ENV reference instead of a bare ready badge', async () => {
    // The ONE case where the stored value is visible on the page but no key is
    // in use: dropping the reference is right (resolveKeys cannot use it) but
    // silence would make the page claim a key is configured.
    const { call } = harness({
      resolveKeys: () => [],
      unresolvedKeys: (entry: { readonly apiKeys?: readonly string[] }) => entry.apiKeys?.length ?? 0,
    })
    const row = await roundTrip(call, ['$ENV:NOT_SET_FOR_THIS_TEST'])
    assert.equal(row.status.keyCount, 0)
    assert.equal(row.status.keyState, 'none')
    assert.equal(row.status.keyUnresolved, 1)
  })
})
