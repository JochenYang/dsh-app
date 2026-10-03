/**
 * Catalog sources: fetching, validation, and merging.
 *
 * A catalog source is an https URL answering a JSON document. Two document
 * formats are accepted, decided by sniffing the first object entry of the
 * `plugins` array:
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
 *
 * Security stance: a source is DATA ONLY. Entries are validated field by
 * field and anything unusable is dropped (never executed, never followed);
 * a failed source is reported per-source and never blocks the others. The
 * `version` a source declares is display metadata only — the install chain
 * resolves versions from the npm registry (see npm.ts), and it re-validates
 * the package name so a non-installable entry's surrogate key can never reach
 * the CLI.
 *
 * @module @dsh-app/plugin-market/catalog
 */

import { gunzipSync } from 'node:zlib'
import { MarketExecutionError, type HostText } from './errors.ts'
import { PACKAGE_NAME_PATTERN } from './npm.ts'

/** The primary directory preset into a fresh store (first run only; user-removable). */
export const DEFAULT_SOURCE_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/**
 * The catalog as a PUBLISHED NPM PACKAGE, read through a China npm mirror.
 *
 * The catalog's own host (above) is served from GitHub Pages, and public
 * GitHub proxies refuse hostnames outside github.com — so from a mainland
 * link without a proxy the 5 MB body takes 6-8 s. Published to npm it rides
 * the same mirror every plugin install already uses: measured against the
 * Tencent mirror 2026-10-03, the metadata + tarball round trip is 1.2 MB in
 * ~0.7 s, and the package carries a meaningful version that doubles as the
 * cache validator (skip the tarball entirely when the held version matches).
 * Same data, same schema as the origin's `plugins.json` (verified: 4412
 * entries with downloads/stars/version per entry).
 */
export const DEFAULT_CATALOG_PACKAGE = 'dsh-plugin-catalog'

/** The China npm mirror the package catalog is read through (no trailing slash). */
export const DEFAULT_NPM_MIRROR = 'https://mirrors.cloud.tencent.com/npm'

/**
 * The secondary preset: a China-reachable community store. The URL pins the
 * first page only — full pagination is deliberately out of scope (a 13k-entry
 * catalog would blow every entry cap for no browsing benefit; the panel is a
 * discovery surface, the primary source stays the comprehensive one).
 */
export const DEFAULT_SECONDARY_SOURCE_URL = 'https://deepseek1024.com/api/v2/plugins?page=1&limit=100'

/** Fresh-store seed list (first run only; user-removable). */
/**
 * The scheme-prefixed address of the npm-package catalog source. Not a real
 * URL — `validateSourceUrl` special-cases the scheme — but it keeps every
 * source (whatever its transport) behind one list, one cache and one UI.
 */
export const NPM_PACKAGE_SOURCE_URL = `npm:${DEFAULT_CATALOG_PACKAGE}@${DEFAULT_NPM_MIRROR}`

export const DEFAULT_SOURCE_URLS: readonly string[] = [NPM_PACKAGE_SOURCE_URL, DEFAULT_SOURCE_URL, DEFAULT_SECONDARY_SOURCE_URL]

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
  return { ok: true, url: url.toString() }
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
    const installable = npm !== undefined && PACKAGE_NAME_PATTERN.test(npm)
    // A name carrying '#' (e.g. `archify#integrations/deepseek-harness`) is a
    // REPO PATH the source uses as an entry id for example/template
    // directories, not a plugin title. Where a real npm name exists, the npm
    // name becomes the display title; entries with no npm name AND a
    // path-shaped name are dropped outright — they are not installable and
    // their "title" is a fragment of a repository tree, never a plugin name.
    let displayName = name
    if (name.includes('#')) {
      if (installable && npm !== undefined) displayName = npm
      else continue
    }
    const version = plainString(record.version, 100)
    const owner = plainString(record.owner, 100)
    const stars = safeCountOf(record.stars)
    const downloads = safeCountOf(record.downloads)
    const category = categoryOf(record.category, categories, record.categoryId)
    // Source-only rows key on their (stable) directory page so the merge step
    // still dedupes; the install chain re-validates names, so this surrogate
    // key can never be installed even if it leaked past the panel.
    const key = installable ? npm : (page ?? homepage ?? name)
    entries.push({
      id: page ?? homepage ?? name,
      name: displayName,
      description,
      package: key,
      installable,
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
    const installable = npm !== undefined
    const installs30d = safeCountOf(record.installs30d)
    const owner = plainString(record.owner, 100)
    const stars = safeCountOf(record.stars)
    const id = plainString(record.id, 200) ?? homepage ?? name
    const key = installable ? npm : id
    entries.push({
      id,
      name,
      description,
      package: key,
      installable,
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

/**
 * Read the response body enforcing the byte cap DURING the transfer, not
 * after: a rogue source must not be able to buffer an unbounded body in host
 * memory before the slice happens. Returns BYTES, not text — the caller may
 * need to gunzip (a proxy that strips the encoding header), and a string
 * round-trip through the default UTF-8 TextDecoder destroys those bytes
 * irrecoverably (0x80-0x9F are not valid UTF-8 continuations; measured:
 * `Buffer.from(TextDecoder().decode(gz), 'latin1')` does NOT restore the
 * original gzip).
 */
async function readBodyCapped(response: Response): Promise<Buffer> {
  const body = response.body
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BYTES_PER_SOURCE) {
      await reader.cancel().catch(() => undefined)
      const mb = Math.floor(MAX_BYTES_PER_SOURCE / 1_000_000)
      throw new MarketExecutionError(
        {
          code: 'catalog.responseTooLarge',
          params: { mb },
          text: `the source response exceeds the ${String(mb)} MB cap`,
        },
        'catalog',
      )
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
 * @param pkg - the catalog package name (unscoped).
 * @param registryBase - the registry base URL, no trailing slash.
 * @param heldVersion - the version already in the caller's cache, if any.
 * @returns the parsed entries plus the served version, or a per-source reason.
 */
export async function fetchCatalogFromNpmPackage(
  pkg: string,
  registryBase: string,
  heldVersion?: string,
): Promise<SourceFetchResult | { url: string, notModified: true, servedVersion: string }> {
  const url = `npm:${pkg}@${registryBase}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NPM_PACKAGE_TIMEOUT_MS)
  try {
    const base = registryBase.replace(/\/$/, '')
    const metaRes = await fetch(`${base}/${encodeURIComponent(pkg)}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!metaRes.ok) {
      return { url, reason: { code: 'catalog.httpStatus', params: { status: metaRes.status }, text: `HTTP ${String(metaRes.status)}` } }
    }
    const meta = (await metaRes.json()) as Packument
    const version = typeof meta.version === 'string' ? meta.version : null
    const tarball = typeof meta.dist?.tarball === 'string' ? meta.dist.tarball : null
    if (version === null || tarball === null) {
      return { url, reason: { code: 'catalog.npmMeta', text: 'the package metadata names no version or tarball' } }
    }
    // Nothing changed, so nothing to download — re-fetching a package whose
    // version we already hold would give back most of the bytes this path
    // exists to save.
    if (heldVersion !== undefined && heldVersion === version) {
      return { url, notModified: true, servedVersion: version } as SourceFetchResult
    }
    // Follow `dist.tarball` rather than composing a URL: a mirror rewrites
    // this field to its own host, and composing one would send the download
    // back to the origin registry the mirror exists to avoid.
    const tarRes = await fetch(tarball, { signal: controller.signal })
    if (!tarRes.ok) {
      return { url, reason: { code: 'catalog.httpStatus', params: { status: tarRes.status }, text: `HTTP ${String(tarRes.status)}` } }
    }
    const bytes = fileFromTarball(Buffer.from(await tarRes.arrayBuffer()), 'package/plugins.json')
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
 * @param url - a previously validated https URL string.
 * @param validators - validators from the previous download, when held.
 * @returns per-source result.
 */
export async function fetchCatalog(
  url: string,
  validators: { readonly etag?: string, readonly modified?: string } = {},
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
    return fetchCatalogFromNpmPackage(match[1], registryBase, validators.modified)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
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
    const bytes = await readBodyCapped(response)
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
