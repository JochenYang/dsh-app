/**
 * The persisted store of catalog source URLs:
 * `$DSH_HOME/storages/dsh-app-plugin-market/sources.json`.
 *
 * Same discipline as the other suite stores: reads validate and DEGRADE (an
 * unusable file answers as empty — the panel just shows no sources) and
 * writes are atomic full-file (tmp + rename). URLs are re-sanitized on every
 * read, so a hand-edited file cannot smuggle a non-https source past the
 * routes' validation.
 *
 * @module @dsh-app/plugin-market/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostDiagnostic, type HostText } from './errors.ts'
import {
  DEFAULT_SOURCE_URLS,
  LEGACY_SOURCE_URLS,
  MAX_ENTRIES_TOTAL,
  MAX_SOURCES,
  validateSourceUrl,
  type CatalogEntry,
  type SourceFetchResult,
} from './catalog.ts'

/**
 * Read + sanitize the source list. Duplicates collapse, non-https entries are
 * dropped, order is preserved. Never throws.
 *
 * Only a MISSING file (first run) is seeded with the default directory; any
 * existing file is respected as-is — a user who deleted every source keeps an
 * empty list, and an unreadable file degrades to empty instead of silently
 * substituting the preset.
 *
 * ONE exception, and it is not a preset re-injection: a list that is EXACTLY
 * {@link LEGACY_SOURCE_URLS} — the pair an untouched install has carried since
 * the presets were last changed — is upgraded to the current presets. The
 * distinction is "nobody has edited this" versus "this is what the user chose":
 * a user who removed one entry, reordered them, or added their own holds a list
 * that matches neither, and keeps it. The file is not rewritten; the upgrade is
 * recomputed on each read and becomes permanent at the user's next save.
 *
 * @param path - absolute path of sources.json.
 * @param log - diagnostic logger for degradations.
 * @returns the sanitized URL list.
 */
export function loadSources(path: string, log: (message: string) => void): string[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [...DEFAULT_SOURCE_URLS] // first run: open the panel with content
    }
    return [] // exists but unreadable: degrade, never overwrite or substitute
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`plugin-market sources: unreadable JSON, starting empty: ${(error as Error).message}`)
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('plugin-market sources: expected a JSON object, starting empty')
    return []
  }
  const candidates = (parsed as { sources?: unknown }).sources
  if (!Array.isArray(candidates)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const check = validateSourceUrl(candidate)
    if (!check.ok) {
      log(`plugin-market sources: dropping an unusable entry: ${hostDiagnostic(check.reason)}`)
      continue
    }
    if (seen.has(check.url)) continue
    seen.add(check.url)
    out.push(check.url)
    if (out.length >= MAX_SOURCES) break
  }
  // The untouched-install upgrade: same length, same order, same URLs.
  if (out.length === LEGACY_SOURCE_URLS.length && out.every((url, index) => url === LEGACY_SOURCE_URLS[index])) {
    log('plugin-market sources: upgrading the untouched preset pair to the current presets (CDN index instead of the npm tarball)')
    return [...DEFAULT_SOURCE_URLS]
  }
  return out
}

/**
 * Persist the source list atomically. The caller owns validation (routes
 * sanitize through validateSourceUrl before calling).
 * @param path - absolute path of sources.json.
 * @param sources - the validated URL list.
 */
export function saveSources(path: string, sources: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  // 随机后缀：两个并发写入各自落在独立临时文件，后 rename 者胜，互不踩踏
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ sources: [...sources] }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * One cached source: its last good entry list, or why the last fetch failed
 * (the panel keeps showing the per-source failure instead of silently
 * pretending the source is empty). The reason is the coded shape, so a cached
 * failure renders in the active locale just like a fresh one.
 */
export interface CachedSourceState {
  readonly entries: readonly CatalogEntry[]
  readonly failed?: HostText
  /** The origin's ETag for this body; sent back as `If-None-Match`. */
  readonly etag?: string
  /** The origin's Last-Modified; sent back as `If-Modified-Since`. */
  readonly modified?: string
  /**
   * True when the per-source entry cap clipped this source's document when it
   * was fetched (see `SourceTruncation`). Optional and deliberately NOT a
   * format-version bump: a cache written before the flag existed simply reads
   * as untruncated, and the next refetch that clips a row records it.
   */
  readonly truncated?: true
}

/**
 * Persisted catalog-cache format version. The panel reads cached entries
 * as-is (it never recomputes category labels), so a cache written by an older
 * build can carry downgraded display data — e.g. raw category ids where a
 * label now belongs. A cache whose version is missing or not the current one
 * reads as absent, so the next open refetches the live sources and rebuilds
 * the file instead of rendering degraded rows until the TTL lapses.
 *
 * Version 3 made `failed` a coded message (v2 stored the pre-i18n Chinese
 * sentence); the gate above is exactly what keeps that prose off the panel.
 * Version 5 added the entry's `gitTarget` (v4 rows carry `installable: false`
 * for every git-only row and no target at all), which is not merely display
 * data: without the refetch those rows keep rendering as source-only and the
 * new install path stays invisible until the 6 h TTL lapses.
 */
export const CACHE_FORMAT_VERSION = 5

/**
 * The persisted catalog snapshot (`catalog-cache.json`) behind the
 * cache-first panel open: `{ version, fetchedAt, sources: { [url]: state } }`.
 * Entries inside were validated when they were first parsed from their
 * source; the cache only re-checks the load-bearing display fields on read.
 *
 * Each source row also carries the validators the origin served with the
 * body (`etag` / `modified`), so the next refresh can revalidate with
 * `If-None-Match` / `If-Modified-Since` instead of re-downloading a 5 MB
 * catalog to learn nothing changed (the primary source is GitHub Pages
 * behind Fastly and answers a 304 in ~0.5 s; measured 2026-10-03).
 */
export interface CatalogCache {
  readonly version: number
  readonly fetchedAt: number
  readonly sources: Readonly<Record<string, CachedSourceState>>
}

/** Cache-read entry check: the three fields every consumer reads. */
function usableEntry(value: unknown): CatalogEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<CatalogEntry>
  if (typeof record.package !== 'string' || record.package === '') return undefined
  if (typeof record.name !== 'string' || record.name === '') return undefined
  if (typeof record.description !== 'string') return undefined
  return value as CatalogEntry
}

/** A cached failure reason: the coded shape, or undefined when unusable. */
function cachedHostTextOf(value: unknown): HostText | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.code !== 'string' || record.code === '') return undefined
  const params = typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
    ? record.params as Record<string, string | number>
    : undefined
  return {
    code: record.code,
    ...(params !== undefined ? { params } : {}),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
  }
}

/** Validated per-source cache row; undefined when the row carries nothing usable. */
function cachedSourceStateOf(value: unknown): CachedSourceState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const failed = cachedHostTextOf(record.failed)
  const entries: CatalogEntry[] = Array.isArray(record.entries)
    ? record.entries.map(usableEntry).filter((entry): entry is CatalogEntry => entry !== undefined)
    : []
  if (entries.length === 0 && failed === undefined) return undefined
  return {
    entries,
    ...(failed === undefined ? {} : { failed }),
    // Validators are optional metadata: an absent/garbage one just means the
    // next fetch goes unconditional. Only sane header values are kept.
    ...(typeof record.etag === 'string' && record.etag !== '' && record.etag.length <= 256
      ? { etag: record.etag }
      : {}),
    ...(typeof record.modified === 'string' && record.modified !== '' && record.modified.length <= 64
      ? { modified: record.modified }
      : {}),
    // Only the literal `true` counts: an older cache has no field at all, and a
    // hand-edited value must not make a complete directory read as clipped.
    ...(record.truncated === true ? { truncated: true as const } : {}),
  }
}

/**
 * Build a cache snapshot from per-source fetch results (source order kept).
 * Total entries are capped at the merged-catalog limit; per-source caps were
 * already enforced at parse time, so no re-slicing per source here. A row the
 * shared budget clipped is flagged `truncated` ONLY when the merge would have
 * listed it — a package an earlier source already carries is dropped by the
 * dedupe, so it is not a clip (the flag is re-served by every later 304 and
 * stale-row read, so a false one would never age out). Response validators
 * (etag / last-modified) travel with their source's row so the next refresh
 * can revalidate instead of re-downloading. A revalidated row (304) keeps its
 * prior cached state verbatim — entries AND validators — keyed by the source URL
 * the caller resolved it for.
 */
export function buildCatalogCache(
  fetchedAt: number,
  results: ReadonlyArray<SourceFetchResult>,
  revalidated: Readonly<Record<string, CachedSourceState>> = {},
  previous: Readonly<Record<string, CachedSourceState>> = {},
): CatalogCache {
  const sources: Record<string, CachedSourceState> = {}
  /** Packages the rows already written carry: the merged list holds each one once. */
  const seen = new Set<string>()
  let budget = MAX_ENTRIES_TOTAL
  for (const result of results) {
    if ('entries' in result) {
      const room = Math.max(budget, 0)
      const entries = result.entries.slice(0, room)
      budget -= entries.length
      // Two caps can clip a row here: the per-source one (already reported by the
      // fetch) and this shared budget, which is the merged cap applied at write
      // time. The budget clip is judged the way `mergeCatalogsDetailed` judges it:
      // a package an earlier row already carries is dropped by the dedupe, so its
      // absence is not truncation. Without that test a source whose rows all
      // duplicate an earlier one was flagged "truncated" for ever — the cache
      // re-serves the flag through 304s and stale-row lending, so the model kept
      // reading "this directory is incomplete" about a complete list.
      const clippedByBudget = result.entries.slice(room).some(entry => !seen.has(entry.package))
      for (const entry of entries) seen.add(entry.package)
      sources[result.url] = {
        entries,
        ...(result.etag !== undefined ? { etag: result.etag } : {}),
        ...(result.modified !== undefined ? { modified: result.modified } : {}),
        ...(result.truncated !== undefined || clippedByBudget ? { truncated: true as const } : {}),
      }
    } else if ('notModified' in result) {
      // The cached copy is confirmed current: write it back so the next refresh
      // revalidates against the same validators again — but WITHOUT its `failed`
      // mark. A 304 proves the source answers; carrying an old failure forward made
      // `isCacheFresh` distrust it for ever, and made the catalog payload drop the
      // very rows this response just confirmed.
      const row = revalidated[result.url]
      if (row !== undefined) {
        for (const entry of row.entries) seen.add(entry.package)
        sources[result.url] = {
          entries: row.entries,
          ...(row.etag !== undefined ? { etag: row.etag } : {}),
          ...(row.modified !== undefined ? { modified: row.modified } : {}),
          ...(row.truncated === true ? { truncated: true as const } : {}),
        }
      }
    } else {
      // A transient failure KEEPS the rows the user already had. Overwriting them
      // with an empty list made one flaky fetch erase the source from the panel,
      // and the cache then looked fresh for the whole TTL — the opposite of what
      // the retry path assumes. `failed` marks the row as unproven: the freshness
      // check retries it on the next request.
      const prior = previous[result.url] ?? revalidated[result.url]
      for (const entry of prior?.entries ?? []) seen.add(entry.package)
      sources[result.url] = {
        entries: prior?.entries ?? [],
        failed: result.reason,
        ...(prior?.etag !== undefined ? { etag: prior.etag } : {}),
        ...(prior?.modified !== undefined ? { modified: prior.modified } : {}),
        ...(prior?.truncated === true ? { truncated: true as const } : {}),
      }
    }
  }
  return { version: CACHE_FORMAT_VERSION, fetchedAt, sources }
}

/**
 * Sanity cap for the cache FILE: a hand-mangled or runaway file is refused
 * before it is parsed on the request thread.
 *
 * Measured 2026-11-26 on real cache rows (625 bytes per row as this writer
 * emits them, indentation included): 6,985 rows → 3.50 MB, 16,100 rows →
 * 8.09 MB, 24,000 rows → 12.07 MB, and 24,000 rows of the current shape
 * extrapolate to ~15.0 MB. The previous 16 MB cap therefore sat within a tenth
 * of a LEGAL full cache, and crossing it did not degrade — it made
 * `loadCatalogCache` refuse the file as corruption, so every request refetched
 * live and nothing was ever persisted again: the same silent failure this round
 * exists to remove. 32 MB keeps the cap a bound on hand-edited/runaway files
 * (2x the largest legal cache) instead of a second, hidden entry limit.
 */
export const MAX_CACHE_BYTES = 32_000_000

/**
 * Last parse per cache path, keyed by the file's identity (`mtimeMs` + `size`).
 *
 * A cache read happens on EVERY `/catalog` request, `/install-intent`, and
 * `market_search`, and the primary source's 6,885 rows make the file several
 * megabytes — measured 2026-11-26: ~7.8 ms per `JSON.parse` on a 3 MB file, on
 * the request thread. A stat is microseconds, and this process's own writes go
 * through tmp+rename, so every write moves `mtimeMs` (and usually `size`) and
 * invalidates the entry. `null` is cached too: a garbage file must not be
 * re-parsed on every request either. A rewrite that landed in the same
 * millisecond AND kept the exact byte length is the one case this can serve
 * stale — the next stat after that tick moves on.
 */
const cacheParseMemo = new Map<string, { mtimeMs: number, size: number, cache: CatalogCache | null }>()

/**
 * Read + validate the catalog cache. Missing/unreadable/garbage answers null
 * (the routes then fall back to a live fetch) — same degrade discipline as
 * loadSources; a broken cache file never breaks the panel. A file written by
 * an older format answers null too: its rows may carry downgraded display
 * data, and one live rebuild is cheaper than rendering them.
 * @param path - absolute path of catalog-cache.json.
 * @param log - diagnostic logger for degradations.
 * @returns the cache, or null when absent or unusable.
 */
export function loadCatalogCache(path: string, log: (message: string) => void): CatalogCache | null {
  let mtimeMs: number
  let size: number
  try {
    // Size guard BEFORE parsing: this runs on the request thread, and a
    // hand-mangled multi-megabyte file would otherwise stall every open.
    const stat = statSync(path)
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`plugin-market catalog cache: unreadable, ignoring: ${(error as Error).message}`)
    }
    return null // missing (first run) or unreadable: fall through to a live fetch
  }
  if (!Number.isFinite(size) || size > MAX_CACHE_BYTES) {
    log(`plugin-market catalog cache: ${size} bytes exceeds the ${MAX_CACHE_BYTES} cap, ignoring`)
    return null
  }
  const memo = cacheParseMemo.get(path)
  if (memo !== undefined && memo.mtimeMs === mtimeMs && memo.size === size) return memo.cache
  const cache = parseCatalogCacheFile(path, log)
  cacheParseMemo.set(path, { mtimeMs, size, cache })
  return cache
}

/** Read + parse one cache file; the caller owns the stat guard and the memo. */
function parseCatalogCacheFile(path: string, log: (message: string) => void): CatalogCache | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`plugin-market catalog cache: unreadable, ignoring: ${(error as Error).message}`)
    }
    return null // missing (first run) or unreadable: fall through to a live fetch
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log(`plugin-market catalog cache: unreadable JSON, ignoring: ${(error as Error).message}`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('plugin-market catalog cache: expected a JSON object, ignoring')
    return null
  }
  const record = parsed as Record<string, unknown>
  // Version gate before any field work: only a cache at the current format is
  // trusted, so a legacy or future file invalidates itself on read.
  if (record.version !== CACHE_FORMAT_VERSION) {
    log(`plugin-market catalog cache: format version ${String(record.version)} is not ${CACHE_FORMAT_VERSION}, ignoring`)
    return null
  }
  const fetchedAt = record.fetchedAt
  if (typeof fetchedAt !== 'number' || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) {
    log('plugin-market catalog cache: missing fetchedAt, ignoring')
    return null
  }
  const rawSources = record.sources
  if (typeof rawSources !== 'object' || rawSources === null || Array.isArray(rawSources)) {
    log('plugin-market catalog cache: missing sources map, ignoring')
    return null
  }
  const sources: Record<string, CachedSourceState> = {}
  for (const [url, value] of Object.entries(rawSources)) {
    const state = cachedSourceStateOf(value)
    if (state !== undefined) sources[url] = state
  }
  return { version: CACHE_FORMAT_VERSION, fetchedAt, sources }
}

/**
 * Persist the catalog cache atomically (tmp + rename, same as saveSources).
 * The caller decides whether a write failure matters — the cache is an
 * optimization, so routes degrade write errors to a log line.
 * @param path - absolute path of catalog-cache.json.
 * @param cache - the snapshot to persist.
 */
export function saveCatalogCache(path: string, cache: CatalogCache): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
