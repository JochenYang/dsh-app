/**
 * The one-shot install intent: issuance (which resolves a caller's SELECTOR
 * against the host's own catalog), consumption (which is one-shot, expiring and
 * bound to the profile it was minted for), the route pair that carries it over
 * HTTP, and the model-facing tool's ride on the same lane.
 *
 * What these pin, in the order the failure modes matter:
 *
 *   - the renderer's claim is a LOOKUP KEY: a caller that sends a package name
 *     or a version alongside a token installs the token's facts, not its own;
 *   - one-shot: a replayed token is refused, and the executor ran once;
 *   - expiry and the profile/home fence refuse a token that went stale while it
 *     waited;
 *   - the row must exist in the host's own catalog (the build it served, else
 *     the persisted cache) — a name the catalog does not carry is refused,
 *     which is what keeps the install target the host's reading rather than the
 *     caller's;
 *   - the model tool cannot skip any of it.
 *
 * The destructive path (the CLI run) is not exercised anywhere here: the
 * executor is a stub that records what it was asked for.
 *
 * @module plugin-market/tests/install-intent
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { installPluginByName } from '../src/bridge-install.ts'
import type { CatalogEntry } from '../src/catalog.ts'
import { MarketValidationError } from '../src/errors.ts'
import type { PluginInstaller } from '../src/installer.ts'
import {
  CatalogHold,
  INSTALL_INTENT_TTL_MS,
  InstallIntentStore,
  ISSUE_BUCKET_CAPACITY,
  MAX_PENDING_INTENTS,
  type CatalogBuild,
  type IntentClock,
} from '../src/install-intent.ts'
import {
  createInstallIntents,
  registerMarketRoutes,
  ROUTE_PREFIX,
  type MarketDeps,
} from '../src/routes.ts'
import { CACHE_FORMAT_VERSION, saveCatalogCache, saveSources } from '../src/store.ts'

/** One catalog row; overrides keep each case one field wide. */
function entry(overrides: Partial<CatalogEntry> & { id: string, package: string }): CatalogEntry {
  return { name: overrides.package, description: 'a row', ...overrides }
}

/** An npm row (no git target). */
const NPM_ROW = entry({
  id: 'row-npm',
  package: 'dsh-remote',
  name: 'Remote',
  version: '1.2.3',
  homepage: 'https://github.com/owner/dsh-remote',
})

/** A git-only row: its package field is the source's page, not an npm name. */
const GIT_ROW = entry({
  id: 'row-git',
  package: 'https://example.com/pages/git-only',
  name: 'Git Only',
  gitTarget: 'github:owner/git-only',
  homepage: 'https://github.com/owner/git-only',
})

/** A source-only row: nothing to install. */
const SOURCE_ONLY_ROW = entry({
  id: 'row-source-only',
  package: 'https://example.com/pages/source-only',
  name: 'Source Only',
  installable: false,
})

/** A build of the host's own catalog, with attribution by source URL. */
function buildOf(
  entries: readonly CatalogEntry[],
  at: number | null = 1,
  sourceOf: (pkg: string) => string | null = () => null,
): CatalogBuild {
  return { entries, at, sourceOf }
}

/** The coded reason a call threw, or undefined when it did not throw. */
function reasonOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (cause: unknown) {
    if (cause instanceof MarketValidationError) return cause.host.code
    throw cause
  }
}

/**
 * A clock the test drives: both hands read the same source, which is what a
 * test that only needs "time passed" wants. The tests that pin the fence itself
 * (a moved wall clock, a rate bucket) build the two hands separately instead.
 */
function drivenClock(read: () => number): IntentClock {
  return { wall: read, monotonic: read }
}

/** A store over one fixed build, with a clock the test drives. */
function storeOver(
  entries: readonly CatalogEntry[],
  options: { clock?: IntentClock, profile?: () => string, profileDir?: () => string } = {},
): InstallIntentStore {
  const hold = new CatalogHold(() => null)
  hold.remember(buildOf(entries))
  return new InstallIntentStore(
    () => ({ profile: options.profile?.() ?? 'web', profileDir: options.profileDir?.() ?? '/home/first/profiles/web' }),
    hold,
    options.clock,
  )
}

describe('InstallIntentStore (issuance)', () => {
  let now = 1_000
  let store: InstallIntentStore

  beforeEach(() => {
    now = 1_000
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf(
      [NPM_ROW, GIT_ROW, SOURCE_ONLY_ROW],
      42,
      pkg => (pkg === NPM_ROW.package ? 'https://example.com/catalog.json' : null),
    ))
    store = new InstallIntentStore(
      () => ({ profile: 'web', profileDir: '/home/first/profiles/web' }),
      hold,
      drivenClock(() => now),
    )
  })

  it('binds the facts from the resolved row, not from the selector', () => {
    const intent = store.consume(store.issue({ entryId: 'row-npm' }, true).token)
    assert.equal(intent.package, 'dsh-remote')
    assert.equal(intent.version, '1.2.3')
    assert.equal(intent.gitTarget, null)
    assert.equal(intent.force, true)
    assert.equal(intent.repoKey, 'github.com/owner/dsh-remote')
    assert.deepEqual(intent.source, {
      sourceUrl: 'https://example.com/catalog.json',
      entryId: 'row-npm',
      catalogAt: 42,
    })
    assert.equal(intent.profile, 'web')
    assert.equal(intent.profileDir, '/home/first/profiles/web')
    assert.equal(intent.nonce.length, 32)
    assert.equal(intent.expiresAt, 1_000 + INSTALL_INTENT_TTL_MS)
  })

  it('resolves a git row to its repository target and identity', () => {
    const intent = store.consume(store.issue({ entryId: 'row-git' }, false).token)
    assert.equal(intent.gitTarget, 'github:owner/git-only')
    assert.equal(intent.repoKey, 'github.com/owner/git-only')
    assert.equal(intent.package, 'https://example.com/pages/git-only')
  })

  it('accepts an npm name as the selector (the model tool’s handle)', () => {
    const intent = store.consume(store.issue({ package: 'dsh-remote' }, false).token)
    assert.equal(intent.package, 'dsh-remote')
  })

  it('refuses a selector the host’s catalog does not carry', () => {
    assert.equal(reasonOf(() => store.issue({ entryId: 'row-gone' }, false)), 'install.entryUnknown')
    assert.equal(reasonOf(() => store.issue({ package: 'not-in-the-catalog' }, false)), 'install.entryUnknown')
    assert.equal(reasonOf(() => store.issue({}, false)), 'install.entryUnknown')
    // A package name is validated as such before it is used as a key, so a
    // malformed selector reads as malformed input rather than as a missing row.
    assert.equal(reasonOf(() => store.issue({ package: '../evil' }, false)), 'pkg.invalid')
  })

  it('refuses a row with no install target', () => {
    assert.equal(reasonOf(() => store.issue({ entryId: 'row-source-only' }, false)), 'install.notInstallable')
  })

  it('refuses an id the payload repeats instead of guessing which row it meant', () => {
    // The id is source-declared: a merged payload can carry two rows under one
    // id (a source that names no page falls back to its display name), and
    // "whichever matched first" is exactly the gap this lane exists to close.
    const ambiguous = storeOver([
      entry({ id: 'same', package: 'dsh-one', name: 'One' }),
      entry({ id: 'same', package: 'dsh-two', name: 'Two' }),
    ])
    assert.equal(reasonOf(() => ambiguous.issue({ entryId: 'same' }, false)), 'install.entryAmbiguous')
    // The package IS the payload's merge key, so that selector stays exact.
    assert.equal(ambiguous.consume(ambiguous.issue({ package: 'dsh-two' }, false).token).package, 'dsh-two')
  })

  it('refuses a git row whose repository the host cannot identify', () => {
    const foreign = storeOver([entry({ id: 'r', package: 'https://example.com/p', name: 'n', gitTarget: 'github:o/r' })])
    assert.equal(reasonOf(() => foreign.issue({ entryId: 'r' }, false)), 'install.gitTargetInvalid')
  })

  it('refuses to mint anything with no catalog at all', () => {
    const empty = new InstallIntentStore(
      () => ({ profile: 'web', profileDir: '/home/first/profiles/web' }),
      new CatalogHold(() => null),
      drivenClock(() => now),
    )
    assert.equal(reasonOf(() => empty.issue({ entryId: 'row-npm' }, false)), 'install.catalogUnavailable')
  })
})

describe('InstallIntentStore (consumption)', () => {
  let now = 1_000
  let profile = 'web'
  let home = '/home/first'
  let store: InstallIntentStore

  beforeEach(() => {
    now = 1_000
    profile = 'web'
    home = '/home/first'
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf([NPM_ROW]))
    store = new InstallIntentStore(
      () => ({ profile, profileDir: join(home, 'profiles', profile) }),
      hold,
      drivenClock(() => now),
    )
  })

  it('is one-shot: the second use of a token is refused', () => {
    const { token } = store.issue({ entryId: 'row-npm' }, false)
    assert.equal(store.consume(token).package, 'dsh-remote')
    assert.equal(reasonOf(() => store.consume(token)), 'install.tokenUnknown')
  })

  it('refuses an unknown, blank or non-string token', () => {
    assert.equal(reasonOf(() => store.consume('never-issued')), 'install.tokenUnknown')
    for (const value of ['', '   ', undefined, null, 42, {}]) {
      assert.equal(reasonOf(() => store.consume(value)), 'install.tokenInvalid', JSON.stringify(value))
    }
  })

  it('refuses a token past its deadline, and burns it doing so', () => {
    const { token } = store.issue({ entryId: 'row-npm' }, false)
    now += INSTALL_INTENT_TTL_MS
    assert.equal(reasonOf(() => store.consume(token)), 'install.tokenExpired')
    assert.equal(reasonOf(() => store.consume(token)), 'install.tokenUnknown')
  })

  it('stays usable up to the deadline', () => {
    const { token } = store.issue({ entryId: 'row-npm' }, false)
    now += INSTALL_INTENT_TTL_MS - 1
    assert.equal(store.consume(token).package, 'dsh-remote')
  })

  it('refuses a token minted for another profile', () => {
    const { token } = store.issue({ entryId: 'row-npm' }, false)
    profile = 'dev'
    assert.equal(reasonOf(() => store.consume(token)), 'install.tokenProfileMismatch')
  })

  it('refuses a token minted against another data directory', () => {
    const { token } = store.issue({ entryId: 'row-npm' }, false)
    home = '/home/second'
    assert.equal(reasonOf(() => store.consume(token)), 'install.tokenHomeChanged')
  })

  it('keeps a bounded number of pending intents, dropping the oldest', () => {
    const tokens: string[] = []
    for (let index = 0; index <= MAX_PENDING_INTENTS; index += 1) {
      // A second per mint: what this test measures is EVICTION, and the
      // issue-rate fence (one token a second) would otherwise refuse long
      // before the ceiling is reached.
      now += 1_000
      tokens.push(store.issue({ entryId: 'row-npm' }, false).token)
    }
    assert.equal(reasonOf(() => store.consume(tokens[0]!)), 'install.tokenUnknown')
    assert.equal(store.consume(tokens[tokens.length - 1]!).package, 'dsh-remote')
  })

  it('drops expired intents as it issues, so a long-lived host does not accumulate them', () => {
    const stale = store.issue({ entryId: 'row-npm' }, false).token
    now += INSTALL_INTENT_TTL_MS + 1
    const fresh = store.issue({ entryId: 'row-npm' }, false).token
    assert.equal(reasonOf(() => store.consume(stale)), 'install.tokenUnknown')
    assert.equal(store.consume(fresh).package, 'dsh-remote')
  })
})

// ── The two clock hands, and the issue-rate fence ───────────────────────────

describe('InstallIntentStore (monotonic fence and issue rate)', () => {
  /** A store whose two clock hands the test moves independently. */
  function splitStore(): {
    readonly store: InstallIntentStore
    readonly wall: { ms: number }
    readonly mono: { ms: number }
  } {
    const wall = { ms: 1_000_000 }
    const mono = { ms: 5_000 }
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf([NPM_ROW]))
    return {
      store: new InstallIntentStore(
        () => ({ profile: 'web', profileDir: '/home/first/profiles/web' }),
        hold,
        { wall: () => wall.ms, monotonic: () => mono.ms },
      ),
      wall,
      mono,
    }
  }

  it('expires on the monotonic clock, so a wall clock set back cannot extend a token', () => {
    const { store, wall, mono } = splitStore()
    const issued = store.issue({ entryId: 'row-npm' }, false)
    // The system clock goes back an hour. The deadline the panel was shown is a
    // wall stamp and moves with it — which is exactly why it is not the fence.
    wall.ms -= 60 * 60 * 1000
    assert.equal(issued.expiresAt, 1_000_000 + INSTALL_INTENT_TTL_MS, 'the panel is still shown a wall deadline')
    mono.ms += INSTALL_INTENT_TTL_MS
    assert.equal(reasonOf(() => store.consume(issued.token)), 'install.tokenExpired')
  })

  it('stays usable while the monotonic clock is inside the window, however far the wall clock jumps', () => {
    const { store, wall } = splitStore()
    const { token } = store.issue({ entryId: 'row-npm' }, false)
    wall.ms += 30 * 24 * 60 * 60 * 1000
    assert.equal(store.consume(token).package, 'dsh-remote')
  })

  it('refuses a burst of mints, so it cannot evict the confirmation the user has open', () => {
    const { store } = splitStore()
    const live = store.issue({ entryId: 'row-npm' }, false).token
    // The measured attack: MAX_PENDING_INTENTS mints back to back in one
    // instant, which used to push the live entry — the OLDEST — out of the map.
    const codes = Array.from(
      { length: MAX_PENDING_INTENTS },
      () => reasonOf(() => store.issue({ entryId: 'row-npm' }, false)),
    )
    assert.equal(codes.filter(code => code === undefined).length, ISSUE_BUCKET_CAPACITY - 1, 'the burst spends what the bucket held')
    assert.equal(
      codes.filter(code => code === 'install.rateLimited').length,
      MAX_PENDING_INTENTS - (ISSUE_BUCKET_CAPACITY - 1),
      'and is refused past it',
    )
    assert.equal(store.consume(live).package, 'dsh-remote', 'the confirmation that was open is still usable')
  })

  it('refills with the monotonic clock, so a normal pace is never refused', () => {
    const { store, mono } = splitStore()
    for (let index = 0; index < ISSUE_BUCKET_CAPACITY * 3; index += 1) {
      mono.ms += 1_000
      assert.equal(reasonOf(() => store.issue({ entryId: 'row-npm' }, false)), undefined, `mint ${String(index)}`)
    }
  })

  it('fences per profile, so one profile\'s burst does not spend another\'s quota', () => {
    let profile = 'web'
    const store = storeOver([NPM_ROW], { profile: () => profile })
    for (let index = 0; index < ISSUE_BUCKET_CAPACITY; index += 1) {
      assert.equal(reasonOf(() => store.issue({ entryId: 'row-npm' }, false)), undefined, `mint ${String(index)}`)
    }
    assert.equal(reasonOf(() => store.issue({ entryId: 'row-npm' }, false)), 'install.rateLimited')
    profile = 'dev'
    assert.equal(reasonOf(() => store.issue({ entryId: 'row-npm' }, false)), undefined, 'the other profile has its own bucket')
  })
})

describe('createInstallIntents (cold start)', () => {
  let dir: string
  let previousHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-intent-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dir
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  })

  /** Seed one persisted source + cache pair under the temp home. */
  function seedCache(entries: readonly CatalogEntry[]): { sourcesPath: string, catalogCachePath: string, url: string } {
    const sourcesPath = join(dir, 'sources.json')
    const catalogCachePath = join(dir, 'catalog-cache.json')
    const url = 'https://example.com/catalog.json'
    saveSources(sourcesPath, [url])
    saveCatalogCache(catalogCachePath, {
      version: CACHE_FORMAT_VERSION,
      fetchedAt: 7,
      sources: { [url]: { entries: [...entries] } },
    })
    return { sourcesPath, catalogCachePath, url }
  }

  it('resolves against the persisted catalog when nothing was served yet', () => {
    const { sourcesPath, catalogCachePath, url } = seedCache([NPM_ROW])
    const store = createInstallIntents({ profile: 'web', sourcesPath, catalogCachePath, log: () => undefined })
    const intent = store.consume(store.issue({ package: 'dsh-remote' }, false).token)
    assert.equal(intent.package, 'dsh-remote')
    // Attribution comes from the cache the rows did, and the profile directory
    // is resolved through $DSH_HOME at CALL time, not at construction.
    assert.equal(intent.source.sourceUrl, url)
    assert.equal(intent.source.catalogAt, 7)
    assert.equal(intent.profileDir, join(dir, 'profiles', 'web'))
  })

  it('carries the catalog the host just served over the persisted one', () => {
    const { sourcesPath, catalogCachePath, url } = seedCache([NPM_ROW])
    const store = createInstallIntents({ profile: 'web', sourcesPath, catalogCachePath, log: () => undefined })
    const live = entry({ id: 'row-new', package: 'dsh-brand-new', name: 'New', homepage: 'https://github.com/o/n' })
    store.hold.remember(buildOf([live], 99, () => url))
    const intent = store.consume(store.issue({ entryId: 'row-new' }, false).token)
    assert.equal(intent.package, 'dsh-brand-new')
    assert.equal(intent.source.catalogAt, 99)
  })
})

// ── Route level: the pair that carries the token over HTTP ──────────────────

/** The answer envelope every market route shares. */
interface Envelope {
  ok: boolean
  value?: Record<string, unknown>
  error?: { code: string, host?: { code: string } }
}

/** One route-test harness: the registered routes plus the observable host state. */
interface RouteHarness {
  readonly post: (path: string, body: unknown) => Promise<{ status: number, body: Envelope }>
  readonly installs: Array<{ name: string, version: string | undefined }>
  readonly gitInstalls: string[]
  /** Move the app to another profile / another $DSH_HOME, as a restart would. */
  readonly moveTo: (next: { profile?: string, profileDir?: string }) => void
}

describe('install intent routes', () => {
  let home: string
  let previousHome: string | undefined
  let harness: RouteHarness

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-market-intent-routes-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')

    const installs: Array<{ name: string, version: string | undefined }> = []
    const gitInstalls: string[] = []
    const installer = {
      install: async (pkg: unknown, version?: unknown) => {
        installs.push({ name: String(pkg), version: version === undefined ? undefined : String(version) })
        return { version: '9.9.9', output: 'ok' }
      },
      installGit: async (target: unknown) => {
        gitInstalls.push(String(target))
        return { version: String(target), output: 'ok' }
      },
    } as unknown as PluginInstaller

    // The store reads the profile identity through a thunk, so the test can
    // move the app (a profile switch, a restart onto another home) exactly as
    // the running host would experience it.
    const current = { profile: 'web', profileDir }
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf(
      [NPM_ROW, GIT_ROW, SOURCE_ONLY_ROW],
      42,
      pkg => (pkg === NPM_ROW.package ? 'https://example.com/catalog.json' : null),
    ))
    const store = new InstallIntentStore(() => ({ ...current }), hold)

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

    const send = async (path: string, init?: RequestInit): Promise<Response> => {
      const handler = routes.get(path)
      assert.ok(handler !== undefined, `no route registered for ${path}`)
      return await handler(new Request(`dsh-app://app${path}`, init))
    }
    harness = {
      installs,
      gitInstalls,
      moveTo: (next) => {
        if (next.profile !== undefined) current.profile = next.profile
        if (next.profileDir !== undefined) current.profileDir = next.profileDir
      },
      post: async (path, body) => {
        const response = await send(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: response.status, body: await response.json() as Envelope }
      },
    }
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  /** Mint one token through the route. */
  async function mint(body: unknown): Promise<string> {
    const minted = await harness.post(`${ROUTE_PREFIX}/install-intent`, body)
    assert.equal(minted.status, 200)
    assert.equal(minted.body.ok, true)
    const token = minted.body.value!.token
    assert.equal(typeof token, 'string')
    assert.ok((token as string).length >= 32)
    assert.ok((minted.body.value!.expiresAt as number) > Date.now(), 'a fresh token must not already be expired')
    return token as string
  }

  it('mints a token for a row, installs nothing yet, then installs exactly what that row binds', async () => {
    const token = await mint({ entryId: 'row-npm' })
    assert.equal(harness.installs.length, 0, 'minting must not install anything')
    const installed = await harness.post(`${ROUTE_PREFIX}/install`, { token })
    assert.equal(installed.status, 200)
    assert.equal(installed.body.ok, true)
    assert.deepEqual(harness.installs, [{ name: 'dsh-remote', version: undefined }])
  })

  it('ignores every install field but the token', async () => {
    const token = await mint({ entryId: 'row-npm' })
    const response = await harness.post(`${ROUTE_PREFIX}/install`, {
      token,
      package: 'some-other-package',
      version: '0.0.0',
      force: true,
      repoKey: 'github.com/attacker/other',
      gitTarget: 'github:attacker/other',
    })
    assert.equal(response.status, 200)
    assert.deepEqual(harness.installs, [{ name: 'dsh-remote', version: undefined }])
    assert.deepEqual(harness.gitInstalls, [])
  })

  it('installs a git row from the target the host resolved', async () => {
    const token = await mint({ entryId: 'row-git' })
    const response = await harness.post(`${ROUTE_PREFIX}/install`, { token })
    assert.equal(response.status, 200)
    assert.deepEqual(harness.gitInstalls, ['github:owner/git-only'])
    assert.deepEqual(harness.installs, [])
  })

  it('refuses a replayed token and runs the executor once', async () => {
    const token = await mint({ entryId: 'row-npm' })
    const first = await harness.post(`${ROUTE_PREFIX}/install`, { token })
    assert.equal(first.status, 200)
    const replay = await harness.post(`${ROUTE_PREFIX}/install`, { token })
    assert.equal(replay.status, 400)
    assert.equal(replay.body.error?.code, 'bad-request')
    assert.equal(replay.body.error?.host?.code, 'install.tokenUnknown')
    assert.equal(harness.installs.length, 1, 'a replay must never install twice')
  })

  it('refuses a token whose profile changed while it waited', async () => {
    const token = await mint({ entryId: 'row-npm' })
    harness.moveTo({ profile: 'dev' })
    const response = await harness.post(`${ROUTE_PREFIX}/install`, { token })
    assert.equal(response.status, 400)
    assert.equal(response.body.error?.host?.code, 'install.tokenProfileMismatch')
    assert.equal(harness.installs.length, 0)
  })

  it('refuses a token whose data directory changed while it waited', async () => {
    const token = await mint({ entryId: 'row-npm' })
    harness.moveTo({ profileDir: join(home, 'elsewhere', 'profiles', 'web') })
    const response = await harness.post(`${ROUTE_PREFIX}/install`, { token })
    assert.equal(response.status, 400)
    assert.equal(response.body.error?.host?.code, 'install.tokenHomeChanged')
    assert.equal(harness.installs.length, 0)
  })

  it('refuses to mint for a row the host’s catalog does not carry', async () => {
    const response = await harness.post(`${ROUTE_PREFIX}/install-intent`, { entryId: 'row-gone' })
    assert.equal(response.status, 400)
    assert.equal(response.body.error?.host?.code, 'install.entryUnknown')
  })

  it('refuses a request that carries no token at all', async () => {
    const response = await harness.post(`${ROUTE_PREFIX}/install`, {})
    assert.equal(response.status, 400)
    assert.equal(response.body.error?.host?.code, 'install.tokenInvalid')
  })

  it('keeps the same-name gate: a local install still needs the confirmed force', async () => {
    const profileDir = join(home, 'profiles', 'web')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-remote': 'file:../local-remote' },
    }), 'utf8')
    const response = await harness.post(`${ROUTE_PREFIX}/install`, { token: await mint({ entryId: 'row-npm' }) })
    assert.equal(response.status, 400)
    assert.equal(response.body.error?.host?.code, 'install.confirmLocal')

    // The force-confirmed retry is a NEW intent (a token is one shot by
    // design); it passes the gate and reaches the executor.
    const accepted = await harness.post(`${ROUTE_PREFIX}/install`, {
      token: await mint({ entryId: 'row-npm', force: true }),
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(harness.installs, [{ name: 'dsh-remote', version: undefined }])
  })

  it('remembers the catalog it served, so an intent resolves from what the user saw', async () => {
    const url = 'https://example.com/catalog.json'
    saveSources(join(home, 'sources.json'), [url])
    saveCatalogCache(join(home, 'catalog-cache.json'), {
      version: CACHE_FORMAT_VERSION,
      fetchedAt: Date.now(),
      sources: { [url]: { entries: [NPM_ROW] } },
    })
    // A fresh store whose hold starts empty: only the /catalog answer can fill
    // it, which is what makes this test about the serving route.
    const hold = new CatalogHold(() => null)
    const store = new InstallIntentStore(
      () => ({ profile: 'web', profileDir: join(home, 'profiles', 'web') }),
      hold,
    )
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const connectionFetch = {
      register(route: { path: string, fetch: (request: Request) => Promise<Response> }) {
        routes.set(route.path, route.fetch)
        return Promise.resolve()
      },
    }
    registerMarketRoutes(connectionFetch as never, {
      sourcesPath: join(home, 'sources.json'),
      catalogCachePath: join(home, 'catalog-cache.json'),
      installer: {} as unknown as PluginInstaller,
      profile: 'web',
      installIntents: store,
    }, () => undefined)
    assert.equal(reasonOf(() => store.issue({ entryId: 'row-npm' }, false)), 'install.catalogUnavailable')

    const response = await routes.get(`${ROUTE_PREFIX}/catalog`)!(new Request(`dsh-app://app${ROUTE_PREFIX}/catalog`))
    assert.equal(response.status, 200)

    const intent = store.consume(store.issue({ entryId: 'row-npm' }, false).token)
    assert.equal(intent.package, 'dsh-remote')
    assert.equal(intent.source.sourceUrl, url)
  })
})

// ── The model-facing tool rides the same lane ───────────────────────────────

describe('market_install_plugin (model path)', () => {
  let home: string
  let previousHome: string | undefined
  let store: InstallIntentStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-market-intent-tool-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf([NPM_ROW, GIT_ROW]))
    store = new InstallIntentStore(() => ({ profile: 'web', profileDir }), hold)
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  /** An executor recording what the tool asked it to install. */
  function recorder(): { installer: PluginInstaller, calls: string[] } {
    const calls: string[] = []
    const installer = {
      install: async (pkg: unknown) => {
        calls.push(String(pkg))
        return { version: '9.9.9', output: 'done' }
      },
    } as unknown as PluginInstaller
    return { installer, calls }
  }

  it('installs the package the catalog row carries, through issue + consume', async () => {
    const { installer, calls } = recorder()
    const result = await installPluginByName({ installer, profile: 'web', installIntents: store }, 'dsh-remote')
    assert.equal(result.ok, true)
    assert.equal(result.installed, true)
    assert.deepEqual(calls, ['dsh-remote'])
  })

  it('refuses a name the host’s own catalog does not carry, without reaching the executor', async () => {
    const { installer, calls } = recorder()
    const result = await installPluginByName({ installer, profile: 'web', installIntents: store }, 'never-in-the-catalog')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'install.entryUnknown')
    assert.deepEqual(calls, [])
  })

  it('refuses a row that installs from GitHub: that is the panel’s path', async () => {
    const { installer, calls } = recorder()
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf([entry({
      id: 'row-git',
      package: 'dsh-git-only',
      name: 'Git',
      gitTarget: 'github:owner/git-only',
      homepage: 'https://github.com/owner/git-only',
    })]))
    const gitStore = new InstallIntentStore(() => ({ profile: 'web', profileDir: join(home, 'profiles', 'web') }), hold)
    const result = await installPluginByName({ installer, profile: 'web', installIntents: gitStore }, 'dsh-git-only')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'install.gitOnly')
    assert.deepEqual(calls, [])
  })

  it('refuses an already-installed name BEFORE minting, so a refused call spends nothing', async () => {
    const profileDir = join(home, 'profiles', 'web')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-remote': 'file:./local-remote' },
    }), 'utf8')
    const { installer, calls } = recorder()
    // Counting the mints is the observation: the lane must be untouched by a
    // call that will be refused.
    let minted = 0
    const hold = new CatalogHold(() => null)
    hold.remember(buildOf([NPM_ROW]))
    const counted = new InstallIntentStore(
      () => ({ profile: 'web', profileDir }),
      hold,
      drivenClock(() => Date.now()),
      () => { minted += 1; return `token-${String(minted)}` },
    )
    const result = await installPluginByName({ installer, profile: 'web', installIntents: counted }, 'dsh-remote')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'install.alreadyInstalled')
    assert.equal(minted, 0)
    assert.deepEqual(calls, [])
  })

  it('hands the executor the row’s package, so the tool’s lane stays one-shot per call', async () => {
    const { installer, calls } = recorder()
    await installPluginByName({ installer, profile: 'web', installIntents: store }, 'dsh-remote')
    await installPluginByName({ installer, profile: 'web', installIntents: store }, 'dsh-remote')
    assert.deepEqual(calls, ['dsh-remote', 'dsh-remote'])
  })
})
