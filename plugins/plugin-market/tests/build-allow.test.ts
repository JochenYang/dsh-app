/**
 * Build-script whitelist tests: the minimal workspace document created when
 * no pnpm-workspace.yaml exists, the merge into an existing
 * onlyBuiltDependencies list (deduped, everything else byte-preserved), the
 * key appended to files without one, YAML-safety quoting for scoped names,
 * and idempotency at both the pure and the file level.
 *
 * The last block goes through the REAL routes (`POST /allow-build` beside
 * `POST /install`): the whitelist retry is authorized against the host's own
 * record of the installs it ran, so a package name the host never attempted —
 * and a name pnpm never reported — must be refused before the file is touched,
 * while the retry for a blocked install must keep working.
 *
 * @module plugin-market/tests/build-allow
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { CatalogEntry } from '../src/catalog.ts'
import { MarketBlockedBuildError, MarketValidationError } from '../src/errors.ts'
import { CatalogHold, InstallIntentStore } from '../src/install-intent.ts'
import type { PluginInstaller } from '../src/installer.ts'
import { blockedBuildsOf } from '../src/installer.ts'
import { registerMarketRoutes, ROUTE_PREFIX, type MarketDeps } from '../src/routes.ts'
import { allowBuilds, withAllowedBuilds } from '../src/build-allow.ts'

/** A realistic user-maintained workspace file the merge must not disturb. */
const EXISTING = `packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
onlyBuiltDependencies:
  - esbuild
  - '@scope/native'
`

describe('withAllowedBuilds (pure)', () => {
  it('creates the minimal document when the file is absent', () => {
    assert.equal(
      withAllowedBuilds(null, ['dsh-remote']),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nonlyBuiltDependencies:\n  - dsh-remote\n',
    )
    assert.equal(
      withAllowedBuilds(null, ['a', 'b']),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nonlyBuiltDependencies:\n  - a\n  - b\n',
    )
  })

  it('merges into an existing list, deduped and byte-preserving', () => {
    const next = withAllowedBuilds(EXISTING, ['dsh-remote', 'esbuild', '@scope/native'])
    assert.equal(next, `${EXISTING}  - dsh-remote\n`)
  })

  it('appends the key to a file without one', () => {
    const existing = 'packages:\n  - .\nnodeLinker: hoisted\n'
    const next = withAllowedBuilds(existing, ['dsh-remote'])
    assert.ok(next.startsWith(existing), 'existing content must be untouched')
    assert.equal(next, `${existing}onlyBuiltDependencies:\n  - dsh-remote\n`)
  })

  it('merges into a flow-style list', () => {
    const next = withAllowedBuilds('onlyBuiltDependencies: [esbuild]\n', ['dsh-remote'])
    assert.equal(next, 'onlyBuiltDependencies: [esbuild, dsh-remote]\n')
  })

  it('is idempotent: already-listed names change nothing', () => {
    assert.equal(withAllowedBuilds(EXISTING, ['esbuild', '@scope/native']), EXISTING)
    assert.equal(withAllowedBuilds(null, ['dsh-remote']), withAllowedBuilds(withAllowedBuilds(null, ['dsh-remote']), ['dsh-remote']))
  })

  it('adopts CRLF line endings for inserted rows and keeps existing bytes', () => {
    const crlf = EXISTING.replace(/\n/g, '\r\n')
    const next = withAllowedBuilds(crlf, ['dsh-remote'])
    assert.ok(next.startsWith(crlf))
    assert.ok(next.endsWith('  - dsh-remote\r\n'))
  })

  it('quotes scoped names as YAML requires and dedupes them against quoted rows', () => {
    const created = withAllowedBuilds(null, ['@scope/native'])
    assert.ok(created.includes("  - '@scope/native'\n"))
    const merged = withAllowedBuilds(created, ['@scope/native', 'other'])
    assert.equal(merged.includes('  - other\n'), true)
    assert.equal(merged.match(/@scope\/native/g)?.length, 1)
  })

  it('rejects names that could break out of the list row', () => {
    for (const name of ['a b', 'a:b', "a'b", 'a#b', '*alias', '~', 'x\ny']) {
      assert.throws(() => withAllowedBuilds(null, [name]), MarketValidationError, name)
    }
  })
})

describe('allowBuilds (file level)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-build-allow-'))
    path = join(dir, 'profiles', 'web', 'pnpm-workspace.yaml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates the profile directory and file when absent', () => {
    assert.equal(existsSync(path), false)
    assert.equal(allowBuilds(path, ['dsh-remote']), true)
    assert.equal(readFileSync(path, 'utf8'), withAllowedBuilds(null, ['dsh-remote']))
  })

  it('is idempotent on disk: a second identical write changes nothing', () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, EXISTING, 'utf8')
    assert.equal(allowBuilds(path, ['dsh-remote']), true)
    const afterFirst = readFileSync(path, 'utf8')
    assert.equal(allowBuilds(path, ['dsh-remote']), false)
    assert.equal(readFileSync(path, 'utf8'), afterFirst)
  })

  it('merges into an existing file without touching its other content', () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, EXISTING, 'utf8')
    allowBuilds(path, ['dsh-remote'])
    const text = readFileSync(path, 'utf8')
    assert.ok(text.startsWith('packages:\n  - .\nnodeLinker: hoisted\n'))
    assert.ok(text.includes("  - '@scope/native'\n"))
    assert.ok(text.includes('  - dsh-remote\n'))
  })

  it('leaves no temporary files behind', () => {
    allowBuilds(path, ['dsh-remote'])
    assert.equal(existsSync(path), true)
    assert.deepEqual(
      readdirSync(join(path, '..')).filter(name => name.includes('.tmp')),
      [],
    )
  })
})

// ── Route level: the whitelist retry is authorized by the HOST's own record ──

/** The answer envelope `POST /allow-build` and its neighbours share. */
interface Envelope {
  ok: boolean
  value?: Record<string, unknown>
  error?: { code: string, host?: { code: string }, blockedBuilds?: readonly string[] }
}

/** The npm row every install below targets. */
const ROW: CatalogEntry = {
  id: 'row-npm',
  package: 'dsh-remote',
  name: 'Remote',
  version: '1.2.3',
  description: 'a row',
  homepage: 'https://github.com/owner/dsh-remote',
}

/** Real pnpm wording for a blocked run (the pnpm ≤10 ignored-list form). */
function pnpmBlocked(name: string): string {
  return `Ignored build scripts: ${name}. Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts`
}

describe('POST /allow-build (the host’s own blocked-attempt record)', () => {
  let home: string
  let profileDir: string
  let workspacePath: string
  let previousHome: string | undefined
  let installs: string[]
  /** The pnpm output of each successive CLI run; exhausted = a clean run. */
  let script: string[]
  let post: (path: string, body: unknown) => Promise<{ status: number, body: Envelope }>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-market-allow-route-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    profileDir = join(home, 'profiles', 'web')
    workspacePath = join(profileDir, 'pnpm-workspace.yaml')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')

    installs = []
    script = []
    // The executor is scripted, but the ERROR is built the way the real one
    // builds it: the blocked names come from `blockedBuildsOf` over real pnpm
    // wording, so what the ledger records is what a blocked run produces.
    const installer = {
      install: async (pkg: unknown) => {
        installs.push(String(pkg))
        const output = script.shift()
        if (output !== undefined) {
          throw new MarketBlockedBuildError({
            code: 'install.commandFailedLog',
            params: { log: output },
            text: `the command failed:\n${output}`,
          }, blockedBuildsOf(output) ?? [])
        }
        return { version: '9.9.9', output: 'ok' }
      },
      installGit: async (target: unknown) => ({ version: String(target), output: 'ok' }),
      exclusive: async (job: () => Promise<void> | void) => { await job() },
    } as unknown as PluginInstaller

    const hold = new CatalogHold(() => null)
    hold.remember({ entries: [ROW], at: 42, sourceOf: () => null })
    const store = new InstallIntentStore(() => ({ profile: 'web', profileDir }), hold)

    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const connectionFetch = {
      register(route: { path: string, fetch: (request: Request) => Promise<Response> }) {
        routes.set(route.path, route.fetch)
        return Promise.resolve()
      },
    }
    const deps: MarketDeps = {
      sourcesPath: join(home, 'sources.json'),
      catalogCachePath: join(home, 'catalog-cache.json'),
      installer,
      profile: 'web',
      installIntents: store,
    }
    registerMarketRoutes(connectionFetch as never, deps, () => undefined)

    post = async (path, body) => {
      const handler = routes.get(path)
      assert.ok(handler !== undefined, `no route registered for ${path}`)
      const response = await handler(new Request(`dsh-app://app${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      return { status: response.status, body: await response.json() as Envelope }
    }
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  /** One real install attempt of the row the panel would show. */
  async function installRow(): Promise<Envelope> {
    const minted = await post(`${ROUTE_PREFIX}/install-intent`, { entryId: ROW.id })
    assert.equal(minted.status, 200)
    const token = minted.body.value!.token as string
    return (await post(`${ROUTE_PREFIX}/install`, { token })).body
  }

  it('refuses a package the host never attempted, and writes no whitelist', async () => {
    const refused = await post(`${ROUTE_PREFIX}/allow-build`, {
      package: 'totally-arbitrary-pkg',
      packages: ['totally-arbitrary-pkg'],
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error?.host?.code, 'allowBuild.notBlockedInstall')
    assert.deepEqual(installs, [], 'the executor must never be reached')
    assert.equal(existsSync(workspacePath), false, 'pnpm-workspace.yaml must not be created')
  })

  it('still performs the retry after a blocked install — the reason the route exists', async () => {
    script.push(pnpmBlocked('sharp'))
    const blocked = await installRow()
    assert.equal(blocked.ok, false)
    assert.deepEqual(blocked.error?.blockedBuilds, ['sharp'], 'the panel learns what to offer the retry for')
    assert.deepEqual(installs, ['dsh-remote'])
    assert.equal(existsSync(workspacePath), false, 'a failed install writes no whitelist')

    const retried = await post(`${ROUTE_PREFIX}/allow-build`, {
      package: 'dsh-remote',
      packages: ['sharp'],
    })
    assert.equal(retried.status, 200)
    assert.deepEqual(retried.body.value?.allowed, ['sharp'])
    assert.deepEqual(installs, ['dsh-remote', 'dsh-remote'], 'the retry re-runs the install the host ran')
    assert.equal(readFileSync(workspacePath, 'utf8'), withAllowedBuilds(null, ['sharp']))
  })

  it('refuses a whitelist name pnpm never reported', async () => {
    script.push(pnpmBlocked('sharp'))
    await installRow()
    const refused = await post(`${ROUTE_PREFIX}/allow-build`, {
      package: 'dsh-remote',
      packages: ['totally-arbitrary-pkg'],
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error?.host?.code, 'allowBuild.notReported')
    assert.deepEqual(installs, ['dsh-remote'], 'a refused request reaches no executor')
    assert.equal(existsSync(workspacePath), false)
  })

  it('refuses a target that is not the install the host ran, reported name or not', async () => {
    script.push(pnpmBlocked('sharp'))
    await installRow()
    const refused = await post(`${ROUTE_PREFIX}/allow-build`, {
      package: 'some-other-pkg',
      packages: ['sharp'],
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error?.host?.code, 'allowBuild.notBlockedInstall')
    assert.deepEqual(installs, ['dsh-remote'])
  })

  it('keeps a retry retryable: the retry is recorded like any other host install', async () => {
    script.push(pnpmBlocked('sharp'), pnpmBlocked('native-x'))
    await installRow()
    const first = await post(`${ROUTE_PREFIX}/allow-build`, { package: 'dsh-remote', packages: ['sharp'] })
    assert.equal(first.status, 502)
    assert.deepEqual(first.body.error?.blockedBuilds, ['native-x'])

    const second = await post(`${ROUTE_PREFIX}/allow-build`, { package: 'dsh-remote', packages: ['native-x'] })
    assert.equal(second.status, 200)
    assert.deepEqual(installs, ['dsh-remote', 'dsh-remote', 'dsh-remote'])
    const workspace = readFileSync(workspacePath, 'utf8')
    assert.ok(workspace.includes('  - sharp\n'), workspace)
    assert.ok(workspace.includes('  - native-x\n'), workspace)
  })
})
