/**
 * Typed client for the market's host routes. Same-origin fetch against the
 * dsh web server; the host fence admits loopback-Host requests, which every
 * same-origin browser request is.
 */

/**
 * The plugin's route prefix on the dsh web server (mirrors the host half;
 * the /api segment keeps clear of the loader-owned client.js bundle route).
 */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-market/api'

/** One market API failure. */
export class MarketApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Package names pnpm skipped builds for (present on blocked-builds failures). */
    readonly blockedBuilds?: readonly string[],
  ) {
    super(message)
  }
}

/** Envelope of every market answer. */
interface MarketEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string, message: string, blockedBuilds?: readonly string[] }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json() as MarketEnvelope<T>
  if (!body.ok || body.value === undefined) {
    throw new MarketApiError(
      body.error?.code ?? 'unknown',
      body.error?.message ?? `HTTP ${String(response.status)}`,
      body.error?.blockedBuilds,
    )
  }
  return body.value
}

/** One browsable catalog entry (mirror of the host's CatalogEntry). */
export interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly package: string
  readonly version?: string
  readonly homepage?: string
  /**
   * Normalized repo identity (`host/owner/repo`) the host derives from the
   * entry's homepage — the key the panel's same-name checks compare (absent
   * when the source declares no repo page).
   */
  readonly repoKey?: string
  /** Category display label (zh preferred); absent = uncategorized. */
  readonly category?: string
  /**
   * Stable category key (the source's raw id) the panel filters on; entries
   * persisted before the field existed fall back to the label as the key.
   */
  readonly categoryId?: string
  /** Source-declared author/maintainer handle (display only). */
  readonly owner?: string
  /** False = source-only row without an npm package (install disabled). */
  readonly installable?: boolean
  /** Source-declared star count (community schemas; display only). */
  readonly stars?: number
  /** Store-declared 30-day install count (only the store schema carries it). */
  readonly installs30d?: number
}

/**
 * Where an installed package's dependency spec points. Local/git packages are
 * user-managed development installs: no registry probe, no update offer, and
 * an install over them requires explicit force server-side.
 */
export type PackageSource = 'local' | 'git' | 'registry'

/** One installed package (mirror of the host's InstalledPackageView). */
export interface InstalledPackage {
  readonly name: string
  readonly version: string
  readonly bundled: boolean
  /** True = @dsh-app suite package (toggling is a no-op; the shell manages it). */
  readonly suite: boolean
  /** False = the profile patch layer disables this entry. */
  readonly enabled: boolean
  /** The composed entry id the disable patch targets. */
  readonly entryId: string
  /** The version recorded in the package's own manifest (absent = unreadable). */
  readonly installedVersion?: string
  /** What the dependency spec points at (drives the local-version badges). */
  readonly source: PackageSource
  /**
   * Normalized repo identity from the package's own manifest — present when
   * a repo URL exists; the panel compares it against a catalog entry's key.
   */
  readonly repoKey?: string
  /** Registry `latest` at query time (absent = unknown or the lookup failed). */
  readonly latest?: string
  /** True only when both versions are known and latest sorts above installed. */
  readonly updateAvailable?: boolean
}

/** GET /sources + PUT /sources payloads. */
export interface SourcesValue {
  readonly sources: string[]
}

/** GET /catalog payload (flags mark which mode produced it). */
export interface CatalogValue {
  readonly plugins: readonly CatalogEntry[]
  readonly failed: ReadonlyArray<{ url: string, reason: string }>
  readonly sources: readonly string[]
  /** Snapshot time of the served data (cache write moment, or the fetch moment). */
  readonly cachedAt?: number
  /** True = answered from a cache inside the host's TTL window. */
  readonly cached?: boolean
  /** True = every live fetch failed and a stale cache rescued the response. */
  readonly stale?: boolean
  /** True = no cache existed and the bundled offline snapshot is served. */
  readonly snapshot?: boolean
  /** ISO generation timestamp of the served offline snapshot. */
  readonly snapshotAt?: string
}

/** GET /installed payload. */
export interface InstalledValue {
  readonly profile: string
  readonly packages: readonly InstalledPackage[]
  readonly manifestAvailable: boolean
}

/** POST /install + POST /uninstall + POST /update payloads. */
export interface InstallValue {
  readonly installed: boolean
  readonly version?: string
  readonly output: string
  /**
   * Package names whose build scripts pnpm skipped (present only when a
   * blocked signal was in the install output; possibly empty when the message
   * named nothing parseable).
   */
  readonly blockedBuilds?: readonly string[]
  /** True = this install replaced a local/git-installed version (force). */
  readonly replacedLocal?: boolean
}

/** POST /update payload. */
export interface UpdateValue {
  readonly updated: boolean
  readonly version?: string
  readonly output: string
  readonly blockedBuilds?: readonly string[]
}

/** POST /allow-build payload (the retry's result). */
export interface AllowBuildValue {
  readonly allowed: readonly string[]
  readonly installed: boolean
  readonly version?: string
  readonly output: string
  readonly blockedBuilds?: readonly string[]
}

/** POST /toggle payload. */
export interface ToggleValue {
  readonly package: string
  readonly entryId: string
  /** The state AFTER the toggle. */
  readonly enabled: boolean
}

/** Host of the paged preset source (its panel row explains the top-100 slice). */
export const PAGED_SOURCE_HOST = 'deepseek1024.com'

/** The market API face. */
export const marketApi = {
  sources(): Promise<SourcesValue> {
    return request<SourcesValue>(`${ROUTE_PREFIX}/sources`)
  },
  saveSources(urls: readonly string[]): Promise<SourcesValue> {
    return request<SourcesValue>(`${ROUTE_PREFIX}/sources`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: urls }),
    })
  },
  /** Live catalog; `refresh` skips the host cache and forces a source fetch. */
  catalog(refresh = false): Promise<CatalogValue> {
    return request<CatalogValue>(refresh ? `${ROUTE_PREFIX}/catalog?refresh=1` : `${ROUTE_PREFIX}/catalog`)
  },
  /**
   * Installed view. Without `updates` the host answers the local facts alone
   * (no registry round-trips), so the panel can render the list immediately;
   * `updates: true` asks again for the latest/updateAvailable fields the
   * badges need.
   */
  installed(updates = false): Promise<InstalledValue> {
    return request<InstalledValue>(`${ROUTE_PREFIX}/installed${updates ? '?updates=1' : ''}`)
  },
  /**
   * Install `pkg` from the registry. `force` confirms a same-name replacement
   * the host's gate will not do silently (a local/git install or a repo
   * mismatch — an unknown side included); `repoKey` carries the incoming
   * entry's normalized repo key so the gate's refusal and log name both sides.
   */
  install(pkg: string, version?: string, force?: boolean, repoKey?: string): Promise<InstallValue> {
    return request<InstallValue>(`${ROUTE_PREFIX}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: pkg,
        ...(version !== undefined ? { version } : {}),
        ...(force === true ? { force: true } : {}),
        ...(repoKey !== undefined ? { repoKey } : {}),
      }),
    })
  },
  /**
   * Merge `packages` into the profile's pnpm build-script whitelist, then
   * re-run the install for `pkg` (the retry after a blocked-builds result).
   */
  allowBuild(pkg: string, packages: readonly string[]): Promise<AllowBuildValue> {
    return request<AllowBuildValue>(`${ROUTE_PREFIX}/allow-build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: pkg, packages: [...packages] }),
    })
  },
  uninstall(pkg: string): Promise<InstallValue> {
    return request<InstallValue>(`${ROUTE_PREFIX}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: pkg }),
    })
  },
  /** Update one installed package to the registry's latest (server-gated). */
  update(pkg: string): Promise<UpdateValue> {
    return request<UpdateValue>(`${ROUTE_PREFIX}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: pkg }),
    })
  },
  toggle(pkg: string, entryId: string, enable: boolean): Promise<ToggleValue> {
    return request<ToggleValue>(`${ROUTE_PREFIX}/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: pkg, entryId, enable }),
    })
  },
}
