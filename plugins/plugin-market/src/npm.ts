/**
 * npm-side primitives of the install chain: package-name validation, exact
 * registry version resolution, kernel CLI location, and the profile name
 * constraint. Everything here is pure or strictly bounded network I/O —
 * no filesystem writes, no process spawns (those live in installer.ts).
 *
 * Security stance: registry lookups go to the official npm registry over
 * https only, carry no credentials, and only the exact version string of the
 * resolved manifest is consumed. Catalog-declared versions are never trusted;
 * the resolved version comes from the registry (`latest`) or from a
 * user-specified exact version verified against the registry.
 *
 * @module @dsh-app/plugin-market/npm
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MarketExecutionError, MarketValidationError } from './errors.ts'

/**
 * npm package-name grammar (new-packages rule: lowercase only). Anchored —
 * the name is spliced into CLI argv and registry URLs, so anything outside
 * this shape (paths, specifiers, whitespace, control chars) is rejected.
 */
export const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-*~][a-z0-9-._~]*$/

/** Exact semver version (no ranges/tags): the only form we ever install. */
export const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** npm's own name length cap (scoped names count the whole string). */
const MAX_NAME_LENGTH = 214

/** Official registry host — the only host registry requests may target. */
export const REGISTRY_HOST = 'registry.npmjs.org'

/** Registry lookup timeout (ms) — the panel must stay responsive. */
export const REGISTRY_TIMEOUT_MS = 10_000

/** Registry response cap; a single-version manifest is far smaller. */
const REGISTRY_MAX_BYTES = 1_000_000

/**
 * Validate and normalize a requested package name.
 * @param raw - the client-supplied value (any shape).
 * @returns the trimmed name.
 * @throws MarketValidationError with a zh-CN message when unusable.
 */
export function validatePackageName(raw: unknown): string {
  if (typeof raw !== 'string') throw new MarketValidationError('包名必须是字符串')
  const name = raw.trim()
  if (name.length === 0) throw new MarketValidationError('包名不能为空')
  if (name.length > MAX_NAME_LENGTH) throw new MarketValidationError('包名过长')
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw new MarketValidationError(`包名格式不合法：「${name}」`)
  }
  return name
}

/**
 * Validate a user-specified exact version (ranges/tags are never installed).
 * @param raw - the client-supplied version or undefined.
 * @returns the trimmed version, or undefined when the caller wants `latest`.
 * @throws MarketValidationError when the shape is not an exact semver.
 */
export function validateExactVersion(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw new MarketValidationError('版本号必须是字符串')
  const version = raw.trim()
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new MarketValidationError(`版本号必须是精确版本（如 1.2.3），不接受范围或标签：「${version}」`)
  }
  return version
}

/**
 * Validate the profile name used in CLI argv. It comes from the environment,
 * not the client — this is hygiene so a broken env cannot bend the command.
 * @param raw - profile name.
 * @returns the trimmed name.
 */
export function validateProfileName(raw: string): string {
  const name = raw.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new MarketValidationError(`profile 名称不合法：「${name}」`)
  }
  return name
}

/**
 * Build the registry manifest URL for one package/version.
 * The full name is percent-encoded (scope slash included) — the registry
 * accepts the encoded form and it keeps every byte of the name inside the
 * path component.
 */
export function registryUrl(name: string, version = 'latest'): string {
  return `https://${REGISTRY_HOST}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

/**
 * Resolve the exact version to install: the user's exact version (verified to
 * exist) or the registry's `latest`. The catalog's declared version never
 * reaches this function.
 * @param name - a validated package name.
 * @param requested - user-specified exact version, or undefined for latest.
 * @returns the exact version string from the registry manifest.
 * @throws MarketExecutionError on network failure, malformed answer, or a
 *   requested version that does not exist.
 */
export async function resolveRegistryVersion(name: string, requested?: string): Promise<string> {
  const url = registryUrl(name, requested ?? 'latest')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  let body: string
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    if (response.status === 404) {
      throw new MarketValidationError(requested === undefined
        ? `npm 上找不到插件包：「${name}」`
        : `版本不存在：「${name}@${requested}」`)
    }
    if (!response.ok) {
      throw new MarketExecutionError(`registry 查询失败（HTTP ${response.status}）`, 'registry')
    }
    body = (await response.text()).slice(0, REGISTRY_MAX_BYTES)
  } catch (error) {
    if (error instanceof MarketValidationError || error instanceof MarketExecutionError) throw error
    throw new MarketExecutionError(`registry 查询失败：${error instanceof Error ? error.message : '网络错误'}`, 'registry')
  } finally {
    clearTimeout(timer)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(body)
  } catch {
    throw new MarketExecutionError('registry 返回了无法解析的内容', 'registry')
  }
  const version = (manifest as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || !EXACT_VERSION_PATTERN.test(version)) {
    throw new MarketExecutionError('registry 返回的版本信息不完整', 'registry')
  }
  if (requested !== undefined && version !== requested) {
    throw new MarketExecutionError(`registry 返回的版本与请求不一致：${version}`, 'registry')
  }
  return version
}

/**
 * Keep the last `max` lines of combined CLI output (the panel shows a tail,
 * not the whole log).
 */
export function tailLines(text: string, max: number): string {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.slice(-max).join('\n')
}

/** Core shape consumed by compareVersions (prerelease captured, build dropped). */
const VERSION_CORE_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Lightweight semver precedence for the update check: three numeric segments,
 * optional prerelease (semver identifier rules), build metadata ignored.
 * Answers like localeCompare (<0 / 0 / >0). Malformed input answers 0 — the
 * caller reads "equal" as "no update", which is the safe direction for a
 * version string a registry or manifest should never produce.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { core: [number, number, number], pre: readonly string[] | null } | null => {
    const match = VERSION_CORE_PATTERN.exec(value.trim())
    if (match === null) return null
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? null : match[4].split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return 0
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index]! - right.core[index]!
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  // A release outranks any prerelease of the same core version.
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1 // shorter identifier set sorts lower
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta < 0 ? -1 : 1
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1 // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Freshness window of the in-memory `latest` cache: one registry round per window. */
export const LATEST_CACHE_TTL_MS = 5 * 60 * 1000

interface LatestCacheEntry {
  readonly version: string | undefined
  readonly fetchedAt: number
}

/** Module-level: the server process is the single consumer of /installed. */
const latestCache = new Map<string, LatestCacheEntry>()

/**
 * One registry `latest` probe, never rejecting: a failed or malformed answer
 * degrades to undefined so one dead package cannot block the installed view.
 */
async function fetchLatestVersion(name: string): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  try {
    const response = await fetch(registryUrl(name), { signal: controller.signal, redirect: 'error' })
    if (!response.ok) return undefined
    const manifest = JSON.parse((await response.text()).slice(0, REGISTRY_MAX_BYTES)) as { version?: unknown } | null
    const version = manifest?.version
    return typeof version === 'string' && EXACT_VERSION_PATTERN.test(version) ? version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Registry `latest` for one package, with a 5-minute in-memory cache that
 * also covers failures — a dead package or offline link must not turn every
 * panel open into a registry round-trip.
 */
export async function latestVersionOf(name: string): Promise<string | undefined> {
  const cached = latestCache.get(name)
  if (cached !== undefined && Date.now() - cached.fetchedAt < LATEST_CACHE_TTL_MS) return cached.version
  const version = await fetchLatestVersion(name)
  latestCache.set(name, { version, fetchedAt: Date.now() })
  return version
}

/**
 * Concurrent `latest` probes per batch. A cold panel open probes every
 * installed registry package at once; without a cap that is one outbound
 * socket per package — four keeps the batch prompt while staying polite to
 * the registry. Each probe also carries its own REGISTRY_TIMEOUT_MS, so one
 * unresponsive package delays at most its own slot.
 */
export const LATEST_PROBE_CONCURRENCY = 4

/**
 * Registry `latest` for a batch of package names, probed with a bounded
 * concurrency (LATEST_PROBE_CONCURRENCY workers pull from a shared cursor);
 * every failure degrades to undefined for that name only. `probe` is
 * injectable so the concurrency bound is testable without the network.
 */
export async function latestVersionsOf(
  names: readonly string[],
  probe: (name: string) => Promise<string | undefined> = latestVersionOf,
): Promise<Record<string, string | undefined>> {
  const latest: Record<string, string | undefined> = {}
  let cursor = 0
  const workers = Array.from({ length: Math.min(LATEST_PROBE_CONCURRENCY, names.length) }, async () => {
    while (cursor < names.length) {
      // Read+advance before the first await: JS is single-threaded, so two
      // workers can never claim the same index.
      const name = names[cursor]!
      cursor += 1
      latest[name] = await probe(name)
    }
  })
  await Promise.all(workers)
  return latest
}

// The resolve anchor is this module's own URL. In the packaged runtime the
// plugin sits inside the kernel's app tree, so the kernel package resolves
// directly; in dev the fallback below takes over.
const hostRequire = createRequire(import.meta.url)

/**
 * Locate the kernel CLI entry (`@deepseek-ai/dsh/lib/bin.js`).
 *
 * Strategy 1 resolves the kernel package from this plugin's own location
 * (works whenever the plugin and the kernel share a node_modules root, as in
 * the packaged runtime). Strategy 2 walks up from the running process's entry
 * script (the server process booted that exact kernel, so its path is
 * authoritative in dev checkouts). Both pin the CLI to the RUNNING kernel
 * version — installing with a different global CLI could write an
 * incompatible profile layout.
 *
 * @param argv1 - `process.argv[1]` of the running server (pass it through).
 * @returns absolute path of the kernel's bin.js.
 * @throws MarketValidationError when neither strategy resolves.
 */
export function resolveDshBin(argv1: string | undefined): string {
  try {
    const manifest = hostRequire.resolve('@deepseek-ai/dsh/package.json')
    return join(dirname(manifest), 'lib', 'bin.js')
  } catch {
    // fall through to the entry-script strategy
  }
  if (typeof argv1 === 'string' && argv1 !== '') {
    let dir = resolve(dirname(argv1))
    for (let hop = 0; hop < 8; hop += 1) {
      const manifest = join(dir, 'package.json')
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
        if ((parsed as { name?: unknown } | null)?.name === '@deepseek-ai/dsh') {
          const bin = join(dir, 'lib', 'bin.js')
          if (existsSync(bin)) return bin
          break
        }
      } catch {
        // no manifest here — keep walking up
      }
      const parent = dirname(dir)
      if (parent === dir || !isAbsolute(parent)) break
      dir = parent
    }
  }
  throw new MarketValidationError('未能定位内核命令行工具，无法安装插件')
}
