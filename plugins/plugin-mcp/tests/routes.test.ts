/**
 * Routes-layer behavior tests: the exact-Fetch registration shape, the
 * request/reply behavior of every route over a captured registry, and the
 * secret mask/unmask round trip (literal values are never returned to the
 * client; a mask sentinel sent back keeps the stored value).
 *
 * The store under these routes is the `mcp-manager` row (see src/store.ts), so
 * "persisted" here means "in the config document", and the assertions read that
 * document rather than a file. The registry stand-in mirrors the carrier: a
 * request whose path is not registered, or whose method the route does not own,
 * falls through to the shared channel's 404.
 *
 * @module plugin-mcp/tests/routes
 */

import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import { maskSecretValues, registerMcpRoutes, ROUTE_PREFIX, unmaskSecretValues, VALUE_MASK } from '../src/routes.ts'
import { MANAGER_ROW_ID, McpStore, type ConfigEditorLike, type ConfigRow } from '../src/store.ts'
import { McpFleetStatus } from '../src/status.ts'
import { McpValidationError, type McpServerEntry } from '../src/wire.ts'

const STORED: McpServerEntry = {
  id: 'github',
  serverName: 'github',
  transport: 'stdio',
  enabled: true,
  command: 'npx',
  env: { GITHUB_TOKEN: 'gh_secret_value', HOME_REF: '$ENV:HOME' },
}

/** One route as the plugin registered it. */
interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** The captured registry plus the shared channel's own dispatch rule. */
interface Harness {
  readonly routes: readonly RegisteredRoute[]
  readonly get: (path: string) => Promise<Response>
  readonly post: (path: string, body: unknown) => Promise<Response>
  readonly dispose: () => Promise<void>
}

/** A config document in memory, shaped the way the kernel's editor reports it. */
function fakeEditor(initial: Record<string, unknown> = {}) {
  const document: Record<string, unknown> = { servers: initial }
  const row: ConfigRow = { options: { id: MANAGER_ROW_ID } }
  const editor: ConfigEditorLike = {
    entries: () => [row],
    configuration: () => [{ entry: row, inherited: {}, override: document }],
    edit: async (_entry, change) => {
      const next = change({ ...document }, {})
      for (const key of Object.keys(document)) Reflect.deleteProperty(document, key)
      Object.assign(document, next)
    },
  }
  return {
    editor,
    /** The stored servers, keyed by server name. */
    servers: () => (document.servers ?? {}) as Record<string, Record<string, unknown>>,
  }
}

function harness(store: McpStore): Harness {
  const routes: RegisteredRoute[] = []
  const fetchRegistry = {
    register(route: RegisteredRoute): () => Promise<void> {
      routes.push(route)
      return async () => undefined
    },
  }
  const status = new McpFleetStatus(undefined)
  const dispose = registerMcpRoutes(fetchRegistry as never, store, status)

  const dispatch = async (path: string, method: string, body?: unknown): Promise<Response> => {
    const route = routes.find(candidate => candidate.path === path)
    if (route === undefined || !route.methods.includes(method)) {
      return new Response('not found', { status: 404 })
    }
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    return await route.fetch(new Request(`dsh-app://app${path}`, init))
  }

  return {
    routes,
    get: (path: string) => dispatch(path, 'GET'),
    post: (path: string, body: unknown) => dispatch(path, 'POST', body),
    dispose,
  }
}

interface Envelope {
  ok: boolean
  value?: {
    enabled: boolean
    filePath: string
    mountAvailable: boolean
    servers: Array<{
      id: string
      serverName: string
      enabled: boolean
      env?: Record<string, string>
      status: { state: string }
    }>
    imported?: string[]
    failed?: Array<{ name: string, reason: { code: string } }>
  }
  error?: { code: string, message: string, host?: { code: string } }
}

async function envelope(response: Response): Promise<Envelope> {
  return await response.json() as Envelope
}

const okEnvelope = (response: Response): Promise<Envelope> => envelope(response)

describe('route registration', () => {
  const harnessed = harness(new McpStore(fakeEditor().editor, true, () => {}))

  it('registers the five routes under the Connection prefix, reads GET, writes POST', () => {
    assert.deepEqual(harnessed.routes.map(route => route.path).sort(), [
      `${ROUTE_PREFIX}/server/create`,
      `${ROUTE_PREFIX}/server/delete`,
      `${ROUTE_PREFIX}/server/import`,
      `${ROUTE_PREFIX}/server/update`,
      `${ROUTE_PREFIX}/servers`,
    ])
    for (const route of harnessed.routes) {
      assert.equal(route.requestBody, 'buffered')
      // The registry admits GET/HEAD/POST only: a PUT would never reach a
      // handler, so no route may declare one.
      assert.deepEqual([...route.methods].sort(), route.path.endsWith('/servers') ? ['GET'] : ['POST'])
    }
  })

  it('owns no path below the retired web-server prefix', async () => {
    const legacy = '/plugins/@dsh-app/plugin-mcp/api/servers'
    assert.equal(harnessed.routes.some(route => route.path === legacy), false)
    assert.equal((await harnessed.get(legacy)).status, 404)
  })

  it('answers 404 for a method the route does not own', async () => {
    assert.equal((await harnessed.get(`${ROUTE_PREFIX}/server/create`)).status, 404)
  })
})

describe('route behavior', () => {
  let fake: ReturnType<typeof fakeEditor>
  let store: McpStore
  let harnessed: Harness

  beforeEach(() => {
    fake = fakeEditor()
    store = new McpStore(fake.editor, true, () => {})
    harnessed = harness(store)
  })

  it('GET /servers reports the store location, the mount availability, and the masked entries', async () => {
    await store.create({ serverName: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'gh_secret_value', HOME_REF: '$ENV:HOME' } })
    const response = await harnessed.get(`${ROUTE_PREFIX}/servers`)
    assert.equal(response.status, 200)
    const body = await okEnvelope(response)
    assert.equal(body.ok, true)
    assert.equal(body.value?.enabled, true)
    assert.equal(body.value?.filePath, store.filePath)
    assert.equal(body.value?.mountAvailable, false)
    assert.equal(body.value?.servers.length, 1)
    const view = body.value?.servers[0]
    assert.equal(view?.env?.GITHUB_TOKEN, VALUE_MASK)
    assert.equal(view?.env?.HOME_REF, '$ENV:HOME')
    assert.equal(JSON.stringify(body.value).includes('gh_secret_value'), false)
    // No manager was mounted, so the entry reads as unavailable rather than
    // claiming its tools are live.
    assert.equal(view?.status.state, 'unavailable')
  })

  it('POST /server/create stores the literal value and answers the masked list', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/create`, {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      env: { GITHUB_TOKEN: 'gh_secret_value' },
    })
    assert.equal(response.status, 200)
    const body = await okEnvelope(response)
    assert.equal(body.value?.servers.length, 1)
    assert.equal(body.value?.servers[0]?.env?.GITHUB_TOKEN, VALUE_MASK)
    assert.equal(fake.servers().github?.env && (fake.servers().github!.env as Record<string, string>).GITHUB_TOKEN, 'gh_secret_value')
  })

  it('POST /server/create answers the coded validation failure for a bad entry', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/create`, { serverName: 'has space', transport: 'stdio' })
    assert.equal(response.status, 400)
    const body = await okEnvelope(response)
    assert.equal(body.ok, false)
    assert.equal(body.error?.code, 'bad-request')
    assert.equal(typeof body.error?.host?.code, 'string')
  })

  it('POST /server/update keeps the stored value behind a returned mask sentinel', async () => {
    const created = await store.create({ serverName: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'gh_secret_value' } })
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/update`, {
      ...created,
      enabled: false,
      env: { GITHUB_TOKEN: VALUE_MASK },
    })
    assert.equal(response.status, 200)
    const body = await okEnvelope(response)
    assert.equal(body.value?.servers[0]?.enabled, false)
    assert.equal((fake.servers().github!.env as Record<string, string>).GITHUB_TOKEN, 'gh_secret_value')
  })

  it('POST /server/update answers 404 for a name the document does not hold', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/update`, { id: 'ghost', serverName: 'ghost', transport: 'stdio', command: 'npx' })
    assert.equal(response.status, 404)
    const body = await okEnvelope(response)
    assert.equal(body.error?.host?.code, 'server.notFound')
  })

  it('POST /server/delete removes the entry and answers the remaining list', async () => {
    const created = await store.create({ serverName: 'github', transport: 'stdio', command: 'npx' })
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/delete`, { id: created.id })
    assert.equal(response.status, 200)
    const body = await okEnvelope(response)
    assert.deepEqual(body.value?.servers, [])
    assert.deepEqual(fake.servers(), {})
  })

  it('POST /server/import reports the per-server failures without failing the batch', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/import`, {
      json: JSON.stringify({ mcpServers: { good: { command: 'npx' }, 'bad name': { command: 'npx' }, broken: { transport: 'streamable-http' } } }),
    })
    assert.equal(response.status, 200)
    const body = await okEnvelope(response)
    assert.deepEqual(body.value?.imported, ['good', 'bad_name'])
    assert.equal(body.value?.failed?.length, 1)
    assert.equal(body.value?.failed?.[0]?.name, 'broken')
  })

  it('answers 409 for every write route while the master switch is off', async () => {
    const readOnly = fakeEditor()
    const disabledStore = new McpStore(readOnly.editor, false, () => {})
    const disabled = harness(disabledStore)
    try {
      for (const path of ['create', 'update', 'delete', 'import']) {
        const response = await disabled.post(`${ROUTE_PREFIX}/server/${path}`, { json: '{"mcpServers":{}}' })
        assert.equal(response.status, 409, `${path} must answer 409`)
        const body = await okEnvelope(response)
        assert.equal(body.error?.host?.code, 'route.disabled')
      }
      assert.equal((await disabled.get(`${ROUTE_PREFIX}/servers`)).status, 200)
    } finally {
      await disabled.dispose()
    }
  })

  it('answers a coded 400 when the body is not JSON', async () => {
    const route = harnessed.routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/server/create`)
    const response = await route!.fetch(new Request(`dsh-app://app${ROUTE_PREFIX}/server/create`, {
      method: 'POST',
      body: 'not json',
    }))
    assert.equal(response.status, 400)
    const body = await okEnvelope(response)
    assert.equal(body.error?.host?.code, 'route.invalidBody')
  })

  it('answers 413 when the body exceeds the route cap', async () => {
    const route = harnessed.routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/server/create`)
    const response = await route!.fetch(new Request(`dsh-app://app${ROUTE_PREFIX}/server/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: 'x'.repeat(70_000) }),
    }))
    assert.equal(response.status, 413)
    const body = await okEnvelope(response)
    assert.equal(body.error?.host?.code, 'route.bodyTooLarge')
  })
})

describe('secret masking round trip', () => {
  it('masks literal env values on read but keeps references verbatim', () => {
    const masked = maskSecretValues(STORED)
    assert.equal(masked.env?.GITHUB_TOKEN, VALUE_MASK)
    assert.equal(masked.env?.HOME_REF, '$ENV:HOME')
    assert.equal(masked.command, STORED.command)
  })

  it('keeps the manager credential template readable too', () => {
    const masked = maskSecretValues({ ...STORED, env: { TOKEN: '${credential:GH_TOKEN}' } })
    assert.equal(masked.env?.TOKEN, '${credential:GH_TOKEN}')
  })

  it('masks literal headers and keeps the URL untouched', () => {
    const entry: McpServerEntry = {
      id: 'web',
      serverName: 'web',
      transport: 'streamable-http',
      enabled: true,
      url: 'http://127.0.0.1:3000/mcp',
      headers: { Authorization: 'Bearer plain-secret' },
    }
    const masked = maskSecretValues(entry)
    assert.equal(masked.url, entry.url)
    assert.equal(masked.headers?.Authorization, VALUE_MASK)
  })

  it('restores stored values when the client sends the mask sentinel back', () => {
    const masked = maskSecretValues(STORED)
    const restored = unmaskSecretValues({ ...masked, enabled: true }, STORED)
    assert.equal((restored.env as Record<string, string>).GITHUB_TOKEN, 'gh_secret_value')
    assert.equal((restored.env as Record<string, string>).HOME_REF, '$ENV:HOME')
  })

  it('rejects a mask sentinel with no stored value behind it', () => {
    assert.throws(
      () => unmaskSecretValues({ env: { NEW_TOKEN: VALUE_MASK } }, undefined),
      (error: unknown) => error instanceof McpValidationError && error.code === 'secret.masked',
    )
    assert.throws(
      () => unmaskSecretValues({ env: { NEW_TOKEN: VALUE_MASK } }, undefined),
      (error: unknown) => error instanceof McpValidationError && error.params?.field === 'env.NEW_TOKEN',
    )
  })

  it('rejects a non-string value inside a secret map', () => {
    assert.throws(
      () => unmaskSecretValues({ env: { KEY: 42 } }, STORED),
      (error: unknown) => error instanceof McpValidationError && error.code === 'field.stringValue',
    )
  })

  it('passes through unmasked literal values unchanged', () => {
    const restored = unmaskSecretValues({ env: { KEY: 'plain' } }, undefined)
    assert.equal((restored.env as Record<string, string>).KEY, 'plain')
  })
})
