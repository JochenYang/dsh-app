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
 */
export const CACHE_FORMAT_VERSION = 3

/**
 * The persisted catalog snapshot (`catalog-cache.json`) behind the
 * cache-first panel open: `{ version, fetchedAt, sources: { [url]: state } }`.
 * Entries inside were validated when they were first parsed from their
 * source; the cache only re-checks the load-bearing display fields on read.
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
  return failed === undefined ? { entries } : { entries, failed }
}

/**
 * Build a cache snapshot from per-source fetch results (source order kept).
 * Total entries are capped at the merged-catalog limit; per-source caps were
 * already enforced at parse time, so no re-slicing per source here.
 */
export function buildCatalogCache(fetchedAt: number, results: ReadonlyArray<SourceFetchResult>): CatalogCache {
  const sources: Record<string, CachedSourceState> = {}
  let budget = MAX_ENTRIES_TOTAL
  for (const result of results) {
    if ('entries' in result) {
      const entries = result.entries.slice(0, Math.max(budget, 0))
      budget -= entries.length
      sources[result.url] = { entries }
    } else {
      sources[result.url] = { entries: [], failed: result.reason }
    }
  }
  return { version: CACHE_FORMAT_VERSION, fetchedAt, sources }
}

/** Sanity cap: a real cache is ~1-2 MB; anything beyond this is corruption. */
export const MAX_CACHE_BYTES = 16_000_000

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
  let raw: string
  try {
    // Size guard BEFORE parsing: this runs on the request thread, and a
    // hand-mangled multi-megabyte file would otherwise stall every open.
    const bytes = statSync(path).size
    if (!Number.isFinite(bytes) || bytes > MAX_CACHE_BYTES) {
      log(`plugin-market catalog cache: ${bytes} bytes exceeds the ${MAX_CACHE_BYTES} cap, ignoring`)
      return null
    }
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
