/**
 * Route contract for the code-graph settings surface: the envelope shape, the
 * reindex fence, and the language-install rejections.
 *
 * The load-bearing assertions are the ones a silent bug would hide. Every route
 * answers the suite's `{ ok, value }` / `{ ok:false, error:{ code, host } }`
 * envelope with a coded `host.code` the CLIENT maps to its dictionary — matching
 * on prose across the boundary once misread one failure as another. And the
 * `reindex` action must refuse any path it was not already opened on: a route
 * that indexed a caller-named directory would let a request choose what the
 * process reads, the exact shape this plugin's own storage-path rule forbids.
 *
 * @module plugin-codegraph/tests/routes
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  ROUTE_PREFIX,
  registerCodegraphRoutes,
  type CodegraphRoutesOptions,
} from '../src/routes.ts'
import type { ProjectStatus } from '../src/queue.ts'

const created: string[] = []

after(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

type FetchHandler = (request: Request) => Promise<Response>

/** One captured exact-Fetch route. */
interface CapturedRoute {
  readonly methods: readonly string[]
  readonly fetch: FetchHandler
}

/** A grammar directory holding the named wasm files, so install state is real. */
function grammarFixture(installed: readonly string[]): CodegraphRoutesOptions['grammarPaths'] {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cg-routes-'))
  created.push(dir)
  const bundledDir = join(dir, 'bundled')
  const downloadDir = join(dir, 'download')
  mkdirSync(bundledDir, { recursive: true })
  mkdirSync(downloadDir, { recursive: true })
  // A bundled grammar: whatever the table marks bundled, place its file here.
  for (const name of installed) {
    const target = name.startsWith('download:')
      ? join(downloadDir, name.slice('download:'.length))
      : join(bundledDir, name)
    writeFileSync(target, 'wasm')
  }
  return () => ({ bundledDir, downloadDir })
}

/** A status row with the defaults a settled project has. */
function status(cwd: string, over: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    cwd,
    name: cwd.split(/[\\/]/u).pop() ?? cwd,
    state: 'current',
    indexedAt: 1,
    lastOutcome: undefined,
    failure: undefined,
    queued: false,
    ...over,
  }
}

/** Capture the registered routes, keyed by path. */
function harness(options: CodegraphRoutesOptions) {
  const routes = new Map<string, CapturedRoute>()
  const connectionFetch = {
    register(route: ConnectionFetchRoute): () => Promise<void> {
      routes.set(route.path, { methods: route.methods, fetch: route.fetch })
      return async () => { routes.delete(route.path) }
    },
  }
  const dispose = registerCodegraphRoutes(connectionFetch, options)
  return { routes, dispose }
}

/** A JSON request against the plugin's namespace. */
function post(body: unknown): Request {
  return new Request(`dsh-app://app${ROUTE_PREFIX}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function call(route: CapturedRoute, req: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route.fetch(req)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** The options the routes read, with the write-side actions recorded. */
function options(over: Partial<CodegraphRoutesOptions> = {}): CodegraphRoutesOptions & { actions: string[] } {
  const actions: string[] = []
  return {
    actions,
    statuses: () => [status('D:/codes/a')],
    grammarPaths: grammarFixture([]),
    installLanguage: async (id) => { actions.push(`install:${id}`) },
    removeLanguage: async (id) => { actions.push(`remove:${id}`) },
    reindex: async (cwd) => { actions.push(`reindex:${cwd}`) },
    ...over,
  }
}

describe('route registration', () => {
  it('registers the three routes under the plugin prefix with the admitted methods', async () => {
    const { routes, dispose } = harness(options())
    assert.deepEqual([...routes.keys()].sort(), [
      `${ROUTE_PREFIX}/action`,
      `${ROUTE_PREFIX}/languages`,
      `${ROUTE_PREFIX}/status`,
    ])
    assert.deepEqual([...routes.get(`${ROUTE_PREFIX}/status`)!.methods], ['GET'])
    assert.deepEqual([...routes.get(`${ROUTE_PREFIX}/action`)!.methods], ['POST'])
    // No `@` in any segment (the registry rejects it), and the shared prefix is
    // the suite's own `/api/plugins/dsh-app/<plugin>` shape.
    assert.ok(ROUTE_PREFIX.startsWith('/api/plugins/dsh-app/codegraph'))
    for (const path of routes.keys()) assert.ok(!path.includes('@'))
    await dispose()
    assert.equal(routes.size, 0, 'the disposer removes every route')
  })
})

describe('GET /status', () => {
  it('answers the ok envelope with projects newest first', async () => {
    const opts = options({ statuses: () => [status('D:/a', { indexedAt: 1 }), status('D:/b', { indexedAt: 9 })] })
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/status`)!, new Request('dsh-app://app/x'))
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
    const value = reply.body.value as { projects: { cwd: string }[] }
    assert.deepEqual(value.projects.map(p => p.cwd), ['D:/b', 'D:/a'], 'sorted by indexedAt desc')
    // The status answer carries the projects and nothing else: a `storageRoot`
    // field used to ride along and reached the browser while nothing read it —
    // a local path in the page for no benefit.
    assert.deepEqual(Object.keys(value).sort(), ['projects'])
    await dispose()
  })
})

describe('GET /languages', () => {
  it('reports each language installed only when its grammar file is present', async () => {
    const opts = options({ grammarPaths: grammarFixture(['tree-sitter-typescript.wasm']) })
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/languages`)!, new Request('dsh-app://app/x'))
    const { languages } = reply.body.value as { languages: { id: string, installed: boolean, supported: boolean }[] }
    const ts = languages.find(language => language.id === 'typescript')
    assert.equal(ts?.installed, true)
    assert.equal(ts?.supported, true, 'typescript has extraction rules')
    const ruby = languages.find(language => language.id === 'ruby')
    assert.equal(ruby?.installed, false, 'ruby grammar not present')
    await dispose()
  })

  it('marks an installed grammar with no extraction shape as unsupported', async () => {
    // "Installed" and "indexable" are different claims; conflating them tells the
    // user a language works when it parses to nothing.
    const opts = options({ grammarPaths: grammarFixture(['download:tree-sitter-ruby.wasm']) })
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/languages`)!, new Request('dsh-app://app/x'))
    const { languages } = reply.body.value as { languages: { id: string, installed: boolean, supported: boolean }[] }
    const ruby = languages.find(language => language.id === 'ruby')
    assert.equal(ruby?.installed, true)
    assert.equal(ruby?.supported, false, 'ruby has a grammar but no shape in this plugin')
    await dispose()
  })
})

describe('POST /action', () => {
  it('installs a non-bundled language through the injected action', async () => {
    const opts = options()
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/action`)!, post({ action: 'install', id: 'ruby' }))
    assert.equal(reply.status, 200)
    assert.deepEqual(opts.actions, ['install:ruby'])
    await dispose()
  })

  it('refuses to install or remove a BUNDLED grammar (409)', async () => {
    const opts = options()
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/action`)!, post({ action: 'remove', id: 'typescript' }))
    assert.equal(reply.status, 409)
    assert.deepEqual(opts.actions, [], 'a bundled grammar is never touched')
    const host = (reply.body.error as { host: { code: string } }).host
    assert.equal(host.code, 'route.bundledLanguage')
    await dispose()
  })

  it('refuses an unknown language id with a coded host message', async () => {
    const { routes, dispose } = harness(options())
    const reply = await call(routes.get(`${ROUTE_PREFIX}/action`)!, post({ action: 'install', id: 'cobol' }))
    assert.equal(reply.status, 404)
    assert.equal((reply.body.error as { host: { code: string } }).host.code, 'route.unknownLanguage')
    await dispose()
  })

  it('refuses a reindex for a path the queue never opened', async () => {
    // The fence: `reindex` may only act on a project already known to the queue.
    // A route that indexed any caller-named directory would let a request choose
    // what the process reads.
    const opts = options()
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/action`)!, post({ action: 'reindex', cwd: 'D:/somewhere/else' }))
    assert.equal(reply.status, 404)
    assert.equal((reply.body.error as { host: { code: string } }).host.code, 'route.unknownProject')
    assert.deepEqual(opts.actions, [], 'nothing was indexed')
    await dispose()
  })

  it('reindexes a known project', async () => {
    const opts = options()
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/action`)!, post({ action: 'reindex', cwd: 'D:/codes/a' }))
    assert.equal(reply.status, 200)
    assert.deepEqual(opts.actions, ['reindex:D:/codes/a'])
    await dispose()
  })

  it('refuses an action with no required field, and an unknown action', async () => {
    const { routes, dispose } = harness(options())
    const route = routes.get(`${ROUTE_PREFIX}/action`)!
    assert.equal((await call(route, post({ action: 'reindex' }))).status, 400)
    assert.equal((await call(route, post({ action: 'frobnicate' }))).status, 400)
    await dispose()
  })

  it('surfaces an install failure as a coded 500, not a thrown error', async () => {
    const opts = options({ installLanguage: async () => { throw new Error('network down') } })
    const { routes, dispose } = harness(opts)
    const reply = await call(routes.get(`${ROUTE_PREFIX}/action`)!, post({ action: 'install', id: 'ruby' }))
    assert.equal(reply.status, 500)
    const error = reply.body.error as { code: string, host: { code: string, params?: Record<string, unknown> } }
    assert.equal(error.code, 'action-failed')
    assert.equal(error.host.code, 'route.actionFailed')
    assert.equal(error.host.params?.detail, 'network down', 'the original cause is preserved as a param')
    await dispose()
  })
})
