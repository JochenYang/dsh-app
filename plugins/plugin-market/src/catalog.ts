/**
 * Catalog sources: fetching, validation, and merging.
 *
 * A catalog source is an https URL answering a JSON document. Four document
 * formats are accepted, decided by sniffing the first object entry of the
 * `plugins` array (and, for format 1, by its own `format` declaration):
 *
 * 1. Custom schema (the suite's own directory format):
 *      { "plugins": [{ "id": string, "name": string, "description": string,
 *        "package": string, "version"?: string, "homepage"?: string }] }
 * 2. Aggregated directory schema (large community directories): entries
 *      describe source-published plugins with `category` ids and an OPTIONAL
 *      `npm` name (`{ en, zh }` localized description, a category map at the
 *      top level). Entries without a usable npm name degrade to non-installable
 *      "source-only" rows instead of being dropped — they are still browsable.
 * 3. Store directory schema (the second preset source, a paged community
 *      store): entries carry a store id, a repository `url`, a string
 *      `category` id, an `{ en, zh }` description and an install COMMAND
 *      (`dsh plugin --profile <p> add <target>`) instead of an npm field. Only
 *      the npm identity is extracted from the command's trailing token — the
 *      command itself is never retained or executed. Targets that are not npm
 *      package names (e.g. git specifiers) degrade to source-only rows keyed
 *      by the store entry id. The categories map arrives as an ARRAY of
 *      `{ id, en, zh, count }`. The preset URL pins the first page
 *      (`page=1&limit=100`), so this source shows its top-100 slice.
 * 4. Format-1 index (`{ "format": 1, "title", "description", "metadata",
 *      "plugins": [...] }`), the published-index shape the newest community
 *      directories serve: it declares itself, so it is detected by `format`
 *      rather than sniffed. Entries carry the npm `name`, a human `title`
 *      (`owner/repo`), an `{ en, zh }` description, `repository.url`,
 *      `metadata.category` and a `versions` array — npm-only by construction,
 *      so a row whose `name` is not a valid npm package name is DROPPED rather
 *      than kept as a source-only row (there is no other install target in
 *      this shape, and a wrong one is worse than a missing row). The category
 *      map is `{ id: { title: { en, zh } } }`.
 *
 * Security stance: a source is DATA ONLY. Entries are validated field by
 * field and anything unusable is dropped (never executed, never followed);
 * a failed source is reported per-source and never blocks the others. The
 * `version` a source declares is display metadata only — the install chain
 * resolves versions from the npm registry (see npm.ts), and it re-validates
 * the package name so a non-installable entry's surrogate key can never reach
 * the CLI.
 *
 * Address stance: a source URL must be an https URL naming a globally
 * routable destination. A literal private host is refused at validation, and a
 * hostname whose answers are private is refused at request time — the policy,
 * and the one deliberate exception (the RFC 2544 block a TUN/fake-IP network
 * answers for every name), live in `src/source-address.ts`. The npm-package
 * source has TWO source-controlled hops (the registry's metadata URL and the
 * `dist.tarball` URL that metadata names) and both are held to the same
 * policy, failing closed on anything that cannot be judged; neither hop
 * follows a redirect blindly — see {@link judgedFetch}. The one public-address
 * gap this leaves open, and it is shared with the suite's fetch provider, is
 * recorded in `src/source-address.ts` (an IPv4-compatible literal).
 *
 * Byte stance: every response this module reads — a directory document, the
 * registry metadata, the tarball — is read through {@link readBodyCapped}, so
 * a source that passes the address policy still cannot make the kernel child
 * buffer an unbounded body. The three caps differ because the three reads do.
 *
 * @module @dsh-app/plugin-market/catalog
 */

import { lookup } from 'node:dns/promises'
import { gunzipSync } from 'node:zlib'
import { MarketExecutionError, type HostText } from './errors.ts'
import { PACKAGE_NAME_PATTERN, REGISTRY_MAX_BYTES } from './npm.ts'
import {
  blockedAddressOf,
  literalAddressOf,
  literalAddressReason,
  privateResolutionReason,
  unresolvedReason,
  type AddressResolver,
} from './source-address.ts'

/**
 * The offline-snapshot source: `scripts/generate-market-snapshot.mjs` fetches
 * this document to build the plugin's bundled recovery snapshot
 * (`src/catalog-snapshot.json`), and `src/snapshot-builder.ts` labels it. NOT a
 * preset source any more (removed from {@link DEFAULT_SOURCE_URLS} on
 * 2026-10-11): the host is GitHub Pages behind Fastly, which public proxies
 * refuse (hostnames outside github.com) and a mainland link without a proxy
 * serves in 6-8 s for 5 MB — an expired catalog open waited on it and was the
 * reported "the market takes forever to open". The npm mirror below carries the
 * byte-identical document (verified 2026-10-11: sha256 equal), so dropping this
 * from the live source list costs at most a day of entry lag; a user who wants
 * it back adds it on the panel's Sources tab.
 */
export const DEFAULT_SOURCE_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/**
 * The catalog as a format-1 index on a global CDN — the live source list's
 * FIRST entry, and the only one that ships enabled besides the community store.
 *
 * Why this and not the npm-package source below. Both read the SAME published
 * package (`dsh-plugin-catalog`), but the transports are not comparable: the
 * package source costs a registry manifest plus a tarball, while jsDelivr
 * serves the index as one immutable file from an edge cache. Measured
 * 2026-10-28 on the reporter's link, `/catalog` being the open that stalls:
 *
 *   jsDelivr index.json   610 KB transferred / 2.83 MB JSON  ~4.9 s
 *   jsDelivr plugins.json 1.66 MB transferred / 9.07 MB JSON ~9.1 s
 *   Tencent metadata+tgz  0.28 MB + 966 KB of a 1.2 MB tarball in 58 s, then reset
 *
 * The index carries 3730 rows and every one of them is npm-installable (its
 * `versions[].source.type` is `npm`), which is exactly the set this market can
 * install. The tarball's `plugins.json` carries 7406 rows — the extra ~3.6k are
 * source-only rows it browses but cannot install, plus 106 npm rows the index
 * does not list yet. That 106 is the price of the transport, and it is
 * recoverable per user: the npm-package source ({@link NPM_PACKAGE_SOURCE_URL})
 * stays valid input on the Sources tab.
 *
 * `Promise.all` in `resolveCatalog` means ONE slow source delays the whole
 * open, so this cannot be an addition beside the tarball source — it replaces
 * it in the seed list. jsDelivr is a public CDN with edges on every continent,
 * which is the "fast from anywhere" property the mirror chain could not give.
 */
export const DEFAULT_INDEX_SOURCE_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'

/**
 * The catalog as a PUBLISHED NPM PACKAGE, read through a China npm mirror.
 *
 * The COMPREHENSIVE directory, and the reason the index source above exists: it
 * carries the same document the GitHub-Pages origin ({@link DEFAULT_SOURCE_URL})
 * serves — published there daily, byte-identical (verified 2026-10-11: sha256
 * equal) — but rides the same mirror every plugin install already uses, and the
 * package carries a meaningful version that doubles as the cache validator (skip
 * the tarball entirely when the held version matches).
 *
 * NOT in {@link DEFAULT_SOURCE_URLS} any more (2026-10-28): it is a two-hop
 * transport ending in a tarball, and the tarball is what stalled the panel open
 * (measured: 966 KB of 1.2 MB in 58 s, then a reset). Kept exported because the
 * address stays valid input on the Sources tab, and because
 * {@link DEFAULT_CATALOG_PACKAGE} is still what the index is published from.
 */
export const DEFAULT_CATALOG_PACKAGE = 'dsh-plugin-catalog'

/** The China npm mirror the package catalog is read through (no trailing slash). */
export const DEFAULT_NPM_MIRROR = 'https://mirrors.cloud.tencent.com/npm'

/**
 * The secondary preset: a China-reachable community store. The URL pins the
 * first page only — full pagination is deliberately out of scope (a 13k-entry
 * catalog would blow every entry cap for no browsing benefit; the panel is a
 * discovery surface, the index source above stays the comprehensive one).
 */
export const DEFAULT_SECONDARY_SOURCE_URL = 'https://deepseek1024.com/api/v2/plugins?page=1&limit=100'

/**
 * The scheme-prefixed address of the npm-package catalog source. Not a real
 * URL — `validateSourceUrl` special-cases the scheme — but it keeps every
 * source (whatever its transport) behind one list, one cache and one UI.
 */
export const NPM_PACKAGE_SOURCE_URL = `npm:${DEFAULT_CATALOG_PACKAGE}@${DEFAULT_NPM_MIRROR}`

/**
 * Fresh-store seed list (first run only; user-removable).
 *
 * Two sources, both reachable without a proxy. The format-1 index on jsDelivr
 * leads — one file off a global CDN, ~610 KB on the wire — and the community
 * store follows. The npm-package source is deliberately ABSENT: it is the
 * fastest COMPLETE mirror on a domestic link and simultaneously the slowest
 * thing this list has ever carried (a 1.2 MB tarball that stalls), and because
 * one open waits on every source, its presence decides the panel's open time.
 * The GitHub-Pages origin ({@link DEFAULT_SOURCE_URL}) stays absent for the
 * reason its own doc comment gives: it is the snapshot builder's fetch source,
 * and a 5 MB body is not what an expired open should wait on.
 */
export const DEFAULT_SOURCE_URLS: readonly string[] = [DEFAULT_INDEX_SOURCE_URL, DEFAULT_SECONDARY_SOURCE_URL]

/** One browsable catalog entry (already validated). */
export interface CatalogEntry {
  /** Stable entry id from the source (display/stability only). */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** One-line description. */
  readonly description: string
  /**
   * npm package name — the merge/dedupe key and the install target. For
   * source-only entries this is a surrogate key (their source page) and the
   * install chain rejects it again if it ever leaves the panel.
   */
  readonly package: string
  /** Source-declared version (display only, never installed verbatim). */
  readonly version?: string
  /** Source-declared homepage (display only, never navigated to here). */
  readonly homepage?: string
  /**
   * Normalized repo identity (`host/owner/repo`, lowercase) derived from
   * `homepage` when it points at github/gitlab/gitee — the key the same-name
   * origin checks compare, since the npm name alone is not an identity.
   * Optional: a source without a repo page has none, and entries persisted
   * before the field existed are recomputed at payload assembly time.
   */
  readonly repoKey?: string
  /** Category display label (zh preferred; absent = uncategorized). */
  readonly category?: string
  /**
   * Stable category key (the source's raw id) the panel filters on — the
   * display label is presentation and may drift between refreshes, so a
   * filter value must never be the label itself when an id exists. Entries
   * persisted before the field existed carry only the label and fall back to
   * it as the key.
   */
  readonly categoryId?: string
  /** Source-declared author/maintainer handle (display only). */
  readonly owner?: string
  /** Whether the entry carries an installable npm package (custom-schema sources always do). */
  readonly installable?: boolean
  /**
   * GitHub install target for an entry with no npm package (`github:owner/repo`,
   * optionally `#<40-hex commit>`). Present only when the source's install
   * command named one; the install chain re-validates it and pins the commit,
   * so a mutable selector can never reach the CLI from here.
   */
  readonly gitTarget?: string
  /** Source-declared star count (community schemas; display only). */
  readonly stars?: number
  /**
   * Source-declared npm downloads over the source's reporting window (the
   * npm-mirror catalog schema; display and search-ranking only). Absent
   * means the source does not track it for this entry — a coverage gap,
   * never a zero.
   */
  readonly downloads?: number
  /** Store-declared 30-day install count (only the store schema carries it; display only). */
  readonly installs30d?: number
}

/**
 * The seed list a build BEFORE 2026-10-28 wrote, kept so it can be recognised.
 *
 * Existing installations keep their stored `sources.json` — the preset list is
 * first-run only — and every one of them carries this pair, which is why the
 * panel open would stay slow after the default changed. `loadSources` therefore
 * upgrades a list that is EXACTLY this pair (an untouched install, not a
 * decision) and leaves every other list alone; see its doc comment. Bump this
 * constant, never the semantics, if the presets change again.
 */
export const LEGACY_SOURCE_URLS: readonly string[] = [NPM_PACKAGE_SOURCE_URL, DEFAULT_SECONDARY_SOURCE_URL]

/** Per-source fetch cap: large aggregated directories clock in around 3 MB. */
export const MAX_BYTES_PER_SOURCE = 8_000_000

/**
 * Per-source entry cap: real aggregated directories carry thousands of rows;
 * the panel paginates its rendering, so the host can pass them through.
 */
export const MAX_ENTRIES_PER_SOURCE = 5000

/** Merged-catalog cap across all sources. */
export const MAX_ENTRIES_TOTAL = 8000

/** Allowed source-list size. */
export const MAX_SOURCES = 20

/** Single URL length cap (sanity, not a security boundary). */
const MAX_URL_LENGTH = 500

/**
 * Catalog fetch timeout (ms). Large sources on slow links need real headroom —
 * the 3.3 MB primary source clocks ~2.5 s on a healthy link, and the previous
 * 10 s cap was the main cause of "This operation was aborted" failures.
 */
export const CATALOG_TIMEOUT_MS = 30_000

/** String field cap inside one entry. */
const MAX_FIELD_LENGTH = 400

/** npm's own name length cap — the package field carries a package name. */
const MAX_NAME_LENGTH = 214

/**
 * Validate one user-supplied source URL.
 *
 * The URL half of the source-address policy lives here (a literal private,
 * loopback or link-local host is refused, both in an https source and in an
 * npm registry base); the resolution half runs at request time in
 * {@link fetchCatalog}, because it needs a resolver and a deadline.
 *
 * @param raw - the client-supplied value.
 * @returns the normalized URL string, or a coded rejection reason.
 */
export function validateSourceUrl(raw: unknown): { ok: true, url: string } | { ok: false, reason: HostText } {
  if (typeof raw !== 'string') return { ok: false, reason: { code: 'source.notString', text: 'a catalog source URL must be a string' } }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: { code: 'source.empty', text: 'a catalog source URL cannot be empty' } }
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: { code: 'source.tooLong', text: 'the catalog source URL is too long' } }
  // The npm-package catalog source: `npm:<pkg>@<registry-base>`. The package
  // name is UN Scoped by design here (the catalog package is not): the
  // registry must be https so the same transport guarantees hold, and a
  // registry carrying credentials is refused by the grammar (no '@' inside).
  if (trimmed.startsWith('npm:')) {
    const match = /^npm:([a-z0-9-~][a-z0-9-._~]*)(@https:\/\/[a-z0-9.-]+(?:\.\S+)?\/?)?$/i.exec(trimmed)
    if (match === null) {
      return { ok: false, reason: { code: 'source.npmShape', text: 'an npm catalog source must read npm:<package>@<https registry base>' } }
    }
    const registry = (match[2] ?? `@${DEFAULT_NPM_MIRROR}`).slice(1)
    // The registry base is user input like any other host: a literal private
    // address there is refused on the same grounds as one in an https source
    // (the default mirror and every public registry pass untouched).
    const registryLiteral = registryHostOf(registry)
    const registryReason = registryLiteral === undefined ? undefined : literalAddressReason(registryLiteral)
    if (registryReason !== undefined) return { ok: false, reason: registryReason }
    return { ok: true, url: trimmed }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return {
      ok: false,
      reason: { code: 'source.unparsable', params: { url: trimmed }, text: `the catalog source URL cannot be parsed: "${trimmed}"` },
    }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: { code: 'source.notHttps', text: 'a catalog source must be an https:// URL' } }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: { code: 'source.hasCredentials', text: 'a catalog source URL must not carry a username or password' } }
  }
  const literalReason = literalAddressReason(url.hostname)
  if (literalReason !== undefined) return { ok: false, reason: literalReason }
  return { ok: true, url: url.toString() }
}

/** The hostname of a registry base, or undefined when it does not parse. */
function registryHostOf(registry: string): string | undefined {
  try {
    return new URL(registry).hostname
  } catch {
    return undefined
  }
}

/** A plain non-empty string within the field cap. */
function plainString(value: unknown, cap = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > cap) return undefined
  return trimmed
}

/**
 * Display-length text for browsable rows: over-length copy truncates with an
 * ellipsis instead of dropping the row — a long description is a presentation
 * concern, not an unusable entry (the entry's page carries the full text).
 */
function displayText(value: unknown, cap = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > cap ? `${trimmed.slice(0, cap - 1)}…` : trimmed
}

/** Localized `{ en, zh }` display text: zh wins, en is the fallback. */
function localizedText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return displayText(value)
  const record = value as Record<string, unknown>
  return displayText(record.zh) ?? displayText(record.en)
}

/** Top-level category map of an aggregated document, keyed by category id. */
function categoryMapOf(value: unknown): ReadonlyMap<string, { zh?: string, en?: string }> {
  const map = new Map<string, { zh?: string, en?: string }>()
  if (typeof value !== 'object' || value === null) return map
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    map.set(id, { zh: plainString(record.zh), en: plainString(record.en) })
  }
  return map
}

/** Resolved category of one entry: the stable id plus its display label. */
interface CategoryRef {
  readonly id: string
  /** Display label: map's zh → map's en → the raw id (fallback chain). */
  readonly label: string
}

/**
 * Category id + display label, or undefined when the entry is uncategorized.
 * An explicit `categoryId` (the self-describing shape the bundled snapshot
 * emits) wins over the `category` field, which then carries the display
 * label: the label is presentation and must never become the filter key when
 * a stable id is present. Sources that predate the field keep the raw
 * `category` value as the id and resolve it through the document's map.
 */
function categoryOf(
  raw: unknown,
  categories: ReadonlyMap<string, { zh?: string, en?: string }>,
  explicitId?: unknown,
): CategoryRef | undefined {
  const rawText = plainString(raw, 100)
  const id = plainString(explicitId, 100) ?? rawText
  if (id === undefined) return undefined
  const known = categories.get(id)
  return { id, label: known?.zh ?? known?.en ?? rawText ?? id }
}

/**
 * Format sniff, store schema first. Two markers together identify a store
 * document: its category map is an ARRAY (aggregated directories publish an
 * OBJECT map keyed by id) and its rows carry an install COMMAND string.
 * Sniff order matters — store entries also carry `category`, which would
 * otherwise misroute them into the aggregated path and strip their npm
 * identity. The categories shape is decisive, not the command alone: the
 * primary directory's rows now carry install commands too, so keying on the
 * command by itself misroutes that document here, where the object category
 * map matches nothing and every entry falls back to its raw id as the label.
 * Documents are homogeneous in practice and every mis-sniff degrades safely:
 * a misrouted row at worst loses installability and stays browsable, never
 * gains a wrong install target.
 */
function isStoreDocument(json: object, plugins: readonly unknown[]): boolean {
  if (!Array.isArray((json as { categories?: unknown }).categories)) return false
  for (const candidate of plugins) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    return typeof record.install === 'string' && record.install.trim().startsWith('dsh plugin ')
  }
  return false
}

/**
 * Format sniff: the first object entry of the plugins array decides the whole
 * document. Aggregated entries carry `npm` (possibly null) and/or `category`;
 * a custom-schema entry has neither. Documents are homogeneous in practice and
 * a mis-sniff degrades safely: an aggregated document misread as custom loses
 * every row (their missing `package` fails validation), and a custom document
 * with stray `npm`/`category` fields displays as source-only rows — neither
 * direction can produce a wrong install target.
 */
function isAggregatedDocument(plugins: readonly unknown[]): boolean {
  for (const candidate of plugins) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    return 'npm' in record || 'category' in record
  }
  return false
}

/**
 * Format-1 index detection. Gated on the document's OWN `format: 1`
 * declaration, then confirmed on the first object entry (`name` + a `versions`
 * array), so a future `format: 2` document — which this parser has never seen —
 * falls through to the other sniffs and degrades to "no rows" instead of being
 * read as though it were today's shape. Both halves are needed: the declaration
 * alone would accept a document whose entries changed under the same number,
 * and the entry shape alone would accept anything that happens to carry
 * `versions`.
 */
function isIndexDocument(json: object, plugins: readonly unknown[]): boolean {
  if ((json as { format?: unknown }).format !== 1) return false
  for (const candidate of plugins) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    return typeof record.name === 'string' && Array.isArray(record.versions)
  }
  return false
}

/**
 * Validate one already-parsed catalog document. The shared entry point for
 * fetched bodies (parseCatalog) and the bundled offline snapshot (snapshot.ts)
 * — both flow through the same per-field validation, so a snapshot entry can
 * never be weaker than a fetched one.
 * @param json - the parsed document.
 * @returns the valid entries; per-entry failures are dropped silently here —
 *   the caller surfaces the count through `parseCatalog`.
 */
export function parseCatalogDocument(json: unknown): CatalogEntry[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return []
  const plugins = (json as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return []
  // The declared-format branch goes first: a format-1 document also carries
  // `name`-only entries, which the custom path would drop and the aggregated
  // path would misread.
  if (isIndexDocument(json, plugins)) return indexEntriesOf(json, plugins)
  if (isStoreDocument(json, plugins)) return storeEntriesOf(json, plugins)
  if (isAggregatedDocument(plugins)) return aggregatedEntriesOf(json, plugins)
  return customEntriesOf(plugins)
}

/** Custom-schema path: every entry carries a real npm package name. */
function customEntriesOf(plugins: readonly unknown[]): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const candidate of plugins) {
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const pkg = plainString(record.package, MAX_NAME_LENGTH)
    // The package name is re-checked against the npm grammar here: it is the
    // key the install chain will act on, so a source cannot smuggle a
    // malformed string through as an install target.
    if (pkg === undefined || !PACKAGE_NAME_PATTERN.test(pkg)) continue
    const name = plainString(record.name)
    const description = plainString(record.description)
    if (name === undefined || description === undefined) continue
    const homepage = plainString(record.homepage)
    if (homepage !== undefined && !/^https?:\/\//.test(homepage)) continue
    const version = plainString(record.version, 100)
    entries.push({
      id: plainString(record.id) ?? pkg,
      name,
      description,
      package: pkg,
      ...(version !== undefined ? { version } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
    })
  }
  return entries
}

/**
 * Aggregated-directory path. Entries without a usable npm name stay browsable
 * as source-only rows (`installable: false`, deduped by their source page);
 * only entries missing name/description are dropped.
 */
function aggregatedEntriesOf(json: object, plugins: readonly unknown[]): CatalogEntry[] {
  const categories = categoryMapOf((json as { categories?: unknown }).categories)
  const entries: CatalogEntry[] = []
  for (const candidate of plugins) {
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const name = plainString(record.name)
    const description = localizedText(record.description)
    if (name === undefined || description === undefined) continue
    const page = plainString(record.page)
    const rawHomepage = plainString(record.url)
    const homepage = rawHomepage !== undefined && /^https?:\/\//.test(rawHomepage) ? rawHomepage : undefined
    const npm = plainString(record.npm, MAX_NAME_LENGTH)
    const npmValid = npm !== undefined && PACKAGE_NAME_PATTERN.test(npm)
    // A row with no npm package can still be installable: the aggregated
    // schema's `install` command names the real target, and for `npm: null`
    // entries that target is a GitHub shortcut. Same extraction contract as
    // the store path — the command is never retained or executed.
    const git = gitTargetOf(record.install)
    const installable = npmValid || git !== undefined
    // A name carrying '#' (e.g. `archify#integrations/deepseek-harness`) is a
    // REPO PATH the source uses as an entry id for example/template
    // directories, not a plugin title. Where a real npm name exists, the npm
    // name becomes the display title; entries with no npm name AND a
    // path-shaped name are dropped outright — they are not installable and
    // their "title" is a fragment of a repository tree, never a plugin name.
    let displayName = name
    if (name.includes('#')) {
      if (installable && npmValid && npm !== undefined) displayName = npm
      else continue
    }
    const version = plainString(record.version, 100)
    const owner = plainString(record.owner, 100)
    const stars = safeCountOf(record.stars)
    const downloads = safeCountOf(record.downloads)
    const category = categoryOf(record.category, categories, record.categoryId)
    // The merge/dedupe key stays the npm name where one exists and the
    // directory page otherwise — unchanged by git installability, so merging
    // an npm row and a git row of the same plugin still picks the npm one
    // (source order decides). Source-only rows key on their (stable) page; a
    // git row's key is its page too, with the real target riding `gitTarget`.
    const key = npmValid && npm !== undefined ? npm : (page ?? homepage ?? name)
    const gitTarget = git === undefined ? undefined : `github:${git.repo}${git.commit === undefined ? '' : `#${git.commit}`}`
    entries.push({
      id: page ?? homepage ?? name,
      name: displayName,
      description,
      package: key,
      installable,
      ...(gitTarget !== undefined ? { gitTarget } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(stars !== undefined ? { stars } : {}),
      ...(downloads !== undefined ? { downloads } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
      ...(category !== undefined ? { category: category.label, categoryId: category.id } : {}),
    })
  }
  return entries
}

/**
 * The newest release row of a format-1 entry's `versions` array.
 *
 * The timestamp decides, not array order: the document does not promise an
 * order, and a row that reports an older release as "the version" would show a
 * stale number on a card whose update check then disagrees with it. A row with
 * no timestamp loses to one that has it; the first row wins a tie.
 */
function latestVersionOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  let best: { version: string, at: number } | undefined
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const version = plainString(record.version, 100)
    if (version === undefined) continue
    const at = typeof record.publishTimestamp === 'number' && Number.isFinite(record.publishTimestamp)
      ? record.publishTimestamp
      : Number.NEGATIVE_INFINITY
    if (best === undefined || at > best.at) best = { version, at }
  }
  return best?.version
}

/** Format-1 category map: `{ id: { title: { en, zh } } }` — one level deeper than the aggregated shape. */
function indexCategoryMapOf(value: unknown): ReadonlyMap<string, { zh?: string, en?: string }> {
  const map = new Map<string, { zh?: string, en?: string }>()
  if (typeof value !== 'object' || value === null) return map
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const title = (entry as { title?: unknown }).title
    if (typeof title !== 'object' || title === null) continue
    const record = title as Record<string, unknown>
    map.set(id, { zh: plainString(record.zh), en: plainString(record.en) })
  }
  return map
}

/**
 * Format-1 index path.
 *
 * Every row names an npm package — `versions[].source.type` is `npm` for the
 * whole document — so a row whose `name` is not a valid npm package name is
 * DROPPED rather than kept as a source-only row. That is the opposite of the
 * aggregated path, and deliberate: there a drop would lose a browsable row that
 * other schema fields can still describe, while here there is no other install
 * target anywhere in the shape, so a kept row would be one the panel cannot
 * install and cannot explain.
 *
 * Field mapping, and the two choices that are not obvious:
 * - `id` ← `homepage`: the directory page is stable per row and is what a
 *   duplicate report names.
 * - `homepage` ← `repository.url`, NOT the directory page. `originOf` derives
 *   the repo identity from this field, and the same-name origin check is only
 *   meaningful against the repository (a directory page identifies the catalog
 *   entry, not the code).
 */
function indexEntriesOf(json: object, plugins: readonly unknown[]): CatalogEntry[] {
  const metadata = (json as { metadata?: { categories?: unknown } }).metadata
  const categories = indexCategoryMapOf(metadata?.categories)
  const entries: CatalogEntry[] = []
  for (const candidate of plugins) {
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const pkg = plainString(record.name, MAX_NAME_LENGTH)
    if (pkg === undefined || !PACKAGE_NAME_PATTERN.test(pkg)) continue
    const description = localizedText(record.description)
    if (description === undefined) continue
    const repository = record.repository
    const repoUrl = typeof repository === 'object' && repository !== null
      ? plainString((repository as { url?: unknown }).url)
      : undefined
    const homepage = repoUrl !== undefined && /^https?:\/\//.test(repoUrl) ? repoUrl : undefined
    const page = plainString(record.homepage)
    const title = plainString(record.title, 200)
    const rowMetadata = typeof record.metadata === 'object' && record.metadata !== null
      ? record.metadata as Record<string, unknown>
      : {}
    const category = categoryOf(rowMetadata.category, categories)
    const version = latestVersionOf(record.versions)
    entries.push({
      id: page ?? homepage ?? pkg,
      name: title ?? pkg,
      description,
      package: pkg,
      ...(version !== undefined ? { version } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
      ...(category !== undefined ? { category: category.label, categoryId: category.id } : {}),
    })
  }
  return entries
}

/** Store-schema categories arrive as an array of `{ id, en, zh, count }`. */
function storeCategoryMapOf(value: unknown): ReadonlyMap<string, { zh?: string, en?: string }> {
  const map = new Map<string, { zh?: string, en?: string }>()
  if (!Array.isArray(value)) return map
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = plainString(record.id, 100)
    if (id === undefined) continue
    map.set(id, { zh: plainString(record.zh), en: plainString(record.en) })
  }
  return map
}

/** Non-negative safe integer (install counters; anything else is unusable). */
function safeCountOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

/**
 * Extract the npm identity from a store install command
 * (`dsh plugin --profile <p> add <target>`). Only the trailing target token is
 * consumed — the command is never retained or executed — and a version suffix
 * is stripped scope-aware (`@scope/pkg@1.0.0` vs `pkg@1.0.0`). Targets that are
 * not npm package names (git specifiers, file paths) answer undefined so the
 * row degrades to source-only.
 */
function npmTargetOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const tokens = raw.trim().split(/\s+/)
  if (tokens.length < 4 || tokens[0] !== 'dsh' || tokens[1] !== 'plugin' || tokens[tokens.length - 2] !== 'add') {
    return undefined
  }
  const target = tokens[tokens.length - 1]!
  const searchFrom = target.startsWith('@') ? (target.indexOf('/') + 1 || target.length) : 1
  const at = target.indexOf('@', searchFrom)
  const name = (at === -1 ? target : target.slice(0, at)).trim()
  return name !== '' && PACKAGE_NAME_PATTERN.test(name) ? name : undefined
}

/**
 * Grammar of the ONE git install target this build accepts: a GitHub
 * owner/repository shortcut with an optional commit pin. Deliberately narrow —
 * the catalog's own install commands use exactly this shape (`npm: null` rows
 * carry `dsh plugin … add github:owner/repo`), so anything else (other hosts,
 * `git+https://`, branch or tag selectors, `#path:` monorepo fragments) stays
 * source-only until it is wanted. A commit pin IS accepted and preserved: it is
 * immutable, which is what the install chain wants to hand the CLI verbatim;
 * everything mutable (branches, tags) is refused rather than re-pinned here,
 * because a selector this parser would rewrite is a promise the source made
 * that the install chain cannot keep.
 */
export const GIT_TARGET_PATTERN = /^github:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9-._]{1,100}?)(?:#([0-9a-f]{40}))?$/i

/** The pieces of a validated git install target. */
export interface GitTarget {
  /** Repository slug, `owner/repo`, in the source's own casing. */
  readonly repo: string
  /** 40-hex commit pin, when the source's command carried one. */
  readonly commit?: string
}

/**
 * Extract a git install target from a store install command. Same contract as
 * {@link npmTargetOf}: only the trailing token of `dsh plugin … add <target>`
 * is read, the command itself is never retained or executed, and a non-git
 * target answers undefined so the row keeps its npm path (or degrades to
 * source-only).
 */
export function gitTargetOf(raw: unknown): GitTarget | undefined {
  if (typeof raw !== 'string') return undefined
  const tokens = raw.trim().split(/\s+/)
  if (tokens.length < 4 || tokens[0] !== 'dsh' || tokens[1] !== 'plugin' || tokens[tokens.length - 2] !== 'add') {
    return undefined
  }
  const target = tokens[tokens.length - 1]!
  const match = GIT_TARGET_PATTERN.exec(target)
  if (match === null) return undefined
  return {
    repo: `${match[1]}/${match[2]}`,
    ...(match[3] !== undefined ? { commit: match[3].toLowerCase() } : {}),
  }
}

/**
 * Store-directory path (the second preset source). Entries without a usable
 * npm target stay browsable as source-only rows keyed by the store entry id
 * (unique per row, unlike the repository url several entries may share);
 * only entries missing a name are dropped. A missing description stays empty
 * — the panel renders its own placeholder, and faking one from the name
 * would duplicate the title line in the description slot.
 */
function storeEntriesOf(json: object, plugins: readonly unknown[]): CatalogEntry[] {
  const categories = storeCategoryMapOf((json as { categories?: unknown }).categories)
  const entries: CatalogEntry[] = []
  for (const candidate of plugins) {
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const name = plainString(record.name)
    if (name === undefined) continue
    const description = localizedText(record.description) ?? ''
    const rawHomepage = plainString(record.url)
    const homepage = rawHomepage !== undefined && /^https?:\/\//.test(rawHomepage) ? rawHomepage : undefined
    const category = categoryOf(record.category, categories, record.categoryId)
    const npm = npmTargetOf(record.install)
    const git = gitTargetOf(record.install)
    const installable = npm !== undefined || git !== undefined
    const installs30d = safeCountOf(record.installs30d)
    const owner = plainString(record.owner, 100)
    const stars = safeCountOf(record.stars)
    const id = plainString(record.id, 200) ?? homepage ?? name
    const key = npm ?? id
    const gitTarget = git === undefined ? undefined : `github:${git.repo}${git.commit === undefined ? '' : `#${git.commit}`}`
    entries.push({
      id,
      name,
      description,
      package: key,
      installable,
      ...(gitTarget !== undefined ? { gitTarget } : {}),
      ...(installs30d !== undefined ? { installs30d } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(stars !== undefined ? { stars } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
      ...(category !== undefined ? { category: category.label, categoryId: category.id } : {}),
    })
  }
  return entries
}

/**
 * Parse + validate a fetched source body.
 * @param body - raw response text.
 * @returns valid entries.
 * @throws MarketExecutionError when the body is not a usable catalog object.
 */
export function parseCatalog(body: string): CatalogEntry[] {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new MarketExecutionError(
      { code: 'catalog.notJson', text: 'the catalog source returned unparsable JSON' },
      'catalog',
    )
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new MarketExecutionError(
      { code: 'catalog.notObject', text: 'the catalog source has the wrong shape (expected a JSON object)' },
      'catalog',
    )
  }
  return parseCatalogDocument(json)
}

/**
 * Merge per-source entry lists into one catalog: dedupe by package name with
 * first-source-wins, preserving source order then entry order. Total size is
 * capped.
 * @param lists - one validated list per source, in source order.
 * @returns the merged list.
 */
export function mergeCatalogs(lists: ReadonlyArray<readonly CatalogEntry[]>): CatalogEntry[] {
  const seen = new Set<string>()
  const merged: CatalogEntry[] = []
  for (const list of lists) {
    for (const entry of list) {
      if (merged.length >= MAX_ENTRIES_TOTAL) return merged
      if (seen.has(entry.package)) continue
      seen.add(entry.package)
      merged.push(entry)
    }
  }
  return merged
}

/** Result of fetching one source (failures never throw across sources). */
export type SourceFetchResult =
  | {
    readonly url: string
    readonly entries: readonly CatalogEntry[]
    /** The origin's ETag, when it served one; the cache persists it. */
    readonly etag?: string
    /** The origin's Last-Modified (or, for the npm-package source, the
     *  published package version); the cache persists it. */
    readonly modified?: string
  }
  /** The origin answered "not modified": the caller's cached copy stands.
   *  For the npm-package source the served version rides along. */
  | { readonly url: string, readonly notModified: true, readonly servedVersion?: string }
  | { readonly url: string, readonly reason: HostText }

/** Longest reason detail echoed to the panel; a hostile or huge message is cut. */
const MAX_REASON_DETAIL = 120

/** One capped reason detail. */
function reasonDetail(message: string): string {
  return message.length > MAX_REASON_DETAIL ? `${message.slice(0, MAX_REASON_DETAIL - 3)}…` : message
}

/** One capped read's refusal: the cap is stated in whole MB for the sentence. */
function tooLargeReason(code: string, maxBytes: number): HostText {
  const mb = Math.floor(maxBytes / 1_000_000)
  return { code, params: { mb }, text: `the response exceeds the ${String(mb)} MB cap` }
}

/**
 * Read the response body enforcing the byte cap DURING the transfer, not
 * after: a rogue source must not be able to buffer an unbounded body in host
 * memory before the slice happens. The read stops and the body is cancelled at
 * the chunk that crosses the cap — reading it all in and comparing afterwards
 * would enforce nothing, since the bytes are already resident. Returns BYTES,
 * not text — the caller may need to gunzip (a proxy that strips the encoding
 * header), and a string round-trip through the default UTF-8 TextDecoder
 * destroys those bytes irrecoverably (0x80-0x9F are not valid UTF-8
 * continuations; measured: `Buffer.from(TextDecoder().decode(gz), 'latin1')`
 * does NOT restore the original gzip).
 *
 * @param response - the response whose body to read.
 * @param maxBytes - the cap for THIS read; callers differ (a directory
 *   document, a registry manifest, a package tarball).
 * @param tooLarge - the coded refusal a body past the cap produces.
 * @throws MarketExecutionError carrying `tooLarge` when the cap is crossed.
 */
async function readBodyCapped(response: Response, maxBytes: number, tooLarge: HostText): Promise<Buffer> {
  const body = response.body
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new MarketExecutionError(tooLarge, 'catalog')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Decode a response body that arrived gzip-encoded WITHOUT a declared
 * `content-encoding` — the broken-proxy shape measured on a real machine
 * (the proxy strips response headers, the origin compresses anyway, and
 * undici then hands back raw gzip bytes). When the origin declared the
 * encoding, undici has already decoded it and this passes through. When
 * nothing was declared and the first two bytes are gzip magic (0x1f 0x8b),
 * the bytes are decompressed here — so the old failure mode ("JSON.parse
 * rejects gzip bytes → the source is reported broken") is answered at the
 * transport, in the BYTE layer: a string round-trip of gzip bytes through
 * the UTF-8 TextDecoder is lossy and cannot be recovered afterwards.
 * @param body - the (already size-capped) response bytes.
 * @param declared - the response's own `content-encoding` header, when any.
 * @returns the decoded JSON text.
 */
function maybeGunzip(body: Buffer, declared: string | null): string {
  if (declared !== null && declared !== 'identity') return body.toString('utf8') // undici decoded it
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) return gunzipSync(body).toString('utf8')
  return body.toString('utf8')
}

/** Long enough for a multi-megabyte tarball on a slow link, short enough to fall back. */
const NPM_PACKAGE_TIMEOUT_MS = 20_000

/**
 * The system resolver behind the source-address check — `dns.lookup`, so the
 * hosts file and the platform's own resolver config (including a TUN client's
 * fake-IP answers) are what the check sees.
 *
 * It is deliberately the LOCAL resolver and not a hook on the connection: the
 * request that follows re-resolves the name inside undici — through the
 * dispatcher the kernel installed, which on a desktop start is the proxy the
 * shell injected. See {@link resolveWithinDeadline} and the module header of
 * `src/source-address.ts` for what that costs.
 */
const systemAddressResolver: AddressResolver = async hostname =>
  (await lookup(hostname, { all: true, order: 'verbatim' })).map(entry => entry.address)

/**
 * The resolver's answer for one hostname, or undefined when it failed or the
 * request's deadline expired.
 *
 * The race is what keeps this check from becoming a new way to hang — and why
 * the lookup is not simply awaited: `dns.lookup` takes no signal, so the
 * bounding comes from the deadline timer that already guards the fetch. A
 * resolver failure answers `undefined`, never a rejection; what the CALLER does
 * with that is the policy: the user-typed https source runs the request and
 * lets it fail in its own words (turning a transient NXDOMAIN into "your source
 * points at a private address" would be a lie), while the npm path's
 * source-controlled hops refuse with the honest `source.unresolved` reason
 * (see {@link hopAddressReason}). Neither ever reports a lookup failure as a
 * private answer.
 *
 * @param hostname - the host to resolve.
 * @param resolve - the resolver seam.
 * @param signal - the request's deadline signal.
 * @returns the answer set, or undefined when there is nothing to judge.
 */
function resolveWithinDeadline(
  hostname: string,
  resolve: AddressResolver,
  signal: AbortSignal,
): Promise<readonly string[] | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<readonly string[] | undefined>((settle) => {
    let done = false
    const finish = (value: readonly string[] | undefined): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      settle(value)
    }
    const onAbort = (): void => { finish(undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    resolve(hostname).then(addresses => { finish(addresses) }, () => { finish(undefined) })
  })
}

/**
 * The source-address reason for one hostname, or undefined when it passes.
 *
 * A literal host is judged without a lookup (and a public literal is its own
 * answer set). Everything else is resolved and judged against the same policy:
 * a name that answers with a private, loopback, link-local or metadata address
 * is refused before the request is sent.
 *
 * WHAT THIS COVERS, AND WHAT IT DOES NOT. This is a check-then-connect, not a
 * pin: the request that follows resolves the name again inside undici, so a
 * name that answers differently the second time is not caught here (the suite's
 * fetch provider pins the connection instead, over `node:http(s)`; doing that
 * for the catalog would fork the transfer semantics below — the advertised
 * gzip, the declared-vs-stripped `content-encoding` handling, the byte-capped
 * read — and would have to re-implement the proxy routing, because on a desktop
 * start the shell injects a local proxy and the connection must keep using it).
 * When that proxy is in play, the connection's DNS happens at the PROXY: this
 * check then judges the local resolver's answer alone, and on a TUN/fake-IP
 * machine (every name answers `198.18.0.0/15`) the exception in
 * `src/source-address.ts` lets that answer through. The refusal that still
 * holds on such a machine is the URL half — a literal private host — plus a
 * name the LOCAL resolver answers privately (an intranet name, which is the
 * case a user actually types).
 *
 * @param hostname - the host to judge.
 * @param resolve - the resolver seam.
 * @param signal - the request's deadline signal.
 * @returns the coded reason, or undefined.
 */
async function sourceAddressReason(
  hostname: string,
  resolve: AddressResolver,
  signal: AbortSignal,
): Promise<HostText | undefined> {
  const literal = literalAddressReason(hostname)
  if (literal !== undefined) return literal
  if (literalAddressOf(hostname) !== undefined) return undefined
  const addresses = await resolveWithinDeadline(hostname, resolve, signal)
  if (addresses === undefined) return undefined
  const blocked = blockedAddressOf(addresses)
  return blocked === undefined ? undefined : privateResolutionReason(hostname, blocked.address, blocked.range)
}

/** Statuses that ask a client to fetch somewhere else. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308]

/**
 * The destination judgement for one SOURCE-CONTROLLED hop (the npm path's
 * registry metadata URL and the `dist.tarball` URL its answer names), or
 * undefined when the hop may be sent.
 *
 * Same policy as {@link sourceAddressReason} — a literal is judged on its own,
 * a name on its answers — with two deliberate differences:
 *
 * 1. FAIL CLOSED. A URL that does not parse, a scheme that is not http(s) (a
 *    registry could otherwise answer `dist.tarball: data:…` and have this host
 *    fetch bytes that never crossed the network), and an answer set the
 *    resolver could not produce are all refused. These URLs are the SOURCE's
 *    data, not the user's, and the user cannot check a claim about them: a
 *    refusal that names the host is better than a request nobody judged. The
 *    user-typed https source keeps the opposite default — see
 *    {@link resolveWithinDeadline}.
 * 2. The whole URL is judged, host and scheme together, so the check travels
 *    with the request it guards.
 *
 * @param raw - the absolute URL about to be requested.
 * @param resolve - the resolver seam.
 * @param signal - the request's deadline signal.
 * @returns the coded reason, or undefined.
 */
async function hopAddressReason(
  raw: string,
  resolve: AddressResolver,
  signal: AbortSignal,
): Promise<HostText | undefined> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    const echoed = reasonDetail(raw)
    return { code: 'source.unparsable', params: { url: echoed }, text: `the catalog source URL cannot be parsed: "${echoed}"` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { code: 'source.notHttps', text: 'a catalog source must be an https:// URL' }
  }
  const literal = literalAddressReason(url.hostname)
  if (literal !== undefined) return literal
  // A public literal is its own answer set: nothing to resolve, and no reason
  // a lookup could fail on its behalf (same short-circuit as
  // {@link sourceAddressReason}).
  if (literalAddressOf(url.hostname) !== undefined) return undefined
  const addresses = await resolveWithinDeadline(url.hostname, resolve, signal)
  if (addresses === undefined) {
    // An aborted signal is the request's own deadline, not an unresolvable
    // host: reporting "could not be resolved" for a name the resolver was
    // never given a chance to answer would be the same kind of lie as
    // reporting a private answer.
    if (signal.aborted) {
      const seconds = Math.round(NPM_PACKAGE_TIMEOUT_MS / 1000)
      return { code: 'catalog.timeout', params: { seconds }, text: `the request timed out after ${String(seconds)} seconds` }
    }
    return unresolvedReason(url.hostname)
  }
  const blocked = blockedAddressOf(addresses)
  return blocked === undefined ? undefined : privateResolutionReason(url.hostname, blocked.address, blocked.range)
}

/** One judged hop: the response it produced, or the coded refusal. */
type JudgedHop =
  | { readonly response: Response }
  | { readonly reason: HostText }

/**
 * Send one request whose destination is judged FIRST, following at most ONE
 * redirect of it.
 *
 * Redirects are not refused outright (`redirect: 'error'`) the way the
 * user-typed https source refuses them: a registry mirror legitimately answers
 * a tarball request with a 302 to its own CDN — measured 2026-10-13,
 * `registry.npmmirror.com` answers `302 … cdn.npmmirror.com`, and with
 * `redirect: 'error'` the same source comes back `catalog.requestFailedDetail
 * (fetch failed)` in 107 ms while the Tencent mirror and registry.npmjs.org are
 * unaffected, so refusing the hop outright would break a mirror users actually
 * add — and the tarball URL is the registry's own data, so its destination is
 * judged like the first one. The chain stops there: the second request runs
 * with `redirect: 'error'`, and a 3xx with no usable `Location` is returned
 * as-is (the caller reports its status).
 *
 * @param raw - the URL to request.
 * @param init - request options, minus the signal and the redirect mode.
 * @param resolve - the resolver seam.
 * @param signal - the request's deadline signal.
 * @returns the response, or the reason no request was made.
 */
async function judgedFetch(
  raw: string,
  init: RequestInit,
  resolve: AddressResolver,
  signal: AbortSignal,
): Promise<JudgedHop> {
  const first = await hopAddressReason(raw, resolve, signal)
  if (first !== undefined) return { reason: first }
  const response = await fetch(raw, { ...init, signal, redirect: 'manual' })
  if (!REDIRECT_STATUSES.includes(response.status)) return { response }
  const location = response.headers.get('location')
  if (location === null || location.trim() === '') return { response }
  let target: string
  try {
    target = new URL(location, raw).toString()
  } catch {
    const echoed = reasonDetail(location)
    return { reason: { code: 'source.unparsable', params: { url: echoed }, text: `the catalog source URL cannot be parsed: "${echoed}"` } }
  }
  const second = await hopAddressReason(target, resolve, signal)
  if (second !== undefined) return { reason: second }
  return { response: await fetch(target, { ...init, signal, redirect: 'error' }) }
}

/**
 * Injected seams of the catalog fetch. Tests supply the resolver so the
 * address check runs without a socket.
 */
export interface CatalogFetchDeps {
  /**
   * The resolver behind the source-address check. Defaults to the system
   * resolver.
   */
  readonly resolve?: AddressResolver
}

/* Tar reading constants: 512-byte headers, name at 0, octal size at 124,
 * type flag at 156. Written out rather than pulled from a dependency — a
 * reader for one known filename inside a gzipped tar is smaller than the
 * argument for adding a package to the runtime (and the npm package whose
 * catalog we read ships the same approach, for the same reason). */
const TAR_NAME_OFFSET = 0
const TAR_NAME_LENGTH = 100
const TAR_SIZE_OFFSET = 124
const TAR_SIZE_LENGTH = 12
const TAR_TYPE_OFFSET = 156
const TAR_BLOCK = 512

/**
 * One file's bytes from a gzipped tar, or null when the entry is not there.
 * @param gz - the gzipped tarball.
 * @param wanted - the exact entry name, npm-style (`package/plugins.json`).
 */
function fileFromTarball(gz: Buffer, wanted: string): Buffer | null {
  const buf = gunzipSync(gz)
  let offset = 0
  while (offset + TAR_BLOCK <= buf.length) {
    const name = buf.toString('utf8', offset + TAR_NAME_OFFSET, offset + TAR_NAME_OFFSET + TAR_NAME_LENGTH).replace(/\0.*$/s, '')
    if (name === '') break // two consecutive empty headers end a tar
    const rawSize = buf.toString('ascii', offset + TAR_SIZE_OFFSET, offset + TAR_SIZE_OFFSET + TAR_SIZE_LENGTH).replace(/\0.*$/s, '').trim()
    const size = Number.parseInt(rawSize, 8)
    if (!Number.isFinite(size) || size < 0) break
    const type = String.fromCharCode(buf[offset + TAR_TYPE_OFFSET] ?? 0)
    offset += TAR_BLOCK
    // '0' and NUL both mean a regular file; anything else (directories,
    // links, pax headers) is skipped rather than mistaken for content.
    if ((type === '0' || type === '\0') && name === wanted) {
      return buf.subarray(offset, offset + size)
    }
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return null
}

/** What an npm registry says about a package's newest release. */
interface Packument {
  version?: unknown
  dist?: { tarball?: unknown }
}

/**
 * Fetch the catalog from a PUBLISHED NPM PACKAGE read through a registry
 * mirror — the China-fast path. The published package version doubles as the
 * cache validator: when the caller's held version matches `latest`, the
 * tarball is not downloaded at all (the whole point of putting the catalog
 * on a mirror is the bytes it saves).
 *
 * BOTH requests this makes are source-controlled and both go through
 * {@link judgedFetch}: the metadata URL is built from the user's registry base,
 * and the tarball URL is whatever that registry's answer names. This source no
 * longer ships enabled (see {@link DEFAULT_SOURCE_URLS}), but it is one the
 * Sources tab offers and a user can add back in two clicks, so a second hop
 * nobody judges would still be a request to any address a registry chooses —
 * including a redirected one. A hop the policy cannot judge is refused, not
 * sent.
 *
 * BOTH reads are byte-capped while they stream, and the cap is what makes the
 * judging above worth anything: a registry that passes the address policy can
 * still answer an endless body, so the metadata read is held to
 * `REGISTRY_MAX_BYTES` (the same cap, imported, that `src/npm.ts` applies to
 * the same `/latest` manifest) and the tarball to `MAX_BYTES_PER_SOURCE` — the
 * document inside it is capped at that size once parsed, so a tarball past it
 * could not yield a document this host would accept. Crossing a cap fails the
 * source with `catalog.npmMetaTooLarge` / `catalog.npmTarballTooLarge`.
 *
 * @param pkg - the catalog package name (unscoped).
 * @param registryBase - the registry base URL, no trailing slash.
 * @param heldVersion - the version already in the caller's cache, if any.
 * @param deps - injected seams (the address-check resolver; tests supply it).
 * @returns the parsed entries plus the served version, or a per-source reason.
 */
export async function fetchCatalogFromNpmPackage(
  pkg: string,
  registryBase: string,
  heldVersion?: string,
  deps: CatalogFetchDeps = {},
): Promise<SourceFetchResult | { url: string, notModified: true, servedVersion: string }> {
  const url = `npm:${pkg}@${registryBase}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NPM_PACKAGE_TIMEOUT_MS)
  const resolve = deps.resolve ?? systemAddressResolver
  try {
    const base = registryBase.replace(/\/$/, '')
    const metaHop = await judgedFetch(
      `${base}/${encodeURIComponent(pkg)}/latest`,
      { headers: { accept: 'application/json' } },
      resolve,
      controller.signal,
    )
    if ('reason' in metaHop) return { url, reason: metaHop.reason }
    const metaRes = metaHop.response
    if (!metaRes.ok) {
      return { url, reason: { code: 'catalog.httpStatus', params: { status: metaRes.status }, text: `HTTP ${String(metaRes.status)}` } }
    }
    // Both bodies are read with a cap enforced DURING the transfer. Every byte
    // here comes from a URL a registry chose, so neither read may buffer an
    // unbounded body in the kernel child's memory; the deadline is the same for
    // both, because one controller already covers the metadata and the tarball
    // hop (NPM_PACKAGE_TIMEOUT_MS, started above).
    const metaBytes = await readBodyCapped(
      metaRes,
      REGISTRY_MAX_BYTES,
      tooLargeReason('catalog.npmMetaTooLarge', REGISTRY_MAX_BYTES),
    )
    const meta = JSON.parse(metaBytes.toString('utf8')) as Packument
    const version = typeof meta.version === 'string' ? meta.version : null
    const tarball = typeof meta.dist?.tarball === 'string' ? meta.dist.tarball : null
    if (version === null || tarball === null) {
      return { url, reason: { code: 'catalog.npmMeta', text: 'the package metadata names no version or tarball' } }
    }
    // Nothing changed, so nothing to download — re-fetching a package whose
    // version we already hold would give back most of the bytes this path
    // exists to save. (The tarball URL is judged below, where it is used: a
    // source that needs no download should not be refused over a destination
    // nothing is about to connect to.)
    if (heldVersion !== undefined && heldVersion === version) {
      return { url, notModified: true, servedVersion: version } as SourceFetchResult
    }
    // Follow `dist.tarball` rather than composing a URL: a mirror rewrites
    // this field to its own host, and composing one would send the download
    // back to the origin registry the mirror exists to avoid. Its destination
    // is judged exactly like the metadata hop's.
    const tarHop = await judgedFetch(tarball, {}, resolve, controller.signal)
    if ('reason' in tarHop) return { url, reason: tarHop.reason }
    const tarRes = tarHop.response
    if (!tarRes.ok) {
      return { url, reason: { code: 'catalog.httpStatus', params: { status: tarRes.status }, text: `HTTP ${String(tarRes.status)}` } }
    }
    const tarballBytes = await readBodyCapped(
      tarRes,
      MAX_BYTES_PER_SOURCE,
      tooLargeReason('catalog.npmTarballTooLarge', MAX_BYTES_PER_SOURCE),
    )
    const bytes = fileFromTarball(tarballBytes, 'package/plugins.json')
    if (bytes === null) {
      return { url, reason: { code: 'catalog.npmTarball', text: `the package tarball carries no plugins.json` } }
    }
    return { url, entries: parseCatalog(bytes.toString('utf8')), modified: version }
  } catch (error) {
    if (error instanceof MarketExecutionError) return { url, reason: error.host }
    if (controller.signal.aborted) {
      const seconds = Math.round(NPM_PACKAGE_TIMEOUT_MS / 1000)
      return { url, reason: { code: 'catalog.timeout', params: { seconds }, text: `the request timed out after ${String(seconds)} seconds` } }
    }
    const detail = error instanceof Error ? reasonDetail(error.message) : ''
    return detail === ''
      ? { url, reason: { code: 'catalog.requestFailed', text: 'the request failed' } }
      : { url, reason: { code: 'catalog.requestFailedDetail', params: { detail }, text: detail } }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch + parse one catalog source. Only https URLs are honored; the response
 * is size-capped and the parse is strict. Any failure degrades to
 * `{ url, reason }` — a source can never break the whole catalog view.
 *
 * Revalidation: when the caller holds validators (etag / last-modified) from
 * the previous download, they ride as `If-None-Match` / `If-Modified-Since`;
 * a 304 answers the cached entries without moving the 5 MB body (the primary
 * source is GitHub Pages behind Fastly: 0 bytes and ~0.5 s on a 304, versus
 * 5.05 MB and ~6 s unconditional — measured 2026-10-03).
 *
 * Transfer encoding: the request ADVERTISES gzip. The previous unconditional
 * `identity` guarded against a proxy that strips response headers while the
 * origin still compresses, leaving undici to hand back undecoded gzip bytes
 * that `JSON.parse` rejects. The guard is now adaptive: the response is
 * decoded by what it DECLARES when headers exist, and a body whose first
 * bytes are gzip magic with no declared encoding is decompressed explicitly
 * — so the decompression failure can never masquerade as "the source is
 * broken" while the bandwidth cost drops ~4x on the primary source.
 *
 * Address policy: the URL half (a literal private host) is enforced by
 * {@link validateSourceUrl}; the resolution half runs here, before the request
 * is sent, against the host's answers — see `src/source-address.ts` for what is
 * refused and for the one deliberate exception (the RFC 2544 block, which a
 * TUN/fake-IP network answers for every name).
 * @param url - a previously validated https URL string.
 * @param validators - validators from the previous download, when held.
 * @param deps - injected seams (the address-check resolver; tests supply it).
 * @returns per-source result.
 */
export async function fetchCatalog(
  url: string,
  validators: { readonly etag?: string, readonly modified?: string } = {},
  deps: CatalogFetchDeps = {},
): Promise<SourceFetchResult> {
  const check = validateSourceUrl(url)
  if (!check.ok) return { url, reason: check.reason }
  // The npm-package source dispatches to its own reader: the transport (a
  // registry metadata + tarball round trip) and the validator (the published
  // version) are different from every https URL source.
  if (url.startsWith('npm:')) {
    const match = /^npm:([a-z0-9-~][a-z0-9-._~]*)(@https:\/\/.+)?$/i.exec(url)
    if (match === null) return { url, reason: { code: 'source.npmShape', text: 'an npm catalog source must read npm:<package>@<https registry base>' } }
    const registryBase = match[2] !== undefined ? match[2].slice(1) : DEFAULT_NPM_MIRROR
    return fetchCatalogFromNpmPackage(match[1], registryBase, validators.modified, deps)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const addressReason = await sourceAddressReason(
      new URL(check.url).hostname,
      deps.resolve ?? systemAddressResolver,
      controller.signal,
    )
    if (addressReason !== undefined) return { url, reason: addressReason }
    const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br' }
    // ETag first: it is exact, while a date has one-second resolution. Only
    // one is sent — an origin given both must satisfy both, which turns a
    // weak ETag match into an unnecessary 200.
    if (validators.etag !== undefined) headers['if-none-match'] = validators.etag
    else if (validators.modified !== undefined) headers['if-modified-since'] = validators.modified
    const response = await fetch(check.url, { signal: controller.signal, redirect: 'error', headers })
    if (response.status === 304) {
      // The caller resolves 304 against its own cached entries; the signal
      // rides as a dedicated result kind so the caller cannot confuse it
      // with a parse.
      return { url, notModified: true } as SourceFetchResult
    }
    if (!response.ok) {
      // A status code reads the same in every locale: code plus diagnostic,
      // no dictionary copy.
      return {
        url,
        reason: {
          code: 'catalog.httpStatus',
          params: { status: response.status },
          text: `HTTP ${String(response.status)}`,
        },
      }
    }
    const bytes = await readBodyCapped(
      response,
      MAX_BYTES_PER_SOURCE,
      tooLargeReason('catalog.responseTooLarge', MAX_BYTES_PER_SOURCE),
    )
    const body = maybeGunzip(bytes, response.headers.get('content-encoding'))
    return {
      url,
      entries: parseCatalog(body),
      ...(response.headers.get('etag') !== null ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') !== null
        ? { modified: response.headers.get('last-modified')! }
        : {}),
    }
  } catch (error) {
    // A parse/size failure already speaks in codes; pass its own message on.
    if (error instanceof MarketExecutionError) return { url, reason: error.host }
    // An abort here is the timeout (the controller has no other trigger), so
    // the raw "This operation was aborted" is replaced with an actionable reason.
    if (controller.signal.aborted) {
      const seconds = Math.round(CATALOG_TIMEOUT_MS / 1000)
      return {
        url,
        reason: {
          code: 'catalog.timeout',
          params: { seconds },
          text: `the request timed out after ${String(seconds)} seconds`,
        },
      }
    }
    const detail = error instanceof Error ? reasonDetail(error.message) : ''
    return detail === ''
      ? { url, reason: { code: 'catalog.requestFailed', text: 'the request failed' } }
      // The detail IS the message (a fetch/network diagnostic), so it rides as
      // the unknown-code fallback rather than as a sentence of ours.
      : { url, reason: { code: 'catalog.requestFailedDetail', params: { detail }, text: detail } }
  } finally {
    clearTimeout(timer)
  }
}
