/**
 * Routes-layer behavior tests: the exact-Fetch registration shape, the
 * request/reply behavior of every route over a captured registry, and the
 * secret mask/unmask round trip (literal values are never returned to the
 * client; a mask sentinel sent back keeps the stored value).
 *
 * The registry stand-in mirrors the carrier: a request whose path is not
 * registered, or whose method the route does not own, falls through to the
 * shared channel's 404 (`HostConnectionService.createSharedFetchHandler`).
 *
 * @module plugin-mcp/tests/routes
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { McpMountManager } from '../src/mount.ts'
import { maskSecretValues, registerMcpRoutes, ROUTE_PREFIX, unmaskSecretValues, VALUE_MASK } from '../src/routes.ts'
import { McpStore, McpValidationError } from '../src/store.ts'
import type { McpServerEntry } from '../src/wire.ts'

const STORED: McpServerEntry = {
  id: 'mcp-1',
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

function harness(store: McpStore): Harness {
  const routes: RegisteredRoute[] = []
  const fetchRegistry = {
    register(route: RegisteredRoute): () => Promise<void> {
      routes.push(route)
      return async () => undefined
    },
  }
  const manager = new McpMountManager(() => {}, undefined, undefined)
  const dispose = registerMcpRoutes(fetchRegistry as never, store, manager)

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
  readonly ok: boolean
  readonly value?: {
    readonly enabled: boolean
    readonly filePath: string
    readonly mountAvailable: boolean
    readonly servers: readonly McpServerEntry[]
    readonly imported?: readonly string[]
    readonly failed?: readonly { readonly name: string, readonly reason: { readonly code: string } }[]
  }
  readonly error?: { readonly code: string, readonly host?: { readonly code: string } }
}

async function envelope(response: Response): Promise<Envelope> {
  return await response.json() as Envelope
}

describe('route registration', () => {
  let dir: string
  let harnessed: Harness

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-routes-'))
    harnessed = harness(new McpStore(dir, () => {}))
  })

  afterEach(async () => {
    await harnessed.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

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
  let dir: string
  let store: McpStore
  let harnessed: Harness

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-routes-'))
    store = new McpStore(dir, () => {})
    harnessed = harness(store)
  })

  afterEach(async () => {
    await harnessed.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET /servers reports the file, the mount availability, and the masked entries', async () => {
    store.save({ version: 1, enabled: true, servers: [STORED] })
    const response = await harnessed.get(`${ROUTE_PREFIX}/servers`)
    assert.equal(response.status, 200)
    const body = await envelope(response)
    assert.equal(body.ok, true)
    assert.equal(body.value?.enabled, true)
    assert.equal(body.value?.filePath, store.filePath)
    assert.equal(body.value?.mountAvailable, false)
    assert.equal(body.value?.servers.length, 1)
    const view = body.value?.servers[0]
    assert.equal(view?.env?.GITHUB_TOKEN, VALUE_MASK)
    assert.equal(view?.env?.HOME_REF, '$ENV:HOME')
    assert.equal(JSON.stringify(body.value).includes('gh_secret_value'), false)
  })

  it('POST /server/create persists the literal value and answers the masked list', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/create`, {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      env: { GITHUB_TOKEN: 'gh_secret_value' },
    })
    assert.equal(response.status, 200)
    const body = await envelope(response)
    assert.equal(body.value?.servers.length, 1)
    assert.equal(body.value?.servers[0]?.env?.GITHUB_TOKEN, VALUE_MASK)
    const onDisk = JSON.parse(readFileSync(store.filePath, 'utf8')) as { servers: McpServerEntry[] }
    assert.equal(onDisk.servers[0]?.env?.GITHUB_TOKEN, 'gh_secret_value')
  })

  it('POST /server/create answers the coded validation failure for a bad entry', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/create`, { serverName: 'has space', transport: 'stdio' })
    assert.equal(response.status, 400)
    const body = await envelope(response)
    assert.equal(body.ok, false)
    assert.equal(body.error?.code, 'bad-request')
    assert.equal(typeof body.error?.host?.code, 'string')
  })

  it('POST /server/update keeps the stored value behind a returned mask sentinel', async () => {
    const created = store.create({ serverName: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'gh_secret_value' } })
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/update`, {
      ...created,
      enabled: false,
      env: { GITHUB_TOKEN: VALUE_MASK },
    })
    assert.equal(response.status, 200)
    const body = await envelope(response)
    assert.equal(body.value?.servers[0]?.enabled, false)
    const onDisk = JSON.parse(readFileSync(store.filePath, 'utf8')) as { servers: McpServerEntry[] }
    assert.equal(onDisk.servers[0]?.env?.GITHUB_TOKEN, 'gh_secret_value')
  })

  it('POST /server/update answers 404 for an id this file does not hold', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/update`, { id: 'mcp-404', serverName: 'github', transport: 'stdio', command: 'npx' })
    assert.equal(response.status, 404)
    const body = await envelope(response)
    assert.equal(body.error?.host?.code, 'server.notFound')
  })

  it('POST /server/delete removes the entry and answers the remaining list', async () => {
    const created = store.create({ serverName: 'github', transport: 'stdio', command: 'npx' })
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/delete`, { id: created.id })
    assert.equal(response.status, 200)
    const body = await envelope(response)
    assert.deepEqual(body.value?.servers, [])
  })

  it('POST /server/import reports the per-server failures without failing the batch', async () => {
    const response = await harnessed.post(`${ROUTE_PREFIX}/server/import`, {
      json: JSON.stringify({ mcpServers: { good: { command: 'npx' }, 'bad name': { command: 'npx' }, broken: { transport: 'streamable-http' } } }),
    })
    assert.equal(response.status, 200)
    const body = await envelope(response)
    assert.deepEqual(body.value?.imported, ['good', 'bad_name'])
    assert.equal(body.value?.failed?.length, 1)
    assert.equal(body.value?.failed?.[0]?.name, 'broken')
  })

  it('answers 409 for every write route while the master switch is off', async () => {
    store.save({ version: 1, enabled: false, servers: [] })
    for (const path of ['create', 'update', 'delete', 'import']) {
      const response = await harnessed.post(`${ROUTE_PREFIX}/server/${path}`, { json: '{"mcpServers":{}}' })
      assert.equal(response.status, 409, `${path} must answer 409`)
      const body = await envelope(response)
      assert.equal(body.error?.host?.code, 'route.disabled')
    }
    assert.equal((await harnessed.get(`${ROUTE_PREFIX}/servers`)).status, 200)
  })

  it('answers a coded 400 when the body is not JSON', async () => {
    const route = harnessed.routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/server/create`)
    const response = await route!.fetch(new Request(`dsh-app://app${ROUTE_PREFIX}/server/create`, {
      method: 'POST',
      body: 'not json',
    }))
    assert.equal(response.status, 400)
    const body = await envelope(response)
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
    const body = await envelope(response)
    assert.equal(body.error?.host?.code, 'route.bodyTooLarge')
  })
})

describe('secret masking round trip', () => {
  it('masks literal env values on read but keeps $ENV: references verbatim', () => {
    const masked = maskSecretValues(STORED)
    assert.equal(masked.env?.GITHUB_TOKEN, VALUE_MASK)
    assert.equal(masked.env?.HOME_REF, '$ENV:HOME')
    assert.equal(masked.command, STORED.command)
  })

  it('masks literal headers and keeps the URL untouched', () => {
    const entry: McpServerEntry = {
      id: 'mcp-2',
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
