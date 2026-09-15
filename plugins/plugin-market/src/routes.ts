/**
 * Market API under `/plugins/@dsh-app/plugin-market/api`:
 *   GET  /sources          — the saved catalog source URLs
 *   PUT  /sources          — replace the source list (validated https, deduped)
 *   GET  /catalog          — TTL cache: a catalog-cache.json inside the 6 h
 *                            window answers instantly (`cached: true`); an
 *                            expired/missing cache fetches every source
 *                            concurrently, persists the result, and falls back
 *                            to the stale cache when EVERY source fails; with
 *                            no cache at all the bundled offline snapshot
 *                            renders (`snapshot: true`). `?refresh=1` skips
 *                            the cache and forces the live fetch.
 *   GET  /installed        — the current profile's dependencies + mount state
 *                            + per-package suite membership, entry id,
 *                            enabled state, installed version, install source
 *                            (registry/local/git), and the normalized repo key
 *                            read from the package's own manifest
 *                            (`repository`/`homepage`; every source, when a
 *                            repo URL exists — it is the evidence behind the
 *                            same-name origin checks). Everything above is a
 *                            local disk read and answers immediately; the
 *                            registry `latest` (5-min cache; registry packages
 *                            only — a local or git dependency is never probed
 *                            and never reports an update, so the panel cannot
 *                            offer to overwrite it with the npm release) is
 *                            layered on only under `?updates=1`, so the first
 *                            paint is never gated on the network
 *   POST /toggle           — {package, entryId, enable}: add/remove a disable
 *                            row for the entry id in the profile's own patch
 *                            layer (managed marker block; hot-reloaded)
 *   POST /install          — {package, version?, force?, repoKey?}: registry-resolve the
 *                            exact version, then run the kernel's plugin CLI
 *                            `add`. The npm name is not an identity: a
 *                            same-name collision is the same plugin only
 *                            when the installed package's repo key matches
 *                            the incoming one (`repoKey`, the catalog
 *                            entry's claim, re-derived server-side). A
 *                            local/git dev install or a repo mismatch —
 *                            an unknown side included — requires
 *                            `force: true`, and the refusal plus the
 *                            force-confirmed override name both repos;
 *                            responses carry `blockedBuilds` when pnpm
 *                            skipped build scripts
 *   POST /allow-build      — {packages, package}: merge the packages into the
 *                            profile's pnpm-workspace.yaml
 *                            `onlyBuiltDependencies` whitelist, then re-run
 *                            the install for `package` (the retry for a
 *                            blocked-builds result)
 *   POST /uninstall        — {package}: kernel plugin CLI `remove`
 *   POST /update           — {package}: verify the package is installed AND
 *                            outdated, then re-run the install chain at the
 *                            registry's latest version
 *
 * Every route enforces same-origin and the loopback-Host fence (403 with a
 * body, never a hung connection). Install/remove/update run serialized (see
 * installer.ts) so concurrent panel actions can never interleave profile
 * mutations. Reads expose only package facts — no absolute paths beyond the
 * suite-conventional profile name, no registry/auth internals.
 *
 * Isolation note: the HTTP helpers below intentionally mirror the other
 * suite plugins' routes instead of being shared — each suite plugin bundles
 * standalone (esbuild, no cross-plugin runtime imports), so a shared util
 * would be a new package for ~40 lines.
 *
 * @module @dsh-app/plugin-market/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  fetchCatalog,
  mergeCatalogs,
  validateSourceUrl,
  MAX_SOURCES,
  type CatalogEntry,
  type SourceFetchResult,
} from './catalog.ts'
import { MarketBlockedBuildError, MarketExecutionError, MarketValidationError, type HostText } from './errors.ts'
import { repoKeyOf, sameOrigin as sameRepoOrigin } from './identity.ts'
import type { PluginInstaller } from './installer.ts'
import { compareVersions, latestVersionOf, latestVersionsOf, validatePackageName } from './npm.ts'
import { allowBuilds } from './build-allow.ts'
import {
  disabledIdsOf,
  insertedEntryIdOf,
  toggleManagedDisable,
  ENTRY_ID_PATTERN,
} from './patchfile.ts'
import {
  buildCatalogCache,
  loadCatalogCache,
  loadSources,
  saveCatalogCache,
  saveSources,
  type CatalogCache,
} from './store.ts'
import { loadSnapshot, type SnapshotFallback } from './snapshot.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-market/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

/** Collaborators the routes need; injectable for tests. */
export interface MarketDeps {
  /** Absolute path of sources.json. */
  readonly sourcesPath: string
  /** Absolute path of catalog-cache.json (the cache-first snapshot). */
  readonly catalogCachePath: string
  /** The serialized install/uninstall executor. */
  readonly installer: PluginInstaller
  /** Profile whose package.json backs /installed and the CLI --profile. */
  readonly profile: string
  /**
   * Registry `latest` prober for the update check; defaults to the cached npm
   * resolver. Injectable so tests never touch the network.
   */
  readonly latestVersions?: (names: readonly string[]) => Promise<Record<string, string | undefined>>
}

/** The GET /catalog payload (every mode shares the shape; flags mark the mode). */
export interface CatalogPayload {
  readonly plugins: readonly CatalogEntry[]
  readonly failed: ReadonlyArray<{ url: string, reason: HostText }>
  readonly sources: readonly string[]
  /** Snapshot time of the served data (cache write moment, or the fetch moment). */
  readonly cachedAt?: number
  /** True = answered from a cache inside the TTL window (the fast path). */
  readonly cached?: boolean
  /** True = every live fetch failed and the stale cache rescued the response. */
  readonly stale?: boolean
  /** True = no cache existed and the bundled offline snapshot is served. */
  readonly snapshot?: boolean
  /** ISO generation timestamp of the served offline snapshot. */
  readonly snapshotAt?: string
}

/**
 * Where an installed dependency's spec points. Registry packages have a
 * meaningful npm identity the panel can update; local (file:/link:) and git
 * dependencies are user-managed development installs — the registry knows
 * nothing about them, and treating them as updatable would replace the local
 * version with the npm release.
 */
export type PackageSource = 'local' | 'git' | 'registry'

/** Git hosts a dependency spec may point at (scp-style `host:path` included). */
const GIT_HOST_PATTERN = /(?:github|gitlab|bitbucket|gitee)\.(?:com|org)[:/]/

/**
 * Classify one dependency spec. Only the spec decides — the same package name
 * can be installed from npm in one profile and from a local path in another,
 * so the manifest is the sole authority.
 */
export function dependencySourceOf(spec: string): PackageSource {
  const value = spec.trim()
  if (/^(?:file|link):/i.test(value)) return 'local'
  if (/^(?:github:|git\+|git:)/i.test(value) || value.endsWith('.git') || GIT_HOST_PATTERN.test(value)) return 'git'
  return 'registry'
}

/** One installed package as the client sees it. */
export interface InstalledPackageView {
  readonly name: string
  /** The dependency spec as written in the profile manifest. */
  readonly version: string
  /** Whether the package is listed in the profile's bundle (mount) layer. */
  readonly bundled: boolean
  /**
   * True for @dsh-app suite packages: the shell's overlay applies AFTER the
   * profile patch layer (last write wins), so a profile-layer disable row
   * would be a silent no-op — the panel must not offer toggling for them.
   */
  readonly suite: boolean
  /** False only when the profile patch layer disables this package's entry. */
  readonly enabled: boolean
  /** The composed entry id the disable patch must target (fallback: package name). */
  readonly entryId: string
  /** The version recorded in the package's own manifest (absent = unreadable). */
  readonly installedVersion?: string
  /** What the dependency spec points at; drives the local-version guard. */
  readonly source: PackageSource
  /**
   * Normalized repo identity (`host/owner/repo`) read from the package's own
   * manifest (`repository`, then `homepage`) — present for every source when
   * a repo URL exists. The npm name is not an identity: this key is the
   * evidence the same-name origin checks compare.
   */
  readonly repoKey?: string
  /** Registry `latest` at query time (absent = unknown or the lookup failed). */
  readonly latest?: string
  /** True only when both versions are known and latest sorts above installed. */
  readonly updateAvailable?: boolean
}

/** Same-origin fence (compare host parts; Origin carries the scheme). */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Loopback-host fence: admit only requests whose Host names this machine's
 * loopback interface, so a rebinding/cross-site request carrying an
 * attacker's Host is refused even when it forges a matching Origin.
 */
function passesFence(req: IncomingMessage): boolean {
  const raw = req.headers.host
  if (typeof raw !== 'string' || raw === '') return false
  let hostname: string
  try {
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.setHeader('Content-Type', 'application/json')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value })
}

/**
 * Failure answer. `code` is the transport-ish category (kept for the existing
 * client checks); `host` is the coded message the panel renders in its own
 * language. The plain `message` stays an English diagnostic for logs and for a
 * client that does not know the code yet.
 */
function fail(
  res: ServerResponse,
  status: number,
  code: string,
  host: HostText,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, status, { ok: false, error: { code, message: host.text ?? host.code, host, ...extra } })
}

/** Error-envelope extras for install-chain failures (blocked-builds payload). */
function errorExtras(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof MarketBlockedBuildError) return { blockedBuilds: error.blockedBuilds }
  return undefined
}

/** Bounded JSON body read (sources lists and install requests are small). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16_384) {
        // Drain instead of destroy: the socket stays alive so the 413 answer
        // actually reaches the client.
        rejectPromise(new Error('payload-too-large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolvePromise(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error('invalid JSON body'))
      }
    })
    req.on('error', rejectPromise)
  })
}

/** Map one route error to its status + stable coded message. */
function errorStatus(error: unknown): { status: number, code: string, host: HostText } {
  if (error instanceof MarketValidationError) return { status: 400, code: 'bad-request', host: error.host }
  if (error instanceof MarketExecutionError) return { status: 502, code: error.code, host: error.host }
  const detail = error instanceof Error ? error.message : String(error)
  return {
    status: 500,
    code: 'io',
    host: {
      code: 'route.internalError',
      params: { detail },
      text: `the operation failed: ${detail}`,
    },
  }
}

/**
 * Force-refresh marker of GET /catalog (`?refresh=1`): the panel's reload
 * buttons must pay the live fetch even when a fresh cache exists.
 */
export function wantsRefresh(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined || rawUrl === '') return false
  try {
    return new URL(rawUrl, 'http://localhost').searchParams.get('refresh') === '1'
  } catch {
    return false
  }
}

/**
 * Update-probe opt-in of GET /installed (`?updates=1`). Absent/anything else
 * answers the local facts alone — a pure disk read the panel can render at
 * once — so the registry round-trips are paid only when explicitly requested
 * and the default response stays wire-compatible with older clients.
 */
export function wantsUpdates(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined || rawUrl === '') return false
  try {
    return new URL(rawUrl, 'http://localhost').searchParams.get('updates') === '1'
  } catch {
    return false
  }
}

/** Sanitize a client-supplied source list (order-preserving dedupe). */
export function sanitizeSourceList(raw: unknown): { ok: true, urls: string[] } | { ok: false, reason: HostText } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: { code: 'source.notArray', text: 'sources must be an array of strings' } }
  }
  if (raw.length > MAX_SOURCES) {
    return {
      ok: false,
      reason: {
        code: 'source.tooMany',
        params: { max: MAX_SOURCES },
        text: `at most ${String(MAX_SOURCES)} catalog sources`,
      },
    }
  }
  const urls: string[] = []
  const seen = new Set<string>()
  for (const candidate of raw) {
    const check = validateSourceUrl(candidate)
    if (!check.ok) return { ok: false, reason: check.reason }
    if (seen.has(check.url)) continue
    seen.add(check.url)
    urls.push(check.url)
  }
  return { ok: true, urls }
}

/** Sanity cap on one /allow-build request: real block lists are a handful. */
const MAX_ALLOW_PACKAGES = 32

/** Validate + dedupe the whitelist of one /allow-build request. */
function sanitizePackageList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MarketValidationError({
      code: 'allowBuild.packagesNotArray',
      text: 'packages must be a non-empty array of package names',
    })
  }
  if (raw.length > MAX_ALLOW_PACKAGES) {
    throw new MarketValidationError({
      code: 'allowBuild.tooMany',
      params: { max: MAX_ALLOW_PACKAGES },
      text: `at most ${String(MAX_ALLOW_PACKAGES)} packages per request`,
    })
  }
  const names: string[] = []
  for (const candidate of raw) {
    const name = validatePackageName(candidate)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Read a text file, answering '' when absent or unreadable (degrade to "enabled"/"no id"). */
function readTextIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The repo identity of one package manifest: `repository` (string or {url}
 * are the two shapes npm manifests carry) first, then `homepage` — answered
 * through the shared repo-key normalization so an installed package and a
 * catalog entry are compared by the same rule. A manifest without either has
 * no provable origin and the view omits the key.
 */
function manifestRepoKeyOf(manifest: { homepage?: unknown, repository?: unknown }): string | undefined {
  const repository = manifest.repository
  const repositoryUrl = typeof repository === 'string'
    ? repository
    : (typeof repository === 'object' && repository !== null && typeof (repository as { url?: unknown }).url === 'string'
      ? (repository as { url: string }).url
      : undefined)
  const homepage = typeof manifest.homepage === 'string' ? manifest.homepage : undefined
  return repoKeyOf(repositoryUrl) ?? repoKeyOf(homepage) ?? undefined
}

/**
 * The per-package facts read from the package's own manifest: the composed
 * entry id (the manifest's bundle patch is the kernel's authoritative id
 * source — the insert row may name the entry differently from the package),
 * the actually installed version, and the normalized repo key. The patch
 * path is only honored when it stays inside the package directory; an
 * unreadable manifest or patch degrades to the package name / no version —
 * a disable row keyed on a wrong id is a no-op, never a misfire, a missing
 * version only hides the update badge, and a missing repo key only hides
 * the origin evidence.
 */
function installedFactsOf(profileDir: string, name: string): {
  entryId: string
  installedVersion: string | undefined
  repoKey: string | undefined
} {
  const segments = name.split('/')
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', ...segments, 'package.json'), 'utf8')) as {
      version?: unknown
      homepage?: unknown
      repository?: unknown
      dsh?: { bundle?: { patch?: unknown } }
    }
    const installedVersion = typeof manifest.version === 'string' && manifest.version !== ''
      ? manifest.version
      : undefined
    const repoKey = manifestRepoKeyOf(manifest)
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string' || patch === '' || isAbsolute(patch) || patch.split(/[\\/]/).includes('..')) {
      return { entryId: name, installedVersion, repoKey }
    }
    const patchText = readTextIfPresent(join(profileDir, 'node_modules', ...segments, patch))
    return { entryId: insertedEntryIdOf(patchText, name) ?? name, installedVersion, repoKey }
  } catch {
    return { entryId: name, installedVersion: undefined, repoKey: undefined }
  }
}

/**
 * Read the profile manifest (package.json) and project it to the installed
 * view: dependencies + per-package bundle-layer membership, suite membership,
 * entry id, and enabled state (the profile patch layer's disabled rows, which
 * the kernel hot-reloads).
 * @param profileDir - absolute path of the profile directory.
 * @param profile - profile display name for the response.
 * @returns the view; a missing/unusable manifest degrades to an empty list.
 */
export function readInstalled(profileDir: string, profile: string): {
  profile: string
  packages: InstalledPackageView[]
  manifestAvailable: boolean
} {
  let manifest: { dependencies?: Record<string, unknown>, dsh?: { profile?: { bundles?: unknown } } }
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return { profile, packages: [], manifestAvailable: false }
  }
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles
  const bundledSet = new Set<string>(
    Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : [],
  )
  const disabled = disabledIdsOf(readTextIfPresent(join(profileDir, 'cordis.patch.yml')))
  const packages: InstalledPackageView[] = Object.entries(dependencies)
    .filter(([name, spec]) => typeof name === 'string' && typeof spec === 'string')
    .map(([name, spec]) => {
      const { entryId, installedVersion, repoKey } = installedFactsOf(profileDir, name)
      return {
        name,
        version: spec as string,
        bundled: bundledSet.has(name),
        suite: name.startsWith('@dsh-app/'),
        entryId,
        enabled: !disabled.has(entryId),
        source: dependencySourceOf(spec as string),
        ...(installedVersion !== undefined ? { installedVersion } : {}),
        ...(repoKey !== undefined ? { repoKey } : {}),
      }
    })
  return { profile, packages, manifestAvailable: true }
}

/**
 * Attach the update facts to an installed view. `updateAvailable` requires
 * both versions to be known — a dependency spec (`^1.2.0`) is not a version
 * and never participates in the comparison, so an unreadable manifest can
 * never fake an update. Local/git installs are passed through untouched: the
 * registry has no version for them, and even a probed latest must never read
 * as "update" for a package whose local version an update would destroy.
 * @param view - the projected installed view.
 * @param latest - per-package registry `latest` (undefined = unknown).
 * @returns the view with per-package latest/updateAvailable filled in.
 */
export function withUpdateFacts(
  view: { profile: string, packages: InstalledPackageView[], manifestAvailable: boolean },
  latest: Readonly<Record<string, string | undefined>>,
): { profile: string, packages: InstalledPackageView[], manifestAvailable: boolean } {
  return {
    ...view,
    packages: view.packages.map((pkg) => {
      if (pkg.source !== 'registry') return pkg
      const newest = latest[pkg.name]
      if (newest === undefined || pkg.installedVersion === undefined) return pkg
      const updateAvailable = compareVersions(newest, pkg.installedVersion) > 0
      return {
        ...pkg,
        latest: newest,
        ...(updateAvailable ? { updateAvailable: true } : {}),
      }
    }),
  }
}

/** Cache age within which a snapshot answers without a live fetch. */
export const CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** A source's contribution to a payload (mergeCatalogs applies the caps). */
function listsOf(results: ReadonlyArray<SourceFetchResult>): {
  lists: CatalogEntry[][]
  failed: Array<{ url: string, reason: HostText }>
} {
  const lists: CatalogEntry[][] = []
  const failed: Array<{ url: string, reason: HostText }> = []
  for (const result of results) {
    if ('entries' in result) lists.push([...result.entries])
    else failed.push({ url: result.url, reason: result.reason })
  }
  return { lists, failed }
}

/**
 * Fill each entry's repo key at payload assembly, recomputed from
 * `homepage`: entries persisted before the identity rule existed (catalog
 * caches, older snapshots) lack the field, and recomputing also heals a
 * stored key against later normalization changes. A homepage that is no
 * repo URL leaves the entry untouched.
 */
function withRepoKeys(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries.map((entry) => {
    const repoKey = repoKeyOf(entry.homepage)
    return repoKey === null ? entry : { ...entry, repoKey }
  })
}

/** Project the persisted cache to a payload, in the CURRENT source order. */
function cachePayload(cache: CatalogCache, sources: readonly string[], fresh: boolean): CatalogPayload {
  const lists: CatalogEntry[][] = []
  const failed: Array<{ url: string, reason: HostText }> = []
  for (const url of sources) {
    const state = cache.sources[url]
    if (state === undefined) continue
    if (state.failed !== undefined) failed.push({ url, reason: state.failed })
    else if (state.entries.length > 0) lists.push([...state.entries])
  }
  return {
    plugins: withRepoKeys(mergeCatalogs(lists)),
    failed,
    sources,
    cachedAt: cache.fetchedAt,
    ...(fresh ? { cached: true } : { stale: true }),
  }
}

/** A cache is usable only when it is inside the TTL and covers every source. */
function isCacheFresh(cache: CatalogCache, sources: readonly string[], now: number): boolean {
  if (!Number.isSafeInteger(cache.fetchedAt) || now - cache.fetchedAt < 0) return false
  if (now - cache.fetchedAt >= CATALOG_CACHE_TTL_MS) return false
  // A source added after the snapshot has no row — treat the whole cache as
  // expired so the new source participates in the next fetch instead of
  // silently rendering an incomplete directory for hours.
  return sources.every(url => cache.sources[url] !== undefined)
}

/** Collaborators of the catalog resolution, injectable for tests. */
export interface CatalogResolveDeps {
  readonly sources: readonly string[]
  /** True = skip the cache entirely (the panel's force reload). */
  readonly refresh: boolean
  readonly fetchSource: (url: string) => Promise<SourceFetchResult>
  readonly readCache: () => CatalogCache | null
  readonly loadSnapshot: () => SnapshotFallback | null
  readonly now: () => number
}

/** The resolution outcome: the response payload plus the cache to persist. */
export interface CatalogResolution {
  readonly payload: CatalogPayload
  /** Non-null = persist this snapshot (atomic write is the caller's job). */
  readonly cacheToWrite: CatalogCache | null
}

/**
 * The catalog flow, one place and pure enough to test without HTTP:
 *
 * 1. fresh cache (TTL + covers every source) → answer immediately;
 * 2. otherwise fetch all sources concurrently — any success persists a new
 *    snapshot (per-source failures ride along as rows);
 * 3. every source failed → fall back to the stale cache (marked `stale`);
 * 4. no cache either → render the bundled offline snapshot (`snapshot`);
 * 5. nothing at all → an empty payload whose failed list drives the panel's
 *    prominent reload box.
 */
export async function resolveCatalog(deps: CatalogResolveDeps): Promise<CatalogResolution> {
  const { sources } = deps
  if (sources.length === 0) {
    return { payload: { plugins: [], failed: [], sources }, cacheToWrite: null }
  }
  // A forced refresh skips the freshness window but still reads the cache:
  // the moment a user most likely hits reload is exactly when the sources are
  // down, and a stale copy rescued from disk beats an empty or snapshot panel.
  // `refresh` re-enters the fetch path below regardless.
  const cache = deps.readCache()
  if (!deps.refresh && cache !== null && isCacheFresh(cache, sources, deps.now())) {
    return { payload: cachePayload(cache, sources, true), cacheToWrite: null }
  }
  const results = await Promise.all(sources.map(url => deps.fetchSource(url)))
  const { lists, failed } = listsOf(results)
  if (lists.length > 0) {
    const fetchedAt = deps.now()
    return {
      payload: { plugins: withRepoKeys(mergeCatalogs(lists)), failed, sources, cachedAt: fetchedAt },
      cacheToWrite: buildCatalogCache(fetchedAt, results),
    }
  }
  // Every source failed: the last good snapshot (even an expired one) beats an
  // empty panel, and the current failure reasons still reach the user.
  if (cache !== null) {
    const payload = cachePayload(cache, sources, false)
    return { payload: { ...payload, failed }, cacheToWrite: null }
  }
  const snapshot = deps.loadSnapshot()
  if (snapshot !== null) {
    return {
      payload: {
        plugins: withRepoKeys([...snapshot.entries]),
        failed,
        sources,
        ...(snapshot.snapshotAt !== undefined ? { snapshotAt: snapshot.snapshotAt } : {}),
        snapshot: true,
      },
      cacheToWrite: null,
    }
  }
  return { payload: { plugins: [], failed, sources }, cacheToWrite: null }
}

/**
 * Validate one update request against the installed view + registry latest.
 * Pure so the route keeps only glue: the answer is either the exact target
 * version to install (the install chain re-verifies it against the registry)
 * or a stable coded refusal the panel renders.
 * @param pkg - the installed view row for the requested package.
 * @param latest - the registry `latest` for the package (undefined = probe failed).
 */
export function checkUpdateTarget(
  pkg: InstalledPackageView | undefined,
  latest: string | undefined,
): { ok: true, version: string } | { ok: false, reason: HostText } {
  if (pkg === undefined) {
    return {
      ok: false,
      reason: { code: 'update.notInstalled', text: 'this plugin is not installed, so it cannot be updated' },
    }
  }
  if (pkg.suite) {
    return {
      ok: false,
      reason: {
        code: 'update.suiteManaged',
        text: 'suite plugins are managed by the desktop shell and cannot be updated in the market',
      },
    }
  }
  if (pkg.source !== 'registry') {
    return {
      ok: false,
      reason: {
        code: 'update.localOrGit',
        text: 'a locally or Git-installed plugin does not update through npm; update it at its own source and reinstall',
      },
    }
  }
  if (latest === undefined) {
    return {
      ok: false,
      reason: {
        code: 'update.latestUnknown',
        text: "the plugin's latest version could not be fetched right now; try again later",
      },
    }
  }
  if (pkg.installedVersion === undefined || compareVersions(latest, pkg.installedVersion) <= 0) {
    return {
      ok: false,
      reason: { code: 'update.upToDate', text: 'already on the latest version; nothing to update' },
    }
  }
  return { ok: true, version: latest }
}

/**
 * The same-name install gate, pure so its texts are testable without HTTP.
 * The npm name is not an identity: a collision is the same plugin only when
 * both repo keys are known and equal. Anything else — a local/git dev
 * install, a different repo, an unknown side — reads as "a different plugin
 * sharing the name", and replacing it demands the explicit `force`
 * confirmation. The refusal and the force-confirmed log name both sides
 * (`host/owner/repo`, 未知来源 when a side is unprovable) so the replacement
 * is an informed, auditable decision rather than a silent overwrite.
 * @param current - the installed row for the requested name (undefined = no collision).
 * @param incomingRepoKey - the incoming package's claimed repo key (null = unclaimed/unknown).
 * @param force - the caller's explicit replacement confirmation.
 */
export function installGateOf(
  current: InstalledPackageView | undefined,
  incomingRepoKey: string | null,
  force: boolean,
): { action: 'allow' } | { action: 'refuse', reason: HostText } | { action: 'confirm', log: string } {
  if (current === undefined) return { action: 'allow' }
  // An unprovable side travels as a nested code, not as the word 未知来源: the
  // sentence is the dictionary's in either language.
  const installedRepo = current.repoKey ?? 'repo.unknown'
  const incomingRepo = incomingRepoKey ?? 'repo.unknown'
  if (current.source === 'registry' && sameRepoOrigin(incomingRepoKey, current.repoKey ?? null)) {
    return { action: 'allow' }
  }
  if (!force) {
    return {
      action: 'refuse',
      reason: current.source !== 'registry'
        ? {
            code: 'install.confirmLocal',
            params: { installed: installedRepo, incoming: incomingRepo },
            text: `this plugin is installed locally or from Git (local: ${current.repoKey ?? 'unknown'}), this install comes from npm (repo: ${incomingRepoKey ?? 'unknown'}), and installing directly would replace the existing version; to replace it, send force: true`,
          }
        : {
            code: 'install.confirmCrossOrigin',
            params: { installed: installedRepo, incoming: incomingRepo },
            text: `an installed plugin with the same name comes from ${current.repoKey ?? 'unknown'}, not from this install's source (${incomingRepoKey ?? 'unknown'}); they are two different plugins, and installing replaces the existing version; to replace it, send force: true`,
          },
    }
  }
  return {
    action: 'confirm',
    log: `plugin-market: ${current.name} is ${current.source}-installed (repo: ${current.repoKey ?? 'unknown'}); the incoming install claims repo ${incomingRepoKey ?? 'unknown'} and will REPLACE it (force confirmed)`,
  }
}

/**
 * Register the market routes.
 * @param webServer - the dsh web server service.
 * @param deps - collaborators (paths, installer, profile).
 * @param log - diagnostic logger.
 * @returns disposer removing the routes.
 */
export function registerMarketRoutes(webServer: WebServerLike, deps: MarketDeps, log: (message: string) => void): () => void {
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!sameOrigin(req) || !passesFence(req)) {
      fail(res, 403, 'forbidden', { code: 'route.crossOrigin', text: 'cross-origin request' })
      return false
    }
    if (req.method !== method) {
      res.setHeader('Allow', method)
      fail(res, 405, 'method-not-allowed', { code: 'route.methodOnly', params: { method }, text: `${method} only` })
      return false
    }
    return true
  }

  /** Cache writes are an optimization: a failed write degrades to a log line, never a failed response. */
  const persistCache = (cache: CatalogCache): void => {
    try {
      saveCatalogCache(deps.catalogCachePath, cache)
    } catch (error) {
      log(`plugin-market catalog cache: write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Toggle jobs queue behind each other so patch-file rewrites never interleave. */
  let toggleChain: Promise<unknown> = Promise.resolve()

  /**
   * One toggle job: validate, then add/remove the disable row in the profile
   * patch layer. The kernel's live patch reload applies the change without a
   * restart. Suite packages are refused — the shell's overlay re-applies them
   * after this layer, so a disable row would be a silent no-op.
   */
  const runToggle = (body: Record<string, unknown>): { package: string, entryId: string, enabled: boolean } => {
    const name = validatePackageName(body.package)
    if (name.startsWith('@dsh-app/')) {
      throw new MarketValidationError({
        code: 'toggle.suiteManaged',
        text: 'suite plugins are managed by the desktop shell and cannot be enabled or disabled in the market',
      })
    }
    const rawEntryId = body.entryId
    let entryId = name
    if (rawEntryId !== undefined && rawEntryId !== null && rawEntryId !== '') {
      if (typeof rawEntryId !== 'string' || !ENTRY_ID_PATTERN.test(rawEntryId.trim())) {
        const id = typeof rawEntryId === 'string' ? rawEntryId.trim() : String(rawEntryId)
        throw new MarketValidationError({
          code: 'entryId.invalid',
          params: { id },
          text: `invalid plugin entry id: "${id}"`,
        })
      }
      entryId = rawEntryId.trim()
    }
    if (typeof body.enable !== 'boolean') {
      throw new MarketValidationError({ code: 'toggle.enableNotBoolean', text: 'enable must be a boolean' })
    }
    const patchPath = join(resolveDshHome(), 'profiles', deps.profile, 'cordis.patch.yml')
    const outcome = toggleManagedDisable(patchPath, entryId, body.enable)
    if (body.enable && outcome.foreign) {
      // The id shows as disabled but the row lives outside the managed block
      // (hand-written). Reporting success here would strand the user in a
      // toggle that never flips — point them at the file instead.
      throw new MarketValidationError({
        code: 'toggle.manualDisable',
        text: "this plugin's disable entry was written into the patch file by hand, so it cannot be re-enabled from here; edit cordis.patch.yml under profiles and remove the matching disabled row",
      })
    }
    log(`plugin-market: ${body.enable ? 'enabled' : 'disabled'} entry ${entryId} (${name}) via profile patch`)
    return { package: name, entryId, enabled: body.enable }
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/sources`,
      handler: (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          ok(res, { sources: loadSources(deps.sourcesPath, log) })
          return
        }
        if (!guard(req, res, 'PUT')) return
        void readJsonBody(req)
          .then((body) => {
            const check = sanitizeSourceList(body.sources)
            if (!check.ok) {
              fail(res, 400, 'bad-request', check.reason)
              return
            }
            saveSources(deps.sourcesPath, check.urls)
            ok(res, { sources: check.urls })
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (16 KiB cap)' })
              return
            }
            fail(res, 400, 'bad-request', { code: 'route.invalidBody', text: message })
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/catalog`,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        const sources = loadSources(deps.sourcesPath, log)
        void resolveCatalog({
          sources,
          // ?refresh=1 is the panel's force reload: skip the cache and pay the
          // live fetch even when a fresh snapshot exists.
          refresh: wantsRefresh(req.url),
          fetchSource: fetchCatalog,
          readCache: () => loadCatalogCache(deps.catalogCachePath, log),
          loadSnapshot,
          now: Date.now,
        })
          .then((resolution) => {
            if (resolution.cacheToWrite !== null) persistCache(resolution.cacheToWrite)
            ok(res, resolution.payload)
          })
          .catch(() => {
            // fetchCatalog never rejects across sources; this is a last-resort
            // fence so the panel always gets an envelope.
            fail(res, 500, 'io', { code: 'route.catalogFailed', text: 'could not fetch the catalog; try again later' })
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/installed`,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        const profileDir = join(resolveDshHome(), 'profiles', deps.profile)
        const view = readInstalled(profileDir, deps.profile)
        // First paint: the default answer is the local facts alone (manifest
        // deps, node_modules versions, suite/entry/enabled state, patch layer)
        // — a disk read that never waits on the registry.
        if (!wantsUpdates(req.url)) {
          ok(res, view)
          return
        }
        // `?updates=1` layers the update facts on top: the 5-minute in-memory
        // cache keeps repeat opens off the registry, the probe batch is
        // concurrency-capped and per-probe timed out (see npm.ts), a failed
        // probe degrades to "unknown" per package, and two groups are skipped
        // — suite packages (the shell owns their lifecycle) and local/git
        // installs (the registry knows nothing about them, and probing would
        // only let the panel offer an update that overwrites the local
        // version with the npm release).
        const probe = deps.latestVersions ?? latestVersionsOf
        void probe(view.packages.filter(pkg => !pkg.suite && pkg.source === 'registry').map(pkg => pkg.name))
          .then((latest) => { ok(res, withUpdateFacts(view, latest)) })
          .catch(() => { ok(res, view) })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/install`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then((body) => {
            const name = validatePackageName(body.package)
            // Same-name guard: the npm name is not an identity — the
            // normalized repo key is. The panel sends the catalog entry's
            // claim; repoKeyOf re-derives the canonical key so a tampered or
            // absent claim degrades to the unknown side. A local/git dev
            // install or a repo mismatch (unknown side included) reads as a
            // different plugin sharing the name and requires the explicit
            // `force` confirmation; see installGateOf for the verdict texts.
            const profileDir = join(resolveDshHome(), 'profiles', deps.profile)
            const current = readInstalled(profileDir, deps.profile).packages.find(pkg => pkg.name === name)
            const incomingRepoKey = repoKeyOf(typeof body.repoKey === 'string' ? body.repoKey : null)
            const gate = installGateOf(current, incomingRepoKey, body.force === true)
            if (gate.action === 'refuse') throw new MarketValidationError(gate.reason)
            if (gate.action === 'confirm') log(gate.log)
            const replacedLocal = gate.action === 'confirm' && current !== undefined && current.source !== 'registry'
            return deps.installer.install(name, body.version).then(result => ({ result, replacedLocal }))
          })
          .then(({ result, replacedLocal }) => {
            ok(res, {
              installed: true,
              version: result.version,
              output: result.output,
              ...(replacedLocal ? { replacedLocal: true } : {}),
              ...(result.blockedBuilds !== undefined ? { blockedBuilds: result.blockedBuilds } : {}),
            })
          })
          .catch((error: unknown) => {
            const mapped = errorStatus(error)
            fail(res, mapped.status, mapped.code, mapped.host, errorExtras(error))
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/allow-build`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then(async (body) => {
            const name = validatePackageName(body.package)
            const allowed = sanitizePackageList(body.packages)
            // The retry reinstalls from npm, so a local/git install must never
            // be its target — the same guard as /install, without a force
            // escape: allow-build retries a blocked npm install, which a
            // locally installed version can never have been.
            const profileDir = join(resolveDshHome(), 'profiles', deps.profile)
            const current = readInstalled(profileDir, deps.profile).packages.find(pkg => pkg.name === name)
            if (current !== undefined && current.source !== 'registry') {
              throw new MarketValidationError({
                code: 'allowBuild.localOrGit',
                text: 'this plugin is installed locally or from Git, so it cannot be reinstalled from npm to allow build scripts',
              })
            }
            const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
            // The whitelist write is a profile mutation like any install, so
            // it runs under the installer's own mutex. The retry is chained
            // AFTER the exclusive section rather than nested inside it — the
            // mutex is not reentrant, and install() enqueues on it too.
            await deps.installer.exclusive(async () => {
              if (allowBuilds(workspacePath, allowed)) {
                log(`plugin-market: allowed build scripts for ${allowed.join(', ')} in profile ${deps.profile}`)
              }
            })
            const result = await deps.installer.install(name)
            return {
              allowed,
              installed: true,
              version: result.version,
              output: result.output,
              ...(result.blockedBuilds !== undefined ? { blockedBuilds: result.blockedBuilds } : {}),
            }
          })
          .then((value) => { ok(res, value) })
          .catch((error: unknown) => {
            const mapped = errorStatus(error)
            fail(res, mapped.status, mapped.code, mapped.host, errorExtras(error))
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/toggle`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then((body) => {
            // Read-modify-write on the patch file is serialized so concurrent
            // panel switches can never interleave (mirrors the installer queue).
            const next = toggleChain.then(() => runToggle(body), () => runToggle(body))
            toggleChain = next.catch(() => undefined)
            return next
          })
          .then((value) => { ok(res, value) })
          .catch((error: unknown) => {
            const mapped = errorStatus(error)
            fail(res, mapped.status, mapped.code, mapped.host)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/uninstall`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then((body) => deps.installer.uninstall(body.package))
          .then((result) => {
            ok(res, { installed: false, output: result.output })
          })
          .catch((error: unknown) => {
            const mapped = errorStatus(error)
            fail(res, mapped.status, mapped.code, mapped.host)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/update`,
      handler: (req, res) => {
        if (!guard(req, res, 'POST')) return
        void readJsonBody(req)
          .then(async (body) => {
            const name = validatePackageName(body.package)
            // Update = install at the registry's latest, but only after the
            // server-side gate confirms the package really is installed and
            // outdated — the panel's badge is a hint, never the authority.
            const profileDir = join(resolveDshHome(), 'profiles', deps.profile)
            const installed = readInstalled(profileDir, deps.profile)
            const current = installed.packages.find(pkg => pkg.name === name)
            const check = checkUpdateTarget(current, await latestVersionOf(name))
            if (!check.ok) throw new MarketValidationError(check.reason)
            return deps.installer.install(name, check.version)
          })
          .then((result) => {
            ok(res, {
              updated: true,
              version: result.version,
              output: result.output,
              ...(result.blockedBuilds !== undefined ? { blockedBuilds: result.blockedBuilds } : {}),
            })
          })
          .catch((error: unknown) => {
            const mapped = errorStatus(error)
            fail(res, mapped.status, mapped.code, mapped.host, errorExtras(error))
          })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
