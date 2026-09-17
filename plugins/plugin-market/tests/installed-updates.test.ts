/**
 * GET /installed two-phase contract tests. The default answer is the local
 * facts alone and must never touch the registry prober; `?updates=1` opts
 * into the probe and layers latest/updateAvailable onto the same response
 * shape. Uses a captured Connection exact-Fetch route + injected prober, so no
 * network and no HTTP server are involved.
 *
 * @module plugin-market/tests/installed-updates
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { PluginInstaller } from '../src/installer.ts'
import { registerMarketRoutes, ROUTE_PREFIX, wantsUpdates, type MarketDeps } from '../src/routes.ts'

/** The captured /installed route and the payload it last answered. */
interface Harness {
  readonly get: (url: string) => Promise<{ status: number, body: { ok: boolean, value?: Record<string, unknown> } }>
  readonly probeCalls: Array<readonly string[]>
}

function harness(probe: (names: readonly string[]) => Promise<Record<string, string | undefined>>): Harness {
  let installedFetch: ((request: Request) => Promise<Response>) | undefined
  const connectionFetch = {
    register(route: { path: string, fetch: (request: Request) => Promise<Response> }) {
      if (route.path === `${ROUTE_PREFIX}/installed`) installedFetch = route.fetch
      return Promise.resolve()
    },
  }
  const probeCalls: Array<readonly string[]> = []
  const deps: MarketDeps = {
    sourcesPath: join(tmpdir(), 'unused-sources.json'),
    catalogCachePath: join(tmpdir(), 'unused-catalog-cache.json'),
    installer: {} as PluginInstaller,
    profile: 'web',
    legacyProfile: 'web',
    latestVersions: (names) => {
      probeCalls.push([...names])
      return probe(names)
    },
  }
  registerMarketRoutes(connectionFetch as never, deps, () => undefined)

  return {
    probeCalls,
    get: async (url: string) => {
      const response = await installedFetch!(new Request(`dsh-app://app${url}`))
      return { status: response.status, body: await response.json() as { ok: boolean, value?: Record<string, unknown> } }
    },
  }
}

describe('wantsUpdates', () => {
  it('opts in only for updates=1', () => {
    assert.equal(wantsUpdates(undefined), false)
    assert.equal(wantsUpdates(''), false)
    assert.equal(wantsUpdates(`${ROUTE_PREFIX}/installed`), false)
    assert.equal(wantsUpdates(`${ROUTE_PREFIX}/installed?updates=0`), false)
    assert.equal(wantsUpdates(`${ROUTE_PREFIX}/installed?refresh=1`), false)
    assert.equal(wantsUpdates(`${ROUTE_PREFIX}/installed?updates=1`), true)
  })
})

describe('GET /installed (local facts first)', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-market-installed-updates-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(join(profileDir, 'node_modules', 'pkg-a'), { recursive: true })
    mkdirSync(join(profileDir, 'node_modules', 'dsh-local'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        'pkg-a': '^1.0.0',
        '@dsh-app/plugin-market': '0.1.0',
        'dsh-local': 'file:../dsh-local',
      },
    }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-local', 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0' }), 'utf8')
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const noProbe: (names: readonly string[]) => Promise<Record<string, string | undefined>> =
    () => Promise.reject(new Error('the prober must not run without updates=1'))

  it('never calls the registry prober and answers the local view', async () => {
    const market = harness(noProbe)
    const { status, body } = await market.get(`${ROUTE_PREFIX}/installed`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(market.probeCalls.length, 0)
    const value = body.value!
    assert.equal(value.profile, 'web')
    assert.equal(value.manifestAvailable, true)
    const packages = value.packages as Array<Record<string, unknown>>
    assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['@dsh-app/plugin-market', 'dsh-local', 'pkg-a'])
    // The response shape is the local one: no update fields on any row.
    for (const pkg of packages) {
      assert.equal(Object.hasOwn(pkg, 'latest'), false)
      assert.equal(Object.hasOwn(pkg, 'updateAvailable'), false)
    }
  })

  it('treats an explicit updates=0 like the default (no prober)', async () => {
    const market = harness(noProbe)
    const { body } = await market.get(`${ROUTE_PREFIX}/installed?updates=0`)
    assert.equal(body.ok, true)
    assert.equal(market.probeCalls.length, 0)
  })

  it('probes only the non-suite registry packages under updates=1', async () => {
    const market = harness(async (names) => Object.fromEntries(names.map(name => [name, '9.9.9'])))
    const { status, body } = await market.get(`${ROUTE_PREFIX}/installed?updates=1`)
    assert.equal(status, 200)
    // Suite (@dsh-app) and local (file:) rows are skipped: neither can update.
    assert.deepEqual(market.probeCalls, [['pkg-a']])
    const packages = body.value!.packages as Array<Record<string, unknown>>
    const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
    assert.equal(byName.get('pkg-a')?.latest, '9.9.9')
    assert.equal(byName.get('pkg-a')?.updateAvailable, true)
    assert.equal(Object.hasOwn(byName.get('@dsh-app/plugin-market')!, 'latest'), false)
    assert.equal(Object.hasOwn(byName.get('dsh-local')!, 'latest'), false)
  })

  it('answers the local view when the prober fails', async () => {
    const market = harness(() => Promise.reject(new Error('registry down')))
    const { status, body } = await market.get(`${ROUTE_PREFIX}/installed?updates=1`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    // A failed probe degrades to unknown per package, never to an error.
    const packages = body.value!.packages as Array<Record<string, unknown>>
    assert.equal(Object.hasOwn(packages.find(pkg => pkg.name === 'pkg-a')!, 'latest'), false)
  })
})
